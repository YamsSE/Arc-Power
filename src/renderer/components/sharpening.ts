import { api } from '../ipc.ts';
import { el } from '../dom.ts';
import type { PostprocessSharpeningGame, PostprocessSharpeningGlobal, PostprocessSharpeningValue } from '../types.ts';

const safePercentage = (value: number): number => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

/** App-managed screen sharpening controls, kept outside the driver's graphics apply path. */
export function renderGlobalSharpening(): HTMLElement {
  const root = el('section', { class: 'card graphics-card sharpening-card' });
  let generation = 0;
  let state: PostprocessSharpeningGlobal | null = null;
  let draft: PostprocessSharpeningValue = { enabled: false, percentage: 50 };
  let latestRuntimeStatus: { active: boolean; reason?: string } | null = null;
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
    ?? (state?.active ? 'Sharpening is active on the foreground window.' : state?.runtimeReady ? 'Included with Arc Power · Applies while a supported window is active.' : 'Sharpening is unavailable on this system.');

  const render = (): void => {
    const request = generation;
    const slider = el('input', { type: 'range', class: 'graphics-slider', min: 0, max: 100, step: 1, value: draft.percentage, disabled: busy || !state,
      'aria-label': 'Image sharpening strength', 'aria-valuetext': `${draft.percentage}%`, oninput: (event: Event) => {
        draft.percentage = safePercentage((event.target as HTMLInputElement).valueAsNumber);
        const text = root.querySelector<HTMLElement>('.graphics-fps-value');
        if (text) text.textContent = `${draft.percentage}%`;
        (event.currentTarget as HTMLInputElement).setAttribute('aria-valuetext', `${draft.percentage}%`);
      } });
    const toggle = el('input', { type: 'checkbox', checked: draft.enabled, disabled: busy || !state, 'aria-label': 'Enable app-managed image sharpening', onchange: (event: Event) => { draft.enabled = (event.target as HTMLInputElement).checked; } });
    const apply = async (): Promise<void> => {
      if (busy) return;
      busy = true; error = ''; render();
      try {
        state = await api.postprocessSharpeningSet({ enabled: draft.enabled, percentage: draft.percentage });
        if (latestRuntimeStatus) {
          state = { ...state, active: latestRuntimeStatus.active, reason: latestRuntimeStatus.reason };
        }
        draft = { ...state.value };
      } catch (err) { error = err instanceof Error ? err.message : String(err); }
      finally { busy = false; if (request === generation && root.isConnected) render(); }
    };
    root.replaceChildren(
      el('div', { class: 'graphics-card-heading' }, [el('h2', { class: 'card-title', text: 'Image Sharpening' }), el('label', { class: 'graphics-control graphics-inline-control' }, [toggle, el('span', { text: 'On' })])]),
      el('p', { class: 'card-note', text: 'Sharpens the active window on a display connected to Intel Arc while Arc Power is open. No capture prompt, setup download, or game-folder files are used. Windowed or borderless mode is recommended.' }),
      ...legacyWarning(),
      el('div', { class: 'graphics-fps-slider-row' }, [slider, el('span', { class: 'graphics-fps-value', text: `${draft.percentage}%` })]),
      el('p', { class: 'profile-capability-note sharpening-runtime-status', text: state ? runtimeStatusText() : 'Loading sharpening settings…' }),
      ...(error ? [el('p', { class: 'text-error', text: error })] : []),
      el('div', { class: 'graphics-card-actions' }, [el('button', { class: 'btn btn-primary btn-sm', text: busy ? 'Applying…' : 'Apply sharpening', disabled: busy || !state, onclick: () => void apply() })]),
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
  const root = el('section', { class: 'profile-settings-section game-igs-settings sharpening-card' });
  let generation = 0;
  let state: PostprocessSharpeningGame | null = null;
  let draft: PostprocessSharpeningValue = { enabled: false, percentage: 50 };
  let useGlobal = true;
  let busy = false;
  let error = '';

  const legacyWarning = (): HTMLElement[] => {
    if (state?.legacyManifestStatus === 'unreadable') {
      return [el('p', { class: 'profile-capability-note', text: 'The previous game-folder sharpening manifest could not be checked. Older integrations may remain; this build does not change game files.' })];
    }
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
  const mutate = async (action: () => Promise<PostprocessSharpeningGame>): Promise<void> => {
    if (busy) return;
    const request = generation;
    busy = true; error = ''; render();
    try {
      state = await action();
      useGlobal = state.override === null;
      draft = { ...(state.override ?? state.globalValue) };
    } catch (err) { error = err instanceof Error ? err.message : String(err); }
    finally { busy = false; if (request === generation && root.isConnected) render(); }
  };
  const render = (): void => {
    const globalValue = state?.globalValue ?? { enabled: false, percentage: 50 };
    const slider = el('input', { class: 'profile-setting-control game-setting-control profile-sharpening-slider', type: 'range', min: 0, max: 100, step: 1, value: draft.percentage, disabled: busy || !state || useGlobal,
      'aria-label': 'Per-game image sharpening strength', 'aria-valuetext': `${draft.percentage}%`, oninput: (event: Event) => {
        draft.percentage = safePercentage((event.target as HTMLInputElement).valueAsNumber);
        const label = root.querySelector<HTMLElement>('.sharpening-game-value'); if (label) label.textContent = `${draft.percentage}%`;
        (event.currentTarget as HTMLInputElement).setAttribute('aria-valuetext', `${draft.percentage}%`);
      } });
    const enabled = el('input', { class: 'profile-setting-check game-setting-control', type: 'checkbox', checked: draft.enabled, disabled: busy || !state || useGlobal, 'aria-label': 'Enable per-game image sharpening', onchange: (event: Event) => { draft.enabled = (event.target as HTMLInputElement).checked; } });
    const perform = (fn: () => Promise<PostprocessSharpeningGame>): void => { void mutate(fn); };
    const apply = el('button', { class: 'btn btn-ghost btn-sm', text: 'Apply override', disabled: busy || !state || useGlobal, onclick: () => perform(() => api.postprocessSharpeningGameSet(exePath, { ...draft })) });
    root.replaceChildren(
      el('h3', { class: 'profile-section-title', text: 'Image Sharpening' }),
      el('p', { class: 'profile-capability-note', text: 'Changes sharpening for this game while it is the active window. The global Image Sharpening switch in Graphics must be on.' }),
      ...legacyWarning(),
      ...(state?.reason ? [el('p', { class: 'text-error', text: state.reason })] : []),
      el('label', { class: 'profile-use-toggle' }, [el('input', { type: 'checkbox', checked: useGlobal, disabled: busy || !state, onchange: (event: Event) => {
          const nextUsesGlobal = (event.target as HTMLInputElement).checked;
          perform(() => api.postprocessSharpeningGameSet(exePath, nextUsesGlobal ? null : { ...globalValue }));
        } }), el('span', { text: `Use global (${globalValue.enabled ? 'On' : 'Off'}, ${globalValue.percentage}%)` })]),
        el('div', { class: 'profile-inline-control' }, [enabled, slider, el('span', { class: 'profile-capability-note sharpening-game-value', text: `${draft.percentage}%` })]),
      el('div', { class: 'graphics-card-actions' }, [apply]),
      el('p', { class: 'profile-capability-note', text: 'Changes take effect while this game is running.' }),
      ...(error ? [el('p', { class: 'text-error', text: error })] : []),
      ...(!state ? [el('p', { class: 'profile-capability-note', text: 'Loading game sharpening…' })] : []),
    );
  };
  render(); void load();
  return root;
}
