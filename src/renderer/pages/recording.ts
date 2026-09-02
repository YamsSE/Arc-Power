// Arc Power recording page. The renderer only uses the typed preload bridge;
// capture processes, files, and media authorization remain main-owned.
import { el, clear } from '../dom.ts';
import { api } from '../ipc.ts';
import type { Page, PageContext } from '../router.ts';
import type { RecordingAudioDevice, RecordingCaptureTarget, RecordingCaptureTargets, RecordingClip, RecordingClipDeleteResult, RecordingEngineState, RecordingMode, RecordingResolution, RecordingSettings, RecordingSettingsPatch, RecordingStorageInfo, RecordingTab } from '../types.ts';
import { toast } from '../components/toast.ts';
import { showRecordingClipDeleteConfirm } from '../components/recording-delete-dialog.ts';
import { recordingBitrateRange, recordingMessage } from '../pure/recording.ts';

const TABS: Array<[RecordingTab, string, string]> = [
  ['manual', 'Manual Recording', 'Capture a full video when you choose.'],
  ['clips', 'Clips', 'Keep a replay buffer and save the last moments.'],
  ['audio', 'Audio', 'Configure microphone and sound capture.'],
];
const RESOLUTIONS: Array<[RecordingResolution, string]> = [
  ['default', 'Auto (source)'],
  ['480p', '480p'],
  ['720p', '720p'],
  ['900p', '900p'],
  ['1080p', '1080p'],
  ['1440p', '1440p'],
  ['4k', '4K'],
];
const DEFAULT_REPLAY_LENGTH_SEC = 30;
const RECORDING_FPS_PRESETS = new Set([30, 60, 120]);
const RECORDING_FPS_MIN = 1;
const RECORDING_FPS_MAX = 360;
const INTEL_QSV_ENCODERS = new Set(['obs_qsv11_v2', 'obs_qsv11_hevc', 'obs_qsv11_av1']);
type ClipLibraryFilter = 'all' | 'clips' | 'recordings';
type ClipLibrarySort = 'newest' | 'oldest';

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
  probeComplete: false,
  activeModes: { video: false, replay: false },
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
let recordingTargets: RecordingCaptureTargets = { displays: [], windows: [] };
let recordingTargetsBusy = false;
let draftSettings: RecordingSettings | null = null;
let storageInfo: RecordingStorageInfo | null = null;
let settingsDirty = false;
let applyingSettings = false;
let applySettingsButton: HTMLButtonElement | null = null;
let fpsCustomEditing = false;
let recordingStateRevision = 0;
let clipLibraryFilter: ClipLibraryFilter = 'all';
let clipLibrarySort: ClipLibrarySort = 'newest';
let recordingPillEnabled = false;

function recordingClipKind(clip: RecordingClip): 'recording' | 'clip' {
  return /^Arc Recording \d+\.mp4$/i.test(clip.fileName) ? 'recording' : 'clip';
}

function setStatus(next: RecordingEngineState): void {
  const previous = status;
  // Engine action responses contain capture state only; the IPC status
  // response additionally carries hotkey state. Keep that auxiliary state
  // when a start/stop response updates the page, otherwise rendering the
  // shortcut section after Stop can crash on status.hotkeys.error.
  const incoming = next && typeof next === 'object' ? next : previous;
  const startedAt = incoming.running
    ? Number.isFinite(incoming.startedAt) ? incoming.startedAt : previous.running ? previous.startedAt : Date.now()
    : null;
  status = { ...previous, ...incoming, hotkeys: incoming.hotkeys ?? previous.hotkeys, startedAt };
  recordingStateRevision += 1;
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

type SelectOptionGroup<T extends string> = [string, Array<[T, string]>];

function groupedSelect<T extends string>(value: T, groups: SelectOptionGroup<T>[], onChange: (value: T) => void): HTMLSelectElement {
  const control = el('select', {
    class: 'recording-select',
    value,
  }, groups.map(([label, options]) => el('optgroup', { label }, options.map(([id, text]) => el('option', { value: id, text }))))) as HTMLSelectElement;
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

function cloneRecordingSettings(value: RecordingSettings): RecordingSettings {
  return {
    ...value,
    audio: {
      ...value.audio,
      microphone: { ...value.audio.microphone },
      system: { ...value.audio.system },
      customProcesses: [...value.audio.customProcesses],
    },
    hotkeys: { ...value.hotkeys },
    captureTarget: { ...value.captureTarget },
  };
}

function mergeRecordingSettings(base: RecordingSettings, patch: RecordingSettingsPatch): RecordingSettings {
  const audioPatch = patch.audio;
  return {
    ...base,
    ...patch,
    audio: {
      ...base.audio,
      ...(audioPatch ?? {}),
      microphone: { ...base.audio.microphone, ...(audioPatch?.microphone ?? {}) },
      system: { ...base.audio.system, ...(audioPatch?.system ?? {}) },
      customProcesses: audioPatch?.customProcesses ? [...audioPatch.customProcesses] : [...base.audio.customProcesses],
    },
    hotkeys: { ...base.hotkeys, ...(patch.hotkeys ?? {}) },
    captureTarget: { ...base.captureTarget, ...(patch.captureTarget ?? {}) },
  } as RecordingSettings;
}

function settingsForRender(): RecordingSettings | null {
  return draftSettings ?? settings;
}

function formatBytes(bytes: number | null): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'Unavailable';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const decimals = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

function compactPath(value: string): string {
  if (!value) return 'Choose a folder';
  if (value.length <= 54) return value;
  return `${value.slice(0, 24)}…${value.slice(-27)}`;
}

function selectedEncoderLabel(id: string): string {
  if (id === 'automatic') return 'Automatic';
  const encoder = status.encoders.find((candidate) => candidate.type === id);
  if (encoder) return encoderLabel(encoder);
  return ({ obs_qsv11_v2: 'Intel H264', obs_qsv11_hevc: 'Intel HEVC', obs_qsv11_av1: 'Intel AV1' } as Record<string, string>)[id] ?? id;
}

function captureProfileLabel(value: RecordingSettings): string {
  const resolution = RESOLUTIONS.find(([id]) => id === value.resolution)?.[1] ?? value.resolution;
  const bitrate = Math.round(value.bitrateKbps).toLocaleString();
  return `${resolution} · ${value.fps} FPS · ${selectedEncoderLabel(value.encoderId)} · ${bitrate} Kbps`;
}

function estimatedVideoSizePerMinute(bitrateKbps: number): string {
  return formatBytes((bitrateKbps * 1000 / 8) * 60);
}

function sameRecordingPath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return left.trim().replaceAll('/', '\\').toLowerCase() === right.trim().replaceAll('/', '\\').toLowerCase();
}

function updateRecordingApplyButton(): void {
  if (!applySettingsButton) return;
  applySettingsButton.hidden = !settingsDirty && !applyingSettings;
  applySettingsButton.disabled = applyingSettings || !settingsDirty;
  applySettingsButton.textContent = applyingSettings ? 'Applying…' : 'Apply settings';
}

function stagePatch(patch: RecordingSettingsPatch, rerender = true): void {
  if (!settings) return;
  draftSettings = mergeRecordingSettings(draftSettings ?? settings, patch);
  settingsDirty = JSON.stringify(draftSettings) !== JSON.stringify(settings);
  updateRecordingApplyButton();
  if (rerender) render();
}

function recordingSettingsPatchFrom(value: RecordingSettings): RecordingSettingsPatch {
  return {
    location: value.location,
    runtimePath: value.runtimePath,
    mode: value.mode,
    fps: value.fps,
    resolution: value.resolution,
    encoderId: value.encoderId,
    bitrateKbps: value.bitrateKbps,
    captureTarget: { ...value.captureTarget },
    captureColorMode: value.captureColorMode,
    replayLengthSec: value.replayLengthSec,
    audio: {
      microphone: { ...value.audio.microphone },
      system: { ...value.audio.system },
      sourceMode: value.audio.sourceMode,
      customProcesses: [...value.audio.customProcesses],
    },
    hotkeys: { ...value.hotkeys },
  };
}

async function applyRecordingSettings(): Promise<void> {
  if (applyingSettings || !settingsDirty || !draftSettings) return;
  applyingSettings = true;
  updateRecordingApplyButton();
  try {
    const result = await api.recordingSettingsSave(recordingSettingsPatchFrom(draftSettings));
    settings = result.settings;
    draftSettings = cloneRecordingSettings(result.settings);
    settingsDirty = false;
    status = { ...status, hotkeys: result.hotkeys };
    storageInfo = null;
    toast('success', 'Recording settings', 'Your recording profile was applied.');
    void refreshRecordingStorage();
  } catch (err) {
    toast('error', 'Recording settings', messageOf(err));
  } finally {
    applyingSettings = false;
    render();
  }
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
  const checking = status.probeComplete !== true && status.encoders.length === 0
    && (!status.error || /^Loading recording engine/i.test(status.error));
  for (const [id, label] of [['obs_qsv11_v2', 'Intel H264'], ['obs_qsv11_hevc', 'Intel HEVC'], ['obs_qsv11_av1', 'Intel AV1']] as const) {
    const encoder = known.get(id);
    const unavailable = !encoder
      ? checking ? ' — checking…' : ' — unavailable'
      : (encoder.startTested && !encoder.startSupported) || encoder.probeValid !== true ? ' — unavailable' : '';
    options.push([id, `${encoder ? encoderLabel(encoder) : label}${unavailable}`]);
  }
  return options;
}

function renderRecordingHeadingActions(): HTMLElement {
  const stateLabel = !settings ? 'Loading…' : settingsDirty ? 'Unsaved' : 'Applied';
  return el('div', { class: 'recording-heading-actions' }, [
    el('span', { class: `recording-settings-state${settingsDirty ? ' is-unsaved' : ''}`, text: stateLabel }),
    el('span', { class: 'recording-settings-dirty', text: 'Unsaved changes', hidden: !settingsDirty }),
    (() => {
      const apply = button('Apply settings', () => void applyRecordingSettings(), 'btn btn-primary recording-apply-button', applyingSettings || !settingsDirty);
      apply.hidden = !settingsDirty && !applyingSettings;
      applySettingsButton = apply;
      return apply;
    })(),
  ]);
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
  const recordingRunning = status.activeModes?.video === true || (!status.activeModes && status.running && status.mode === 'video');
  const replayRunning = status.activeModes?.replay === true || (!status.activeModes && status.running && status.mode === 'replay');
  const captureNeedsApply = settingsDirty || applyingSettings;
  return el('div', { class: 'recording-capture-actions' }, [
    button(recordingRunning ? 'Stop Recording' : 'Start Recording', () => void (recordingRunning ? stopCapture('video') : startRecording()), `btn ${recordingRunning ? 'btn-recording-stop' : 'btn-primary'}`, !status.available || actionBusy || (!recordingRunning && captureNeedsApply)),
    button(replayRunning ? 'Stop Replay Buffer' : 'Start Replay Buffer', () => void (replayRunning ? stopCapture('replay') : startReplay()), `btn ${replayRunning ? 'btn-recording-stop' : 'btn-secondary'}`, !status.available || actionBusy || (!replayRunning && captureNeedsApply)),
    button('Save Clip', () => void saveClip(), 'btn btn-secondary', !status.available || !replayRunning || actionBusy),
    settingsDirty ? el('span', { class: 'recording-inline-note recording-unsaved-note', text: 'Apply changes before capture.' }) : null,
    recordingRunning && replayRunning ? el('span', { class: 'recording-inline-note recording-live-note', text: 'Recording and replay buffer are both active.' }) : null,
  ]);
}

function renderRecordingPillSetting(): HTMLElement {
  return el('div', { class: 'recording-pill-setting' }, [
    el('div', { class: 'recording-pill-setting-copy' }, [
      el('span', { class: 'recording-field-label', text: 'On-screen indicator' }),
      el('strong', { text: 'Recording Pill' }),
      el('span', { class: 'recording-field-note', text: 'Shows the Arc Power icon with a red or blue status pill while capture is active.' }),
    ]),
    el('label', { class: 'recording-check-row' }, [
      el('input', {
        type: 'checkbox',
        class: 'settings-checkbox',
        dataset: { setting: 'overlayRecordingPill' },
        checked: recordingPillEnabled,
        onchange: (ev: Event) => void onRecordingPillToggle((ev.target as HTMLInputElement).checked),
      }),
      el('span', { text: 'Show while recording' }),
    ]),
  ]);
}

function renderCapturePanel(): HTMLElement {
  const working = settingsForRender();
  const replayLength = working?.replayLengthSec ?? DEFAULT_REPLAY_LENGTH_SEC;
  return el('section', { class: 'recording-panel recording-capture-panel' }, [
    el('div', { class: 'recording-panel-heading' }, [
      el('div', {}, [
        el('span', { class: 'recording-eyebrow', text: 'Capture controls' }),
        el('h2', { class: 'recording-panel-title', text: 'Record or save a moment' }),
      ]),
    ]),
    el('p', { class: 'recording-panel-note', text: `Full recording or ${replayLength}-second replay buffer.` }),
    working ? el('div', { class: 'recording-profile-strip' }, [
      el('div', { class: 'recording-profile-copy' }, [
        el('span', { class: 'recording-field-label', text: 'Capture profile' }),
        el('strong', { text: captureProfileLabel(working) }),
      ]),
      el('span', { class: `recording-settings-state${settingsDirty ? ' is-unsaved' : ''}`, text: settingsDirty ? 'Unsaved' : 'Applied' }),
    ]) : null,
    renderCaptureActions(),
    renderCaptureTargetSettings(),
    status.error && status.available ? el('p', { class: 'recording-inline-error', text: messageOf(status.error) }) : null,
    status.hotkeys.error ? el('p', { class: 'recording-inline-error', text: `Shortcut registration issue: ${messageOf(status.hotkeys.error)}` }) : null,
  ]);
}

async function onRecordingPillToggle(checked: boolean): Promise<void> {
  const previous = recordingPillEnabled;
  recordingPillEnabled = checked;
  render();
  try {
    const result = await api.profilesSettingsSave({ overlayRecordingPill: checked });
    recordingPillEnabled = result.overlayRecordingPill === true;
    toast(checked ? 'success' : 'info', checked ? 'Recording Pill enabled' : 'Recording Pill disabled', '');
  } catch (err) {
    recordingPillEnabled = previous;
    toast('error', 'Recording Pill could not be changed', messageOf(err));
  }
  render();
}

function captureTargetKey(target: RecordingCaptureTarget): string {
  return target.type === 'window' ? `window:${target.windowHandle}` : `display:${target.displayId}`;
}

function captureTargetFromKey(key: string): RecordingCaptureTarget | null {
  if (key.startsWith('window:')) {
    const windowHandle = Number(key.slice('window:'.length));
    const window = recordingTargets.windows.find((item) => item.handle === windowHandle);
    if (!windowHandle || !window) return null;
    return { type: 'window', displayId: 'primary', windowHandle, processName: window.processName, windowTitle: window.title };
  }
  if (key.startsWith('display:')) {
    const displayId = key.slice('display:'.length);
    if (!displayId) return null;
    return { type: 'display', displayId, windowHandle: 0, processName: '', windowTitle: '' };
  }
  return null;
}

function captureAspectLabel(width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '';
  const ratio = width / height;
  const known = [[16, 9], [21, 9], [4, 3], [5, 4], [32, 9]] as const;
  const match = known.find(([w, h]) => Math.abs(ratio - (w / h)) < 0.06);
  return match ? `${match[0]}:${match[1]}` : `${ratio.toFixed(2)}:1`;
}

function selectedCaptureSource(target: RecordingCaptureTarget): { width: number; height: number; label: string } | null {
  if (target.type === 'window') {
    const window = recordingTargets.windows.find((item) => item.handle === target.windowHandle);
    return window ? { width: window.width, height: window.height, label: 'Program window' } : null;
  }
  const display = target.displayId === 'primary'
    ? (recordingTargets.displays.find((item) => item.primary) ?? recordingTargets.displays[0])
    : recordingTargets.displays.find((item) => item.id === target.displayId);
  return display ? { width: display.width, height: display.height, label: display.label } : null;
}

function captureTargetOptionGroups(selected: RecordingCaptureTarget): Array<SelectOptionGroup<string>> {
  const displays: Array<[string, string]> = recordingTargets.displays
    .slice()
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.label.localeCompare(b.label))
    .map((display) => [
      `display:${display.id}`,
      `${display.primary ? 'Primary display' : display.label}${display.hdr ? ' · HDR' : ''}`,
    ]);
  if (!displays.length) displays.push(['display:primary', 'Primary display']);

  const programs: Array<[string, string]> = recordingTargets.windows
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title) || a.processName.localeCompare(b.processName))
    .map((window) => [
      `window:${window.handle}`,
      `${window.title || 'Untitled window'} · ${window.processName || 'Window'}`,
    ]);

  const selectedKey = captureTargetKey(selected);
  const selectedGroup = selected.type === 'window' ? programs : displays;
  const selectedDisplayIsAvailable = selected.type === 'display'
    && (selected.displayId === 'primary'
      ? recordingTargets.displays.length > 0
      : recordingTargets.displays.some((display) => display.id === selected.displayId));
  const selectedIsAvailable = selected.type === 'window'
    ? selectedGroup.some(([key]) => key === selectedKey)
    : selectedDisplayIsAvailable;
  if (!selectedIsAvailable) {
    selectedGroup.push([selectedKey, selected.type === 'window'
      ? `${selected.windowTitle || 'Selected window'} (saved)`
      : `${selected.displayId} (saved)`]);
  }
  const groups: Array<SelectOptionGroup<string>> = [['Displays', displays]];
  if (programs.length) groups.push(['Programs', programs]);
  return groups;
}

function captureTargetControlKey(target: RecordingCaptureTarget): string {
  if (target.type !== 'display' || target.displayId !== 'primary') return captureTargetKey(target);
  const primary = recordingTargets.displays.find((display) => display.primary) ?? recordingTargets.displays[0];
  return primary ? `display:${primary.id}` : 'display:primary';
}

async function refreshRecordingCaptureTargets(force = false): Promise<void> {
  if (recordingTargetsBusy) return;
  recordingTargetsBusy = true;
  render();
  try {
    recordingTargets = await api.recordingCaptureTargets(force);
    render();
  } catch (err) {
    toast('error', 'Capture targets', messageOf(err));
  } finally {
    recordingTargetsBusy = false;
    render();
  }
}

function renderCaptureTargetSettings(): HTMLElement {
  const working = settingsForRender();
  const target = working?.captureTarget ?? { type: 'display' as const, displayId: 'primary', windowHandle: 0, processName: '', windowTitle: '' };
  const targetSelect = groupedSelect(captureTargetControlKey(target), captureTargetOptionGroups(target), (value) => {
    const next = captureTargetFromKey(value);
    if (next) stagePatch({ captureTarget: next });
  });
  targetSelect.setAttribute('aria-label', 'Capture target');
  const colorMode = select(working?.captureColorMode ?? 'auto', [['auto', 'Auto'], ['sdr', 'SDR'], ['hdr', 'HDR']], (value) => stagePatch({ captureColorMode: value }));
  colorMode.setAttribute('aria-label', 'Capture color mode');
  const source = selectedCaptureSource(target);
  const sourceNote = source
    ? `${source.width}×${source.height} · ${captureAspectLabel(source.width, source.height)} detected`
    : 'Choose a display or live program window.';
  return el('div', { class: 'recording-capture-target-row' }, [
    field('Capture target', targetSelect, sourceNote),
    field('Color handling', colorMode, 'Auto follows the selected source.'),
    button(recordingTargetsBusy ? 'Refreshing…' : 'Refresh targets', () => void refreshRecordingCaptureTargets(true), 'btn btn-secondary recording-target-refresh', recordingTargetsBusy),
  ]);
}

function renderQualitySettings(): HTMLElement {
  const working = settingsForRender();
  const currentFps = Number.isFinite(Number(working?.fps)) ? Math.round(Number(working?.fps)) : 60;
  const fpsIsPreset = !fpsCustomEditing && RECORDING_FPS_PRESETS.has(currentFps);
  const fpsSelect = select(fpsIsPreset ? String(currentFps) : 'custom', [
    ['30', '30 FPS'],
    ['60', '60 FPS'],
    ['120', '120 FPS'],
    ['custom', 'Custom'],
  ], (value) => {
    if (value === 'custom') {
      fpsCustomEditing = true;
      stagePatch({ fps: currentFps }, true);
      return;
    }
    fpsCustomEditing = false;
    stagePatch({ fps: Number(value) });
  });
  fpsSelect.setAttribute('aria-label', 'Frame rate');
  const customFps = el('input', {
    class: 'recording-number recording-fps-custom',
    type: 'number',
    min: RECORDING_FPS_MIN,
    max: RECORDING_FPS_MAX,
    step: 1,
    value: currentFps,
    hidden: fpsIsPreset,
  }) as HTMLInputElement;
  customFps.title = `Enter a custom frame rate from ${RECORDING_FPS_MIN} to ${RECORDING_FPS_MAX} FPS`;
  customFps.addEventListener('change', () => {
    const value = Number(customFps.value);
    if (!Number.isFinite(value)) return;
    const next = Math.min(RECORDING_FPS_MAX, Math.max(RECORDING_FPS_MIN, Math.round(value)));
    customFps.value = String(next);
    stagePatch({ fps: next }, false);
  });
  const fps = el('div', { class: 'recording-fps-control' }, [fpsSelect, customFps]);
  const selectedResolution = working?.resolution ?? '1080p';
  const bitrateRange = recordingBitrateRange(selectedResolution);
  const bitrate = el('input', {
    class: 'recording-number',
    type: 'number',
    step: 'any',
    value: working?.bitrateKbps ?? bitrateRange.default,
  }) as HTMLInputElement;
  bitrate.title = 'Enter any positive bitrate in Kbps';
  bitrate.addEventListener('input', () => {
    const value = Number(bitrate.value);
    if (Number.isFinite(value) && value > 0) stagePatch({ bitrateKbps: value }, false);
  });
  const encoder = select(working?.encoderId ?? 'automatic', encoderOptions(), (value) => stagePatch({ encoderId: value }));
  const resolution = select(selectedResolution, RESOLUTIONS, (value) => stagePatch({ resolution: value }));
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
    ]),
    el('div', { class: 'recording-quality-meta' }, [
      el('span', { class: 'recording-quality-meta-item' }, [el('span', { text: 'Bitrate Recommendation' }), el('strong', { text: bitrateRange.label })]),
      el('span', { class: 'recording-quality-meta-item' }, [el('span', { text: 'Estimated video size' }), el('strong', { text: `≈ ${estimatedVideoSizePerMinute(Number(working?.bitrateKbps ?? bitrateRange.default))} / min` })]),
    ]),
    el('p', { class: 'recording-panel-note recording-quality-note', text: status.running
      ? 'Active capture uses the applied profile.'
      : 'Apply changes before capture.' }),
  ]);
}

function renderReplaySettings(): HTMLElement {
  const working = settingsForRender();
  const replay = el('input', {
    class: 'recording-number',
    type: 'number',
    min: 5,
    max: 3600,
    step: 5,
    value: working?.replayLengthSec ?? DEFAULT_REPLAY_LENGTH_SEC,
  }) as HTMLInputElement;
  replay.addEventListener('change', () => stagePatch({ replayLengthSec: Number(replay.value) }));
  return el('section', { class: 'recording-panel recording-replay-settings' }, [
    el('div', { class: 'recording-panel-heading recording-panel-heading-compact' }, [
      el('div', {}, [el('span', { class: 'recording-eyebrow', text: 'Clip window' }), el('h2', { class: 'recording-panel-title', text: 'Replay length' })]),
      el('span', { class: 'recording-panel-badge', text: '5–3600 seconds' }),
    ]),
    field('Seconds to keep available', replay, 'Saved when you press Save Clip.'),
  ]);
}

function deviceOptions(devices: RecordingAudioDevice[], selected: string): Array<[string, string]> {
  const options: Array<[string, string]> = [['', 'Default device']];
  for (const device of devices) {
    if (device.deviceId && !options.some(([id]) => id === device.deviceId)) options.push([device.deviceId, device.name || device.deviceId]);
  }
  if (selected && !options.some(([id]) => id === selected)) options.push([selected, 'Saved device (unavailable)']);
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
  const audio = settingsForRender()?.audio ?? {
    microphone: { enabled: false, deviceId: '', volume: 1, mono: false },
    system: { enabled: true, deviceId: '', volume: 1 },
    sourceMode: 'system' as const,
    customProcesses: [],
  };
  const microphoneEnabled = el('input', { type: 'checkbox', checked: audio.microphone.enabled, 'aria-label': 'Enable microphone' }) as HTMLInputElement;
  microphoneEnabled.addEventListener('change', () => stagePatch({ audio: { microphone: { enabled: microphoneEnabled.checked } } }));
  const microphoneDevice = select(audio.microphone.deviceId, deviceOptions(status.audioInputs, audio.microphone.deviceId), (value) => stagePatch({ audio: { microphone: { deviceId: value } } }));
  const microphoneMono = el('input', { type: 'checkbox', checked: audio.microphone.mono, 'aria-label': 'Mono microphone' }) as HTMLInputElement;
  microphoneMono.addEventListener('change', () => stagePatch({ audio: { microphone: { mono: microphoneMono.checked } } }));
  const sourceMode = select(audio.sourceMode, [['system', 'Full PC'], ['custom', 'Up to 3 processes']], (value) => stagePatch({ audio: { sourceMode: value } }));
  const systemEnabled = el('input', { type: 'checkbox', checked: audio.system.enabled, disabled: audio.sourceMode === 'custom', 'aria-label': 'Enable full PC audio' }) as HTMLInputElement;
  systemEnabled.addEventListener('change', () => stagePatch({ audio: { system: { enabled: systemEnabled.checked } } }));
  const systemDevice = select(audio.system.deviceId, deviceOptions(status.audioOutputs, audio.system.deviceId), (value) => stagePatch({ audio: { system: { deviceId: value } } }));
  const processSelects = [0, 1, 2].map((index) => {
    const selected = audio.customProcesses[index] ?? '';
    const processSelect = select(selected, recordingProcessOptions(selected), (value) => {
      const next = audio.customProcesses.slice(0, 3);
      next[index] = value;
      stagePatch({ audio: { customProcesses: next.filter(Boolean) } });
    });
    processSelect.classList.add('recording-process-select');
    processSelect.disabled = audio.sourceMode !== 'custom';
    return processSelect;
  });
  const processCount = audio.customProcesses.filter(Boolean).length;
  const sourceLabel = audio.sourceMode === 'custom' ? `${processCount}/3 processes` : 'Full PC';
  return el('section', { class: 'recording-panel recording-audio-panel' }, [
    el('div', { class: 'recording-panel-heading recording-panel-heading-compact' }, [
      el('div', {}, [el('span', { class: 'recording-eyebrow', text: 'Audio capture' }), el('h2', { class: 'recording-panel-title', text: 'Microphone and sound source' })]),
    ]),
    el('div', { class: 'recording-audio-summary' }, [
      el('div', { class: 'recording-audio-summary-item' }, [el('span', { text: 'Microphone' }), el('strong', { class: audio.microphone.enabled ? 'text-ok' : undefined, text: audio.microphone.enabled ? 'On' : 'Off' })]),
      el('div', { class: 'recording-audio-summary-item' }, [el('span', { text: 'Source' }), el('strong', { text: sourceLabel })]),
      el('div', { class: 'recording-audio-summary-item' }, [el('span', { text: 'Profile' }), el('strong', { class: settingsDirty ? 'text-warn' : 'text-ok', text: settingsDirty ? 'Unsaved' : 'Applied' })]),
    ]),
    el('div', { class: 'recording-audio-sections' }, [
      el('div', { class: 'recording-audio-section' }, [
        el('h3', { text: 'Microphone' }),
        el('label', { class: 'recording-check-row' }, [microphoneEnabled, el('span', { text: 'Include microphone' })]),
        field('Device', microphoneDevice),
        field('Volume', volumeControl(audio.microphone.volume, 'Microphone volume', (value) => stagePatch({ audio: { microphone: { volume: value } } }, false))),
        el('label', { class: 'recording-check-row' }, [microphoneMono, el('span', { text: 'Force mono' })]),
      ]),
      el('div', { class: 'recording-audio-section' }, [
        el('h3', { text: 'Sound source' }),
        field('Capture source', sourceMode, 'Full PC or up to 3 processes.'),
        el('label', { class: 'recording-check-row' }, [systemEnabled, el('span', { text: 'Include full PC audio' })]),
        field('Output device', systemDevice),
        field('Output volume', volumeControl(audio.system.volume, 'System audio volume', (value) => stagePatch({ audio: { system: { volume: value } } }, false))),
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
  const working = settingsForRender();
  const make = (key: 'start' | 'stop' | 'saveClip' | 'screenshot', label: string, description: string): HTMLElement => {
    const input = el('input', {
      class: 'recording-hotkey',
      type: 'text',
      value: working?.hotkeys[key] ?? '',
      maxlength: 32,
      'aria-label': label,
    }) as HTMLInputElement;
    input.addEventListener('change', () => stagePatch({ hotkeys: { [key]: input.value } as Partial<RecordingSettings['hotkeys']> }));
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
    el('p', { class: 'recording-panel-note', text: 'Works from any window.' }),
    make('start', 'Start recording', 'Begin a full video capture.'),
    make('stop', 'Stop capture', 'Finish the active video or replay buffer.'),
    make('saveClip', 'Save clip', 'Export the configured replay window.'),
    make('screenshot', 'Screenshot', 'Save the selected display or window as a PNG.'),
  ]);
}

function quickSetupItem(label: string, value: string): HTMLElement {
  return el('div', { class: 'recording-quickstart-item' }, [
    el('span', { text: label }),
    el('strong', { text: value }),
  ]);
}

function renderFirstCaptureSetup(): HTMLElement | null {
  const working = settingsForRender();
  if (!working || clips.length > 0) return null;
  const audio = working.audio.sourceMode === 'custom' ? 'Up to 3 processes' : 'Full PC audio';
  return el('details', { class: 'recording-quickstart' }, [
    el('summary', { class: 'recording-quickstart-summary' }, [
      el('span', { class: 'recording-quickstart-title', text: 'First capture' }),
      el('span', { class: 'recording-field-note', text: 'Quick setup' }),
    ]),
    el('div', { class: 'recording-quickstart-grid' }, [
      quickSetupItem('Save to', compactPath(working.location)),
      quickSetupItem('Video', `${captureProfileLabel(working)}`),
      quickSetupItem('Audio', audio),
      quickSetupItem('Hotkeys', `${working.hotkeys.start} / ${working.hotkeys.stop} / ${working.hotkeys.saveClip} / ${working.hotkeys.screenshot}`),
    ]),
  ]);
}

function renderStorage(): HTMLElement {
  const working = settingsForRender();
  const location = el('input', {
    class: 'recording-input',
    type: 'text',
    value: working?.location ?? '',
    placeholder: 'Choose a capture folder',
  }) as HTMLInputElement;
  location.addEventListener('change', () => stagePatch({ location: location.value }));
  const locationValue = working?.location ?? '';
  const pendingLocation = settingsDirty && !sameRecordingPath(locationValue, storageInfo?.location);
  const spaceText = !locationValue
    ? 'Choose a folder'
    : pendingLocation
      ? 'Apply to check this drive'
      : !storageInfo
        ? 'Checking space…'
        : storageInfo.freeBytes === null
          ? 'Space unavailable'
          : `${formatBytes(storageInfo.freeBytes)} free${storageInfo.totalBytes === null ? '' : ` of ${formatBytes(storageInfo.totalBytes)}`}`;
  return el('section', { class: 'recording-panel recording-storage-panel' }, [
    el('div', { class: 'recording-panel-heading recording-panel-heading-compact' }, [
      el('div', {}, [el('span', { class: 'recording-eyebrow', text: 'Files' }), el('h2', { class: 'recording-panel-title', text: 'Save location' })]),
      el('div', { class: 'recording-storage-heading-meta' }, [
        el('div', { class: 'recording-storage-space' }, [
          el('span', { class: 'recording-field-label', text: 'Available space' }),
          el('strong', { text: spaceText }),
        ]),
        el('span', { class: 'recording-panel-badge', text: 'Recordings and clips' }),
      ]),
    ]),
    el('div', { class: 'recording-storage-controls' }, [
      field('Recording folder', el('div', { class: 'recording-input-row' }, [location, button('Browse', () => void chooseFolder(), 'btn btn-secondary'), button('Open folder', () => void api.recordingOpenFolder().catch((err) => toast('error', 'Recording folder', messageOf(err))), 'btn btn-secondary', !locationValue)])),
      renderRecordingPillSetting(),
    ]),
  ]);
}

function renderManualView(): HTMLElement {
  return el('div', { class: 'recording-content recording-manual-content' }, [
    renderFirstCaptureSetup(),
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

function previewVideo(clip: RecordingClip, hoverTarget: HTMLElement, onDuration: (seconds: number) => void): HTMLElement {
  const host = el('div', { class: 'recording-clip-preview-host' });
  const thumbnail = el('div', { class: 'recording-clip-thumbnail', 'aria-hidden': 'true' });
  const thumbnailFallback = el('div', { class: 'recording-clip-thumbnail-fallback' }, [
    el('span', { class: 'recording-clip-thumbnail-mark' }, [el('span', { class: 'recording-clip-play-icon', text: '▶' })]),
    el('span', { class: 'recording-clip-thumbnail-label', text: 'Preview' }),
  ]);
  thumbnail.append(thumbnailFallback);
  if (clip.thumbnailUrl) {
    const thumbnailImage = el('img', {
      class: 'recording-clip-thumbnail-image',
      src: clip.thumbnailUrl,
      alt: '',
      loading: 'lazy',
      decoding: 'async',
    }) as HTMLImageElement;
    thumbnailImage.addEventListener('load', () => {
      thumbnail.classList.add('recording-clip-thumbnail-has-image');
    });
    thumbnailImage.addEventListener('error', () => {
      thumbnailImage.remove();
    });
    thumbnail.prepend(thumbnailImage);
  }
  host.append(thumbnail);

  let preview: HTMLVideoElement | null = null;
  let hovered = false;
  let hoverTimer: number | null = null;
  let loadStarted = false;
  const playPreview = () => {
    if (!hovered || !preview?.src) return;
    preview.muted = true;
    preview.volume = 0;
    void preview.play().catch(() => { /* unavailable previews stay quiet */ });
  };
  const stopPreview = () => {
    if (!preview) return;
    preview.pause();
    try { preview.currentTime = 0; } catch { /* metadata may not have loaded */ }
  };
  const clearHoverTimer = () => {
    if (hoverTimer === null) return;
    window.clearTimeout(hoverTimer);
    hoverTimer = null;
  };
  const loadPreview = () => {
    if (!hovered || loadStarted || !host.isConnected) return;
    loadStarted = true;
    preview = el('video', {
      class: 'recording-clip-preview',
      muted: true,
      defaultMuted: true,
      loop: true,
      playsinline: true,
      preload: 'metadata',
      ...(clip.thumbnailUrl ? { poster: clip.thumbnailUrl } : {}),
    }) as HTMLVideoElement;
    preview.addEventListener('canplay', () => {
      thumbnail.hidden = true;
      playPreview();
    });
    preview.addEventListener('loadedmetadata', () => {
      if (preview) onDuration(preview.duration);
    });
    host.append(preview);
    void api.recordingClipUrl(clip.id).then((url) => {
      if (!preview?.isConnected) return;
      preview.src = url;
      preview.load();
      playPreview();
    }).catch(() => {
      if (preview?.isConnected) preview.dataset.previewError = 'true';
    });
  };
  hoverTarget.addEventListener('mouseenter', () => {
    hovered = true;
    clearHoverTimer();
    hoverTimer = window.setTimeout(() => {
      hoverTimer = null;
      loadPreview();
      playPreview();
    }, 500);
  });
  hoverTarget.addEventListener('mouseleave', () => {
    hovered = false;
    clearHoverTimer();
    stopPreview();
  });
  return host;
}

function renderClipList(): HTMLElement {
  const query = el('input', { class: 'recording-search', type: 'search', placeholder: 'Search clips…', 'aria-label': 'Search clips' }) as HTMLInputElement;
  const list = el('div', { class: 'recording-clip-list' });
  const filter = select(clipLibraryFilter, [['all', 'All captures'], ['clips', 'Clips'], ['recordings', 'Recordings']], (value) => { clipLibraryFilter = value; draw(); });
  filter.classList.add('recording-library-filter');
  filter.setAttribute('aria-label', 'Filter captures');
  const sort = select(clipLibrarySort, [['newest', 'Newest first'], ['oldest', 'Oldest first']], (value) => { clipLibrarySort = value; draw(); });
  sort.classList.add('recording-library-filter');
  sort.setAttribute('aria-label', 'Sort captures');
  const count = el('span', { class: 'recording-library-count', text: `${clips.length} captures` });
  const draw = () => {
    clear(list);
    const needle = query.value.trim().toLowerCase();
    const visible = clips
      .filter((clip) => clipLibraryFilter === 'all' || recordingClipKind(clip) === (clipLibraryFilter === 'recordings' ? 'recording' : 'clip'))
      .filter((clip) => !needle || clip.fileName.toLowerCase().includes(needle))
      .sort((left, right) => {
        const leftTime = Date.parse(left.modifiedAt ?? left.createdAt) || 0;
        const rightTime = Date.parse(right.modifiedAt ?? right.createdAt) || 0;
        return clipLibrarySort === 'newest' ? rightTime - leftTime : leftTime - rightTime;
      });
    count.textContent = `${visible.length} ${visible.length === 1 ? 'capture' : 'captures'}`;
    if (visible.length === 0) {
      list.append(el('p', { class: 'recording-empty', text: clips.length ? 'No captures match this view.' : 'No captures found yet.' }));
      return;
    }
    for (const clip of visible) {
      const kind = recordingClipKind(clip);
      const duration = el('span', { class: 'recording-clip-duration', text: '—' });
      const media = el('div', { class: 'recording-clip-media' });
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
      media.append(
        previewVideo(clip, media, (seconds) => { duration.textContent = formatTime(seconds); }),
        duration,
        el('span', { class: 'recording-clip-hover-action' }, [el('span', { class: 'recording-clip-play-icon', text: '▶' }), el('span', { text: 'Open player' })]),
      );
      tile.append(
        media,
        el('span', { class: 'recording-clip-details' }, [
          el('strong', { text: clip.fileName }),
          el('span', { class: 'recording-clip-meta' }, [
            el('span', { class: `recording-clip-kind recording-clip-kind-${kind}`, text: kind === 'recording' ? 'Recording' : 'Clip' }),
            el('span', { text: `Arc Capture · ${new Date(clip.modifiedAt ?? clip.createdAt).toLocaleString()}` }),
          ]),
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
        filter,
        sort,
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
      const inlineSeek = el('input', { class: 'recording-player-seek recording-player-seek-inline', type: 'range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Seek clip' }) as HTMLInputElement;
      const timelineSeek = el('input', { class: 'recording-player-seek recording-player-seek-secondary', type: 'range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Seek clip on timeline' }) as HTMLInputElement;
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
        const progress = video.duration > 0 ? Math.min(100, Math.max(0, (video.currentTime / video.duration) * 100)) : 0;
        const value = String(Math.round(progress * 10));
        for (const control of [inlineSeek, timelineSeek]) {
          control.value = value;
          control.style.setProperty('--progress', `${progress}%`);
        }
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
      const seekTo = (control: HTMLInputElement) => {
        if (video.duration > 0) {
          video.currentTime = (Number(control.value) / 1000) * video.duration;
          updateTimeline();
        }
      };
      inlineSeek.addEventListener('input', () => seekTo(inlineSeek));
      timelineSeek.addEventListener('input', () => seekTo(timelineSeek));
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
        const fullscreenTarget = player as HTMLElement & { requestFullscreen?: () => Promise<void> };
        if (document.fullscreenElement === player) void document.exitFullscreen?.();
        else void fullscreenTarget.requestFullscreen?.();
      }, 'recording-player-fullscreen');
      const playerBrand = el('a', {
        class: 'recording-player-brand',
        href: 'https://github.com/YamsSE/Arc-Power',
        title: 'Open Arc Power on GitHub',
        onClick: (event: Event) => {
          event.preventDefault();
          void api.openExternal('https://github.com/YamsSE/Arc-Power').catch(() => {
            toast('error', 'Could not open GitHub', 'The repository link could not be opened.');
          });
        },
      }, [
        el('img', { class: 'recording-player-brand-logo', src: '../assets/ArcPowerIcon.png', alt: 'Arc Power logo' }),
        el('span', { text: 'Arc Power' }),
      ]) as HTMLAnchorElement;
      clear(player);
      player.append(
        video,
        el('div', { class: 'recording-player-overlay' }, [
          el('div', { class: 'recording-player-progress' }, [inlineSeek]),
          el('div', { class: 'recording-player-controls' }, [
            playButton,
            muteButton,
            volume,
            el('div', { class: 'recording-player-time-pair' }, [elapsed, el('span', { text: '/' }), duration]),
            el('span', { class: 'recording-player-controls-spacer' }),
            playerBrand,
            fullscreen,
          ]),
        ]),
      );
      clear(timelinePanel);
      timelinePanel.append(
        el('div', { class: 'recording-player-timeline-heading' }, [
          el('div', {}, [el('span', { class: 'recording-eyebrow', text: 'Clip timeline' }), el('strong', { text: 'Review your moment' })]),
          durationLabel,
        ]),
        el('div', { class: 'recording-player-timeline-row' }, [timelineElapsed, timelineSeek, timelineDuration]),
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
  applySettingsButton = null;
  clear(renderContainer);
  renderContainer.append(
    el('div', { class: 'page-heading recording-heading' }, [
      el('div', {}, [
        el('span', { class: 'recording-eyebrow', text: 'Arc Capture' }),
        el('h1', { text: 'Recording' }),
      ]),
      activeTab === 'manual' ? renderRecordingHeadingActions() : null,
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
  const mode = modeForTab(tab);
  if (settings && mode && settingsForRender()?.mode !== mode) stagePatch({ mode }, false);
  activeTab = tab;
  render();
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

async function refreshRecordingStorage(): Promise<void> {
  try {
    storageInfo = await api.recordingStorageInfo();
  } catch {
    storageInfo = null;
  }
  if (renderContainer) render();
}

async function load(): Promise<void> {
  if (loading) return;
  loading = true;
  const loadStateRevision = recordingStateRevision;
  try {
    const [loadedSettings, loadedStatus, loadedClips, loadedStorage, profileEnvelope] = await Promise.all([
      api.recordingSettingsGet(),
      api.recordingStatus(),
      api.recordingClipsList(),
      api.recordingStorageInfo().catch(() => null),
      api.profilesList().catch(() => null),
    ]);
    settings = loadedSettings;
    draftSettings = cloneRecordingSettings(loadedSettings);
    fpsCustomEditing = false;
    settingsDirty = false;
    // The startup probe and the page load run concurrently. If the probe
    // pushed a newer encoder list while the clip/settings reads were still
    // pending, never restore the older status snapshot returned by the
    // initial recordingStatus request.
    if (recordingStateRevision === loadStateRevision) setStatus(loadedStatus);
    clips = loadedClips;
    storageInfo = loadedStorage;
    recordingPillEnabled = profileEnvelope?.settings?.overlayRecordingPill === true;
    activeTab = tabForMode(settings.mode);
    const canonicalMode = modeForTab(activeTab) ?? 'manual';
    if (settings.mode !== canonicalMode) {
      // Older settings remain usable: map every full-session variant to the
      // manual tab, and persist only the two current renderer choices.
      void api.recordingSettingsSave({ mode: canonicalMode }).then((result) => {
        settings = result.settings;
        draftSettings = cloneRecordingSettings(result.settings);
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
  if (actionBusy || settingsDirty || applyingSettings) {
    if (settingsDirty) toast('info', 'Apply settings first', 'Apply your recording changes before starting a capture.');
    return;
  }
  actionBusy = true;
  render();
  try {
    const result = await api.recordingStart();
    setStatus(result.state);
  } catch (err) {
    status = { ...status, error: messageOf(err) };
  } finally {
    actionBusy = false;
    render();
  }
}

async function startReplay(): Promise<void> {
  if (actionBusy || settingsDirty || applyingSettings) {
    if (settingsDirty) toast('info', 'Apply settings first', 'Apply your recording changes before starting the replay buffer.');
    return;
  }
  actionBusy = true;
  render();
  try {
    const result = await api.recordingReplayStart();
    setStatus(result.state);
  } catch (err) {
    status = { ...status, error: messageOf(err) };
  } finally {
    actionBusy = false;
    render();
  }
}

async function stopCapture(mode: 'video' | 'replay' | null = null): Promise<void> {
  if (actionBusy) return;
  actionBusy = true;
  render();
  try {
    setStatus(await api.recordingStop(mode));
    await loadClips();
  } catch (err) {
    status = { ...status, error: messageOf(err) };
  } finally {
    actionBusy = false;
    render();
  }
}

async function saveClip(): Promise<void> {
  const replayRunning = status.activeModes?.replay === true || (!status.activeModes && status.running && status.mode === 'replay');
  if (actionBusy || !replayRunning) return;
  actionBusy = true;
  render();
  try {
    const replayLengthSec = settings?.replayLengthSec ?? DEFAULT_REPLAY_LENGTH_SEC;
    await api.recordingClipSave({ headDurationMs: replayLengthSec * 1000 });
    await loadClips();
  } catch (err) {
    // The main IPC action channel owns the global action error toast. The
    // library refresh has its own error path, so do not duplicate the action
    // failure here.
    status = { ...status, error: messageOf(err) };
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
    if (!result.canceled && result.location) {
      storageInfo = null;
      stagePatch({ location: result.location });
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
        setStatus(next);
        if (renderContainer === container) render();
      });
    }
    // Do not make first paint wait for settings, clip scanning, or an engine
    // probe. Startup owns the runtime probe; this page refreshes its cached
    // state asynchronously after the shell and controls are visible.
    render();
    void load();
    void refreshRecordingCaptureTargets();
  },
  leave(): void {
    unsubscribeRecordingState?.();
    unsubscribeRecordingState = null;
    disposePlayerVideo();
    applySettingsButton = null;
    draftSettings = null;
    settingsDirty = false;
    applyingSettings = false;
    fpsCustomEditing = false;
    storageInfo = null;
    recordingPillEnabled = false;
    recordingTargets = { displays: [], windows: [] };
    recordingTargetsBusy = false;
    renderContainer = null;
    playerClip = null;
  },
};
