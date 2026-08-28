import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  createPortableHandoffScript,
  expectedAssetName,
  installedUpdateArguments,
  parseReleaseTag,
  selectReleaseAsset,
  validateDownloadedUpdatePath,
  validatePortableTargetPath,
  validateReleaseAssetUrl,
} from '../src/main/auto-update-pure.js';
import { createUpdateOperations } from '../src/main/auto-update-runtime.js';
import { createStartupUpdateCoordinator, shouldBlockStartupSplashClose } from '../src/main/startup-update.js';
import { createStartupUpdateHandoff } from '../src/main/startup-update-handoff.js';

const release = {
  tag_name: 'v1.0.6',
  assets: [
    {
      name: 'Arc-Power_Installer.exe',
      browser_download_url: 'https://github.com/YamsSE/Arc-Power/releases/download/v1.0.6/Arc-Power_Installer.exe',
    },
    {
      name: 'Arc-Power_Portable.exe',
      browser_download_url: 'https://github.com/YamsSE/Arc-Power/releases/download/v1.0.6/Arc-Power_Portable.exe',
    },
  ],
};

test('release tags and build-specific assets are parsed deterministically', () => {
  assert.equal(parseReleaseTag('v1.0.6'), '1.0.6');
  assert.equal(parseReleaseTag('1.0.6'), '1.0.6');
  assert.equal(parseReleaseTag('release-1.0.6'), null);
  assert.equal(expectedAssetName('installed'), 'Arc-Power_Installer.exe');
  assert.equal(expectedAssetName('portable'), 'Arc-Power_Portable.exe');
  assert.equal(expectedAssetName('dev'), null);
  assert.deepEqual(selectReleaseAsset(release, 'installed'), {
    assetName: 'Arc-Power_Installer.exe',
    assetUrl: release.assets[0].browser_download_url,
  });
  assert.deepEqual(selectReleaseAsset(release, 'portable'), {
    assetName: 'Arc-Power_Portable.exe',
    assetUrl: release.assets[1].browser_download_url,
  });
});

test('release asset validation rejects non-GitHub, non-HTTPS, wrong-repository, and wrong-name URLs', () => {
  const valid = release.assets[1].browser_download_url;
  assert.equal(validateReleaseAssetUrl(valid, 'Arc-Power_Portable.exe'), valid);
  assert.equal(validateReleaseAssetUrl('http://github.com/YamsSE/Arc-Power/releases/download/v1.0.6/Arc-Power_Portable.exe'), null);
  assert.equal(validateReleaseAssetUrl('https://example.com/Arc-Power_Portable.exe'), null);
  assert.equal(validateReleaseAssetUrl('https://github.com/other/project/releases/download/v1.0.6/Arc-Power_Portable.exe'), null);
  assert.equal(validateReleaseAssetUrl(valid, 'Arc-Power_Installer.exe'), null);
});

test('downloaded update paths stay inside the update temp folder and match the selected build', () => {
  const root = join(tmpdir(), 'arc-power-updates');
  const portable = join(root, 'Arc-Power_Portable.exe');
  const installer = join(root, 'Arc-Power_Installer.exe');
  assert.equal(validateDownloadedUpdatePath(portable, { buildKind: 'portable', tempDir: root }), portable);
  assert.equal(validateDownloadedUpdatePath(installer, { buildKind: 'installed', tempDir: root }), installer);
  assert.equal(validateDownloadedUpdatePath(installer, { buildKind: 'portable', tempDir: root }), null);
  assert.equal(validateDownloadedUpdatePath(join(root, 'nested', '..', 'Arc-Power_Portable.exe'), { buildKind: 'portable', tempDir: root }), portable);
  assert.equal(validateDownloadedUpdatePath(join(root, '..', 'Arc-Power_Portable.exe'), { buildKind: 'portable', tempDir: root }), null);
});

test('portable handoff validates the target and supports cross-volume replacement before relaunching', () => {
  const downloaded = join(tmpdir(), 'arc-power-updates', 'Arc-Power_Portable.exe');
  const target = join(tmpdir(), 'Arc Power', 'Arc-Power_Portable.exe');
  assert.equal(validatePortableTargetPath(target, downloaded), target);
  assert.equal(validatePortableTargetPath(downloaded, downloaded), null);
  assert.equal(validatePortableTargetPath('Arc-Power_Portable.exe', downloaded), null);

  const script = createPortableHandoffScript();
  assert.match(script, /Get-Process -Id \$ParentPid/);
  assert.match(script, /Copy-Item -LiteralPath \$DownloadedPath -Destination \$stagedPath -Force/);
  assert.match(script, /\[System\.IO\.File\]::Replace\(\$stagedPath, \$TargetPath/);
  assert.match(script, /Move-Item -LiteralPath \$stagedPath -Destination \$TargetPath -Force/);
  assert.match(script, /Test-Path -LiteralPath \$TargetPath -PathType Leaf/);
  assert.match(script, /Remove-Item -LiteralPath \$DownloadedPath -Force/);
  assert.match(script, /Start-Process -FilePath \$TargetPath/);
  assert.ok(script.indexOf('Copy-Item') < script.indexOf('Start-Process'));
  assert.ok(script.indexOf('Remove-Item -LiteralPath \$stagedPath') < script.indexOf('Start-Process'));
});

test('portable handoff script is self-contained after the parent exits', () => {
  const script = createPortableHandoffScript();
  assert.match(script, /while \(Get-Process -Id \$ParentPid -ErrorAction SilentlyContinue\)/);
  assert.match(script, /Start-Sleep -Milliseconds 250/);
  assert.match(script, /if \(-not \$moved\) \{[\s\S]*?exit 1[\s\S]*?\}/);
});

test('installed update handoff names the parent process and current install directory', () => {
  assert.deepEqual(installedUpdateArguments({
    parentPid: 2718,
    installDir: 'C:\\Users\\Tester\\AppData\\Local\\Programs\\Arc Power',
  }), [
    '--update',
    '--update-parent-pid',
    '2718',
    '--update-install-dir',
    'C:\\Users\\Tester\\AppData\\Local\\Programs\\Arc Power',
  ]);
  assert.throws(() => installedUpdateArguments({ parentPid: 0, installDir: 'C:\\Arc Power' }), /parent PID/);
  assert.throws(() => installedUpdateArguments({ parentPid: 1, installDir: 'Arc Power' }), /absolute/);
});

function fakeChild({ failure = null } = {}) {
  const child = new EventEmitter();
  child.unref = () => { child.unrefCalled = true; };
  queueMicrotask(() => child.emit(failure ? 'error' : 'spawn', failure ?? undefined));
  return child;
}

function fakeProcess(tempDir) {
  return {
    pid: 2718,
    execPath: 'C:\\Users\\Tester\\AppData\\Local\\Programs\\Arc Power\\Arc Power.exe',
    env: { SystemRoot: 'C:\\Windows' },
  };
}

test('injected downloader writes the selected asset and reports deterministic progress and failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-power-m98-download-'));
  try {
    const progress = [];
    const operations = createUpdateOperations({
      tempDirPath: root,
      appApi: { getVersion: () => '1.0.5', quit: () => {} },
      fetchResponse: async () => ({
        headers: new Headers({ 'content-length': '4' }),
        body: Readable.toWeb(Readable.from([Buffer.from('ab'), Buffer.from('cd')])),
      }),
    });
    const path = await operations.downloadUpdate(
      'https://github.com/YamsSE/Arc-Power/releases/download/v1.0.6/Arc-Power_Portable.exe',
      (percent) => progress.push(percent),
      'portable',
    );
    assert.equal(existsSync(path), true);
    assert.equal((await readFile(path, 'utf8')), 'abcd');
    assert.deepEqual(progress, [50, 100]);

    const failureOperations = createUpdateOperations({
      tempDirPath: root,
      appApi: { getVersion: () => '1.0.5', quit: () => {} },
      fetchResponse: async () => ({
        headers: new Headers({ 'content-length': '4' }),
        body: Readable.toWeb(new Readable({ read() { this.destroy(new Error('stream failed')); } })),
      }),
    });
    await assert.rejects(failureOperations.downloadUpdate(
      'https://github.com/YamsSE/Arc-Power/releases/download/v1.0.6/Arc-Power_Portable.exe',
      null,
      'portable',
    ), /stream failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('injected installed handoff waits for spawn, quits, and records spawn failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-power-m98-installed-'));
  try {
    const downloaded = join(root, 'Arc-Power_Installer.exe');
    await writeFile(downloaded, 'installer');
    const calls = [];
    const appApi = { quit: () => { calls.push('quit'); }, getVersion: () => '1.0.5' };
    const processApi = fakeProcess(root);
    const operations = createUpdateOperations({
      tempDirPath: root,
      appApi,
      processApi,
      spawnProcess: (file, args, options) => { calls.push({ file, args, options }); return fakeChild(); },
    });
    const result = await operations.installUpdate(downloaded, {
      buildKind: 'installed',
      onHandoffStarted: () => calls.push('handoff-started'),
    });
    assert.equal(result.kind, 'installed');
    assert.deepEqual(calls[0].args, ['--update', '--update-parent-pid', '2718', '--update-install-dir', 'C:\\Users\\Tester\\AppData\\Local\\Programs\\Arc Power']);
    assert.deepEqual(calls.slice(1), ['handoff-started', 'quit']);

    await rm(downloaded, { force: true });
    const failurePath = join(root, 'Arc-Power_Installer.exe');
    await writeFile(failurePath, 'installer');
    const failureOperations = createUpdateOperations({
      tempDirPath: root,
      appApi,
      processApi,
      spawnProcess: () => fakeChild({ failure: new Error('installer launch failed') }),
    });
    let failureHandoffStarted = 0;
    await assert.rejects(failureOperations.installUpdate(failurePath, {
      buildKind: 'installed',
      onHandoffStarted: () => { failureHandoffStarted += 1; },
    }), /installer launch failed/);
    assert.equal(failureHandoffStarted, 0, 'spawn failure must not mark the handoff started');
    assert.equal(calls.filter((call) => call === 'quit').length, 1, 'spawn failure must not request another quit');
    const diagnostic = await readFile(join(root, 'arc-power-update-2718.log'), 'utf8');
    assert.match(diagnostic, /installer spawn failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('injected portable handoff uses the validated wrapper target and records handoff spawn failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-power-m98-portable-'));
  try {
    const downloaded = join(root, 'Arc-Power_Portable.exe');
    const target = join(root, 'wrapper', 'Arc-Power_Portable.exe');
    await writeFile(downloaded, 'portable');
    await writeFile(target, 'target').catch(async () => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(root, 'wrapper'), { recursive: true });
      await writeFile(target, 'target');
    });
    const calls = [];
    const operations = createUpdateOperations({
      tempDirPath: root,
      appApi: { quit: () => calls.push('quit'), getVersion: () => '1.0.5' },
      processApi: fakeProcess(root),
      spawnProcess: (file, args) => { calls.push({ file, args }); return fakeChild(); },
    });
    const result = await operations.installUpdate(downloaded, {
      buildKind: 'portable',
      portableWrapperPath: target,
      onHandoffStarted: () => calls.push('handoff-started'),
    });
    assert.equal(result.kind, 'portable');
    assert.equal(result.targetPath, target);
    assert.equal(calls[0].args.includes('-TargetPath'), true);
    assert.equal(calls[0].args[calls[0].args.indexOf('-TargetPath') + 1], target);
    assert.deepEqual(calls.slice(1), ['handoff-started', 'quit']);

    const failureOperations = createUpdateOperations({
      tempDirPath: root,
      appApi: { quit: () => {}, getVersion: () => '1.0.5' },
      processApi: fakeProcess(root),
      spawnProcess: () => fakeChild({ failure: new Error('PowerShell launch failed') }),
    });
    let failureHandoffStarted = 0;
    await assert.rejects(failureOperations.installUpdate(downloaded, {
      buildKind: 'portable',
      portableWrapperPath: target,
      onHandoffStarted: () => { failureHandoffStarted += 1; },
    }), /PowerShell launch failed/);
    assert.equal(failureHandoffStarted, 0, 'spawn failure must not mark the handoff started');
    const diagnostic = await readFile(join(root, 'arc-power-update-2718.log'), 'utf8');
    assert.match(diagnostic, /portable handoff spawn failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('startup update marks the handoff before a real runtime quit closes the splash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-power-m98-ordering-'));
  try {
    const downloaded = join(root, 'Arc-Power_Installer.exe');
    await writeFile(downloaded, 'installer');
    const calls = [];
    let closePrevented = null;
    let completeCalls = 0;
    const coordinator = createStartupUpdateCoordinator({
      check: async () => ({ available: true, version: '1.0.6', assetUrl: 'https://example.invalid/update.exe' }),
    });
    const appApi = {
      getVersion: () => '1.0.5',
      quit: () => {
        calls.push('quit');
        closePrevented = shouldBlockStartupSplashClose({
          updatePending: coordinator.updatePending(),
          restartResolved: coordinator.restartResolved(),
          handoffStarted: coordinator.handoffStarted(),
          fatalSplashFailure: coordinator.fatalSplashFailed(),
        });
      },
    };
    const operations = createUpdateOperations({
      tempDirPath: root,
      appApi,
      processApi: fakeProcess(root),
      spawnProcess: () => {
        calls.push('spawn');
        return fakeChild();
      },
    });
    const handoff = createStartupUpdateHandoff({
      coordinator,
      buildKind: 'installed',
      downloadUpdate: async () => downloaded,
      installUpdate: (...args) => operations.installUpdate(...args),
      completeUpdate: () => { completeCalls += 1; return { ok: true, action: 'restart' }; },
    });

    await coordinator.start({ buildKind: 'installed' });
    const result = await handoff.updateNow();

    assert.deepEqual(result, {
      ok: true,
      action: 'restart-pending',
      handoff: {
        restarting: true,
        restartConfirmed: false,
        kind: 'installed',
        handoff: 'Arc-Power_Installer.exe',
        args: ['--update', '--update-parent-pid', '2718', '--update-install-dir', 'C:\\Users\\Tester\\AppData\\Local\\Programs\\Arc Power'],
        diagnosticPath: join(root, 'arc-power-update-2718.log'),
      },
    });
    assert.deepEqual(calls, ['spawn', 'quit']);
    assert.equal(closePrevented, false);
    assert.equal(completeCalls, 0);
    assert.equal(coordinator.handoffStarted(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
