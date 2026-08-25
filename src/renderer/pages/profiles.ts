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
import { formatValue } from '../pure/slider.ts';
import type { Capabilities, DeviceState, FlipMode, GameAssociation, GameCatalogEntry, GameProfileGraphics, GameSettingsRecord, LowLatency, Profile, ProfilesEnvelope, Settings, StartupGetState } from '../types.ts';

const SCALAR_KEYS = ['powerLimitW', 'gpuVoltOffsetV', 'gpuFreqOffsetMhz', 'tempLimitC', 'vramFreqOffsetGts', 'vramVoltOffsetV', 'fixedFanPct'];

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
  return out;
}

function settingsSummary(settings: Settings, caps: Capabilities | null): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value !== 'number') continue;
    const compactSigned = (number: number, suffix: string): string => `${number >= 0 ? '+' : ''}${number}${suffix}`;
    if (key === 'powerLimitW') out.push(`${Math.round(value)}W`);
    else if (key === 'gpuVoltOffsetV' || key === 'vramVoltOffsetV') out.push(compactSigned(Math.round(value * 1000), 'mV'));
    else if (key === 'gpuFreqOffsetMhz') out.push(compactSigned(Math.round(value), 'MHz'));
    else if (key === 'vramFreqOffsetGts') out.push(compactSigned(Math.round(value * 10) / 10, 'GTS'));
    else if (key === 'tempLimitC') out.push(`TL: ${Math.round(value)}°C`);
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

function artworkTile(artwork: string | undefined, label: string, className = ''): HTMLElement {
  const isDataArtwork = typeof artwork === 'string' && artwork.length <= 750000
    && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(artwork);
  const safeKey = isDataArtwork || (typeof artwork === 'string' && /^(?:local:arc-power|fallback-[a-z0-9_-]{1,48})$/.test(artwork))
    ? artwork : `fallback-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || 'app'}`;
  let hash = 0;
  for (const char of safeKey) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  const initials = label.split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('') || '?';
  return el('span', { class: `profile-artwork profile-artwork-tone-${Math.abs(hash) % 5}${className ? ` ${className}` : ''}`, dataset: { artwork: safeKey } }, [
    el('img', { src: isDataArtwork ? artwork : './assets/game-cover-fallback.png', alt: '', 'aria-hidden': 'true' }),
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
  let associations: GameAssociation[] = [];
  let gameCatalog: GameCatalogEntry[] = gameCatalogSession.catalog;
  let gameSettings: GameSettingsRecord[] = gameCatalogSession.settings;
  let gameCatalogLoaded = gameCatalogSession.loaded;
  let gameCatalogLoading = Boolean(gameCatalogSession.loading || gameCatalogSession.scanLoading);
  let gameCatalogError: string | null = null;
  let gameProfileCapabilities: { enduranceGaming: boolean; reason?: string | null } = { enduranceGaming: false };
  let viewMode: 'oc' | 'game' = 'oc';
  let selectedGameExePath: string | null = null;
  let selectedProfileId: string | null = null;
  let selectedAssociationExePath: string | null = null;
  let sidecarWarning: string | null = null;
  let startupWarning: string | null = null;
  let sidecarAvailable = true;
  let searchTerm = '';
  let showFilter = 'all';
  let sortMode = 'alphabetical';
  let cardMode: 'grid' | 'list' = 'grid';
  const profileSubtitle = container.querySelector<HTMLElement>('#profiles-subtitle');
  const updateProfileCopy = (): void => {
    if (!profileSubtitle) return;
    profileSubtitle.textContent = viewMode === 'game'
      ? 'Save and load named game presets. Enable a game profile only when that executable should override the global graphics settings.'
      : 'Save and load named tuning presets. Loading applies the profile immediately; the active profile can start at boot.';
  };
  try { gameProfileCapabilities = await api.gameProfileCapabilities(s.deviceId); } catch { /* unsupported surface stays hidden */ }
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
  try { bootState = await api.startupGet(); }
  catch (err) { startupWarning = `Start-at-boot state unavailable: ${err instanceof Error ? err.message : String(err)}`; }
  try {
    associations = (await api.gameProfilesList()).associations;
  } catch (err) {
    associations = [];
    sidecarAvailable = false;
    sidecarWarning = `Per-game settings unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }

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

  const gameSettingFor = (exePath: string): GameSettingsRecord | null => gameSettings.find((item) => item.exePath === exePath) ?? null;

  const renderGameCatalog = (): void => {
    const cards = gameCatalog.map((game) => {
      const settings = gameSettingFor(game.exePath);
      return el('button', { class: 'game-catalog-card', dataset: { exePath: game.exePath }, onclick: () => { selectedGameExePath = game.exePath; renderGameDetail(game); } }, [
        artworkTile(game.artwork, game.displayName, 'game-catalog-artwork'),
        el('span', { class: 'game-catalog-copy' }, [el('strong', { text: game.displayName }), el('small', { text: settings?.enabled === false ? 'Use Profile off' : 'Installed game' })]),
      ]);
    });
    clear(root);
    root.append(modeToggle(), el('section', { class: 'profile-browser game-catalog-browser' }, [
      el('div', { class: 'profile-browser-head' }, [
        el('div', { class: 'profile-browser-title' }, [el('h2', { class: 'card-title', text: 'Installed Games' }), el('p', { class: 'card-note', text: 'Installed games remain here even when they are not running.' })]),
        el('div', { class: 'profile-browser-actions' }, [
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

  const renderGameDetail = (game: GameCatalogEntry): void => {
    const current = gameSettingFor(game.exePath);
    const graphics: GameProfileGraphics = current?.graphics ?? {};
    const endurance = el('select', { class: 'profile-setting-control game-setting-control', value: graphics.enduranceGaming ?? 'off', disabled: !gameProfileCapabilities.enduranceGaming }, [
      el('option', { value: 'off', text: 'Off' }), el('option', { value: 'on', text: 'On' }),
    ]) as HTMLSelectElement;
    const frame = el('select', { class: 'profile-setting-control game-setting-control', value: graphics.flipMode ?? 'application-default' }, [
      el('option', { value: 'application-default', text: 'Application Choice' }), el('option', { value: 'vsync-on', text: 'VSync On' }), el('option', { value: 'vsync-off', text: 'VSync Off' }), el('option', { value: 'smooth-sync', text: 'Smooth Sync' }), el('option', { value: 'speed-frame', text: 'Speed / Frame' }),
    ]) as HTMLSelectElement;
    const fps = el('input', { class: 'profile-setting-check game-setting-control', type: 'checkbox', checked: graphics.frameLimit?.enabled === true }) as HTMLInputElement;
    const fpsValue = el('input', { class: 'profile-setting-number game-setting-control', type: 'number', min: 1, max: 1000, value: graphics.frameLimit?.value ?? 60 }) as HTMLInputElement;
    const latency = el('select', { class: 'profile-setting-control game-setting-control', value: graphics.lowLatency ?? 'off' }, [
      el('option', { value: 'off', text: 'Off' }), el('option', { value: 'on', text: 'On' }), el('option', { value: 'on-boost', text: 'On + Boost' }),
    ]) as HTMLSelectElement;
    const save = (patch: Partial<GameSettingsRecord>): void => { void onGameSettingsSave(game, patch); };
    const detail = el('div', { class: 'profile-detail game-profile-detail' }, [
      el('div', { class: 'profile-detail-head game-profile-detail-head' }, [
        el('button', { class: 'btn btn-ghost btn-sm game-profile-back', text: 'Back to catalog', onclick: () => { selectedGameExePath = null; renderGameCatalog(); } }),
        el('div', { class: 'game-profile-title' }, [el('span', { class: 'profile-breadcrumb-sep', text: '›' }), el('h2', { class: 'card-title', text: game.displayName })]),
      ]),
      el('div', { class: 'profile-app-badge' }, [artworkTile(game.artwork, game.displayName, 'profile-artwork-small'), el('span', { text: `${game.displayName}  ·  ${game.exePath}` })]),
      el('section', { class: 'card profile-use-card' }, [el('label', { class: 'profile-use-toggle' }, [el('input', { class: 'game-use-profile', type: 'checkbox', checked: current?.enabled === true, onchange: (ev: Event) => save({ enabled: (ev.target as HTMLInputElement).checked }) }), el('span', { text: 'Use Profile' })]), el('span', { class: 'card-note', text: 'Game profiles start disabled; enable this only when this executable should use its settings.' })]),
      ...(gameProfileCapabilities.enduranceGaming ? [el('section', { class: 'profile-settings-section game-igs-settings' }, [
        el('h3', { class: 'profile-section-title', text: 'General' }),
        settingRow('Endurance Gaming', 'Extend gameplay on battery with platform and frame rate tuning for supported games.', endurance),
      ])] : []),
      el('section', { class: 'profile-settings-section game-igs-settings' }, [
        el('h3', { class: 'profile-section-title', text: 'Frame Delivery' }),
        settingRow('Frame Synchronization', 'Sets the method used for vertically syncing the rendered image to the display.', frame),
        settingRow('FPS Limiter', 'Saved independently for this executable.', el('span', { class: 'profile-inline-control' }, [fps, fpsValue])),
        settingRow('Low Latency Mode', 'Improves the responsiveness between user input and graphics rendering for a better gaming experience.', latency),
      ]),
      el('p', { class: 'profile-capability-note', text: gameProfileCapabilities.enduranceGaming ? 'When Use Profile is enabled, these values are applied to this executable through the driver per-application profile and override the global values for it.' : 'When Use Profile is enabled, the available values are applied to this executable through the driver per-application profile and override the global values for it.' }),
    ]);
    endurance.addEventListener('change', () => save({ graphics: { enduranceGaming: endurance.value as 'off' | 'on' } }));
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

  const openGameView = (): void => {
    viewMode = 'game';
    updateProfileCopy();
    renderGameCatalog();
    if (selectedGameExePath) {
      const selected = gameCatalog.find((item) => item.exePath === selectedGameExePath);
      if (selected) { renderGameDetail(selected); return; }
      selectedGameExePath = null;
    }
    if (!gameCatalogLoaded) {
      void loadGameCatalog().then(() => {
        if (viewMode !== 'game') return;
        if (selectedGameExePath) {
          const selected = gameCatalog.find((item) => item.exePath === selectedGameExePath);
          if (selected) { renderGameDetail(selected); return; }
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
    try {
      associations = (await api.gameProfilesList()).associations;
      sidecarAvailable = true;
      sidecarWarning = null;
    } catch (err) {
      sidecarAvailable = false;
      sidecarWarning = `Per-game settings unavailable: ${err instanceof Error ? err.message : String(err)}`;
    }
    renderList();
  };

  const renderList = (): void => {
    const activeId = envelope.settings.activeProfileId;
    const activeProfile = envelope.profiles.find((p) => p.id === activeId) ?? null;
    const waiverAccepted = caps.waiverAccepted === true;
    // Honest ocOnBoot state: the startup-get derivation is the truth
    // (applyOnBoot = the Run value exists AND ocOnBoot is on AND an active
    // profile exists), settings.json the persisted intent - a mismatch
    // surfaces as a hint, never a lie.
    const applyOnBoot = bootState?.applyOnBoot === true;
    const bootMismatch = applyOnBoot !== (envelope.settings.ocOnBoot === true && !!envelope.settings.activeProfileId);

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
        : activeProfile
          ? el('p', { class: 'card-note', text: `Applies "${activeProfile.name}" at boot.` })
          : el('p', { class: 'card-note', text: 'Load a profile first - start-at-boot applies the active profile.' }),
      bootMismatch
        ? el('p', { class: 'card-note boot-hint', text: 'The startup registration and the saved settings disagree - the toggle reflects the registration.' })
        : null,
    ]);

    const filtered = envelope.profiles
      .filter((p) => !searchTerm || p.name.toLowerCase().includes(searchTerm.toLowerCase()))
      .filter((p) => showFilter === 'all' || (showFilter === 'active' ? p.id === activeId : associations.some((a) => a.profileId === p.id)));
    filtered.sort((a, b) => sortMode === 'recent' ? b.createdAt.localeCompare(a.createdAt) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const listCard = el('section', { class: 'profile-browser' }, [
      el('div', { class: 'profile-browser-head' }, [
        el('div', { class: 'profile-browser-title' }, [
          el('h2', { class: 'card-title', text: 'Profiles' }),
          el('p', { class: 'card-note', text: 'Save GPU tuning presets and associate them with detected games or apps.' }),
        ]),
      ]),
      el('div', { class: 'profile-browser-toolbar' }, [
        el('button', { class: 'btn btn-primary btn-sm profile-create', text: 'Add Profile +', onClick: () => void onCreate() }),
        el('input', { class: 'profile-search', type: 'search', placeholder: 'Find a profile', value: searchTerm, oninput: (ev: Event) => { searchTerm = (ev.target as HTMLInputElement).value; renderList(); } }),
        el('label', { class: 'profile-filter-label', text: 'Show' }),
        el('select', { class: 'profile-filter', onchange: (ev: Event) => { showFilter = (ev.target as HTMLSelectElement).value; renderList(); } }, [
          el('option', { value: 'all', text: 'All Profiles' }), el('option', { value: 'active', text: 'Active' }), el('option', { value: 'associated', text: 'With a game/app' }),
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
        : el('div', { class: `profile-list profile-cards ${cardMode === 'grid' ? 'profile-grid' : 'profile-list-mode'}` }, filtered.map((p) => profileRow(p, p.id === activeId, activeId))),
    ]);

    clear(root);
    if (sidecarWarning) root.append(el('p', { class: 'card-note profile-sidecar-warning', role: 'status', text: sidecarWarning }));
    if (startupWarning) root.append(el('p', { class: 'card-note profile-sidecar-warning', role: 'status', text: startupWarning }));
    root.append(modeToggle(), bootCard, listCard);
  };

  const profileRow = (p: Profile, active: boolean, activeId: string | null): HTMLElement => {
    // F3 instant apply (M2C-B): the Load button is a single trigger - one
    // attempt, immediate result (no in-flight cancel surface anymore).
    const loadBtn = el('button', { class: 'btn btn-primary btn-sm', text: 'Load' });
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
        active ? el('span', { class: 'badge profile-badge', text: 'Active' }) : null,
      ]),
      el('div', { class: 'chips profile-chips' }, settingsSummary(p.settings, caps).map((t) => el('span', { class: 'chip', text: t }))),
      el('div', { class: 'profile-actions' }, [
        loadBtn,
        el('button', { class: 'btn btn-ghost btn-sm', text: 'Save', title: 'Overwrite this profile with the current driver settings', onClick: () => void onSave(p) }),
        el('button', { class: 'btn btn-ghost btn-sm', text: 'Rename', onClick: () => void onRename(p) }),
        el('button', { class: 'btn btn-ghost btn-sm btn-danger-text', text: 'Delete', onClick: () => void onDelete(p) }),
      ]),
    ]);
    return row;
  };

  const profileActionButtons = (p: Profile): HTMLElement => {
    const loadBtn = el('button', { class: 'btn btn-primary btn-sm', text: 'Load' });
    loadBtn.addEventListener('click', () => void onLoad(p, () => {}));
    return el('div', { class: 'profile-actions profile-detail-actions' }, [
      loadBtn,
      el('button', { class: 'btn btn-ghost btn-sm', text: 'Save', onClick: () => void onSave(p) }),
      el('button', { class: 'btn btn-ghost btn-sm', text: 'Rename', onClick: () => void onRename(p) }),
      el('button', { class: 'btn btn-ghost btn-sm btn-danger-text', text: 'Delete', onClick: () => void onDelete(p) }),
    ]);
  };

  const renderDetail = (p: Profile): void => {
    const links = associations.filter((a) => a.profileId === p.id);
    const selected = links.find((a) => a.exePath === selectedAssociationExePath) ?? links[0] ?? null;
    selectedAssociationExePath = selected?.exePath ?? null;
    const graphics: GameProfileGraphics = selected?.graphics ?? {};
    const frame = el('select', { class: 'profile-setting-control', value: graphics.flipMode ?? 'application-default', disabled: !selected || !sidecarAvailable }, [
      el('option', { value: 'application-default', text: 'Application Choice' }), el('option', { value: 'vsync-on', text: 'VSync On' }), el('option', { value: 'vsync-off', text: 'VSync Off' }), el('option', { value: 'smooth-sync', text: 'Smooth Sync' }), el('option', { value: 'speed-frame', text: 'Speed / Frame' }),
    ]) as HTMLSelectElement;
    const fps = el('input', { class: 'profile-setting-check', type: 'checkbox', checked: graphics.frameLimit?.enabled === true, disabled: !selected || !sidecarAvailable }) as HTMLInputElement;
    const fpsValue = el('input', { class: 'profile-setting-number', type: 'number', min: 1, max: 1000, value: graphics.frameLimit?.value ?? 60, disabled: !selected || !sidecarAvailable }) as HTMLInputElement;
    const latency = el('select', { class: 'profile-setting-control', value: graphics.lowLatency ?? 'off', disabled: !selected || !sidecarAvailable }, [
      el('option', { value: 'off', text: 'Off' }), el('option', { value: 'on', text: 'On' }), el('option', { value: 'on-boost', text: 'On + Boost' }),
    ]) as HTMLSelectElement;
    const associationPicker = links.length
      ? el('div', { class: 'profile-associated-apps' }, [
        el('h3', { class: 'profile-section-title', text: 'Associated Games / Apps' }),
        ...links.map((link) => el('button', {
          class: `profile-associated-app${link.exePath === selected?.exePath ? ' selected' : ''}`,
          dataset: { exePath: link.exePath },
          onClick: () => { selectedAssociationExePath = link.exePath; renderDetail(p); },
        }, [
          artworkTile(link.artwork, link.displayName, 'profile-artwork-small'),
          el('span', { class: 'profile-associated-app-name', text: link.displayName }),
          el('span', { class: 'profile-associated-app-path', text: link.exePath }),
          link.enabled ? el('span', { class: 'badge profile-badge', text: 'On' }) : el('span', { class: 'badge', text: 'Off' }),
        ])),
      ])
      : el('p', { class: 'card-note', text: 'No game or app is associated with this profile yet.' });
    const detail = el('div', { class: 'profile-detail' }, [
      el('div', { class: 'profile-detail-head' }, [
        el('button', { class: 'btn btn-ghost btn-sm profile-back', text: 'Profiles', onClick: () => { selectedProfileId = null; renderList(); } }),
        el('span', { class: 'profile-breadcrumb-sep', text: '›' }), el('h2', { class: 'card-title', text: p.name }),
        activeBadge(p.id === envelope.settings.activeProfileId),
      ]),
      selected ? el('div', { class: 'profile-app-badge' }, [artworkTile(selected.artwork, selected.displayName, 'profile-artwork-small'), el('span', { class: 'profile-app-dot', text: '●' }), el('span', { text: `${selected.displayName}  ·  ${selected.exePath}` })]) : el('p', { class: 'card-note', text: 'Global profile · associate a scanned app below to use this page for a game.' }),
      associationPicker,
      sidecarWarning ? el('p', { class: 'card-note profile-sidecar-warning', role: 'status', text: sidecarWarning }) : null,
      el('section', { class: 'card profile-use-card' }, [
        el('label', { class: 'profile-use-toggle' }, [el('input', { type: 'checkbox', checked: selected?.enabled === true, disabled: !selected || !sidecarAvailable, onchange: (ev: Event) => void onGameSave(p, selected, { enabled: (ev.target as HTMLInputElement).checked }) }), el('span', { text: 'Use Profile' })]),
        el('span', { class: 'card-note', text: selected ? 'Controls whether this association is enabled when the application is detected.' : 'Associate a scanned game/app to enable per-game controls.' }),
      ]),
      el('section', { class: 'profile-settings-section' }, [
        el('h3', { class: 'profile-section-title', text: 'Frame Delivery' }),
        settingRow('Frame Synchronization', 'How rendered frames are synchronized for this application.', frame),
        settingRow('FPS Limiter', 'Limits the rate at which frames are displayed.', el('span', { class: 'profile-inline-control' }, [fps, fpsValue])),
        settingRow('Low Latency Mode', 'Improves responsiveness between input and rendering.', latency),
      ]),
      el('p', { class: 'profile-capability-note', text: 'Per-game values are saved and read back from the sidecar. Driver per-app IGCL application is not available yet, so these controls never apply a global graphics setting.' }),
      el('div', { class: 'profile-detail-footer' }, [profileActionButtons(p), selected ? el('button', { class: 'btn btn-ghost btn-sm btn-danger-text', text: 'Remove association', onClick: () => void onGameDelete(p, selected) }) : el('p', { class: 'card-note', text: 'Per-game settings are managed in the Game Profile view.' })]),
    ]);
    frame.addEventListener('change', () => void onGameSave(p, selected, { graphics: { flipMode: frame.value as FlipMode } }));
    latency.addEventListener('change', () => void onGameSave(p, selected, { graphics: { lowLatency: latency.value as LowLatency } }));
    fps.addEventListener('change', () => void onGameSave(p, selected, { graphics: { frameLimit: { enabled: fps.checked, value: Number(fpsValue.value) || 60 } } }));
    fpsValue.addEventListener('change', () => void onGameSave(p, selected, { graphics: { frameLimit: { enabled: fps.checked, value: Number(fpsValue.value) || 60 } } }));
    clear(root); root.append(detail);
  };

  const activeBadge = (active: boolean): HTMLElement | null => active ? el('span', { class: 'badge profile-badge', text: 'Active' }) : null;
  const settingRow = (label: string, note: string, control: Node): HTMLElement => el('div', { class: 'profile-setting-row' }, [el('div', { class: 'profile-setting-label' }, [el('strong', { text: label }), el('small', { text: note })]), control]);

  let gameSaveQueue: Promise<void> = Promise.resolve();
  const onGameSave = async (p: Profile, association: GameAssociation | null, patch: Partial<GameAssociation>): Promise<void> => {
    if (!association || !sidecarAvailable) return;
    const operation = gameSaveQueue.then(async () => {
      try {
        // Read the latest association at execution time.  A user can change
        // two controls before the first IPC round trip finishes; rebuilding
        // from the render-time snapshot would otherwise drop the first edit.
        const current = associations.find((item) => item.profileId === p.id && item.exePath === association.exePath);
        if (!current) return;
        const result = await api.gameProfileSave({
          ...current,
          ...patch,
          profileId: p.id,
          exePath: current.exePath,
          graphics: patch.graphics ? { ...current.graphics, ...patch.graphics } : current.graphics,
        });
        associations = result.associations;
        toast('success', 'Per-game settings saved', 'Saved to the per-game sidecar; no global graphics setting was changed.');
        renderDetail(p);
      } catch (err) {
        toast('error', 'Per-game save failed', err instanceof Error ? err.message : String(err));
        try { associations = (await api.gameProfilesList()).associations; renderDetail(p); } catch { /* retain the last known state */ }
      }
    });
    gameSaveQueue = operation.catch(() => {});
    await operation;
  };

  const onGameDelete = async (p: Profile, association: GameAssociation): Promise<void> => {
    const operation = gameSaveQueue.then(async () => {
      try {
        associations = (await api.gameProfileDelete({ profileId: p.id, exePath: association.exePath })).associations;
        selectedAssociationExePath = null;
        toast('info', 'Association removed', association.displayName);
        renderDetail(p);
      }
      catch (err) {
        toast('error', 'Association removal failed', err instanceof Error ? err.message : String(err));
        try { associations = (await api.gameProfilesList()).associations; renderDetail(p); } catch { /* retain the last known state */ }
      }
    });
    gameSaveQueue = operation.catch(() => {});
    await operation;
  };

  let gameSettingsSaveQueue: Promise<void> = Promise.resolve();
  const onGameSettingsSave = async (game: GameCatalogEntry, patch: Partial<GameSettingsRecord>): Promise<void> => {
    const operation = gameSettingsSaveQueue.then(async () => {
      try {
        const current = gameSettingFor(game.exePath);
        const result = await api.gameSettingsSave({
          ...current,
          ...patch,
          exePath: game.exePath,
          graphics: patch.graphics ? { ...(current?.graphics ?? {}), ...patch.graphics } : (current?.graphics ?? {}),
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
      const activeId = envelope.settings.activeProfileId;
      const activeProfile = envelope.profiles.find((p) => p.id === activeId) ?? null;
      if (!activeProfile) {
        toast('warn', 'No active profile', 'Load a profile first - start-at-boot applies the active profile.');
        if (box) box.checked = false;
        return;
      }
      try {
        // M4-D2 (plan F4): the toggle only persists the intent -
        // profilesSettingsSave({ ocOnBoot }) is the ONLY writer of the Run
        // value (main re-derives it from the merged intent; NO direct
        // startupSet call).
        await api.profilesSettingsSave({ ocOnBoot: true, activeProfileId: activeProfile.id });
      } catch (err) {
        toast('error', 'Start at boot could not be set', err instanceof Error ? err.message : String(err));
        if (box) box.checked = false; // transient honest state - the re-render below follows startup-get
        await refresh(); // F3: re-render the card from startup-get so the honest state shows immediately
        return;
      }
      toast('success', 'Start at boot enabled', `"${activeProfile.name}" will apply when Arc Power starts.`);
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
      await api.profilesSave({ id: newProfileId(), name, settings, ocOnBoot: false });
      toast('success', 'Profile saved', name);
      void api.trayRebuild().catch(() => {});
      await refresh();
    } catch (err) {
      toast('error', 'Profile save failed', err instanceof Error ? err.message : String(err));
    }
  };

  const onSave = async (p: Profile): Promise<void> => {
    const settings = settingsFromState(ctx.store.get().state as DeviceState);
    if (!validateSettingsPayload(settings)) {
      toast('error', 'Could not save profile', 'The settings payload failed validation - this is a bug.');
      return;
    }
    try {
      await api.profilesSave({ id: p.id, name: p.name, settings, ocOnBoot: p.ocOnBoot });
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
      const wasActive = envelope.settings.activeProfileId === p.id;
      await api.profilesDelete(p.id);
      if (wasActive) {
        // M4-D2 (plan F4): clearing the active slot + ocOnBoot re-derives
        // the Run value in main - removed unless the Settings page's
        // startWithWindows still owns it (no renderer-side guard needed;
        // the single writer cannot double-remove).
        await api.profilesSettingsSave({ ocOnBoot: false, activeProfileId: null });
        toast('info', 'Active profile deleted', 'Start-at-boot was disabled.');
      }
      toast('success', 'Profile deleted', p.name);
      void api.trayRebuild().catch(() => {});
      await refresh();
    } catch (err) {
      toast('error', 'Delete failed', err instanceof Error ? err.message : String(err));
    }
  };

  const onLoad = async (p: Profile, done: () => void): Promise<void> => {
    const deviceId = s.deviceId;
    if (deviceId === null) return;
    // M3-C review F4: the waiver gate reads the LIVE store's caps - an
    // in-session acceptance must not re-prompt (the mount-time caps lag
    // until a re-render).
    const liveCaps = ctx.store.get().caps;
    // M17 (B50-class): OC-locked devices have no waiver - skip the gate (the
    // per-control 'unsupported' refusals are the honest floor).
    const decision = await ensureWaiver(deviceId, liveCaps?.waiverAccepted === true, caps.deviceName || 'this GPU', liveCaps?.overclockingSupported !== false);
    if (decision === 'cancelled') {
      done();
      toast('info', 'Load cancelled', 'The warranty waiver must be accepted before applying a profile.');
      return;
    }
    // M3-C-D (double-dialog decision): NO per-apply extended-range confirm
    // on the Profiles page - in Advanced mode the mode-enable confirm
    // already warned; M4O: in Stock mode the profile apply is NOT gated by
    // the OC mode either (the profile applies as saved against the
    // driver's true limits - the flagless slider gate does not apply here;
    // the >375 W ceiling (M21: the sysman-primary ceiling) + the runtime-capability refusals still surface
    // as per-control error toasts below, never a dead-end confirm).
    // M2C-C: a non-elevated product app delegates to the elevated worker -
    // explain before the UAC prompt. M4-D2: the packaged EXE is asInvoker
    // now - the workerApply toast applies (the worker still spawns elevated
    // when the user approves).
    if (ctx.store.get().workerApply && !ctx.store.get().elevated) {
      toast('info', 'Administrator approval needed', 'Administrator approval is needed to apply GPU settings.');
    }
    try {
      const before = ctx.store.get().state as DeviceState;
      // M4O: the profile apply carries { profileApply: true } - the OC-mode
      // gate (the interactive slider gate) must NOT block a saved profile
      // (uniform with the boot/tray/--apply-profile paths: the profile
      // applies as saved against the driver's true limits; the >375 W
      // ceiling (M21: the sysman-primary ceiling) + the runtime-capability
      // refusals still apply in main).
      const { result, state: fresh } = await api.applySettings(deviceId, p.settings, { profileApply: true });
      // M3-C review F2: only store a NON-NULL fresh state - a refusal
      // envelope's null state must never null out the store's device state
      // (that renders the OC page 'Loading device capabilities…' forever
      // and throws in the dirty helpers).
      if (fresh) ctx.store.set({ state: fresh });
      // M3-A: record the outcome for the dashboard "OC working" health row.
      {
        const failed = Object.entries(result.perControl)
          .filter(([, per]) => !per.ok)
          .map(([k, per]) => `${CONTROL_LABELS[k] ?? k}: ${per.message ?? per.errorCode ?? 'failed'}`)
          .join('; ');
        ctx.store.set({
          lastApply: {
            ok: result.ok,
            at: Date.now(),
            detail: result.ok ? `Profile "${p.name}" applied` : (failed || `Profile "${p.name}" failed`),
          },
        });
      }
      // M4-D: a waiver-not-set failure must not dead-end the load
      // with a confusing error - re-prompt the waiver dialog AUTOMATICALLY
      // (the fresh caps reflect the driver truth, refreshed like the OC
      // page does) and retry ONCE. Never a loop; the counter resets on
      // success, so a later driver-side loss still gets its own retry.
      // Accepted-store sessions never reach this branch (MAIN silently
      // re-sets + retries - the failure does not surface).
      if (!result.ok) {
        const freshCaps = await api.getCapabilities(deviceId);
        ctx.store.set({ caps: freshCaps });
        if (waiverRetryCount === 0
          && Object.values(result.perControl).some((p) => p?.errorCode === 'waiver-not-set')) {
          waiverRetryCount += 1;
          const retryDecision = await ensureWaiver(deviceId, freshCaps.waiverAccepted === true, caps.deviceName || 'this GPU', freshCaps.overclockingSupported !== false);
          if (retryDecision === 'accepted') {
            // The store caps flag must be patched BEFORE the retry - the
            // retry re-enters the pre-load waiver gate, which reads the
            // store flag; without the patch it would re-show the dialog
            // (the user just accepted - no second prompt).
            const cur2 = ctx.store.get();
            if (cur2.caps && cur2.caps.waiverAccepted !== true) {
              ctx.store.set({ caps: { ...cur2.caps, waiverAccepted: true } });
            }
            return onLoad(p, done);
          }
        }
      }
      let changed = 0;
      for (const [key, per] of Object.entries(result.perControl)) {
        if (!per.ok) {
          // F3 instant: refusals carry the composed actionable message;
          // hard errors keep the errorCode mapping (M17d item 0b: the
          // shared applyFailureText preference).
          toast('error', `${CONTROL_LABELS[key] ?? key} failed`, applyFailureText(per, key));
        } else if (!isNoopApply(key, p.settings, before)) {
          changed += 1;
          toast('success', `${CONTROL_LABELS[key] ?? key} applied`, '');
        }
      }
      ctx.store.set({ caps: { ...caps, waiverAccepted: true } });
      // M4-D: a successful load resets the auto-retry counter - a later
      // driver-side waiver loss gets its own single retry.
      if (result.ok) waiverRetryCount = 0;
      // M2b step-5 NIT 2: only a fully-successful apply (result.ok) may mark
      // the profile active and claim "applied to the GPU" - a partially-
      // failed load keeps the per-control error toasts but marks nothing.
      const outcome = profileApplyOutcome(result, p.name, changed);
      if (outcome.markActive) {
        await api.profilesSettingsSave({ activeProfileId: p.id });
        toast('info', 'Profile loaded', outcome.toast ?? '');
        void api.trayRebuild().catch(() => {});
      }
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.store.set({ lastApply: { ok: false, at: Date.now(), detail: msg } });
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
