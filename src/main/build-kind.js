import path from 'node:path';

export const PORTABLE_EXECUTABLE_NAME = 'Arc-Power_Portable.exe';

function validatedPortablePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  return path.basename(value).toLowerCase() === PORTABLE_EXECUTABLE_NAME.toLowerCase()
    ? path.resolve(value)
    : null;
}

/** Resolve the wrapper proof shared by classification and replacement. */
export function resolvePortableWrapperPath({ portableExecutableFile = null, portableExecutableDir = null, parentExecutableFile = null } = {}) {
  const directoryCandidate = typeof portableExecutableDir === 'string' && path.isAbsolute(portableExecutableDir)
    ? path.join(portableExecutableDir, PORTABLE_EXECUTABLE_NAME)
    : null;
  return validatedPortablePath(portableExecutableFile)
    ?? validatedPortablePath(directoryCandidate)
    ?? validatedPortablePath(parentExecutableFile);
}

// Arc Power - the app:build-info distribution-kind derivation (electron-free,
// unit-testable). Consumed by main.js's app:build-info IPC injection; the
// Settings page's start-with-Windows hint differentiates by it.
//
// The four quadrants (M4-E review F2 pin):
//   - mock/ui-verify -> 'portable' (the mock applies in-process like the
//     portable build - the ui-verify pins expect the portable hint);
//   - INSTALLED build (packaged AND positively identified by the caller) ->
//     'installed';
//   - packaged PORTABLE build (PORTABLE_EXECUTABLE_DIR set) -> 'portable' -
//     NOT 'dev' (the regression this module exists for: the old ternary
//     `mock ? 'portable' : installedBuild ? 'installed' : 'dev'` dropped the
//     packaged portable build into 'dev', so its Settings card rendered NO
//     hint line);
//   - the dev tree (not packaged) -> 'dev' (no hint).
//
// Marker-less packaged launches without a positive installed proof are
// 'unknown' and must not guess an installed update target.
// @param {{ mock: boolean, installedBuild?: boolean, isPackaged: boolean, portableWrapperPath?: string|null }} deps
// @returns {'portable' | 'installed' | 'dev' | 'unknown'}
export function deriveBuildKind({ mock, installedBuild = false, isPackaged, portableWrapperPath = null }) {
  if (mock) return 'portable';
  if (!isPackaged) return 'dev';
  if (validatedPortablePath(portableWrapperPath)) return 'portable';
  if (installedBuild === true) return 'installed';
  return 'unknown';
}
