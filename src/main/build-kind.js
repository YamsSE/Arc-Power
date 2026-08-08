// Arc Power — the app:build-info distribution-kind derivation (electron-free,
// unit-testable). Consumed by main.js's app:build-info IPC injection; the
// Settings page's start-with-Windows hint differentiates by it.
//
// The four quadrants (M4-E review F2 pin):
//   - mock/ui-verify -> 'portable' (the mock applies in-process like the
//     portable build — the ui-verify pins expect the portable hint);
//   - INSTALLED build (packaged AND no PORTABLE_EXECUTABLE_DIR — that env
//     var is set ONLY by the portable wrapper) -> 'installed';
//   - packaged PORTABLE build (PORTABLE_EXECUTABLE_DIR set) -> 'portable' —
//     NOT 'dev' (the regression this module exists for: the old ternary
//     `mock ? 'portable' : installedBuild ? 'installed' : 'dev'` dropped the
//     packaged portable build into 'dev', so its Settings card rendered NO
//     hint line);
//   - the dev tree (not packaged) -> 'dev' (no hint).
//
// @param {{ mock: boolean, installedBuild: boolean, isPackaged: boolean }} deps
// @returns {'portable' | 'installed' | 'dev'}
export function deriveBuildKind({ mock, installedBuild, isPackaged }) {
  if (mock) return 'portable';
  if (installedBuild) return 'installed';
  if (isPackaged) return 'portable'; // packaged + PORTABLE_EXECUTABLE_DIR — the portable wrapper
  return 'dev';
}
