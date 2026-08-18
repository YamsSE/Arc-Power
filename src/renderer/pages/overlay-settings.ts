// Arc Power - M6 the Overlay Settings content (M9: the #/overlay PAGE is
// gone - the content lives inside the Monitoring page's Overlay view; the
// old hash redirects there via the router). M6-amd3 (
// amendment): the content ALSO owns the enable TOGGLE now - the General
// card at the top (the Settings card is button-only); everything else:
//   - Stats - the 19 stat TICKBOXES (the Monitoring-tab-tickbox idea,
//     landed here): FPS + the M7a 1% Low / 99% FPS + the M12 AVG / 0.1%
//     Low row stats + the M10a Graphics-API badge, CPU
//     Util/Clock/Temp + the M13 Wattage, the M12 RAM, GPU Util/Core
//     clock/Mem clock/VRAM/Temp/Wattage/Fan + the Frametime graph. Persisted
//     as overlayStats (string[], default = ALL - the stock set);
//   - Appearance - the COLORS (a swatch palette - the theme-option pattern:
//     white (stock), yellow, green, cyan, orange, red, magenta + a custom
//     hex input (type=color - a plain value applied via CSSOM, CSP-safe))
//     + the SIZE slider (the existing overlayScale) + M9 the POSITION
//     select (the standalone Position card is REMOVED - the corner lives
//     in the Appearance card);
//   - Hotkey - the letter input (CTRL + fixed - the letter is the only
//     changeable part) + the register-failure note + the get-state re-query
//     on every render (the Settings-card pattern - the honest note never
//     goes stale);
//   - the honest notes at the bottom (topmost/MPO + the FPS/frametime data
//     sources).
//
// The content KEEPS the Settings card's class names (.settings-hotkey-input,
// .settings-position-select, .settings-scale-slider, ...) - the ui-verify
// selectors survived the Settings->Overlay page move AND the M9 move into
// the Monitoring view. The General card's toggle KEEPS the
// .settings-checkbox[data-setting="overlayEnabled"] class + dataset so the
// toggle pins moved with the control too.

import { el, clear } from '../dom.ts';
import type { PageContext } from '../router.ts';
import { api } from '../ipc.ts';
import { toast } from '../components/toast.ts';
import {
  OVERLAY_POSITIONS,
  OVERLAY_POSITION_LABELS,
  OVERLAY_STAT_IDS,
  OVERLAY_STATS_DEFAULT,
  OVERLAY_STAT_LABELS,
  OVERLAY_COLOR_PRESETS,
  OVERLAY_COLOR_LABELS,
  OVERLAY_POLL_MS_MIN,
  OVERLAY_POLL_MS_MAX,
  OVERLAY_THEMES,
  OVERLAY_THEME_DEFAULT,
  isValidOverlayPosition,
  isValidOverlayColor,
  isValidOverlayTheme,
  clampOverlayScale,
  clampOverlayBgOpacity,
  clampOverlayPollMs,
  // M23: the ADVANCED overlay's anchored-edge mirror (pure/overlay.ts - the
  // HUD's lockstep family; the persisted-truth owner is profile-store.js).
  ADVANCED_OVERLAY_POSITIONS,
  ADVANCED_OVERLAY_POSITION_LABELS,
  isValidAdvancedOverlayPosition,
} from '../pure/overlay.ts';
import type { OverlayPosition, OverlayState, AdvancedOverlayState } from '../types.ts';

// M9: the Overlay Settings content renderer - the old page module's export
// (the fan-editor.ts precedent: the old page shell moved into the
// Monitoring page, this module renders the sub-view content). The
// sub-view carries its own heading ("Overlay Settings" stays - the
// ui-verify pins the title text).
// M25: the "Overlay Settings" heading + subtitle are REMOVED - the
// Monitoring page's own title + subtitle now serve as the description.
export function renderOverlaySettings(container: HTMLElement, ctx: PageContext): void {
  clear(container);
  container.append(
    el('div', { id: 'overlay-settings-root', class: 'overlay-settings-root' }, [el('p', { class: 'page-subtitle', text: 'Loading settings…' })]),
  );
  void mount(ctx, container);
}

interface PersistedOverlay {
  enabled: boolean;
  hotkeyLetter: string;
  position: OverlayPosition;
  scale: number;
  color: string;
  stats: string[];
  // M24: the overlay THEME ('arc' the product default - the Intel-Arc
  // harness redesign; 'classic' the original HUD, one click away via the
  // Theme row). Persisted as settings.json 'overlayTheme'.
  theme: 'classic' | 'arc';
  // M7b (fix 4): the background box (the Appearance card's Background
  // section) - off / black / 0.5 opacity when absent.
  bgEnabled: boolean;
  bgColor: string;
  bgOpacity: number;
  // M17b: the chip-name row labels (the General card checkbox) - off =
  // the stock 'CPU '/'GPU ' prefixes.
  chipNames: boolean;
  // M17e (the user addition): the overlay polling-rate (the General card
  // slider) - the telemetry push cadence in ms (100-2000, 400 the default
  // - M17g: the stock polling rate FLIPS 500 -> 400).
  pollMs: number;
  // M23: the ADVANCED overlay (the AMD-Adrenaline-style interactive side
  // panel - CONTROL + <letter>, stock P). Absent on old files -> the
  // defaults (off / 'P' / 'right').
  advEnabled: boolean;
  advHotkeyLetter: string;
  advPosition: 'left' | 'right';
}

async function mount(ctx: PageContext, container: HTMLElement): Promise<void> {
  const root = container.querySelector('#overlay-settings-root') as HTMLElement;

  // M5/M6: the overlay window's live state - the page re-queries it on
  // EVERY render (the refresh() pattern) so the hotkey-register-failure
  // note never goes stale (M1: a letter-save re-register failure
  // mid-session must surface immediately).
  let overlayState: OverlayState | null = null;
  let persisted: PersistedOverlay;
  try {
    const envelope = await api.profilesList();
    const s = envelope.settings;
    persisted = {
      enabled: s.overlayEnabled === true,
      hotkeyLetter: typeof s.overlayHotkeyLetter === 'string'
        && /^[A-Za-z]$/.test(s.overlayHotkeyLetter)
        ? s.overlayHotkeyLetter
        : 'O',
      position: isValidOverlayPosition(s.overlayPosition) ? s.overlayPosition : 'top-left',
      scale: clampOverlayScale(s.overlayScale),
      color: isValidOverlayColor(s.overlayColor) ? s.overlayColor : '#ffffff',
      stats: Array.isArray(s.overlayStats) ? s.overlayStats : [...OVERLAY_STATS_DEFAULT],
      // M24: the overlay theme (absent on old files -> 'arc' - the redesign
      // IS the product default; 'classic' stays one click away).
      theme: isValidOverlayTheme(s.overlayTheme) ? s.overlayTheme : OVERLAY_THEME_DEFAULT,
      // M7b (fix 4): the background box defaults (off / black / 0.5).
      bgEnabled: s.overlayBgEnabled === true,
      bgColor: isValidOverlayColor(s.overlayBgColor) ? s.overlayBgColor : '#000000',
      bgOpacity: clampOverlayBgOpacity(s.overlayBgOpacity),
      // M17b: the chip-name row labels (absent on old files -> false).
      chipNames: s.overlayChipNames === true,
      // M17e: the polling-rate (absent on old files -> the 400 ms default
      // - M17g: the stock polling rate FLIPS 500 -> 400).
      pollMs: clampOverlayPollMs(s.overlayPollMs),
      // M23: the ADVANCED overlay (absent on old files -> off / 'P' /
      // 'right' - the same absent-field mechanism; NO scale key - the
      // panel is a fixed compact size).
      advEnabled: s.advancedOverlayEnabled === true,
      advHotkeyLetter: typeof s.advancedOverlayHotkeyLetter === 'string'
        && /^[A-Za-z]$/.test(s.advancedOverlayHotkeyLetter)
        ? s.advancedOverlayHotkeyLetter
        : 'P',
      advPosition: isValidAdvancedOverlayPosition(s.advancedOverlayPosition) ? s.advancedOverlayPosition : 'right',
    };
  } catch (err) {
    clear(root);
    root.append(el('p', { class: 'text-error', text: `Could not load settings: ${err instanceof Error ? err.message : String(err)}` }));
    return;
  }
  try {
    overlayState = await api.overlayGetState();
  } catch { /* the cards degrade to the persisted state */ }
  // M23: the advanced panel's live state - the Advanced card re-queries it
  // on EVERY render (the register-failure note must never go stale - the
  // second hotkey seam's live flag).
  let advancedOverlayState: AdvancedOverlayState | null = null;
  try {
    advancedOverlayState = await api.advancedOverlayGetState();
  } catch { /* the card degrades to the persisted state */ }

  const refresh = async (): Promise<void> => {
    try {
      overlayState = await api.overlayGetState();
    } catch { /* keep the last known overlay state */ }
    try {
      advancedOverlayState = await api.advancedOverlayGetState();
    } catch { /* keep the last known panel state */ }
    render();
  };

  const render = (): void => {
    // M17e: the polling-rate slider's live value label (declared before the
    // General card - the scale-slider pattern).
    const pollMsValue = el('span', { class: 'settings-poll-ms-value', text: `${persisted.pollMs} ms` });
    // --- General card (M6-amd3): the enable TOGGLE - moved here from the
    // Settings page (the Settings card is button-only now). The
    // .settings-checkbox[data-setting="overlayEnabled"] class + dataset
    // are KEPT so the ui-verify toggle pins moved with the control.
    const generalCard = el('section', { class: 'card settings-card overlay-general-card' }, [
      el('h2', { class: 'card-title', text: 'General' }),
      el('div', { class: 'settings-row' }, [
        el('label', { class: 'boot-toggle' }, [
          el('input', {
            type: 'checkbox',
            class: 'settings-checkbox',
            dataset: { setting: 'overlayEnabled' },
            checked: persisted.enabled,
            onchange: (ev: Event) => void onOverlayEnabledToggle((ev.target as HTMLInputElement).checked),
          }),
          el('span', { text: 'Show the overlay' }),
        ]),
      ]),
      // M25: the "Show Advanced Overlay" toggle moved here from the
      // Hotkey card (the AMD-Adrenaline-style side panel).
      el('div', { class: 'settings-row' }, [
        el('label', { class: 'boot-toggle' }, [
          el('input', {
            type: 'checkbox',
            class: 'settings-checkbox',
            dataset: { setting: 'advancedOverlayEnabled' },
            checked: persisted.advEnabled,
            onchange: (ev: Event) => void onAdvancedEnabledToggle((ev.target as HTMLInputElement).checked),
          }),
          el('span', { text: 'Show Advanced Overlay' }),
        ]),
      ]),
      // M17b: the chip-name row labels - the overlayEnabled/overlayBgEnabled
      // checkbox pattern (NOT the per-stat .overlay-stat-toggle hook; the
      // ui-verify pin queries [data-setting="overlayChipNames"]).
      el('div', { class: 'settings-row' }, [
        el('label', { class: 'boot-toggle' }, [
          el('input', {
            type: 'checkbox',
            class: 'settings-checkbox',
            dataset: { setting: 'overlayChipNames' },
            checked: persisted.chipNames,
            onchange: (ev: Event) => void onChipNamesToggle((ev.target as HTMLInputElement).checked),
          }),
          el('span', { text: 'Use chip names instead of the CPU / GPU labels' }),
        ]),
      ]),
      // M17e (the user addition - "current 500 ms is a bit slow" - M17g:
      // the stock polling rate is now 400 ms): the
      // POLLING-RATE slider - the overlay's telemetry push cadence. The
      // scale-slider pattern (a live ms value label; the change saves
      // through profiles-settings-save and main's reaction RESTARTS the
      // telemetry push with the new interval - a live change, never a
      // next-boot-only one).
      el('div', { class: 'settings-row overlay-poll-ms-row' }, [
        el('span', { class: 'settings-row-label', text: 'Refresh rate' }),
        el('input', {
          type: 'range',
          class: 'settings-poll-ms-slider',
          dataset: { setting: 'overlayPollMs' },
          min: String(OVERLAY_POLL_MS_MIN),
          max: String(OVERLAY_POLL_MS_MAX),
          step: '50',
          value: String(persisted.pollMs),
          oninput: (ev: Event) => {
            const v = Number((ev.target as HTMLInputElement).value);
            pollMsValue.textContent = `${v} ms`;
          },
          onchange: (ev: Event) => void onPollMsChange(Number((ev.target as HTMLInputElement).value)),
        }),
        pollMsValue,
      ]),
    ]);

    // --- Stats card: one tickbox per stat id (data-stat-id; the persisted
    // overlayStats round-trips through profiles-settings-save). The
    // frametime id is NOT a line - it drives the canvas strip visibility.
    // M25: Select All / Hide All buttons + compact stat grid sorted by
    // category (CPU / RAM / GPU / VRAM / FPS / API).
    const onSelectAll = async (): Promise<void> => {
      const all = [...OVERLAY_STAT_IDS];
      if (all.join(',') === persisted.stats.join(',')) return;
      try {
        await api.profilesSettingsSave({ overlayStats: all });
        persisted.stats = all;
        render();
        toast('success', 'All stats shown', '');
      } catch (err) {
        toast('error', 'Overlay stats could not be changed', err instanceof Error ? err.message : String(err));
      }
    };
    const onHideAll = async (): Promise<void> => {
      if (persisted.stats.length === 0) return;
      try {
        await api.profilesSettingsSave({ overlayStats: [] });
        persisted.stats = [];
        render();
        toast('info', 'All stats hidden', '');
      } catch (err) {
        toast('error', 'Overlay stats could not be changed', err instanceof Error ? err.message : String(err));
      }
    };
    const statsCard = el('section', { class: 'card settings-card overlay-stats-card' }, [
      el('h2', { class: 'card-title', text: 'Stats' }),
      el('div', { class: 'overlay-stat-actions' }, [
        el('button', { class: 'btn btn-sm btn-ghost', text: 'Select all', onClick: () => void onSelectAll() }),
        el('button', { class: 'btn btn-sm btn-ghost', text: 'Hide all', onClick: () => void onHideAll() }),
      ]),
      el('div', { class: 'overlay-stat-grid' }, OVERLAY_STAT_IDS.map((id) =>
        el('label', { class: 'boot-toggle overlay-stat-toggle' }, [
          el('input', {
            type: 'checkbox',
            class: 'settings-checkbox overlay-stat-checkbox',
            dataset: { statId: id },
            checked: persisted.stats.includes(id),
            onchange: (ev: Event) => void onStatToggle(id, (ev.target as HTMLInputElement).checked),
          }),
          el('span', { text: OVERLAY_STAT_LABELS[id] }),
        ]),
      )),
    ]);

    // --- Appearance card: the color swatch palette (the theme-option
    // pattern - button[data-color-option="#..."]; the chips are
    // CLASS-driven swatch chips, CSP-safe) + the custom hex input
    // (type=color - a plain value applied via CSSOM, never an inline
    // style) + the SIZE slider (the existing overlayScale).
    // M24: the THEME row sits at the TOP of the card (the swatch-button
    // pattern - two buttons button[data-overlay-theme-option="classic"|"arc"],
    // the .active class on the persisted one). The switch saves through
    // profiles-settings-save ({ overlayTheme }); main's onOverlaySettings
    // then applies + pushes 'overlay:settings' so the HUD re-renders
    // immediately (the overlayChanged loop carries the theme key).
    const themeOptions = OVERLAY_THEMES.map((t) =>
      el('button', {
        type: 'button',
        class: `theme-option overlay-theme-option${persisted.theme === t ? ' active' : ''}`,
        dataset: { overlayThemeOption: t },
        title: t === 'arc' ? 'The Arc Power look - the Intel Arc harness' : 'The original HUD',
        onclick: () => void onThemeSelect(t),
      }, [
        el('span', { class: 'theme-option-name', text: t === 'arc' ? 'Arc' : 'Classic' }),
      ]),
    );
    const colorOptions = OVERLAY_COLOR_PRESETS.map((hex) =>
      el('button', {
        type: 'button',
        class: `theme-option overlay-color-option${persisted.color.toLowerCase() === hex ? ' active' : ''}`,
        dataset: { colorOption: hex },
        title: OVERLAY_COLOR_LABELS[hex],
        onclick: () => void onColorSelect(hex),
      }, [
        el('span', { class: `swatch-chip overlay-swatch-${hex.replace('#', '')}` }),
        el('span', { class: 'theme-option-name', text: OVERLAY_COLOR_LABELS[hex] }),
      ]),
    );
    const customColor = el('input', {
      type: 'color',
      class: 'settings-color-input',
      value: persisted.color,
      title: 'Custom overlay color',
      onchange: (ev: Event) => void onColorSelect((ev.target as HTMLInputElement).value),
    });
    const scaleValue = el('span', { class: 'settings-scale-value', text: `${persisted.scale.toFixed(2)}x` });
    // M7b (fix 4): the Background section - the box toggle, the color
    // swatches + custom hex (the overlay-color-option pattern, but
    // data-bg-color-option) + the 0-100 opacity slider (the scale-slider
    // pattern with a live value label). Every control saves through
    // profiles-settings-save; main's onOverlaySettings then applies +
    // pushes 'overlay:settings' so the box re-renders immediately.
    const bgColorOptions = OVERLAY_COLOR_PRESETS.map((hex) =>
      el('button', {
        type: 'button',
        class: `theme-option overlay-bg-color-option${persisted.bgColor.toLowerCase() === hex ? ' active' : ''}`,
        dataset: { bgColorOption: hex },
        title: OVERLAY_COLOR_LABELS[hex],
        onclick: () => void onBgColorSelect(hex),
      }, [
        el('span', { class: `swatch-chip overlay-swatch-${hex.replace('#', '')}` }),
        el('span', { class: 'theme-option-name', text: OVERLAY_COLOR_LABELS[hex] }),
      ]),
    );
    const customBgColor = el('input', {
      type: 'color',
      class: 'settings-color-input settings-bg-color-input',
      value: persisted.bgColor,
      title: 'Custom background color',
      onchange: (ev: Event) => void onBgColorSelect((ev.target as HTMLInputElement).value),
    });
    const bgOpacityValue = el('span', { class: 'settings-bg-opacity-value', text: `${Math.round(persisted.bgOpacity * 100)}%` });
    // M9: the position select moves into the Appearance card (the
    // standalone Position card is REMOVED - the same row pattern as the
    // Size row; the .settings-position-select class survives).
    const positionSelect = el('select', {
      class: 'settings-position-select',
      onchange: (ev: Event) => void onPositionChange((ev.target as HTMLSelectElement).value),
    }, OVERLAY_POSITIONS.map((p) => el('option', { value: p, text: OVERLAY_POSITION_LABELS[p] })));
    positionSelect.value = persisted.position;
    const appearanceCard = el('section', { class: 'card settings-card overlay-appearance-card' }, [
      el('h2', { class: 'card-title', text: 'Appearance' }),
      el('div', { class: 'settings-row overlay-theme-row' }, [
        el('span', { class: 'settings-row-label', text: 'Theme' }),
        el('div', { class: 'chips overlay-theme-options' }, themeOptions),
      ]),
      el('div', { class: 'overlay-color-options' }, [
        ...colorOptions,
        el('label', { class: 'overlay-custom-color' }, [
          el('span', { class: 'settings-row-label', text: 'Custom' }),
          customColor,
        ]),
      ]),
      el('div', { class: 'settings-row overlay-scale-row' }, [
        el('span', { class: 'settings-row-label', text: 'Size' }),
        el('input', {
          type: 'range',
          class: 'settings-scale-slider',
          min: 0.5,
          max: 2,
          step: 0.05,
          value: String(persisted.scale),
          oninput: (ev: Event) => {
            const v = Number((ev.target as HTMLInputElement).value);
            scaleValue.textContent = `${v.toFixed(2)}x`;
          },
          onchange: (ev: Event) => void onScaleChange(Number((ev.target as HTMLInputElement).value)),
        }),
        scaleValue,
      ]),
      // M9: the Position row - the old standalone Position card's select
      // lives here now (the same settings-row pattern as the Size row).
      el('div', { class: 'settings-row overlay-position-row' }, [
        el('span', { class: 'settings-row-label', text: 'Position' }),
        positionSelect,
      ]),
      // M7b (fix 4) / M25: the Background section - hidden when the Arc
      // theme is selected (Arc has its own built-in chrome; background box
      // is a Classic-only option).
      ...(persisted.theme === 'classic' ? [
        el('div', { class: 'settings-row overlay-bg-row' }, [
          el('label', { class: 'boot-toggle' }, [
            el('input', {
              type: 'checkbox',
              class: 'settings-checkbox',
              dataset: { setting: 'overlayBgEnabled' },
              checked: persisted.bgEnabled,
              onchange: (ev: Event) => void onBgEnabledToggle((ev.target as HTMLInputElement).checked),
            }),
            el('span', { text: 'Show a background box' }),
          ]),
        ]),
        el('div', { class: 'overlay-bg-options' }, [
          ...bgColorOptions,
          el('label', { class: 'overlay-custom-color' }, [
            el('span', { class: 'settings-row-label', text: 'Custom' }),
            customBgColor,
          ]),
        ]),
        el('div', { class: 'settings-row overlay-bg-row' }, [
          el('span', { class: 'settings-row-label', text: 'Opacity' }),
          el('input', {
            type: 'range',
            class: 'settings-bg-opacity-slider',
            min: 0,
            max: 100,
            step: 1,
            value: String(Math.round(persisted.bgOpacity * 100)),
            oninput: (ev: Event) => {
              const v = Number((ev.target as HTMLInputElement).value);
              bgOpacityValue.textContent = `${v}%`;
            },
            onchange: (ev: Event) => void onBgOpacityChange(Number((ev.target as HTMLInputElement).value)),
          }),
          bgOpacityValue,
        ]),
      ] : []),
    ]);

    // M25: the Hotkey + Advanced cards are MERGED into a single "Hotkey"
    // card. The overlay hotkey (CTRL + letter) and the advanced overlay
    // hotkey (CTRL + letter) + edge select live in one compact card.
    const hotkeyInput = el('input', {
      type: 'text',
      class: 'settings-hotkey-input',
      maxlength: 1,
      value: persisted.hotkeyLetter.toUpperCase(),
      title: 'The overlay hotkey letter (CTRL + <letter>)',
      oninput: (ev: Event) => {
        const t = ev.target as HTMLInputElement;
        const m = t.value.match(/[A-Za-z]/);
        t.value = m ? m[m.length - 1].toUpperCase() : '';
      },
      onchange: (ev: Event) => void onHotkeyLetterChange((ev.target as HTMLInputElement).value),
    });
    const advancedHotkeyInput = el('input', {
      type: 'text',
      class: 'settings-hotkey-input settings-advanced-hotkey-input',
      maxlength: 1,
      value: persisted.advHotkeyLetter.toUpperCase(),
      title: 'The advanced overlay hotkey letter (CONTROL + <letter>)',
      oninput: (ev: Event) => {
        const t = ev.target as HTMLInputElement;
        const m = t.value.match(/[A-Za-z]/);
        t.value = m ? m[m.length - 1].toUpperCase() : '';
      },
      onchange: (ev: Event) => void onAdvancedHotkeyLetterChange((ev.target as HTMLInputElement).value),
    });
    const advancedPositionSelect = el('select', {
      class: 'settings-position-select settings-advanced-position-select',
      onchange: (ev: Event) => void onAdvancedPositionChange((ev.target as HTMLSelectElement).value),
    }, ADVANCED_OVERLAY_POSITIONS.map((p) => el('option', { value: p, text: ADVANCED_OVERLAY_POSITION_LABELS[p] })));
    advancedPositionSelect.value = persisted.advPosition;
    // M25: "Show Advanced Overlay" toggle moved to the General card.
    const hotkeyCard = el('section', { class: 'card settings-card overlay-hotkey-card' }, [
      el('h2', { class: 'card-title', text: 'Hotkey' }),
      el('div', { class: 'settings-row overlay-hotkey-row' }, [
        el('span', { class: 'settings-row-label', text: 'HUD' }),
        el('span', { class: 'overlay-hotkey-fixed', text: 'CTRL +' }),
        hotkeyInput,
      ]),
      overlayState && overlayState.exists && overlayState.hotkeyRegistered === false
        ? el('p', { class: 'card-note boot-hint overlay-hotkey-fail', text: `The CTRL + ${persisted.hotkeyLetter.toUpperCase()} hotkey could not be registered - another application may be using it.` })
        : null,
      el('hr', { class: 'overlay-hotkey-divider' }),
      el('div', { class: 'settings-row overlay-advanced-hotkey-row' }, [
        el('span', { class: 'settings-row-label', text: 'Panel' }),
        el('span', { class: 'overlay-hotkey-fixed', text: 'CTRL +' }),
        advancedHotkeyInput,
      ]),
      el('div', { class: 'settings-row overlay-advanced-position-row' }, [
        el('span', { class: 'settings-row-label', text: 'Edge' }),
        advancedPositionSelect,
      ]),
      advancedOverlayState && advancedOverlayState.exists && advancedOverlayState.hotkeyRegistered === false
        ? el('p', { class: 'card-note boot-hint overlay-hotkey-fail', text: `The CTRL + ${persisted.advHotkeyLetter.toUpperCase()} hotkey could not be registered - another application may be using it.` })
        : null,
    ]);

    clear(root);
    root.append(generalCard, statsCard, appearanceCard, hotkeyCard);
  };

  // --- M6 handlers (every save goes through profiles-settings-save;
  // main's onOverlaySettings then applies + pushes 'overlay:settings' to
  // the overlay window so the HUD re-renders immediately).

  // M6-amd3: the enable toggle (moved from the Settings page; the same
  // read-modify-write save + the honest error revert).
  const onOverlayEnabledToggle = async (checked: boolean): Promise<void> => {
    const box = root.querySelector<HTMLInputElement>('.settings-checkbox[data-setting="overlayEnabled"]');
    try {
      await api.profilesSettingsSave({ overlayEnabled: checked });
      persisted.enabled = checked;
      toast(checked ? 'success' : 'info', checked ? 'Overlay enabled' : 'Overlay disabled', '');
    } catch (err) {
      toast('error', 'Overlay could not be changed', err instanceof Error ? err.message : String(err));
      if (box) box.checked = persisted.enabled;
      return;
    }
  };

  // M17b: the chip-name row labels toggle (the same profiles-settings-save
  // pattern as the enable toggle - the honest error revert on failure).
  const onChipNamesToggle = async (checked: boolean): Promise<void> => {
    const box = root.querySelector<HTMLInputElement>('.settings-checkbox[data-setting="overlayChipNames"]');
    try {
      await api.profilesSettingsSave({ overlayChipNames: checked });
      persisted.chipNames = checked;
      toast(checked ? 'success' : 'info', checked ? 'Chip names shown' : 'Stock labels restored', '');
    } catch (err) {
      toast('error', 'Chip names could not be changed', err instanceof Error ? err.message : String(err));
      if (box) box.checked = persisted.chipNames;
      return;
    }
  };

  // M17e (the user addition): the polling-rate slider - the same
  // profiles-settings-save pattern as the scale/opacity handlers (the
  // clamped value + the honest error revert; main's reaction restarts the
  // telemetry push with the new interval - the live restart).
  const onPollMsChange = async (ms: number): Promise<void> => {
    const clamped = clampOverlayPollMs(ms);
    if (clamped === persisted.pollMs) return;
    const slider = root.querySelector<HTMLInputElement>('.settings-poll-ms-slider');
    const label = root.querySelector<HTMLElement>('.settings-poll-ms-value');
    try {
      await api.profilesSettingsSave({ overlayPollMs: clamped });
      persisted.pollMs = clamped;
      toast('success', 'Overlay refresh rate changed', `The overlay reads every ${clamped} ms now.`);
    } catch (err) {
      toast('error', 'Overlay refresh rate could not be changed', err instanceof Error ? err.message : String(err));
      if (slider) slider.value = String(persisted.pollMs);
      if (label) label.textContent = `${persisted.pollMs} ms`;
      return;
    }
  };

  const onStatToggle = async (statId: string, checked: boolean): Promise<void> => {
    const box = root.querySelector<HTMLInputElement>(`.overlay-stat-checkbox[data-stat-id="${statId}"]`);
    const next = checked
      ? (persisted.stats.includes(statId) ? persisted.stats : [...persisted.stats, statId])
      : persisted.stats.filter((id) => id !== statId);
    if (next.join(',') === persisted.stats.join(',')) return;
    try {
      await api.profilesSettingsSave({ overlayStats: next });
      persisted.stats = next;
      toast(checked ? 'success' : 'info', `Overlay ${OVERLAY_STAT_LABELS[statId]} ${checked ? 'shown' : 'hidden'}`, '');
    } catch (err) {
      toast('error', 'Overlay stats could not be changed', err instanceof Error ? err.message : String(err));
      if (box) box.checked = persisted.stats.includes(statId);
      return;
    }
  };

  const syncColorSwatches = (hex: string): void => {
    root.querySelectorAll<HTMLElement>('.overlay-color-option').forEach((b) => {
      b.classList.toggle('active', (b.dataset.colorOption ?? '').toLowerCase() === hex.toLowerCase());
    });
    const custom = root.querySelector<HTMLInputElement>('.settings-color-input');
    if (custom && custom.value.toLowerCase() !== hex.toLowerCase()) custom.value = hex;
  };

  // M24: the theme row handler - the same profiles-settings-save pattern as
  // the color handler (toast + the .active class flip; the overlay itself
  // re-renders on the push - the save + the push are one main-side flow).
  const syncThemeButtons = (theme: string): void => {
    root.querySelectorAll<HTMLElement>('.overlay-theme-option').forEach((b) => {
      b.classList.toggle('active', b.dataset.overlayThemeOption === theme);
    });
  };

  const onThemeSelect = async (theme: string): Promise<void> => {
    if (!isValidOverlayTheme(theme) || theme === persisted.theme) return;
    const previous = persisted.theme;
    syncThemeButtons(theme);
    persisted.theme = theme;
    // M25: re-render so the background section hides/shows (Arc has its
    // own chrome; background box is Classic-only).
    render();
    try {
      await api.profilesSettingsSave({ overlayTheme: theme });
      toast('success', 'Overlay theme changed', theme === 'arc' ? 'The Arc look is active.' : 'The classic HUD is active.');
    } catch (err) {
      toast('error', 'Overlay theme could not be changed', err instanceof Error ? err.message : String(err));
      persisted.theme = previous;
      syncThemeButtons(previous);
      render();
    }
  };

  const onColorSelect = async (hex: string): Promise<void> => {
    if (!isValidOverlayColor(hex)) {
      toast('error', 'Overlay color', 'The color must be a 6-digit hex value (like #ffffff).');
      return;
    }
    const normalized = hex.toLowerCase();
    if (normalized === persisted.color.toLowerCase()) return;
    const previous = persisted.color;
    // Apply the swatch highlight immediately - the overlay itself
    // re-renders on the push (the save + the push are one main-side flow).
    syncColorSwatches(normalized);
    persisted.color = normalized;
    try {
      await api.profilesSettingsSave({ overlayColor: normalized });
      toast('success', 'Overlay color changed', `${OVERLAY_COLOR_LABELS[normalized] ?? 'Custom'} - the overlay text updates immediately.`);
    } catch (err) {
      toast('error', 'Overlay color could not be changed', err instanceof Error ? err.message : String(err));
      persisted.color = previous;
      syncColorSwatches(previous);
    }
  };

  const onScaleChange = async (scale: number): Promise<void> => {
    const clamped = clampOverlayScale(scale);
    if (clamped === persisted.scale) return;
    const slider = root.querySelector<HTMLInputElement>('.settings-scale-slider');
    try {
      await api.profilesSettingsSave({ overlayScale: clamped });
      persisted.scale = clamped;
      toast('success', 'Overlay size changed', 'The overlay resizes immediately.');
    } catch (err) {
      toast('error', 'Overlay size could not be changed', err instanceof Error ? err.message : String(err));
      if (slider) slider.value = String(persisted.scale);
      return;
    }
  };

  // M7b (fix 4): the Background section handlers - the same
  // profiles-settings-save pattern as the color/scale handlers (toast +
  // revert on error); main's onOverlaySettings re-applies + pushes so the
  // box re-renders immediately.
  const onBgEnabledToggle = async (checked: boolean): Promise<void> => {
    const box = root.querySelector<HTMLInputElement>('.settings-checkbox[data-setting="overlayBgEnabled"]');
    try {
      await api.profilesSettingsSave({ overlayBgEnabled: checked });
      persisted.bgEnabled = checked;
      toast(checked ? 'success' : 'info', checked ? 'Background box shown' : 'Background box hidden', '');
    } catch (err) {
      toast('error', 'Background box could not be changed', err instanceof Error ? err.message : String(err));
      if (box) box.checked = persisted.bgEnabled;
      return;
    }
  };

  const syncBgColorSwatches = (hex: string): void => {
    root.querySelectorAll<HTMLElement>('.overlay-bg-color-option').forEach((b) => {
      b.classList.toggle('active', (b.dataset.bgColorOption ?? '').toLowerCase() === hex.toLowerCase());
    });
    const custom = root.querySelector<HTMLInputElement>('.settings-bg-color-input');
    if (custom && custom.value.toLowerCase() !== hex.toLowerCase()) custom.value = hex;
  };

  const onBgColorSelect = async (hex: string): Promise<void> => {
    if (!isValidOverlayColor(hex)) {
      toast('error', 'Background color', 'The color must be a 6-digit hex value (like #000000).');
      return;
    }
    const normalized = hex.toLowerCase();
    if (normalized === persisted.bgColor.toLowerCase()) return;
    const previous = persisted.bgColor;
    syncBgColorSwatches(normalized);
    persisted.bgColor = normalized;
    try {
      await api.profilesSettingsSave({ overlayBgColor: normalized });
      toast('success', 'Background color changed', `${OVERLAY_COLOR_LABELS[normalized] ?? 'Custom'} - the box updates immediately.`);
    } catch (err) {
      toast('error', 'Background color could not be changed', err instanceof Error ? err.message : String(err));
      persisted.bgColor = previous;
      syncBgColorSwatches(previous);
    }
  };

  const onBgOpacityChange = async (pct: number): Promise<void> => {
    const clamped = clampOverlayBgOpacity(pct / 100);
    if (clamped === persisted.bgOpacity) return;
    const slider = root.querySelector<HTMLInputElement>('.settings-bg-opacity-slider');
    const label = root.querySelector<HTMLElement>('.settings-bg-opacity-value');
    try {
      await api.profilesSettingsSave({ overlayBgOpacity: clamped });
      persisted.bgOpacity = clamped;
      toast('success', 'Background opacity changed', `${Math.round(clamped * 100)}% - the box updates immediately.`);
    } catch (err) {
      toast('error', 'Background opacity could not be changed', err instanceof Error ? err.message : String(err));
      if (slider) slider.value = String(Math.round(persisted.bgOpacity * 100));
      if (label) label.textContent = `${Math.round(persisted.bgOpacity * 100)}%`;
      return;
    }
  };

  const onPositionChange = async (position: string): Promise<void> => {
    if (!isValidOverlayPosition(position) || position === persisted.position) return;
    const select = root.querySelector<HTMLSelectElement>('.settings-position-select');
    try {
      await api.profilesSettingsSave({ overlayPosition: position });
      persisted.position = position;
      toast('success', 'Overlay position changed', `${OVERLAY_POSITION_LABELS[position]} - the overlay moves immediately.`);
    } catch (err) {
      toast('error', 'Overlay position could not be changed', err instanceof Error ? err.message : String(err));
      if (select) select.value = persisted.position;
      return;
    }
  };

  const onHotkeyLetterChange = async (letter: string): Promise<void> => {
    const input = root.querySelector<HTMLInputElement>('.settings-hotkey-input');
    const v = letter.trim().toUpperCase();
    if (!/^[A-Za-z]$/.test(v)) {
      toast('error', 'Overlay hotkey', 'The hotkey must be a single letter (CTRL + <letter>).');
      if (input) input.value = persisted.hotkeyLetter.toUpperCase();
      return;
    }
    try {
      await api.profilesSettingsSave({ overlayHotkeyLetter: v });
      persisted.hotkeyLetter = v;
      toast('success', 'Overlay hotkey changed', `The overlay toggles with CTRL + ${v}.`);
    } catch (err) {
      toast('error', 'Overlay hotkey could not be changed', err instanceof Error ? err.message : String(err));
      if (input) input.value = persisted.hotkeyLetter.toUpperCase();
      return;
    }
    // The register-failure note must follow the live registration state
    // (the letter save re-registers through main's hotkey seam).
    await refresh();
  };

  // --- M23: the ADVANCED card handlers (the same profiles-settings-save
  // pattern as the HUD card - the honest revert on error). The COLLISION
  // RULE is enforced BOTH in the renderer (the toast below) AND at the
  // ENVELOPE (ipc-core rejects a patch whose advanced letter equals the HUD
  // letter - and symmetrically a HUD letter equal to the advanced one). The
  // envelope's rejection surfaces here as the honest toast + input revert.

  const onAdvancedEnabledToggle = async (checked: boolean): Promise<void> => {
    const box = root.querySelector<HTMLInputElement>('.settings-checkbox[data-setting="advancedOverlayEnabled"]');
    try {
      await api.profilesSettingsSave({ advancedOverlayEnabled: checked });
      persisted.advEnabled = checked;
      toast(checked ? 'success' : 'info', checked ? 'Advanced overlay enabled' : 'Advanced overlay disabled', '');
    } catch (err) {
      toast('error', 'Advanced overlay could not be changed', err instanceof Error ? err.message : String(err));
      if (box) box.checked = persisted.advEnabled;
      return;
    }
  };

  const onAdvancedPositionChange = async (position: string): Promise<void> => {
    if (!isValidAdvancedOverlayPosition(position) || position === persisted.advPosition) return;
    const select = root.querySelector<HTMLSelectElement>('.settings-advanced-position-select');
    try {
      await api.profilesSettingsSave({ advancedOverlayPosition: position });
      persisted.advPosition = position;
      toast('success', 'Advanced overlay edge changed', `${ADVANCED_OVERLAY_POSITION_LABELS[position]} - the panel moves immediately.`);
    } catch (err) {
      toast('error', 'Advanced overlay edge could not be changed', err instanceof Error ? err.message : String(err));
      if (select) select.value = persisted.advPosition;
      return;
    }
  };

  const onAdvancedHotkeyLetterChange = async (letter: string): Promise<void> => {
    const input = root.querySelector<HTMLInputElement>('.settings-advanced-hotkey-input');
    const v = letter.trim().toUpperCase();
    if (!/^[A-Za-z]$/.test(v)) {
      toast('error', 'Advanced overlay hotkey', 'The hotkey must be a single letter (CONTROL + <letter>).');
      if (input) input.value = persisted.advHotkeyLetter.toUpperCase();
      return;
    }
    try {
      await api.profilesSettingsSave({ advancedOverlayHotkeyLetter: v });
      persisted.advHotkeyLetter = v;
      toast('success', 'Advanced overlay hotkey changed', `The panel toggles with CONTROL + ${v}.`);
    } catch (err) {
      toast('error', 'Advanced overlay hotkey could not be changed', err instanceof Error ? err.message : String(err));
      if (input) input.value = persisted.advHotkeyLetter.toUpperCase();
      return;
    }
    // The register-failure note must follow the live registration state
    // (the letter save re-registers through main's second hotkey seam).
    await refresh();
  };

  render();
}
