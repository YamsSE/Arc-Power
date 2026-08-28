// M99 - Arc Power Recording page. The page only talks to the typed preload
// API; the Ascent process, filesystem, and media authorization stay in main.
import { el, clear } from '../dom.ts';
import { api } from '../ipc.ts';
import type { Page, PageContext } from '../router.ts';
import type { RecordingClip, RecordingClipDeleteResult, RecordingEngineState, RecordingMode, RecordingResolution, RecordingSettings } from '../types.ts';
import { toast } from '../components/toast.ts';

const MODES: Array<[RecordingMode, string, string]> = [
  ['full-matches', 'Full Matches', 'Records continuously while you play.'],
  ['clips-only', 'Clips Only', 'Keeps the replay buffer without full recordings.'],
  ['always-on', 'Always On', 'Records full sessions and keeps manual clips available.'],
  ['manual-only', 'Manual Only', 'Only records when you start it manually.'],
];
const RESOLUTIONS: Array<[RecordingResolution, string]> = [
  ['default', 'Default'], ['480p', '480p'], ['720p', '720p'], ['900p', '900p'], ['1080p', '1080p'], ['1440p', '1440p'], ['4k', '4K'],
];

let settings: RecordingSettings | null = null;
let status: RecordingEngineState = { available: false, running: false, mode: null, error: 'Loading recording engine…', encoders: [], hotkeys: { registered: {}, conflicts: {}, error: null } };
let clips: RecordingClip[] = [];
let selectedClip: RecordingClip | null = null;
let activeView: 'settings' | 'library' = 'settings';
let renderContainer: HTMLElement | null = null;
let loading = false;
let unsubscribeRecordingState: (() => void) | null = null;

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function recordingDeleteError(reason: RecordingClipDeleteResult['reason']): string {
  switch (reason) {
    case 'unsupported-platform': return 'Clip deletion is unavailable on Windows until a race-safe delete operation is available.';
    case 'unsafe-path': return 'The clip path failed safety checks.';
    case 'delete-failed': return 'The clip could not be deleted.';
    case 'unavailable': return 'Clip deletion is unavailable.';
    default: return 'The clip could not be deleted.';
  }
}
function button(text: string, onClick: () => void, className = 'btn btn-secondary', disabled = false): HTMLButtonElement {
  return el('button', { class: className, disabled, text, onClick: (event: Event) => { event.preventDefault(); onClick(); } });
}
function select<T extends string>(value: T, options: Array<[T, string]>, onChange: (value: T) => void): HTMLSelectElement {
  const control = el('select', { class: 'recording-select', value }, options.map(([id, label]) => el('option', { value: id, text: label }))) as HTMLSelectElement;
  control.addEventListener('change', () => onChange(control.value as T));
  return control;
}
function field(label: string, control: HTMLElement, note?: string): HTMLElement {
  return el('label', { class: 'recording-field' }, [el('span', { class: 'recording-field-label', text: label }), control, note ? el('span', { class: 'recording-field-note', text: note }) : null]);
}
function savePatch(patch: Partial<Omit<RecordingSettings, 'hotkeys'>> & { hotkeys?: Partial<RecordingSettings['hotkeys']> }): void {
  void api.recordingSettingsSave(patch).then((result) => { settings = result.settings; status = { ...status, hotkeys: result.hotkeys }; render(); }).catch((err) => toast('error', 'Recording settings', messageOf(err)));
}
function renderStatusCard(): HTMLElement {
  const available = status.available;
  const stateText = status.running ? `Recording ${status.mode === 'replay' ? 'replay buffer' : 'video'}` : available ? 'Ready to capture' : 'Runtime unavailable';
  const detail = available
    ? (status.error ?? 'Ascent OBS is ready.')
    : 'Provision a built Ascent runtime with bin\\64bit\\ascent-obs.exe, then set its location below.';
  return el('section', { class: 'card recording-status-card' }, [
    el('div', { class: 'recording-status-heading' }, [
      el('div', { class: 'recording-status-icon', text: '●' }),
      el('div', {}, [el('h2', { class: 'card-title', text: 'Recording' }), el('p', { class: 'card-note', text: detail })]),
      el('span', { class: `recording-status-pill ${available ? status.running ? 'recording-live' : 'recording-ready' : 'recording-missing'}`, text: stateText }),
    ]),
    el('div', { class: 'recording-actions' }, [
      button('Check Runtime', () => void probe(), 'btn btn-secondary'),
      button(status.running ? status.mode === 'replay' ? 'Stop Replay Buffer' : 'Stop Recording' : 'Start Recording', () => void (status.running ? stop() : start()), 'btn btn-primary', !available),
      button('Start Replay Buffer', () => void startReplay(), 'btn btn-secondary', !available || status.running),
      button('Save Replay Clip', () => void saveClip(), 'btn btn-secondary', !available || status.mode !== 'replay'),
    ]),
    status.error && available ? el('p', { class: 'card-note text-warn', text: status.error }) : null,
    status.hotkeys.error ? el('p', { class: 'card-note text-warn', text: `Shortcut registration issue: ${status.hotkeys.error}` }) : null,
  ]);
}

function renderStorage(): HTMLElement {
  const location = el('input', { class: 'recording-input', type: 'text', value: settings?.location ?? '', placeholder: 'Choose a capture folder' }) as HTMLInputElement;
  location.addEventListener('change', () => savePatch({ location: location.value }));
  const runtime = el('input', { class: 'recording-input', type: 'text', value: settings?.runtimePath ?? '', placeholder: 'Optional: path to built Ascent runtime' }) as HTMLInputElement;
  runtime.addEventListener('change', () => savePatch({ runtimePath: runtime.value }));
  return el('section', { class: 'card recording-card' }, [
    el('h2', { class: 'card-title', text: 'Storage & Engine' }),
    el('p', { class: 'card-note', text: 'Choose where captures are saved and, when available, point Arc Power at the external Ascent OBS runtime.' }),
    field('Recording Location', el('div', { class: 'recording-input-row' }, [location, button('Browse', () => void chooseFolder(), 'btn btn-secondary')])),
    field('Ascent Runtime', runtime, 'The folder must contain bin\\64bit\\ascent-obs.exe and the collected OBS runtime files.'),
  ]);
}

function renderCaptureSettings(): HTMLElement {
  const modeCards = MODES.map(([id, title, note]) => el('button', {
    class: `recording-mode-card${settings?.mode === id ? ' selected' : ''}`,
    type: 'button',
    onClick: () => savePatch({ mode: id }),
  }, [el('strong', { text: title }), el('span', { text: note })]));
  const fps = select(String(settings?.fps ?? 60), [['30', '30 FPS'], ['60', '60 FPS'], ['120', '120 FPS']], (value) => savePatch({ fps: Number(value) as 30 | 60 | 120 }));
  const resolution = select(settings?.resolution ?? '1080p', RESOLUTIONS, (value) => savePatch({ resolution: value }));
  const bitrate = el('input', { class: 'recording-number', type: 'number', min: 100, max: 200000, step: 100, value: settings?.bitrateKbps ?? 8000 }) as HTMLInputElement;
  bitrate.addEventListener('change', () => savePatch({ bitrateKbps: Number(bitrate.value) }));
  const replay = el('input', { class: 'recording-number', type: 'number', min: 5, max: 3600, step: 5, value: settings?.replayLengthSec ?? 30 }) as HTMLInputElement;
  replay.addEventListener('change', () => savePatch({ replayLengthSec: Number(replay.value) }));
  const encoders: Array<[string, string]> = [['automatic', 'Automatic']];
  for (const encoder of status.encoders) {
    if (encoder.startTested && !encoder.startSupported) continue;
    encoders.push([encoder.type, encoder.description]);
  }
  const encoder = select(settings?.encoderId ?? 'automatic', encoders, (value) => savePatch({ encoderId: value }));
  return el('section', { class: 'card recording-card' }, [
    el('h2', { class: 'card-title', text: 'Capture Settings' }),
    el('p', { class: 'card-note', text: 'These controls mirror the practical recording choices from Ascent while keeping support tied to the runtime probe.' }),
    el('div', { class: 'recording-mode-grid' }, modeCards),
    el('div', { class: 'recording-form-grid' }, [
      field('Frame Rate', fps), field('Output Resolution', resolution), field('Encoder', encoder, status.encoders.length ? 'Only encoders returned by Ascent are shown.' : 'Probe the provisioned runtime to discover Intel QSV H264, HEVC, and AV1.'),
      field('Bitrate (Kbps)', bitrate), field('Replay Length (seconds)', replay), field('Rate Control', el('input', { class: 'recording-input', type: 'text', value: 'CBR', disabled: true }, []), 'Ascent recording uses constant bitrate for this first integration.'),
    ]),
  ]);
}

function renderHotkeys(): HTMLElement {
  const make = (key: 'start' | 'stop' | 'saveClip', label: string) => {
    const input = el('input', { class: 'recording-hotkey', type: 'text', value: settings?.hotkeys[key] ?? '', maxlength: 32 }) as HTMLInputElement;
    input.addEventListener('change', () => savePatch({ hotkeys: { [key]: input.value } as Partial<RecordingSettings['hotkeys']> }));
    const conflict = status.hotkeys.conflicts[key];
    return el('div', { class: 'recording-hotkey-row' }, [el('span', { text: label }), input, conflict ? el('span', { class: 'text-warn', text: `Not registered (${conflict} is in use)` }) : null]);
  };
  return el('section', { class: 'card recording-card' }, [el('h2', { class: 'card-title', text: 'Manual Recording' }), el('p', { class: 'card-note', text: 'Global shortcuts are registered by the main process and checked against Arc Power overlay shortcuts.' }), make('start', 'Start Recording'), make('stop', 'Stop Recording'), make('saveClip', 'Save Replay Clip')]);
}

function renderSettingsView(): HTMLElement { return el('div', { class: 'recording-stack' }, [renderStorage(), renderCaptureSettings(), renderHotkeys()]); }

function renderLibraryView(): HTMLElement {
  const query = el('input', { class: 'recording-search', type: 'search', placeholder: 'Search clips…' }) as HTMLInputElement;
  const grid = el('div', { class: 'recording-clip-grid' });
  const draw = () => {
    clear(grid);
    const needle = query.value.trim().toLowerCase();
    const visible = clips.filter((clip) => !needle || clip.fileName.toLowerCase().includes(needle));
    if (visible.length === 0) grid.append(el('p', { class: 'card-note recording-empty', text: 'No recordings found yet.' }));
    for (const clip of visible) {
      const card = el('article', { class: `recording-clip-card${selectedClip?.id === clip.id ? ' selected' : ''}` }, [
        el('button', { class: 'recording-clip-card-main', type: 'button', onClick: () => selectClip(clip) }, [
          el('span', { class: 'recording-clip-placeholder', text: '▶' }),
          el('strong', { text: clip.fileName }),
          el('span', { class: 'recording-clip-meta', text: new Date(clip.createdAt).toLocaleString() }),
        ]),
        el('div', { class: 'recording-clip-card-actions' }, [button('Delete', () => void deleteClip(clip), 'btn btn-danger')]),
      ]);
      grid.append(card);
    }
  };
  query.addEventListener('input', draw);
  draw();
  const player = el('div', { class: 'recording-player' }, [el('p', { class: 'card-note', text: selectedClip ? 'Loading clip…' : 'Select a clip to play it here.' })]);
  if (selectedClip) {
    void api.recordingClipUrl(selectedClip.id).then((url) => {
      clear(player);
      player.append(el('video', { class: 'recording-video', controls: true, preload: 'metadata', src: url }) as HTMLVideoElement);
    }).catch((err) => { clear(player); player.append(el('p', { class: 'text-error', text: messageOf(err) })); });
  }
  return el('div', { class: 'recording-library' }, [el('div', { class: 'recording-library-toolbar' }, [query, button('Refresh', () => void loadClips(), 'btn btn-secondary'), button('Open Folder', () => void api.recordingOpenFolder().catch((err) => toast('error', 'Clip folder', messageOf(err))), 'btn btn-secondary')]), grid, player]);
}

function render(): void {
  if (!renderContainer) return;
  clear(renderContainer);
  renderContainer.append(el('div', { class: 'page-heading recording-heading' }, [el('div', {}, [el('h1', { text: 'Recording' }), el('p', { text: 'Capture gameplay with the Ascent OBS engine and manage your clips.' })]), el('div', { class: 'recording-view-tabs' }, [button('Settings', () => { activeView = 'settings'; render(); }, `btn ${activeView === 'settings' ? 'btn-primary' : 'btn-secondary'}`), button('Clip Library', () => { activeView = 'library'; render(); }, `btn ${activeView === 'library' ? 'btn-primary' : 'btn-secondary'}`)])]), renderStatusCard(), activeView === 'settings' ? renderSettingsView() : renderLibraryView());
}

async function loadClips(): Promise<void> { try { clips = await api.recordingClipsList(); render(); } catch (err) { toast('error', 'Clip library', messageOf(err)); } }
async function load(): Promise<void> {
  if (loading) return;
  loading = true;
  try { [settings, status, clips] = await Promise.all([api.recordingSettingsGet(), api.recordingStatus(), api.recordingClipsList()]); }
  catch (err) { status = { ...status, error: messageOf(err) }; }
  finally { loading = false; render(); }
}
async function probe(): Promise<void> { try { status = await api.recordingRuntimeProbe(); await loadClips(); } catch (err) { status = { ...status, available: false, error: messageOf(err) }; render(); } }
async function start(): Promise<void> { try { const result = await api.recordingStart(); status = result.state; await loadClips(); render(); } catch (err) { toast('error', 'Start recording', messageOf(err)); status = { ...status, error: messageOf(err) }; render(); } }
async function startReplay(): Promise<void> { try { const result = await api.recordingReplayStart(); status = result.state; render(); } catch (err) { toast('error', 'Start replay buffer', messageOf(err)); status = { ...status, error: messageOf(err) }; render(); } }
async function stop(): Promise<void> { try { status = await api.recordingStop(); await loadClips(); render(); } catch (err) { toast('error', 'Stop recording', messageOf(err)); } }
async function saveClip(): Promise<void> { try { await api.recordingClipSave({}); await loadClips(); toast('success', 'Clip saved', 'The replay clip was added to the library.'); } catch (err) { toast('error', 'Save clip', messageOf(err)); } }
async function deleteClip(clip: RecordingClip): Promise<void> {
  if (!window.confirm(`Delete ${clip.fileName}?`)) return;
  try {
    const result = await api.recordingClipDelete(clip.id);
    if (!result.ok) {
      if (result.reason === 'not-found') {
        if (selectedClip?.id === clip.id) selectedClip = null;
        await loadClips();
        return;
      }
      throw new Error(recordingDeleteError(result.reason));
    }
    if (selectedClip?.id === clip.id) selectedClip = null;
    await loadClips();
    toast('success', 'Clip deleted', `${clip.fileName} was removed.`);
  } catch (err) { toast('error', 'Delete clip', messageOf(err)); }
}
async function chooseFolder(): Promise<void> { try { const result = await api.recordingChooseFolder(); if (!result.canceled) { settings = result.settings; render(); } } catch (err) { toast('error', 'Recording folder', messageOf(err)); } }
function selectClip(clip: RecordingClip): void { selectedClip = clip; render(); }

export const recordingPage: Page = {
  id: 'recording',
  render(container: HTMLElement): void {
    renderContainer = container;
    if (!unsubscribeRecordingState) {
      unsubscribeRecordingState = api.onRecordingStateUpdated((next) => {
        status = next;
        if (renderContainer === container) render();
      });
    }
    void load();
  },
  leave(): void { unsubscribeRecordingState?.(); unsubscribeRecordingState = null; renderContainer = null; selectedClip = null; },
};
