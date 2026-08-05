// Arc Power — Profiles page (M2b-B): list/create/save/rename/delete/load
// profiles persisted by the main-process ProfileStore (via the profiles-*
// IPC channels), plus the "start at boot" toggle (ocOnBoot, waiver-gated)
// backed by the Run-key helper (startup-set) with honest state reporting.
// Loading a profile applies its settings through the same waiver gate and
// toast rules as the Overclocking page (no-op applies stay silent; retried
// applies note the retry; errors always toast). Every mutation rebuilds the
// tray menu (tray-rebuild IPC) and marks the active profile.

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { api } from '../ipc.ts';
import { toast } from '../components/toast.ts';
import { ensureWaiver } from '../components/waiver-dialog.ts';
import { errorMessage, CONTROL_LABELS } from '../pure/errors.ts';
import { isNoopApply, shouldShowRetryNote, validateSettingsPayload, profileApplyOutcome } from '../pure/settings.ts';
import { formatValue } from '../pure/slider.ts';
import type { Capabilities, DeviceState, Profile, ProfilesEnvelope, Settings } from '../types.ts';

const SCALAR_KEYS = ['powerLimitW', 'gpuVoltOffsetV', 'gpuFreqOffsetMhz', 'tempLimitC', 'vramFreqOffsetGts', 'vramVoltOffsetV', 'fixedFanPct'];

function newProfileId(): string {
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build a Settings payload from the driver's current read-back (only
 * controls the UI understands; expert controls gpuLock/vfCurve are excluded —
 * they are not editable in M2b and a saved {0,0} lock pair would mislead).
 */
export function settingsFromState(state: DeviceState): Settings {
  const out: Settings = {};
  for (const key of SCALAR_KEYS) {
    const v = state[key as keyof DeviceState];
    if (typeof v === 'number') (out as Record<string, number>)[key] = v;
  }
  if (state.fanMode) out.fanMode = state.fanMode;
  if (state.fanCurve) out.fanCurve = state.fanCurve;
  if (state.fixedFanPct !== null && state.fixedFanPct !== undefined) out.fixedFanPct = state.fixedFanPct;
  return out;
}

function settingsSummary(settings: Settings, caps: Capabilities | null): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value !== 'number') continue;
    const units = caps?.ranges[key]?.units ?? '';
    out.push(`${CONTROL_LABELS[key] ?? key} ${formatValue(value, units)}`);
  }
  if (settings.fanCurve) out.push(`Fan curve ${settings.fanCurve.length} points`);
  if (settings.fanMode) out.push(`Fan mode ${settings.fanMode}`);
  return out;
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
      el('p', { class: 'page-subtitle', text: 'Save and load named OC presets. Loading applies the profile immediately; the active profile can start at boot.' }),
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
    root.append(el('p', { class: 'page-subtitle', text: 'Device state not loaded yet — try again in a moment.' }));
    return;
  }
  if (s.deviceId === null) {
    clear(root);
    root.append(el('p', { class: 'page-subtitle', text: 'No GPU available.' }));
    return;
  }

  let envelope: ProfilesEnvelope;
  let bootState: { enabled: boolean; profileId: string | null; value: string | null } | null = null;
  try {
    [envelope, bootState] = await Promise.all([api.profilesList(), api.startupGet()]);
  } catch (err) {
    clear(root);
    root.append(el('p', { class: 'text-error', text: `Could not load profiles: ${err instanceof Error ? err.message : String(err)}` }));
    return;
  }

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
    const activeId = envelope.settings.activeProfileId;
    const activeProfile = envelope.profiles.find((p) => p.id === activeId) ?? null;
    const waiverAccepted = caps.waiverAccepted === true;
    // Honest ocOnBoot state: the Run key is the truth, settings.json the
    // persisted intent — a mismatch surfaces as a hint, never a lie.
    const runKeyEnabled = bootState?.enabled === true;
    const bootMismatch = runKeyEnabled !== envelope.settings.ocOnBoot;

    const bootCard = el('section', { class: 'card boot-card' }, [
      el('h2', { class: 'card-title', text: 'Start at boot' }),
      el('div', { class: 'boot-row' }, [
        el('label', { class: 'boot-toggle' }, [
          el('input', {
            type: 'checkbox',
            class: 'boot-checkbox',
            checked: runKeyEnabled,
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
          : el('p', { class: 'card-note', text: 'Load a profile first — start-at-boot applies the active profile.' }),
      bootMismatch
        ? el('p', { class: 'card-note boot-hint', text: 'The Run key and the saved settings disagree — the toggle reflects the Run key.' })
        : null,
    ]);

    const listCard = el('section', { class: 'card' }, [
      el('h2', { class: 'card-title', text: 'Profiles' }),
      envelope.profiles.length === 0
        ? el('p', { class: 'card-note', text: 'No profiles yet — save the current settings as a profile to get started.' })
        : el('div', { class: 'profile-list' }, envelope.profiles.map((p) => profileRow(p, p.id === activeId, activeId))),
      el('div', { class: 'card-footer' }, [
        el('button', {
          class: 'btn btn-primary btn-sm profile-create',
          text: 'Save current settings as new profile',
          onClick: () => void onCreate(),
        }),
      ]),
    ]);

    clear(root);
    root.append(bootCard, listCard);
  };

  const profileRow = (p: Profile, active: boolean, activeId: string | null): HTMLElement => el('div', {
    class: `profile-row${active ? ' profile-active' : ''}`,
    dataset: { id: p.id },
  }, [
    el('div', { class: 'profile-info' }, [
      el('span', { class: 'profile-name', text: p.name }),
      active ? el('span', { class: 'badge profile-badge', text: 'Active' }) : null,
    ]),
    el('div', { class: 'chips profile-chips' }, settingsSummary(p.settings, caps).map((t) => el('span', { class: 'chip', text: t }))),
    el('div', { class: 'profile-actions' }, [
      el('button', { class: 'btn btn-primary btn-sm', text: 'Load', onClick: () => void onLoad(p) }),
      el('button', { class: 'btn btn-ghost btn-sm', text: 'Save', title: 'Overwrite this profile with the current driver settings', onClick: () => void onSave(p) }),
      el('button', { class: 'btn btn-ghost btn-sm', text: 'Rename', onClick: () => void onRename(p) }),
      el('button', { class: 'btn btn-ghost btn-sm btn-danger-text', text: 'Delete', onClick: () => void onDelete(p) }),
    ]),
  ]);

  const onBootToggle = async (checked: boolean): Promise<void> => {
    const box = root.querySelector('.boot-checkbox') as HTMLInputElement | null;
    if (checked) {
      const activeId = envelope.settings.activeProfileId;
      const activeProfile = envelope.profiles.find((p) => p.id === activeId) ?? null;
      if (!activeProfile) {
        toast('warn', 'No active profile', 'Load a profile first — start-at-boot applies the active profile.');
        if (box) box.checked = false;
        return;
      }
      try {
        await api.startupSet(true, activeProfile.id);
      } catch (err) {
        toast('error', 'Start at boot could not be set', err instanceof Error ? err.message : String(err));
        if (box) box.checked = false; // honest state: the Run key was not written
        return;
      }
      await api.profilesSettingsSave({ ocOnBoot: true, activeProfileId: activeProfile.id });
      toast('success', 'Start at boot enabled', `"${activeProfile.name}" will apply when Arc Power starts.`);
    } else {
      try {
        await api.startupSet(false, null);
      } catch (err) {
        toast('error', 'Start at boot could not be removed', err instanceof Error ? err.message : String(err));
        if (box) box.checked = true; // honest state: the Run key is still set
        return;
      }
      await api.profilesSettingsSave({ ocOnBoot: false });
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
      toast('error', 'Could not save profile', 'The settings payload failed validation — this is a bug.');
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
      toast('error', 'Could not save profile', 'The settings payload failed validation — this is a bug.');
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
        // Deleting the boot profile: remove the Run key + clear the active
        // slot so boot never applies a ghost profile.
        const runKeyEnabled = (await api.startupGet()).enabled;
        if (runKeyEnabled) {
          try { await api.startupSet(false, null); } catch { /* best effort */ }
        }
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

  const onLoad = async (p: Profile): Promise<void> => {
    const deviceId = s.deviceId;
    if (deviceId === null) return;
    const decision = await ensureWaiver(deviceId, caps.waiverAccepted, caps.deviceName || 'this GPU');
    if (decision === 'cancelled') {
      toast('info', 'Load cancelled', 'The warranty waiver must be accepted before applying a profile.');
      return;
    }
    try {
      const before = ctx.store.get().state as DeviceState;
      const { result, state: fresh } = await api.applySettings(deviceId, p.settings);
      ctx.store.set({ state: fresh });
      let changed = 0;
      for (const [key, per] of Object.entries(result.perControl)) {
        if (!per.ok) {
          toast('error', `${CONTROL_LABELS[key] ?? key} failed`, errorMessage(per.errorCode, key));
        } else if (!isNoopApply(key, p.settings, before)) {
          changed += 1;
          toast('success', `${CONTROL_LABELS[key] ?? key} applied`, '');
        }
      }
      // The retry note only claims success when the retried apply actually
      // succeeded (M2b review F3) — a failed retry shows only the errors.
      if (shouldShowRetryNote(result)) {
        toast('warn', 'Applied on retry', 'The driver was busy — the profile was applied on the retry attempt.');
      }
      ctx.store.set({ caps: { ...caps, waiverAccepted: true } });
      // M2b step-5 NIT 2: only a fully-successful apply (result.ok) may mark
      // the profile active and claim "applied to the GPU" — a partially-
      // failed load keeps the per-control error toasts but marks nothing.
      const outcome = profileApplyOutcome(result, p.name, changed);
      if (outcome.markActive) {
        await api.profilesSettingsSave({ activeProfileId: p.id });
        toast('info', 'Profile loaded', outcome.toast ?? '');
        void api.trayRebuild().catch(() => {});
      }
      await refresh();
    } catch (err) {
      toast('error', 'Profile load failed', err instanceof Error ? err.message : String(err));
    }
  };

  renderList();
}
