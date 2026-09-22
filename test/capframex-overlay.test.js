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
const recordingPillSrc = read('src/main/recording-status-pill.js');
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
  assert.match(overlaySrc, /softwareRendererSelected && overlayEnabled \? overlayLaneKeys : \[\]/);
  assert.match(overlaySrc, /mainSelection: \{ deviceId\?: number \| null; deviceKey\?: string \| null \}/);
  assert.match(overlaySrc, /resolveOverlayMainDevice\(monitored, orderedDevices, mainSelection, primaryId\)/);
  assert.match(overlaySrc, /!softwareRendererSelected \|\| !overlayEnabled \|\| fpsDeviceId === null/);
  assert.match(overlaySrc, /mainSelectedDeviceId = payload\.deviceId/);
  assert.match(overlaySrc, /const requestGeneration = \+\+overlayRequestGeneration/);
  assert.match(overlaySrc, /const persistedSelection = await api\.deviceGet\(\)/);
  assert.match(overlaySrc, /const bootRequestGeneration = overlayRequestGeneration/);
  assert.match(overlaySrc, /bootRequestGeneration !== overlayRequestGeneration/);
  assert.match(settingsSrc, /dataset: \{ overlayRenderer: 'rtss' \}/);
  assert.match(settingsSrc, /dataset: \{ overlayRenderer: 'capframex' \}/);
  assert.match(settingsSrc, /profilesSettingsSave\(\{ overlayRenderer: nextRenderer \}\)/);
  assert.match(settingsSrc, /Arc Power Overlay/);
  assert.doesNotMatch(settingsSrc, /CapFrameX-style|CapFrameX style|Show CapFrameX/);
});

test('CapFrameX-style renderer honors the shared chip-name label toggle', () => {
  const gpuTitle = overlaySrc.match(/function capGpuTitle\([\s\S]*?\n}\n/);
  assert.ok(gpuTitle, 'CapFrameX GPU title helper should remain isolated');
  assert.match(gpuTitle[0], /if \(chipNamesEnabled\)/);
  assert.match(gpuTitle[0], /chipLabelGpu\(raw\)/);
  assert.match(overlaySrc, /cpuName\.textContent = chipNamesEnabled[\s\S]*cpuChipLabel/);
});

test('Arc Power Overlay labels averaged CPU frequency as CPU Clock', () => {
  assert.doesNotMatch(overlaySrc, /'CPU Max'/);
  assert.match(overlaySrc, /capStatRow\(cpuSection, enabled, 'cpu-clock', 'CPU Clock'/);
});

test('CapFrameX-style surface stays independent of CapFrameX native redistribution', () => {
  assert.match(overlayHtml, /Independent hook-free provider/);
  assert.match(overlayHtml, /does not load or\s+redistribute CapFrameX binaries/);
  assert.match(overlayCss, /data-overlay-renderer="capframex"/);
  assert.match(overlayCss, /capframex-chart/);
  assert.match(overlayCss, /#capframex-root \[hidden\] \{ display: none !important; \}/);
  assert.match(overlayCss, /var\(--capframex-bg/);
  assert.match(overlaySrc, /const capframexBackground = s\.overlayBgEnabled === true/);
  assert.match(overlayCss, /html\[data-overlay-bg="disabled"\] \.capframex-panel/);
  assert.match(overlayCss, /background: url\('\.\.\/assets\/ArcPowerIcon\.png'\)/);
  assert.match(overlayCss, /grid-template-columns: 1fr;/);
  assert.match(overlayCss, /linear-gradient\(180deg, #7fe3ff/);
  assert.match(overlayCss, /grid-template-columns: minmax\(0, 1fr\) 5\.8rem 6\.4rem/);
  assert.match(overlayCss, /#capframex-performance \{ grid-column: 3; \}/);
  assert.match(overlayCss, /\.capframex-panel[\s\S]*color-mix/);
  assert.match(overlayCss, /\.capframex-chart-card[\s\S]*var\(--capframex-bg-opacity/);
  assert.match(overlayCss, /\.capframex-title-label[\s\S]*grid-column: 1 \/ -1/);
  assert.match(overlayCss, /\.capframex-cpu-title \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(overlayHtml, /capframex-frametime-axis-top/);
  assert.match(overlayHtml, /capframex-frametime-axis-bottom/);
  assert.match(overlayHtml, />FPS<\/span>/);
  assert.match(overlayHtml, />RAM<\/span>/);
  assert.doesNotMatch(overlayHtml, /performance-ft/);
  assert.match(overlayHtml, /capframex-api-row[\s\S]*capframex-label">API/);
  assert.match(overlaySrc, /'cpu-util', 'CPU Load'/);
  assert.match(overlaySrc, /const apiLabel = apiLabelOf\(latestApi\)/);
  assert.match(overlaySrc, /capframexApiRow\.hidden = !enabled\.has\('api'\) \|\| !apiLabel/);
  assert.match(settingsSrc, /overlayBgEnabled/);
  assert.match(settingsSrc, /settings-background-opacity-slider/);
  assert.doesNotMatch(overlayHtml, /Displaytime/);
  assert.doesNotMatch(overlaySrc, /displaySeries|Displaytime/);
  assert.match(overlaySrc, /const low = 0/);
  assert.match(overlaySrc, /const high = Math\.max\(25/);
  assert.match(overlaySrc, /setAxis\(high\)/);
  assert.match(overlayMainSrc, /CAPFRAMEX_BASE_WIDTH = 336/);
  assert.match(overlayMainSrc, /CAPFRAMEX_BASE_HEIGHT = 426/);
  assert.match(overlayMainSrc, /CAPFRAMEX_GPU_ROW_HEIGHT = 21/);
  assert.match(overlayMainSrc, /capframexGpuTitleRows/);
  assert.match(overlayMainSrc, /capframexGpuSectionHeight/);
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

function loadAdvancedOverlayFactory() {
  const source = read('src/main/advanced-overlay.js')
    .replace(/^import .*\r?\n/gm, '')
    .replace('const __dirname = path.dirname(fileURLToPath(import.meta.url));', "const __dirname = '.';")
    .replace('export function createAdvancedOverlayWindow', 'function createAdvancedOverlayWindow');

  return ({ displayHeight = 1080, deferBuild = true, windows }) => {
    const screen = {
      getPrimaryDisplay: () => ({
        bounds: { x: 0, y: 0, width: 1920, height: displayHeight },
      }),
    };
    class FakeBrowserWindow {
      constructor(options) {
        this.options = options;
        this.destroyed = false;
        this.visible = options.show === true;
        this.bounds = {
          x: options.x,
          y: options.y,
          width: options.width,
          height: options.height,
        };
        this.handlers = new Map();
        this.webContents = {
          handlers: new Map(),
          on: (event, handler) => this.webContents.handlers.set(event, handler),
          send: () => {},
        };
        windows.push(this);
      }

      on(event, handler) {
        this.handlers.set(event, handler);
      }

      isDestroyed() {
        return this.destroyed;
      }

      isVisible() {
        return this.visible;
      }

      show() {
        this.visible = true;
      }

      hide() {
        this.visible = false;
      }

      destroy() {
        this.destroyed = true;
        this.visible = false;
        this.handlers.get('closed')?.();
      }

      setAlwaysOnTop() {}
      setBackgroundColor() {}
      setBounds(bounds) { this.bounds = { ...this.bounds, ...bounds }; }
      getBounds() { return { ...this.bounds }; }
      loadFile() {}
    }

    const factory = new Function(
      'BrowserWindow',
      'screen',
      'path',
      'fileURLToPath',
      'normalizeTheme',
      'themeBackground',
      'OVERLAY_STAT_IDS',
      'OVERLAY_STATS_DEFAULT',
      'applyWindowIconLifecycle',
      'resolveWindowIconPath',
      `${source}; return createAdvancedOverlayWindow;`,
    );
    return factory(
      FakeBrowserWindow,
      screen,
      path,
      fileURLToPath,
      (theme) => theme ?? 'arc',
      () => '#000000',
      ['fps'],
      ['fps'],
      () => {},
      () => undefined,
    )({
      getOverlaySettings: () => ({ enabled: true, position: 'right', hotkeyLetter: 'P', stats: ['fps'] }),
      deferBuild,
    });
  };
}

function loadRecordingPillFactory() {
  const source = read('src/main/recording-status-pill.js')
    .replace(/^import .*\r?\n/gm, '')
    .replace('const __dirname = path.dirname(fileURLToPath(import.meta.url));', "const __dirname = '.';")
    .replace('export function createRecordingStatusPillWindow', 'function createRecordingStatusPillWindow');

  return ({ initialState = null, deferBuild = true, windows }) => {
    const screen = {
      getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
    };
    class FakeBrowserWindow {
      constructor(options) {
        this.destroyed = false;
        this.visible = options.show === true;
        this.loading = true;
        this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
        this.handlers = new Map();
        this.messages = [];
        this.webContents = {
          handlers: new Map(),
          isLoading: () => this.loading,
          on: (event, handler) => this.webContents.handlers.set(event, handler),
          send: (channel, payload) => this.messages.push({ channel, payload }),
        };
        windows.push(this);
      }

      on(event, handler) { this.handlers.set(event, handler); }
      isDestroyed() { return this.destroyed; }
      isVisible() { return this.visible; }
      show() { this.visible = true; }
      showInactive() { this.visible = true; }
      hide() { this.visible = false; }
      destroy() {
        this.destroyed = true;
        this.visible = false;
        this.handlers.get('closed')?.();
      }
      setAlwaysOnTop() {}
      setBounds(bounds) { this.bounds = { ...this.bounds, ...bounds }; }
      getBounds() { return { ...this.bounds }; }
      setIgnoreMouseEvents() {}
      loadFile() {}
      finishLoad() {
        this.loading = false;
        this.webContents.handlers.get('did-finish-load')?.();
      }
    }

    const factory = new Function(
      'BrowserWindow',
      'screen',
      'path',
      'fileURLToPath',
      'applyWindowIconLifecycle',
      'resolveWindowIconPath',
      `${source}; return createRecordingStatusPillWindow;`,
    );
    let state = initialState;
    const handle = factory(
      FakeBrowserWindow,
      screen,
      path,
      fileURLToPath,
      () => {},
      () => undefined,
    )({
      getAnchorWindow: () => null,
      getRecordingState: () => state,
      deferBuild,
    });
    return {
      handle,
      windows,
      setState(next) {
        state = next;
        handle.setRecordingState(next);
      },
    };
  };
}

test('advanced overlay product mode builds on demand, clamps, and releases the renderer', async () => {
  const windows = [];
  const create = loadAdvancedOverlayFactory()({ displayHeight: 540, windows });
  const handle = create;

  handle.apply({ enabled: true, position: 'right', hotkeyLetter: 'P', stats: ['fps'] });
  assert.equal(handle.getState().exists, false, 'idle product mode must not create a renderer');
  assert.equal(windows.length, 0);

  await handle.toggle();
  assert.equal(windows.length, 1, 'the shortcut must build the renderer');
  assert.equal(handle.getState().visible, true);
  assert.equal(windows[0].bounds.height, 524, 'shortcut creation must clamp to a short display');

  await handle.toggle();
  assert.equal(windows[0].destroyed, true, 'hiding must release the product renderer');
  assert.equal(handle.getState().exists, false);

  await handle.toggle();
  assert.equal(windows.length, 2, 'a later shortcut must rebuild the renderer');
  await handle.closePanel();
  assert.equal(windows[1].destroyed, true, 'panel close must release the rebuilt renderer');
  assert.equal(handle.getState().exists, false);
});

test('advanced overlay eager mode keeps the verifier window contract', () => {
  const windows = [];
  const handle = loadAdvancedOverlayFactory()({ deferBuild: false, windows });

  handle.apply({ enabled: true, position: 'right', hotkeyLetter: 'P', stats: ['fps'] });
  assert.equal(windows.length, 1);
  assert.equal(handle.getState().exists, true);
  assert.equal(handle.getState().visible, false, 'eager verifier mode still starts hidden');
  handle.destroy();
});

test('recording status pill is demand-built for product capture only', () => {
  assert.match(recordingPillSrc, /deferBuild = false/);
  assert.match(recordingPillSrc, /if \(deferBuild && !isCaptureActive\(recordingState\)\) \{[\s\S]*?destroyWindow\(\);/);
  assert.match(recordingPillSrc, /const setRecordingState = \(state\) => \{[\s\S]*?if \(!enabled\) return;[\s\S]*?if \(deferBuild && !isCaptureActive\(recordingState\)\) \{[\s\S]*?destroyWindow\(\);/);
  assert.match(mainSrc, /getRecordingState: \(\) => recordingEngine\.getState\(\),\s*deferBuild: !uiVerify,/);
});

test('recording status pill releases and rebuilds around capture transitions', () => {
  const windows = [];
  const harness = loadRecordingPillFactory()({
    initialState: { activeModes: { video: false, replay: false } },
    windows,
  });

  harness.handle.apply(true);
  assert.equal(windows.length, 0, 'enabled idle product mode must not build a renderer');

  harness.setState({ activeModes: { video: true, replay: true } });
  assert.equal(windows.length, 1, 'active capture must build one renderer');
  assert.equal(windows[0].visible, true);
  windows[0].finishLoad();
  assert.ok(windows[0].messages.some(({ channel }) => channel === 'recording:state'));

  harness.setState({ activeModes: { video: false, replay: false } });
  assert.equal(windows[0].destroyed, true, 'capture stop must release the renderer');

  harness.setState({ activeModes: { video: false, replay: true } });
  assert.equal(windows.length, 2, 'a later replay must rebuild the renderer');
  harness.handle.apply(false);
  assert.equal(windows[1].destroyed, true, 'disabling the pill must release an active renderer');
  harness.handle.destroy();
});

test('recording status pill keeps the legacy running fallback during a start transition', () => {
  const windows = [];
  const harness = loadRecordingPillFactory()({
    initialState: { activeModes: { video: false, replay: false }, running: false, mode: null },
    windows,
  });

  harness.handle.apply(true);
  harness.setState({ activeModes: { video: false, replay: false }, running: true, mode: 'video' });
  assert.equal(windows.length, 1, 'a start envelope with stale activeModes must still build the pill');
  assert.equal(windows[0].visible, true);

  harness.setState({ activeModes: { video: false, replay: false }, running: true, mode: 'replay' });
  assert.equal(windows[0].visible, true, 'the replay fallback must keep the same pill visible');
  harness.handle.destroy();
});

test('recording toast releases its transient renderer after expiry', () => {
  const toastSrc = read('src/main/recording-toast.js');
  assert.match(toastSrc, /const destroyWindow = \(\) =>/);
  assert.match(toastSrc, /hideTimer = setTimeout\(\(\) => \{[\s\S]*?destroyWindow\(\);/);
});
