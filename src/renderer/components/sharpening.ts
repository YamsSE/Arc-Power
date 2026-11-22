import { api } from '../ipc.ts';
import { el } from '../dom.ts';
import { toast } from './toast.ts';
import { showRecordingHotkeyDialog } from './recording-hotkey-dialog.ts';
import { buildDropdown, type DropdownElement } from './dropdown.ts';
import type { ArcSuperResolutionState, ArcSuperResolutionValue, PostprocessScaleHotkeyState, PostprocessSharpeningGlobal, PostprocessSharpeningValue, PostprocessWindowSelection } from '../types.ts';

const safePercentage = (value: number): number => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

const sharpeningHelp = (text: string, label = 'How sharpening works'): HTMLElement => el('details', { class: 'sharpening-help' }, [
  el('summary', { text: label }),
  el('p', { class: 'card-note', text }),
]);

const makeSelect = (value: string, options: Array<{ value: string; label: string }>, onChange: (value: string) => void, ariaLabel: string): DropdownElement =>
  buildDropdown(value, options, { className: 'graphics-select sharpening-select', ariaLabel, onChange });

export type GlobalSharpeningApplyState = { dirty: boolean; busy: boolean; canApply: boolean; apply: () => Promise<void> };

/** One global target selector shared by windowed sharpening and ASR. */
export function renderPostprocessWindowSelector(): HTMLElement {
  const root = el('section', { class: 'postprocess-window-panel' });
  let selection: PostprocessWindowSelection = { phase: 'idle', secondsRemaining: 0, targetName: null };
  let hotkey: PostprocessScaleHotkeyState | null = null;
  let busy = false;
  let stopping = false;
  let hotkeyBusy = false;
  let error = '';
  let runtimeWarning = '';
  let selectionRevision = 0;
  let selectionOperation = 0;
  const selectionText = (): string => {
    if (selection.phase === 'countdown') return selection.secondsRemaining > 0
      ? `Switch to your game · ${selection.secondsRemaining}s.`
      : 'Checking the foreground window…';
    if (selection.phase === 'selected') return `Selected: ${selection.targetName ?? 'game window'} · pauses when unfocused.`;
    return 'Effects start on the selected game and pause when you switch away.';
  };
  const statusText = (): string => error || runtimeWarning || selectionText();
  const render = (): void => {
    const select = el('button', { class: 'btn btn-primary btn-sm postprocess-scale', text: busy || selection.phase === 'countdown' ? 'Selecting…' : 'Scale', disabled: busy || stopping || selection.phase === 'countdown', title: 'Switch to your game within five seconds after pressing Scale', onclick: () => void selectWindow() });
    const stop = el('button', { class: 'btn btn-ghost btn-sm postprocess-stop', text: stopping ? 'Stopping…' : 'Stop', disabled: stopping || (selection.phase === 'idle' && !busy), 'aria-label': 'Stop scaling and sharpening', title: 'Stop the active scaling session or cancel selection', onclick: () => void stopWindow() });
    const setHotkey = el('button', { class: 'btn btn-ghost btn-sm', text: hotkeyBusy ? 'Saving…' : `Hotkey: ${hotkey?.accelerator ?? 'Alt+F10'}`, disabled: hotkeyBusy, title: 'Set the global shortcut for starting and stopping Scale', onclick: () => void editHotkey() });
    const clearHotkey = el('button', {
      class: 'btn btn-secondary recording-hotkey-none', type: 'button', text: 'NONE',
      disabled: hotkeyBusy || hotkey?.accelerator === 'None',
      title: 'Turn off the Scale shortcut',
      onClick: () => void clearScaleHotkey(),
    });
    root.replaceChildren(
      el('div', { class: 'sharpening-card-heading' }, [
        el('div', { class: 'sharpening-card-copy' }, [
          el('h2', { class: 'card-title', text: 'Scale a game' }),
          el('p', { class: 'card-note', text: 'Press Scale, then switch to your game within five seconds.' }),
        ]),
      ]),
      el('p', { class: 'sharpening-runtime-status postprocess-window-status', text: statusText() }),
      el('div', { class: 'graphics-card-actions' }, [select, stop, setHotkey, clearHotkey]),
      ...(hotkey && !hotkey.registered ? [el('p', { class: 'postprocess-hotkey-warning', text: hotkey.reason || `Scale shortcut ${hotkey.accelerator} could not be registered.` })] : []),
    );
  };
  const stopWindow = async (): Promise<void> => {
    if (stopping || (selection.phase === 'idle' && !busy)) return;
    const operation = ++selectionOperation;
    stopping = true; error = ''; render();
    try {
      const result = await api.postprocessSharpeningWindowStop();
      if (operation !== selectionOperation) return;
      selectionRevision++;
      selection = result.selection;
      busy = false;
      runtimeWarning = '';
      toast('success', 'Scaling stopped', 'The selected game window has been released.');
    } catch (err) {
      if (operation !== selectionOperation) return;
      busy = false;
      error = err instanceof Error ? err.message : String(err);
      toast('error', 'Could not stop scaling', error);
    } finally {
      if (operation === selectionOperation) {
        stopping = false;
        if (root.isConnected) render();
      }
    }
  };
  const selectWindow = async (): Promise<void> => {
    if (busy || stopping || selection.phase === 'countdown') return;
    const operation = ++selectionOperation;
    busy = true; error = ''; render();
    try {
      await api.postprocessSharpeningWindowSelect();
    } catch (err) {
      if (operation !== selectionOperation) return;
      error = err instanceof Error ? err.message : String(err);
      toast('error', 'Game window selection failed', error);
    } finally {
      if (operation === selectionOperation) {
        busy = false;
        if (root.isConnected) render();
      }
    }
  };
  const clearScaleHotkey = async (): Promise<void> => {
    if (hotkeyBusy) return;
    hotkeyBusy = true; render();
    try {
      hotkey = await api.postprocessSharpeningHotkeySet('None');
      toast('success', 'Scale hotkey disabled', 'No global shortcut starts or stops Scale now.');
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      toast('error', 'Scale hotkey could not be disabled', error);
    } finally { hotkeyBusy = false; if (root.isConnected) render(); }
  };
  const editHotkey = async (): Promise<void> => {
    const next = await showRecordingHotkeyDialog('Scale', hotkey?.accelerator ?? 'Alt+F10', { requireModifier: true });
    if (next === null) return;
    hotkeyBusy = true; render();
    try {
      hotkey = await api.postprocessSharpeningHotkeySet(next);
      if (hotkey.registered) toast('success', 'Scale hotkey saved', `${hotkey.accelerator} starts or stops the selected window.`);
      else toast('warn', 'Scale hotkey saved but unavailable', hotkey.reason || `Could not register ${hotkey.accelerator}.`);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      toast('error', 'Scale hotkey could not be saved', error);
    } finally { hotkeyBusy = false; if (root.isConnected) render(); }
  };
  render();
  const initialRevision = selectionRevision;
  void api.postprocessSharpeningGet().then((state) => {
    if (!root.isConnected || initialRevision !== selectionRevision || !state.selection) return;
    selection = state.selection;
    render();
  }).catch(() => {});
  void api.postprocessSharpeningHotkeyGet().then((state) => {
    if (!root.isConnected) return;
    hotkey = state;
    render();
  }).catch(() => {});
  const unsubscribe = api.onPostprocessSharpeningStatus((status) => {
    if (!root.isConnected) return;
    if (status.selection) {
      selectionRevision++;
      selection = status.selection;
      if (selection.phase !== 'idle') error = '';
    }
    runtimeWarning = typeof status.reason === 'string' && status.reason.trim() ? status.reason : '';
    const text = root.querySelector<HTMLElement>('.postprocess-window-status');
    if (text) text.textContent = statusText();
    const stop = root.querySelector<HTMLButtonElement>('.postprocess-stop');
    if (stop) stop.disabled = stopping || (selection.phase === 'idle' && !busy);
    const scale = root.querySelector<HTMLButtonElement>('.postprocess-scale');
    if (scale) {
      scale.disabled = busy || stopping || selection.phase === 'countdown';
      scale.textContent = busy || selection.phase === 'countdown' ? 'Selecting…' : 'Scale';
    }
  });
  const detachObserver = new MutationObserver(() => {
    if (root.isConnected) return;
    unsubscribe();
    detachObserver.disconnect();
  });
  detachObserver.observe(document.body, { childList: true, subtree: true });
  return root;
}

/** App-managed screen sharpening controls, kept outside the driver's graphics apply path. */
export function renderGlobalSharpening(onStateChange?: (state: GlobalSharpeningApplyState) => void, onUnmount?: () => void): HTMLElement {
  const root = el('section', { class: 'postprocess-feature-panel sharpening-card' });
  let generation = 0;
  let state: PostprocessSharpeningGlobal | null = null;
  let draft: PostprocessSharpeningValue = { enabled: false, percentage: 50 };
  let latestRuntimeStatus: { active: boolean; reason?: string; mode?: 'asr' | 'sharpening' | 'scale' } | null = null;
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
    if (button && !busy) button.textContent = 'Save';
  };
  const isDirty = (): boolean => !!state && !!appliedValue
    && (draft.enabled !== appliedValue.enabled || draft.percentage !== appliedValue.percentage);
  const notify = (): void => onStateChange?.({ dirty: isDirty(), busy, canApply: !!state && (state.runtimeReady || !draft.enabled), apply: applyGlobal });

  const legacyWarning = (): HTMLElement[] => {
    if (state?.legacyManifestStatus === 'unreadable') {
      return [el('p', { class: 'profile-capability-note', text: 'Could not check for a previous game-folder sharpening integration.' })];
    }
    const games = state?.legacyIntegrations ?? [];
    if (!games.length) return [];
    const names = games.slice(0, 5).map((game) => game.exePath.split(/[\\/]/).pop() || game.exePath);
    const list = `${names.join(', ')}${games.length > names.length ? ` + ${games.length - names.length} more` : ''}`;
    return [el('p', { class: 'profile-capability-note', text: `Old sharpening integration found: ${list}. Remove it with the previous release while those games are closed.` })];
  };
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
      { value: 'off', label: 'Off' },
      { value: 'on', label: 'On' },
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
        saveStatus = 'Saved';
        if (state.reason) toast('warn', 'Arc Image Sharpening saved', state.reason);
        else toast('success', 'Arc Image Sharpening saved', state.active
          ? 'Updated on the selected window.'
          : 'Press Scale to start it on a game.');
      } catch (err) {
        if (request !== generation || !root.isConnected) return;
        error = err instanceof Error ? err.message : String(err);
        toast('error', 'Arc Image Sharpening failed', error);
      } finally { if (request === generation) { busy = false; if (root.isConnected) { render(); notify(); } } }
    };
    applyGlobal = apply;
    root.replaceChildren(
      el('div', { class: 'sharpening-card-heading' }, [
        el('div', { class: 'sharpening-card-copy' }, [el('h2', { class: 'card-title', text: 'Arc Image Sharpening' }), el('p', { class: 'card-note', text: 'Set strength for selected game windows.' })]),
        el('div', { class: 'sharpening-card-control' }, [select, sliderRow]),
      ]),
      sharpeningHelp('Starts with Scale. It can run alone or with ASR; windowed and borderless modes are recommended.'),
      ...legacyWarning(),
      ...(error ? [el('p', { class: 'text-error', text: error })] : []),
      ...(externalChange ? [el('p', { class: 'settings-sync-status', text: 'Saved settings changed in the other window. Your draft is preserved; Save will overwrite that change.' })] : []),
      el('div', { class: 'graphics-card-actions' }, [
      el('button', { class: 'btn btn-primary btn-sm', text: busy ? 'Saving…' : saveStatus || 'Save', disabled: busy || !state || (!state.runtimeReady && draft.enabled), onclick: () => void apply() }),
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
    if (!dirty || draftMatchesSaved) { draft = { ...update.state.value }; externalChange = false; saveStatus = 'Saved'; }
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
  const root = el('section', { class: 'postprocess-feature-panel asr-card' });
  let generation = 0;
  let state: ArcSuperResolutionState | null = null;
  let draft: ArcSuperResolutionValue = { enabled: false };
  let latestStatus: { active: boolean; reason?: string; mode?: 'asr' | 'sharpening' | 'scale' } | null = null;
  let busy = false;
  let applied = false;
  let error = '';
  let settingsRevision = 0;
  let externalChange = false;
  let pendingPush: import('../types.ts').PostprocessGlobalSettingsUpdate | null = null;

  const render = (): void => {
    const request = generation;
    const select = makeSelect(draft.enabled ? 'on' : 'off', [
      { value: 'off', label: 'Off' },
      { value: 'on', label: 'On' },
    ], (value) => {
      draft.enabled = value === 'on';
      applied = false;
      const button = root.querySelector<HTMLButtonElement>('.asr-apply');
      if (button) button.textContent = 'Save';
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
          ? (state.active ? 'Active on the selected window.' : 'Press Scale to start it on a game.')
          : 'The global ASR preference is Off.');
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
          el('p', { class: 'card-note', text: 'Upscale a smaller game window to your display.' }),
        ]),
        el('div', { class: 'sharpening-card-control' }, [select]),
      ]),
      sharpeningHelp('Scale starts ASR on the selected smaller game window. It can run alone or with sharpening; windowed and borderless modes are recommended.', 'How Scaling Works'),
      ...(error ? [el('p', { class: 'text-error', text: error })] : []),
      ...(externalChange ? [el('p', { class: 'settings-sync-status', text: 'Saved settings changed in the other window. Your draft is preserved; Save will overwrite that change.' })] : []),
      el('div', { class: 'graphics-card-actions' }, [
        el('button', { class: 'btn btn-primary btn-sm asr-apply', text: busy ? 'Saving…' : applied ? 'Saved' : 'Save', disabled: busy || !state || (draft.enabled && !state.runtimeReady), onclick: () => void apply() }),
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
    const snapshot = { active: status.asrActive ?? status.active, mode: independent ? 'asr' as const : status.mode, reason: typeof reason === 'string' ? reason : undefined };
    latestStatus = snapshot;
    if (state) {
      state = { ...state, active: snapshot.active && snapshot.mode === 'asr', reason: snapshot.reason };
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

/** A single global surface for configuring, selecting, and activating screen effects. */
export function renderScreenPostprocessCard(
  onStateChange?: (state: GlobalSharpeningApplyState) => void,
  onUnmount?: () => void,
): HTMLElement {
  const root = el('section', { class: 'card graphics-card postprocess-suite-card' }, [
    el('header', { class: 'postprocess-suite-header' }, [
      el('span', { class: 'postprocess-suite-eyebrow', text: 'DISPLAY EFFECTS' }),
      el('h2', { class: 'card-title', text: 'Arc Image Scaling & Sharpening' }),
      el('p', { class: 'card-note', text: 'Choose your effects, then press Scale to apply them to a game.' }),
    ]),
    el('div', { class: 'postprocess-feature-grid' }, [
      renderGlobalSharpening(onStateChange),
      renderArcSuperResolution(),
    ]),
    renderPostprocessWindowSelector(),
  ]);
  const detachObserver = new MutationObserver(() => {
    if (root.isConnected) return;
    onUnmount?.();
    detachObserver.disconnect();
  });
  detachObserver.observe(document.body, { childList: true, subtree: true });
  return root;
}
