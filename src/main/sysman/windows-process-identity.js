// Arc Power - Windows process identity for the Electron-free Sysman child.

import koffi from 'koffi';

export const ARC_POWER_APP_USER_MODEL_ID = 'com.rid.arcpower.desktop.v3';

/**
 * Set the process AppUserModelId when running on Windows.
 *
 * The DLL is deliberately loaded only when this helper is called. Native
 * loading and invocation failures are safe for the Sysman child: callers get
 * a result instead of an exception.
 *
 * @param {{ platform?: string, lib?: object, koffiMod?: object }} [deps]
 * @returns {{ ok: boolean, skipped?: boolean, hresult?: number }}
 */
export function setWindowsProcessIdentity({ platform = process.platform, lib: libDep, koffiMod = koffi } = {}) {
  if (platform !== 'win32') return { ok: true, skipped: true };

  try {
    const lib = libDep ?? koffiMod.load('shell32.dll');
    const setCurrentProcessExplicitAppUserModelID = lib.func(
      'int32 SetCurrentProcessExplicitAppUserModelID(str16)',
    );
    const hresult = setCurrentProcessExplicitAppUserModelID(ARC_POWER_APP_USER_MODEL_ID);
    return { ok: hresult >= 0, hresult };
  } catch {
    return { ok: false };
  }
}
