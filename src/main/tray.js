// Arc Power - M2b system tray.
//
// The menu template + icon helpers are electron-free (unit-testable under
// plain node --test); the electron part (createTray) is a thin assembler.
// The product passes the canonical ArcPowerIcon.png path. The embedded PNG is
// retained as a small electron-free test fallback. The tray starts only in
// the normal app path (never headless);
// Show/Hide toggles the window, "Apply active profile" applies the profile
// currently set in settings (only present when one exists), Quit exits.

import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

export const TRAY_ICON_DATA_URL =
  'data:image/png;base64,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';

export const TRAY_LABEL_TOGGLE = 'Show / Hide window';
export const TRAY_LABEL_APPLY_PROFILE = 'Apply active profile';
export const TRAY_LABEL_QUIT = 'Quit';
export const TRAY_BALLOON_TITLE = 'Arc Power';
export const TRAY_STATUS = Object.freeze({ RECORDING: 'recording', REPLAY: 'replay', READY: 'ready' });
const TRAY_STATUS_COLOR = Object.freeze({
  [TRAY_STATUS.RECORDING]: [239, 68, 68],
  [TRAY_STATUS.REPLAY]: [59, 130, 246],
  [TRAY_STATUS.READY]: [34, 197, 94],
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
  const modes = state.activeModes && typeof state.activeModes === 'object' ? state.activeModes : {};
  const video = modes.video === true || (Object.keys(modes).length === 0 && state.running === true && state.mode === 'video');
  const replay = modes.replay === true || (Object.keys(modes).length === 0 && state.running === true && state.mode === 'replay');
  if (video) return TRAY_STATUS.RECORDING;
  if (replay) return TRAY_STATUS.REPLAY;
  return TRAY_STATUS.READY;
}

export function trayStatusLabel(status) {
  if (status === TRAY_STATUS.RECORDING) return 'Recording';
  if (status === TRAY_STATUS.REPLAY) return 'Replay buffer';
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
 * Add the small status pill to the canonical 32px tray artwork. Keeping the
 * composition in PNG bytes makes the icon reliable on Windows tray surfaces,
 * including packaged Portable builds where SVG decoding is not guaranteed.
 */
export function createTrayStatusIconBuffer(baseBuffer, status) {
  const color = TRAY_STATUS_COLOR[status];
  if (!color) return Buffer.from(baseBuffer ?? []);
  try {
    const image = decodeRgbaPng(baseBuffer);
    const border = [3, 7, 15, 255];
    const left = image.width - 12;
    const top = image.height - 9;
    paintRoundedRect(image.pixels, image.width, image.height, left, top, image.width - 2, image.height - 2, 4, border);
    paintRoundedRect(image.pixels, image.width, image.height, left + 2, top + 2, image.width - 4, image.height - 4, 2, [...color, 255]);
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
