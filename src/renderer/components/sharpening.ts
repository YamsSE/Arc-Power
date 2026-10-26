import { api } from '../ipc.ts';
import { el } from '../dom.ts';
import { toast } from './toast.ts';
import { buildDropdown, type DropdownElement } from './dropdown.ts';
import type { ArcSuperResolutionGame, ArcSuperResolutionState, ArcSuperResolutionValue, PostprocessSharpeningGame, PostprocessSharpeningGlobal, PostprocessSharpeningValue } from '../types.ts';

const safePercentage = (value: number): number => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

const sharpeningHelp = (text: string, label = 'How sharpening works'): HTMLElement => el('details', { class: 'sharpening-help' }, [
  el('summary', { text: label }),
  el('p', { class: 'card-note', text }),
]);

const makeSelect = (value: string, options: Array<{ value: string; label: string }>, onChange: (value: string) => void, ariaLabel: string): DropdownElement =>
  buildDropdown(value, options, { className: 'graphics-select sharpening-select', ariaLabel, onChange });

export type GlobalSharpeningApplyState = { dirty: boolean; busy: boolean; canApply: boolean; apply: () => Promise<void> };

/** App-managed screen sharpening controls, kept outside the driver's graphics apply path. */
export function renderGlobalSharpening(onStateChange?: (state: GlobalSharpeningApplyState) => void, onUnmount?: () => void): HTMLElement {
  const root = el('section', { class: 'card graphics-card sharpening-card' });
  let generation = 0;
  let state: PostprocessSharpeningGlobal | null = null;
  let draft: PostprocessSharpeningValue = { enabled: false, percentage: 50 };
  let latestRuntimeStatus: { active: boolean; reason?: string; mode?: 'asr' | 'sharpening' } | null = null;
  let busy = false;
  let error = '';
  let saveStatus = '';
  let appliedValue: PostprocessSharpeningValue | null = null;
  let settingsRevision = 0;
  let externalChange = false;
  let applyGlobal: () => Promise<void> = async () => {};
  const mergeRuntimeStatus = (base: PostprocessSharpeningGlobal): PostprocessSharpeningGlobal => {
    if (!latestRuntimeStatus) return base;
    // An unavailable screen-sharpening runtime can carry a mode-specific
    // pause explanation. ASR status events describe the separate ASR path and
    // must never replace that explanation (or supply a global warning).
    if (!base.runtimeReady) return { ...base, active: false, reason: base.reason };
    if (latestRuntimeStatus.mode === 'asr') return { ...base, active: false, reason: undefined };
    return { ...base, active: latestRuntimeStatus.active, reason: latestRuntimeStatus.reason };
  };
  const markEditing = (): void => {
    saveStatus = '';
    const button = root.querySelector<HTMLButtonElement>('.graphics-card-actions .btn-primary');
    if (button && !busy) button.textContent = 'Apply';
  };
  const isDirty = (): boolean => !!state && !!appliedValue
    && (draft.enabled !== appliedValue.enabled || draft.percentage !== appliedValue.percentage);
  const notify = (): void => onStateChange?.({ dirty: isDirty(), busy, canApply: !!state && (state.runtimeReady || !draft.enabled), apply: applyGlobal });

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
    const slider = el('input', { type: 'range', class: 'graphics-slider', min: 0, max: 100, step: 1, value: draft.percentage, disabled: busy || !state || !state.runtimeReady || !draft.enabled,
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
      slider.disabled = busy || !state || !state.runtimeReady || !draft.enabled;
      const applyButton = root.querySelector<HTMLButtonElement>('.graphics-card-actions .btn-primary');
      if (applyButton) applyButton.disabled = busy || !state || (!state.runtimeReady && draft.enabled);
      notify();
    }, 'Arc Image Sharpening');
    select.disabled = busy || !state;
    const apply = async (): Promise<void> => {
      if (busy || !state) return;
      if (!state.runtimeReady && draft.enabled) return;
      const request = generation;
      busy = true; error = ''; saveStatus = ''; render(); notify();
      try {
        const next = await api.postprocessSharpeningSet({ enabled: draft.enabled, percentage: draft.percentage });
        if (request !== generation || !root.isConnected) return;
        state = mergeRuntimeStatus(next);
        draft = { ...state.value };
        appliedValue = { ...state.value };
        externalChange = false;
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
      sharpeningHelp(state?.provider === 'managed'
        ? 'Launch the game from Game Profiles to attach the bundled sharpening runtime before graphics starts. Strength changes then apply live inside the game. Arc Image Sharpening works independently of ASR, and both may be enabled together. No download or game-folder files are required.'
        : 'Sharpens only the foreground game on a display connected to Intel Arc while Arc Power is open. Windowed, borderless, and fullscreen game windows are eligible; exclusive fullscreen capture can vary by game. No capture prompt, setup download, or game-folder files are used.'),
      ...legacyWarning(),
      el('p', { class: 'sharpening-runtime-status', text: state ? runtimeStatusText() : 'Loading sharpening settings…' }),
      ...(error ? [el('p', { class: 'text-error', text: error })] : []),
      ...(externalChange ? [el('p', { class: 'settings-sync-status', text: 'Saved settings changed in the other window. Your draft is preserved; Apply will overwrite that change.' })] : []),
      el('div', { class: 'graphics-card-actions' }, [
        el('button', { class: 'btn btn-primary btn-sm', text: busy ? 'Applying…' : saveStatus || 'Apply', disabled: busy || !state || (!state.runtimeReady && draft.enabled), onclick: () => void apply() }),
        el('button', { class: 'btn btn-ghost btn-sm', text: 'Reset to default', disabled: busy || !state, onclick: () => { saveStatus = ''; externalChange = false; draft = { enabled: false, percentage: 50 }; render(); notify(); } }),
      ]),
    );
  };
  render();
  const request = ++generation;
  const unsubscribeStatus = api.onPostprocessSharpeningStatus((status) => {
    if (!root.isConnected || typeof status?.active !== 'boolean') return;
    const independent = typeof status.sharpeningActive === 'boolean';
    const reason = independent ? status.sharpeningReason : status.reason;
    latestRuntimeStatus = { active: status.sharpeningActive ?? (status.active && status.mode !== 'asr'),
      mode: independent ? 'sharpening' : status.mode, reason: typeof reason === 'string' ? reason : undefined };
    if (state) {
      state = mergeRuntimeStatus(state);
      const note = root.querySelector<HTMLElement>('.sharpening-runtime-status');
      if (note) note.textContent = runtimeStatusText();
    }
  });
  const unsubscribeSettings = api.onPostprocessGlobalSettingsUpdated((update) => {
    if (!root.isConnected || update.kind !== 'sharpening' || update.revision <= settingsRevision) return;
    settingsRevision = update.revision;
    const dirty = isDirty();
    const changed = !!appliedValue && (update.state.value.enabled !== appliedValue.enabled || update.state.value.percentage !== appliedValue.percentage);
    state = mergeRuntimeStatus(update.state);
    appliedValue = { ...update.state.value };
    const draftMatchesSaved = draft.enabled === update.state.value.enabled && draft.percentage === update.state.value.percentage;
    if (!dirty || draftMatchesSaved) { draft = { ...update.state.value }; externalChange = false; saveStatus = 'Applied'; }
    else if (changed) externalChange = true;
    render(); notify();
  });
  void api.postprocessSharpeningGet().then((value) => {
    if (request !== generation || !root.isConnected) return;
    if (settingsRevision > 0) return;
    state = mergeRuntimeStatus(value);
    draft = { ...value.value }; appliedValue = { ...value.value };
    render(); notify();
  }).catch((err: unknown) => {
    if (request !== generation || !root.isConnected) return;
    error = err instanceof Error ? err.message : String(err); render();
  });
  const detachObserver = new MutationObserver(() => {
    if (root.isConnected) return;
    generation += 1;
    unsubscribeStatus();
    unsubscribeSettings();
    onUnmount?.();
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
  let settingsRevision = 0;
  let externalChange = false;
  let pendingPush: import('../types.ts').PostprocessGlobalSettingsUpdate | null = null;

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
      if (draft.enabled && !state.runtimeReady) return;
      busy = true; error = ''; render();
      try {
        state = await api.arcSuperResolutionSet({ enabled: draft.enabled });
        if (latestStatus) state = { ...state, active: latestStatus.active && latestStatus.mode === 'asr', reason: latestStatus.reason };
        draft = { ...state.value };
        applied = true;
        toast('success', 'Arc Super Resolution preference saved', state.value.enabled
          ? (state.active ? 'ASR is active on the foreground game.' : runtimeStatusText())
          : 'The global ASR default is Off. Per-game overrides still apply.');
      } catch (err) {
        applied = false;
        error = err instanceof Error ? err.message : String(err);
        toast('error', 'Arc Super Resolution apply failed', error);
      }
      finally {
        busy = false;
        const update = pendingPush; pendingPush = null;
        if (update) reconcilePush(update);
        if (request === generation && root.isConnected) render();
      }
    };
    root.replaceChildren(
      el('div', { class: 'sharpening-card-heading' }, [
        el('div', { class: 'sharpening-card-copy' }, [
          el('h2', { class: 'card-title', text: 'Arc Super Resolution (ASR)' }),
          el('p', { class: 'card-note', text: 'Spatially scales a smaller game window to the monitor’s desktop resolution.' }),
        ]),
        el('div', { class: 'sharpening-card-control' }, [select]),
      ]),
      sharpeningHelp('Run a recognized game in a smaller window while the desktop remains at its native resolution. Arc Power fits that game window to the display and passes native input through to the game. A display-filling borderless window has no smaller image to scale. Exclusive fullscreen may change the active display mode. ASR is limited to recognized games and does not guarantee compatibility with every game. Per-game On or Off overrides this global default. ASR and Arc Image Sharpening are independent; both may be enabled together.', 'How Scaling Works'),
      el('p', { class: 'sharpening-runtime-status', text: state ? runtimeStatusText() : 'Loading Arc Super Resolution settings…' }),
      ...(error ? [el('p', { class: 'text-error', text: error })] : []),
      ...(externalChange ? [el('p', { class: 'settings-sync-status', text: 'Saved settings changed in the other window. Your draft is preserved; Apply will overwrite that change.' })] : []),
      el('div', { class: 'graphics-card-actions' }, [
        el('button', { class: 'btn btn-primary btn-sm asr-apply', text: busy ? 'Applying…' : applied ? 'Applied' : 'Apply', disabled: busy || !state || (draft.enabled && !state.runtimeReady), onclick: () => void apply() }),
        el('button', { class: 'btn btn-ghost btn-sm', text: 'Reset to default', disabled: busy || !state, onclick: () => { draft = { enabled: false }; applied = false; externalChange = false; render(); } }),
      ]),
    );
  };

  render();
  const request = ++generation;
  const unsubscribeStatus = api.onPostprocessSharpeningStatus((status) => {
    if (!root.isConnected || typeof status?.active !== 'boolean') return;
    const independent = typeof status.asrActive === 'boolean';
    const reason = independent ? status.asrReason : status.reason;
    latestStatus = { active: status.asrActive ?? status.active, mode: independent ? 'asr' : status.mode, reason: typeof reason === 'string' ? reason : undefined };
    if (state) {
      state = { ...state, active: latestStatus.active && latestStatus.mode === 'asr', reason: latestStatus.reason };
      const note = root.querySelector<HTMLElement>('.sharpening-runtime-status');
      if (note) note.textContent = runtimeStatusText();
    }
  });
  const reconcilePush = (update: import('../types.ts').PostprocessGlobalSettingsUpdate): void => {
    if (!root.isConnected || update.kind !== 'asr' || update.revision <= settingsRevision) return;
    if (pendingPush && update.revision <= pendingPush.revision) return;
    if (busy) { pendingPush = update; return; }
    settingsRevision = update.revision;
    const dirty = !!state && draft.enabled !== state.value.enabled;
    const changed = !!state && update.state.value.enabled !== state.value.enabled;
    state = latestStatus ? { ...update.state, active: latestStatus.active && latestStatus.mode === 'asr', reason: latestStatus.reason } : update.state;
    const draftMatchesSaved = draft.enabled === update.state.value.enabled;
    if (!dirty || draftMatchesSaved) { draft = { ...update.state.value }; applied = true; externalChange = false; }
    else if (changed) { applied = false; externalChange = true; }
    render();
  };
  const unsubscribeSettings = api.onPostprocessGlobalSettingsUpdated(reconcilePush);
  void api.arcSuperResolutionGet().then((value) => {
    if (request !== generation || !root.isConnected) return;
    if (settingsRevision > 0) return;
    state = latestStatus ? { ...value, active: latestStatus.active && latestStatus.mode === 'asr', reason: latestStatus.reason } : value;
    draft = { ...value.value }; render();
  }).catch((err: unknown) => {
    if (request !== generation || !root.isConnected) return;
    error = err instanceof Error ? err.message : String(err); render();
  });
  const detachObserver = new MutationObserver(() => {
    if (root.isConnected) return;
    unsubscribeStatus();
    unsubscribeSettings();
    detachObserver.disconnect();
  });
  detachObserver.observe(document.body, { childList: true, subtree: true });
  return root;
}

export function renderGameArcSuperResolution(exePath: string): HTMLElement {
  const root = el('section', { class: 'card graphics-card asr-game-card' });
  let state: ArcSuperResolutionGame | null = null;
  let choice = 'global';
  let busy = false, saved = false, error = '', generation = 0;
  const load = async (): Promise<void> => {
    const request = ++generation;
    try {
      const next = await api.arcSuperResolutionGameGet(exePath);
      if (request !== generation || !root.isConnected) return;
      state = next; choice = next.override === null ? 'global' : next.override.enabled ? 'on' : 'off'; error = '';
    } catch (err) { if (request === generation) error = err instanceof Error ? err.message : String(err); }
    if (request === generation && root.isConnected) render();
  };
  const apply = async (): Promise<void> => {
    if (busy || !state) return;
    const request = generation;
    busy = true; saved = false; error = ''; render();
    try {
      const next = await api.arcSuperResolutionGameSet(exePath, choice === 'global' ? null : { enabled: choice === 'on' });
      if (request !== generation || !root.isConnected) return;
      state = next; saved = true;
      toast('success', 'Per-game ASR saved', next.effective.enabled
        ? 'ASR will enlarge this recognized game while it runs in a smaller foreground window.'
        : 'ASR is off for this game.');
    } catch (err) {
      if (request !== generation || !root.isConnected) return;
      error = err instanceof Error ? err.message : String(err);
      toast('error', 'Per-game ASR apply failed', error);
    } finally { if (request === generation) { busy = false; if (root.isConnected) render(); } }
  };
  const render = (): void => {
    const select = makeSelect(choice, [
      { value: 'global', label: `Use global (${state?.globalValue.enabled ? 'On' : 'Off'})` },
      { value: 'off', label: 'Arc Super Resolution Off' },
      { value: 'on', label: 'Arc Super Resolution On' },
    ], value => { choice = value; saved = false; const button = root.querySelector<HTMLButtonElement>('.asr-game-apply'); if (button) button.textContent = 'Apply'; }, 'Per-game Arc Super Resolution');
    select.disabled = busy || !state;
    root.replaceChildren(
      el('div', { class: 'sharpening-card-heading' }, [
        el('div', { class: 'sharpening-card-copy' }, [el('h2', { class: 'card-title', text: 'Arc Super Resolution (ASR)' }), el('p', { class: 'card-note', text: 'Choose whether to enlarge this game’s smaller window.' })]),
        el('div', { class: 'sharpening-card-control' }, [select]),
      ]),
      sharpeningHelp('Run this recognized game in Windowed mode at a resolution smaller than your display. On enables ASR for this game even when the global default is Off; Off excludes it even when the global default is On. Use global inherits the Graphics setting. No Arc Power launch is required for ASR. Sharpening is independent and may run at the same time.', 'How Scaling Works'),
      ...(state?.reason ? [el('p', { class: 'text-error', text: state.reason })] : []),
      ...(error ? [el('p', { class: 'text-error', text: error })] : []),
      ...(!state && !error ? [el('p', { class: 'profile-capability-note', text: 'Loading game scaling settings…' })] : []),
      el('div', { class: 'graphics-card-actions' }, [
        el('button', { class: 'btn btn-primary btn-sm asr-game-apply', text: busy ? 'Applying…' : saved ? 'Saved' : 'Apply', disabled: busy || !state || state.runtimeReady === false, onclick: () => void apply() }),
        el('button', { class: 'btn btn-ghost btn-sm', text: 'Reset to default', disabled: busy || !state, onclick: () => { choice = 'global'; saved = false; render(); } }),
        ...(!state && error ? [el('button', { class: 'btn btn-ghost btn-sm', text: 'Retry', onclick: () => void load() })] : []),
      ]),
    );
  };
  const unsubscribe = api.onPostprocessGlobalSettingsUpdated(update => {
    if (!root.isConnected || !state || update.kind !== 'asr') return;
    state = { ...state, globalValue: { ...update.state.value },
      effective: state.override ?? { ...update.state.value } };
    render();
  });
  render(); void load();
  const observer = new MutationObserver(() => {
    if (root.isConnected) return;
    generation++; unsubscribe(); observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
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
  const launchGame = async (): Promise<void> => {
    if (busy) return;
    const request = generation;
    busy = true; error = ''; render();
    try {
      state = await api.postprocessSharpeningGameSet(exePath, useGlobal ? null : { ...draft });
      if (request !== generation || !root.isConnected) return;
      const launched = await api.postprocessSharpeningLaunchGame(exePath);
      if (request !== generation || !root.isConnected) return;
      toast('success', 'Game started', `Sharpening controls are attaching to the game (PID ${launched.pid}).`);
      const next = await api.postprocessSharpeningGameGet(exePath);
      if (request !== generation || !root.isConnected) return;
      state = next;
    } catch (err) {
      if (request !== generation || !root.isConnected) return;
      error = err instanceof Error ? err.message : String(err);
      toast('error', 'Game launch failed', error);
    } finally { if (request === generation) { busy = false; if (root.isConnected) render(); } }
  };
  const render = (): void => {
    const globalValue = state?.globalValue ?? { enabled: false, percentage: 50 };
    const shownValue = useGlobal ? globalValue : draft;
    const slider = el('input', { class: 'graphics-slider', type: 'range', min: 0, max: 100, step: 1, value: shownValue.percentage, disabled: busy || !state || state.runtimeReady === false || useGlobal || !draft.enabled,
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
      slider.disabled = busy || !state || state.runtimeReady === false || useGlobal || !draft.enabled;
      const shown = useGlobal ? globalValue : draft;
      const label = root.querySelector<HTMLElement>('.sharpening-game-value'); if (label) label.textContent = `${shown.percentage}%`;
      const applyButton = root.querySelector<HTMLButtonElement>('.graphics-card-actions .btn-primary');
      if (applyButton) applyButton.disabled = busy || !state || (state.runtimeReady === false && !useGlobal && draft.enabled);
    }, 'Per-game Arc Image Sharpening');
    select.disabled = busy || !state;
    root.replaceChildren(
      el('div', { class: 'sharpening-card-heading' }, [
        el('div', { class: 'sharpening-card-copy' }, [el('h2', { class: 'card-title', text: 'Arc Image Sharpening' }), el('p', { class: 'card-note', text: 'Set a sharpening override for this game.' })]),
        el('div', { class: 'sharpening-card-control' }, [select, sliderRow]),
      ]),
      sharpeningHelp(state?.provider === 'managed'
        ? 'Use Launch game below to start this game with the bundled sharpening runtime. Strength changes apply inside the game after launch. The global Arc Image Sharpening switch must be on. ASR is independent and can run at the same time.'
        : 'Per-game sharpening applies while this recognized game is the foreground window on a display connected to Intel Arc. The global Arc Image Sharpening switch in Graphics must be on. Windowed, borderless, and fullscreen game windows are eligible; exclusive fullscreen capture can vary by game.'),
      ...(state && !state.globalValue.enabled ? [el('p', { class: 'profile-capability-note', text: 'Global Arc Image Sharpening is off. This per-game override remains saved and will be inactive until the global switch is on.' })] : []),
      ...legacyWarning(),
      ...(state?.reason ? [el('p', { class: 'text-error', text: state.reason })] : []),
      ...(error ? [el('p', { class: 'text-error', text: error })] : []),
      ...(!state ? [el('p', { class: 'profile-capability-note', text: 'Loading game sharpening…' })] : []),
      el('div', { class: 'graphics-card-actions' }, [
        el('button', { class: 'btn btn-primary btn-sm', text: busy ? 'Applying…' : saveStatus || 'Apply', disabled: busy || !state || (state.runtimeReady === false && !useGlobal && draft.enabled), onclick: () => void mutate(useGlobal ? null : { ...draft }) }),
        el('button', { class: 'btn btn-ghost btn-sm', text: 'Reset to default', disabled: busy || !state, onclick: () => { saveStatus = ''; useGlobal = true; draft = { ...globalValue }; render(); } }),
        ...(state?.launchSupported ? [el('button', { class: 'btn btn-ghost btn-sm sharpening-launch-game', text: busy ? 'Working…' : 'Launch game', disabled: busy, onclick: () => void launchGame() })] : []),
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
