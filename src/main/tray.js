// Arc Power - M2b system tray.
//
// The menu template + icon helpers are electron-free (unit-testable under
// plain node --test); the electron part (createTray) is a thin assembler.
// The product passes the canonical tray-icon.png path. The embedded PNG is
// the matching 32px fallback for missing files and electron-free tests. The
// tray starts only in the normal app path (never headless);
// Show/Hide toggles the window, "Apply active profile" applies the profile
// currently set in settings (only present when one exists), Quit exits.

import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

export const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAASgSURBVFhH7c55UFVVHAfw55IT00x7U+M44zIMphECIsFjOT7xCQhXAxQUSMB9SW0bI1E099zuZNQ4BUgggygGmguu5D0XBARFRb1ZFqPj+PaN9x7v8ZZv88CaumllKk0zfGbOP+f8zu/7lUh69fo/2y6g33YBT4rve8zmq8jeeg354vsesbYVfhuuwL7pKrD5KjLF749VziUMWHUZLR+3AutagQ1XYNl4BX7iuccmuwUbll8EVl4CVl0G1rTCtr6nCrxzHqHvX4BzWQuQfRHI6S7y4fxmPD+/2T1RPP9ILWjCU2834/rSZuDd88AHF4BlLaid2+iWzDvnLp/b4NLMrnO9Iv73yMxpRN78c8DCJmBxM7D0PMzvXYD3nHpX6pyzLsyqdWImdR7IrHGIvz68GfWQZzXAPasRmNsIeIosasKC2XUur1m1Tu1M6kTWGQcyTzuQcbIzQ/z/oSTX4tnUOtxKPwtk1ANZDcDsRhybdw59PO9ZZxw7Mmu6gjHjuB3p1XZ92mHbIPGefy2JR8nUWmBaHZB6FnirHrrMBvwWkHGq02vGic5r6dV2pB2xIfWQDdMPdFSnfGPtKvhQ4jkkTqJAAg8k8UByd5E0VoCcFbCUFbCIFTAg/ag9KPWQrXP6wQ5Mq+xA8n4rpu6zzBPveyDyk86XY2pcqonfuRHPAZO7i1SwAgaxAkysANw9+awAybSqjtyUrmArppRbkFRmNiXsNg8V7/1HyFG7ZNzxzqrxJxyYcMqJmBoX4s64FQyHF1kB5b8L//UsTq6w9p9SbqlPKjMjsdSMN4vbMbmovYYpMPUV7/9b4Yc7MiOP2iCrtiPqeCfkJx2IPu1kWAEDWQFf3+MUsAJeSCw1+ySUtFsmF7VjUqEJTL4J8V8al4j3/6XgKvPg0IMWQ9i3VkQc7gDxFDlmLxTP3c+kXaaFd4MRt9OA2M8NlpjP9D7iuXvy32vsO3q/6dSYyna8UWVG6EELwg5Z2yKP2J4Wz95P/FfGPnE7DdWxXxgQk6dH9Kd6TGB1deO3avuJZ//k9T36JaP2GhCwz4jR+00IrjS7Qg5YZAH8T96BfBsTRG8ywfQ2E0LvMFKqYiKohiFUz8iokYmiZkbOWZlozjYyNk8/MHqHXjuB1UG+TYeoLVqM26RZJs77g+ElmuEjSrVW3zId/Pbo4b/XiMAKEzuK//EZf/7Gz4F8G4LoTQTT2wihdyClKkRQDQjVQ0aNiKJmyDkrojm7IoZzvCTfpksZ7wn+RAPZRg3GrlPbIteoXxPndhlaqOzvXaRq8ClW49USLUaW6uBbpr82qtzg5cf/UOzP38ADFEAs56iYyLkkso2a0rHr1SBr1IhYrUJ4rqpJmqN8QpwvGZyvWDGkQIlhu1TwLlLDp1jjGLFbO8aX/z7Fj7+OBy/gRBznSiNr1c9FrlbdCs9VIWyFEtLlCoRmK3LF+Z4C0sH5CjKkQEGGFSqJd5HK33PvywsBfvx14s/fIIF8GwmiN0kwvU1C6B0ipSoSQTWEUD2RUSOJomYi56wkmrOTWM5J4jh3gGdH+Erl0LAcJZF+pCCh2V1HKs7v1es/8wsre1E9qRBvKAAAAABJRU5ErkJggg==';

export const TRAY_LABEL_TOGGLE = 'Show / Hide window';
export const TRAY_LABEL_APPLY_PROFILE = 'Apply active profile';
export const TRAY_LABEL_QUIT = 'Quit';
export const TRAY_BALLOON_TITLE = 'Arc Power';
export const TRAY_STATUS = Object.freeze({ RECORDING: 'recording', REPLAY: 'replay', READY: 'ready', SAVING: 'saving', ERROR: 'error' });
const TRAY_STATUS_COLOR = Object.freeze({
  [TRAY_STATUS.RECORDING]: [239, 68, 68],
  [TRAY_STATUS.REPLAY]: [59, 130, 246],
  [TRAY_STATUS.READY]: [34, 197, 94],
  [TRAY_STATUS.SAVING]: [245, 158, 11],
  [TRAY_STATUS.ERROR]: [220, 38, 38],
});
export function trayBalloonProfileFailed(name) {
  return `Arc Power: profile '${name}' failed to apply - defaults restored`;
}

/**
 * M4-D Round-1 F5: the tray toggle's window action. A MINIMIZED window
 * reports isVisible() === true - the old visibility-only toggle would HIDE
 * a minimized window instead of restoring it (a start-hidden (tray) session
 * could never be restored from the tray). The minimize case wins: restore
 * first; only a visible, non-minimized window toggles to hidden.
 * @param {{ isMinimized: boolean, isVisible: boolean }} winState
 * @returns {'restore' | 'hide' | 'show'}
 */
export function trayToggleAction({ isMinimized, isVisible }) {
  if (isMinimized) return 'restore';
  return isVisible ? 'hide' : 'show';
}

export function trayStatusFromRecordingState(state = {}) {
  const saveStatus = state.instantReplaySave?.status;
  if (saveStatus === 'saving') return TRAY_STATUS.SAVING;
  if (saveStatus === 'error') return TRAY_STATUS.ERROR;
  const modes = state.activeModes && typeof state.activeModes === 'object' ? state.activeModes : {};
  const video = modes.video === true || (Object.keys(modes).length === 0 && state.running === true && state.mode === 'video');
  const replay = modes.replay === true || (Object.keys(modes).length === 0 && state.running === true && state.mode === 'replay');
  if (video) return TRAY_STATUS.RECORDING;
  if (replay) return TRAY_STATUS.REPLAY;
  return TRAY_STATUS.READY;
}

export function trayStatusLabel(status) {
  if (status === TRAY_STATUS.RECORDING) return 'Recording';
  if (status === TRAY_STATUS.REPLAY) return 'Instant Replay';
  if (status === TRAY_STATUS.SAVING) return 'Saving Instant Replay';
  if (status === TRAY_STATUS.ERROR) return 'Instant Replay failed';
  return 'Ready';
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), 8 + data.length);
  return chunk;
}

function decodeRgbaPng(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('tray icon is not a valid PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error('tray icon PNG is truncated');
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset = dataEnd + 4;
  }
  if (!width || !height || bitDepth !== 8 || colorType !== 6 || interlace !== 0) throw new Error('tray icon must be a non-interlaced 8-bit RGBA PNG');
  const stride = width * 4;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * 4);
  const previous = Buffer.alloc(stride);
  let sourceOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[sourceOffset++];
    const row = Buffer.from(raw.subarray(sourceOffset, sourceOffset + stride));
    sourceOffset += stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? row[x - 4] : 0;
      const up = previous[x] ?? 0;
      const upperLeft = x >= 4 ? previous[x - 4] : 0;
      if (filter === 1) row[x] = (row[x] + left) & 0xff;
      else if (filter === 2) row[x] = (row[x] + up) & 0xff;
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) {
        const p = left + up - upperLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upperLeft);
        row[x] = (row[x] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft)) & 0xff;
      } else if (filter !== 0) throw new Error(`unsupported tray icon PNG filter ${filter}`);
    }
    row.copy(pixels, y * stride);
    row.copy(previous);
  }
  return { width, height, pixels };
}

function encodeRgbaPng(image) {
  const rows = Buffer.alloc((image.width * 4 + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    const rowOffset = y * (image.width * 4 + 1);
    rows[rowOffset] = 0;
    image.pixels.copy(rows, rowOffset + 1, y * image.width * 4, (y + 1) * image.width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(rows, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

function roundedRectContains(x, y, left, top, right, bottom, radius) {
  const nearestX = Math.max(left + radius, Math.min(x, right - radius));
  const nearestY = Math.max(top + radius, Math.min(y, bottom - radius));
  const dx = x - nearestX;
  const dy = y - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}

function paintRoundedRect(pixels, width, height, left, top, right, bottom, radius, color) {
  for (let y = Math.max(0, top); y <= Math.min(height - 1, bottom); y++) {
    for (let x = Math.max(0, left); x <= Math.min(width - 1, right); x++) {
      if (!roundedRectContains(x, y, left, top, right, bottom, radius)) continue;
      const offset = (y * width + x) * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = color[3] ?? 255;
    }
  }
}

/**
 * Add the high-visibility status pill to the canonical 32px tray artwork.
 * Keeping the composition in PNG bytes makes the icon reliable on Windows
 * tray surfaces, including packaged Portable builds where SVG decoding is not
 * guaranteed.
 */
export function createTrayStatusIconBuffer(baseBuffer, status) {
  const color = TRAY_STATUS_COLOR[status];
  if (!color) return Buffer.from(baseBuffer ?? []);
  try {
    const image = decodeRgbaPng(baseBuffer);
    const border = [3, 7, 15, 255];
    const left = image.width - 17;
    const top = image.height - 12;
    paintRoundedRect(image.pixels, image.width, image.height, left, top, image.width - 2, image.height - 2, 5, border);
    paintRoundedRect(image.pixels, image.width, image.height, left + 2, top + 2, image.width - 4, image.height - 4, 3, [...color, 255]);
    return encodeRgbaPng(image);
  } catch {
    return Buffer.from(baseBuffer ?? []);
  }
}

/** Balloon text for a gate refusal (nothing was applied or restored). */
export function trayBalloonProfileRefused(reason) {
  return `Arc Power: profile not applied - ${reason}`;
}

/**
 * Balloon content for an apply outcome (M2b review F1). The failure balloon
 * claims "defaults restored" ONLY when a restore actually ran
 * (`fallbackApplied !== undefined`); gate refusals get a reason-specific
 * message; a successful apply balloons nothing (returns null).
 * @param {{ applied: boolean, reason: string, fallbackApplied?: boolean }} out
 * @param {string} name
 * @returns {string | null}
 */
export function trayBalloonForOutcome(out, name) {
  if (out.applied) return null;
  if (out.fallbackApplied !== undefined) return trayBalloonProfileFailed(name);
  return trayBalloonProfileRefused(out.reason);
}

/**
 * Decode the embedded icon (pure, no electron): returns the PNG dimensions
 * from the IHDR chunk so tests can pin the icon without a window.
 * @returns {{ width: number, height: number, bytes: number }}
 */
export function decodeTrayIcon() {
  const b64 = TRAY_ICON_DATA_URL.slice(TRAY_ICON_DATA_URL.indexOf(',') + 1);
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('tray icon is not a valid PNG');
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length };
}

/**
 * Pure menu template (electron-free, testable).
 * @param {{
 *   hasActiveProfile: boolean,
 *   onToggle: () => void,
 *   onApplyProfile: () => void,
 *   onQuit: () => void,
 * }} deps
 * @returns {Array<{ label: string, enabled: boolean, click: () => void }>}
 */
export function buildTrayMenuTemplate({ hasActiveProfile, onToggle, onApplyProfile, onQuit }) {
  const items = [
    { label: TRAY_LABEL_TOGGLE, enabled: true, click: onToggle },
  ];
  if (hasActiveProfile) {
    items.push({ label: TRAY_LABEL_APPLY_PROFILE, enabled: true, click: onApplyProfile });
  }
  items.push({ label: TRAY_LABEL_QUIT, enabled: true, click: onQuit });
  return items;
}

/**
 * Electron assembler: build the Tray with the embedded icon + the template.
 * Only ever called from the normal app path (never headless). The returned
 * tray is kept alive by the caller (module-level reference).
 * @param {{
 *   tray: import('electron').Tray,
 *   nativeImage: import('electron').NativeImage,
 *   Menu: typeof import('electron').Menu,
 *   template: ReturnType<typeof buildTrayMenuTemplate>,
 *   iconPath?: string | null,
 * }} deps - electron types injected so the module stays importable in tests
 * @returns {import('electron').Tray}
 */
export function createTray({ tray: Tray, nativeImage, Menu, template, iconPath = null }) {
  let baseBuffer = null;
  if (iconPath) {
    try {
      // Pass bytes rather than an app.asar path. This keeps the tray icon
      // valid in both the unpacked development tree and packaged Portable.
      baseBuffer = readFileSync(iconPath);
    } catch {
      baseBuffer = null;
    }
  }
  if (!baseBuffer) baseBuffer = Buffer.from(TRAY_ICON_DATA_URL.slice(TRAY_ICON_DATA_URL.indexOf(',') + 1), 'base64');
  const icons = new Map(Object.values(TRAY_STATUS).map((status) => [status, createTrayStatusIconBuffer(baseBuffer, status)]));
  const iconFor = (status) => {
    try {
      const icon = nativeImage.createFromBuffer(icons.get(status) ?? baseBuffer);
      return icon && !icon.isEmpty() ? icon : null;
    } catch { return null; }
  };
  let icon = iconFor(TRAY_STATUS.READY);
  if (!icon) icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  const t = new Tray(icon);
  let currentStatus = TRAY_STATUS.READY;
  t.setToolTip(`Arc Power — ${trayStatusLabel(currentStatus)}`);
  t.setRecordingState = (state) => {
    const nextStatus = trayStatusFromRecordingState(state);
    if (nextStatus === currentStatus) return;
    const nextIcon = iconFor(nextStatus);
    if (nextIcon && typeof t.setImage === 'function') t.setImage(nextIcon);
    currentStatus = nextStatus;
    t.setToolTip(`Arc Power — ${trayStatusLabel(currentStatus)}`);
  };
  t.setContextMenu(Menu.buildFromTemplate(template));
  return t;
}
