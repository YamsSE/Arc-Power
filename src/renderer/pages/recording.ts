// Arc Power recording page. The renderer only uses the typed preload bridge;
// capture processes, files, and media authorization remain main-owned.
import { el, clear, svgEl } from '../dom.ts';
import { api } from '../ipc.ts';
import type { Page, PageContext } from '../router.ts';
import type { DeviceInfo, RecordingAudioDevice, RecordingCaptureTarget, RecordingCaptureTargets, RecordingClip, RecordingClipDeleteResult, RecordingEditorJob, RecordingEngineState, RecordingMode, RecordingResolution, RecordingSettings, RecordingSettingsPatch, RecordingStorageInfo, RecordingTab } from '../types.ts';
import { toast } from '../components/toast.ts';
import { showRecordingClipDeleteConfirm } from '../components/recording-delete-dialog.ts';
import { showRecordingShareDialog, type RecordingShareDialogHandle } from '../components/recording-share-dialog.ts';
import { showRecordingHotkeyDialog } from '../components/recording-hotkey-dialog.ts';
import { buildDropdown, type DropdownElement } from '../components/dropdown.ts';
import { parseRecordingEncoderSelection, recordingAdapterTargetOf, recordingBitrateRange, recordingGpuEncoderOptions, recordingGpuEncoderRows, recordingMessage } from '../pure/recording.ts';
import { clampRecordingEditorRange, normalizeRecordingEditorClipName, recordingEditorResumePosition, recordingEditorSelectionFromRatios, recordingEditorSeekTargetMs, recordingEditorTimelineMsFromRatio } from '../pure/recording-editor.ts';

const TABS: Array<[RecordingTab, string, string]> = [
  ['manual', 'Manual Recording', 'Capture a full video when you choose.'],
  ['clips', 'Instant Replay', 'Keep a rolling buffer and save the last moments.'],
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
const PLAYBACK_SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const PLAYBACK_SPEED_MIN = 0.1;
const PLAYBACK_SPEED_MAX = 4;
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
let unsubscribeRecordingSettings: (() => void) | null = null;
let unsubscribeRecordingPillSettings: (() => void) | null = null;
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
let recordingDevices: DeviceInfo[] = [];
let editorPollTimer: number | null = null;

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
  if (editorPollTimer !== null) {
    window.clearInterval(editorPollTimer);
    editorPollTimer = null;
  }
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

function select<T extends string>(value: T, options: Array<[T, string]>, ariaLabel: string, onChange: (value: T) => void): DropdownElement {
  return buildDropdown(value, options.map(([id, label]) => ({ value: id, label })), {
    className: 'recording-select',
    ariaLabel,
    onChange: (next) => onChange(next as T),
  });
}

type SelectOptionGroup<T extends string> = [string, Array<[T, string]>];

function groupedSelect<T extends string>(value: T, groups: SelectOptionGroup<T>[], ariaLabel: string, onChange: (value: T) => void): DropdownElement {
  return buildDropdown(value, groups.flatMap(([group, options]) => options.map(([id, label]) => ({
    value: id,
    label,
    group,
  }))), {
    className: 'recording-select',
    ariaLabel,
    onChange: (next) => onChange(next as T),
  });
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
  const selection = parseRecordingEncoderSelection(id);
  if (selection) {
    const concrete = recordingGpuEncoderOptions(recordingDevices, status.encoders).find(([optionId]) => optionId === id);
    if (concrete) return concrete[1];
    const matchingDevice = recordingDevices.find((device) => {
      const target = recordingAdapterTargetOf(device);
      if (!target) return false;
      if (selection.target.deviceKey && target.deviceKey) return selection.target.deviceKey === target.deviceKey;
      if (selection.target.bdf && target.bdf) return JSON.stringify(selection.target.bdf) === JSON.stringify(target.bdf);
      return Boolean(selection.target.luid && target.luid && selection.target.luid === target.luid);
    });
    const name = matchingDevice?.name ?? selection.deviceName ?? 'GPU';
    const sku = name.match(/\b[AB]\d{3}\b/i)?.[0]?.toUpperCase();
    const codec = selection.codec === 'obs_qsv11_av1' ? 'AV1' : selection.codec === 'obs_qsv11_hevc' ? 'HEVC' : 'H264';
    return `${sku ?? name} ${codec}`;
  }
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
    showCursor: value.showCursor,
    replayLengthSec: value.replayLengthSec,
    instantReplayAutoStart: value.instantReplayAutoStart,
    replayMarkersEnabled: value.replayMarkersEnabled,
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

function encoderOptions(selectedId: string): Array<[string, string]> {
  const options: Array<[string, string]> = [['automatic', 'Automatic']];
  const known = new Map(status.encoders.filter((encoder) => INTEL_QSV_ENCODERS.has(encoder.type)).map((encoder) => [encoder.type, encoder]));
  const concrete = recordingGpuEncoderOptions(recordingDevices, status.encoders);
  options.push(...concrete);
  const checking = status.probeComplete !== true && status.encoders.length === 0
    && (!status.error || /^Loading recording engine/i.test(status.error));
  for (const [id, label] of [['obs_qsv11_v2', 'Intel H264'], ['obs_qsv11_hevc', 'Intel HEVC'], ['obs_qsv11_av1', 'Intel AV1']] as const) {
    // Once concrete choices exist, keep the dropdown focused on physical
    // GPU+codec pairs. A legacy global ID is retained only when it is the
    // persisted selection, so old settings remain representable and usable.
    if (concrete.length && id !== selectedId) continue;
    const encoder = known.get(id);
    const unavailable = !encoder
      ? checking ? ' — checking…' : ' — unavailable'
      : (encoder.startTested && !encoder.startSupported) || encoder.probeValid !== true ? ' — unavailable' : '';
    options.push([id, `${encoder ? encoderLabel(encoder) : label}${concrete.length ? ' (legacy)' : ''}${unavailable}`]);
  }
  // Keep an older persisted global ID visible even if a future renderer
  // cannot currently enumerate a stable physical target for it.
  if (selectedId && !options.some(([id]) => id === selectedId)) options.push([selectedId, selectedEncoderLabel(selectedId)]);
  return options;
}

function renderGpuEncoderInventory(): HTMLElement {
  const rows = recordingGpuEncoderRows(recordingDevices, status.encoders);
  const body = rows.length
    ? rows.map((row) => el('div', { class: 'recording-encoder-row' }, [
      el('span', { class: 'recording-encoder-device', text: row.deviceName }),
      el('strong', { class: 'recording-encoder-codecs', text: row.encoderLabels.join(' · ') }),
    ]))
    : [el('p', { class: 'recording-encoder-empty', text: status.probeComplete === true ? 'No GPU encoders were verified.' : 'Checking encoder availability…' })];
  return el('div', { class: 'recording-encoder-inventory' }, [
    el('div', { class: 'recording-encoder-heading' }, [
      el('span', { class: 'recording-field-label', text: 'GPU encoder inventory' }),
      el('span', { class: 'recording-field-note', text: 'Detected codecs by graphics adapter' }),
    ]),
    ...body,
  ]);
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
  const instantReplaySaving = status.instantReplaySave?.status === 'saving';
  const instantReplaySaveLabel = instantReplaySaving ? 'Saving Instant Replay…' : 'Save Instant Replay';
  const instantReplaySaveError = status.instantReplaySave?.status === 'error';
  const captureNeedsApply = settingsDirty || applyingSettings;
  return el('div', { class: 'recording-capture-actions' }, [
    button(recordingRunning ? 'Stop Recording' : 'Start Recording', () => void (recordingRunning ? stopCapture('video') : startRecording()), `btn ${recordingRunning ? 'btn-recording-stop' : 'btn-primary'}`, !status.available || actionBusy || (!recordingRunning && captureNeedsApply)),
    button(replayRunning ? 'Stop Instant Replay' : 'Start Instant Replay', () => void (replayRunning ? stopCapture('replay') : startReplay()), `btn ${replayRunning ? 'btn-recording-stop' : 'btn-secondary'}`, !status.available || actionBusy || (!replayRunning && captureNeedsApply)),
    button(instantReplaySaveLabel, () => void saveClip(), 'btn btn-secondary', !status.available || !replayRunning || actionBusy || instantReplaySaving),
    settingsDirty ? el('span', { class: 'recording-inline-note recording-unsaved-note', text: 'Apply changes before capture.' }) : null,
    instantReplaySaving ? el('span', { class: 'recording-inline-note recording-live-note', text: 'Instant Replay is being saved…' }) : null,
    instantReplaySaveError ? el('span', { class: 'recording-inline-error', text: status.instantReplaySave?.error ?? 'Instant Replay could not be saved. Try again.' }) : null,
    recordingRunning && replayRunning ? el('span', { class: 'recording-inline-note recording-live-note', text: 'Recording and Instant Replay are both active.' }) : null,
    recordingRunning || replayRunning ? el('span', { class: 'recording-inline-note recording-live-note', text: 'APM capture active · saved clips include the activity wave.' }) : null,
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
        'aria-label': 'Recording Pill overlay',
        checked: recordingPillEnabled,
        onchange: (ev: Event) => void onRecordingPillToggle((ev.target as HTMLInputElement).checked),
      }),
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
    el('p', { class: 'recording-panel-note', text: `Full recording or ${replayLength}-second Instant Replay window.` }),
    working ? el('div', { class: 'recording-profile-strip' }, [
      el('div', { class: 'recording-profile-copy' }, [
        el('span', { class: 'recording-field-label', text: 'Capture profile' }),
        el('strong', { text: captureProfileLabel(working) }),
      ]),
      el('span', { class: `recording-settings-state${settingsDirty ? ' is-unsaved' : ''}`, text: settingsDirty ? 'Unsaved' : 'Applied' }),
    ]) : null,
    renderCaptureActions(),
    renderCaptureTargetSettings(),
    renderCaptureCursorSetting(),
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
  const targetSelect = groupedSelect(captureTargetControlKey(target), captureTargetOptionGroups(target), 'Capture target', (value) => {
    const next = captureTargetFromKey(value);
    if (next) stagePatch({ captureTarget: next });
  });
  const colorMode = select(working?.captureColorMode ?? 'auto', [['auto', 'Auto'], ['sdr', 'SDR'], ['hdr', 'HDR']], 'Capture color mode', (value) => stagePatch({ captureColorMode: value }));
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

function renderCaptureCursorSetting(): HTMLElement {
  const working = settingsForRender();
  return el('div', { class: 'recording-cursor-setting' }, [
    el('div', { class: 'recording-cursor-setting-copy' }, [
      el('strong', { text: 'Show cursor in recording' }),
      el('span', { class: 'recording-field-note', text: 'Includes the mouse pointer in display and window captures.' }),
    ]),
    el('label', { class: 'recording-check-row' }, [
      el('input', {
        type: 'checkbox',
        class: 'settings-checkbox',
        ariaLabel: 'Show cursor in recording',
        checked: working?.showCursor === true,
        onchange: (event: Event) => stagePatch({ showCursor: (event.target as HTMLInputElement).checked }),
      }),
    ]),
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
  ], 'Frame rate', (value) => {
    if (value === 'custom') {
      fpsCustomEditing = true;
      stagePatch({ fps: currentFps }, true);
      return;
    }
    fpsCustomEditing = false;
    stagePatch({ fps: Number(value) });
  });
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
  const selectedEncoder = working?.encoderId ?? 'automatic';
  const encoder = select(selectedEncoder, encoderOptions(selectedEncoder), 'Encoder', (value) => stagePatch({ encoderId: value }));
  const resolution = select(selectedResolution, RESOLUTIONS, 'Resolution', (value) => stagePatch({ resolution: value }));
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
    renderGpuEncoderInventory(),
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
  const autoStart = el('input', { type: 'checkbox', class: 'settings-checkbox', checked: working?.instantReplayAutoStart === true, 'aria-label': 'Auto-start Instant Replay' }) as HTMLInputElement;
  autoStart.addEventListener('change', () => stagePatch({ instantReplayAutoStart: autoStart.checked }));
  const toggleCard = (title: string, note: string, input: HTMLInputElement): HTMLElement => el('div', { class: 'recording-replay-toggle-card' }, [
    el('div', { class: 'recording-replay-toggle-copy' }, [el('strong', { text: title }), el('span', { class: 'recording-field-note', text: note })]),
    el('label', { class: 'recording-check-row' }, [input]),
  ]);
  return el('section', { class: 'recording-panel recording-replay-settings' }, [
    el('div', { class: 'recording-panel-heading recording-panel-heading-compact' }, [
      el('div', {}, [el('span', { class: 'recording-eyebrow', text: 'Instant Replay window' }), el('h2', { class: 'recording-panel-title', text: 'Replay length' })]),
      el('span', { class: 'recording-panel-badge', text: '5–3600 seconds' }),
    ]),
    field('Seconds to keep available', replay, 'Saved when you press Save Instant Replay.'),
    toggleCard('Auto-start Instant Replay after launch', 'Start the rolling buffer once Arc Power finishes launching.', autoStart),
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
  const microphoneDevice = select(audio.microphone.deviceId, deviceOptions(status.audioInputs, audio.microphone.deviceId), 'Microphone device', (value) => stagePatch({ audio: { microphone: { deviceId: value } } }));
  const microphoneMono = el('input', { type: 'checkbox', checked: audio.microphone.mono, 'aria-label': 'Mono microphone' }) as HTMLInputElement;
  microphoneMono.addEventListener('change', () => stagePatch({ audio: { microphone: { mono: microphoneMono.checked } } }));
  const sourceMode = select(audio.sourceMode, [['system', 'Full PC'], ['custom', 'Up to 3 processes']], 'Capture source', (value) => stagePatch({ audio: { sourceMode: value } }));
  const systemEnabled = el('input', { type: 'checkbox', checked: audio.system.enabled, disabled: audio.sourceMode === 'custom', 'aria-label': 'Enable full PC audio' }) as HTMLInputElement;
  systemEnabled.addEventListener('change', () => stagePatch({ audio: { system: { enabled: systemEnabled.checked } } }));
  const systemDevice = select(audio.system.deviceId, deviceOptions(status.audioOutputs, audio.system.deviceId), 'Output device', (value) => stagePatch({ audio: { system: { deviceId: value } } }));
  const processSelects = [0, 1, 2].map((index) => {
    const selected = audio.customProcesses[index] ?? '';
    const processSelect = select(selected, recordingProcessOptions(selected), `Process ${index + 1}`, (value) => {
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
    const current = working?.hotkeys[key] ?? '';
    const focusPicker = (): void => {
      document.querySelector<HTMLButtonElement>(`[data-recording-hotkey="${key}"]`)?.focus();
    };
    const picker = el('button', {
      class: 'recording-hotkey',
      type: 'button',
      dataset: { recordingHotkey: key },
      title: current ? `Change ${label} hotkey` : `Set ${label} hotkey`,
      'aria-label': `${label} hotkey${current ? `: ${current}` : ': not set'}`,
      text: current,
      onClick: () => {
        void showRecordingHotkeyDialog(label, current).then((next) => {
          if (next === null) {
            focusPicker();
            return;
          }
          stagePatch({ hotkeys: { [key]: next } as Partial<RecordingSettings['hotkeys']> });
          focusPicker();
        });
      },
    }) as HTMLButtonElement;
    const conflict = status.hotkeys.conflicts[key];
    return el('div', { class: 'recording-hotkey-row' }, [
      el('div', { class: 'recording-hotkey-copy' }, [el('strong', { text: label }), el('span', { text: description })]),
      el('div', { class: 'recording-hotkey-status' }, [
        conflict ? el('span', { class: 'text-warn recording-hotkey-warning', text: `Not registered (${conflict} is in use)` }) : null,
        picker,
        button('NONE', () => stagePatch({ hotkeys: { [key]: '' } as Partial<RecordingSettings['hotkeys']> }), 'btn btn-secondary recording-hotkey-none'),
      ]),
    ]);
  };
  return el('section', { class: 'recording-panel' }, [
    el('div', { class: 'recording-panel-heading recording-panel-heading-compact' }, [
      el('div', {}, [el('span', { class: 'recording-eyebrow', text: 'Shortcuts' }), el('h2', { class: 'recording-panel-title', text: 'Hotkeys' })]),
      el('span', { class: 'recording-panel-badge', text: 'Global' }),
    ]),
    el('p', { class: 'recording-panel-note', text: 'Works from any window.' }),
    make('start', 'Start recording', 'Begin a full video capture.'),
    make('stop', 'Stop capture', 'Finish the active video or Instant Replay buffer.'),
    make('saveClip', 'Save Instant Replay', 'Export the configured Instant Replay window.'),
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

function formatPreciseTime(milliseconds: number): string {
  const safe = Math.max(0, Math.round(Number.isFinite(milliseconds) ? milliseconds : 0));
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const remainder = safe % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`;
}

function parseTimeInput(value: string): number {
  const text = value.trim();
  if (!text) return 0;
  if (text.includes(':')) {
    const parts = text.split(':');
    const minutes = Number(parts.at(-2));
    const seconds = Number(parts.at(-1));
    return Number.isFinite(minutes) && Number.isFinite(seconds) ? Math.max(0, Math.round((minutes * 60 + seconds) * 1000)) : 0;
  }
  const seconds = Number(text);
  return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : 0;
}

function playbackSpeedLabel(rate: number): string {
  if (Math.abs(rate - 1) < 0.001) return 'Normal';
  return `${Number(rate.toFixed(2))}x`;
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
      // The hover surface is the actual recording, not a generated low-res
      // preview. Let Chromium fetch enough of the original file to render it
      // cleanly at the tile's reduced size.
      preload: 'auto',
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
  const filter = select(clipLibraryFilter, [['all', 'All captures'], ['clips', 'Clips'], ['recordings', 'Recordings']], 'Filter captures', (value) => { clipLibraryFilter = value; draw(); });
  filter.classList.add('recording-library-filter');
  const sort = select(clipLibrarySort, [['newest', 'Newest first'], ['oldest', 'Oldest first']], 'Sort captures', (value) => { clipLibrarySort = value; draw(); });
  sort.classList.add('recording-library-filter');
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
      const editButton = button('Edit', () => openPlayer(clip), 'recording-clip-edit');
      editButton.setAttribute('aria-label', `Edit ${clip.fileName}`);
      list.append(el('article', { class: 'recording-clip-card' }, [tile, editButton, deleteButton]));
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

type RecordingEditorElement = HTMLElement & {
  updateDuration?: (durationMs: number) => void;
  updatePlayback?: (playbackMs: number) => void;
  getSelection?: () => { startMs: number; endMs: number };
  onSelectionChanged?: (range: { startMs: number; endMs: number }) => void;
};

type RecordingApmChartElement = HTMLElement & {
  updateDuration?: (durationMs: number) => void;
  updatePlayback?: (playbackMs: number) => void;
};

type RecordingTrackerElement = HTMLElement & {
  updateDuration?: (durationMs: number) => void;
  updatePlayback?: (playbackMs: number) => void;
};

function renderApmGraph(clip: RecordingClip, durationMs: number, extraClass = '', onSeek?: (atMs: number) => void): RecordingApmChartElement {
  // Keep the raw telemetry so a late video metadata event can establish the
  // authoritative playable span without allowing samples from the sampler's
  // shutdown tail to stretch the graph beyond the actual file.
  const allSamples = Array.isArray(clip.apmSamples) ? clip.apmSamples.filter((sample) => Number.isFinite(sample.atMs) && Number.isFinite(sample.apm)) : [];
  let samples = allSamples;
  let span = Math.max(1000, durationMs, ...allSamples.map((sample) => sample.atMs));
  const chart = el('div', { class: `recording-apm-chart recording-apm-chart-live${extraClass ? ` ${extraClass}` : ''}`, 'aria-label': samples.length || clip.apmAvailable === true ? 'APM timeline' : 'APM telemetry unavailable for this clip' }) as RecordingApmChartElement;
  let playbackMs = 0;
  const playhead = el('div', { class: 'recording-apm-playhead', 'aria-hidden': 'true' });
  const hoverCrosshair = el('div', { class: 'recording-apm-hover-crosshair', hidden: true, 'aria-hidden': 'true' });
  const tooltip = el('div', { class: 'recording-apm-tooltip', hidden: true });
  const trace = samples.length > 0 ? svgEl('polyline', { points: '' }) : null;
  const updateTrace = () => {
    if (trace) {
      const maxApm = Math.max(60, ...samples.map((sample) => sample.apm));
      trace.setAttribute('points', samples.map((sample) => {
        const x = Math.min(100, Math.max(0, (sample.atMs / span) * 100));
        const y = 38 - (Math.min(maxApm, Math.max(0, sample.apm)) / maxApm) * 32;
        return `${x.toFixed(3)},${y.toFixed(3)}`;
      }).join(' '));
    }
  };
  const timelineMsAtEvent = (event: MouseEvent): number => {
    const rect = chart.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return recordingEditorTimelineMsFromRatio((event.clientX - rect.left) / rect.width, span);
  };
  const placeTooltipAtSample = (sample: { atMs: number; apm: number }): void => {
    const width = chart.clientWidth || 0;
    const ratio = span > 0 ? Math.min(1, Math.max(0, sample.atMs / span)) : 0;
    const x = Math.min(width, Math.max(0, ratio * width));
    hoverCrosshair.style.left = `${x}px`;
    hoverCrosshair.hidden = false;
    tooltip.textContent = `${sample.apm}`;
    tooltip.hidden = false;
    // Keep the compact text next to the nearest sample's dashed line. It is
    // placed on the side with room, matching the Monitoring graph hover.
    const textWidth = tooltip.offsetWidth || 48;
    const textHeight = tooltip.offsetHeight || 10;
    const maxLeft = Math.max(1, width - textWidth - 1);
    const left = x <= width / 2 ? Math.min(maxLeft, x + 5) : Math.max(1, x - textWidth - 5);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = '2px';
  };
  const seekFromEvent = (event: MouseEvent): void => {
    const atMs = timelineMsAtEvent(event);
    playbackMs = atMs;
    onSeek?.(atMs);
    chart.updatePlayback?.(atMs);
  };
  chart.addEventListener('click', (event) => {
    seekFromEvent(event as MouseEvent);
  });
  chart.tabIndex = 0;
  chart.addEventListener('keydown', (event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key !== 'ArrowLeft' && keyboardEvent.key !== 'ArrowRight') return;
    keyboardEvent.preventDefault();
    const step = keyboardEvent.shiftKey ? 1000 : 100;
    const atMs = Math.min(span, Math.max(0, playbackMs + (keyboardEvent.key === 'ArrowRight' ? step : -step)));
    playbackMs = atMs;
    onSeek?.(atMs);
    chart.updatePlayback?.(atMs);
    if (samples.length > 0) {
      const sample = samples.reduce((best, candidate) => Math.abs(candidate.atMs - atMs) < Math.abs(best.atMs - atMs) ? candidate : best, samples[0]);
      placeTooltipAtSample(sample);
    }
  });
  if (samples.length > 0) {
    const svg = svgEl('svg', { class: 'recording-apm-trace', viewBox: '0 0 100 40', preserveAspectRatio: 'none', role: 'img', 'aria-label': 'APM activity wave' });
    if (trace) svg.append(trace);
    chart.append(svg);
    const nearest = (ratio: number) => samples.reduce((best, sample) => Math.abs(sample.atMs / span - ratio) < Math.abs(best.atMs / span - ratio) ? sample : best, samples[0]);
    const showTooltip = (event: MouseEvent) => {
      const rect = chart.getBoundingClientRect();
      const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) : 0;
      const sample = nearest(ratio);
      placeTooltipAtSample(sample);
    };
    chart.addEventListener('mousemove', showTooltip);
    chart.addEventListener('mouseleave', () => { tooltip.hidden = true; hoverCrosshair.hidden = true; });
    chart.addEventListener('focusout', () => { tooltip.hidden = true; hoverCrosshair.hidden = true; });
  } else {
    chart.append(el('div', { class: 'recording-apm-empty-trace', 'aria-hidden': 'true' }));
  }
  chart.append(playhead, hoverCrosshair, tooltip);
  chart.updateDuration = (nextDurationMs: number) => {
    if (!Number.isFinite(nextDurationMs) || nextDurationMs <= 0) return;
    const boundedDuration = Math.max(1000, Math.round(nextDurationMs));
    // Video metadata is the source of truth for the timeline. APM capture can
    // publish one or two samples after the encoder has closed; those points
    // must be clipped instead of moving the ruler/playhead past the video.
    samples = allSamples.filter((sample) => sample.atMs <= boundedDuration);
    span = boundedDuration;
    updateTrace();
  };
  chart.updatePlayback = (nextPlaybackMs: number) => {
    playbackMs = Math.min(span, Math.max(0, Number.isFinite(nextPlaybackMs) ? Math.round(nextPlaybackMs) : 0));
    playhead.style.left = `${Math.min(100, Math.max(0, (playbackMs / span) * 100))}%`;
    playhead.setAttribute('aria-label', `Playback position ${formatTime(playbackMs / 1000)}`);
  };
  updateTrace();
  chart.updatePlayback(0);
  return chart;
}

function renderRecordingEditor(clip: RecordingClip, getVideo: () => HTMLVideoElement | null, onCancel?: () => void): HTMLElement {
  // A file's byte length is not a playback duration. Start with a safe one
  // second range and replace it from the video's authoritative metadata.
  let durationMs = 1000;
  let job: RecordingEditorJob | null = null;
  let shareDialogHandle: RecordingShareDialogHandle | null = null;
  let shareDialogJobId: string | null = null;
  const clipName = el('input', { class: 'recording-editor-clip-name', type: 'text', value: clip.fileName.replace(/\.[^.]+$/, ''), maxlength: 96, 'aria-label': 'Clip name' }) as HTMLInputElement;
  const startTime = el('input', { class: 'recording-editor-time-input', type: 'text', inputmode: 'decimal', value: '0:00.000', 'aria-label': 'Clip start time' }) as HTMLInputElement;
  const endTime = el('input', { class: 'recording-editor-time-input', type: 'text', inputmode: 'decimal', value: '0:00.000', 'aria-label': 'Clip end time' }) as HTMLInputElement;
  const durationReadout = el('span', { class: 'recording-editor-duration', text: '0:00' });
  type RecordingAudioSelection = 'original' | 'mute' | 'system' | 'microphone';
  let audioSelection: RecordingAudioSelection = 'original';
  let audioCapabilities: { system: boolean; microphone: boolean; mixed: boolean } = { system: false, microphone: false, mixed: true };
  const audioToggle = el('button', { class: 'recording-editor-audio-toggle', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', text: 'Original audio' }) as HTMLButtonElement;
  const audioMenu = el('div', { class: 'recording-editor-audio-menu', role: 'group', 'aria-label': 'Audio source choices', hidden: true });
  const audioHint = el('span', { class: 'recording-editor-audio-hint', hidden: true });
  const audioControl = el('div', { class: 'recording-editor-audio-control' }, [audioToggle, audioMenu]);
  const audioField = el('div', { class: 'recording-editor-audio-field' }, [el('span', { text: 'Audio' }), audioControl, audioHint]);
  const audioLabels: Record<RecordingAudioSelection, string> = {
    original: 'Original audio',
    system: 'System Audio',
    microphone: 'Microphone',
    mute: 'Mute audio',
  };
  const audioEnabled = (selection: RecordingAudioSelection): boolean => selection === 'mute' || (selection === 'original' ? audioCapabilities.mixed : audioCapabilities[selection]);
  const renderAudioMenu = (): void => {
    clear(audioMenu);
    (Object.keys(audioLabels) as RecordingAudioSelection[]).forEach((selection) => {
      const enabled = audioEnabled(selection);
      const checkbox = el('input', { type: 'checkbox', checked: audioSelection === selection, disabled: !enabled, 'aria-label': audioLabels[selection] }) as HTMLInputElement;
      const option = el('label', { class: `recording-editor-audio-option${enabled ? '' : ' is-disabled'}` }, [checkbox, el('span', { text: audioLabels[selection] })]);
      checkbox.addEventListener('change', () => {
        if (!enabled || !checkbox.checked) return;
        audioSelection = selection;
        audioToggle.textContent = audioLabels[selection];
        audioMenu.hidden = true;
        audioToggle.setAttribute('aria-expanded', 'false');
        renderAudioMenu();
      });
      audioMenu.append(option);
    });
    const separateUnavailable = !audioCapabilities.system && !audioCapabilities.microphone;
    audioHint.hidden = !separateUnavailable;
    audioHint.textContent = separateUnavailable ? 'This recording has a single mixed audio track' : '';
    audioToggle.textContent = audioLabels[audioSelection];
  };
  audioToggle.addEventListener('click', (event) => {
    event.preventDefault();
    audioMenu.hidden = !audioMenu.hidden;
    audioToggle.setAttribute('aria-expanded', String(!audioMenu.hidden));
  });
  renderAudioMenu();
  const startRange = el('input', { class: 'recording-editor-range', type: 'range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Edit start' }) as HTMLInputElement;
  const endRange = el('input', { class: 'recording-editor-range', type: 'range', min: 0, max: 1000, step: 1, value: 1000, 'aria-label': 'Edit end' }) as HTMLInputElement;
  const startLabel = el('span', { text: 'START 0:00' });
  const endLabel = el('span', { text: 'END 0:00' });
  const rangeRuler = el('div', { class: 'recording-editor-range-ruler' }, [
    el('span', { text: '0:00' }),
    el('span', { class: 'recording-editor-range-ruler-middle', text: '0:00' }),
    el('span', { class: 'recording-editor-range-ruler-end', text: '0:00' }),
  ]);
  const statusLabel = el('span', { class: 'recording-editor-status', text: 'Choose a range to create a new clip or GIF.' });
  const progress = el('progress', { class: 'recording-editor-progress', max: 100, value: 0, hidden: true, 'aria-label': 'Editor progress' }) as HTMLProgressElement;
  const cancelButton = button('Cancel', () => {
    if (job && (job.state === 'queued' || job.state === 'running')) {
      void api.recordingEditorCancel(job.jobId).then(updateJob).catch((err) => { statusLabel.textContent = messageOf(err); });
    }
    if (editorPollTimer !== null) {
      window.clearInterval(editorPollTimer);
      editorPollTimer = null;
    }
    onCancel?.();
  }, 'btn btn-secondary');
  const gifButton = button('Export GIF', () => void startJob('gif'), 'btn btn-secondary');
  const fps = el('input', { class: 'recording-editor-number', type: 'number', min: 5, max: 30, step: 1, value: 15, 'aria-label': 'GIF frames per second' }) as HTMLInputElement;
  const width = el('input', { class: 'recording-editor-number', type: 'number', min: 2, max: 1920, step: 2, value: 640, 'aria-label': 'GIF width' }) as HTMLInputElement;
  const editor = el('section', { class: 'recording-editor-drawer recording-editor-ascent', 'aria-label': 'Clip editor' }) as RecordingEditorElement;
  const selectionFill = el('div', { class: 'recording-editor-selection-fill', 'aria-hidden': 'true' });
  let selectionStartMs = 0;
  let selectionEndMs = durationMs;
  let playbackMs = 0;
  let hasVideoDuration = false;
  editor.addEventListener('click', (event) => {
    if (!audioControl.contains(event.target as Node)) {
      audioMenu.hidden = true;
      audioToggle.setAttribute('aria-expanded', 'false');
    }
  });
  const playbackMarker = el('div', {
    class: 'recording-editor-playback-marker',
    role: 'slider',
    tabindex: '0',
    'aria-label': 'Playback position',
    'aria-valuemin': '0',
    'aria-valuemax': String(durationMs),
    'aria-valuenow': '0',
  });
  const playbackLabel = el('span', { class: 'recording-editor-playback-label', text: 'PLAYBACK 0:00' });
  playbackMarker.append(playbackLabel);
  const syncPlaybackMarker = (nextPlaybackMs: number): void => {
    playbackMs = Math.min(durationMs, Math.max(0, Number.isFinite(nextPlaybackMs) ? Math.round(nextPlaybackMs) : 0));
    const percent = durationMs > 0 ? (playbackMs / durationMs) * 100 : 0;
    playbackMarker.style.left = `${Math.min(100, Math.max(0, percent))}%`;
    playbackLabel.textContent = `PLAYBACK ${formatTime(playbackMs / 1000)}`;
    playbackLabel.style.transform = percent > 88 ? 'translateX(-100%)' : 'none';
    playbackLabel.style.marginLeft = percent > 88 ? '-6px' : '6px';
    playbackMarker.setAttribute('aria-valuemax', String(durationMs));
    playbackMarker.setAttribute('aria-valuenow', String(playbackMs));
    playbackMarker.setAttribute('aria-valuetext', formatTime(playbackMs / 1000));
  };
  playbackMarker.addEventListener('keydown', (event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key !== 'ArrowLeft' && keyboardEvent.key !== 'ArrowRight') return;
    keyboardEvent.preventDefault();
    const step = keyboardEvent.shiftKey ? 1000 : 100;
    const next = playbackMs + (keyboardEvent.key === 'ArrowRight' ? step : -step);
    seekVideoTo(next);
  });
  const syncRangeControls = (startMs: number, endMs: number) => {
    const range = clampRecordingEditorRange(startMs, endMs, durationMs);
    selectionStartMs = range.startMs;
    selectionEndMs = range.endMs;
    startRange.value = String(Math.round((range.startMs / range.durationMs) * 1000));
    endRange.value = String(Math.round((range.endMs / range.durationMs) * 1000));
    startTime.value = formatPreciseTime(range.startMs);
    endTime.value = formatPreciseTime(range.endMs);
    startLabel.textContent = `START ${formatTime(range.startMs / 1000)}`;
    endLabel.textContent = `END ${formatTime(range.endMs / 1000)}`;
    durationReadout.textContent = formatTime((range.endMs - range.startMs) / 1000);
    const startPercent = Math.min(100, Math.max(0, (range.startMs / range.durationMs) * 100));
    const endPercent = Math.min(100, Math.max(0, (range.endMs / range.durationMs) * 100));
    selectionFill.style.left = `${startPercent}%`;
    selectionFill.style.right = `${100 - endPercent}%`;
    startLabel.style.left = `${startPercent}%`;
    endLabel.style.left = `${endPercent}%`;
    startLabel.style.transform = startPercent < 8 ? 'translateX(0)' : 'translateX(-50%)';
    endLabel.style.transform = endPercent > 92 ? 'translateX(-100%)' : 'translateX(-50%)';
    startRange.setAttribute('aria-valuetext', formatTime(range.startMs / 1000));
    endRange.setAttribute('aria-valuetext', formatTime(range.endMs / 1000));
    const middle = rangeRuler.querySelector<HTMLElement>('.recording-editor-range-ruler-middle');
    const rulerEnd = rangeRuler.querySelector<HTMLElement>('.recording-editor-range-ruler-end');
    if (middle) middle.textContent = formatTime((range.durationMs / 2) / 1000);
    if (rulerEnd) rulerEnd.textContent = formatTime(range.durationMs / 1000);
    editor.onSelectionChanged?.({ startMs: range.startMs, endMs: range.endMs });
  };
  const seekVideoTo = (nextMs: number): void => {
    const video = getVideo();
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const targetMs = Math.min(durationMs, Math.max(0, Math.round(Number.isFinite(nextMs) ? nextMs : 0)));
    video.currentTime = Math.min(video.duration, targetMs / 1000);
    // Keep the player transport and editor divider visually locked together
    // before the browser emits its asynchronous media timeupdate event.
    video.dispatchEvent(new Event('timeupdate'));
    syncPlaybackMarker(targetMs);
  };
  const setRangeFromSliders = () => {
    const range = recordingEditorSelectionFromRatios(Number(startRange.value), Number(endRange.value), durationMs);
    syncRangeControls(range.startMs, range.endMs);
  };
  const syncTimeFields = (field: 'start' | 'end') => {
    const range = clampRecordingEditorRange(parseTimeInput(startTime.value), parseTimeInput(endTime.value), durationMs);
    syncRangeControls(range.startMs, range.endMs);
    seekVideoTo(field === 'start' ? range.startMs : range.endMs);
  };
  const setBusy = (busy: boolean) => {
    createClipButton.disabled = busy;
    gifButton.disabled = busy;
    startRange.disabled = busy;
    endRange.disabled = busy;
    fps.disabled = busy;
    width.disabled = busy;
    cancelButton.disabled = false;
  };
  const updateJob = (next: RecordingEditorJob) => {
    job = next;
    progress.hidden = next.state !== 'running' && next.state !== 'queued';
    progress.value = Math.max(0, Math.min(100, next.progress));
    if (next.state === 'error') statusLabel.textContent = next.error ?? 'The editor could not complete this export.';
    else if (next.state === 'cancelled') statusLabel.textContent = 'Export cancelled.';
    else if (next.state === 'ready') statusLabel.textContent = next.clip ? `Created ${next.clip.fileName}.` : `Created ${next.artifact?.fileName ?? 'GIF export'}.`;
    else statusLabel.textContent = next.state === 'queued' ? 'Queued…' : `Rendering ${Math.round(next.progress)}%`;
    const ready = next.state === 'ready';
    setBusy(next.state === 'queued' || next.state === 'running');
    if (ready && next.clip) {
      clips = [...clips.filter((item) => item.id !== next.clip?.id), next.clip];
      const dialog = shareDialogHandle;
      shareDialogHandle = null;
      shareDialogJobId = next.jobId;
      if (dialog) {
        void api.recordingClipUrl(next.clip.id)
          .then((previewUrl) => dialog.setReady(previewUrl, next.clip?.fileName))
          .catch((err) => dialog.setError(messageOf(err)));
      }
    } else if (next.state === 'cancelled' || next.state === 'error') {
      shareDialogHandle?.setError(next.state === 'cancelled' ? 'Clip creation was cancelled.' : (next.error ?? 'The editor could not complete this clip.'));
      shareDialogHandle = null;
      shareDialogJobId = null;
    }
    if (next.state === 'ready' || next.state === 'cancelled' || next.state === 'error') {
      if (editorPollTimer !== null) { window.clearInterval(editorPollTimer); editorPollTimer = null; }
    }
  };
  async function startJob(operation: 'trim' | 'gif'): Promise<void> {
    const video = getVideo();
    if (video && Number.isFinite(video.duration) && video.duration > 0) durationMs = Math.round(video.duration * 1000);
    const range = clampRecordingEditorRange(selectionStartMs, selectionEndMs, durationMs);
    syncRangeControls(range.startMs, range.endMs);
    const { startMs, endMs } = range;
    if (!video || !Number.isFinite(video.duration) || startMs >= endMs) {
      statusLabel.textContent = 'Choose a valid start and end range.';
      return;
    }
    try {
      const requestedName = normalizeRecordingEditorClipName(clipName.value);
      if (operation === 'trim') {
        shareDialogJobId = null;
        shareDialogHandle?.setError('A newer clip is being created.');
        shareDialogHandle = showRecordingShareDialog({
          fileName: requestedName,
          loading: true,
          onCopy: () => shareDialogJobId ? api.recordingEditorCopy(shareDialogJobId) : Promise.reject(new Error('Clip is still being created')),
          onOpenFolder: () => shareDialogJobId ? api.recordingEditorFolder(shareDialogJobId) : Promise.reject(new Error('Clip is still being created')),
        });
      }
      const next = await api.recordingEditorStart({ sourceId: clip.id, operation, startMs, endMs, outputName: requestedName, audio: audioSelection, ...(operation === 'gif' ? { fps: Number(fps.value), width: Number(width.value) } : {}) });
      updateJob(next);
      if (next.state === 'queued' || next.state === 'running') {
        if (editorPollTimer !== null) window.clearInterval(editorPollTimer);
        editorPollTimer = window.setInterval(() => {
          void api.recordingEditorStatus(next.jobId).then(updateJob).catch((err) => {
            statusLabel.textContent = messageOf(err);
            toast('error', 'Clip export', messageOf(err));
          });
        }, 300);
      }
    } catch (err) {
      statusLabel.textContent = messageOf(err);
      shareDialogHandle?.setError(messageOf(err));
      shareDialogHandle = null;
      shareDialogJobId = null;
      toast('error', 'Clip export', messageOf(err));
    }
  }
  startRange.addEventListener('input', () => {
    setRangeFromSliders();
    seekVideoTo(selectionStartMs);
  });
  endRange.addEventListener('input', () => {
    setRangeFromSliders();
    seekVideoTo(selectionEndMs);
  });
  startTime.addEventListener('change', () => syncTimeFields('start'));
  endTime.addEventListener('change', () => syncTimeFields('end'));
  const createClipButton = button('Create clip', () => void startJob('trim'), 'btn btn-primary');
  // The editor strip is reserved for the three interactive points:
  // START, END, and PLAYBACK. APM is rendered only in the viewing timeline.
  const rangeTrack = el('div', { class: 'recording-editor-range-track' }, [selectionFill, playbackMarker, startRange, endRange]);
  let dragMode: 'start' | 'end' | 'playback' | null = null;
  let dragPointerId: number | null = null;
  const timelineMsAtEvent = (event: PointerEvent): number => {
    const rect = rangeTrack.getBoundingClientRect();
    if (rect.width <= 0 || durationMs <= 0) return 0;
    const ratio = Math.min(1000, Math.max(0, ((event.clientX - rect.left) / rect.width) * 1000));
    return recordingEditorSelectionFromRatios(ratio, ratio, durationMs).startMs;
  };
  const closestTimelinePoint = (candidateMs: number): 'start' | 'end' | 'playback' => {
    const points: Array<{ key: 'start' | 'end' | 'playback'; distance: number }> = [
      { key: 'start', distance: Math.abs(candidateMs - selectionStartMs) },
      { key: 'end', distance: Math.abs(candidateMs - selectionEndMs) },
      { key: 'playback', distance: Math.abs(candidateMs - playbackMs) },
    ];
    points.sort((left, right) => left.distance - right.distance);
    // Only the small visible handle hit-box selects START or END. A broad
    // time-based threshold made ordinary timeline clicks snap the playback
    // position to whichever boundary happened to be closer.
    const width = rangeTrack.getBoundingClientRect().width;
    const thresholdMs = width > 0 ? Math.max(80, (durationMs * 14) / width) : 80;
    return points[0].distance <= thresholdMs ? points[0].key : 'playback';
  };
  const applyTimelineDrag = (event: PointerEvent): void => {
    if (!dragMode) return;
    const candidate = timelineMsAtEvent(event);
    if (dragMode === 'start') {
      syncRangeControls(candidate, selectionEndMs);
      seekVideoTo(selectionStartMs);
    } else if (dragMode === 'end') {
      syncRangeControls(selectionStartMs, candidate);
      seekVideoTo(selectionEndMs);
    } else {
      syncPlaybackMarker(candidate);
      seekVideoTo(candidate);
    }
  };
  rangeTrack.addEventListener('pointerdown', (event) => {
    const pointerEvent = event as PointerEvent;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button')) return;
    dragMode = closestTimelinePoint(timelineMsAtEvent(pointerEvent));
    dragPointerId = pointerEvent.pointerId;
    rangeTrack.setPointerCapture?.(pointerEvent.pointerId);
    applyTimelineDrag(pointerEvent);
    pointerEvent.preventDefault();
  });
  rangeTrack.addEventListener('pointermove', (event) => {
    const pointerEvent = event as PointerEvent;
    if (dragPointerId !== pointerEvent.pointerId) return;
    applyTimelineDrag(pointerEvent);
  });
  const finishTimelineDrag = (event: Event): void => {
    const pointerEvent = event as PointerEvent;
    if (dragPointerId !== pointerEvent.pointerId) return;
    rangeTrack.releasePointerCapture?.(pointerEvent.pointerId);
    dragPointerId = null;
    dragMode = null;
  };
  rangeTrack.addEventListener('pointerup', finishTimelineDrag);
  rangeTrack.addEventListener('pointercancel', finishTimelineDrag);
  const startField = el('label', { class: 'recording-editor-time-field' }, [el('span', { text: 'START' }), startTime]);
  const endField = el('label', { class: 'recording-editor-time-field' }, [el('span', { text: 'END' }), endTime]);
  const creationTimelineActions = el('div', { class: 'recording-editor-timeline-actions' }, [cancelButton]);
  editor.append(
    el('div', { class: 'recording-editor-header' }, [clipName, startField, endField, audioField, createClipButton]),
    el('div', { class: 'recording-editor-selection-toolbar' }, [
      el('span', { class: 'recording-editor-clip-duration', text: 'Clip duration:' }),
      durationReadout,
      creationTimelineActions,
    ]),
      el('div', { class: 'recording-editor-selected-timeline' }, [
      rangeTrack,
      el('div', { class: 'recording-editor-range-labels' }, [startLabel, endLabel]),
      rangeRuler,
    ]),
    el('div', { class: 'recording-editor-gif-options' }, [el('span', { class: 'recording-editor-secondary-label', text: 'GIF export' }), el('label', {}, [el('span', { text: 'FPS' }), fps]), el('label', {}, [el('span', { text: 'Width' }), width]), gifButton]),
    progress,
  );
  editor.updateDuration = (nextDurationMs: number) => {
    if (!Number.isFinite(nextDurationMs) || nextDurationMs <= 0) return;
    const previousDurationMs = durationMs;
    durationMs = Math.max(1000, Math.round(nextDurationMs));
    syncPlaybackMarker(playbackMs);
    if (!hasVideoDuration || (selectionStartMs === 0 && selectionEndMs === previousDurationMs)) {
      hasVideoDuration = true;
      syncRangeControls(0, durationMs);
    } else {
      syncRangeControls(selectionStartMs, selectionEndMs);
    }
  };
  editor.updatePlayback = (nextPlaybackMs: number) => syncPlaybackMarker(nextPlaybackMs);
  editor.getSelection = () => ({ startMs: selectionStartMs, endMs: selectionEndMs });
  const video = getVideo();
  if (video?.duration && Number.isFinite(video.duration)) editor.updateDuration(video.duration * 1000);
  if (video && Number.isFinite(video.currentTime)) syncPlaybackMarker(video.currentTime * 1000);
  syncRangeControls(0, durationMs);
  void api.recordingEditorAudio(clip.id).then((capabilities) => {
    audioCapabilities = {
      system: capabilities?.system === true,
      microphone: capabilities?.microphone === true,
      mixed: capabilities?.mixed === true,
    };
    if (!audioEnabled(audioSelection)) audioSelection = audioCapabilities.mixed ? 'original' : 'mute';
    renderAudioMenu();
  }).catch(() => {
    // Keep the safe original/mute choices when an older backend has no probe.
    renderAudioMenu();
  });
  return editor;
}

function renderPlayerTracker(clip: RecordingClip, actions: HTMLElement[] = []): RecordingTrackerElement {
  const samples = clip.apmSamples ?? [];
  const average = Number.isFinite(clip.apmAverage) ? clip.apmAverage : samples.length ? Math.round(samples.reduce((sum, sample) => sum + sample.apm, 0) / samples.length) : null;
  const hasTelemetry = samples.length > 0;
  const sourceAvailable = clip.apmAvailable === true || hasTelemetry;
  const tracker = el('section', { class: 'recording-apm-tracker', 'aria-label': 'APM performance tracker' }, [
    el('div', { class: 'recording-apm-heading' }, [
      el('div', {}, [el('span', { class: 'recording-eyebrow', text: 'APM' }), el('strong', { text: 'Performance tracker' })]),
      el('div', { class: 'recording-apm-heading-actions' }, actions),
    ]),
    el('div', { class: 'recording-apm-average' }, [el('span', { text: 'Average' }), el('strong', { text: average === null ? sourceAvailable ? '0' : '—' : String(average) }), el('span', { class: 'recording-apm-unit', text: 'APM' }), el('span', { class: 'recording-apm-live', text: hasTelemetry ? 'Live capture telemetry' : sourceAvailable ? 'Capture telemetry · no actions detected' : 'Telemetry unavailable for this clip' })]),
  ]) as RecordingTrackerElement;
  const chart = renderApmGraph(clip, 1000);
  const ruler = el('div', { class: 'recording-apm-ruler' }, [el('span', { text: '0:00' }), el('span', { text: '0:00' }), el('span', { text: 'Clip end' })]);
  tracker.append(chart, ruler);
  tracker.updateDuration = (durationMs: number) => {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;
    const bounded = Math.max(1000, Math.round(durationMs));
    chart.updateDuration?.(bounded);
    const middle = ruler.children[1];
    const end = ruler.children[2];
    if (middle) middle.textContent = formatTime((bounded / 2) / 1000);
    if (end) end.textContent = formatTime(bounded / 1000);
  };
  tracker.updatePlayback = (playbackMs: number) => chart.updatePlayback?.(playbackMs);
  return tracker;
}

function renderPlayerView(): HTMLElement {
  const player = el('div', { class: 'recording-player-stage' }, [el('p', { class: 'recording-player-placeholder', text: 'Loading clip…' })]);
  let creationMode = false;
  let constrainedPlaybackEndMs: number | null = null;
  let playbackEndedAtSelection = false;
  let editorPanel: RecordingEditorElement | null = null;
  let trackerPanel: RecordingTrackerElement | null = null;
  let timelineSurface: HTMLElement | null = null;
  const setCreationMode = (enabled: boolean): void => {
    creationMode = enabled;
    // Keep the player visible while the editor opens beneath it. The player
    // transport is the clip preview; the editor below owns the single range.
    player.hidden = false;
    timelineSurface?.classList.toggle('is-editing', enabled);
    if (editorPanel) editorPanel.hidden = !enabled;
    if (trackerPanel) trackerPanel.hidden = enabled;
    player.dataset.creationMode = enabled ? 'true' : 'false';
  };
  const clipButton = button('Clip', () => setCreationMode(true), 'btn btn-primary');
  if (playerClip) {
    const requestedId = playerClip.id;
    void api.recordingClipUrl(requestedId).then((url) => {
      if (!player.isConnected || playerClip?.id !== requestedId) return;
      const video = el('video', { class: 'recording-video', preload: 'metadata', playsinline: true, src: url }) as HTMLVideoElement;
      let playbackRate = 1;
      let speedButton: HTMLButtonElement | null = null;
      const speedPopover = el('div', { class: 'recording-player-speed-popover', hidden: true, role: 'dialog', 'aria-label': 'Playback speed' }) as HTMLDivElement;
      const speedCustomInput = el('input', {
        class: 'recording-player-speed-input',
        type: 'number',
        min: PLAYBACK_SPEED_MIN,
        max: PLAYBACK_SPEED_MAX,
        step: 0.05,
        value: '1.0',
        'aria-label': 'Custom playback speed',
      }) as HTMLInputElement;
      const updateSpeedMenu = () => {
        for (const option of speedPopover.querySelectorAll<HTMLButtonElement>('[data-playback-rate]')) {
          const rate = Number(option.dataset.playbackRate);
          const active = Math.abs(rate - playbackRate) < 0.001;
          option.classList.toggle('active', active);
          option.setAttribute('aria-pressed', String(active));
          const check = option.querySelector('.recording-player-speed-check');
          if (check) check.textContent = active ? '✓' : '';
        }
        speedCustomInput.value = playbackRate.toFixed(2).replace(/0+$/, '').replace(/\.$/, '.0');
        if (speedButton) {
          speedButton.title = `Playback speed: ${playbackSpeedLabel(playbackRate)}`;
          speedButton.setAttribute('aria-label', `Playback speed: ${playbackSpeedLabel(playbackRate)}`);
        }
      };
      const setPlaybackRate = (value: number, close = true) => {
        if (!Number.isFinite(value)) return;
        playbackRate = Math.min(PLAYBACK_SPEED_MAX, Math.max(PLAYBACK_SPEED_MIN, value));
        video.playbackRate = playbackRate;
        updateSpeedMenu();
        if (close) speedPopover.hidden = true;
      };
      speedPopover.append(
        el('div', { class: 'recording-player-speed-heading', text: 'PLAYBACK SPEED' }),
        el('div', { class: 'recording-player-speed-divider' }),
        ...PLAYBACK_SPEED_PRESETS.map((rate) => el('button', {
          class: 'recording-player-speed-option',
          type: 'button',
          dataset: { playbackRate: String(rate) },
          'aria-pressed': 'false',
          onClick: () => setPlaybackRate(rate),
        }, [el('span', { text: playbackSpeedLabel(rate) }), el('span', { class: 'recording-player-speed-check', 'aria-hidden': 'true' })])),
        el('div', { class: 'recording-player-speed-divider' }),
        el('div', { class: 'recording-player-speed-custom' }, [
          el('span', { text: 'Custom:' }),
          speedCustomInput,
          el('button', {
            class: 'recording-player-speed-apply',
            type: 'button',
            text: 'Apply',
            onClick: () => setPlaybackRate(Number(speedCustomInput.value)),
          }),
        ]),
      );
      const playButton = playerIconButton('Play', 'play', () => {
        if (video.paused) void video.play().catch(() => {});
        else video.pause();
      }, 'recording-player-play');
      const inlineSeek = el('input', { class: 'recording-player-seek recording-player-seek-inline', type: 'range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Seek clip' }) as HTMLInputElement;
      const elapsed = el('span', { class: 'recording-player-time', text: '0:00' });
      const duration = el('span', { class: 'recording-player-time', text: '0:00' });
      const updatePlayButton = () => {
        playButton.title = video.paused ? 'Play' : 'Pause';
        playButton.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
        const icon = playButton.querySelector('.recording-player-icon');
        if (icon) icon.className = `recording-player-icon recording-player-icon-${video.paused ? 'play' : 'pause'}`;
      };
      const applyPlaybackBoundary = () => {
        if (constrainedPlaybackEndMs === null || video.currentTime * 1000 < constrainedPlaybackEndMs - 8) return;
        const endMs = constrainedPlaybackEndMs;
        constrainedPlaybackEndMs = null;
        playbackEndedAtSelection = true;
        video.currentTime = endMs / 1000;
        video.pause();
      };
      const updateTimeline = () => {
        applyPlaybackBoundary();
        elapsed.textContent = formatTime(video.currentTime);
        duration.textContent = formatTime(video.duration);
        const progress = video.duration > 0 ? Math.min(100, Math.max(0, (video.currentTime / video.duration) * 100)) : 0;
        const value = String(Math.round(progress * 10));
        inlineSeek.value = value;
        inlineSeek.style.setProperty('--progress', `${progress}%`);
        (editorPanel as RecordingEditorElement | null)?.updateDuration?.(video.duration * 1000);
        (editorPanel as RecordingEditorElement | null)?.updatePlayback?.(video.currentTime * 1000);
        trackerPanel?.updateDuration?.(video.duration * 1000);
        trackerPanel?.updatePlayback?.(video.currentTime * 1000);
      };
      video.addEventListener('play', () => {
        // The editor owns a bounded playback pass. If the player was parked
        // outside the selected range, resume at whichever boundary is nearest
        // to that parked position, then stop at END. This keeps a timeline
        // click useful without letting an accidental outside click play the
        // whole source clip.
        if (creationMode) {
          const range = editorPanel?.getSelection?.();
          const currentMs = Math.round(video.currentTime * 1000);
          if (range) {
            const restartFromEnd = playbackEndedAtSelection && currentMs >= range.endMs - 8;
            const resume = restartFromEnd
              ? { positionMs: range.startMs, constrainedEndMs: range.endMs }
              : recordingEditorResumePosition(currentMs, range.startMs, range.endMs);
            if (resume.positionMs !== currentMs) video.currentTime = resume.positionMs / 1000;
            playbackEndedAtSelection = false;
            constrainedPlaybackEndMs = resume.constrainedEndMs;
          } else {
            constrainedPlaybackEndMs = null;
          }
        } else {
          constrainedPlaybackEndMs = null;
        }
        updatePlayButton();
      });
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
          const targetMs = recordingEditorSeekTargetMs(Number(control.value), video.duration * 1000);
          const range = creationMode ? editorPanel?.getSelection?.() : null;
          playbackEndedAtSelection = false;
          if (!range || (targetMs >= range.startMs && targetMs <= range.endMs)) constrainedPlaybackEndMs = null;
          video.currentTime = targetMs / 1000;
          updateTimeline();
        }
      };
      inlineSeek.addEventListener('input', () => seekTo(inlineSeek));
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
      speedButton = playerIconButton('Playback speed: Normal', 'settings', () => {
        speedPopover.hidden = !speedPopover.hidden;
        if (!speedPopover.hidden) speedCustomInput.focus();
      }, 'recording-player-speed-button');
      const speedControl = el('div', { class: 'recording-player-speed-control' }, [speedButton, speedPopover]);
      player.addEventListener('click', (event) => {
        const target = event.target as Node | null;
        if (target && !speedControl.contains(target)) speedPopover.hidden = true;
      });
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
            speedControl,
            fullscreen,
          ]),
        ]),
      );
      updatePlayButton();
      updateMuteButton();
      updateSpeedMenu();
      playerVideo = video;
      if (creationMode) setCreationMode(true);
    }).catch((err) => {
      if (!player.isConnected || playerClip?.id !== requestedId) return;
      clear(player);
      player.append(el('p', { class: 'text-error', text: messageOf(err) }));
    });
  }
  trackerPanel = renderPlayerTracker(playerClip ?? { id: '', fileName: '', relativePath: '', createdAt: '' }, [clipButton]);
  editorPanel = playerClip ? renderRecordingEditor(playerClip, () => playerVideo, () => setCreationMode(false)) : null;
  if (editorPanel) editorPanel.hidden = true;
  timelineSurface = el('div', { class: 'recording-player-timeline-surface' }, [trackerPanel, editorPanel]);
  const back = el('button', {
    class: 'recording-player-back',
    type: 'button',
    'aria-label': 'Back to clips',
    title: 'Back to clips',
    onClick: () => closePlayer(),
  }, [el('span', { class: 'recording-player-back-icon', 'aria-hidden': 'true' }), el('span', { text: 'Back to Clips' })]);
  const shareClip = playerClip ? button('Share clip', () => {
    const source = playerClip;
    if (!source) return;
    void api.recordingClipUrl(source.id).then((previewUrl) => showRecordingShareDialog({
      fileName: source.fileName,
      previewUrl,
      onCopy: () => api.recordingClipCopy(source.id),
      onOpenFolder: () => api.recordingOpenFolder(),
    })).catch((err) => toast('error', 'Clip actions', messageOf(err)));
  }, 'btn btn-primary') : null;
  return el('section', { class: 'recording-player-view' }, [
    el('header', { class: 'recording-player-view-heading' }, [
      back,
      el('div', { class: 'recording-player-heading-copy' }, [el('span', { class: 'recording-eyebrow', text: 'Clip player' }), el('h2', { class: 'recording-panel-title', text: playerClip?.fileName ?? 'Clip' }), el('span', { class: 'recording-player-meta', text: playerClip ? `Saved ${new Date(playerClip.createdAt).toLocaleString()}` : '' })]),
      el('div', { class: 'recording-player-heading-actions' }, [shareClip, button('Open Folder', () => void api.recordingOpenFolder().catch((err) => toast('error', 'Clip folder', messageOf(err))), 'btn btn-secondary recording-player-folder')]),
    ]),
    player,
    timelineSurface,
  ]);
}

function render(): void {
  if (!renderContainer) return;
  disposePlayerVideo();
  applySettingsButton = null;
  clear(renderContainer);
  if (playerClip) {
    renderContainer.append(renderPlayerView());
    return;
  }
  renderContainer.append(
    el('div', { class: 'page-heading recording-heading' }, [
      el('div', {}, [
        el('span', { class: 'recording-eyebrow', text: 'Arc Capture' }),
        el('h1', { text: 'Recording' }),
      ]),
      activeTab === 'manual' ? renderRecordingHeadingActions() : null,
      renderTabs(),
    ]),
    activeTab === 'manual' ? renderManualView() : activeTab === 'clips' ? renderClipsView() : renderAudioView(),
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
    if (settingsDirty) toast('info', 'Apply settings first', 'Apply your recording changes before starting Instant Replay.');
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
  if (actionBusy || !replayRunning || status.instantReplaySave?.status === 'saving') return;
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
  render(container: HTMLElement, context: PageContext): void {
    renderContainer = container;
    recordingDevices = context.store.get().devices;
    if (!unsubscribeRecordingState) {
      unsubscribeRecordingState = api.onRecordingStateUpdated((next) => {
        setStatus(next);
        if (renderContainer === container) render();
      });
    }
    if (!unsubscribeRecordingSettings) {
      unsubscribeRecordingSettings = api.onRecordingSettingsUpdated((next) => {
        if (!next || typeof next !== 'object') return;
        settings = next;
        // Preserve a local unsaved draft, but adopt the pushed settings as
        // the clean base so the page and the Advanced Overlay stay aligned.
        if (!settingsDirty && !applyingSettings) draftSettings = cloneRecordingSettings(next);
        if (renderContainer === container) render();
      });
    }
    if (!unsubscribeRecordingPillSettings) {
      unsubscribeRecordingPillSettings = api.onRecordingPillSettingsUpdated((next) => {
        if (!next || typeof next.enabled !== 'boolean') return;
        recordingPillEnabled = next.enabled;
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
  onUpdate(container: HTMLElement, context: PageContext): void {
    const devices = context.store.get().devices;
    if (devices !== recordingDevices) {
      recordingDevices = devices;
      if (renderContainer === container) render();
    }
  },
  leave(): void {
    unsubscribeRecordingState?.();
    unsubscribeRecordingState = null;
    unsubscribeRecordingSettings?.();
    unsubscribeRecordingSettings = null;
    unsubscribeRecordingPillSettings?.();
    unsubscribeRecordingPillSettings = null;
    disposePlayerVideo();
    applySettingsButton = null;
    draftSettings = null;
    settingsDirty = false;
    applyingSettings = false;
    fpsCustomEditing = false;
    storageInfo = null;
    recordingPillEnabled = false;
    recordingDevices = [];
    recordingTargets = { displays: [], windows: [] };
    recordingTargetsBusy = false;
    renderContainer = null;
    playerClip = null;
  },
};
