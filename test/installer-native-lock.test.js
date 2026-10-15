import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('native Electron keeps product lock across setup userData selection and releases before child launch', {
  skip: process.platform !== 'win32', timeout: 45_000,
}, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'arc-power-installer-lock-test-'));
  const scriptPath = path.join(fixture, 'probe.cjs');
  const source = await readFile(new URL('../src/main/installer.js', import.meta.url), 'utf8');
  const guard = source.slice(source.indexOf('export function createInstallerOperationGuard('), source.indexOf('\nlet withInstallerProductLock'))
    .replace(/^export /, '');
  const cacheModuleUrl = new URL('../src/main/cache-lifecycle.js', import.meta.url).href;
  const environment = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_APP_FILENAME']) delete environment[key];
  const script = `
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fixture = process.argv[2];
const contender = process.argv[3] === 'contender';
const productPath = path.join(fixture, 'arc-power');
const sessionPath = path.join(fixture, 'setup-session');
fs.mkdirSync(productPath, { recursive: true });
fs.mkdirSync(sessionPath, { recursive: true });
app.disableHardwareAcceleration();
app.setPath('userData', productPath);
${guard}
const run = createInstallerOperationGuard({ waitForParentExit: async () => {} });
if (contender) {
  const acquired = app.requestSingleInstanceLock();
  if (acquired) app.releaseSingleInstanceLock();
  app.exit(acquired ? 0 : 23);
} else {
  app.setPath('userData', sessionPath);
  const runContender = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, fixture, 'contender'], { env: process.env, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('exit', resolve);
  });
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    try {
      await run({}, async ({ activeLockPath }) => {
        assert.equal(app.getPath('userData'), sessionPath);
        assert.equal(await runContender(), 23, 'normal app is blocked during operation');
        fs.writeFileSync(path.join(productPath, 'stale-cache'), 'fixture');
        const { prepareArcPowerCacheSync } = await import(${JSON.stringify(cacheModuleUrl)});
        prepareArcPowerCacheSync(fixture, '1.2.3', { forceReset: true, activeLockPath });
        assert.deepEqual(fs.readdirSync(productPath), ['lockfile']);
        assert.equal(await runContender(), 23, 'clearing legacy cache children does not release native lock');
      });
      assert.equal(win.isDestroyed(), false, 'setup UI remains alive');
      assert.equal(await runContender(), 0, 'normal app can acquire product lock after release');
      process.stdout.write('NATIVE_INSTALLER_LOCK_HANDOFF_OK\\n');
      app.exit(0);
    } catch (error) {
      process.stderr.write(String(error.stack || error));
      app.exit(1);
    }
  });
}
`;
  try {
    await writeFile(scriptPath, script, 'utf8');
    const electron = createRequire(import.meta.url)('electron');
    const result = await new Promise((resolve, reject) => {
      const child = spawn(electron, [scriptPath, fixture, 'holder'], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (data) => { output += data; });
      child.stderr.on('data', (data) => { output += data; });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Native fixture timed out: ${output}`)); }, 35_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
    });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /NATIVE_INSTALLER_LOCK_HANDOFF_OK/);
  } finally {
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
