import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInstallationPlan, createUninstallCleanupScript } from '../src/main/installer-pure.js';

const appData = path.resolve('test-fixtures', 'Roaming');
const documents = path.resolve('test-fixtures', 'Documents');
const profilePath = path.join(appData, 'ArcPower');
const monitorLogPath = path.join(documents, 'Arc Power');

function makePlan(overrides = {}) {
  return createInstallationPlan({
    localAppData: path.resolve('test-fixtures', 'Local'),
    appData,
    documents,
    desktop: path.resolve('test-fixtures', 'Desktop'),
    installDir: path.resolve('test-fixtures', 'Local', 'Programs', 'Arc Power'),
    ...overrides,
  });
}

test('uninstall cleanup owns the exact ArcPower profile and removes only Arc Power telemetry logs', () => {
  const plan = makePlan();
  const script = createUninstallCleanupScript({
    pid: 1234,
    plan,
    scriptPath: path.join(path.resolve('test-fixtures', 'Temp'), 'arc-power-uninstall.ps1'),
    recoveryCommand: 'powershell.exe -File recovery.ps1',
    recoveryDisplayIcon: 'powershell.exe,0',
  });

  assert.ok(plan.cleanupPaths.includes(profilePath));
  assert.ok(script.includes(profilePath), 'generated cleanup script contains the exact owned data path');
  assert.equal(plan.monitorLogPath, monitorLogPath);
  assert.ok(script.includes(monitorLogPath), 'generated cleanup targets only the Arc Power telemetry log folder');
  assert.match(script, /-Filter "monitor-\*\.txt"/);
  assert.match(script, /refusing to follow a reparse point at the telemetry log folder/);
  assert.ok(!plan.cleanupPaths.includes(appData), 'the parent AppData directory is never a cleanup target');
  assert.ok(!plan.cleanupPaths.includes(path.join(appData, 'OtherApp')));
  assert.ok(!plan.cleanupPaths.includes(documents), 'the Documents directory is never a cleanup target');
  assert.ok(!plan.cleanupPaths.includes(monitorLogPath), 'the telemetry folder is not recursively deleted with user files');
});

test('installation plan rejects an install path that overlaps durable ArcPower data', () => {
  assert.throws(() => makePlan({ installDir: profilePath }), /must not equal, contain, or be contained by/);
  assert.throws(() => makePlan({ installDir: monitorLogPath }), /must not overlap the Arc Power telemetry log path/);
});

test('successful cleanup removes its exact status files, while unsafe status paths are rejected', () => {
  const plan = makePlan();
  const scriptPath = path.join(path.resolve('test-fixtures', 'Temp'), 'arc-power-uninstall-1234-aabbccddeeff0011.ps1');
  const markerPath = `${scriptPath}.started.json`;
  const statusPath = `${scriptPath}.status.json`;
  const summaryPath = path.join(path.dirname(scriptPath), 'arc-power-uninstall-last.json');
  const script = createUninstallCleanupScript({
    pid: 1234, plan, scriptPath, markerPath, statusPath, summaryPath, attemptNonce: 'aabbccddeeff0011',
    recoveryCommand: 'powershell.exe -File recovery.ps1', recoveryDisplayIcon: 'powershell.exe,0',
  });
  assert.match(script, /Write-Status 'complete' 'Arc Power cleanup completed'[\s\S]*Remove-Item -LiteralPath \$statusPath[\s\S]*Remove-Item -LiteralPath \$summaryPath/);
  assert.throws(() => createUninstallCleanupScript({
    pid: 1234, plan, scriptPath, markerPath, statusPath: path.join(path.dirname(scriptPath), 'other.json'), summaryPath, attemptNonce: 'aabbccddeeff0011',
    recoveryCommand: 'powershell.exe -File recovery.ps1', recoveryDisplayIcon: 'powershell.exe,0',
  }), /exact uninstall status files/);
});

test('cleanup script refuses sibling or otherwise unowned targets', () => {
  const plan = makePlan();
  const unsafePlan = { ...plan, cleanupPaths: [...plan.cleanupPaths, path.join(appData, 'OtherApp')] };
  assert.throws(() => createUninstallCleanupScript({
    pid: 1234,
    plan: unsafePlan,
    scriptPath: path.join(path.resolve('test-fixtures', 'Temp'), 'arc-power-uninstall.ps1'),
    recoveryCommand: 'powershell.exe -File recovery.ps1',
    recoveryDisplayIcon: 'powershell.exe,0',
  }), /exact Arc Power owned targets/);

  const unsafeProfilePlan = { ...plan, profilePath: path.join(appData, 'OtherApp') };
  assert.throws(() => createUninstallCleanupScript({
    pid: 1234,
    plan: unsafeProfilePlan,
    scriptPath: path.join(path.resolve('test-fixtures', 'Temp'), 'arc-power-uninstall.ps1'),
    recoveryCommand: 'powershell.exe -File recovery.ps1',
    recoveryDisplayIcon: 'powershell.exe,0',
  }), /exact ArcPower directory under appDataPath/);
});

test('uninstall launcher handoff returns its confirmed helper marker', async () => {
  const source = await readFile(new URL('../src/main/installer.js', import.meta.url), 'utf8');
  const scheduler = source.slice(source.indexOf('async function scheduleUninstall('), source.indexOf('\nasync function uninstallArcPower('));
  assert.match(scheduler, /const handoff = await new Promise\([\s\S]*?\);\s*return handoff;/);
});
