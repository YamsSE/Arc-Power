// Arc Power recording page. The renderer only uses the typed preload bridge;
// capture processes, files, and media authorization remain main-owned.
import { el, clear } from '../dom.ts';
import { api } from '../ipc.ts';
import type { Page, PageContext } from '../router.ts';
import type { RecordingAudioDevice, RecordingClip, RecordingClipDeleteResult, RecordingEngineState, RecordingMode, RecordingResolution, RecordingSettings, RecordingSettingsPatch, RecordingTab } from '../types.ts';
import { toast } from '../components/toast.ts';
import { showRecordingClipDeleteConfirm } from '../components/recording-delete-dialog.ts';
import { normalizeRecordingBitrate, recordingBitrateRange, recordingMessage } from '../pure/recording.ts';

const TABS: Array<[RecordingTab, string, string]> = [
  ['manual', 'Manual Recording', 'Capture a full video when you choose.'],
  ['clips', 'Clips', 'Keep a replay buffer and save the last moments.'],
  ['audio', 'Audio', 'Configure microphone and sound capture.'],
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
  startedAt: null,
  error: 'Loading recording engine…',
  encoders: [],
  audioInputs: [],
  audioOutputs: [],
  hotkeys: { registered: {}, conflicts: {}, error: null },
};
let clips: RecordingClip[] = [];
let playerClip: RecordingClip | null = null;
let activeTab: RecordingTab = 'manual';
let renderContainer: HTMLElement | null = null;
let loading = false;
let actionBusy = false;
let unsubscribeRecordingState: (() => void) | null = null;
let playerVideo: HTMLVideoElement | null = null;
let recordingProcesses: string[] = [];
let recordingProcessesBusy = false;
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
  const startedAt = next.running
    ? Number.isFinite(next.startedAt) ? next.startedAt : previous.running ? previous.startedAt : Date.now()
    : null;
  status = { ...next, startedAt };
  if (announce) announceCaptureTransition(previous, next);
}

const messageOf = recordingMessage;

function disposePlayerVideo(): void {
  if (!playerVideo) return;
  try {
    playerVideo.pause();
    playerVideo.removeAttribute('src');
    playerVideo.load();
  } catch { /* media cleanup is best effort during navigation */ }
  playerVideo = null;
}

function recordingDeleteError(reason: RecordingClipDeleteResult['reason']): string {
  switch (reason) {
    case 'unsupported-platform': return 'The clip could not be deleted safely.';
    case 'unsafe-path': return 'The clip path failed safety checks.';
    case 'delete-failed': return 'The clip could not be deleted.';
    case 'unavailable': return 'Clip deletion is unavailable.';
    default: return 'The clip could not be deleted.';
  }
}

function tabForMode(mode: RecordingMode | string | undefined): RecordingTab {
  return mode === 'clips' || mode === 'clips-only' ? 'clips' : 'manual';
}

function modeForTab(tab: RecordingTab): RecordingMode | null {
  return tab === 'audio' ? null : tab === 'clips' ? 'clips' : 'manual';
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

function savePatch(patch: RecordingSettingsPatch): void {
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
  const known = new Map(status.encoders.filter((encoder) => INTEL_QSV_ENCODERS.has(encoder.type)).map((encoder) => [encoder.type, encoder]));
  for (const [id, label] of [['obs_qsv11_v2', 'Intel H264'], ['obs_qsv11_hevc', 'Intel HEVC'], ['obs_qsv11_av1', 'Intel AV1']] as const) {
    const encoder = known.get(id);
    const unavailable = !encoder || (encoder.startTested && !encoder.startSupported) || encoder.probeValid !== true ? ' — unavailable' : '';
    options.push([id, `${encoder ? encoderLabel(encoder) : label}${unavailable}`]);
  }
  return options;
}

function renderTabs(): HTMLElement {
  return el('nav', { class: 'recording-tabs', 'aria-label': 'Recording sections' }, TABS.map(([tab, label, note]) => el('button', {
    class: `recording-tab${activeTab === tab ? ' active' : ''}`,
    type: 'button',
    role: 'tab',
    'aria-selected': String(activeTab === tab),
    title: note,
    text: label,
    onClick: () => selectTab(tab),
  })));
}

function renderCaptureActions(): HTMLElement {
  const recordingRunning = status.running && status.mode === 'video';
  const replayRunning = status.running && status.mode === 'replay';
  return el('div', { class: 'recording-capture-actions' }, [
    button(recordingRunning ? 'Stop Recording' : 'Start Recording', () => void (recordingRunning ? stopCapture() : startRecording()), `btn ${recordingRunning ? 'btn-recording-stop' : 'btn-primary'}`, !status.available || actionBusy || replayRunning),
    button(replayRunning ? 'Stop Replay Buffer' : 'Start Replay Buffer', () => void (replayRunning ? stopCapture() : startReplay()), `btn ${replayRunning ? 'btn-recording-stop' : 'btn-secondary'}`, !status.available || actionBusy || recordingRunning),
    button('Save Clip', () => void saveClip(), 'btn btn-secondary', !status.available || status.mode !== 'replay' || actionBusy),
    status.running && !recordingRunning && !replayRunning ? el('span', { class: 'recording-inline-note', text: 'Another capture is active.' }) : null,
  ]);
}

function renderCapturePanel(): HTMLElement {
  const replayLength = settings?.replayLengthSec ?? DEFAULT_REPLAY_LENGTH_SEC;
  return el('section', { class: 'recording-panel recording-capture-panel' }, [
    el('div', { class: 'recording-panel-heading' }, [
      el('div', {}, [
        el('span', { class: 'recording-eyebrow', text: 'Capture controls' }),
        el('h2', { class: 'recording-panel-title', text: 'Record or save a moment' }),
      ]),
    ]),
    el('p', { class: 'recording-panel-note', text: `Start a full recording or keep a ${replayLength}-second replay buffer. Save Clip finalizes one clip while the buffer keeps running.` }),
    renderCaptureActions(),
    status.error && status.available ? el('p', { class: 'recording-inline-error', text: messageOf(status.error) }) : null,
    status.hotkeys.error ? el('p', { class: 'recording-inline-error', text: `Shortcut registration issue: ${messageOf(status.hotkeys.error)}` }) : null,
  ]);
}

function renderQualitySettings(): HTMLElement {
  const fps = select(String(settings?.fps ?? 60), [['30', '30 FPS'], ['60', '60 FPS'], ['120', '120 FPS']], (value) => savePatch({ fps: Number(value) as 30 | 60 | 120 }));
  const selectedResolution = settings?.resolution ?? '1080p';
  const bitrateRange = recordingBitrateRange(selectedResolution);
  const bitrate = el('input', {
    class: 'recording-number',
    type: 'number',
    step: 'any',
    value: settings?.bitrateKbps ?? bitrateRange.default,
  }) as HTMLInputElement;
  bitrate.title = 'Enter any positive bitrate in Kbps';
  bitrate.addEventListener('change', () => {
    const value = Number(bitrate.value);
    if (Number.isFinite(value) && value > 0) savePatch({ bitrateKbps: normalizeRecordingBitrate(value, settings?.bitrateKbps ?? bitrateRange.default) });
  });
  const encoder = select(settings?.encoderId ?? 'automatic', encoderOptions(), (value) => savePatch({ encoderId: value }));
  const resolution = select(selectedResolution, RESOLUTIONS, (value) => savePatch({ resolution: value }));
  return el('section', { class: 'recording-panel' }, [
    el('div', { class: 'recording-panel-heading recording-panel-heading-compact' }, [
      el('div', {}, [el('span', { class: 'recording-eyebrow', text: 'Video profile' }), el('h2', { class: 'recording-panel-title', text: 'Quality' })]),
      el('span', { class: 'recording-panel-badge', text: 'Applies to video and clips' }),
    ]),
    el('div', { class: 'recording-settings-grid' }, [
      field('Frame rate', fps),
      field('Resolution', resolution),
      field('Encoder', encoder),
      field('Bitrate (Kbps)', bitrate),
      field('Bitrate Recommendation', el('span', { class: 'recording-field-note', text: bitrateRange.label })),
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

function deviceOptions(devices: RecordingAudioDevice[], selected: string): Array<[string, string]> {
  const options: Array<[string, string]> = [['', 'Default device']];
  for (const device of devices) {
    if (device.deviceId && !options.some(([id]) => id === device.deviceId)) options.push([device.deviceId, device.name || device.deviceId]);
  }
  if (selected && !options.some(([id]) => id === selected)) options.push([selected, `${selected} (saved)`]);
  return options;
}

function volumeControl(value: number, label: string, onChange: (value: number) => void): HTMLElement {
  const input = el('input', { class: 'recording-volume', type: 'range', min: 0, max: 100, step: 1, value: Math.round(value * 100), 'aria-label': label }) as HTMLInputElement;
  const valueLabel = el('span', { class: 'recording-volume-value', text: `${Math.round(value * 100)}%` });
  input.addEventListener('input', () => {
    const next = Math.min(100, Math.max(0, Number(input.value)));
    valueLabel.textContent = `${Math.round(next)}%`;
    onChange(next / 100);
  });
  return el('div', { class: 'recording-volume-control' }, [input, valueLabel]);
}

async function refreshRecordingProcesses(): Promise<void> {
  if (recordingProcessesBusy) return;
  recordingProcessesBusy = true;
  render();
  try {
    recordingProcesses = await api.recordingProcessesList();
    render();
  } catch (err) {
    toast('error', 'Process list', messageOf(err));
  } finally {
    recordingProcessesBusy = false;
    render();
  }
}

function recordingProcessOptions(selected: string): Array<[string, string]> {
  const options: Array<[string, string]> = [['', 'Do not capture a process']];
  for (const name of recordingProcesses) {
    if (!options.some(([id]) => id === name)) options.push([name, name]);
  }
  if (selected && !options.some(([id]) => id === selected)) options.push([selected, `${selected} (saved)`]);
  return options;
}

function renderAudioSettings(): HTMLElement {
  const audio = settings?.audio ?? {
    microphone: { enabled: false, deviceId: '', volume: 1, mono: false },
    system: { enabled: true, deviceId: '', volume: 1 },
    sourceMode: 'system' as const,
    customProcesses: [],
  };
  const microphoneEnabled = el('input', { type: 'checkbox', checked: audio.microphone.enabled, 'aria-label': 'Enable microphone' }) as HTMLInputElement;
  microphoneEnabled.addEventListener('change', () => savePatch({ audio: { microphone: { enabled: microphoneEnabled.checked } } }));
  const microphoneDevice = select(audio.microphone.deviceId, deviceOptions(status.audioInputs, audio.microphone.deviceId), (value) => savePatch({ audio: { microphone: { deviceId: value } } }));
  const microphoneMono = el('input', { type: 'checkbox', checked: audio.microphone.mono, 'aria-label': 'Mono microphone' }) as HTMLInputElement;
  microphoneMono.addEventListener('change', () => savePatch({ audio: { microphone: { mono: microphoneMono.checked } } }));
  const sourceMode = select(audio.sourceMode, [['system', 'Full PC'], ['custom', 'Up to 3 processes']], (value) => savePatch({ audio: { sourceMode: value } }));
  const systemEnabled = el('input', { type: 'checkbox', checked: audio.system.enabled, disabled: audio.sourceMode === 'custom', 'aria-label': 'Enable full PC audio' }) as HTMLInputElement;
  systemEnabled.addEventListener('change', () => savePatch({ audio: { system: { enabled: systemEnabled.checked } } }));
  const systemDevice = select(audio.system.deviceId, deviceOptions(status.audioOutputs, audio.system.deviceId), (value) => savePatch({ audio: { system: { deviceId: value } } }));
  const processSelects = [0, 1, 2].map((index) => {
    const selected = audio.customProcesses[index] ?? '';
    const processSelect = select(selected, recordingProcessOptions(selected), (value) => {
      const next = audio.customProcesses.slice(0, 3);
      next[index] = value;
      savePatch({ audio: { customProcesses: next.filter(Boolean) } });
    });
    processSelect.classList.add('recording-process-select');
    processSelect.disabled = audio.sourceMode !== 'custom';
    return processSelect;
  });
  return el('section', { class: 'recording-panel recording-audio-panel' }, [
    el('div', { class: 'recording-panel-heading recording-panel-heading-compact' }, [
      el('div', {}, [el('span', { class: 'recording-eyebrow', text: 'Audio capture' }), el('h2', { class: 'recording-panel-title', text: 'Microphone and sound source' })]),
    ]),
    el('div', { class: 'recording-audio-sections' }, [
      el('div', { class: 'recording-audio-section' }, [
        el('h3', { text: 'Microphone' }),
        el('label', { class: 'recording-check-row' }, [microphoneEnabled, el('span', { text: 'Include microphone' })]),
        field('Device', microphoneDevice),
        field('Volume', volumeControl(audio.microphone.volume, 'Microphone volume', (value) => savePatch({ audio: { microphone: { volume: value } } }))),
        el('label', { class: 'recording-check-row' }, [microphoneMono, el('span', { text: 'Force mono' })]),
      ]),
      el('div', { class: 'recording-audio-section' }, [
        el('h3', { text: 'Sound source' }),
        field('Capture source', sourceMode, 'Choose full PC audio or up to three individual processes.'),
        el('label', { class: 'recording-check-row' }, [systemEnabled, el('span', { text: 'Include full PC audio' })]),
        field('Output device', systemDevice),
        field('Output volume', volumeControl(audio.system.volume, 'System audio volume', (value) => savePatch({ audio: { system: { volume: value } } }))),
        el('div', { class: 'recording-process-fields' }, [
          el('span', { class: 'recording-field-label', text: 'Processes (up to 3)' }),
          ...processSelects,
          button(recordingProcessesBusy ? 'Refreshing…' : 'Refresh process list', () => void refreshRecordingProcesses(), 'btn btn-secondary recording-process-refresh', recordingProcessesBusy),
          el('span', { class: 'recording-field-note', text: recordingProcesses.length ? `${recordingProcesses.length} running processes available.` : 'Refresh to load running processes.' }),
        ]),
      ]),
    ]),
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
  ]);
}

function renderManualView(): HTMLElement {
  return el('div', { class: 'recording-content recording-manual-content' }, [
    renderCapturePanel(),
    el('div', { class: 'recording-panel-column' }, [renderQualitySettings(), renderReplaySettings(), renderHotkeys(), renderStorage()]),
  ]);
}

function renderAudioView(): HTMLElement {
  return el('div', { class: 'recording-content recording-audio-content' }, [renderAudioSettings()]);
}

function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remainder = safe % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function playerIconButton(label: string, icon: string, onClick: () => void, className = ''): HTMLButtonElement {
  return el('button', {
    class: `recording-player-icon-button${className ? ` ${className}` : ''}`,
    type: 'button',
    title: label,
    'aria-label': label,
    onClick: (event: Event) => { event.preventDefault(); onClick(); },
  }, [el('span', { class: `recording-player-icon recording-player-icon-${icon}`, 'aria-hidden': 'true' })]) as HTMLButtonElement;
}

function previewVideo(clip: RecordingClip, onDuration: (seconds: number) => void): HTMLVideoElement {
  const preview = el('video', {
    class: 'recording-clip-preview',
    muted: true,
    loop: true,
    playsinline: true,
    preload: 'metadata',
  }) as HTMLVideoElement;
  let hovered = false;
  const playPreview = () => {
    if (!hovered || !preview.src) return;
    preview.muted = true;
    void preview.play().catch(() => { /* unavailable previews stay quiet */ });
  };
  preview.addEventListener('canplay', playPreview);
  preview.addEventListener('loadedmetadata', () => onDuration(preview.duration));
  preview.addEventListener('mouseenter', () => {
    hovered = true;
    preview.muted = true;
    playPreview();
  });
  preview.addEventListener('mouseleave', () => {
    hovered = false;
    preview.pause();
    try { preview.currentTime = 0; } catch { /* metadata may not have loaded */ }
  });
  void api.recordingClipUrl(clip.id).then((url) => {
    if (preview.isConnected) {
      preview.src = url;
      playPreview();
    }
  }).catch(() => {
    if (preview.isConnected) preview.dataset.previewError = 'true';
  });
  return preview;
}

function renderClipList(): HTMLElement {
  const query = el('input', { class: 'recording-search', type: 'search', placeholder: 'Search clips…', 'aria-label': 'Search clips' }) as HTMLInputElement;
  const list = el('div', { class: 'recording-clip-list' });
  const count = el('span', { class: 'recording-library-count', text: `${clips.length} clips` });
  const draw = () => {
    clear(list);
    const needle = query.value.trim().toLowerCase();
    const visible = clips.filter((clip) => !needle || clip.fileName.toLowerCase().includes(needle));
    count.textContent = `${visible.length} ${visible.length === 1 ? 'clip' : 'clips'}`;
    if (visible.length === 0) {
      list.append(el('p', { class: 'recording-empty', text: 'No clips found yet. Save a moment from Manual Recording to build this library.' }));
      return;
    }
    for (const clip of visible) {
      const duration = el('span', { class: 'recording-clip-duration', text: '—' });
      const tile = el('div', {
        class: 'recording-clip-tile',
        role: 'button',
        tabindex: 0,
        'aria-label': `Open ${clip.fileName}`,
        onClick: (event: Event) => { event.preventDefault(); openPlayer(clip); },
      });
      tile.addEventListener('keydown', (event) => {
        const keyboardEvent = event as KeyboardEvent;
        if (keyboardEvent.key !== 'Enter' && keyboardEvent.key !== ' ') return;
        keyboardEvent.preventDefault();
        openPlayer(clip);
      });
      tile.append(
        el('div', { class: 'recording-clip-media' }, [
          previewVideo(clip, (seconds) => { duration.textContent = formatTime(seconds); }),
          duration,
          el('span', { class: 'recording-clip-hover-action' }, [el('span', { class: 'recording-clip-play-icon', text: '▶' }), el('span', { text: 'Open player' })]),
        ]),
        el('span', { class: 'recording-clip-details' }, [
          el('strong', { text: clip.fileName }),
          el('span', { text: `Arc Power · ${new Date(clip.createdAt).toLocaleString()}` }),
        ]),
      );
      const deleteButton = el('button', {
        class: 'recording-clip-delete',
        type: 'button',
        title: `Delete ${clip.fileName}`,
        'aria-label': `Delete ${clip.fileName}`,
        onClick: (event: Event) => {
          event.preventDefault();
          event.stopPropagation();
          void deleteClip(clip);
        },
      }, [el('span', { class: 'recording-trash-icon', 'aria-hidden': 'true' })]) as HTMLButtonElement;
      list.append(el('article', { class: 'recording-clip-card' }, [tile, deleteButton]));
    }
  };
  query.addEventListener('input', draw);
  draw();

  return el('section', { class: 'recording-panel recording-library-panel' }, [
    el('div', { class: 'recording-library-toolbar' }, [
      el('div', { class: 'recording-library-heading' }, [
        el('span', { class: 'recording-eyebrow', text: 'Saved clips' }),
        el('div', { class: 'recording-library-title-row' }, [el('h2', { class: 'recording-panel-title', text: 'Clip library' }), count]),
      ]),
      el('div', { class: 'recording-library-actions' }, [
        query,
        button('Refresh', () => void loadClips(), 'btn btn-secondary'),
        button('Open Folder', () => void api.recordingOpenFolder().catch((err) => toast('error', 'Clip folder', messageOf(err))), 'btn btn-secondary'),
      ]),
    ]),
    list,
  ]);
}

function renderClipsView(): HTMLElement {
  return el('div', { class: 'recording-content recording-clips-content' }, [renderClipList()]);
}

function renderPlayerView(): HTMLElement {
  const player = el('div', { class: 'recording-player-stage' }, [el('p', { class: 'recording-player-placeholder', text: 'Loading clip…' })]);
  const timelinePanel = el('section', { class: 'recording-player-timeline-panel' }, [
    el('div', { class: 'recording-player-timeline-heading' }, [
      el('div', {}, [el('span', { class: 'recording-eyebrow', text: 'Clip timeline' }), el('strong', { text: 'Review your moment' })]),
      el('span', { class: 'recording-player-time recording-player-duration-label', text: '0:00' }),
    ]),
    el('p', { class: 'recording-player-placeholder', text: 'Loading timeline…' }),
  ]);
  if (playerClip) {
    const requestedId = playerClip.id;
    void api.recordingClipUrl(requestedId).then((url) => {
      if (!player.isConnected || playerClip?.id !== requestedId) return;
      const video = el('video', { class: 'recording-video', preload: 'metadata', playsinline: true, src: url }) as HTMLVideoElement;
      const playButton = playerIconButton('Play', 'play', () => {
        if (video.paused) void video.play().catch(() => {});
        else video.pause();
      }, 'recording-player-play');
      const seek = el('input', { class: 'recording-player-seek', type: 'range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Seek clip' }) as HTMLInputElement;
      const elapsed = el('span', { class: 'recording-player-time', text: '0:00' });
      const duration = el('span', { class: 'recording-player-time', text: '0:00' });
      const timelineElapsed = el('span', { class: 'recording-player-time', text: '0:00' });
      const timelineDuration = el('span', { class: 'recording-player-time', text: '0:00' });
      const timelineMiddle = el('span', { text: '0:00' });
      const timelineEnd = el('span', { text: '0:00' });
      const durationLabel = timelinePanel.querySelector('.recording-player-duration-label') as HTMLElement;
      const updatePlayButton = () => {
        playButton.title = video.paused ? 'Play' : 'Pause';
        playButton.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
        const icon = playButton.querySelector('.recording-player-icon');
        if (icon) icon.className = `recording-player-icon recording-player-icon-${video.paused ? 'play' : 'pause'}`;
      };
      const updateTimeline = () => {
        elapsed.textContent = formatTime(video.currentTime);
        duration.textContent = formatTime(video.duration);
        timelineElapsed.textContent = formatTime(video.currentTime);
        timelineDuration.textContent = formatTime(video.duration);
        timelineMiddle.textContent = formatTime(video.duration / 2);
        timelineEnd.textContent = formatTime(video.duration);
        durationLabel.textContent = formatTime(video.duration);
        seek.value = video.duration > 0 ? String(Math.round((video.currentTime / video.duration) * 1000)) : '0';
      };
      video.addEventListener('play', updatePlayButton);
      video.addEventListener('pause', updatePlayButton);
      video.addEventListener('loadedmetadata', updateTimeline);
      video.addEventListener('timeupdate', updateTimeline);
      video.addEventListener('ended', updatePlayButton);
      video.addEventListener('click', () => {
        if (video.paused) void video.play().catch(() => {});
        else video.pause();
      });
      video.addEventListener('keydown', (event) => {
        const keyboardEvent = event as KeyboardEvent;
        if (keyboardEvent.key !== ' ' && keyboardEvent.key.toLowerCase() !== 'k') return;
        keyboardEvent.preventDefault();
        if (video.paused) void video.play().catch(() => {});
        else video.pause();
      });
      seek.addEventListener('input', () => {
        if (video.duration > 0) video.currentTime = (Number(seek.value) / 1000) * video.duration;
      });
      let muteButton: HTMLButtonElement;
      const updateMuteButton = () => {
        if (!muteButton) return;
        const muted = video.muted || video.volume === 0;
        muteButton.title = muted ? 'Unmute' : 'Mute';
        muteButton.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
        const icon = muteButton.querySelector('.recording-player-icon');
        if (icon) icon.className = `recording-player-icon recording-player-icon-${muted ? 'muted' : 'volume'}`;
      };
      muteButton = playerIconButton('Mute', 'volume', () => {
        video.muted = !video.muted;
        updateMuteButton();
      }, 'recording-player-mute');
      const volume = el('input', { class: 'recording-player-volume', type: 'range', min: 0, max: 1, step: 0.01, value: 1, 'aria-label': 'Clip volume' }) as HTMLInputElement;
      volume.addEventListener('input', () => { video.volume = Number(volume.value); video.muted = video.volume === 0; updateMuteButton(); });
      video.addEventListener('volumechange', updateMuteButton);
      const fullscreen = playerIconButton('Fullscreen', 'fullscreen', () => {
        void (video.requestFullscreen?.() ?? (player as HTMLElement & { requestFullscreen?: () => Promise<void> }).requestFullscreen?.());
      }, 'recording-player-fullscreen');
      clear(player);
      player.append(
        video,
        el('div', { class: 'recording-player-overlay' }, [
          el('div', { class: 'recording-player-controls' }, [
            playButton,
            el('div', { class: 'recording-player-time-pair' }, [elapsed, el('span', { text: '/' }), duration]),
            el('span', { class: 'recording-player-controls-spacer' }),
            muteButton,
            volume,
            fullscreen,
          ]),
          el('span', { class: 'recording-player-brand' }, [el('span', { class: 'recording-player-brand-mark', 'aria-hidden': 'true' }), el('span', { text: 'Arc Power' })]),
        ]),
      );
      clear(timelinePanel);
      timelinePanel.append(
        el('div', { class: 'recording-player-timeline-heading' }, [
          el('div', {}, [el('span', { class: 'recording-eyebrow', text: 'Clip timeline' }), el('strong', { text: 'Review your moment' })]),
          durationLabel,
        ]),
        el('div', { class: 'recording-player-timeline-row' }, [timelineElapsed, seek, timelineDuration]),
        el('div', { class: 'recording-player-timeline-ruler' }, [el('span', { text: '0:00' }), timelineMiddle, timelineEnd]),
      );
      updatePlayButton();
      updateMuteButton();
      playerVideo = video;
    }).catch((err) => {
      if (!player.isConnected || playerClip?.id !== requestedId) return;
      clear(player);
      player.append(el('p', { class: 'text-error', text: messageOf(err) }));
    });
  }
  const back = el('button', {
    class: 'recording-player-back',
    type: 'button',
    'aria-label': 'Back to clips',
    title: 'Back to clips',
    onClick: () => closePlayer(),
  }, [el('span', { class: 'recording-player-back-icon', 'aria-hidden': 'true' }), el('span', { text: 'Back to Clips' })]);
  return el('section', { class: 'recording-player-view' }, [
    el('header', { class: 'recording-player-view-heading' }, [
      back,
      el('div', { class: 'recording-player-heading-copy' }, [el('span', { class: 'recording-eyebrow', text: 'Clip player' }), el('h2', { class: 'recording-panel-title', text: playerClip?.fileName ?? 'Clip' }), el('span', { class: 'recording-player-meta', text: playerClip ? `Saved ${new Date(playerClip.createdAt).toLocaleString()}` : '' })]),
      button('Open Folder', () => void api.recordingOpenFolder().catch((err) => toast('error', 'Clip folder', messageOf(err))), 'btn btn-secondary recording-player-folder'),
    ]),
    player,
    timelinePanel,
  ]);
}

function render(): void {
  if (!renderContainer) return;
  disposePlayerVideo();
  clear(renderContainer);
  renderContainer.append(
    el('div', { class: 'page-heading recording-heading' }, [
      el('div', {}, [
        el('span', { class: 'recording-eyebrow', text: 'Arc Power Capture' }),
        el('h1', { text: 'Recording' }),
      ]),
      renderTabs(),
    ]),
    playerClip ? renderPlayerView() : activeTab === 'manual' ? renderManualView() : activeTab === 'clips' ? renderClipsView() : renderAudioView(),
  );
}

function selectTab(tab: RecordingTab): void {
  const wasShowingPlayer = playerClip !== null;
  if (wasShowingPlayer) {
    disposePlayerVideo();
    playerClip = null;
  }
  if (activeTab === tab && !wasShowingPlayer) return;
  activeTab = tab;
  render();
  const mode = modeForTab(tab);
  if (settings && mode && settings.mode !== mode) savePatch({ mode });
}

async function loadClips(): Promise<void> {
  try {
    clips = await api.recordingClipsList();
    if (playerClip && !clips.some((clip) => clip.id === playerClip?.id)) closePlayer();
    render();
  } catch (err) {
    toast('error', 'Clip library', messageOf(err));
    throw err;
  }
}

async function load(): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    const [loadedSettings, loadedStatus, loadedClips] = await Promise.all([
      api.recordingSettingsGet(),
      api.recordingStatus(),
      api.recordingClipsList(),
    ]);
    settings = loadedSettings;
    status = loadedStatus;
    clips = loadedClips;
    activeTab = tabForMode(settings.mode);
    const canonicalMode = modeForTab(activeTab) ?? 'manual';
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
    toast('success', 'Clip saved', `The last ${replayLengthSec} seconds were added to the clip library.`);
    await loadClips();
  } catch (err) {
    toast('error', 'Save clip', messageOf(err));
  } finally {
    actionBusy = false;
    render();
  }
}

async function deleteClip(clip: RecordingClip): Promise<void> {
  if (!(await showRecordingClipDeleteConfirm(clip.fileName))) return;
  try {
    const result = await api.recordingClipDelete(clip.id);
    if (!result.ok) {
      if (result.reason === 'not-found') {
        await loadClips();
        return;
      }
      throw new Error(recordingDeleteError(result.reason));
    }
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

function openPlayer(clip: RecordingClip): void {
  disposePlayerVideo();
  playerClip = clip;
  activeTab = 'clips';
  render();
}

function closePlayer(): void {
  disposePlayerVideo();
  playerClip = null;
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
    // Do not make first paint wait for settings, clip scanning, or an engine
    // probe. Startup owns the runtime probe; this page refreshes its cached
    // state asynchronously after the shell and controls are visible.
    render();
    void load();
  },
  leave(): void {
    unsubscribeRecordingState?.();
    unsubscribeRecordingState = null;
    disposePlayerVideo();
    renderContainer = null;
    playerClip = null;
  },
};
