// The optional CapFrameX-style renderer is an Arc Power implementation, not
// a bundled CapFrameX native binary. Keep the provider contract covered at
// the source seam used by the Electron-free overlay tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProfileStore } from '../src/main/store/profile-store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const storeSrc = read('src/main/store/profile-store.js');
const ipcSrc = read('src/main/ipc-core.js');
const mainSrc = read('src/main/main.js');
const overlayMainSrc = read('src/main/overlay.js');
const settingsSrc = read('src/renderer/pages/overlay-settings.ts');
const overlaySrc = read('src/renderer/overlay.ts');
const overlayHtml = read('src/renderer/overlay.html');
const overlayCss = read('src/renderer/overlay.css');

test('CapFrameX-style overlay is an opt-in provider with RTSS-compatible defaults', () => {
  assert.match(storeSrc, /export const OVERLAY_RENDERERS = \['rtss', 'capframex'\]/);
  assert.match(storeSrc, /if \(data\.overlayRenderer !== undefined\)/);
  assert.match(storeSrc, /const overlayRenderer = settings\.overlayRenderer !== undefined/);
  assert.match(ipcSrc, /export function validateOverlayRenderer/);
  assert.match(ipcSrc, /overlayRenderer: patch\.overlayRenderer === undefined/);
  assert.match(ipcSrc, /'overlayRenderer'/);
  assert.match(mainSrc, /const overlayRendererOf =/);
  assert.match(mainSrc, /renderer === 'capframex'/);
  assert.match(mainSrc, /renderer: overlayRendererOf\(settings\)/);
  assert.match(overlayMainSrc, /renderer: applied\.renderer/);
});

test('CapFrameX-style renderer is live-switchable and owns its telemetry lanes', () => {
  assert.match(mainSrc, /const electronSelected = renderer === 'capframex' \|\| uiVerify/);
  assert.match(mainSrc, /currentOverlayRenderer\(\) === 'capframex' && overlayHandle/);
  assert.match(overlaySrc, /document\.documentElement\.dataset\.overlayRenderer/);
  assert.match(overlaySrc, /renderCapframex\(displaySample\)/);
  assert.match(overlaySrc, /owner: 'overlay', deviceKeys: \[\]/);
  assert.match(overlaySrc, /softwareRendererSelected \? overlayLaneKeys : \[\]/);
  assert.match(settingsSrc, /dataset: \{ overlayRenderer: 'rtss' \}/);
  assert.match(settingsSrc, /dataset: \{ overlayRenderer: 'capframex' \}/);
  assert.match(settingsSrc, /profilesSettingsSave\(\{ overlayRenderer: nextRenderer \}\)/);
});

test('CapFrameX-style surface stays independent of CapFrameX native redistribution', () => {
  assert.match(overlayHtml, /Independent hook-free provider/);
  assert.match(overlayHtml, /does not load or\s+redistribute CapFrameX binaries/);
  assert.match(overlayCss, /data-overlay-renderer="capframex"/);
  assert.match(overlayCss, /capframex-chart/);
  assert.doesNotMatch(overlaySrc, /CapFrameX\.OSD|RTSSSharedMemoryV2|\.dll/);
});

test('overlay provider selection round-trips without changing legacy defaults', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-power-capframex-'));
  try {
    const store = new ProfileStore({ dir });
    const defaults = await store.loadSettings();
    assert.equal(defaults.overlayRenderer, undefined);
    await store.saveSettings({ ...defaults, overlayRenderer: 'capframex' });
    assert.equal((await store.loadSettings()).overlayRenderer, 'capframex');
    await store.saveSettings({ monitorLogToFile: true });
    assert.equal((await store.loadSettings()).overlayRenderer, 'capframex');
    await store.saveSettings({ ...(await store.loadSettings()), overlayRenderer: 'rtss' });
    assert.equal((await store.loadSettings()).overlayRenderer, 'rtss');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
