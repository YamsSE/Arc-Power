import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScreenPostprocessSharpening } from '../src/main/sharpening-screen.js';

const GAME = 'C:\\Games\\Palworld\\Pal\\Binaries\\Win64\\Palworld-Win64-Shipping.exe';
const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/main/sharpening-runtime/ArcPower.ScreenSharpen.exe');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeStream extends EventEmitter {
  destroyed = false;
  writes = [];
  setEncoding() {}
  write(value) { this.writes.push(String(value)); return true; }
  end() { this.destroyed = true; }
}

class FakeChild extends EventEmitter {
  stdin = new FakeStream();
  stdout = new FakeStream();
  stderr = new FakeStream();
  exitCode = null;
  signalCode = null;
  killed = false;
  kill() { this.killed = true; this.exitCode = 0; this.emit('exit', 0, null); }
}

async function until(predicate, message, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail(message);
}

function legacyRecord(exePath, mode = 'direct') {
  const gameDir = path.dirname(exePath);
  const runtime = mode === 'direct' ? 'dxgi.dll' : 'ReShade64.dll';
  return {
    exePath,
    mode,
    ownedFiles: Object.fromEntries([
      path.join(gameDir, runtime),
      path.join(gameDir, 'ReShade.ini'),
      path.join(gameDir, 'ArcPowerSharpening', 'ArcPowerSharpen.fx'),
      path.join(gameDir, 'ArcPowerSharpening', 'preset.ini'),
    ].map((file) => [file, 'a'.repeat(64)])),
    optiScalerIni: mode === 'direct' ? null : undefined,
  };
}

test('screen sharpening service starts without capture consent, selects, overrides, warns and stops', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-power-sharpening-screen-'));
  const children = [];
  const commands = [];
  let foreground = { pid: 4242, exePath: GAME };
  const spawn = (exe, args, options) => {
    assert.equal(exe, HELPER);
    assert.deepEqual(args, []);
    assert.equal(options.windowsHide, true);
    const child = new FakeChild();
    children.push(child);
    child.stdin.write = (value) => { child.stdin.writes.push(String(value)); commands.push(String(value).trim()); return true; };
    setTimeout(() => child.stdout.emit('data', 'READY screen-sharpen-v1\n'), 0);
    return child;
  };
  const service = createScreenPostprocessSharpening({
    dir,
    helperPath: HELPER,
    detector: { async detectProcess() { return foreground; } },
    spawn,
    pollMs: 250,
  });
  const statuses = [];
  const unsubscribeStatus = service.subscribeStatus((status) => statuses.push(status));

  try {
    assert.deepEqual(statuses[0], { active: false, reason: null }, 'runtime subscribers receive the current initial state');
    assert.equal((await service.getGlobal()).runtimeReady, true, 'the pinned helper should pass integrity validation');
    await service.start();
    assert.equal(children.length, 0, 'the disabled global setting should not launch the helper');

    const enabled = await service.setGlobal({ enabled: true, percentage: 74 });
    assert.equal(enabled.runtimeReady, true);
    assert.equal(children.length, 1, 'enabling global sharpening should launch one helper');
    await until(() => commands.includes('SET 4242 74'), 'foreground PID and global strength were not sent after READY');
    assert.equal(commands[0], 'SET 4242 74');

    children[0].stdout.emit('data', 'ACTIVE 4242\n');
    assert.deepEqual(statuses.at(-1), { active: true, reason: null }, 'helper ACTIVE transitions are published without polling the settings API');
    assert.equal((await service.getGlobal()).active, true, 'ACTIVE from the helper should be reflected in service state');

    foreground = { pid: 4242, exePath: GAME };
    const game = await service.getGame(GAME);
    assert.equal(game.override, null);
    assert.deepEqual(game.effective, { enabled: true, percentage: 74 });
    const overridden = await service.setGame(GAME, { enabled: true, percentage: 29 });
    assert.deepEqual(overridden.override, { enabled: true, percentage: 29 });
    assert.deepEqual(overridden.effective, { enabled: true, percentage: 29 });
    await until(() => commands.includes('SET 4242 29'), 'per-game override was not sent for the selected process');
    assert.deepEqual((await service.getGlobal()).value, { enabled: true, percentage: 74 }, 'per-game override changed global value');

    foreground = null;
    await until(() => commands.includes('SET 0 0'), 'missing foreground identity did not clear the capture target');
    foreground = { pid: 4242, exePath: GAME };

    children[0].stderr.emit('data', 'WARN capture path is temporarily unavailable\n');
    assert.equal(statuses.at(-1).reason, 'WARN capture path is temporarily unavailable');
    const warned = await service.getGlobal();
    assert.match(warned.reason, /^WARN capture path is temporarily unavailable/);
    assert.equal(children.length, 1, 'a nonfatal warning must not restart or stop the helper');
    assert.equal(children[0].killed, false);

    await service.setGlobal({ enabled: false, percentage: 74 });
    assert.ok(commands.includes('SET 0 0'), 'disabling global sharpening should clear the active target before shutdown');
    assert.ok(commands.includes('STOP'), 'disabling global sharpening should stop the helper');
    assert.equal((await service.getGlobal()).active, false);
  } finally {
    unsubscribeStatus();
    for (const child of children) {
      child.exitCode ??= 0;
      child.stdin.destroyed = true;
    }
    await service.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stopping during asynchronous protected staging cancels launch and cleans the late stage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-power-sharpening-stage-race-'));
  const children = [];
  let stageStarted = false;
  let resolveStage;
  let cleanupCount = 0;
  const service = createScreenPostprocessSharpening({
    dir,
    helperPath: HELPER,
    detector: { async detectProcess() { return null; } },
    stageHelper() {
      stageStarted = true;
      return new Promise((resolve) => { resolveStage = resolve; });
    },
    spawn() { children.push(true); return new FakeChild(); },
  });
  try {
    await service.start();
    const starting = service.setGlobal({ enabled: true, percentage: 85 });
    await until(() => stageStarted, 'protected staging did not start');
    let mainLoopContinued = false;
    setImmediate(() => { mainLoopContinued = true; });
    await until(() => mainLoopContinued, 'asynchronous helper staging blocked the event loop');

    await service.setGlobal({ enabled: false, percentage: 85 });
    resolveStage({ path: HELPER, cleanup() { cleanupCount++; } });
    await starting;
    await delay(0);

    assert.equal(children.length, 0, 'a canceled staging operation must not spawn the helper');
    assert.equal(cleanupCount, 1, 'a stage that finishes after cancellation must be removed');
  } finally {
    await service.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('screen sharpening surfaces a matching legacy install without touching its game folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-power-sharpening-legacy-'));
  const exePath = path.join(dir, 'games', 'OldGame.exe');
  fs.writeFileSync(path.join(dir, 'reshade-managed-games.json'), JSON.stringify({
    [exePath.toLowerCase()]: legacyRecord(exePath),
  }));
  const service = createScreenPostprocessSharpening({
    dir,
    helperPath: HELPER,
    detector: { async detectProcess() { return null; } },
    spawn() { assert.fail('legacy audit must not launch the helper'); },
  });
  try {
    const global = await service.getGlobal();
    assert.equal(global.legacyIntegrations.length, 1);
    assert.equal(global.legacyManifestStatus, 'found');
    const game = await service.getGame(exePath);
    assert.equal(game.legacyIntegration?.mode, 'direct');
    assert.equal(fs.existsSync(path.dirname(exePath)), false, 'audit must not create or modify the old game directory');
  } finally {
    await service.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid saved sharpening settings do not block app startup or get overwritten', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-power-sharpening-invalid-'));
  const file = path.join(dir, 'postprocess-sharpening.json');
  const original = '{invalid json';
  fs.writeFileSync(file, original, 'utf8');
  const service = createScreenPostprocessSharpening({
    dir,
    helperPath: HELPER,
    detector: { async detectProcess() { return null; } },
    spawn() { assert.fail('invalid settings must keep the helper disabled'); },
  });
  try {
    const state = await service.start();
    assert.deepEqual(state.value, { enabled: false, percentage: 50 });
    assert.match(state.reason, /settings could not be loaded and were preserved/i);
    await assert.rejects(service.setGlobal({ enabled: true, percentage: 100 }), /Repair the settings file/i);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally {
    await service.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
