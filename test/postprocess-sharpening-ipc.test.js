import test from 'node:test';
import assert from 'node:assert/strict';
import { createIpcHandlers } from '../src/main/ipc-core.js';
import { createMockPostprocessSharpening } from '../src/main/sharpening-postprocess-mock.js';

const EXE = 'd:\\steamlibrary\\steamapps\\common\\palworld\\pal\\binaries\\win64\\palworld-win64-shipping.exe';
const OTHER_EXE = 'c:\\games\\another-title\\another-title.exe';

function fixture() {
  const service = createMockPostprocessSharpening();
  let nativeCalls = 0;
  const { handlers } = createIpcHandlers({
    backend: { async setGraphicsSettings() { nativeCalls++; throw new Error('Sharpening reached IGCL'); } },
    store: { loadSettings: async () => ({}), saveSettings: async value => value },
    gameProfiles: { loadCatalog: async () => ({ catalog: [{ exePath: EXE }], settings: [] }) },
    postprocessSharpening: service, emit() {},
  });
  return { handlers, service, nativeCalls: () => nativeCalls };
}

test('screen sharpening IPC exposes global and per-game settings without setup routes', async () => {
  const f = fixture();
  assert.deepEqual((await f.handlers['postprocess-sharpening:get']()).value, { enabled: false, percentage: 50 });
  assert.equal(Object.hasOwn(f.handlers, 'postprocess-sharpening:install'), false);
  assert.equal(Object.hasOwn(f.handlers, 'postprocess-sharpening:remove'), false);

  const global = await f.handlers['postprocess-sharpening:set']({ enabled: true, percentage: 100 });
  assert.deepEqual(global.value, { enabled: true, percentage: 100 });
  assert.equal(global.provider, 'screen');
  assert.equal(global.requiresRestart, false);

  // A per-game override needs no setup and can target an executable outside
  // the currently enumerated game catalog; it only affects profile selection.
  const game = await f.handlers['postprocess-sharpening:game-get'](OTHER_EXE.toUpperCase());
  assert.equal(game.override, null);
  assert.deepEqual(game.effective, { enabled: true, percentage: 100 });
  const override = await f.handlers['postprocess-sharpening:game-set'](OTHER_EXE, { enabled: true, percentage: 37 });
  assert.deepEqual(override.override, { enabled: true, percentage: 37 });
  assert.deepEqual(override.effective, { enabled: true, percentage: 37 });
  assert.deepEqual((await f.handlers['postprocess-sharpening:game-get'](OTHER_EXE)).effective, { enabled: true, percentage: 37 });

  await f.handlers['postprocess-sharpening:game-set'](OTHER_EXE, null);
  assert.equal((await f.handlers['postprocess-sharpening:game-get'](OTHER_EXE)).override, null);
  assert.deepEqual((await f.handlers['postprocess-sharpening:game-get'](OTHER_EXE)).effective, { enabled: true, percentage: 100 });

  await f.handlers['postprocess-sharpening:set']({ enabled: false, percentage: 100 });
  assert.deepEqual((await f.handlers['postprocess-sharpening:game-get'](OTHER_EXE)).effective, { enabled: false, percentage: 0 });
  assert.equal(f.nativeCalls(), 0, 'screen sharpening must not route through legacy driver graphics settings');
});

test('Arc Super Resolution IPC persists an isolated toggle and never calls driver graphics settings', async () => {
  const f = fixture();
  assert.deepEqual((await f.handlers['arc-super-resolution:get']()).value, { enabled: false });
  const enabled = await f.handlers['arc-super-resolution:set']({ enabled: true });
  assert.deepEqual(enabled.value, { enabled: true });
  assert.equal(enabled.provider, undefined);
  assert.deepEqual((await f.handlers['arc-super-resolution:get']()).value, { enabled: true });
  await assert.rejects(f.handlers['arc-super-resolution:set']({ enabled: true, method: 'xess' }), /enabled flag/);
  await assert.rejects(f.handlers['arc-super-resolution:set']({ enabled: 1 }), /enabled flag/);
  await assert.rejects(f.handlers['arc-super-resolution:get'](1), /takes no payload/);
  await assert.rejects(f.handlers['arc-super-resolution:set']({ enabled: false }, {}), /takes no payload/);
  assert.equal(f.nativeCalls(), 0, "ASR must remain outside the driver's graphics apply path");
});

test('screen sharpening IPC rejects malformed values, invalid executable paths and extra arguments', async () => {
  const { handlers } = fixture();
  for (const value of [null, {}, [], { enabled: 1, percentage: 50 }, { enabled: true, percentage: 0.5 },
    { enabled: true, percentage: 101 }, { enabled: true, percentage: -1 }, { enabled: true, percentage: 50, path: EXE }]) {
    await assert.rejects(handlers['postprocess-sharpening:set'](value), /whole percentage/);
    if (value !== null) await assert.rejects(handlers['postprocess-sharpening:game-set'](EXE, value), /whole percentage/);
  }
  await assert.rejects(handlers['postprocess-sharpening:game-get']('relative.exe'), /valid game executable/);
  await assert.rejects(handlers['postprocess-sharpening:game-set']('relative.exe', null), /valid game executable/);
  await assert.rejects(handlers['postprocess-sharpening:get'](1), /takes no payload/);
  await assert.rejects(handlers['postprocess-sharpening:set']({ enabled: false, percentage: 0 }, {}), /takes no payload/);
  await assert.rejects(handlers['postprocess-sharpening:game-get'](EXE, {}), /takes no payload/);
  await assert.rejects(handlers['postprocess-sharpening:game-set'](EXE, null, {}), /takes no payload/);
});
