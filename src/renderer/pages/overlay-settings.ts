// Arc Power - M6 the Overlay Settings page (#/overlay): the destination of
// the Settings card's "Overlay settings" button. M6-amd3 (the user's
// amendment): the page ALSO owns the enable TOGGLE now - the General card
// at the top (the Settings card is button-only); everything else:
//   - Stats - the 14 stat TICKBOXES (the Monitoring-tab-tickbox idea,
//     landed here): FPS + the M7a 1% Low / 99% FPS row stats, CPU
//     Util/Clock/Temp, GPU Util/Core clock/Mem clock/VRAM/Temp/Wattage/Fan
//     + the Frametime graph. Persisted as overlayStats (string[], default =
//     ALL - the stock set);
//   - Appearance - the COLORS (a swatch palette - the theme-option pattern:
//     white (stock), yellow, green, cyan, orange, red, magenta + a custom
//     hex input (type=color - a plain value applied via CSSOM, CSP-safe))
//     + the SIZE slider (the existing overlayScale);
//   - Position - the 4 corners;
//   - Hotkey - the letter input (CTRL + fixed - the letter is the only
//     changeable part) + the register-failure note + the get-state re-query
//     on every render (the Settings-card pattern - the honest note never
//     goes stale);
//   - the honest notes at the bottom (topmost/MPO + the FPS/frametime data
//     sources).
//
// The page KEEPS the Settings card's class names (.settings-hotkey-input,
// .settings-position-select, .settings-scale-slider, ...) - the ui-verify
// selectors survived the move (the (g) register-failure block runs against
// THIS page's DOM). The General card's toggle KEEPS the
// .settings-checkbox[data-setting="overlayEnabled"] class + dataset so the
// toggle pins moved with the control too.

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { api } from '../ipc.ts';
import { toast } from '../components/toast.ts';
import {
  OVERLAY_POSITIONS,
  OVERLAY_POSITION_LABELS,
  OVERLAY_STAT_IDS,
  OVERLAY_STAT_LABELS,
  OVERLAY_COLOR_PRESETS,
  OVERLAY_COLOR_LABELS,
  isValidOverlayPosition,
  isValidOverlayColor,
  clampOverlayScale,
} from '../pure/overlay.ts';
import type { OverlayPosition, OverlayState } from '../types.ts';

export const overlaySettingsPage: Page = {
  id: 'overlay',

  render(container: HTMLElement, ctx: PageContext) {
    clear(container);
    container.append(
      el('h1', { class: 'page-title', text: 'Overlay Settings' }),
      el('p', {
        class: 'page-subtitle',
        text: 'The in-game style HUD (bold text floating over the screen - no boxes, no window). Everything lives here: the enable toggle, which stats show, the text color, the size, the corner and the hotkey letter.',
      }),
      el('div', { id: 'overlay-settings-root', class: 'overlay-settings-root' }, [el('p', { class: 'page-subtitle', text: 'Loading settings…' })]),
    );
    void mount(ctx, container);
  },
};

interface PersistedOverlay {
  enabled: boolean;
  hotkeyLetter: string;
  position: OverlayPosition;
  scale: number;
  color: string;
  stats: string[];
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
      stats: Array.isArray(s.overlayStats) ? s.overlayStats : [...OVERLAY_STAT_IDS],
    };
  } catch (err) {
    clear(root);
    root.append(el('p', { class: 'text-error', text: `Could not load settings: ${err instanceof Error ? err.message : String(err)}` }));
    return;
  }
  try {
    overlayState = await api.overlayGetState();
  } catch { /* the cards degrade to the persisted state */ }

  const refresh = async (): Promise<void> => {
    try {
      overlayState = await api.overlayGetState();
    } catch { /* keep the last known overlay state */ }
    render();
  };

  const render = (): void => {
    // --- General card (M6-amd3): the enable TOGGLE - moved here from the
    // Settings page (the Settings card is button-only now). The
    // .settings-checkbox[data-setting="overlayEnabled"] class + dataset
    // are KEPT so the ui-verify toggle pins moved with the control.
    const generalCard = el('section', { class: 'card settings-card overlay-general-card' }, [
      el('h2', { class: 'card-title', text: 'General' }),
      el('p', { class: 'card-note', text: 'Whether the overlay shows. The hotkey, the position, the size, the colors and the stats live below.' }),
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
    ]);

    // --- Stats card: one tickbox per stat id (data-stat-id; the persisted
    // overlayStats round-trips through profiles-settings-save). The
    // frametime id is NOT a line - it drives the canvas strip visibility.
    const statsCard = el('section', { class: 'card settings-card overlay-stats-card' }, [
      el('h2', { class: 'card-title', text: 'Stats' }),
      el('p', { class: 'card-note', text: 'Which readouts the overlay shows. Unchecking every stat of a line hides that line; the frametime strip hides with its own stat.' }),
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
    const appearanceCard = el('section', { class: 'card settings-card overlay-appearance-card' }, [
      el('h2', { class: 'card-title', text: 'Appearance' }),
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
    ]);

    // --- Position card: the 4 corners (the existing select).
    const positionSelect = el('select', {
      class: 'settings-position-select',
      onchange: (ev: Event) => void onPositionChange((ev.target as HTMLSelectElement).value),
    }, OVERLAY_POSITIONS.map((p) => el('option', { value: p, text: OVERLAY_POSITION_LABELS[p] })));
    positionSelect.value = persisted.position;
    const positionCard = el('section', { class: 'card settings-card overlay-position-card' }, [
      el('h2', { class: 'card-title', text: 'Position' }),
      el('div', { class: 'settings-row overlay-position-row' }, [
        el('span', { class: 'settings-row-label', text: 'Corner' }),
        positionSelect,
      ]),
    ]);

    // --- Hotkey card: the letter input (CTRL + FIXED - the user's rule:
    // the letter is the ONLY changeable part) + the honest
    // register-failure note (the get-state re-query on every render).
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
    const hotkeyCard = el('section', { class: 'card settings-card overlay-hotkey-card' }, [
      el('h2', { class: 'card-title', text: 'Hotkey' }),
      el('p', { class: 'card-note', text: `The overlay toggles with CTRL + <letter> anywhere - the letter is the only changeable part.` }),
      el('div', { class: 'settings-row overlay-hotkey-row' }, [
        el('span', { class: 'overlay-hotkey-fixed', text: 'CTRL +' }),
        hotkeyInput,
      ]),
      overlayState && overlayState.exists && overlayState.hotkeyRegistered === false
        ? el('p', { class: 'card-note boot-hint overlay-hotkey-fail', text: `The CTRL + ${persisted.hotkeyLetter.toUpperCase()} hotkey could not be registered - another application may be using it. The Show-the-overlay toggle above still works.` })
        : null,
    ]);

    // The honest limitations + data sources (moved from the Settings card
    // with the rest): the overlay is a standard topmost window - Windows
    // does not expose overlay-plane (MPO) assignment to apps, and an
    // exclusive-fullscreen game can cover it (tools like MSI Afterburner
    // inject into games to avoid this; Arc Power does not).
    const notesCard = el('section', { class: 'card settings-card overlay-notes-card' }, [
      el('h2', { class: 'card-title', text: 'Notes' }),
      el('p', { class: 'card-note overlay-note', text: 'The overlay is a standard topmost window - Windows does not expose overlay-plane (MPO) assignment to apps; exclusive-fullscreen games may cover it (tools like MSI Afterburner inject into games to avoid this; Arc Power does not).' }),
      el('p', { class: 'card-note overlay-note', text: 'FPS comes from the graphics-driver frame statistics (DXGI); the frametime line is derived from the frame rate when per-frame timing is unavailable. Unavailable readings show "-".' }),
    ]);

    clear(root);
    root.append(generalCard, statsCard, appearanceCard, positionCard, hotkeyCard, notesCard);
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

  render();
}
