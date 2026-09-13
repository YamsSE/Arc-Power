import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ARC_POWER_APP_USER_MODEL_ID,
  setWindowsProcessIdentity,
} from '../src/main/sysman/windows-process-identity.js';

const fakeKoffi = (lib) => ({
  load(name) {
    assert.equal(name, 'shell32.dll');
    return lib;
  },
});

test('sets the stable AppUserModelId on win32 with a UTF-16 koffi binding', () => {
  let received = null;
  const lib = {
    func(signature) {
      assert.equal(signature, 'int32 SetCurrentProcessExplicitAppUserModelID(str16)');
      return (value) => {
        received = value;
        return 0;
      };
    },
  };

  assert.deepEqual(setWindowsProcessIdentity({ platform: 'win32', koffiMod: fakeKoffi(lib) }), { ok: true, hresult: 0 });
  assert.equal(received, ARC_POWER_APP_USER_MODEL_ID);
});

test('returns a safe failure for HRESULT and shell32 loader failures', () => {
  const hresultFailure = {
    func: () => () => -2147467259,
  };
  assert.deepEqual(setWindowsProcessIdentity({ platform: 'win32', lib: hresultFailure }), {
    ok: false,
    hresult: -2147467259,
  });

  assert.deepEqual(setWindowsProcessIdentity({
    platform: 'win32',
    koffiMod: { load: () => { throw new Error('shell32 unavailable'); } },
  }), { ok: false });
});

test('is a no-op off Windows without loading koffi or shell32', () => {
  let loaded = false;
  assert.deepEqual(setWindowsProcessIdentity({
    platform: 'linux',
    koffiMod: { load: () => { loaded = true; throw new Error('must not load'); } },
  }), { ok: true, skipped: true });
  assert.equal(loaded, false);
});

test('Electron-free Sysman entry applies the identity before starting the pipe mode', () => {
  const source = readFileSync(new URL('../src/main/sysman/helper-entry.js', import.meta.url), 'utf8');
  const identityCall = source.indexOf('setWindowsProcessIdentity()');
  const pipeModeCall = source.indexOf('runSysmanHelperPipeMode({');
  assert.ok(identityCall >= 0, 'helper entry must apply the process identity');
  assert.ok(pipeModeCall > identityCall, 'identity must be applied before Sysman pipe startup');
});
