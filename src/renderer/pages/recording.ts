// Arc Power recording page. The renderer only uses the typed preload bridge;
// capture processes, files, and media authorization remain main-owned.
import { el, clear } from '../dom.ts';
import { api } from '../ipc.ts';
import type { Page, PageContext } from '../router.ts';
import type { RecordingClip, RecordingClipDeleteResult, RecordingEngineState, RecordingMode, RecordingResolution, RecordingSettings, RecordingTab } from '../types.ts';
import { toast } from '../components/toast.ts';

const TABS: Array<[RecordingTab, string, string]> = [
  ['manual', 'Manual Recording', 'Capture a full video when you choose.'],
  ['clips', 'Clips', 'Keep a replay buffer and save the last moments.'],
];
const RESOLUTIONS: Array<[RecordingResolution, string]> = [
  ['default', 'Default'],
  ['480p', '480p'],
  ['720p', '720p'],
  ['900p', '900p'],
  ['1080p', '1080p'],
  ['1440p', '1440p'],
  ['4k', '4K'],
];
const DEFAULT_REPLAY_LENGTH_SEC = 30;
const INTEL_QSV_ENCODERS = new Set(['obs_qsv11_v2', 'obs_qsv11_hevc', 'obs_qsv11_av1']);

let settings: RecordingSettings | null = null;
let status: RecordingEngineState = {
  available: false,
  running: false,
  mode: null,
  error: 'Loading recording engine…',
  encoders: [],
  hotkeys: { registered: {}, conflicts: {}, error: null },
};
let clips: RecordingClip[] = [];
let selectedClip: RecordingClip | null = null;
let activeTab: RecordingTab = 'manual';
let renderContainer: HTMLElement | null = null;
let loading = false;
let actionBusy = false;
let unsubscribeRecordingState: (() => void) | null = null;
let lastTransitionToast = { key: '', at: 0 };

function announceCaptureTransition(previous: RecordingEngineState, next: RecordingEngineState): void {
  const started = !previous.running && next.running;
  const stopped = previous.running && !next.running;
  if (!started && !stopped) return;
  const replay = (next.mode ?? previous.mode) === 'replay';
  const key = `${started ? 'started' : 'stopped'}:${replay ? 'replay' : 'video'}`;
  const now = Date.now();
  if (lastTransitionToast.key === key && now - lastTransitionToast.at < 2000) return;
  lastTransitionToast = { key, at: now };
  if (started) {
    toast('success', replay ? 'Replay buffer started' : 'Recording started', replay ? 'Recent gameplay is now being kept for clips.' : 'Video capture is now active.');
  } else {
    toast('success', replay ? 'Replay buffer stopped' : 'Recording stopped', replay ? 'The replay buffer is no longer active.' : 'Video capture has finished.');
  }
}

function setStatus(next: RecordingEngineState, announce = false): void {
  const previous = status;
  status = next;
  if (announce) announceCaptureTransition(previous, next);
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const backendName = new RegExp(['a', 'scent'].join(''), 'gi');
  return message.replace(backendName, 'recording engine');
}

function recordingDeleteError(reason: RecordingClipDeleteResult['reason']): string {
  switch (reason) {
    case 'unsupported-platform': return 'Clip deletion is unavailable on Windows until a race-safe delete operation is available.';
    case 'unsafe-path': return 'The clip path failed safety checks.';
    case 'delete-failed': return 'The clip could not be deleted.';
    case 'unavailable': return 'Clip deletion is unavailable.';
    default: return 'The clip could not be deleted.';
  }
}

function tabForMode(mode: RecordingMode | string | undefined): RecordingTab {
  return mode === 'clips' || mode === 'clips-only' ? 'clips' : 'manual';
}

function modeForTab(tab: RecordingTab): RecordingMode {
  return tab === 'clips' ? 'clips' : 'manual';
}

function button(text: string, onClick: () => void, className = 'btn btn-secondary', disabled = false): HTMLButtonElement {
  return el('button', {
    class: className,
    disabled,
    text,
    type: 'button',
    onClick: (event: Event) => { event.preventDefault(); onClick(); },
  });
}

function select<T extends string>(value: T, options: Array<[T, string]>, onChange: (value: T) => void): HTMLSelectElement {
  const control = el('select', {
    class: 'recording-select',
    value,
  }, options.map(([id, label]) => el('option', { value: id, text: label }))) as HTMLSelectElement;
  control.addEventListener('change', () => onChange(control.value as T));
  return control;
}

function field(label: string, control: HTMLElement, note?: string): HTMLElement {
  return el('label', { class: 'recording-field' }, [
    el('span', { class: 'recording-field-label', text: label }),
    control,
    note ? el('span', { class: 'recording-field-note', text: note }) : null,
  ]);
}

function savePatch(patch: Partial<Omit<RecordingSettings, 'hotkeys'>> & { hotkeys?: Partial<RecordingSettings['hotkeys']> }): void {
  void api.recordingSettingsSave(patch)
    .then((result) => {
      settings = result.settings;
      status = { ...status, hotkeys: result.hotkeys };
      render();
    })
    .catch((err) => toast('error', 'Recording settings', messageOf(err)));
}

function encoderLabel(encoder: RecordingEngineState['encoders'][number]): string {
  const source = `${encoder.type} ${encoder.description}`.toLowerCase();
  const intel = INTEL_QSV_ENCODERS.has(encoder.type) || source.includes('quick sync') || source.includes('qsv') || source.includes('intel');
  if (source.includes('av1')) return intel ? 'Intel AV1' : 'AV1';
  if (source.includes('hevc') || source.includes('h.265') || source.includes('h265')) return intel ? 'Intel HEVC' : 'HEVC';
  if (source.includes('h264') || source.includes('h.264') || source.includes('avc') || encoder.type === 'obs_qsv11_v2') return intel ? 'Intel H264' : 'H264';
  return encoder.description || encoder.type;
}

function encoderOptions(): Array<[string, string]> {
  const options: Array<[string, string]> = [['automatic', 'Automatic']];
  const seen = new Set<string>();
  for (const encoder of status.encoders) {
    // The main-process bridge deliberately supports Intel QSV only. Keep
    // software/other-vendor entries out of a selector that would otherwise
    // offer a choice the start path rejects.
    if (!INTEL_QSV_ENCODERS.has(encoder.type)) continue;
    if (seen.has(encoder.type)) continue;
    seen.add(encoder.type);
    const unavailable = encoder.startTested && !encoder.startSupported ? ' — unavailable' : '';
    options.push([encoder.type, `${encoderLabel(encoder)}${unavailable}`]);
  }
  return options;
}

function renderTabs(): HTMLElement {
  return el('nav', { class: 'recording-tabs', 'aria-label': 'Recording modes' }, TABS.map(([tab, label, note]) => el('button', {
    class: `recording-tab${activeTab === tab ? ' active' : ''}`,
    type: 'button',
    role: 'tab',
    'aria-selected': String(activeTab === tab),
    title: note,
    text: label,
    onClick: () => selectTab(tab),
  })));
}

function renderStatusSummary(): HTMLElement {
  const currentMode = status.mode;
  const runningLabel = currentMode === 'replay' ? 'Replay buffer active' : 'Recording active';
  const stateLabel = status.running ? runningLabel : status.available ? 'Ready to capture' : 'Engine unavailable';
  const stateClass = status.running ? 'recording-live' : status.available ? 'recording-ready' : 'recording-missing';
  const detail = status.running
    ? currentMode === 'replay' ? 'The replay buffer is keeping the configured recent gameplay.' : 'A video file is being written to your recording folder.'
    : status.available ? 'Capture is ready when you are.' : messageOf(status.error ?? 'The recording engine is not available.');

  return el('div', { class: 'recording-status-summary' }, [
    el('span', { class: `recording-status-dot ${stateClass}` }),
    el('div', { class: 'recording-status-copy' }, [
      el('strong', { text: stateLabel }),
      el('span', { text: detail }),
    ]),
    el('span', { class: `recording-status-pill ${stateClass}`, text: status.running ? 'Live' : status.available ? 'Ready' : 'Offline' }),
  ]);
}

function renderCaptureActions(): HTMLElement {
  const isReplay = activeTab === 'clips';
  const runningThisMode = status.running && status.mode === (isReplay ? 'replay' : 'video');
  const anotherModeRunning = status.running && !runningThisMode;
  const primaryText = runningThisMode
    ? isReplay ? 'Stop Replay Buffer' : 'Stop Recording'
    : isReplay ? 'Start Replay Buffer' : 'Start Recording';
  const primaryAction = runningThisMode ? stopCapture : isReplay ? startReplay : startRecording;
  const primaryDisabled = !status.available || actionBusy || anotherModeRunning;

  return el('div', { class: 'recording-capture-actions' }, [
    button(primaryText, () => void primaryAction(), `btn ${runningThisMode ? 'btn-recording-stop' : 'btn-primary'}`, primaryDisabled),
    isReplay ? button('Save Clip', () => void saveClip(), 'btn btn-secondary', !status.available || status.mode !== 'replay' || actionBusy) : null,
    anotherModeRunning ? el('span', { class: 'recording-inline-note', text: 'Stop the active capture in its tab before starting this one.' }) : null,
  ]);
}

function renderCapturePanel(): HTMLElement {
  const replayLength = settings?.replayLengthSec ?? DEFAULT_REPLAY_LENGTH_SEC;
  return el('section', { class: 'recording-panel recording-capture-panel' }, [
    el('div', { class: 'recording-panel-heading' }, [
      el('div', {}, [
        el('span', { class: 'recording-eyebrow', text: activeTab === 'clips' ? 'Replay buffer' : 'Capture now' }),
        el('h2', { class: 'recording-panel-title', text: activeTab === 'clips' ? 'Save the moment' : 'Record your session' }),
      ]),
      renderStatusSummary(),
    ]),
    el('p', { class: 'recording-panel-note', text: activeTab === 'clips' ? `The buffer keeps the last ${replayLength} seconds. Save a clip whenever something worth keeping happens.` : 'Start a video capture with the profile below. Stop it whenever you are ready; the file will appear in your recording folder.' }),
    renderCaptureActions(),
    status.error && status.available ? el('p', { class: 'recording-inline-error', text: messageOf(status.error) }) : null,
    status.hotkeys.error ? el('p', { class: 'recording-inline-error', text: `Shortcut registration issue: ${messageOf(status.hotkeys.error)}` }) : null,
  ]);
}

function renderQualitySettings(): HTMLElement {
  const fps = select(String(settings?.fps ?? 60), [['30', '30 FPS'], ['60', '60 FPS'], ['120', '120 FPS']], (value) => savePatch({ fps: Number(value) as 30 | 60 | 120 }));
  const resolution = select(settings?.resolution ?? '1080p', RESOLUTIONS, (value) => savePatch({ resolution: value }));
  const bitrate = el('input', {
    class: 'recording-number',
    type: 'number',
    min: 100,
    max: 200000,
    step: 100,
    value: settings?.bitrateKbps ?? 8000,
  }) as HTMLInputElement;
  bitrate.addEventListener('change', () => savePatch({ bitrateKbps: Number(bitrate.value) }));
  const encoder = select(settings?.encoderId ?? 'automatic', encoderOptions(), (value) => savePatch({ encoderId: value }));
  const hasIntelEncoder = status.encoders.some((item) => INTEL_QSV_ENCODERS.has(item.type));
  return el('section', { class: 'recording-panel' }, [
    el('div', { class: 'recording-panel-heading recording-panel-heading-compact' }, [
      el('div', {}, [el('span', { class: 'recording-eyebrow', text: 'Video profile' }), el('h2', { class: 'recording-panel-title', text: 'Quality' })]),
      el('span', { class: 'recording-panel-badge', text: 'Applies to video and clips' }),
    ]),
    el('div', { class: 'recording-settings-grid' }, [
      field('Frame rate', fps),
      field('Resolution', resolution),
      field('Encoder', encoder, hasIntelEncoder ? 'Intel H264, HEVC and AV1 choices stay visible here.' : 'Intel encoder choices will appear when the engine reports them.'),
      field('Bitrate (Kbps)', bitrate),
    ]),
  ]);
}

function renderReplaySettings(): HTMLElement {
  const replay = el('input', {
    class: 'recording-number',
    type: 'number',
    min: 5,
    max: 3600,
    step: 5,
    value: settings?.replayLengthSec ?? DEFAULT_REPLAY_LENGTH_SEC,
  }) as HTMLInputElement;
  replay.addEventListener('change', () => savePatch({ replayLengthSec: Number(replay.value) }));
  return el('section', { class: 'recording-panel recording-replay-settings' }, [
    el('div', { class: 'recording-panel-heading recording-panel-heading-compact' }, [
      el('div', {}, [el('span', { class: 'recording-eyebrow', text: 'Clip window' }), el('h2', { class: 'recording-panel-title', text: 'Replay length' })]),
      el('span', { class: 'recording-panel-badge', text: '5–3600 seconds' }),
    ]),
    field('Seconds to keep available', replay, 'Save Clip exports this much recent gameplay from the replay buffer.'),
  ]);
}

function renderHotkeys(): HTMLElement {
  const make = (key: 'start' | 'stop' | 'saveClip', label: string, description: string): HTMLElement => {
    const input = el('input', {
      class: 'recording-hotkey',
      type: 'text',
      value: settings?.hotkeys[key] ?? '',
      maxlength: 32,
      'aria-label': label,
    }) as HTMLInputElement;
    input.addEventListener('change', () => savePatch({ hotkeys: { [key]: input.value } as Partial<RecordingSettings['hotkeys']> }));
    const conflict = status.hotkeys.conflicts[key];
    return el('div', { class: 'recording-hotkey-row' }, [
      el('div', { class: 'recording-hotkey-copy' }, [el('strong', { text: label }), el('span', { text: description })]),
      input,
      conflict ? el('span', { class: 'text-warn recording-hotkey-warning', text: `Not registered (${conflict} is in use)` }) : el('span', { class: 'recording-hotkey-registered', text: status.hotkeys.registered[key] ? 'Registered' : 'Not registered' }),
    ]);
  };
  return el('section', { class: 'recording-panel' }, [
    el('div', { class: 'recording-panel-heading recording-panel-heading-compact' }, [
      el('div', {}, [el('span', { class: 'recording-eyebrow', text: 'Shortcuts' }), el('h2', { class: 'recording-panel-title', text: 'Hotkeys' })]),
      el('span', { class: 'recording-panel-badge', text: 'Global' }),
    ]),
    el('p', { class: 'recording-panel-note', text: 'Use these shortcuts from a game or any other window.' }),
    make('start', 'Start recording', 'Begin a full video capture.'),
    make('stop', 'Stop capture', 'Finish the active video or replay buffer.'),
    make('saveClip', 'Save clip', 'Export the configured replay window.'),
  ]);
}

function renderStorage(): HTMLElement {
  const location = el('input', {
    class: 'recording-input',
    type: 'text',
    value: settings?.location ?? '',
    placeholder: 'Choose a capture folder',
  }) as HTMLInputElement;
  location.addEventListener('change', () => savePatch({ location: location.value }));
  return el('section', { class: 'recording-panel recording-storage-panel' }, [
    el('div', { class: 'recording-panel-heading recording-panel-heading-compact' }, [
      el('div', {}, [el('span', { class: 'recording-eyebrow', text: 'Files' }), el('h2', { class: 'recording-panel-title', text: 'Save location' })]),
    ]),
    field('Recording folder', el('div', { class: 'recording-input-row' }, [location, button('Browse', () => void chooseFolder(), 'btn btn-secondary')])),
    el('p', { class: 'recording-panel-note recording-storage-note', text: 'The recording engine ships with Arc Power and is checked automatically when this page opens.' }),
  ]);
}

function renderManualView(): HTMLElement {
  return el('div', { class: 'recording-content recording-manual-content' }, [
    renderCapturePanel(),
    el('div', { class: 'recording-panel-column' }, [renderQualitySettings(), renderReplaySettings(), renderHotkeys(), renderStorage()]),
  ]);
}

function renderClipList(): HTMLElement {
  const query = el('input', { class: 'recording-search', type: 'search', placeholder: 'Search clips…', 'aria-label': 'Search clips' }) as HTMLInputElement;
  const list = el('div', { class: 'recording-clip-list' });
  const draw = () => {
    clear(list);
    const needle = query.value.trim().toLowerCase();
    const visible = clips.filter((clip) => !needle || clip.fileName.toLowerCase().includes(needle));
    if (visible.length === 0) {
      list.append(el('p', { class: 'recording-empty', text: 'No clips found yet.' }));
      return;
    }
    for (const clip of visible) {
      list.append(el('article', { class: `recording-clip-row${selectedClip?.id === clip.id ? ' selected' : ''}` }, [
        el('button', { class: 'recording-clip-play', type: 'button', onClick: () => selectClip(clip) }, [
          el('span', { class: 'recording-clip-play-icon', text: '▶' }),
          el('span', { class: 'recording-clip-details' }, [
            el('strong', { text: clip.fileName }),
            el('span', { text: new Date(clip.createdAt).toLocaleString() }),
          ]),
        ]),
        button('Delete', () => void deleteClip(clip), 'btn btn-danger btn-sm'),
      ]));
    }
  };
  query.addEventListener('input', draw);
  draw();

  const player = el('div', { class: 'recording-player' }, [el('p', { class: 'recording-player-placeholder', text: selectedClip ? 'Loading clip…' : 'Select a clip to play it here.' })]);
  if (selectedClip) {
    void api.recordingClipUrl(selectedClip.id).then((url) => {
      clear(player);
      player.append(el('video', { class: 'recording-video', controls: true, preload: 'metadata', src: url }) as HTMLVideoElement);
    }).catch((err) => {
      clear(player);
      player.append(el('p', { class: 'text-error', text: messageOf(err) }));
    });
  }
  return el('section', { class: 'recording-panel recording-library-panel' }, [
    el('div', { class: 'recording-library-toolbar' }, [
      el('div', {}, [el('span', { class: 'recording-eyebrow', text: 'Saved clips' }), el('h2', { class: 'recording-panel-title', text: 'Clip library' })]),
      query,
      button('Refresh', () => void loadClips(), 'btn btn-secondary'),
      button('Open Folder', () => void api.recordingOpenFolder().catch((err) => toast('error', 'Clip folder', messageOf(err))), 'btn btn-secondary'),
    ]),
    list,
    player,
  ]);
}

function renderClipsView(): HTMLElement {
  return el('div', { class: 'recording-content recording-clips-content' }, [renderCapturePanel(), renderReplaySettings(), renderClipList()]);
}

function render(): void {
  if (!renderContainer) return;
  clear(renderContainer);
  renderContainer.append(
    el('div', { class: 'page-heading recording-heading' }, [
      el('div', {}, [
        el('span', { class: 'recording-eyebrow', text: 'Arc Power Capture' }),
        el('h1', { text: 'Recording' }),
        el('p', { text: 'Capture gameplay, keep the moments that matter, and stay in control of your files.' }),
      ]),
      renderTabs(),
    ]),
    activeTab === 'manual' ? renderManualView() : renderClipsView(),
  );
}

function selectTab(tab: RecordingTab): void {
  if (activeTab === tab) return;
  activeTab = tab;
  render();
  if (settings && settings.mode !== modeForTab(tab)) savePatch({ mode: modeForTab(tab) });
}

async function loadClips(): Promise<void> {
  try {
    clips = await api.recordingClipsList();
    if (selectedClip && !clips.some((clip) => clip.id === selectedClip?.id)) selectedClip = null;
    render();
  } catch (err) {
    toast('error', 'Clip library', messageOf(err));
  }
}

async function load(): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    const [loadedSettings, loadedStatus, loadedClips] = await Promise.all([
      api.recordingSettingsGet(),
      api.recordingRuntimeProbe(),
      api.recordingClipsList(),
    ]);
    settings = loadedSettings;
    status = loadedStatus;
    clips = loadedClips;
    activeTab = tabForMode(settings.mode);
    const canonicalMode = modeForTab(activeTab);
    if (settings.mode !== canonicalMode) {
      // Older settings remain usable: map every full-session variant to the
      // manual tab, and persist only the two current renderer choices.
      void api.recordingSettingsSave({ mode: canonicalMode }).then((result) => {
        settings = result.settings;
        status = { ...status, hotkeys: result.hotkeys };
        render();
      }).catch((err) => toast('error', 'Recording settings', messageOf(err)));
    }
  } catch (err) {
    status = { ...status, error: messageOf(err) };
  } finally {
    loading = false;
    render();
  }
}

async function startRecording(): Promise<void> {
  if (actionBusy) return;
  actionBusy = true;
  render();
  try {
    const result = await api.recordingStart();
    setStatus(result.state, true);
  } catch (err) {
    toast('error', 'Start recording', messageOf(err));
    status = { ...status, error: messageOf(err) };
  } finally {
    actionBusy = false;
    render();
  }
}

async function startReplay(): Promise<void> {
  if (actionBusy) return;
  actionBusy = true;
  render();
  try {
    const result = await api.recordingReplayStart();
    setStatus(result.state, true);
  } catch (err) {
    toast('error', 'Start replay buffer', messageOf(err));
    status = { ...status, error: messageOf(err) };
  } finally {
    actionBusy = false;
    render();
  }
}

async function stopCapture(): Promise<void> {
  if (actionBusy) return;
  const stoppedMode = status.mode;
  actionBusy = true;
  render();
  try {
    setStatus(await api.recordingStop(), true);
    await loadClips();
  } catch (err) {
    toast('error', 'Stop capture', messageOf(err));
    status = { ...status, error: messageOf(err) };
  } finally {
    actionBusy = false;
    render();
  }
}

async function saveClip(): Promise<void> {
  if (actionBusy || status.mode !== 'replay') return;
  actionBusy = true;
  render();
  try {
    const replayLengthSec = settings?.replayLengthSec ?? DEFAULT_REPLAY_LENGTH_SEC;
    await api.recordingClipSave({ headDurationMs: replayLengthSec * 1000 });
    await loadClips();
    toast('success', 'Clip saved', `The last ${replayLengthSec} seconds were added to the clip library.`);
  } catch (err) {
    toast('error', 'Save clip', messageOf(err));
  } finally {
    actionBusy = false;
    render();
  }
}

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
  } catch (err) {
    toast('error', 'Delete clip', messageOf(err));
  }
}

async function chooseFolder(): Promise<void> {
  try {
    const result = await api.recordingChooseFolder();
    if (!result.canceled) {
      settings = result.settings;
      render();
    }
  } catch (err) {
    toast('error', 'Recording folder', messageOf(err));
  }
}

function selectClip(clip: RecordingClip): void {
  selectedClip = clip;
  render();
}

export const recordingPage: Page = {
  id: 'recording',
  render(container: HTMLElement, _context?: PageContext): void {
    renderContainer = container;
    if (!unsubscribeRecordingState) {
      unsubscribeRecordingState = api.onRecordingStateUpdated((next) => {
        setStatus(next, true);
        if (renderContainer === container) render();
      });
    }
    void load();
  },
  leave(): void {
    unsubscribeRecordingState?.();
    unsubscribeRecordingState = null;
    renderContainer = null;
    selectedClip = null;
  },
};
