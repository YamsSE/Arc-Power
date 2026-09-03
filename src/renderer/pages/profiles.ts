// Arc Power - Profiles page (M2b-B): list/create/save/rename/delete/load
// profiles persisted by the main-process ProfileStore (via the profiles-*
// IPC channels), plus the "start at boot" toggle (ocOnBoot) backed by the
// shared HKCU Run value with honest state reporting. M4-D2 (plan F4): the
// toggle ONLY persists the intent - profilesSettingsSave owns the
// Run-value write (main re-derives the value from the merged intent; the
// renderer never calls startupSet directly).
// Loading a profile applies its settings through the same waiver gate and
// toast rules as the Overclocking page (no-op applies stay silent; errors
// always toast; M2C-B F3 instant apply - one attempt, no retry UI). Every
// mutation rebuilds the tray menu (tray-rebuild IPC) and marks the active
// profile.
//
// M4-D: the load keeps its waiver gate and gains the SAME auto
// re-prompt + single retry as OC/fan - a load whose apply answers
// waiver-not-set re-prompts ONCE (the fresh caps show the driver truth) and
// retries on accept; the counter resets on success. This renderer-side
// retry is the defense for NEVER-accepted sessions - with a persisted
// acceptance MAIN silently re-sets the driver waiver and retries (the
// renderer never sees the failure).

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { api } from '../ipc.ts';
import { toast } from '../components/toast.ts';
import { ensureWaiver } from '../components/waiver-dialog.ts';
import { applyFailureText, CONTROL_LABELS } from '../pure/errors.ts';
import { isNoopApply, validateSettingsPayload, profileApplyOutcome } from '../pure/settings.ts';
import { chipLabelGpu } from '../pure/chip-label.ts';
import { isAlchemistGpuName, isBattlemageGpuName } from '../pure/hardware-icons.ts';
import { controlDisplay, formatValue } from '../pure/slider.ts';
import type { AppState } from '../router.ts';
import type { Capabilities, DeviceInfo, DeviceState, FlipMode, FrameGenOverride, GameCatalogEntry, GameGpuProfile, GameProfileCapabilities, GameProfileGraphics, GameSettingsRecord, LowLatency, Profile, ProfilesEnvelope, RangeInfo, Settings, StartupGetState } from '../types.ts';

const SCALAR_KEYS = ['powerLimitW', 'gpuVoltOffsetV', 'gpuFreqOffsetMhz', 'tempLimitC', 'vramFreqOffsetGts', 'vramVoltOffsetV', 'fixedFanPct'];
const MAX_GAME_BANNER_DATA_LENGTH = 12_000_000;

// M4-D: the automatic waiver re-prompt + single retry counter - a
// profile load can hit waiver-not-set (the driver lost the waiver while the
// store had no persisted acceptance); the load then re-prompts ONCE and
// retries on accept. Reset on every successful load - a later driver-side
// loss still gets its own retry. Module-level (per-page state, same pattern
// as the OC page).
let waiverRetryCount = 0;

type GameCatalogSessionCache = {
  catalog: GameCatalogEntry[];
  settings: GameSettingsRecord[];
  loaded: boolean;
  loading: Promise<void> | null;
  scanStarted: boolean;
  scanLoading: Promise<void> | null;
};

// The sidecar catalog is persisted by the main process, but this cache keeps
// the already-read catalog available when the Profiles page is remounted.
// A remount must not turn the page navigation into another synchronous scan.
const gameCatalogSession: GameCatalogSessionCache = {
  catalog: [],
  settings: [],
  loaded: false,
  loading: null,
  scanStarted: false,
  scanLoading: null,
};

function loadGameCatalogSession(force = false): Promise<void> {
  if (gameCatalogSession.loading) return gameCatalogSession.loading;
  if (gameCatalogSession.loaded && !force) return Promise.resolve();
  gameCatalogSession.loading = api.gameCatalogList().then((result) => {
    gameCatalogSession.catalog = Array.isArray(result.catalog) ? result.catalog : [];
    gameCatalogSession.settings = Array.isArray(result.settings) ? result.settings : [];
    gameCatalogSession.loaded = true;
  }).finally(() => {
    gameCatalogSession.loading = null;
  });
  return gameCatalogSession.loading;
}

function refreshGameCatalogSession(scan: boolean): Promise<void> {
  if (!scan) return loadGameCatalogSession();
  if (gameCatalogSession.scanLoading) return gameCatalogSession.scanLoading;
  gameCatalogSession.scanStarted = true;
  gameCatalogSession.scanLoading = (async () => {
    const result = await api.gamesScan();
    if (result.error) toast('warn', 'Game scan unavailable', result.error);
    if (result.sidecarError) toast('warn', 'Game catalog unavailable', result.sidecarError);
    await loadGameCatalogSession(true);
  })().finally(() => {
    gameCatalogSession.scanLoading = null;
  });
  return gameCatalogSession.scanLoading;
}

function newProfileId(): string {
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// M4-H (B): exported for the Tuning page's "Save as Profile" card (the
// profiles page's own create/save flows stay untouched).
export { newProfileId };

/** M152: the renderer's current physical GPU identity for profile binding. */
export function profileGpuIdentity(state: Pick<AppState, 'devices' | 'deviceId' | 'caps'>): { key: string | null; label: string } {
  const gpu = state.devices.find((device) => device.id === state.deviceId) ?? null;
  return {
    key: gpu?.deviceKey ?? state.caps?.deviceKey ?? null,
    label: gpu?.name ?? state.caps?.deviceName ?? 'Current GPU',
  };
}

/** Resolve a saved profile to its physical adapter without using the focused
 * adapter as an ordinal fallback. Legacy profiles intentionally target the
 * focused adapter until their first successful load binds them. */
export function profileTargetDevice(
  state: Pick<AppState, 'devices' | 'deviceId'>,
  profile: Pick<Profile, 'deviceKey'>,
): DeviceInfo | null {
  const devices = Array.isArray(state.devices) ? state.devices : [];
  if (typeof profile.deviceKey === 'string' && profile.deviceKey.trim()) {
    const matches = devices.filter((device) => device.deviceKey === profile.deviceKey);
    return matches.length === 1 ? matches[0] : null;
  }
  if (!Number.isInteger(state.deviceId)) return null;
  return devices.find((device) => device.id === state.deviceId) ?? null;
}

/** M156: every tuning profile card identifies its owning physical adapter. */
export function profileOwnerLabel(profile: Pick<Profile, 'deviceKey' | 'deviceName'>): string {
  const model = chipLabelGpu(profile.deviceName ?? '');
  if (model) {
    // Inventory names may carry a test-fixture marker or the VRAM suffix
    // (for example, "A770 fixture 16GB GDDR6"). A profile badge identifies
    // the GPU model only, so stop before those descriptive tokens.
    const tokens = model.split(/\s+/).filter((token) => token.toLowerCase() !== 'mock');
    const cutoff = tokens.findIndex((token) => /^(?:fixture|\d+(?:\.\d+)?(?:gb|mb)|gddr\d*x?|hbm\d*)$/i.test(token));
    const compact = tokens.slice(0, cutoff >= 0 ? cutoff : tokens.length).join(' ').trim();
    if (compact) return `GPU: ${compact}`;
  }
  return profile.deviceKey ? 'GPU: Unknown' : 'GPU: Legacy';
}

/** A profile without a key is a legacy profile and can be migrated on the
 * first successful load; keyed profiles are usable only on that adapter. */
export function profileMatchesGpu(profile: Profile, deviceKey: string | null): boolean {
  const profileKey = profile.deviceKey ?? null;
  return profileKey === null ? deviceKey === null || deviceKey.length > 0 : profileKey === deviceKey;
}

export function activeProfileIds(settings: ProfilesEnvelope['settings']): Record<string, string> {
  const value = settings.activeProfileIds;
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).filter(([key, id]) => Boolean(key) && typeof id === 'string' && id.length > 0));
}

/** Resolve the active profile for the focused GPU, retaining scalar legacy
 * compatibility without showing GPU A's profile as active on GPU B. */
export function activeProfileIdForGpu(settings: ProfilesEnvelope['settings'], profiles: Profile[], deviceKey: string | null): string | null {
  const mapped = deviceKey ? activeProfileIds(settings)[deviceKey] : undefined;
  if (mapped && profiles.some((profile) => profile.id === mapped && profileMatchesGpu(profile, deviceKey))) return mapped;
  const legacy = settings.activeProfileId;
  const profile = profiles.find((candidate) => candidate.id === legacy);
  return profile && profileMatchesGpu(profile, deviceKey) ? legacy : null;
}

/** Only mappings whose profile is actually bound to the mapped physical GPU
 * count as active. Stale or cross-GPU IDs are intentionally ignored. */
export function validActiveProfileIds(settings: ProfilesEnvelope['settings'], profiles: Profile[]): Set<string> {
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const [deviceKey, profileId] of Object.entries(activeProfileIds(settings))) {
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (profile && profileMatchesGpu(profile, deviceKey) && !keys.has(deviceKey)) {
      ids.add(profileId);
      keys.add(deviceKey);
    }
  }
  const legacy = profiles.find((profile) => profile.id === settings.activeProfileId);
  if (legacy && (!legacy.deviceKey || !keys.has(legacy.deviceKey))) ids.add(legacy.id);
  return ids;
}

export function profileIsActiveForGpu(profile: Profile, settings: ProfilesEnvelope['settings'], profiles: Profile[], deviceKey: string | null): boolean {
  return activeProfileIdForGpu(settings, profiles, deviceKey) === profile.id;
}

export function profileIsActiveOnOtherGpu(profile: Profile, settings: ProfilesEnvelope['settings'], profiles: Profile[], deviceKey: string | null): boolean {
  const mappedElsewhere = Object.entries(activeProfileIds(settings)).some(([mappedKey, profileId]) => (
    mappedKey !== deviceKey && profileId === profile.id && profileMatchesGpu(profile, mappedKey)
  ));
  if (mappedElsewhere) return true;
  return settings.activeProfileId === profile.id
    && !profileMatchesGpu(profile, deviceKey);
}

/**
 * Build a Settings payload from the driver's current read-back (only
 * controls the UI understands; expert controls gpuLock/vfCurve are excluded -
 * they are not editable in M2b and a saved {0,0} lock pair would mislead).
 * M20-B (plan F4): the read-back derives 'fixed' from a FLAT TABLE (TABLE
 * mode + numPoints >= 2 + every speed within 1 + PERCENT) while keeping the
 * table points in fanCurve - saving that derived 'fixed' as-is would
 * collapse the user's table points (incl. custom temps) into the 20/100
 * fixed convention. A flat-table fixed therefore saves as fanMode='curve' +
 * the flat fanCurve (no fixedFanPct); a genuine driver fixed (mode-1 via
 * fixedFanPct, no flat table) keeps 'fixed' + fixedFanPct. M20-B step-5 R2:
 * the derivation ALSO requires the flat curve's speed to match
 * fixedFanPct - a stale flat fanCurve paired with a mismatched fixedFanPct
 * (a mode-1-capable card edge) must not classify as derived (it would drop
 * the fixedFanPct). Derived-fixed satisfies this by construction (both
 * backends set fixedFanPct from the common speed). M20-B step-5 R3 (R4):
 * fanCurve is meaningful ONLY in curve (or derived-fixed) mode - an
 * auto-mode read-back can still carry the last table points (the config
 * struct keeps the table across mode switches; the mock mirrors it), and
 * shipping them in an auto payload would make the profile-load RE-write the
 * table (flipping the mode back to curve) - auto never carries a table.
 */
export function settingsFromState(state: DeviceState): Settings {
  const out: Settings = {};
  const curve = state.fanCurve;
  const flatTableFixed = state.fanMode === 'fixed'
    && Array.isArray(curve) && curve.length >= 2
    && curve.every((p) => Math.abs(p.speedPct - curve[0].speedPct) <= 1)
    && typeof state.fixedFanPct === 'number'
    && Math.abs(curve[0].speedPct - state.fixedFanPct) <= 1;
  for (const key of SCALAR_KEYS) {
    // M20-B step-5 R2 (F3): fixedFanPct is meaningful ONLY in fixed mode -
    // a curve/auto-mode read-back can still carry the last fixed speed (the
    // config struct keeps the speedFixed field across mode switches; the
    // mock mirrors it). Shipping it in a curve payload would make the
    // profile-load RE-write a fixed speed the user never asked for (the
    // table is the curve-mode authority) - the derived flat-table fixed
    // (fanMode 'fixed' + flat curve) already omits it above.
    if (key === 'fixedFanPct' && (flatTableFixed || state.fanMode !== 'fixed')) continue;
    const v = state[key as keyof DeviceState];
    if (typeof v === 'number') (out as Record<string, number>)[key] = v;
  }
  if (state.fanMode) out.fanMode = flatTableFixed ? 'curve' : state.fanMode;
  // M20-B step-5 R3 (R4): fanCurve is meaningful ONLY in curve (or
  // derived-fixed) mode - an auto read-back can still carry the last table
  // points (the config struct keeps the table across mode switches; the mock
  // mirrors it). Shipping them in an auto payload would make the
  // profile-load RE-write the table (flipping the mode back to curve) -
  // auto never carries a table.
  if (state.fanCurve && state.fanMode !== 'auto') out.fanCurve = state.fanCurve;
  if (state.vfCurve && state.vfCurve.length >= 2) {
    out.vfCurve = state.vfCurve.map((point) => ({ voltageV: point.voltageV, freqMhz: point.freqMhz }));
  }
  return out;
}

/**
 * Profile settings are canonical driver values, but a profile can be shown
 * while a different GPU is focused. Prefer the saved GPU family when the
 * current caps would otherwise give a different unit vocabulary. This keeps
 * a B580 profile's percent-shaped driver values from being summarized with
 * the focused A770's W/V/C ranges (and the reverse).
 */
function profileSummaryRange(key: string, caps: Capabilities | null, profileDeviceName: string): RangeInfo | null {
  const range = caps?.ranges[key] ?? null;
  const battlemage = isBattlemageGpuName(profileDeviceName);
  const alchemist = isAlchemistGpuName(profileDeviceName);
  const canonicalUnit = key === 'gpuVoltOffsetV' || key === 'vramVoltOffsetV'
    ? 'V'
    : key === 'powerLimitW' ? 'W'
      : key === 'tempLimitC' ? 'C' : null;

  if (battlemage && key === 'vramFreqOffsetGts') {
    return range ? { ...range, units: 'MHz' } : { min: 0, max: 0, step: 1, default: 0, units: 'MHz' };
  }
  if (battlemage && (canonicalUnit || key === 'powerLimitW')) {
    return range ? { ...range, units: '%' } : { min: 0, max: 0, step: 1, default: 0, units: '%' };
  }
  if (alchemist && canonicalUnit) {
    return range ? { ...range, units: canonicalUnit } : { min: 0, max: 0, step: 1, default: 0, units: canonicalUnit };
  }
  return range;
}

export function settingsSummary(settings: Settings, caps: Capabilities | null, profileDeviceName = caps?.deviceName ?? ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value !== 'number') continue;
    const compactSigned = (number: number, suffix: string): string => `${number >= 0 ? '+' : ''}${number}${suffix}`;
    const range = profileSummaryRange(key, caps, profileDeviceName);
    const display = range ? controlDisplay(key, range, profileDeviceName) : null;
    const displayValue = display ? display.toDisplay(value) : value;
    if (key === 'powerLimitW') {
      out.push(`${Math.round(displayValue)}W`);
    }
    else if (key === 'gpuVoltOffsetV' || key === 'vramVoltOffsetV') {
      const voltage = display?.units === 'V' ? displayValue * 1000 : displayValue;
      out.push(compactSigned(Math.round(voltage), 'mV'));
    }
    else if (key === 'gpuFreqOffsetMhz') out.push(compactSigned(Math.round(displayValue), display?.units ?? 'MHz'));
    else if (key === 'vramFreqOffsetGts') {
      if (display?.units === 'MHz') out.push(`${Math.round(displayValue)}MHz`);
      else out.push(compactSigned(Math.round(displayValue * 10) / 10, display?.units ?? 'GTS'));
    }
    else if (key === 'tempLimitC') out.push(`TL: ${Math.round(displayValue)}°C`);
    else if (key === 'fixedFanPct') out.push(`Fan ${Math.round(value)}%`);
    else {
      const units = caps?.ranges[key]?.units ?? '';
      out.push(`${CONTROL_LABELS[key] ?? key} ${formatValue(value, units)}`);
    }
  }
  if (settings.fanCurve) out.push('Fan Curve');
  else if (settings.fanMode && settings.fanMode !== 'auto') out.push(`Fan ${settings.fanMode}`);
  return out;
}

/** Keep a saved profile's fan payload compatible with the focused physical
 * adapter. Scalar tuning values remain loadable when only the fan surface is
 * unsupported or exposes a different set of modes. */
export function profileSettingsForCapabilities(settings: Settings, caps: Capabilities | null): Settings {
  const out = { ...settings };
  const fanKeys = ['fanMode', 'fanCurve', 'fixedFanPct'] as const;
  if (caps?.fan?.canControl !== true) {
    for (const key of fanKeys) delete out[key];
    return out;
  }
  const requestedMode = settings.fanMode ?? (settings.fanCurve ? 'curve' : null);
  if (requestedMode && !caps.fan.modes.includes(requestedMode)) {
    for (const key of fanKeys) delete out[key];
    return out;
  }
  if (settings.fanCurve && !caps.fan.modes.includes('curve')) delete out.fanCurve;
  if (settings.fixedFanPct !== undefined && !caps.fan.modes.includes('fixed')) delete out.fixedFanPct;
  return out;
}

function artworkTile(artwork: string | undefined, label: string, className = ''): HTMLElement {
  const isDataArtwork = typeof artwork === 'string' && artwork.length <= 750000
    && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(artwork);
  const safeKey = isDataArtwork || (typeof artwork === 'string' && /^(?:local:arc-power|fallback-[a-z0-9_-]{1,48})$/.test(artwork))
    ? artwork : `fallback-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || 'app'}`;
  let hash = 0;
  for (const char of safeKey) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  const initials = label.split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('') || '?';
  return el('span', { class: `profile-artwork profile-artwork-tone-${Math.abs(hash) % 5}${isDataArtwork ? ' has-artwork' : ''}${className ? ` ${className}` : ''}`, dataset: { artwork: safeKey } }, [
    el('img', { src: isDataArtwork ? artwork : './assets/game-cover-fallback.png', alt: '', 'aria-hidden': 'true' }),
    el('span', { class: 'profile-artwork-initials', text: initials }),
  ]);
}

function gameBannerTile(banner: string | undefined, artwork: string | undefined, label: string, className = ''): HTMLElement {
  const isDataBanner = typeof banner === 'string' && banner.length <= MAX_GAME_BANNER_DATA_LENGTH
    && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(banner);
  const isDataArtwork = typeof artwork === 'string' && artwork.length <= 750000
    && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(artwork);
  const image = isDataBanner ? banner : isDataArtwork ? artwork : './assets/game-cover-fallback.png';
  let hash = 0;
  for (const char of label) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  const initials = label.split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('') || '?';
  return el('span', {
    class: `profile-artwork profile-artwork-tone-${Math.abs(hash) % 5}${isDataBanner || isDataArtwork ? ' has-artwork' : ''}${className ? ` ${className}` : ''}`,
    dataset: { hasBanner: isDataBanner ? 'true' : 'false' },
  }, [
    el('img', { src: image, alt: '', 'aria-hidden': 'true', decoding: 'async' }),
    el('span', { class: 'profile-artwork-initials', text: initials }),
  ]);
}

// ---------------------------------------------------------------------------
// Minimal prompt/confirm modals (same modal-root as the waiver dialog)
// ---------------------------------------------------------------------------

const ROOT_ID = 'modal-root';

function modalRoot(): HTMLElement {
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = el('div', { id: ROOT_ID });
    document.body.append(root);
  }
  return root;
}

function promptModal(title: string, initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    const root = modalRoot();
    clear(root);
    const close = (value: string | null) => {
      clear(root);
      resolve(value);
    };
    const input = el('input', { type: 'text', class: 'modal-input', value: initial, placeholder: 'Profile name' }) as HTMLInputElement;
    const save = el('button', {
      class: 'btn btn-primary',
      text: 'Save',
      onClick: () => close(input.value.trim() || null),
    });
    input.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key === 'Enter') save.click();
      if (ev.key === 'Escape') close(null);
    });
    root.append(el('div', { class: 'modal-overlay' }, [
      el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
        el('h2', { class: 'modal-title', text: title }),
        el('div', { class: 'modal-body' }, [input]),
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'btn btn-ghost', text: 'Cancel', onClick: () => close(null) }),
          save,
        ]),
      ]),
    ]));
    input.focus();
    input.select();
  });
}

// M4-H (B): the prompt modal is exported for the Tuning page's "Save as
// Profile" card (prefilled with the applied profile's name on override).
export { promptModal };

function confirmModal(title: string, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const root = modalRoot();
    clear(root);
    const close = (yes: boolean) => {
      clear(root);
      resolve(yes);
    };
    root.append(el('div', { class: 'modal-overlay' }, [
      el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
        el('h2', { class: 'modal-title', text: title }),
        el('p', { class: 'modal-text', text }),
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'btn btn-ghost', text: 'Cancel', onClick: () => close(false) }),
          el('button', { class: 'btn btn-danger', text: 'Delete', onClick: () => close(true) }),
        ]),
      ]),
    ]));
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export const profilesPage: Page = {
  id: 'profiles',

  render(container: HTMLElement, ctx: PageContext) {
    clear(container);
    container.append(
      el('h1', { class: 'page-title', text: 'Profiles' }),
      el('p', { id: 'profiles-subtitle', class: 'page-subtitle', text: 'Save and load named tuning presets. Loading applies the profile immediately; the active profile can start at boot.' }),
      el('div', { id: 'profiles-root', class: 'profiles-root' }, [el('p', { class: 'page-subtitle', text: 'Loading profiles…' })]),
    );
    void mount(ctx, container);
  },
};

/** Merge one Game Profile GPU assignment without treating null as missing.
 * Selecting Normal intentionally clears tuningProfileId, while an omitted
 * field means that only another part of the assignment is being edited. */
export function mergeGameGpuSettings(current: GameGpuProfile, patch: Partial<GameGpuProfile>): Pick<GameGpuProfile, 'enabled' | 'tuningProfileId' | 'graphics'> {
  return {
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
    tuningProfileId: patch.tuningProfileId !== undefined ? patch.tuningProfileId : current.tuningProfileId,
    graphics: patch.graphics ? { ...(current.graphics ?? {}), ...patch.graphics } : (current.graphics ?? {}),
  };
}

/** Game Profile targets must be uniquely addressable writable physical GPUs. */
export function gameProfileTargetDevices(devices: DeviceInfo[]): DeviceInfo[] {
  return (Array.isArray(devices) ? devices : []).filter((device) => device.synthetic !== true
    && device.backendKind !== 'os' && device.identityAmbiguous !== true
    && typeof device.deviceKey === 'string' && device.deviceKey.length > 0);
}

export function gameProfileTargetDevice(devices: DeviceInfo[], deviceKey: string | null): DeviceInfo | null {
  if (typeof deviceKey !== 'string' || deviceKey.length === 0) return null;
  const matches = gameProfileTargetDevices(devices).filter((device) => device.deviceKey === deviceKey);
  return matches.length === 1 ? matches[0] : null;
}

async function mount(ctx: PageContext, container: HTMLElement): Promise<void> {
  const root = container.querySelector('#profiles-root') as HTMLElement;
  const s = ctx.store.get();
  const caps = s.caps;
  const state = s.state;
  if (!caps || !state) {
    clear(root);
    root.append(el('p', { class: 'page-subtitle', text: 'Device state not loaded yet - try again in a moment.' }));
    return;
  }
  if (s.deviceId === null) {
    clear(root);
    root.append(el('p', { class: 'page-subtitle', text: 'No GPU available.' }));
    return;
  }

  let envelope: ProfilesEnvelope;
  let bootState: StartupGetState | null = null;
  let gameCatalog: GameCatalogEntry[] = gameCatalogSession.catalog;
  let gameSettings: GameSettingsRecord[] = gameCatalogSession.settings;
  let gameCatalogLoaded = gameCatalogSession.loaded;
  let gameCatalogLoading = Boolean(gameCatalogSession.loading || gameCatalogSession.scanLoading);
  let gameCatalogError: string | null = null;
  let gameProfileCapabilities: GameProfileCapabilities = { enduranceGaming: false, xeFg: false, xeFgOptions: [] };
  let gameCapabilityRequestGeneration = 0;
  let viewMode: 'oc' | 'game' = 'oc';
  let selectedGameExePath: string | null = null;
  let selectedGameDeviceKey: string | null = profileGpuIdentity(s).key;
  let startupWarning: string | null = null;
  let showFilter = 'all';
  let sortMode = 'alphabetical';
  let cardMode: 'grid' | 'list' = 'grid';
  const profileSubtitle = container.querySelector<HTMLElement>('#profiles-subtitle');
  const updateProfileCopy = (): void => {
    if (!profileSubtitle) return;
    profileSubtitle.textContent = viewMode === 'game'
      ? 'Save and load named game presets. Enable a game profile only when that executable should override the selected GPU\'s graphics settings.'
      : 'Save and load named tuning presets. Each profile is tied to the GPU shown on its card and applies only to that GPU.';
  };
  try {
    // The optional per-game sidecar must never gate the legacy profile page.
    // Keep the independent profile/startup calls usable even when the
    // sidecar is corrupt, partially written, or from a newer schema.
    envelope = await api.profilesList();
  } catch (err) {
    clear(root);
    root.append(el('p', { class: 'text-error', text: `Could not load profiles: ${err instanceof Error ? err.message : String(err)}` }));
    return;
  }
  const deviceId = s.deviceId;
  const gpuIdentity = profileGpuIdentity(s);
  try { bootState = await api.startupGet(); }
  catch (err) { startupWarning = `Start-at-boot state unavailable: ${err instanceof Error ? err.message : String(err)}`; }

  const modeToggle = (): HTMLElement => el('div', { class: 'profiles-mode-toggle', role: 'group', 'aria-label': 'Profiles view' }, [
    el('button', { class: `btn btn-ghost btn-sm${viewMode === 'oc' ? ' active' : ''}`, text: 'Tuning Profile', onclick: () => { viewMode = 'oc'; selectedGameExePath = null; updateProfileCopy(); renderList(); } }),
    el('button', { class: `btn btn-ghost btn-sm${viewMode === 'game' ? ' active' : ''}`, text: 'Game Profile', onclick: () => void openGameView() }),
  ]);

  const syncGameCatalogSession = (): void => {
    gameCatalog = gameCatalogSession.catalog;
    gameSettings = gameCatalogSession.settings;
    gameCatalogLoaded = gameCatalogSession.loaded;
  };

  const loadGameCatalog = async (): Promise<void> => {
    gameCatalogLoading = true;
    try {
      await loadGameCatalogSession();
      syncGameCatalogSession();
    } finally {
      gameCatalogLoading = false;
    }
  };

  const refreshGameCatalog = (scan: boolean, quiet = false): Promise<void> => {
    gameCatalogError = null;
    gameCatalogLoading = true;
    return refreshGameCatalogSession(scan).then(() => {
      syncGameCatalogSession();
    }).catch((err) => {
      gameCatalogError = err instanceof Error ? err.message : String(err);
      if (!quiet) toast('error', 'Game catalog unavailable', gameCatalogError);
      throw err;
    }).finally(() => {
      gameCatalogLoading = false;
    });
  };

  const gameDevices = (): DeviceInfo[] => {
    return gameProfileTargetDevices(s.devices);
  };

  const gameDeviceFor = (deviceKey: string | null): DeviceInfo | null => {
    return gameProfileTargetDevice(gameDevices(), deviceKey);
  };

  const gameGpuLabel = (device: DeviceInfo): string => {
    const chip = chipLabelGpu(device.name) ?? device.name;
    return chip.match(/\b(?:A|B)\d{3,4}\b/i)?.[0] ?? chip;
  };

  const gameSettingFor = (exePath: string): GameSettingsRecord | null => gameSettings.find((item) => item.exePath === exePath) ?? null;

  const gameGpuSettingFor = (record: GameSettingsRecord | null, device: DeviceInfo): GameGpuProfile => {
    const key = device.deviceKey ?? null;
    const exact = record?.gpuProfiles?.find((profile) => (profile.deviceKey ?? null) === key);
    if (exact) return exact;
    const legacy = record?.gpuProfiles?.find((profile) => profile.deviceKey === null)
      ?? (record && !record.gpuProfiles ? {
        deviceKey: null,
        deviceName: null,
        enabled: record.enabled,
        tuningProfileId: record.tuningProfileId,
        graphics: record.graphics,
      } : null);
    if (legacy && device.id === deviceId) return { ...legacy, deviceKey: key, deviceName: device.name };
    return { deviceKey: key, deviceName: device.name, enabled: false, tuningProfileId: null, graphics: {} };
  };

  const gameProfileEnabled = (record: GameSettingsRecord | null): boolean => record?.gpuProfiles?.some((profile) => profile.enabled === true) || record?.enabled === true;

  const renderGameCatalog = (): void => {
    const cards = gameCatalog.map((game) => {
      const settings = gameSettingFor(game.exePath);
      return el('button', { class: 'game-catalog-card', dataset: { exePath: game.exePath }, onclick: () => void openGameDetail(game) }, [
        gameBannerTile(game.banner, game.artwork, game.displayName, 'game-catalog-artwork'),
        el('span', { class: 'game-catalog-copy' }, [el('strong', { text: game.displayName }), el('small', { text: gameProfileEnabled(settings) ? 'Game Profile enabled' : 'Game Profile off' })]),
      ]);
    });
    clear(root);
    root.append(modeToggle(), el('section', { class: 'profile-browser game-catalog-browser' }, [
      el('div', { class: 'profile-browser-head' }, [
        el('div', { class: 'profile-browser-title' }, [el('h2', { class: 'card-title', text: 'Installed Games' }), el('p', { class: 'card-note', text: 'Installed games remain here even when they are not running.' })]),
        el('div', { class: 'profile-browser-actions' }, [
          el('button', { class: 'btn btn-primary btn-sm game-catalog-add', text: 'Manually Add Game', onclick: () => void addGameManually() }),
          el('button', { class: 'btn btn-ghost btn-sm game-catalog-scan', text: 'Scan for Games', onclick: () => void scanGameCatalog() }),
          el('button', { class: 'btn btn-ghost btn-sm game-catalog-refresh', text: 'Refresh', onclick: () => void scanGameCatalog() }),
        ]),
      ]),
      gameCatalogError && !gameCatalog.length
        ? el('p', { class: 'text-error game-catalog-empty', text: gameCatalogError })
        : gameCatalog.length
          ? el('div', { class: 'game-catalog-grid' }, cards)
          : el('p', { class: 'card-note game-catalog-empty', text: gameCatalogLoading || gameCatalogSession.loading || gameCatalogSession.scanLoading ? 'Loading installed games…' : 'No installed games were found.' }),
    ]));
  };

  const openGameDetail = async (game: GameCatalogEntry, requestedDeviceKey: string | null = selectedGameDeviceKey): Promise<void> => {
    selectedGameExePath = game.exePath;
    const targetDevice = gameDeviceFor(requestedDeviceKey);
    selectedGameDeviceKey = targetDevice?.deviceKey ?? requestedDeviceKey;
    if (!targetDevice) {
      renderGameDetail(game, null);
      return;
    }
    const requestGeneration = ++gameCapabilityRequestGeneration;
    gameProfileCapabilities = { enduranceGaming: false, xeFg: false, xeFgOptions: [] };
    try {
      const capabilities = await api.gameProfileCapabilities(targetDevice?.id ?? deviceId, game.exePath);
      if (requestGeneration !== gameCapabilityRequestGeneration || selectedGameExePath !== game.exePath) return;
      gameProfileCapabilities = capabilities;
    } catch { /* unsupported surface stays hidden */ }
    if (requestGeneration === gameCapabilityRequestGeneration && viewMode === 'game' && selectedGameExePath === game.exePath) renderGameDetail(game, targetDevice ?? gameDeviceFor(selectedGameDeviceKey));
  };

  const renderGameDetail = (game: GameCatalogEntry, targetDevice: DeviceInfo | null = gameDeviceFor(selectedGameDeviceKey)): void => {
    if (!targetDevice) {
      clear(root);
      root.append(modeToggle(), el('p', { class: 'page-subtitle', text: 'No writable GPU is available for Game Profiles.' }));
      return;
    }
    const current = gameSettingFor(game.exePath);
    const gpuSettings = gameGpuSettingFor(current, targetDevice);
    const graphics: GameProfileGraphics = gpuSettings.graphics ?? {};
    const targetKey = targetDevice.deviceKey ?? null;
    const availableProfiles = envelope.profiles.filter((profile) => !profile.deviceKey || profile.deviceKey === targetKey);
    const selectedTuningProfileId = gpuSettings.tuningProfileId && availableProfiles.some((profile) => profile.id === gpuSettings.tuningProfileId)
      ? gpuSettings.tuningProfileId
      : '';
    const tuning = el('select', { class: 'profile-setting-control game-setting-control', value: selectedTuningProfileId }, [
      el('option', { value: '', text: `Normal (${gameGpuLabel(targetDevice)} active profile)` }),
      ...availableProfiles.map((profile) => el('option', { value: profile.id, text: `${profile.name} · ${profileOwnerLabel(profile).replace(/^GPU:\s*/, '')}` })),
    ]) as HTMLSelectElement;
    const endurance = el('select', { class: 'profile-setting-control game-setting-control', value: graphics.enduranceGaming ?? 'off', disabled: !gameProfileCapabilities.enduranceGaming }, [
      el('option', { value: 'off', text: 'Off' }), el('option', { value: 'on', text: 'On' }),
    ]) as HTMLSelectElement;
    const xeFgOptions = gameProfileCapabilities.xeFgOptions.length > 0 ? gameProfileCapabilities.xeFgOptions : ['app-choice'];
    const xeFgLabels: Record<string, string> = {
      'app-choice': 'Application Default',
      '2x': '2x Frame Generation',
      '3x': '3x Frame Generation',
      '4x': '4x Frame Generation',
    };
    const xeFg = el('select', { class: 'profile-setting-control game-setting-control', value: graphics.frameGenOverride ?? 'app-choice' },
      xeFgOptions.map((option) => el('option', { value: option, text: xeFgLabels[option] ?? option }))) as HTMLSelectElement;
    const frame = el('select', { class: 'profile-setting-control game-setting-control', value: graphics.flipMode ?? 'application-default' }, [
      el('option', { value: 'application-default', text: 'Application Choice' }), el('option', { value: 'vsync-on', text: 'VSync On' }), el('option', { value: 'vsync-off', text: 'VSync Off' }), el('option', { value: 'smooth-sync', text: 'Smooth Sync' }), el('option', { value: 'speed-frame', text: 'Speed / Frame' }), el('option', { value: 'smart-vsync', text: 'Smart VSync' }),
    ]) as HTMLSelectElement;
    const fps = el('input', { class: 'profile-setting-check game-setting-control', type: 'checkbox', checked: graphics.frameLimit?.enabled === true }) as HTMLInputElement;
    const fpsValue = el('input', { class: 'profile-setting-number game-setting-control', type: 'number', min: 1, max: 1000, value: graphics.frameLimit?.value ?? 60 }) as HTMLInputElement;
    const latency = el('select', { class: 'profile-setting-control game-setting-control', value: graphics.lowLatency ?? 'off' }, [
      el('option', { value: 'off', text: 'Off' }), el('option', { value: 'on', text: 'On' }), el('option', { value: 'on-boost', text: 'On + Boost' }),
    ]) as HTMLSelectElement;
    const save = (patch: Partial<GameGpuProfile>): void => { void onGameSettingsSave(game, targetDevice, patch); };
    const gpuSwitch = el('div', { class: 'game-profile-gpu-switch', role: 'tablist', 'aria-label': 'Game Profile GPU' }, gameDevices().map((device) => el('button', {
      class: `btn btn-ghost btn-sm${(device.deviceKey ?? null) === targetKey ? ' active' : ''}`,
      text: gameGpuLabel(device),
      title: device.name,
      role: 'tab',
      'aria-selected': (device.deviceKey ?? null) === targetKey ? 'true' : 'false',
      onclick: () => void openGameDetail(game, device.deviceKey ?? null),
    })));
    const detail = el('div', { class: 'profile-detail game-profile-detail' }, [
        el('div', { class: 'profile-detail-head game-profile-detail-head' }, [
          el('button', { class: 'btn btn-ghost btn-sm game-profile-back', text: 'Back to catalog', onclick: () => { selectedGameExePath = null; renderGameCatalog(); } }),
          el('div', { class: 'game-profile-title' }, [el('span', { class: 'profile-breadcrumb-sep', text: '›' }), el('h2', { class: 'card-title', text: game.displayName })]),
        ]),
      el('div', { class: 'profile-app-badge' }, [artworkTile(game.artwork, game.displayName, 'profile-artwork-small'), el('span', { text: `${game.displayName}  ·  ${game.exePath}` })]),
      el('section', { class: 'card game-profile-target-card' }, [el('div', { class: 'game-profile-target-copy' }, [el('strong', { text: 'GPU target' }), el('small', { text: targetDevice.name })]), gpuSwitch]),
      el('section', { class: 'card profile-use-card' }, [el('label', { class: 'profile-use-toggle' }, [el('input', { class: 'game-use-profile', type: 'checkbox', checked: gpuSettings.enabled === true, onchange: (ev: Event) => save({ enabled: (ev.target as HTMLInputElement).checked }) }), el('span', { text: `Use Profile for ${gameGpuLabel(targetDevice)}` })]), el('span', { class: 'card-note', text: 'This assignment affects only the selected GPU. Other GPU assignments remain independent.' })]),
      el('section', { class: 'profile-settings-section game-igs-settings' }, [
        el('h3', { class: 'profile-section-title', text: 'Tuning Profile' }),
        settingRow('Overclock preset', `Applied to ${gameGpuLabel(targetDevice)} while this game is running, then restored to that GPU's active normal profile.`, tuning),
      ]),
      ...(gameProfileCapabilities.enduranceGaming ? [el('section', { class: 'profile-settings-section game-igs-settings' }, [
        el('h3', { class: 'profile-section-title', text: 'General' }),
        settingRow('Endurance Gaming', 'Extend gameplay on battery with platform and frame rate tuning for supported games.', endurance),
      ])] : []),
      el('section', { class: 'profile-settings-section game-igs-settings' }, [
        el('h3', { class: 'profile-section-title', text: 'Frame Delivery' }),
        ...(gameProfileCapabilities.xeFg ? [settingRow('XeFG multiplier', 'Per-game frame-generation multiplier.', xeFg)] : []),
        settingRow('Frame Synchronization', 'Sets the method used for vertically syncing the rendered image to the display.', frame),
        settingRow('FPS Limiter', 'Saved independently for this executable.', el('span', { class: 'profile-inline-control' }, [fps, fpsValue])),
        settingRow('Low Latency Mode', 'Improves the responsiveness between user input and graphics rendering for a better gaming experience.', latency),
      ]),
      el('p', { class: 'profile-capability-note', text: `When Use Profile is enabled for ${gameGpuLabel(targetDevice)}, its tuning preset and Graphics values are applied only to that GPU.` }),
    ]);
    tuning.addEventListener('change', () => save({ tuningProfileId: tuning.value || null }));
    endurance.addEventListener('change', () => save({ graphics: { enduranceGaming: endurance.value as 'off' | 'on' } }));
    xeFg.addEventListener('change', () => { if (gameProfileCapabilities.xeFg) save({ graphics: { frameGenOverride: xeFg.value as FrameGenOverride } }); });
    frame.addEventListener('change', () => save({ graphics: { flipMode: frame.value as FlipMode } }));
    latency.addEventListener('change', () => save({ graphics: { lowLatency: latency.value as LowLatency } }));
    fps.addEventListener('change', () => save({ graphics: { frameLimit: { enabled: fps.checked, value: Number(fpsValue.value) || 60 } } }));
    fpsValue.addEventListener('change', () => save({ graphics: { frameLimit: { enabled: fps.checked, value: Number(fpsValue.value) || 60 } } }));
    clear(root); root.append(modeToggle(), detail);
  };

  const scanGameCatalog = async (): Promise<void> => {
    try {
      await refreshGameCatalog(true);
      if (viewMode === 'game') renderGameCatalog();
    } catch {
      if (viewMode === 'game') renderGameCatalog();
    }
  };

  const addGameManually = async (): Promise<void> => {
    try {
      const result = await api.gameCatalogAdd();
      if (result.canceled) return;
      gameCatalogSession.catalog = Array.isArray(result.catalog) ? result.catalog : gameCatalogSession.catalog;
      gameCatalogSession.settings = Array.isArray(result.settings) ? result.settings : gameCatalogSession.settings;
      gameCatalogSession.loaded = true;
      syncGameCatalogSession();
      toast('success', 'Game added', 'The executable was added to Game Profiles and will survive future scans.');
      if (viewMode === 'game') renderGameCatalog();
    } catch (err) {
      toast('error', 'Game could not be added', err instanceof Error ? err.message : String(err));
    }
  };

  const openGameView = (): void => {
    viewMode = 'game';
    updateProfileCopy();
    renderGameCatalog();
    if (selectedGameExePath) {
      const selected = gameCatalog.find((item) => item.exePath === selectedGameExePath);
      if (selected) { void openGameDetail(selected); return; }
      selectedGameExePath = null;
    }
    if (!gameCatalogLoaded) {
      void loadGameCatalog().then(() => {
        if (viewMode !== 'game') return;
        if (selectedGameExePath) {
          const selected = gameCatalog.find((item) => item.exePath === selectedGameExePath);
          if (selected) { void openGameDetail(selected); return; }
        }
        renderGameCatalog();
      }).catch(() => { if (viewMode === 'game') renderGameCatalog(); });
    }
  };

  const refresh = async (): Promise<void> => {
    try {
      envelope = await api.profilesList();
    } catch { /* keep the last known list */ }
    try {
      bootState = await api.startupGet();
    } catch { /* keep the last known Run-key state */ }
    renderList();
  };

  const renderList = (): void => {
    const activeIds = validActiveProfileIds(envelope.settings, envelope.profiles);
    const activeProfiles = envelope.profiles.filter((p) => activeIds.has(p.id));
    const waiverAccepted = caps.waiverAccepted === true;
    // Honest ocOnBoot state: the startup-get derivation is the truth
    // (applyOnBoot = the Run value exists AND ocOnBoot is on AND an active
    // profile exists), settings.json the persisted intent - a mismatch
    // surfaces as a hint, never a lie.
    const applyOnBoot = bootState?.applyOnBoot === true;
    const bootMismatch = applyOnBoot !== (envelope.settings.ocOnBoot === true && activeProfiles.length > 0);

    const bootCard = el('section', { class: 'card boot-card' }, [
      el('h2', { class: 'card-title', text: 'Start at boot' }),
      el('div', { class: 'boot-row' }, [
        el('label', { class: 'boot-toggle' }, [
          el('input', {
            type: 'checkbox',
            class: 'boot-checkbox',
            checked: applyOnBoot,
            disabled: !waiverAccepted,
            onchange: (ev: Event) => void onBootToggle((ev.target as HTMLInputElement).checked),
          }),
          el('span', { text: 'Apply the active profile when Arc Power starts' }),
        ]),
      ]),
      !waiverAccepted
        ? el('p', { class: 'card-note', text: 'Accept the warranty waiver to enable start-at-boot.' })
        : activeProfiles.length > 0
          ? el('p', { class: 'card-note', text: `Applies ${activeProfiles.map((profile) => `"${profile.name}"`).join(' and ')} at boot.` })
          : el('p', { class: 'card-note', text: 'Load a profile first - start-at-boot applies active profiles for each GPU.' }),
      bootMismatch
        ? el('p', { class: 'card-note boot-hint', text: 'The startup registration and the saved settings disagree - the toggle reflects the registration.' })
        : null,
    ]);

    // Active state is per physical GPU, not per focused GPU. The focused GPU
    // still controls which card can be overwritten, but it must not decide
    // which already-loaded profile receives the blue active treatment.
    const filtered = envelope.profiles
      .filter((p) => showFilter === 'all' || activeIds.has(p.id));
    filtered.sort((a, b) => sortMode === 'recent' ? b.createdAt.localeCompare(a.createdAt) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const listCard = el('section', { class: 'profile-browser' }, [
      el('div', { class: 'profile-browser-head' }, [
        el('div', { class: 'profile-browser-title' }, [
          el('h2', { class: 'card-title', text: 'Profiles' }),
          el('p', { class: 'card-note', text: 'Each profile shows the physical GPU it belongs to.' }),
        ]),
      ]),
      el('div', { class: 'profile-browser-toolbar' }, [
        el('button', { class: 'btn btn-primary btn-sm profile-create', text: 'Add Profile +', onClick: () => void onCreate() }),
        el('label', { class: 'profile-filter-label', text: 'Show' }),
        el('select', { class: 'profile-filter', onchange: (ev: Event) => { showFilter = (ev.target as HTMLSelectElement).value; renderList(); } }, [
          el('option', { value: 'all', text: 'All Profiles' }), el('option', { value: 'active', text: 'Active' }),
        ]),
        el('label', { class: 'profile-filter-label', text: 'Sort' }),
        el('select', { class: 'profile-filter', onchange: (ev: Event) => { sortMode = (ev.target as HTMLSelectElement).value; renderList(); } }, [
          el('option', { value: 'alphabetical', text: 'Alphabetically' }), el('option', { value: 'recent', text: 'Recently created' }),
        ]),
        el('div', { class: 'profile-view-toggle' }, [
          el('button', { class: `btn btn-ghost btn-sm${cardMode === 'grid' ? ' active' : ''}`, text: 'Grid', onclick: () => { cardMode = 'grid'; renderList(); } }),
          el('button', { class: `btn btn-ghost btn-sm${cardMode === 'list' ? ' active' : ''}`, text: 'List', onclick: () => { cardMode = 'list'; renderList(); } }),
        ]),
      ]),
      filtered.length === 0
        ? el('p', { class: 'card-note profile-empty', text: envelope.profiles.length === 0 ? 'No profiles yet - add one to get started.' : 'No profiles match the current filter.' })
        : el('div', { class: `profile-list profile-cards ${cardMode === 'grid' ? 'profile-grid' : 'profile-list-mode'}` }, filtered.map((p) => profileRow(
          p,
          activeIds.has(p.id),
          gpuIdentity.key,
        ))),
    ]);

    clear(root);
    if (startupWarning) root.append(el('p', { class: 'card-note profile-sidecar-warning', role: 'status', text: startupWarning }));
    root.append(modeToggle(), bootCard, listCard);
  };

  const profileRow = (p: Profile, active: boolean, deviceKey: string | null): HTMLElement => {
    const usableOnCurrentGpu = profileMatchesGpu(p, deviceKey);
    const gpuLabel = profileOwnerLabel(p);
    // F3 instant apply (M2C-B): the Load button is a single trigger - one
    // attempt, immediate result (no in-flight cancel surface anymore).
    const loadBtn = el('button', {
      class: 'btn btn-primary btn-sm',
      text: 'Load',
      title: usableOnCurrentGpu ? 'Apply this profile to the current GPU' : `Apply this profile directly to ${gpuLabel}`,
    });
    let loadInFlight = false;
    loadBtn.addEventListener('click', () => {
      if (loadInFlight) return;
      loadInFlight = true;
      void onLoad(p, () => { loadInFlight = false; });
    });
    const row = el('div', {
      class: `profile-row${active ? ' profile-active' : ''}`,
      dataset: { id: p.id },
    }, [
      el('div', { class: 'profile-info' }, [
        el('span', { class: 'profile-name', text: p.name }),
        el('span', { class: 'badge profile-gpu-badge', text: gpuLabel, title: 'GPU this tuning profile belongs to' }),
        active ? el('span', { class: 'badge profile-badge', text: 'Active', title: 'Active for this profile\'s GPU' }) : null,
      ]),
      el('div', { class: 'chips profile-chips' }, settingsSummary(p.settings, caps, p.deviceName ?? caps?.deviceName ?? '').map((t) => el('span', { class: 'chip', text: t }))),
      el('div', { class: 'profile-actions' }, [
        loadBtn,
        el('button', { class: 'btn btn-ghost btn-sm', text: 'Save', disabled: !usableOnCurrentGpu, title: usableOnCurrentGpu ? 'Overwrite this profile with the current driver settings' : 'This profile belongs to another GPU', onClick: () => void onSave(p) }),
        el('button', { class: 'btn btn-ghost btn-sm', text: 'Rename', onClick: () => void onRename(p) }),
        el('button', { class: 'btn btn-ghost btn-sm btn-danger-text', text: 'Delete', onClick: () => void onDelete(p) }),
      ]),
    ]);
    return row;
  };

  const settingRow = (label: string, note: string, control: Node): HTMLElement => el('div', { class: 'profile-setting-row' }, [el('div', { class: 'profile-setting-label' }, [el('strong', { text: label }), el('small', { text: note })]), control]);

  let gameSettingsSaveQueue: Promise<void> = Promise.resolve();
  const onGameSettingsSave = async (game: GameCatalogEntry, targetDevice: DeviceInfo, patch: Partial<GameGpuProfile>): Promise<void> => {
    const operation = gameSettingsSaveQueue.then(async () => {
      try {
        const current = gameSettingFor(game.exePath);
        const currentGpu = gameGpuSettingFor(current, targetDevice);
        const next = mergeGameGpuSettings(currentGpu, patch);
        const result = await api.gameSettingsSave({
          exePath: game.exePath,
          deviceKey: targetDevice.deviceKey ?? null,
          deviceName: targetDevice.name,
          enabled: next.enabled,
          tuningProfileId: next.tuningProfileId,
          graphics: next.graphics,
        });
        gameSettings = [...gameSettings.filter((item) => item.exePath !== game.exePath), result.settings];
        gameCatalogSession.settings = gameSettings;
        if (result.apply && result.apply.ok === false) {
          toast('warn', 'Game settings saved, driver apply failed', result.apply.message ?? 'The per-game sidecar was saved, but the driver rejected one or more per-application settings.');
        } else if (result.apply?.skipped === true) {
          toast('info', 'Game settings saved', result.apply.message ?? 'Enable Use Profile to apply these settings to the executable.');
        } else {
          toast('success', 'Game settings applied', 'These settings were saved and applied to this executable.');
        }
        if (selectedGameExePath === game.exePath) renderGameDetail(game);
      } catch (err) {
        toast('error', 'Game settings save failed', err instanceof Error ? err.message : String(err));
        try { await loadGameCatalog(); if (selectedGameExePath === game.exePath) renderGameDetail(game); } catch { /* retain last known state */ }
      }
    });
    gameSettingsSaveQueue = operation.catch(() => {});
    await operation;
  };

  const onBootToggle = async (checked: boolean): Promise<void> => {
    const box = root.querySelector('.boot-checkbox') as HTMLInputElement | null;
    if (checked) {
      const activeMap = Object.fromEntries(Object.entries(activeProfileIds(envelope.settings)).filter(([deviceKey, profileId]) => {
        const profile = envelope.profiles.find((candidate) => candidate.id === profileId);
        return profile ? profileMatchesGpu(profile, deviceKey) : false;
      }));
      const activeProfiles = envelope.profiles.filter((profile) => validActiveProfileIds(envelope.settings, envelope.profiles).has(profile.id));
      const currentActiveId = activeProfileIdForGpu(envelope.settings, envelope.profiles, profileGpuIdentity(ctx.store.get()).key);
      const activeProfile = envelope.profiles.find((profile) => profile.id === currentActiveId)
        ?? activeProfiles[0]
        ?? (envelope.settings.activeProfileId ? envelope.profiles.find((p) => p.id === envelope.settings.activeProfileId) : null);
      if (!activeProfile && activeProfiles.length === 0) {
        toast('warn', 'No active profile', 'Load a profile first - start-at-boot applies active profiles for each GPU.');
        if (box) box.checked = false;
        return;
      }
      try {
        // M4-D2 (plan F4): the toggle only persists the intent -
        // profilesSettingsSave({ ocOnBoot }) is the ONLY writer of the Run
        // value (main re-derives it from the merged intent; NO direct
        // startupSet call).
        await api.profilesSettingsSave({
          ocOnBoot: true,
          activeProfileIds: activeMap,
          activeProfileId: activeProfile?.id ?? null,
        });
      } catch (err) {
        toast('error', 'Start at boot could not be set', err instanceof Error ? err.message : String(err));
        if (box) box.checked = false; // transient honest state - the re-render below follows startup-get
        await refresh(); // F3: re-render the card from startup-get so the honest state shows immediately
        return;
      }
      toast('success', 'Start at boot enabled', activeProfiles.length > 1
        ? `${activeProfiles.length} GPU profiles will apply when Arc Power starts.`
        : `"${activeProfile?.name ?? 'the active profile'}" will apply when Arc Power starts.`);
    } else {
      try {
        // M4-D2 (plan F4): disabling just persists the intent - main
        // removes the Run value only when nothing else owns it (the merged
        // intent derivation). NO direct startupSet call, no renderer-side
        // ownership guard (the single writer cannot double-remove).
        await api.profilesSettingsSave({ ocOnBoot: false });
      } catch (err) {
        toast('error', 'Start at boot could not be removed', err instanceof Error ? err.message : String(err));
        if (box) box.checked = true; // transient honest state - the re-render below follows startup-get
        await refresh(); // F3: re-render the card from startup-get so the honest state shows immediately
        return;
      }
      toast('info', 'Start at boot disabled', '');
    }
    void api.trayRebuild().catch(() => {});
    await refresh();
  };

  const onCreate = async (): Promise<void> => {
    const name = await promptModal('Save current settings as new profile', '');
    if (!name) return;
    const settings = settingsFromState(ctx.store.get().state as DeviceState);
    if (!validateSettingsPayload(settings)) {
      toast('error', 'Could not save profile', 'The settings payload failed validation - this is a bug.');
      return;
    }
    try {
      const currentGpu = profileGpuIdentity(ctx.store.get());
      await api.profilesSave({ id: newProfileId(), name, settings, ocOnBoot: false, deviceKey: currentGpu.key, deviceName: currentGpu.label });
      toast('success', 'Profile saved', name);
      void api.trayRebuild().catch(() => {});
      await refresh();
    } catch (err) {
      toast('error', 'Profile save failed', err instanceof Error ? err.message : String(err));
    }
  };

  const onSave = async (p: Profile): Promise<void> => {
    const currentGpu = profileGpuIdentity(ctx.store.get());
    if (!profileMatchesGpu(p, currentGpu.key)) {
      toast('warn', 'Profile belongs to another GPU', 'Switch to that GPU before overwriting its tuning profile.');
      return;
    }
    const settings = settingsFromState(ctx.store.get().state as DeviceState);
    if (!validateSettingsPayload(settings)) {
      toast('error', 'Could not save profile', 'The settings payload failed validation - this is a bug.');
      return;
    }
    try {
      await api.profilesSave({ id: p.id, name: p.name, settings, ocOnBoot: p.ocOnBoot, deviceKey: currentGpu.key, deviceName: currentGpu.label });
      toast('success', 'Profile updated', p.name);
      void api.trayRebuild().catch(() => {});
      await refresh();
    } catch (err) {
      toast('error', 'Profile save failed', err instanceof Error ? err.message : String(err));
    }
  };

  const onRename = async (p: Profile): Promise<void> => {
    const name = await promptModal('Rename profile', p.name);
    if (!name || name === p.name) return;
    try {
      await api.profilesRename(p.id, name);
      toast('success', 'Profile renamed', name);
      void api.trayRebuild().catch(() => {});
      await refresh();
    } catch (err) {
      toast('error', 'Rename failed', err instanceof Error ? err.message : String(err));
    }
  };

  const onDelete = async (p: Profile): Promise<void> => {
    const yes = await confirmModal('Delete profile', `Delete "${p.name}"? This cannot be undone.`);
    if (!yes) return;
    try {
      const activeMap = activeProfileIds(envelope.settings);
      const wasActive = Object.values(activeMap).includes(p.id) || envelope.settings.activeProfileId === p.id;
      await api.profilesDelete(p.id);
      if (wasActive) {
        const nextMap = Object.fromEntries(Object.entries(activeMap).filter(([, profileId]) => profileId !== p.id));
        const remainingActive = envelope.profiles.some((candidate) => candidate.id !== p.id && Object.values(nextMap).includes(candidate.id));
        await api.profilesSettingsSave({
          ocOnBoot: remainingActive ? envelope.settings.ocOnBoot : false,
          activeProfileIds: nextMap,
          activeProfileId: envelope.settings.activeProfileId === p.id ? null : envelope.settings.activeProfileId,
        });
        toast('info', 'Active profile deleted', remainingActive ? 'The other GPU profiles remain active.' : 'Start-at-boot was disabled.');
      }
      toast('success', 'Profile deleted', p.name);
      void api.trayRebuild().catch(() => {});
      await refresh();
    } catch (err) {
      toast('error', 'Delete failed', err instanceof Error ? err.message : String(err));
    }
  };

  const onLoad = async (p: Profile, done: () => void): Promise<void> => {
    const live = ctx.store.get();
    const targetDevice = profileTargetDevice(live, p);
    if (!targetDevice || !Number.isInteger(targetDevice.id)) {
      done();
      toast('warn', 'Profile GPU unavailable', `This profile belongs to ${profileOwnerLabel(p)}, which is not currently available.`);
      return;
    }
    const targetDeviceId = targetDevice.id;
    const targetGpuKey = targetDevice.deviceKey ?? null;
    const targetGpuLabel = targetDevice.name || p.deviceName || 'this GPU';
    const updateFocusedStore = (patch: Partial<AppState>): void => {
      // Loading a profile for GPU 2 must not replace GPU 1's focused state or
      // refresh the overlay back to an empty sample. The target's driver calls
      // still run directly against targetDeviceId.
      if (ctx.store.get().deviceId === targetDeviceId) ctx.store.set(patch);
    };
    try {
      // A profile's physical key is authoritative. Only legacy profiles use
      // the focused adapter, and only until their first successful load binds
      // them to that adapter.
      let targetCaps = targetDeviceId === live.deviceId ? live.caps : await api.getCapabilities(targetDeviceId);
      let targetState = targetDeviceId === live.deviceId ? live.state : await api.getCurrentSettings(targetDeviceId);
      if (!targetCaps || !targetState) throw new Error(`Could not read ${profileOwnerLabel(p)} before loading the profile.`);

      // M3-C review F4: the waiver gate reads the target adapter's LIVE caps,
      // not the focused GPU's caps.
      const decision = await ensureWaiver(targetDeviceId, targetCaps.waiverAccepted === true, targetGpuLabel, targetCaps.overclockingSupported !== false);
      if (decision === 'cancelled') {
        toast('info', 'Load cancelled', 'The warranty waiver must be accepted before applying a profile.');
        return;
      }
      // M2C-C: a non-elevated product app delegates to the elevated worker -
      // explain before the UAC prompt. M4-D2: distributed EXEs request
      // administrator access; retain the workerApply path for development and
      // legacy non-elevated sessions.
      if (ctx.store.get().workerApply && !ctx.store.get().elevated) {
        toast('info', 'Administrator approval needed', 'Administrator approval is needed to apply GPU settings.');
      }

      let appliedResponse: Awaited<ReturnType<typeof api.applySettings>> | null = null;
      let before = targetState;
      for (;;) {
        // M4O: { profileApply: true } keeps saved profiles independent of the
        // interactive OC-mode gate; runtime capability refusals still surface
        // as per-control error toasts.
        const settingsToApply = profileSettingsForCapabilities(p.settings, targetCaps);
        appliedResponse = await api.applySettings(targetDeviceId, settingsToApply, { profileApply: true });
        const { result, state: fresh } = appliedResponse;
        if (fresh) {
          targetState = fresh;
          updateFocusedStore({ state: fresh });
        }
        // M4-D: a waiver-not-set failure re-prompts once using fresh caps and
        // retries the same physical target. This local retry deliberately
        // avoids re-reading the focused GPU's caps for GPU 2 profiles.
        if (!result.ok && waiverRetryCount === 0
          && Object.values(result.perControl).some((control) => control?.errorCode === 'waiver-not-set')) {
          const freshCaps = await api.getCapabilities(targetDeviceId);
          targetCaps = freshCaps;
          updateFocusedStore({ caps: freshCaps });
          waiverRetryCount += 1;
          const retryDecision = await ensureWaiver(targetDeviceId, freshCaps.waiverAccepted === true, targetGpuLabel, freshCaps.overclockingSupported !== false);
          if (retryDecision === 'accepted') {
            const acceptedCaps = { ...freshCaps, waiverAccepted: true };
            targetCaps = acceptedCaps;
            updateFocusedStore({ caps: acceptedCaps });
            before = targetState;
            continue;
          }
        }
        break;
      }
      if (!appliedResponse) throw new Error('Profile apply did not return a result.');
      const { result } = appliedResponse;
      // M3-A: record the outcome for the dashboard "OC working" health row,
      // but only when this was the focused adapter.
      const failed = Object.entries(result.perControl)
        .filter(([, per]) => !per.ok)
        .map(([key, per]) => `${CONTROL_LABELS[key] ?? key}: ${per.message ?? per.errorCode ?? 'failed'}`)
        .join('; ');
      updateFocusedStore({
        lastApply: {
          ok: result.ok,
          at: Date.now(),
          detail: result.ok ? `Profile "${p.name}" applied` : (failed || `Profile "${p.name}" failed`),
        },
        caps: { ...targetCaps, waiverAccepted: true },
      });

      let changed = 0;
      for (const [key, per] of Object.entries(result.perControl)) {
        if (!per.ok) {
          toast('error', `${CONTROL_LABELS[key] ?? key} failed`, applyFailureText(per, key));
        } else if (!isNoopApply(key, p.settings, before)) {
          changed += 1;
          toast('success', `${CONTROL_LABELS[key] ?? key} applied`, '');
        }
      }
      // M4-D: a successful load resets the auto-retry counter - a later
      // driver-side waiver loss gets its own single retry.
      if (result.ok) waiverRetryCount = 0;
      // Only a fully-successful apply may mark the profile active. The map is
      // keyed by the target physical GPU, never by the currently focused one.
      const outcome = profileApplyOutcome(result, p.name, changed);
      if (outcome.markActive) {
        if (!p.deviceKey && targetGpuKey) {
          await api.profilesSave({ ...p, deviceKey: targetGpuKey, deviceName: targetGpuLabel });
        }
        const currentMap = activeProfileIds((await api.profilesList()).settings);
        if (targetGpuKey) currentMap[targetGpuKey] = p.id;
        await api.profilesSettingsSave({ activeProfileIds: currentMap, activeProfileId: p.id });
        toast('info', 'Profile loaded', outcome.toast ?? `Applied to ${profileOwnerLabel({ deviceKey: targetGpuKey, deviceName: targetGpuLabel })}.`);
        void api.trayRebuild().catch(() => {});
      }
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      updateFocusedStore({ lastApply: { ok: false, at: Date.now(), detail: msg } });
      if (/administrator approval/i.test(msg)) {
        toast('error', 'Load requires administrator approval', msg);
      } else {
        toast('error', 'Profile load failed', msg);
      }
    } finally {
      done();
    }
  };

  renderList();
  // Load the persisted catalog first so a remount can render it immediately;
  // only the first session mount starts the optional scan, in the background.
  void loadGameCatalog().then(() => {
    if (!gameCatalogSession.scanStarted) return refreshGameCatalog(true, true);
    return undefined;
  }).then(() => {
    // A background scan must not make the user switch away from an open game
    // detail page, but the catalog view should reflect newly discovered games
    // as soon as the background refresh completes.
    if (viewMode === 'game' && !selectedGameExePath) renderGameCatalog();
  }).catch(() => {});
}
