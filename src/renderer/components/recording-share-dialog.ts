import { el, clear } from '../dom.ts';
import { toast } from './toast.ts';

const ROOT_ID = 'modal-root';

type RecordingShareDialogOptions = {
  fileName: string;
  previewUrl?: string | null;
  loading?: boolean;
  onCopy: () => Promise<unknown>;
  onOpenFolder: () => Promise<unknown>;
};

export type RecordingShareDialogHandle = {
  setReady: (previewUrl: string | null, fileName?: string) => void;
  setError: (message: string) => void;
};

const PREVIEW_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

function previewTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : 0;
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`;
}

function previewIconButton(label: string, icon: string, onClick: () => void): HTMLButtonElement {
  return el('button', {
    class: 'recording-player-icon-button recording-share-player-icon-button',
    type: 'button',
    title: label,
    'aria-label': label,
    onClick,
  }, [el('span', { class: `recording-player-icon recording-player-icon-${icon}`, 'aria-hidden': 'true' })]) as HTMLButtonElement;
}

function renderClipPreview(previewUrl: string | null | undefined): HTMLElement {
  if (!previewUrl) return el('div', { class: 'recording-share-preview-empty', text: 'Preview is available after opening the clip.' });
  const stage = el('div', { class: 'recording-share-preview-player' });
  const video = el('video', { class: 'recording-share-preview-video', src: previewUrl, preload: 'metadata', playsinline: true }) as HTMLVideoElement;
  const seek = el('input', { class: 'recording-player-seek recording-share-preview-seek', type: 'range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Seek clip preview' }) as HTMLInputElement;
  const elapsed = el('span', { class: 'recording-player-time recording-share-preview-time', text: '0:00' });
  const duration = el('span', { class: 'recording-player-time recording-share-preview-time', text: '0:00' });
  let playbackRate = 1;
  const speedPopover = el('div', { class: 'recording-player-speed-popover recording-share-preview-speed-popover', hidden: true, role: 'dialog', 'aria-label': 'Preview playback speed' }) as HTMLDivElement;
  const speedButton = previewIconButton('Playback speed: Normal', 'settings', () => {
    speedPopover.hidden = !speedPopover.hidden;
  });
  const speedControl = el('div', { class: 'recording-player-speed-control' }, [speedButton, speedPopover]);
  const updateSpeed = (rate: number) => {
    playbackRate = Math.min(4, Math.max(.1, rate));
    video.playbackRate = playbackRate;
    speedButton.title = `Playback speed: ${playbackRate === 1 ? 'Normal' : `${playbackRate}x`}`;
    speedButton.setAttribute('aria-label', speedButton.title);
    for (const option of speedPopover.querySelectorAll<HTMLButtonElement>('[data-preview-rate]')) {
      const active = Math.abs(Number(option.dataset.previewRate) - playbackRate) < .001;
      option.classList.toggle('active', active);
      option.setAttribute('aria-pressed', String(active));
      const check = option.querySelector('.recording-player-speed-check');
      if (check) check.textContent = active ? '✓' : '';
    }
  };
  speedPopover.append(
    el('div', { class: 'recording-player-speed-heading', text: 'PLAYBACK SPEED' }),
    el('div', { class: 'recording-player-speed-divider' }),
    ...PREVIEW_SPEEDS.map((rate) => el('button', {
      class: 'recording-player-speed-option',
      type: 'button',
      dataset: { previewRate: String(rate) },
      'aria-pressed': String(rate === 1),
      onClick: () => { updateSpeed(rate); speedPopover.hidden = true; },
    }, [el('span', { text: rate === 1 ? 'Normal' : `${rate}x` }), el('span', { class: 'recording-player-speed-check', 'aria-hidden': 'true', text: rate === 1 ? '✓' : '' })])),
  );
  const playButton = previewIconButton('Play', 'play', () => {
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  });
  const muteButton = previewIconButton('Mute', 'volume', () => {
    video.muted = !video.muted;
    updateMute();
  });
  const volume = el('input', { class: 'recording-player-volume recording-share-preview-volume', type: 'range', min: 0, max: 1, step: .01, value: 1, 'aria-label': 'Preview volume' }) as HTMLInputElement;
  const fullscreen = previewIconButton('Fullscreen', 'fullscreen', () => {
    if (document.fullscreenElement === stage) void document.exitFullscreen?.();
    else void (stage as HTMLElement & { requestFullscreen?: () => Promise<void> }).requestFullscreen?.();
  });
  const updateMute = () => {
    const muted = video.muted || video.volume === 0;
    muteButton.title = muted ? 'Unmute' : 'Mute';
    muteButton.setAttribute('aria-label', muteButton.title);
    const icon = muteButton.querySelector('.recording-player-icon');
    if (icon) icon.className = `recording-player-icon recording-player-icon-${muted ? 'muted' : 'volume'}`;
  };
  const updatePlay = () => {
    playButton.title = video.paused ? 'Play' : 'Pause';
    playButton.setAttribute('aria-label', playButton.title);
    const icon = playButton.querySelector('.recording-player-icon');
    if (icon) icon.className = `recording-player-icon recording-player-icon-${video.paused ? 'play' : 'pause'}`;
  };
  const updateTimeline = () => {
    const progress = video.duration > 0 ? Math.min(1, Math.max(0, video.currentTime / video.duration)) : 0;
    elapsed.textContent = previewTime(video.currentTime);
    duration.textContent = previewTime(video.duration);
    seek.value = String(Math.round(progress * 1000));
    seek.style.setProperty('--progress', `${progress * 100}%`);
  };
  seek.addEventListener('input', () => {
    if (video.duration > 0) video.currentTime = (Number(seek.value) / 1000) * video.duration;
    updateTimeline();
  });
  volume.addEventListener('input', () => {
    video.volume = Number(volume.value);
    video.muted = video.volume === 0;
    updateMute();
  });
  video.addEventListener('loadedmetadata', updateTimeline);
  video.addEventListener('timeupdate', updateTimeline);
  video.addEventListener('play', updatePlay);
  video.addEventListener('pause', updatePlay);
  video.addEventListener('ended', updatePlay);
  video.addEventListener('volumechange', updateMute);
  video.addEventListener('click', () => {
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  });
  stage.addEventListener('click', (event) => {
    if (!speedControl.contains(event.target as Node)) speedPopover.hidden = true;
  });
  stage.append(video, el('div', { class: 'recording-player-overlay recording-share-player-overlay' }, [
    el('div', { class: 'recording-player-progress' }, [seek]),
    el('div', { class: 'recording-player-controls recording-share-player-controls' }, [
      playButton,
      muteButton,
      volume,
      el('div', { class: 'recording-player-time-pair' }, [elapsed, el('span', { text: '/' }), duration]),
      el('span', { class: 'recording-player-controls-spacer' }),
      speedControl,
      fullscreen,
    ]),
  ]));
  updatePlay();
  updateMute();
  updateSpeed(1);
  return stage;
}

function modalRoot(): HTMLElement {
  const existing = document.getElementById(ROOT_ID);
  if (existing) return existing;
  const root = el('div', { id: ROOT_ID });
  document.body.append(root);
  return root;
}

/** Local clip actions styled like the capture workflow: preview, name, then
 * copy the finished file or reveal its containing folder. No upload occurs. */
export function showRecordingShareDialog(options: RecordingShareDialogOptions): RecordingShareDialogHandle {
  const root = modalRoot();
  clear(root);
  let actionBusy = false;
  let isLoading = options.loading === true;
  let currentFileName = options.fileName;
  const close = () => clear(root);
  const closeButton = el('button', {
    class: 'recording-share-close',
    type: 'button',
    'aria-label': 'Close clip actions',
    title: 'Close',
    text: '×',
    onClick: close,
  });
  const copyButton = el('button', { class: 'btn btn-primary recording-share-copy', type: 'button' }, [
    el('span', { class: 'recording-share-action-icon recording-share-action-icon-copy', 'aria-hidden': 'true' }),
    el('span', { text: 'Copy to Clipboard' }),
  ]) as HTMLButtonElement;
  const folderButton = el('button', { class: 'btn btn-secondary recording-share-folder', type: 'button' }, [
    el('span', { class: 'recording-share-action-icon recording-share-action-icon-folder', 'aria-hidden': 'true' }),
    el('span', { text: 'Open Folder' }),
  ]) as HTMLButtonElement;
  const titleNode = el('div', {
    class: 'recording-share-title-value',
    text: currentFileName.replace(/\.[^.]+$/, ''),
    'aria-label': 'Clip title',
  });
  const previewSlot = el('div', { class: 'recording-share-preview' });
  const loadingState = el('div', { class: 'recording-share-loading', role: 'status', 'aria-live': 'polite' }, [
    el('span', { class: 'recording-share-spinner', 'aria-hidden': 'true' }),
    el('strong', { text: 'Creating your clip' }),
    el('span', { text: 'Encoding the selected range…' }),
  ]);
  const renderPreview = (previewUrl: string | null | undefined) => {
    clear(previewSlot);
    previewSlot.append(isLoading ? loadingState : renderClipPreview(previewUrl));
  };
  const setBusy = (value: boolean) => {
    actionBusy = value;
    copyButton.disabled = value;
    folderButton.disabled = value;
    closeButton.disabled = value;
  };
  const runAction = async (action: 'copy' | 'folder') => {
    if (actionBusy || isLoading) return;
    setBusy(true);
    try {
      if (action === 'copy') {
        await options.onCopy();
        toast('success', 'Clip copied', `${currentFileName} is ready to paste.`);
      } else {
        await options.onOpenFolder();
      }
      close();
    } catch (error) {
      setBusy(false);
      toast('error', action === 'copy' ? 'Copy clip' : 'Open clip folder', error instanceof Error ? error.message : String(error));
    }
  };
  copyButton.addEventListener('click', () => { void runAction('copy'); });
  folderButton.addEventListener('click', () => { void runAction('folder'); });
  const handle: RecordingShareDialogHandle = {
    setReady: (previewUrl, fileName) => {
      isLoading = false;
      if (fileName) currentFileName = fileName;
      titleNode.textContent = currentFileName.replace(/\.[^.]+$/, '');
      copyButton.disabled = false;
      folderButton.disabled = false;
      renderPreview(previewUrl);
    },
    setError: (message) => {
      isLoading = false;
      copyButton.disabled = true;
      folderButton.disabled = true;
      clear(previewSlot);
      previewSlot.append(el('div', { class: 'recording-share-loading recording-share-loading-error', role: 'alert' }, [
        el('strong', { text: 'Clip creation failed' }),
        el('span', { text: message }),
      ]));
    },
  };
  // The backdrop is intentionally inert. Closing a clip action dialog should
  // be an explicit decision through its dedicated X button, especially while
  // the encoder is still creating the file.
  root.append(el('div', { class: 'modal-overlay recording-share-overlay' }, [
    el('div', { class: 'modal recording-share-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'recording-share-title' }, [
      el('div', { class: 'recording-share-heading' }, [
        el('div', {}, [el('span', { class: 'recording-eyebrow', text: 'Arc capture' }), el('h2', { class: 'modal-title', id: 'recording-share-title', text: 'Save & Share Clip' })]),
        closeButton,
      ]),
      previewSlot,
      el('div', { class: 'recording-share-title-row' }, [
        el('div', { class: 'recording-share-field' }, [el('span', { text: 'CLIP TITLE' }), titleNode]),
      ]),
      el('div', { class: 'recording-share-actions' }, [folderButton, copyButton]),
    ]),
  ]));
  renderPreview(options.previewUrl);
  if (isLoading) {
    copyButton.disabled = true;
    folderButton.disabled = true;
    closeButton.focus();
  } else copyButton.focus();
  return handle;
}
