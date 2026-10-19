import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectLegacySharpening } from '../src/main/legacy-sharpening-audit.js';

function record(exePath, mode) {
  const dir = path.dirname(exePath);
  const runtime = mode === 'direct' ? 'dxgi.dll' : 'ReShade64.dll';
  return {
    exePath,
    mode,
    ownedFiles: Object.fromEntries([
      path.join(dir, runtime),
      path.join(dir, 'ReShade.ini'),
      path.join(dir, 'ArcPowerSharpening', 'ArcPowerSharpen.fx'),
      path.join(dir, 'ArcPowerSharpening', 'preset.ini'),
    ].map((file) => [file, 'a'.repeat(64)])),
    optiScalerIni: mode === 'direct' ? null : undefined,
  };
}

test('legacy sharpening audit detects prior ReShade records without writing game folders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-power-legacy-sharpening-'));
  const directExe = path.join(dir, 'games', 'DirectGame.exe');
  const optiExe = path.join(dir, 'other-games', 'OptiGame.exe');
  const before = fs.readdirSync(dir);
  fs.writeFileSync(path.join(dir, 'reshade-managed-games.json'), JSON.stringify({
    [directExe.toLowerCase()]: record(directExe, 'direct'),
    [optiExe.toLowerCase()]: record(optiExe, 'optiscaler'),
  }));
  try {
    const result = inspectLegacySharpening(dir);
    assert.equal(result.status, 'found');
    assert.deepEqual(result.games.map(({ mode }) => mode), ['direct', 'optiscaler']);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name !== 'reshade-managed-games.json'), before);
    assert.equal(fs.existsSync(path.dirname(directExe)), false);
    assert.equal(fs.existsSync(path.dirname(optiExe)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy sharpening audit fails closed for malformed ownership records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-power-legacy-sharpening-invalid-'));
  const file = path.join(dir, 'reshade-managed-games.json');
  fs.writeFileSync(file, JSON.stringify({ 'c:\\games\\game.exe': { exePath: 'C:\\Games\\Game.exe', mode: 'direct', ownedFiles: {} } }));
  try {
    const result = inspectLegacySharpening(dir);
    assert.equal(result.status, 'unreadable');
    assert.match(result.reason, /invalid ownership|invalid owned-file/i);
    assert.deepEqual(fs.readdirSync(dir), ['reshade-managed-games.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
