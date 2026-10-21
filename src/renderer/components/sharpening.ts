import { api } from '../ipc.ts';
import { el } from '../dom.ts';
import { toast } from './toast.ts';
import { buildDropdown, type DropdownElement } from './dropdown.ts';
import type { ArcSuperResolutionState, ArcSuperResolutionValue, PostprocessSharpeningGame, PostprocessSharpeningGlobal, PostprocessSharpeningValue } from '../types.ts';

const safePercentage = (value: number): number => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

const sharpeningHelp = (text: string): HTMLElement => el('details', { class: 'sharpening-help' }, [
  el('summary', { text: 'How sharpening works' }),
  el('p', { class: 'card-note', text }),
]);

const makeSelect = (value: string, options: Array<{ value: string; label: string }>, onChange: (value: string) => void, ariaLabel: string): DropdownElement =>
  buildDropdown(value, options, { className: 'graphics-select sharpening-select', ariaLabel, onChange });

/** App-managed screen sharpening controls, kept outside the driver's graphics apply path. */
export function renderGlobalSharpening(): HTMLElement {
  const root = el('section', { class: 'card graphics-card sharpening-card' });
  let generation = 0;
  let state: PostprocessSharpeningGlobal | null = null;
  let draft: PostprocessSharpeningValue = { enabled: false, percentage: 50 };
  let latestRuntimeStatus: { active: boolean; reason?: string; mode?: 'asr' | 'sharpening' } | null = null;
  let busy = false;
  let error = '';

  const legacyWarning = (): HTMLElement[] => {
    if (state?.legacyManifestStatus === 'unreadable') {
      return [el('p', { class: 'profile-capability-note', text: `The previous game-folder sharpening manifest could not be checked (${state.legacyManifestPath ?? 'Arc Power AppData'}). Older integrations may remain. This build does not change game files.` })];
    }
    const games = state?.legacyIntegrations ?? [];
    if (!games.length) return [];
    const names = games.slice(0, 5).map((game) => game.exePath.split(/[\\/]/).pop() || game.exePath);
    const list = `${names.join(', ')}${games.length > names.length ? `, and ${games.length - names.length} more` : ''}`;
    return [el('p', { class: 'profile-capability-note', text: `The previous game-folder sharpening manifest still lists ${games.length} game(s): ${list}. It may affect these games while this switch is off or stack with the screen effect. This build does not change game files; remove the old integration with the previous Arc Power version while each game is closed before testing.` })];
  };
  const runtimeStatusText = (): string => state?.reason
    ?? (state?.active ? 'Sharpening is active on the foreground game.' : state?.runtimeReady ? 'Included with Arc Power · Applies only to recognized games.' : 'Sharpening is unavailable on this system.');

  const render = (): void => {
    const request = generation;
    const slider = el('input', { type: 'range', class: 'graphics-slider', min: 0, max: 100, step: 1, value: draft.percentage, disabled: busy || !state || !draft.enabled,
      'aria-label': 'Arc Image Sharpening strength', 'aria-valuetext': `${draft.percentage}%`, oninput: (event: Event) => {
        draft.percentage = safePercentage((event.target as HTMLInputElement).valueAsNumber);
        const text = root.querySelector<HTMLElement>('.sharpening-value');
        if (text) text.textContent = `${draft.percentage}%`;
        (event.currentTarget as HTMLInputElement).setAttribute('aria-valuetext', `${draft.percentage}%`);
      } });
    const sliderRow = el('div', { class: 'graphics-fps-slider-row sharpening-slider-row', hidden: !draft.enabled }, [slider, el('span', { class: 'graphics-fps-value sharpening-value', text: `${draft.percentage}%` })]);
    const select = makeSelect(draft.enabled ? 'on' : 'off', [
      { value: 'off', label: 'Arc Image Sharpening Off' },
      { value: 'on', label: 'Arc Image Sharpening On' },
    ], (value) => {
      draft.enabled = value === 'on';
      sliderRow.hidden = !draft.enabled;
      slider.disabled = busy || !state || !draft.enabled;
    }, 'Arc Image Sharpening');
    select.disabled = busy || !state;
    const apply = async (): Promise<void> => {
      if (busy || !state) return;
      busy = true; error = ''; render();
      try {
        state = await api.postprocessSharpeningSet({ enabled: draft.enabled, percentage: draft.percentage });
        if (latestRuntimeStatus) state = { ...state, active: latestRuntimeStatus.active, reason: latestRuntimeStatus.reason };
        draft = { ...state.value };
      } catch (err) { error = err instanceof Error ? err.message : String(err); }
      finally { busy = false; if (request === generation && root.isConnected) render(); }
    };
    root.replaceChildren(
      el('div', { class: 'sharpening-card-heading' }, [
        el('div', { class: 'sharpening-card-copy' }, [el('h2', { class: 'card-title', text: 'Arc Image Sharpening' }), el('p', { class: 'card-note', text: 'Sharpens the foreground game on an Intel Arc display.' })]),
        el('div', { class: 'sharpening-card-control' }, [select, sliderRow]),
      ]),
      sharpeningHelp('Sharpens only the foreground game on a display connected to Intel Arc while Arc Power is open. Windowed, borderless, and fullscreen game windows are eligible; exclusive fullscreen capture can vary by game. No capture prompt, setup download, or game-folder files are used.'),
      ...legacyWarning(),
      el('p', { class: 'sharpening-runtime-status', text: state ? runtimeStatusText() : 'Loading sharpening settings…' }),
      ...(error ? [el('p', { class: 'text-error', text: error })] : []),
      el('div', { class: 'graphics-card-actions' }, [
        el('button', { class: 'btn btn-primary btn-sm', text: busy ? 'Applying…' : 'Apply', disabled: busy || !state, onclick: () => void apply() }),
        el('button', { class: 'btn btn-ghost btn-sm', text: 'Reset to default', disabled: busy || !state, onclick: () => { draft = { enabled: false, percentage: 50 }; render(); } }),
      ]),
    );
  };
  render();
  const request = ++generation;
  const unsubscribeStatus = api.onPostprocessSharpeningStatus((status) => {
    if (!root.isConnected || typeof status?.active !== 'boolean') return;
    latestRuntimeStatus = { active: status.active && status.mode !== 'asr', mode: status.mode, reason: typeof status.reason === 'string' ? status.reason : undefined };
    if (state) {
      state = { ...state, ...latestRuntimeStatus };
      const note = root.querySelector<HTMLElement>('.sharpening-runtime-status');
      if (note) note.textContent = runtimeStatusText();
    }
  });
  void api.postprocessSharpeningGet().then((value) => {
    if (request !== generation || !root.isConnected) return;
    state = latestRuntimeStatus ? { ...value, ...latestRuntimeStatus } : value;
    draft = { ...value.value }; render();
  }).catch((err: unknown) => {
    if (request !== generation || !root.isConnected) return;
    error = err instanceof Error ? err.message : String(err); render();
  });
  const detachObserver = new MutationObserver(() => {
    if (root.isConnected) return;
    unsubscribeStatus();
    detachObserver.disconnect();
  });
  detachObserver.observe(document.body, { childList: true, subtree: true });
  return root;
}

/** Spatial window-to-display upscaling; it does not call XeSS or driver graphics settings. */
export function renderArcSuperResolution(): HTMLElement {
  const root = el('section', { class: 'card graphics-card asr-card' });
  let generation = 0;
  let state: ArcSuperResolutionState | null = null;
  let draft: ArcSuperResolutionValue = { enabled: false };
  let latestStatus: { active: boolean; reason?: string; mode?: 'asr' | 'sharpening' } | null = null;
  let busy = false;
  let applied = false;
  let error = '';

  const runtimeStatusText = (): string => {
    if (state?.reason) return state.reason;
    if (state?.active) return 'Arc Super Resolution is active on the foreground game.';
    return state?.runtimeReady
      ? 'Waiting for a recognized game running in a smaller window on an Intel Arc display.'
      : 'Arc Super Resolution is unavailable on this system.';
  };

  const render = (): void => {
    const request = generation;
    const select = makeSelect(draft.enabled ? 'on' : 'off', [
      { value: 'off', label: 'Arc Super Resolution Off' },
      { value: 'on', label: 'Arc Super Resolution On' },
    ], (value) => {
      draft.enabled = value === 'on';
      applied = false;
      const button = root.querySelector<HTMLButtonElement>('.asr-apply');
      if (button) button.textContent = 'Apply';
    }, 'Arc Super Resolution');
    select.disabled = busy || !state;
    const apply = async (): Promise<void> => {
      if (busy || !state) return;
      busy = true; error = ''; render();
      try {
        state = await api.arcSuperResolutionSet({ enabled: draft.enabled });
        if (latestStatus) state = { ...state, active: latestStatus.active && latestStatus.mode === 'asr', reason: latestStatus.reason };
        draft = { ...state.value };
        applied = true;
        toast('success', 'Arc Super Resolution preference saved', state.value.enabled
          ? (state.active ? 'ASR is active on the foreground game.' : runtimeStatusText())
          : 'Arc Super Resolution is turned off.');
      } catch (err) {
        applied = false;
        error = err instanceof Error ? err.message : String(err);
        toast('error', 'Arc Super Resolution apply failed', error);
      }
      finally { busy = false; if (request === generation && root.isConnected) render(); }
    };
    root.replaceChildren(
      el('div', { class: 'sharpening-card-heading' }, [
        el('div', { class: 'sharpening-card-copy' }, [
          el('h2', { class: 'card-title', text: 'Arc Super Resolution (ASR)' }),
          el('p', { class: 'card-note', text: 'Spatially scales a smaller game window to the monitor’s desktop resolution.' }),
        ]),
        el('div', { class: 'sharpening-card-control' }, [select]),
      ]),
      sharpeningHelp('ASR is an app-level, single-frame Lanczos spatial filter; it does not use XeSS or a driver upscaler. Run a recognized game in a window whose actual size is below the monitor’s desktop resolution. Arc Power captures that smaller window and presents it at the desktop resolution while preserving its aspect ratio; the desktop remains visible in any side bars. A display-filling borderless window has no smaller window image to capture. True exclusive fullscreen can switch the active display mode to the game resolution; ASR does not restore the monitor’s native output mode in that case. Use a smaller windowed source while the desktop stays at native resolution. The game stays focused for keyboard and controller input. Standard mouse messages are mapped to the smaller window; games using raw-input or DirectInput mouse-look may not respond correctly. Pointer appearance can vary because Windows may compose it separately from the captured game image. ASR takes priority over Arc Image Sharpening while enabled; turning ASR off restores the sharpening setting.'),
      el('p', { class: 'sharpening-runtime-status', text: state ? runtimeStatusText() : 'Loading Arc Super Resolution settings…' }),
      ...(error ? [el('p', { class: 'text-error', text: error })] : []),
      el('div', { class: 'graphics-card-actions' }, [
        el('button', { class: 'btn btn-primary btn-sm asr-apply', text: busy ? 'Applying…' : applied ? 'Applied' : 'Apply', disabled: busy || !state, onclick: () => void apply() }),
        el('button', { class: 'btn btn-ghost btn-sm', text: 'Reset to default', disabled: busy || !state, onclick: () => { draft = { enabled: false }; applied = false; render(); } }),
      ]),
    );
  };

  render();
  const request = ++generation;
  const unsubscribeStatus = api.onPostprocessSharpeningStatus((status) => {
    if (!root.isConnected || typeof status?.active !== 'boolean') return;
    latestStatus = { active: status.active, mode: status.mode, reason: typeof status.reason === 'string' ? status.reason : undefined };
    if (state) {
      state = { ...state, active: latestStatus.active && latestStatus.mode === 'asr', reason: latestStatus.reason };
      const note = root.querySelector<HTMLElement>('.sharpening-runtime-status');
      if (note) note.textContent = runtimeStatusText();
    }
  });
  void api.arcSuperResolutionGet().then((value) => {
    if (request !== generation || !root.isConnected) return;
    state = latestStatus ? { ...value, active: latestStatus.active && latestStatus.mode === 'asr', reason: latestStatus.reason } : value;
    draft = { ...value.value }; render();
  }).catch((err: unknown) => {
    if (request !== generation || !root.isConnected) return;
    error = err instanceof Error ? err.message : String(err); render();
  });
  const detachObserver = new MutationObserver(() => {
    if (root.isConnected) return;
    unsubscribeStatus();
    detachObserver.disconnect();
  });
  detachObserver.observe(document.body, { childList: true, subtree: true });
  return root;
}

export function renderGameSharpening(exePath: string): HTMLElement {
  const root = el('section', { class: 'card graphics-card sharpening-card sharpening-game-card' });
  let generation = 0;
  let state: PostprocessSharpeningGame | null = null;
  let draft: PostprocessSharpeningValue = { enabled: false, percentage: 50 };
  let useGlobal = true;
  let busy = false;
  let error = '';

  const legacyWarning = (): HTMLElement[] => {
    if (state?.legacyManifestStatus === 'unreadable') return [el('p', { class: 'profile-capability-note', text: 'The previous game-folder sharpening manifest could not be checked. Older integrations may remain; this build does not change game files.' })];
    const legacy = state?.legacyIntegration;
    if (!legacy) return [];
    const mode = legacy.mode === 'optiscaler' ? 'OptiScaler/ReShade' : 'ReShade';
    return [el('p', { class: 'profile-capability-note', text: `The previous Arc Power version still lists a ${mode} game-folder integration for this game. It may affect the image with this switch off or stack with screen sharpening. This build does not change game files; remove the old integration with the previous Arc Power version while the game is closed before testing.` })];
  };

  const load = async (): Promise<void> => {
    const request = ++generation;
    try {
      const value = await api.postprocessSharpeningGameGet(exePath);
      if (request !== generation || !root.isConnected) return;
      state = value; useGlobal = value.override === null; draft = { ...(value.override ?? value.globalValue) }; error = '';
    } catch (err) { if (request === generation) error = err instanceof Error ? err.message : String(err); }
    if (request === generation && root.isConnected) render();
  };
  const mutate = async (value: PostprocessSharpeningValue | null): Promise<void> => {
    if (busy) return;
    const request = generation;
    busy = true; error = ''; render();
    try {
      state = await api.postprocessSharpeningGameSet(exePath, value);
      useGlobal = state.override === null;
      draft = { ...(state.override ?? state.globalValue) };
    } catch (err) { error = err instanceof Error ? err.message : String(err); }
    finally { busy = false; if (request === generation && root.isConnected) render(); }
  };
  const render = (): void => {
    const globalValue = state?.globalValue ?? { enabled: false, percentage: 50 };
    const shownValue = useGlobal ? globalValue : draft;
    const slider = el('input', { class: 'graphics-slider', type: 'range', min: 0, max: 100, step: 1, value: shownValue.percentage, disabled: busy || !state || useGlobal || !draft.enabled,
      'aria-label': 'Per-game Arc Image Sharpening strength', 'aria-valuetext': `${shownValue.percentage}%`, oninput: (event: Event) => {
        draft.percentage = safePercentage((event.target as HTMLInputElement).valueAsNumber);
        const label = root.querySelector<HTMLElement>('.sharpening-game-value'); if (label) label.textContent = `${draft.percentage}%`;
        (event.currentTarget as HTMLInputElement).setAttribute('aria-valuetext', `${draft.percentage}%`);
      } });
    const sliderRow = el('div', { class: 'graphics-fps-slider-row sharpening-slider-row', hidden: useGlobal || !draft.enabled }, [slider, el('span', { class: 'graphics-fps-value sharpening-game-value', text: `${shownValue.percentage}%` })]);
    const select = makeSelect(useGlobal ? 'global' : draft.enabled ? 'on' : 'off', [
      { value: 'global', label: `Use global (${globalValue.enabled ? 'On' : 'Off'}, ${globalValue.percentage}%)` },
      { value: 'off', label: 'Arc Image Sharpening Off' },
      { value: 'on', label: 'Arc Image Sharpening On' },
    ], (value) => {
      useGlobal = value === 'global';
      if (!useGlobal) draft.enabled = value === 'on';
      sliderRow.hidden = useGlobal || !draft.enabled;
      slider.disabled = busy || !state || useGlobal || !draft.enabled;
      const shown = useGlobal ? globalValue : draft;
      const label = root.querySelector<HTMLElement>('.sharpening-game-value'); if (label) label.textContent = `${shown.percentage}%`;
    }, 'Per-game Arc Image Sharpening');
    select.disabled = busy || !state;
    root.replaceChildren(
      el('div', { class: 'sharpening-card-heading' }, [
        el('div', { class: 'sharpening-card-copy' }, [el('h2', { class: 'card-title', text: 'Arc Image Sharpening' }), el('p', { class: 'card-note', text: 'Set a sharpening override for this game.' })]),
        el('div', { class: 'sharpening-card-control' }, [select, sliderRow]),
      ]),
      sharpeningHelp('Per-game sharpening applies while this recognized game is the foreground window on a display connected to Intel Arc. The global Arc Image Sharpening switch in Graphics must be on. Windowed, borderless, and fullscreen game windows are eligible; exclusive fullscreen capture can vary by game.'),
      ...legacyWarning(),
      ...(state?.reason ? [el('p', { class: 'text-error', text: state.reason })] : []),
      ...(error ? [el('p', { class: 'text-error', text: error })] : []),
      ...(!state ? [el('p', { class: 'profile-capability-note', text: 'Loading game sharpening…' })] : []),
      el('div', { class: 'graphics-card-actions' }, [
        el('button', { class: 'btn btn-primary btn-sm', text: busy ? 'Applying…' : 'Apply', disabled: busy || !state, onclick: () => void mutate(useGlobal ? null : { ...draft }) }),
        el('button', { class: 'btn btn-ghost btn-sm', text: 'Reset to default', disabled: busy || !state, onclick: () => { useGlobal = true; draft = { ...globalValue }; render(); } }),
      ]),
    );
  };
  render(); void load();
  return root;
}
