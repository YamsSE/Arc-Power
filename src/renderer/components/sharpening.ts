import { api } from '../ipc.ts';
import { el } from '../dom.ts';
import { buildDropdown, type DropdownElement } from './dropdown.ts';
import { toast } from './toast.ts';
import type { PostprocessSharpeningGame, PostprocessSharpeningGlobal, PostprocessSharpeningValue } from '../types.ts';

const safePercentage = (value: number): number => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

const sharpeningHelp = (text: string): HTMLElement => el('details', { class: 'sharpening-help' }, [
  el('summary', { text: 'How sharpening works' }),
  el('p', { class: 'card-note', text }),
]);

const makeSelect = (value: string, options: Array<{ value: string; label: string }>, onChange: (value: string) => void, ariaLabel: string): DropdownElement =>
  buildDropdown(value, options, { className: 'graphics-select sharpening-select', ariaLabel, onChange });

export type GlobalSharpeningApplyState = { dirty: boolean; busy: boolean; apply: () => Promise<void> };

/** App-managed screen sharpening controls, kept outside the driver's graphics apply path. */
export function renderGlobalSharpening(onStateChange?: (state: GlobalSharpeningApplyState) => void, onUnmount?: () => void): HTMLElement {
  const root = el('section', { class: 'card graphics-card sharpening-card' });
  let generation = 0;
  let state: PostprocessSharpeningGlobal | null = null;
  let draft: PostprocessSharpeningValue = { enabled: false, percentage: 50 };
  let latestRuntimeStatus: { active: boolean; reason?: string } | null = null;
  let busy = false;
  let error = '';
  let saveStatus = '';
  let appliedValue: PostprocessSharpeningValue | null = null;
  let applyGlobal: () => Promise<void> = async () => {};
  const markEditing = (): void => {
    saveStatus = '';
    const button = root.querySelector<HTMLButtonElement>('.graphics-card-actions .btn-primary');
    if (button && !busy) button.textContent = 'Apply';
  };
  const isDirty = (): boolean => !!state && !!appliedValue
    && (draft.enabled !== appliedValue.enabled || draft.percentage !== appliedValue.percentage);
  const notify = (): void => onStateChange?.({ dirty: isDirty(), busy, apply: applyGlobal });

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
        markEditing();
        draft.percentage = safePercentage((event.target as HTMLInputElement).valueAsNumber);
        const text = root.querySelector<HTMLElement>('.sharpening-value');
        if (text) text.textContent = `${draft.percentage}%`;
        (event.currentTarget as HTMLInputElement).setAttribute('aria-valuetext', `${draft.percentage}%`);
        notify();
      } });
    const sliderRow = el('div', { class: 'graphics-fps-slider-row sharpening-slider-row', hidden: !draft.enabled }, [slider, el('span', { class: 'graphics-fps-value sharpening-value', text: `${draft.percentage}%` })]);
    const select = makeSelect(draft.enabled ? 'on' : 'off', [
      { value: 'off', label: 'Arc Image Sharpening Off' },
      { value: 'on', label: 'Arc Image Sharpening On' },
    ], (value) => {
      markEditing();
      draft.enabled = value === 'on';
      sliderRow.hidden = !draft.enabled;
      slider.disabled = busy || !state || !draft.enabled;
      notify();
    }, 'Arc Image Sharpening');
    select.disabled = busy || !state;
    const apply = async (): Promise<void> => {
      if (busy || !state) return;
      const request = generation;
      busy = true; error = ''; saveStatus = ''; render(); notify();
      try {
        const next = await api.postprocessSharpeningSet({ enabled: draft.enabled, percentage: draft.percentage });
        if (request !== generation || !root.isConnected) return;
        state = next;
        if (latestRuntimeStatus) state = { ...state, active: latestRuntimeStatus.active, reason: latestRuntimeStatus.reason };
        draft = { ...state.value };
        appliedValue = { ...state.value };
        saveStatus = state.reason ? 'Saved' : 'Applied';
        if (state.reason) toast('warn', 'Arc Image Sharpening saved', state.reason);
        else toast('success', 'Arc Image Sharpening saved', 'Runtime status shows whether sharpening is active.');
      } catch (err) {
        if (request !== generation || !root.isConnected) return;
        error = err instanceof Error ? err.message : String(err);
        toast('error', 'Arc Image Sharpening failed', error);
      } finally { if (request === generation) { busy = false; if (root.isConnected) { render(); notify(); } } }
    };
    applyGlobal = apply;
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
        el('button', { class: 'btn btn-primary btn-sm', text: busy ? 'Applying…' : saveStatus || 'Apply', disabled: busy || !state, onclick: () => void apply() }),
        el('button', { class: 'btn btn-ghost btn-sm', text: 'Reset to default', disabled: busy || !state, onclick: () => { saveStatus = ''; draft = { enabled: false, percentage: 50 }; render(); notify(); } }),
      ]),
    );
  };
  render();
  const request = ++generation;
  const unsubscribeStatus = api.onPostprocessSharpeningStatus((status) => {
    if (!root.isConnected || typeof status?.active !== 'boolean') return;
    latestRuntimeStatus = { active: status.active, reason: typeof status.reason === 'string' ? status.reason : undefined };
    if (state) {
      state = { ...state, ...latestRuntimeStatus };
      const note = root.querySelector<HTMLElement>('.sharpening-runtime-status');
      if (note) note.textContent = runtimeStatusText();
    }
  });
  void api.postprocessSharpeningGet().then((value) => {
    if (request !== generation || !root.isConnected) return;
    state = latestRuntimeStatus ? { ...value, ...latestRuntimeStatus } : value;
    draft = { ...value.value }; appliedValue = { ...value.value }; render(); notify();
  }).catch((err: unknown) => {
    if (request !== generation || !root.isConnected) return;
    error = err instanceof Error ? err.message : String(err); render();
  });
  const detachObserver = new MutationObserver(() => {
    if (root.isConnected) return;
    generation += 1;
    unsubscribeStatus();
    onUnmount?.();
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
  let saveStatus = '';
  const markEditing = (): void => {
    saveStatus = '';
    const button = root.querySelector<HTMLButtonElement>('.graphics-card-actions .btn-primary');
    if (button && !busy) button.textContent = 'Apply';
  };

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
    busy = true; error = ''; saveStatus = ''; render();
    try {
      const next = await api.postprocessSharpeningGameSet(exePath, value);
      if (request !== generation || !root.isConnected) return;
      state = next;
      useGlobal = state.override === null;
      draft = { ...(state.override ?? state.globalValue) };
      saveStatus = state.reason ? 'Saved' : 'Applied';
      if (state.reason) toast('warn', 'Per-game sharpening saved', state.reason);
      else toast('success', 'Per-game sharpening saved', 'Runtime status shows whether sharpening is active.');
    } catch (err) {
      if (request !== generation || !root.isConnected) return;
      error = err instanceof Error ? err.message : String(err);
      toast('error', 'Per-game sharpening failed', error);
    } finally { if (request === generation) { busy = false; if (root.isConnected) render(); } }
  };
  const render = (): void => {
    const globalValue = state?.globalValue ?? { enabled: false, percentage: 50 };
    const shownValue = useGlobal ? globalValue : draft;
    const slider = el('input', { class: 'graphics-slider', type: 'range', min: 0, max: 100, step: 1, value: shownValue.percentage, disabled: busy || !state || useGlobal || !draft.enabled,
      'aria-label': 'Per-game Arc Image Sharpening strength', 'aria-valuetext': `${shownValue.percentage}%`, oninput: (event: Event) => {
        markEditing();
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
      markEditing();
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
      ...(state && !state.globalValue.enabled ? [el('p', { class: 'profile-capability-note', text: 'Global Arc Image Sharpening is off. This per-game override remains saved and will be inactive until the global switch is on.' })] : []),
      ...legacyWarning(),
      ...(state?.reason ? [el('p', { class: 'text-error', text: state.reason })] : []),
      ...(error ? [el('p', { class: 'text-error', text: error })] : []),
      ...(!state ? [el('p', { class: 'profile-capability-note', text: 'Loading game sharpening…' })] : []),
      el('div', { class: 'graphics-card-actions' }, [
        el('button', { class: 'btn btn-primary btn-sm', text: busy ? 'Applying…' : saveStatus || 'Apply', disabled: busy || !state, onclick: () => void mutate(useGlobal ? null : { ...draft }) }),
        el('button', { class: 'btn btn-ghost btn-sm', text: 'Reset to default', disabled: busy || !state, onclick: () => { saveStatus = ''; useGlobal = true; draft = { ...globalValue }; render(); } }),
      ]),
    );
  };
  render(); void load();
  const detachObserver = new MutationObserver(() => {
    if (root.isConnected) return;
    generation += 1;
    detachObserver.disconnect();
  });
  detachObserver.observe(document.body, { childList: true, subtree: true });
  return root;
}
