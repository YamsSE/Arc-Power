// Arc Power — Settings tab (M4-D): Start with Windows (the plain-app
// onlogon task ArcPowerAppOnBoot — ONE UAC in dev, mock in --ui-verify),
// Start minimized (persisted startMinimized — the window minimizes to the
// taskbar at boot, the tray click restores), Close to tray (persisted
// closeToTray — closing the window hides it to the icon list instead of
// quitting; the tray menu's Quit still exits), and the app version row.
//
// Honesty rules (same pattern as the Profiles page's boot card):
//   - the Start-with-Windows checkbox reflects the TASK truth from
//     startup-get (read-only), never the persisted intent; a mismatch with
//     settings.json surfaces as a hint, never a lie;
//   - the apply-profile registration (Profiles "start at boot") and the
//     plain-app task cannot both be enabled (two onlogon /rl highest tasks
//     would launch the app twice at logon) — the card shows both states
//     honestly and enabling one disables the other inside the SAME elevated
//     call (still one UAC);
//   - enabling Start with Windows needs ONE UAC in dev (the elevated
//     scheduled-task helper); mock mode applies in-process.

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { api } from '../ipc.ts';
import { toast } from '../components/toast.ts';
import { versionLine } from '../components/header.ts';
import type { StartupGetState } from '../types.ts';

export const settingsPage: Page = {
  id: 'settings',

  render(container: HTMLElement, ctx: PageContext) {
    clear(container);
    container.append(
      el('h1', { class: 'page-title', text: 'Settings' }),
      el('p', {
        class: 'page-subtitle',
        text: 'Startup behavior and app information. Start with Windows runs the app at logon via an elevated scheduled task (no prompt); Start minimized hides the window to the taskbar — restore it from the tray icon.',
      }),
      el('div', { id: 'settings-root', class: 'settings-root' }, [el('p', { class: 'page-subtitle', text: 'Loading settings…' })]),
    );
    void mount(ctx, container);
  },
};

async function mount(ctx: PageContext, container: HTMLElement): Promise<void> {
  const root = container.querySelector('#settings-root') as HTMLElement;
  const s = ctx.store.get();
  const displayVersion = s.appVersion && s.appVersion !== '0.0.0' ? `${versionLine(s.appVersion)} Alpha` : '—';

  let persisted: { startWithWindows: boolean; startMinimized: boolean; closeToTray: boolean };
  let bootState: StartupGetState | null = null;
  try {
    // The persisted Settings-tab fields ride in the profiles envelope
    // (settings.json via ProfileStore — the same read the Profiles page uses).
    const envelope = await api.profilesList();
    persisted = {
      startWithWindows: envelope.settings.startWithWindows === true,
      startMinimized: envelope.settings.startMinimized === true,
      closeToTray: envelope.settings.closeToTray === true,
    };
  } catch (err) {
    clear(root);
    root.append(el('p', { class: 'text-error', text: `Could not load settings: ${err instanceof Error ? err.message : String(err)}` }));
    return;
  }
  try {
    bootState = await api.startupGet();
  } catch { /* the cards below degrade to the persisted state */ }

  const refresh = async (): Promise<void> => {
    try {
      bootState = await api.startupGet();
    } catch { /* keep the last known task state */ }
    render();
  };

  const render = (): void => {
    const appTaskEnabled = bootState?.applyOnBoot?.enabled === true;
    const runKeyEnabled = bootState?.startupRunKey?.enabled === true;
    const startWithMismatch = appTaskEnabled !== persisted.startWithWindows;

    const startWithCard = el('section', { class: 'card settings-card settings-startup-card' }, [
      el('h2', { class: 'card-title', text: 'Start with Windows' }),
      el('div', { class: 'settings-row' }, [
        el('label', { class: 'boot-toggle' }, [
          el('input', {
            type: 'checkbox',
            class: 'settings-checkbox',
            dataset: { setting: 'startWithWindows' },
            checked: appTaskEnabled,
            onchange: (ev: Event) => void onStartWithWindowsToggle((ev.target as HTMLInputElement).checked),
          }),
          el('span', { text: 'Launch Arc Power when Windows starts' }),
        ]),
      ]),
      // Honest current-state lines: the elevated task runs the app WITHOUT
      // --apply-profile (the packaged EXE is always elevated — a plain Run
      // key would UAC at every logon).
      appTaskEnabled
        ? el('p', { class: 'card-note settings-state', text: 'Active: ArcPowerAppOnBoot (elevated logon task — no prompt at logon).' })
        : el('p', { class: 'card-note settings-state', text: 'Not active — the app starts manually.' }),
      // Coexistence (Round-1 F4): both registrations are onlogon /rl
      // highest — both enabled would launch the app twice at logon. The
      // apply-profile task is shown honestly; enabling the app task
      // disables it inside the same elevated call.
      runKeyEnabled
        ? el('p', { class: 'card-note boot-hint', text: 'The "Apply active profile at boot" task is enabled — it also launches the app at logon. Enabling Start with Windows disables it (the two cannot coexist).' })
        : null,
      startWithMismatch
        ? el('p', { class: 'card-note boot-hint', text: 'The task state and the saved settings disagree — the toggle reflects the task.' })
        : null,
    ]);

    const startMinimizedCard = el('section', { class: 'card settings-card' }, [
      el('h2', { class: 'card-title', text: 'Start minimized' }),
      el('div', { class: 'settings-row' }, [
        el('label', { class: 'boot-toggle' }, [
          el('input', {
            type: 'checkbox',
            class: 'settings-checkbox',
            dataset: { setting: 'startMinimized' },
            checked: persisted.startMinimized,
            onchange: (ev: Event) => void onStartMinimizedToggle((ev.target as HTMLInputElement).checked),
          }),
          el('span', { text: 'Start the window minimized to the taskbar' }),
        ]),
      ]),
      el('p', {
        class: 'card-note settings-state',
        text: persisted.startMinimized
          ? 'The window minimizes to the taskbar after boot — restore it from the tray icon.'
          : 'The window opens normally.',
      }),
    ]);

    const closeToTrayCard = el('section', { class: 'card settings-card' }, [
      el('h2', { class: 'card-title', text: 'Close to tray' }),
      el('div', { class: 'settings-row' }, [
        el('label', { class: 'boot-toggle' }, [
          el('input', {
            type: 'checkbox',
            class: 'settings-checkbox',
            dataset: { setting: 'closeToTray' },
            checked: persisted.closeToTray,
            onchange: (ev: Event) => void onCloseToTrayToggle((ev.target as HTMLInputElement).checked),
          }),
          el('span', { text: 'Closing the window minimizes it to the tray icon list' }),
        ]),
      ]),
      el('p', {
        class: 'card-note settings-state',
        text: persisted.closeToTray
          ? 'The close button hides the app to the tray — use the tray menu\'s Quit to exit fully.'
          : 'The close button quits the app.',
      }),
    ]);

    const aboutCard = el('section', { class: 'card settings-card' }, [
      el('h2', { class: 'card-title', text: 'About' }),
      el('div', { class: 'card-body kv-grid' }, [
        el('div', { class: 'kv', 'data-label': 'Version' }, [el('span', { class: 'settings-version', text: displayVersion })]),
      ]),
    ]);

    clear(root);
    root.append(startWithCard, startMinimizedCard, closeToTrayCard, aboutCard);
  };

  const onStartWithWindowsToggle = async (checked: boolean): Promise<void> => {
    try {
      // The elevated task create/delete (ONE UAC in dev; mock in verify).
      // Enabling disables the apply-profile registration in the same call.
      await api.startupAppSet(checked);
      // Persist the intent so the next boot's honest-state line matches.
      await api.profilesSettingsSave({ startWithWindows: checked });
      persisted.startWithWindows = checked;
      toast(checked ? 'success' : 'info', checked ? 'Start with Windows enabled' : 'Start with Windows disabled', '');
    } catch (err) {
      toast('error', 'Start with Windows could not be changed', err instanceof Error ? err.message : String(err));
      // M4-D review F4: a PARTIAL failure (the task write landed but the
      // settings save threw) must not leave the card contradicting the task
      // truth — re-query startup-get so the card re-renders from the TASK
      // state (the checkbox follows the task, the state line reads the
      // truth and the mismatch hint explains the disagreement). A blind
      // checkbox revert would lie when the task write actually succeeded.
      await refresh();
      return;
    }
    await refresh();
  };

  const onStartMinimizedToggle = async (checked: boolean): Promise<void> => {
    const box = root.querySelector<HTMLInputElement>('.settings-checkbox[data-setting="startMinimized"]');
    try {
      await api.profilesSettingsSave({ startMinimized: checked });
      persisted.startMinimized = checked;
      toast(checked ? 'success' : 'info', checked ? 'Start minimized enabled' : 'Start minimized disabled', '');
    } catch (err) {
      toast('error', 'Start minimized could not be changed', err instanceof Error ? err.message : String(err));
      if (box) box.checked = !checked;
      return;
    }
    await refresh();
  };

  const onCloseToTrayToggle = async (checked: boolean): Promise<void> => {
    const box = root.querySelector<HTMLInputElement>('.settings-checkbox[data-setting="closeToTray"]');
    try {
      await api.profilesSettingsSave({ closeToTray: checked });
      persisted.closeToTray = checked;
      toast(checked ? 'success' : 'info', checked ? 'Close to tray enabled' : 'Close to tray disabled', '');
    } catch (err) {
      toast('error', 'Close to tray could not be changed', err instanceof Error ? err.message : String(err));
      if (box) box.checked = !checked;
      return;
    }
    await refresh();
  };

  render();
}
