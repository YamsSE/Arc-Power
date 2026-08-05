// Arc Power — M2b system tray.
//
// The menu template + icon helpers are electron-free (unit-testable under
// plain node --test); the electron part (createTray) is a thin assembler.
// The icon is an embedded base64 PNG (32x32 filled-circle "A" glyph,
// generated at build time — no asset files). The tray starts only in the
// normal app path (never headless); Show/Hide toggles the window,
// "Apply active profile" applies the profile currently set in settings
// (only present when one exists), Quit exits.

export const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAe0lEQVR4nO3RwQ3AIAxDUabpjGxPFygQOw6BCku58p9EKXfAntqa5dLCcggblkBUcQqhjkOIqLgZkQqIjk8RqQD0kd5ohCKOIGjALGJFnA/wfsP5gPQvuAA5AEF47zO+BWAFYhjfAhCJMMWjEFBcjaDiCog7zELk4V/vBSZQ6vtvVfvEAAAAAElFTkSuQmCC';

export const TRAY_LABEL_TOGGLE = 'Show / Hide window';
export const TRAY_LABEL_APPLY_PROFILE = 'Apply active profile';
export const TRAY_LABEL_QUIT = 'Quit';
export const TRAY_BALLOON_TITLE = 'Arc Power';
export function trayBalloonProfileFailed(name) {
  return `Arc Power: profile '${name}' failed to apply — defaults restored`;
}

/** Balloon text for a gate refusal (nothing was applied or restored). */
export function trayBalloonProfileRefused(reason) {
  return `Arc Power: profile not applied — ${reason}`;
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
 * }} deps — electron types injected so the module stays importable in tests
 * @returns {import('electron').Tray}
 */
export function createTray({ tray: Tray, nativeImage, Menu, template }) {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  const t = new Tray(icon);
  t.setToolTip('Arc Power');
  t.setContextMenu(Menu.buildFromTemplate(template));
  return t;
}
