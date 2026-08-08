// M4-E review F2 regression: deriveBuildKind (src/main/build-kind.js) — the
// app:build-info distribution kind. The bug: the old ternary in main.js
// (`mock ? 'portable' : installedBuild ? 'installed' : 'dev'`) dropped the
// packaged PORTABLE build (PORTABLE_EXECUTABLE_DIR set -> installedBuild
// false) into 'dev', so the Settings card rendered NO hint line on the
// portable distribution. The packaged portable build must report 'portable'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveBuildKind } from '../src/main/build-kind.js';

test('deriveBuildKind: the packaged PORTABLE build (PORTABLE_EXECUTABLE_DIR set) reports "portable" — never "dev"', () => {
  // installedBuild is false exactly because the portable wrapper set the env var.
  assert.equal(deriveBuildKind({ mock: false, installedBuild: false, isPackaged: true }), 'portable');
});

test('deriveBuildKind: the other three quadrants — mock -> portable, installed -> installed, dev tree -> dev', () => {
  assert.equal(deriveBuildKind({ mock: true, installedBuild: false, isPackaged: true }), 'portable');
  assert.equal(deriveBuildKind({ mock: true, installedBuild: true, isPackaged: true }), 'portable');
  assert.equal(deriveBuildKind({ mock: false, installedBuild: true, isPackaged: true }), 'installed');
  assert.equal(deriveBuildKind({ mock: false, installedBuild: false, isPackaged: false }), 'dev');
});
