import test from 'node:test';
import assert from 'node:assert/strict';
import { createIpcHandlers } from '../src/main/ipc-core.js';
import { createMockPostprocessSharpening } from '../src/main/sharpening-postprocess-mock.js';

const EXE = 'd:\\steamlibrary\\steamapps\\common\\palworld\\pal\\binaries\\win64\\palworld-win64-shipping.exe';
function fixture() {
  const service = createMockPostprocessSharpening();
  let nativeCalls = 0;
  const { handlers } = createIpcHandlers({
    backend: { async setGraphicsSettings() { nativeCalls++; throw new Error('Shader settings reached IGCL'); } },
    store: { loadSettings: async () => ({}), saveSettings: async value => value },
    gameProfiles: { loadCatalog: async () => ({ catalog: [{ exePath: EXE }], settings: [] }) },
    postprocessSharpening: service, emit() {},
  });
  return { handlers, service, nativeCalls: () => nativeCalls };
}

test('shader install uses the production catalog envelope and separate rendering provider', async () => {
  const f = fixture();
  assert.equal((await f.handlers['postprocess-sharpening:game-get'](EXE)).installed, false);
  const installed = await f.handlers['postprocess-sharpening:install'](EXE.toUpperCase());
  assert.equal(installed.installed, true);
  await f.handlers['postprocess-sharpening:set']({ enabled: true, percentage: 100 });
  assert.deepEqual((await f.handlers['postprocess-sharpening:game-get'](EXE)).value, { enabled: true, percentage: 100 });
  await f.handlers['postprocess-sharpening:game-set'](EXE, { enabled: false, percentage: 37 });
  assert.deepEqual((await f.handlers['postprocess-sharpening:game-get'](EXE)).value, { enabled: false, percentage: 37 });
  await f.handlers['postprocess-sharpening:game-set'](EXE, null);
  assert.deepEqual((await f.handlers['postprocess-sharpening:game-get'](EXE)).value, { enabled: true, percentage: 100 });
  assert.equal((await f.handlers['postprocess-sharpening:remove'](EXE)).installed, false);
  assert.equal(f.nativeCalls(), 0);
});

test('shader channels reject unknown targets, malformed values and extra arguments', async () => {
  const { handlers } = fixture();
  await assert.rejects(handlers['postprocess-sharpening:install']('d:\\other-game.exe'), /Add this game/);
  await assert.rejects(handlers['postprocess-sharpening:install']('relative.exe'), /valid game executable/);
  for (const value of [null, {}, [], { enabled: 1, percentage: 50 }, { enabled: true, percentage: 0.5 },
    { enabled: true, percentage: 101 }, { enabled: true, percentage: -1 }, { enabled: true, percentage: 50, path: EXE }]) {
    await assert.rejects(handlers['postprocess-sharpening:set'](value), /whole percentage/);
    await assert.rejects(handlers['postprocess-sharpening:game-set'](EXE, value === null ? undefined : value), /whole percentage/);
  }
  await assert.rejects(handlers['postprocess-sharpening:get'](1), /takes no payload/);
  await assert.rejects(handlers['postprocess-sharpening:install'](EXE, {}), /takes no payload/);
  await assert.rejects(handlers['postprocess-sharpening:game-set'](EXE, null, {}), /takes no payload/);
});
