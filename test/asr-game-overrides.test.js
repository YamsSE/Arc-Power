import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createScreenPostprocessSharpening } from '../src/main/sharpening-screen.js';

const GAME = 'C:\\Games\\Example\\Game.exe', OTHER = 'C:\\Games\\Other\\Game.exe';
const identity = { pid: 4242, creationFiletime: '134374943822436889', exePath: GAME };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { const end = Date.now() + 3000; while (Date.now() < end) { if (predicate()) return; await delay(10); } assert.fail('Native ASR command did not reach its expected state'); }
function fixture(dir) {
  const commands = [], children = []; let current = { ...identity };
  const service = createScreenPostprocessSharpening({ dir, allowCaptureOverlay: false, allowAsrCapture: true, pollMs: 20,
    detector: { detectProcessIdentity: async () => current }, isGameExecutable: async exe => [GAME, OTHER].includes(exe),
    spawn() {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdout.setEncoding = child.stderr.setEncoding = () => {};
      child.exitCode = null; child.signalCode = null;
      child.stdin = { destroyed: false, write(value) { commands.push(value.trim()); }, end() { this.destroyed = true; child.exitCode = 0; child.emit('exit', 0); } };
      child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
      children.push(child); setImmediate(() => child.stdout.emit('data', 'READY screen-sharpen-v1\n')); return child;
    } });
  return { service, commands, children, foreground: value => { current = value; } };
}

test('per-game ASR On works with global Off, Off excludes global On, and inheritance survives restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-asr-overrides-')), f = fixture(dir);
  try {
    await f.service.start();
    await f.service.setAsrGame(GAME, { enabled: true });
    await until(() => f.commands.at(-1) === `ASR ${identity.pid} ${identity.creationFiletime}`);
    assert.equal((await f.service.getAsr()).value.enabled, false);
    assert.equal((await f.service.getAsrGame(GAME)).effective.enabled, true);
    assert.equal((await f.service.getGlobal()).value.enabled, false, 'ASR did not enable sharpening');
    await f.service.setAsr({ enabled: true });
    await f.service.setAsrGame(GAME, { enabled: false });
    await until(() => f.commands.at(-1) === 'ASR 0');
    await delay(80); assert.equal(f.commands.at(-1), 'ASR 0');
    await f.service.setAsrGame(GAME, null);
    await until(() => f.commands.at(-1) === `ASR ${identity.pid} ${identity.creationFiletime}`);
    await f.service.setAsrGame(OTHER, { enabled: false });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'postprocess-sharpening.json')));
    assert.deepEqual(saved.asrGames, { [OTHER.toLowerCase()]: { enabled: false } });
    await f.service.stop();
    const reload = fixture(dir);
    try {
      assert.equal((await reload.service.getAsrGame(GAME)).override, null);
      assert.equal((await reload.service.getAsrGame(GAME)).effective.enabled, true);
      assert.equal((await reload.service.getAsrGame(OTHER)).effective.enabled, false);
    } finally { await reload.service.stop(); }
  } finally { await f.service.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an ASR override cannot make an unknown desktop executable eligible', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-asr-eligibility-')), f = fixture(dir);
  try {
    f.foreground({ ...identity, exePath: 'C:\\Apps\\Desktop.exe' });
    await f.service.start(); await f.service.setAsrGame('C:\\Apps\\Desktop.exe', { enabled: true });
    await until(() => f.commands.includes('ASR 0')); await delay(80);
    assert.ok(!f.commands.some(command => command.startsWith(`ASR ${identity.pid} `)));
    for (const value of [{ enabled: 1 }, { enabled: true, extra: true }, []]) await assert.rejects(f.service.setAsrGame(GAME, value), /Arc Super Resolution/);
    await assert.rejects(f.service.setAsrGame('relative.exe', null), /valid game executable/);
  } finally { await f.service.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
