// Arc Power - Settings tab (M4-D + M4-D2): Start with Windows (the verified
// packaged task or legacy HKCU Run registration), Start minimized (persisted
// startMinimized - the app starts hidden in the system tray at boot, the tray
// click restores), Close to tray (persisted closeToTray - closing the
// window hides it to the icon list instead of quitting; the tray menu's
// Quit still exits), and the app version row.
//
// M4-D2 (r2 F4/F6): the startup registration is SHARED with the Profiles
// page's "start at boot" (ocOnBoot) - one registration serves both toggles.
// Honesty
// rules:
//   - the checkbox reflects the STARTUP-GET derivation (checked whenever
//     the registration exists - either toggle can own it), never the persisted
//     intent alone;
//   - the mismatch hint compares the startup truth against the persisted
//     intent `(settings.startWithWindows || (settings.ocOnBoot &&
//     !!settings.activeProfileId))` - NEVER a false mismatch when ocOnBoot
//     owns the value (plan-review r2 F6);
//   - disabling Start with Windows must NOT remove the startup registration
//     while the profile's start-at-boot owns it (the registration is shared) - the toggle
//     RE-QUERIES startup-get FRESH before that ownership decision (never
//     the mount-captured bootState); main's profiles-settings-save is the
//     single writer of the registration and re-derives it from the persisted
//     intent on every save.
//
// Packaged Windows builds use an explicit elevated ArcPowerStartup task:
// Explorer cannot reliably consent a requireAdministrator executable from a
// bare HKCU Run value at logon. Dev/mock keeps the Run adapter for tests.

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { api } from '../ipc.ts';
import { toast } from '../components/toast.ts';
import { showRecordingHotkeyDialog } from '../components/recording-hotkey-dialog.ts';
// M5 (N3): displayVersion is imported ALIASED - the settings page used to
// define its OWN `displayVersion` local (the version-row formatter); the
// alias keeps the header's pure helper without a name collision.
import { displayVersion as displayVersionLine } from '../components/header.ts';
import { applyTheme } from '../app.ts';
import { isValidTheme, reconcileThemeSave, THEMES, type Theme } from '../pure/theme.ts';
import { applyUiPreferences, readUiPreferences, UI_SCALES, uiScaleLabel, writeUiPreferences } from '../pure/ui-preferences.ts';
import { HIDEABLE_TABS, HIDDEN_TABS_EVENT, readHiddenTabs, writeHiddenTabs } from '../pure/hidden-tabs.ts';
import type { StartupGetState } from '../types.ts';

function showMaintenanceConfirm(title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root') ?? (() => {
      const node = el('div', { id: 'modal-root' });
      document.body.append(node);
      return node;
    })();
    clear(root);
    const close = (confirmed: boolean): void => {
      clear(root);
      resolve(confirmed);
    };
    root.append(el('div', { class: 'modal-overlay' }, [
      el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
        el('h2', { class: 'modal-title', text: title }),
        el('p', { class: 'modal-text', text: message }),
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'btn btn-ghost', text: 'Cancel', onClick: () => close(false) }),
          el('button', { class: 'btn btn-danger', text: title, onClick: () => close(true) }),
        ]),
      ]),
    ]));
  });
}

/** 1.0.4 Themes: the display label per theme id (the swatch buttons). */
const THEME_LABELS: Record<Theme, string> = {
  dark: 'Dark Steel',
  midnight: 'Midnight',
  light: 'Arctic Light',
  red: 'Red',
  yellow: 'Yellow',
};

export const settingsPage: Page = {
  id: 'settings',

  render(container: HTMLElement, ctx: PageContext) {
    clear(container);
    container.append(el('div', { id: 'settings-root', class: 'settings-root' }, [el('p', { class: 'page-subtitle', text: 'Loading settings…' })]));
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
  let persisted: { startWithWindows: boolean; startMinimized: boolean; closeToTray: boolean; memorySavingMode: boolean; ocOnBoot: boolean; activeProfileId: string | null; theme: Theme };
  // One row per global shortcut. Overlay chords use 'None' for off; recording
  // accelerators use '' - that is what each backing store expects.
  const hotkeys: Record<string, string> = {
    overlay: 'None', advanced: 'None', scale: 'None',
    toggle: '', saveClip: '', screenshot: '', marker: '',
  };
  // Theme chips apply immediately, so rapid clicks can enqueue overlapping
  // read-modify-write IPC calls. Serialize only the theme writes to preserve
  // click order in the ProfileStore and keep the final chip persistent.
  let themeSaveQueue: Promise<unknown> = Promise.resolve();
  let themeSelectionGeneration = 0;
  let committedTheme: Theme;
  let bootState: StartupGetState | null = null;
  let startupCheckPending = false;
  let maintenancePending = false;
  try {
    // The persisted Settings-tab fields ride in the profiles envelope
    // (settings.json via ProfileStore - the same read the Profiles page uses).
    const envelope = await api.profilesList();
    persisted = {
      startWithWindows: envelope.settings.startWithWindows === true,
      startMinimized: envelope.settings.startMinimized === true,
      closeToTray: envelope.settings.closeToTray === true,
      memorySavingMode: envelope.settings.memorySavingMode === true,
      // M4-D2 (r2 F6): the mismatch formula also reads the profile's
      // start-at-boot intent (ocOnBoot + activeProfileId) - the startup
      // registration is shared, so the Settings checkbox can legitimately be ON because
      // the profile owns it.
      ocOnBoot: envelope.settings.ocOnBoot === true,
      activeProfileId: envelope.settings.activeProfileId,
      // 1.0.1: the persisted theme (the store normalizes - an unexpected
      // value degrades to the dark default defensively).
      theme: isValidTheme(envelope.settings.theme) ? envelope.settings.theme : 'dark',
    };
    committedTheme = persisted.theme;
    hotkeys.overlay = envelope.settings.overlayHotkeyLetter ?? 'None';
    hotkeys.advanced = envelope.settings.advancedOverlayHotkeyLetter ?? 'None';
    hotkeys.scale = envelope.settings.postprocessScaleHotkey ?? 'None';
  } catch (err) {
    clear(root);
    root.append(el('p', { class: 'text-error', text: `Could not load settings: ${err instanceof Error ? err.message : String(err)}` }));
    return;
  }
  try {
    bootState = await api.startupGet();
  } catch { /* the cards below degrade to the persisted state */ }
  try {
    const recording = await api.recordingSettingsGet();
    for (const key of ['toggle', 'saveClip', 'screenshot', 'marker']) {
      hotkeys[key] = recording.hotkeys?.[key as keyof typeof recording.hotkeys] ?? '';
    }
  } catch { /* recording shortcuts stay blank when the service is unavailable */ }

  const refresh = async (): Promise<void> => {
    if (startupCheckPending) return;
    startupCheckPending = true;
    render();
    try {
      bootState = await api.startupGet();
    } catch { bootState = null; /* a failed recheck invalidates the prior state */ }
    startupCheckPending = false;
    render();
  };

  const render = (): void => {
    // M4-D2 (r2 F6): the Settings checkbox shows ON whenever the verified
    // startup registration exists - either the Settings toggle OR the profile's start-at-boot
    // owns it.
    const startWithWindows = bootState?.startWithWindows === true;
    const applyOnBoot = bootState?.applyOnBoot === true;
    const valueExists = startWithWindows || applyOnBoot;
    const packagedStartup = s.buildKind === 'installed' || s.buildKind === 'portable';
    const taskStartup = bootState?.registration === 'task' || packagedStartup;
    const startupVerified = bootState !== null;
    const startupCheckbox = el('input', {
      type: 'checkbox',
      class: 'settings-checkbox',
      dataset: { setting: 'startWithWindows' },
      checked: valueExists,
      disabled: !startupVerified || startupCheckPending,
      onchange: (ev: Event) => void onStartWithWindowsToggle((ev.target as HTMLInputElement).checked),
    });
    startupCheckbox.indeterminate = !startupVerified;

    const startWithCard = el('section', { class: 'card settings-card settings-startup-card arc-surface-card' }, [
      el('h2', { class: 'card-title', text: 'Start with Windows' }),
      el('div', { class: 'settings-row' }, [
        el('label', { class: 'boot-toggle' }, [
          startupCheckbox,
          el('span', { text: 'Launch Arc Power when Windows starts' }),
        ]),
      ]),
      // Honest current-state line: packaged builds report the verified task;
      // dev/mock retains the Run adapter wording.
      !startupVerified
        ? el('div', { class: 'settings-startup-unknown' }, [
          el('p', { class: 'card-note settings-state', role: 'status', text: startupCheckPending
            ? 'Checking the Windows startup registration…'
            : 'Could not verify the Windows startup registration. Its current state is unknown.' }),
          el('button', {
            class: 'btn btn-ghost settings-startup-retry',
            type: 'button',
            disabled: startupCheckPending,
            text: startupCheckPending ? 'Checking…' : 'Retry',
            onclick: () => void refresh(),
          }),
        ])
        : valueExists
        ? el('p', { class: 'card-note settings-state', text: taskStartup ? 'Active - an administrator startup task launches Arc Power at logon.' : 'Active - Arc Power starts at logon.' })
        : el('p', { class: 'card-note settings-state', text: taskStartup ? 'Not active - enable this setting to create the one-time administrator startup task.' : 'Not active - the app starts manually.' }),
    ]);

    const startMinimizedCard = el('section', { class: 'card settings-card settings-minimized-card arc-surface-card' }, [
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

    const closeToTrayCard = el('section', { class: 'card settings-card settings-close-card arc-surface-card' }, [
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

    const memorySavingCard = el('section', { class: 'card settings-card settings-memory-card arc-surface-card' }, [
      el('h2', { class: 'card-title', text: 'Memory Saving Mode' }),
      el('div', { class: 'settings-row' }, [
        el('label', { class: 'boot-toggle' }, [
          el('input', {
            type: 'checkbox',
            class: 'settings-checkbox',
            dataset: { setting: 'memorySavingMode' },
            checked: persisted.memorySavingMode,
            onchange: (ev: Event) => void onMemorySavingToggle((ev.target as HTMLInputElement).checked),
          }),
          el('span', { text: 'Unload the capture runtime when it is idle' }),
        ]),
      ]),
      el('p', {
        class: 'card-note settings-state',
        text: persisted.memorySavingMode
          ? 'On - saves RAM by loading the recording runtime only when needed.'
          : 'Off - keeps the capture runtime ready for faster recording starts and uses more RAM.',
      }),
    ]);

    // 1.0.1 Themes: the Theme card - one swatch per theme
    // (button[data-theme-option="dark|midnight|light"]). The color chips
    // are CSS-class driven (.swatch-*) - CSP style-src 'self' blocks inline
    // style attributes (plan-review N10). The current theme's swatch is
    // marked .active.
    let uiPreferences = readUiPreferences();
    const densityButtons: HTMLButtonElement[] = [];
    const scaleButtons: HTMLButtonElement[] = [];
    const syncInterfaceButtons = (): void => {
      for (const button of densityButtons) button.classList.toggle('active', button.dataset.density === uiPreferences.density);
      for (const button of scaleButtons) button.classList.toggle('active', Number(button.dataset.scale) === uiPreferences.scale);
    };
    const updateUiPreferences = (next: Partial<typeof uiPreferences>): void => {
      uiPreferences = { ...uiPreferences, ...next };
      writeUiPreferences(uiPreferences);
      applyUiPreferences(uiPreferences);
      syncInterfaceButtons();
    };
    const interfaceCard = el('section', { class: 'card settings-card settings-interface-card arc-surface-card' }, [
      el('h2', { class: 'card-title', text: 'Density & scale' }),
      el('p', { class: 'card-note', text: 'Compact fits more rows on screen; scale enlarges the whole window. Stored on this PC only.' }),
      el('div', { class: 'settings-row settings-density-row' }, [
        el('span', { class: 'settings-label', text: 'Density' }),
        ...(['comfortable', 'compact'] as const).map((density) => {
          const button = el('button', {
            type: 'button',
            class: 'btn btn-secondary settings-density-option',
            dataset: { density },
            text: density === 'compact' ? 'Compact' : 'Comfortable',
            onclick: () => updateUiPreferences({ density }),
          }) as HTMLButtonElement;
          densityButtons.push(button);
          return button;
        }),
      ]),
      el('div', { class: 'settings-row settings-scale-row' }, [
        el('span', { class: 'settings-label', text: 'Scale' }),
        ...UI_SCALES.map((scale) => {
          const button = el('button', {
            type: 'button',
            class: 'btn btn-secondary settings-scale-option',
            dataset: { scale: String(scale) },
            text: uiScaleLabel(scale),
            onclick: () => updateUiPreferences({ scale }),
          }) as HTMLButtonElement;
          scaleButtons.push(button);
          return button;
        }),
      ]),
    ]);
    syncInterfaceButtons();

    // 1.0.1 Themes: the Theme card - one swatch per theme
    const maintenanceCard = el('section', { class: 'card settings-card maintenance-card arc-surface-card' }, [
      el('h2', { class: 'card-title', text: 'Maintenance' }),
      el('div', { class: 'card-note maintenance-descriptions' }, [
        el('p', { text: 'Clear Cache: Removes Cache and Restarts Arc Power.' }),
        el('p', { text: 'Stock Reset: Clears Cache and Deletes Settings and Presets.' }),
        el('p', { text: 'Full Reset: Clears Cache, Deletes Settings, Presets and Downloaded Drivers.' }),
      ]),
      el('div', { class: 'settings-row maintenance-row' }, [
        ...([
          { action: 'clear-cache' as const, label: 'Clear Cache' },
          { action: 'reset' as const, label: 'Stock Reset' },
          { action: 'reset-with-drivers' as const, label: 'Full Reset' },
        ].map(({ action, label }) => el('button', {
          type: 'button',
          class: 'maintenance-action',
          dataset: { action: action === 'clear-cache' ? 'clear-cache-restart' : action },
          disabled: maintenancePending,
          onclick: () => void onMaintenanceAction(action),
        }, [el('span', { text: label })]))),
      ]),
    ]);

    const themeCard = el('section', { class: 'card settings-card theme-card arc-surface-card' }, [
      el('h2', { class: 'card-title', text: 'Theme' }),
      el('p', { class: 'card-note', text: 'Appearance theme - applies immediately.' }),
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

    const aboutCard = el('section', { class: 'card settings-card settings-about-card arc-surface-card' }, [
      el('h2', { class: 'card-title', text: 'About' }),
      el('div', { class: 'card-body kv-grid' }, [
        el('div', { class: 'kv', 'data-label': 'Version' }, [el('span', { class: 'settings-version', text: versionDisplay })]),
      ]),
    ]);

    type HotkeyRow = {
      key: string; label: string; description: string; off: string | null;
      modifier: boolean; save: (value: string) => Promise<unknown>;
    };
    const hotkeyRows: HotkeyRow[] = [
      { key: 'overlay', label: 'HUD overlay', description: 'Toggle the in-game HUD from any window.', off: 'None', modifier: true,
        save: (value) => api.profilesSettingsSave({ overlayHotkeyLetter: value }) },
      { key: 'advanced', label: 'Advanced overlay', description: 'Open the advanced tuning panel from any window.', off: 'None', modifier: true,
        save: (value) => api.profilesSettingsSave({ advancedOverlayHotkeyLetter: value }) },
      { key: 'scale', label: 'Post-process scale', description: 'Start or stop selected-window scaling from any window.', off: 'None', modifier: true,
        save: (value) => api.postprocessSharpeningHotkeySet(value).then(() => undefined) },
      { key: 'toggle', label: 'Start / stop recording', description: 'Begin or finish video capture. Instant Replay continues independently.', off: '', modifier: false,
        save: (value) => api.recordingSettingsSave({ hotkeys: { toggle: value } }) },
      { key: 'saveClip', label: 'Save Instant Replay', description: 'Export the configured Instant Replay window.', off: '', modifier: false,
        save: (value) => api.recordingSettingsSave({ hotkeys: { saveClip: value } }) },
      { key: 'screenshot', label: 'Screenshot', description: 'Save the selected display or window as a PNG.', off: '', modifier: false,
        save: (value) => api.recordingSettingsSave({ hotkeys: { screenshot: value } }) },
      { key: 'marker', label: 'Add marker', description: 'Mark a moment in the current recording.', off: '', modifier: false,
        save: (value) => api.recordingSettingsSave({ hotkeys: { marker: value } }) },
    ];
    // Overlay chords are persisted in shorthand ('o', 'p'); the UI must show
    // the real accelerator the same way the Overlay page does.
    const displayHotkey = (value: string): string =>
      value === '' || value === 'None' ? (value || 'NONE')
        : /^[A-Za-z]$/.test(value) ? `CONTROL+${value.toUpperCase()}` : value;
    const hotkeyRow = (row: HotkeyRow): HTMLElement => {
      const current = hotkeys[row.key] ?? '';
      const picker = el('button', {
        class: 'recording-hotkey', type: 'button', text: displayHotkey(current),
        'aria-label': `${row.label} hotkey: ${current || 'not set'}`,
        onClick: () => void showRecordingHotkeyDialog(row.label, current, { requireModifier: row.modifier }).then(async (next) => {
          if (next === null) return;
          await commitHotkey(row, next);
        }),
      });
      return el('div', { class: 'recording-hotkey-row' }, [
        el('div', { class: 'recording-hotkey-copy' }, [
          el('strong', { text: row.label }), el('span', { text: row.description }),
        ]),
        el('div', { class: 'recording-hotkey-status' }, [
          picker,
          row.off !== null ? el('button', {
            class: 'btn btn-secondary recording-hotkey-none', type: 'button', text: 'NONE',
            title: `Turn off the ${row.label} shortcut`,
            onClick: () => void commitHotkey(row, row.off as string),
          }) : null,
        ]),
      ]);
    };
    const commitHotkey = async (row: HotkeyRow, value: string): Promise<void> => {
      try {
        await row.save(value);
        hotkeys[row.key] = value;
        toast('success', `${row.label} hotkey`, value ? `Set to ${value}.` : 'Shortcut turned off.');
        render();
      } catch (err) {
        toast('error', `${row.label} hotkey could not be changed`, err instanceof Error ? err.message : String(err));
      }
    };
    const hotkeysCard = el('section', { class: 'recording-panel settings-hotkeys-card arc-surface-card' }, [
      el('div', { class: 'recording-panel-heading recording-panel-heading-compact' }, [
        el('div', {}, [el('span', { class: 'recording-eyebrow', text: 'SHORTCUTS' }), el('h2', { class: 'recording-panel-title', text: 'Hotkeys' })]),
        el('span', { class: 'recording-panel-badge', text: 'Global' }),
      ]),
      el('p', { class: 'recording-panel-note', text: 'Works from any window. Click a key to swap it, or NONE to turn it off.' }),
      ...hotkeyRows.map(hotkeyRow),
    ]);
    const hiddenTabs = readHiddenTabs();
    const navigationRow = (tab: (typeof HIDEABLE_TABS)[number]): HTMLElement => {
      const status = el('span', { class: 'recording-hotkey-status-note', text: hiddenTabs.has(tab.id) ? 'Hidden' : 'Visible' });
      return el('div', { class: 'recording-hotkey-row' }, [
        el('div', { class: 'recording-hotkey-copy' }, [
          el('strong', { text: tab.label }), el('span', { text: tab.description }),
        ]),
        el('div', { class: 'recording-hotkey-status' }, [
          el('label', { class: 'boot-toggle' }, [
            el('input', {
              type: 'checkbox',
              class: 'settings-checkbox',
              dataset: { hiddenTab: tab.id },
              checked: !hiddenTabs.has(tab.id),
              onchange: (ev: Event) => {
                const checked = (ev.target as HTMLInputElement).checked;
                const next = readHiddenTabs();
                if (checked) next.delete(tab.id); else next.add(tab.id);
                writeHiddenTabs(next);
                hiddenTabs.clear();
                for (const id of next) hiddenTabs.add(id);
                status.textContent = checked ? 'Visible' : 'Hidden';
                window.dispatchEvent(new Event(HIDDEN_TABS_EVENT));
                toast('success', 'Sidebar tabs', checked ? `${tab.label} shown.` : `${tab.label} hidden.`);
              },
            }),
            el('span', { text: 'Show tab' }),
          ]),
          status,
        ]),
      ]);
    };
    const navigationCard = el('section', { class: 'recording-panel settings-hotkeys-card arc-surface-card' }, [
      el('div', { class: 'recording-panel-heading recording-panel-heading-compact' }, [
        el('div', {}, [el('span', { class: 'recording-eyebrow', text: 'NAVIGATION' }), el('h2', { class: 'recording-panel-title', text: 'Sidebar tabs' })]),
        el('span', { class: 'recording-panel-badge', text: 'Optional' }),
      ]),
      el('p', { class: 'recording-panel-note', text: 'Hide tabs you do not use. Dashboard, Tuning and Settings always stay visible.' }),
      ...HIDEABLE_TABS.map(navigationRow),
    ]);
    const settingCards = [startWithCard, startMinimizedCard, closeToTrayCard, memorySavingCard, maintenanceCard, themeCard, interfaceCard, aboutCard, hotkeysCard, navigationCard];
    const preferencesGroup = el('section', { class: 'settings-group settings-preferences-group' }, [
      el('div', { class: 'settings-group-heading' }, [
        el('div', {}, [
          el('h2', { text: 'Startup & behavior' }),
          el('p', { text: 'Choose how Arc Power opens and manages capture memory.' }),
        ]),
        el('span', { class: 'settings-group-index', text: '01' }),
      ]),
      el('div', { class: 'settings-preferences-grid' }, [startWithCard, startMinimizedCard, closeToTrayCard, memorySavingCard]),
    ]);
    const interfaceGroup = el('section', { class: 'settings-group settings-interface-group' }, [
      el('div', { class: 'settings-group-heading' }, [
        el('div', {}, [
          el('h2', { text: 'Appearance' }),
          el('p', { text: 'Set the app theme.' }),
        ]),
        el('span', { class: 'settings-group-index', text: '02' }),
      ]),
      el('div', { class: 'settings-interface-grid' }, [interfaceCard, themeCard]),
    ]);
    const maintenanceGroup = el('section', { class: 'settings-group settings-maintenance-group' }, [
      el('div', { class: 'settings-group-heading' }, [
        el('div', {}, [
          el('h2', { text: 'Maintenance & version' }),
          el('p', { text: 'Manage local app data and check the installed version.' }),
        ]),
        el('span', { class: 'settings-group-index', text: '03' }),
      ]),
      el('div', { class: 'settings-maintenance-grid' }, [maintenanceCard, aboutCard]),
    ]);
    const hotkeysGroup = el('section', { class: 'settings-group settings-hotkeys-group' }, [
      el('div', { class: 'settings-group-heading' }, [
        el('div', {}, [
          el('h2', { text: 'Hotkeys' }),
          el('p', { text: 'Review, swap, or disable every global shortcut.' }),
        ]),
        el('span', { class: 'settings-group-index', text: '04' }),
      ]),
      hotkeysCard,
    ]);
    const navigationGroup = el('section', { class: 'settings-group settings-hotkeys-group' }, [
      el('div', { class: 'settings-group-heading' }, [
        el('div', {}, [
          el('h2', { text: 'Navigation' }),
          el('p', { text: 'Hide sidebar tabs that are not part of your workflow.' }),
        ]),
        el('span', { class: 'settings-group-index', text: '05' }),
      ]),
      navigationCard,
    ]);
    const settingGroups = [
      { node: preferencesGroup, cards: [startWithCard, startMinimizedCard, closeToTrayCard, memorySavingCard] },
      { node: interfaceGroup, cards: [interfaceCard, themeCard] },
      { node: maintenanceGroup, cards: [maintenanceCard, aboutCard] },
      { node: hotkeysGroup, cards: [hotkeysCard] },
      { node: navigationGroup, cards: [navigationCard] },
    ];
    const settingsHero = el('header', { class: 'arc-page-hero settings-page-hero' }, [
      el('div', { class: 'arc-page-hero-copy' }, [
        el('span', { class: 'arc-section-kicker', text: 'SYSTEM CONTROL' }),
        el('h1', { class: 'page-title', text: 'Settings' }),
        el('p', { class: 'page-subtitle', text: 'Configure startup behavior, appearance, and local Arc Power maintenance.' }),
      ]),
      el('div', { class: 'arc-page-hero-side' }, [
        el('span', { class: 'arc-hero-label', text: 'APP PREFERENCES' }),
        el('span', { class: 'arc-hero-value', text: 'Arc Power' }),
      ]),
    ]);
    const search = el('input', {
      class: 'settings-search',
      type: 'search',
      placeholder: 'Search settings…',
      'aria-label': 'Search settings',
    }) as HTMLInputElement;
    const resultCount = el('span', { class: 'settings-search-count', text: `${settingCards.length} sections` });
    const filterSettings = (): void => {
      const needle = search.value.trim().toLowerCase();
      let visible = 0;
      for (const card of settingCards) {
        const matches = !needle || (card.textContent ?? '').toLowerCase().includes(needle);
        card.hidden = !matches;
        if (matches) visible += 1;
      }
      for (const group of settingGroups) group.node.hidden = !group.cards.some((card) => !card.hidden);
      resultCount.textContent = `${visible} ${visible === 1 ? 'section' : 'sections'}`;
    };
    search.addEventListener('input', filterSettings);
    clear(root);
    root.append(
      settingsHero,
      el('div', { class: 'settings-toolbar arc-page-toolbar' }, [search, resultCount]),
      preferencesGroup,
      interfaceGroup,
      maintenanceGroup,
      hotkeysGroup,
      navigationGroup,
    );
    filterSettings();
  };

  const onStartWithWindowsToggle = async (checked: boolean): Promise<void> => {
    try {
      // M4-D2: the startup registration is shared with the Profiles page's
      // start-at-boot - disabling must NOT remove it while the profile's
      // boot apply owns it (the in-app boot apply then still runs). The
      // ownership decision ALWAYS re-queries startup-get FRESH - never the
      // mount-captured bootState (a stale capture could remove the value
      // the other toggle owns after a mid-session change). A failed
      // re-query degrades to "owned" - never remove the shared value
      // directly on unknown state (main's profiles-settings-save
      // re-derives the value from the persisted intent anyway). Disabling
      // the global launcher also clears the dependent profile boot intent;
      // otherwise profiles-settings-save would immediately recreate the Run
      // value and the switch would appear to turn itself back on.
      let ownedByBoot = true;
      try {
        const fresh = await api.startupGet();
        ownedByBoot = fresh?.applyOnBoot === true;
      } catch { /* unknown ownership - keep the shared value */ }
      if (checked || !ownedByBoot) {
        await api.startupSet(checked);
      }
      // Persist the intent so the next boot's honest-state line matches.
      await api.profilesSettingsSave({
        startWithWindows: checked,
        ...(checked ? {} : { ocOnBoot: false }),
      });
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

  const onMemorySavingToggle = async (checked: boolean): Promise<void> => {
    const previous = persisted.memorySavingMode;
    const box = root.querySelector<HTMLInputElement>('.settings-checkbox[data-setting="memorySavingMode"]');
    persisted.memorySavingMode = checked;
    render();
    try {
      const result = await api.profilesSettingsSave({ memorySavingMode: checked });
      persisted.memorySavingMode = result.memorySavingMode === true;
      toast(checked ? 'success' : 'info', checked ? 'Memory Saving Mode enabled' : 'Memory Saving Mode disabled', checked
        ? 'The capture runtime will unload when idle.'
        : 'The capture runtime will stay ready for faster starts.');
    } catch (err) {
      persisted.memorySavingMode = previous;
      if (box) box.checked = previous;
      toast('error', 'Memory Saving Mode could not be changed', err instanceof Error ? err.message : String(err));
    }
    render();
  };

  const onMaintenanceAction = async (action: 'clear-cache' | 'reset' | 'reset-with-drivers'): Promise<void> => {
    if (maintenancePending) return;
    if (action !== 'clear-cache') {
      const message = action === 'reset'
        ? 'Stock Reset clears the cache and deletes settings and presets. Downloaded drivers and your clip library, recording folder, and recorded files will be kept. Continue?'
        : 'Full Reset clears the cache and deletes settings, presets, and downloaded drivers. Your clip library, recording folder, and recorded files will be kept. Continue?';
      if (!await showMaintenanceConfirm(action === 'reset' ? 'Stock Reset' : 'Full Reset', message)) return;
    }
    maintenancePending = true;
    const buttons = root.querySelectorAll<HTMLButtonElement>('.maintenance-action');
    buttons.forEach((button) => { button.disabled = true; });
    let keepPendingForRestart = false;
    try {
      const result = await api.appMaintenanceAndRestart(action);
      if (!result || result.ok !== true) {
        throw new Error('Arc Power maintenance could not be completed');
      }
      keepPendingForRestart = result.restarting;
      toast('success', action === 'clear-cache' ? 'Cache cleared' : 'Arc Power reset', result.restarting ? 'Arc Power is restarting.' : 'Restart request completed.');
    } catch (err) {
      toast('error', 'Arc Power maintenance failed', err instanceof Error ? err.message : String(err));
    } finally {
      if (!keepPendingForRestart) {
        maintenancePending = false;
        buttons.forEach((button) => { if (button.isConnected) button.disabled = false; });
      }
    }
  };
  // 1.0.1 Themes: one swatch selected - apply IMMEDIATELY (the <html>
  // attribute + the canvas recolor via app.ts) and persist through
  // profiles-settings-save. A failed save rolls back only when its request
  // is still the newest live selection; a newer queued selection always wins.

  const onThemeSelect = async (theme: string): Promise<void> => {
    if (!isValidTheme(theme) || theme === persisted.theme) return;
    const requestGeneration = ++themeSelectionGeneration;
    const syncSwatches = (active: Theme): void => {
      root.querySelectorAll<HTMLElement>('.theme-option').forEach((b) => {
        b.classList.toggle('active', b.dataset.themeOption === active);
      });
    };
    // The live selection may advance while this request waits in the queue.
    // Keep the last successful store value separate from that selection.
    applyTheme(theme);
    persisted.theme = theme;
    syncSwatches(theme);
    const save = themeSaveQueue.then(() => api.profilesSettingsSave({ theme }));
    // Keep the queue alive after a rejected write so a later user click can
    // still commit its theme.
    themeSaveQueue = save.catch(() => undefined);
    try {
      await save;
      committedTheme = reconcileThemeSave(
        persisted.theme,
        committedTheme,
        theme,
        true,
        requestGeneration,
        themeSelectionGeneration,
      ).committed;
      toast('success', 'Theme changed', `${THEME_LABELS[theme]} is now active.`);
    } catch (err) {
      // An older failure must not roll back a newer live selection. Only the
      // request that is still newest may restore the last committed theme.
      const result = reconcileThemeSave(
        persisted.theme,
        committedTheme,
        theme,
        false,
        requestGeneration,
        themeSelectionGeneration,
      );
      if (result.theme !== persisted.theme) {
        applyTheme(result.theme);
        persisted.theme = result.theme;
        syncSwatches(result.theme);
      }
      toast('error', 'Theme could not be changed', err instanceof Error ? err.message : String(err));
    }
  };

  // M6-amd3: the overlay enable toggle MOVED with the rest of the overlay
  // controls to the Overlay Settings page (overlay-settings.ts) - the
  // shrunk Settings card is button-only (the "Overlay settings" button).

  render();
}
