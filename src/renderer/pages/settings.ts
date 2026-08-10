// Arc Power - Settings tab (M4-D + M4-D2): Start with Windows (the HKCU Run
// value - ONE registration, zero UAC), Start minimized (persisted
// startMinimized - the app starts hidden in the system tray at boot, the tray
// click restores), Close to tray (persisted closeToTray - closing the
// window hides it to the icon list instead of quitting; the tray menu's
// Quit still exits), Log to file (persisted monitorLogToFile - the actual
// log writes happen in the BOOT-LEVEL telemetry subscription in app.ts),
// and the app version row.
//
// M4-D2 (r2 F4/F6): the Run value is SHARED with the Profiles page's
// "start at boot" (ocOnBoot) - one value serves both toggles. Honesty
// rules:
//   - the checkbox reflects the STARTUP-GET derivation (checked whenever
//     the value exists - either toggle can own it), never the persisted
//     intent alone;
//   - the mismatch hint compares the startup truth against the persisted
//     intent `(settings.startWithWindows || (settings.ocOnBoot &&
//     !!settings.activeProfileId))` - NEVER a false mismatch when ocOnBoot
//     owns the value (plan-review r2 F6);
//   - disabling Start with Windows must NOT remove the Run value while the
//     profile's start-at-boot owns it (the value is shared) - the toggle
//     RE-QUERIES startup-get FRESH before that ownership decision (never
//     the mount-captured bootState); main's profiles-settings-save is the
//     single writer of the value and re-derives it from the persisted
//     intent on every save.
//
// The old elevated scheduled-task wording (ArcPowerAppOnBoot) is GONE -
// tasks are dead (M4-D2 §12 root cause b); the HKCU Run value is the only
// registration and it never UACs.

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { requestOverlayView } from '../router.ts';
import { api } from '../ipc.ts';
import { toast } from '../components/toast.ts';
// M5 (N3): displayVersion is imported ALIASED - the settings page used to
// define its OWN `displayVersion` local (the version-row formatter); the
// alias keeps the header's pure helper without a name collision.
import { displayVersion as displayVersionLine } from '../components/header.ts';
import { setMonitorLogToFile } from '../log-state.ts';
import { applyTheme } from '../app.ts';
import { isValidTheme, THEMES, type Theme } from '../pure/theme.ts';
import type { StartupGetState } from '../types.ts';

/** 1.0.1 Themes: the display label per theme id (the swatch buttons). */
const THEME_LABELS: Record<Theme, string> = {
  dark: 'Dark Steel',
  midnight: 'Midnight',
  light: 'Arctic Light',
};

export const settingsPage: Page = {
  id: 'settings',

  render(container: HTMLElement, ctx: PageContext) {
    clear(container);
    container.append(
      el('h1', { class: 'page-title', text: 'Settings' }),
      el('p', {
        class: 'page-subtitle',
        text: 'Startup behavior and app information. Start with Windows registers Arc Power in the HKCU Run key (no elevation, no prompt); Start minimized starts the app in the system tray - restore it from the tray icon.',
      }),
      el('div', { id: 'settings-root', class: 'settings-root' }, [el('p', { class: 'page-subtitle', text: 'Loading settings…' })]),
    );
    void mount(ctx, container);
  },
};

async function mount(ctx: PageContext, container: HTMLElement): Promise<void> {
  const root = container.querySelector('#settings-root') as HTMLElement;
  const s = ctx.store.get();
  const versionDisplay = s.appVersion && s.appVersion !== '0.0.0' ? displayVersionLine(s.appVersion) : '-';

  // M6-amd3: the shrunk Overlay card is BUTTON-ONLY (the enable toggle
  // moved to the Overlay view - M6 the #/overlay page, M9 the Monitoring
  // page's Overlay view; the old #/overlay page is gone).
  let persisted: { startWithWindows: boolean; startMinimized: boolean; closeToTray: boolean; monitorLogToFile: boolean; ocOnBoot: boolean; activeProfileId: string | null; theme: Theme };
  let bootState: StartupGetState | null = null;
  try {
    // The persisted Settings-tab fields ride in the profiles envelope
    // (settings.json via ProfileStore - the same read the Profiles page uses).
    const envelope = await api.profilesList();
    persisted = {
      startWithWindows: envelope.settings.startWithWindows === true,
      startMinimized: envelope.settings.startMinimized === true,
      closeToTray: envelope.settings.closeToTray === true,
      monitorLogToFile: envelope.settings.monitorLogToFile === true,
      // M4-D2 (r2 F6): the mismatch formula also reads the profile's
      // start-at-boot intent (ocOnBoot + activeProfileId) - the Run value
      // is shared, so the Settings checkbox can legitimately be ON because
      // the profile owns it.
      ocOnBoot: envelope.settings.ocOnBoot === true,
      activeProfileId: envelope.settings.activeProfileId,
      // 1.0.1: the persisted theme (the store normalizes - an unexpected
      // value degrades to the dark default defensively).
      theme: isValidTheme(envelope.settings.theme) ? envelope.settings.theme : 'dark',
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
    } catch { /* keep the last known startup state */ }
    render();
  };

  const render = (): void => {
    // M4-D2 (r2 F6): the Settings checkbox shows ON whenever the Run value
    // exists - either the Settings toggle OR the profile's start-at-boot
    // owns it. The mismatch hint compares the startup truth against the
    // persisted INTENT (never a false mismatch when ocOnBoot owns the
    // value).
    const startWithWindows = bootState?.startWithWindows === true;
    const applyOnBoot = bootState?.applyOnBoot === true;
    const valueExists = startWithWindows || applyOnBoot;
    const intended = persisted.startWithWindows || (persisted.ocOnBoot && !!persisted.activeProfileId);
    const startWithMismatch = valueExists !== intended;

    const startWithCard = el('section', { class: 'card settings-card settings-startup-card' }, [
      el('h2', { class: 'card-title', text: 'Start with Windows' }),
      el('div', { class: 'settings-row' }, [
        el('label', { class: 'boot-toggle' }, [
          el('input', {
            type: 'checkbox',
            class: 'settings-checkbox',
            dataset: { setting: 'startWithWindows' },
            checked: valueExists,
            onchange: (ev: Event) => void onStartWithWindowsToggle((ev.target as HTMLInputElement).checked),
          }),
          el('span', { text: 'Launch Arc Power when Windows starts' }),
        ]),
      ]),
      // Honest current-state line: the HKCU Run value is the ONLY
      // registration (no tasks, no elevation).
      valueExists
        ? el('p', { class: 'card-note settings-state', text: 'Active - Arc Power starts at logon.' })
        : el('p', { class: 'card-note settings-state', text: 'Not active - the app starts manually.' }),
      // M4-D2 (r2 F6 reword): when the profile's start-at-boot owns the
      // value, the Settings checkbox is ON because Arc Power starts at
      // logon to run the boot apply - the hint explains the ownership
      // (never a false mismatch).
      applyOnBoot
        ? el('p', { class: 'card-note boot-hint', text: 'Apply active profile at boot is enabled - Arc Power starts at logon to apply it.' })
        : null,
      // M4-E (plan §3): the installed-build line - the INSTALLED app's
      // logon applies run ELEVATED through the first-run-installed
      // ArcPowerBootApply task; the portable app applies when it can
      // (unelevated, honest balloon on refusal). Short + honest, keyed on
      // app:build-info.
      s.buildKind === 'installed' || s.buildKind === 'portable'
        ? el('p', { class: 'card-note boot-hint', text: s.buildKind === 'installed'
            ? 'The installed app applies at logon elevated (installed at first run) - the portable app applies when it can.'
            : 'The portable app applies at logon when it can.' })
        : null,
      startWithMismatch
        ? el('p', { class: 'card-note boot-hint', text: 'The startup registration and the saved settings disagree - the toggle reflects the registration.' })
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
          el('span', { text: 'Start the app in the system tray (no window at boot)' }),
        ]),
      ]),
      el('p', {
        class: 'card-note settings-state',
        text: persisted.startMinimized
          ? 'The app starts hidden in the system tray - restore it from the tray icon.'
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
          ? 'The close button hides the app to the tray - use the tray menu\'s Quit to exit fully.'
          : 'The close button quits the app.',
      }),
    ]);

    // M4-D2 (§10): the "Log to file" toggle. The persisted value rides in
    // profiles-settings (monitorLogToFile); the actual log writes live in
    // the BOOT-LEVEL telemetry subscription (app.ts) so logging continues
    // across page navigation. M4M (G): this Settings card is now the ONLY
    // home of the toggle - the Monitoring page's duplicate card is REMOVED.
    const logCard = el('section', { class: 'card settings-card' }, [
      el('h2', { class: 'card-title', text: 'Log to file' }),
      el('div', { class: 'settings-row' }, [
        el('label', { class: 'boot-toggle' }, [
          el('input', {
            type: 'checkbox',
            class: 'settings-checkbox',
            dataset: { setting: 'monitorLogToFile' },
            checked: persisted.monitorLogToFile,
            onchange: (ev: Event) => void onLogToggle((ev.target as HTMLInputElement).checked),
          }),
          el('span', { text: 'Write every telemetry sample to a text file' }),
        ]),
      ]),
      el('p', {
        class: 'card-note settings-state',
        text: persisted.monitorLogToFile
          ? 'Every telemetry sample is appended to a daily text file (monitor-YYYYMMDD.txt) in your Documents folder.'
          : 'No log file is written.',
      }),
    ]);

    // 1.0.1 Themes: the Theme card - one swatch per theme
    // (button[data-theme-option="dark|midnight|light"]). The color chips
    // are CSS-class driven (.swatch-*) - CSP style-src 'self' blocks inline
    // style attributes (plan-review N10). The current theme's swatch is
    // marked .active.
    // M5: the Overlay card - the MSI Afterburner/RTSS-style HUD settings.
    // M6-amd3 (the user's amendment): the card is BUTTON-ONLY - the
    // "Overlay settings" button + a one-line description. The enable
    // TOGGLE moved to the Overlay page's General card (overlay-settings.ts);
    // the hotkey letter / position / scale / honest notes moved there in M6
    // too.
    // M9: the button navigates to the MONITORING page with the Overlay
    // view active (the Overlay Settings content lives there now - the old
    // #/overlay page is gone; requestOverlayView signals the view BEFORE
    // the navigation, the #/fan pattern).
    const overlayCard = el('section', { class: 'card settings-card overlay-card' }, [
      el('h2', { class: 'card-title', text: 'Overlay' }),
      el('p', { class: 'card-note', text: 'The in-game style HUD - bold text floating over the screen. The enable toggle, the stats, colors, size, position and hotkey live in the Monitoring tab\'s Overlay view.' }),
      el('div', { class: 'settings-row overlay-open-row' }, [
        el('button', {
          type: 'button',
          class: 'overlay-settings-button',
          onclick: () => {
            requestOverlayView();
            window.location.hash = '#/monitoring';
          },
        }, [el('span', { text: 'Overlay settings' })]),
      ]),
    ]);

    const themeCard = el('section', { class: 'card settings-card theme-card' }, [
      el('h2', { class: 'card-title', text: 'Theme' }),
      el('p', { class: 'card-note', text: 'Appearance - Dark Steel (the default black/gray), Midnight (deep indigo) or Arctic Light. The change applies immediately and is saved.' }),
      el('div', { class: 'theme-options' }, THEMES.map((t) =>
        el('button', {
          type: 'button',
          class: `theme-option${persisted.theme === t ? ' active' : ''}`,
          dataset: { themeOption: t },
          onclick: () => void onThemeSelect(t),
        }, [
          el('span', { class: `swatch-chip swatch-${t}` }),
          el('span', { class: 'theme-option-name', text: THEME_LABELS[t] }),
        ]),
      )),
    ]);

    const aboutCard = el('section', { class: 'card settings-card' }, [
      el('h2', { class: 'card-title', text: 'About' }),
      el('div', { class: 'card-body kv-grid' }, [
        el('div', { class: 'kv', 'data-label': 'Version' }, [el('span', { class: 'settings-version', text: versionDisplay })]),
      ]),
    ]);

    clear(root);
    root.append(startWithCard, startMinimizedCard, closeToTrayCard, logCard, overlayCard, themeCard, aboutCard);
  };

  const onStartWithWindowsToggle = async (checked: boolean): Promise<void> => {
    try {
      // M4-D2: the HKCU Run value is shared with the Profiles page's
      // start-at-boot - disabling must NOT remove it while the profile's
      // boot apply owns it (the in-app boot apply then still runs). The
      // ownership decision ALWAYS re-queries startup-get FRESH - never the
      // mount-captured bootState (a stale capture could remove the value
      // the other toggle owns after a mid-session change). A failed
      // re-query degrades to "owned" - never remove the shared value
      // directly on unknown state (main's profiles-settings-save
      // re-derives the value from the persisted intent anyway).
      let ownedByBoot = true;
      try {
        const fresh = await api.startupGet();
        ownedByBoot = fresh?.applyOnBoot === true;
      } catch { /* unknown ownership - keep the shared value */ }
      if (checked || !ownedByBoot) {
        await api.startupSet(checked);
      }
      // Persist the intent so the next boot's honest-state line matches.
      await api.profilesSettingsSave({ startWithWindows: checked });
      persisted.startWithWindows = checked;
      toast(checked ? 'success' : 'info', checked ? 'Start with Windows enabled' : 'Start with Windows disabled', '');
    } catch (err) {
      toast('error', 'Start with Windows could not be changed', err instanceof Error ? err.message : String(err));
      // M4-D review F4: a PARTIAL failure (the value write landed but the
      // settings save threw) must not leave the card contradicting the
      // startup truth - re-query startup-get so the card re-renders from
      // the derived state (the checkbox follows the derivation, the state
      // line reads the truth and the mismatch hint explains the
      // disagreement). A blind checkbox revert would lie when the value
      // write actually succeeded.
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

  const onLogToggle = async (checked: boolean): Promise<void> => {
    const box = root.querySelector<HTMLInputElement>('.settings-checkbox[data-setting="monitorLogToFile"]');
    try {
      await api.profilesSettingsSave({ monitorLogToFile: checked });
      persisted.monitorLogToFile = checked;
      // M4-D2: the boot-level telemetry subscription reads the shared
      // module state - the toggle takes effect on the next tick, no
      // navigation needed.
      setMonitorLogToFile(checked);
      toast(checked ? 'success' : 'info', checked ? 'Log to file enabled' : 'Log to file disabled', '');
    } catch (err) {
      toast('error', 'Log to file could not be changed', err instanceof Error ? err.message : String(err));
      if (box) box.checked = !checked;
      return;
    }
    await refresh();
  };

  // 1.0.1 Themes: one swatch selected - apply IMMEDIATELY (the <html>
  // attribute + the canvas recolor via app.ts) and persist through
  // profiles-settings-save. A failed save REVERTS to the last persisted
  // theme + surfaces the honest error toast (like the other toggles).
  const onThemeSelect = async (theme: string): Promise<void> => {
    if (!isValidTheme(theme) || theme === persisted.theme) return;
    const syncSwatches = (active: Theme): void => {
      root.querySelectorAll<HTMLElement>('.theme-option').forEach((b) => {
        b.classList.toggle('active', b.dataset.themeOption === active);
      });
    };
    const previous = persisted.theme;
    // Apply first - the UI never waits on the save to show the new theme.
    applyTheme(theme);
    persisted.theme = theme;
    syncSwatches(theme);
    try {
      await api.profilesSettingsSave({ theme });
      toast('success', 'Theme changed', `${THEME_LABELS[theme]} is now active.`);
    } catch (err) {
      // Revert to the last known persisted theme (the failed save left the
      // store on `previous`) + honest error toast.
      toast('error', 'Theme could not be changed', err instanceof Error ? err.message : String(err));
      applyTheme(previous);
      persisted.theme = previous;
      syncSwatches(previous);
    }
  };

  // M6-amd3: the overlay enable toggle MOVED with the rest of the overlay
  // controls to the Overlay Settings page (overlay-settings.ts) - the
  // shrunk Settings card is button-only (the "Overlay settings" button).

  render();
}
