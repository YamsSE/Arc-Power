import { api } from '../ipc.ts';
import { el } from '../dom.ts';
import type { PostprocessSharpeningGame, PostprocessSharpeningGlobal, PostprocessSharpeningValue } from '../types.ts';

const safePercentage = (value: number): number => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

/** App-managed post-process controls, kept outside the driver's graphics apply path. */
export function renderGlobalSharpening(): HTMLElement {
  const root = el('section', { class: 'card graphics-card sharpening-card' });
  let generation = 0;
  let state: PostprocessSharpeningGlobal | null = null;
  let draft: PostprocessSharpeningValue = { enabled: false, percentage: 50 };
  let busy = false;
  let error = '';

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
        draft = { ...state.value };
      } catch (err) { error = err instanceof Error ? err.message : String(err); }
      finally { busy = false; if (request === generation && root.isConnected) render(); }
    };
    root.replaceChildren(
      el('div', { class: 'graphics-card-heading' }, [el('h2', { class: 'card-title', text: 'Image Sharpening' }), el('label', { class: 'graphics-control graphics-inline-control' }, [toggle, el('span', { text: 'On' })])]),
      el('p', { class: 'card-note', text: 'Sharpens supported 64-bit DirectX 11/12 games with Arc Power’s shader. Set up each game in Profiles first. Shared across GPUs.' }),
      el('div', { class: 'graphics-fps-slider-row' }, [slider, el('span', { class: 'graphics-fps-value', text: `${draft.percentage}%` })]),
      el('p', { class: 'profile-capability-note', text: state ? `${state.managedGameCount} game${state.managedGameCount === 1 ? '' : 's'} set up · ${state.runtimeReady ? 'Included with Arc Power' : 'Sharpening runtime is missing or damaged'} · Restart games after changes.` : 'Loading sharpening settings…' }),
      ...(error ? [el('p', { class: 'text-error', text: error })] : []),
      el('div', { class: 'graphics-card-actions' }, [el('button', { class: 'btn btn-primary btn-sm', text: busy ? 'Applying…' : 'Apply sharpening', disabled: busy || !state, onclick: () => void apply() })]),
    );
  };
  render();
  const request = ++generation;
  void api.postprocessSharpeningGet().then((value) => {
    if (request !== generation || !root.isConnected) return;
    state = value; draft = { ...value.value }; render();
  }).catch((err: unknown) => {
    if (request !== generation || !root.isConnected) return;
    error = err instanceof Error ? err.message : String(err); render();
  });
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
    const installed = state?.installed === true;
    const slider = el('input', { class: 'profile-setting-control game-setting-control profile-sharpening-slider', type: 'range', min: 0, max: 100, step: 1, value: draft.percentage, disabled: busy || !installed || useGlobal,
      'aria-label': 'Per-game image sharpening strength', 'aria-valuetext': `${draft.percentage}%`, oninput: (event: Event) => {
        draft.percentage = safePercentage((event.target as HTMLInputElement).valueAsNumber);
        const label = root.querySelector<HTMLElement>('.sharpening-game-value'); if (label) label.textContent = `${draft.percentage}%`;
        (event.currentTarget as HTMLInputElement).setAttribute('aria-valuetext', `${draft.percentage}%`);
      } });
    const enabled = el('input', { class: 'profile-setting-check game-setting-control', type: 'checkbox', checked: draft.enabled, disabled: busy || !installed || useGlobal, 'aria-label': 'Enable per-game image sharpening', onchange: (event: Event) => { draft.enabled = (event.target as HTMLInputElement).checked; } });
    const perform = (fn: () => Promise<PostprocessSharpeningGame>): void => { void mutate(fn); };
    const apply = el('button', { class: 'btn btn-ghost btn-sm', text: 'Apply override', disabled: busy || !installed || useGlobal, onclick: () => perform(() => api.postprocessSharpeningGameSet(exePath, { ...draft })) });
    root.replaceChildren(
      el('h3', { class: 'profile-section-title', text: 'Image Sharpening' }),
      el('p', { class: 'profile-capability-note', text: 'Uses Arc Power’s shader through ReShade for 64-bit DirectX 11/12 games.' }),
      ...(state?.reason ? [el('p', { class: 'text-error', text: state.reason })] : []),
      ...(installed ? [
        el('label', { class: 'profile-use-toggle' }, [el('input', { type: 'checkbox', checked: useGlobal, disabled: busy, onchange: (event: Event) => {
          const nextUsesGlobal = (event.target as HTMLInputElement).checked;
          perform(() => api.postprocessSharpeningGameSet(exePath, nextUsesGlobal ? null : { ...state!.globalValue }));
        } }), el('span', { text: `Use global (${state!.globalValue.enabled ? 'On' : 'Off'}, ${state!.globalValue.percentage}%)` })]),
        el('div', { class: 'profile-inline-control' }, [enabled, slider, el('span', { class: 'profile-capability-note sharpening-game-value', text: `${draft.percentage}%` })]),
        el('div', { class: 'graphics-card-actions' }, [apply, el('button', { class: 'btn btn-ghost btn-sm', text: busy ? 'Working…' : 'Remove sharpening', disabled: busy, onclick: () => perform(() => api.postprocessSharpeningRemove(exePath)) })]),
        el('p', { class: 'profile-capability-note', text: 'Changes require a game restart.' }),
      ] : [el('button', { class: 'btn btn-primary btn-sm', text: busy ? 'Setting up…' : 'Set up sharpening', title: 'Installs the included sharpening files for this game. Restart the game after setup.', disabled: busy || !state, onclick: () => perform(() => api.postprocessSharpeningInstall(exePath)) }), el('p', { class: 'profile-capability-note', text: 'Installs the included sharpening files for this game. Restart the game after setup.' })]),
      ...(error ? [el('p', { class: 'text-error', text: error })] : []),
      ...(!state ? [el('p', { class: 'profile-capability-note', text: 'Loading game sharpening…' })] : []),
    );
  };
  render(); void load();
  return root;
}
