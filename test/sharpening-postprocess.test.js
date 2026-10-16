import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPostprocessSharpening, detectOptiScaler } from '../src/main/sharpening-postprocess.js';
import { createReShadeRuntimeProvider, RESHADE_DLL_SHA256 } from '../src/main/sharpening-runtime.js';

function tempDir() { return fs.mkdtempSync(path.join(process.env.TEMP ?? process.env.TMP ?? '.', 'arc-sharpening-')); }

function makeExe(file) {
  const data = Buffer.alloc(512);
  data.write('MZ', 0, 'ascii');
  data.writeUInt32LE(0x80, 0x3c);
  data.writeUInt32LE(0x00004550, 0x80);
  data.writeUInt16LE(0x8664, 0x84);
  data.writeUInt16LE(0x00f0, 0x94);
  data.writeUInt16LE(0x20b, 0x98);
  fs.writeFileSync(file, data);
  return file;
}

function fixture({ opti = false, fsImpl = fs, runtime = Buffer.from('verified-runtime-for-test') } = {}) {
  const root = tempDir();
  const gameDir = path.join(root, 'game');
  fs.mkdirSync(gameDir);
  const exePath = makeExe(path.join(gameDir, 'ExampleGame.exe'));
  const appData = path.join(root, 'appdata');
  if (opti) {
    fs.writeFileSync(path.join(gameDir, 'dxgi.dll'), 'external OptiScaler proxy');
    fs.writeFileSync(path.join(gameDir, 'OptiScaler.ini'), '[Plugins]\r\nLoadReshade=false ; keep comment\r\nOther=keep\r\n');
  }
  const service = createPostprocessSharpening({
    dir: appData,
    runtimeProvider: async () => runtime,
    validateTarget: () => exePath,
    optiScalerDetector: () => opti,
    isRunning: () => false,
    expectedRuntimeSha256: createHash('sha256').update(runtime).digest('hex'),
    protectedRoots: [],
    fsImpl,
  });
  return { root, gameDir, appData, exePath, service, runtime };
}

test('provider accepts exact enabled values at 0 and 100 and rejects malformed values', async () => {
  const { service, gameDir } = fixture();
  await service.install('ignored');
  assert.equal((await service.setGame('ignored', { enabled: true, percentage: 0 })).value.percentage, 0);
  assert.match(fs.readFileSync(path.join(gameDir, 'ArcPowerSharpening', 'preset.ini'), 'utf8'), /Techniques=\r\n/);
  assert.deepEqual((await service.setGame('ignored', { enabled: true, percentage: 100 })).value, { enabled: true, percentage: 100 });
  assert.match(fs.readFileSync(path.join(gameDir, 'ArcPowerSharpening', 'preset.ini'), 'utf8'), /Sharpness=1\.00/);
  await assert.rejects(service.setGame('ignored', { enabled: true, percentage: 100.5 }), /integer 0-100/);
  await assert.rejects(service.setGlobal({ enabled: false, percentage: -1 }), /integer 0-100/);
});

test('hard-linked executable targets are refused', async () => {
  const { exePath, root } = fixture();
  const linked = path.join(root, 'linked.exe');
  fs.linkSync(exePath, linked);
  const hardlinked = createPostprocessSharpening({
    dir: path.join(root, 'other-appdata'),
    runtimeProvider: async () => Buffer.from('unused'),
    validateTarget: () => linked,
    expectedRuntimeSha256: '0'.repeat(64),
  });
  await assert.rejects(hardlinked.install(linked), /standalone 64-bit/);
});

test('symlinked game directory is refused', async (t) => {
  const { service, gameDir, exePath, root } = fixture();
  const alias = path.join(root, 'alias');
  try { fs.symlinkSync(gameDir, alias, 'junction'); } catch { t.skip('directory symlink creation is unavailable'); return; }
  const linkedTarget = path.join(alias, path.basename(exePath));
  const linkedService = createPostprocessSharpening({
    dir: path.join(root, 'alias-appdata'),
    runtimeProvider: async () => Buffer.from('unused'),
    validateTarget: () => linkedTarget,
  });
  await assert.rejects(linkedService.install(linkedTarget), /reparse points/);
});

test('managed shader-folder junction blocks inherited global writes', async (t) => {
  const { service, gameDir, exePath, root } = fixture();
  await service.install('ignored');
  const ownedFolder = path.join(gameDir, 'ArcPowerSharpening');
  const savedFolder = path.join(gameDir, 'ArcPowerSharpening-owned');
  const redirectedFolder = path.join(root, 'redirected-shader-folder');
  fs.renameSync(ownedFolder, savedFolder);
  fs.mkdirSync(redirectedFolder);
  fs.copyFileSync(path.join(savedFolder, 'preset.ini'), path.join(redirectedFolder, 'preset.ini'));
  const outsidePreset = path.join(redirectedFolder, 'preset.ini');
  const before = fs.readFileSync(outsidePreset);
  try { fs.symlinkSync(redirectedFolder, ownedFolder, 'junction'); } catch { fs.renameSync(savedFolder, ownedFolder); t.skip('directory symlink creation is unavailable'); return; }
  try {
    await assert.rejects(service.setGlobal({ enabled: true, percentage: 95 }), /reparse point|redirected/);
    assert.deepEqual(fs.readFileSync(outsidePreset), before);
  } finally {
    fs.rmdirSync(ownedFolder);
    fs.renameSync(savedFolder, ownedFolder);
  }
  assert.equal((await service.getGame(exePath)).installed, true);
});

test('system and current application directories are refused before executable inspection', async () => {
  const appPath = path.dirname(process.execPath);
  const service = createPostprocessSharpening({
    dir: path.join(process.cwd(), 'temp-sharpening-settings'),
    validateTarget: () => process.execPath,
    protectedRoots: [appPath],
    runtimeProvider: async () => { throw new Error('must not fetch'); },
    isRunning: () => false,
  });
  await assert.rejects(service.install(process.execPath), /Windows system and Arc Power application paths/);
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const systemService = createPostprocessSharpening({
    dir: path.join(process.cwd(), 'temp-sharpening-settings-2'),
    validateTarget: () => path.join(systemRoot, 'System32', 'notepad.exe'),
    protectedRoots: [systemRoot],
    runtimeProvider: async () => { throw new Error('must not fetch'); },
    isRunning: () => false,
  });
  await assert.rejects(systemService.install('system-target'), /Windows system and Arc Power application paths/);
});

test('default running gate fails closed and passes only the basename as environment data', async () => {
  const { service, exePath, gameDir } = fixture();
  const guarded = createPostprocessSharpening({
    dir: path.join(path.dirname(gameDir), 'process-gate'),
    validateTarget: () => exePath,
    runtimeProvider: async () => { throw new Error('must not fetch'); },
    protectedRoots: [],
    processRunner: (_exe, args, options) => {
      assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
      assert.equal(args.includes(exePath), false);
      assert.equal(options.env.RID_ARC_SHARPEN_BASENAME, path.basename(exePath));
      assert.match(Buffer.from(args[3], 'base64').toString('utf16le'), /Get-CimInstance/);
      return { status: 0, stdout: 'RUNNING' };
    },
  });
  await assert.rejects(guarded.install(exePath), /Close the game/);
  const failedQuery = createPostprocessSharpening({
    dir: path.join(path.dirname(gameDir), 'process-gate-fail'),
    validateTarget: () => exePath,
    runtimeProvider: async () => { throw new Error('must not fetch'); },
    protectedRoots: [],
    processRunner: () => ({ status: 1, stdout: '' }),
  });
  await assert.rejects(failedQuery.install(exePath), /Close the game/);
  assert.equal((await service.getGame(exePath)).mode, null);
});

test('OptiScaler metadata query uses a fixed encoded command and environment path', async (t) => {
  if (process.platform !== 'win32') { t.skip('Windows FileVersionInfo is unavailable'); return; }
  const target = 'C:\\Temp\\dxgi.dll & throw "path text must not become code"';
  let called = false;
  assert.equal(await detectOptiScaler(target, (_exe, args, options) => {
    called = true;
    assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    assert.equal(args.includes(target), false);
    assert.equal(options.env.RID_ARC_SHARPEN_TARGET, target);
    assert.match(Buffer.from(args[3], 'base64').toString('utf16le'), /FileVersionInfo/);
    assert.match(Buffer.from(args[3], 'base64').toString('utf16le'), /RID_ARC_SHARPEN_TARGET/);
    return { status: 0, stdout: 'OPTISCALER' };
  }), true);
  assert.equal(called, true);
});

test('actual Palworld OptiScaler proxy is identified by version metadata without loading it', (t) => {
  const dll = 'D:\\SteamLibrary\\steamapps\\common\\Palworld\\Pal\\Binaries\\Win64\\dxgi.dll';
  if (process.platform !== 'win32' || !fs.existsSync(dll)) { t.skip('Palworld OptiScaler DLL is not installed on this host'); return; }
  return detectOptiScaler(dll).then((result) => assert.equal(result, true));
});

test('asynchronous process queries leave the event loop responsive', async () => {
  const { exePath, gameDir } = fixture();
  let queryFinished = false;
  const service = createPostprocessSharpening({
    dir: path.join(path.dirname(gameDir), 'async-process-gate'),
    validateTarget: () => exePath,
    runtimeProvider: async () => { throw new Error('must not fetch'); },
    protectedRoots: [],
    processRunner: async () => new Promise((resolve) => setTimeout(() => {
      queryFinished = true;
      resolve({ status: 0, stdout: 'RUNNING' });
    }, 40)),
  });
  let eventLoopAdvanced = false;
  const operation = service.install(exePath);
  setImmediate(() => { eventLoopAdvanced = true; });
  await assert.rejects(operation, /Close the game/);
  assert.equal(eventLoopAdvanced, true);
  assert.equal(queryFinished, true);
});

test('per-game override inherits global defaults and can return to inheritance', async () => {
  const { service } = fixture();
  await service.install('ignored');
  await service.setGlobal({ enabled: true, percentage: 73 });
  assert.deepEqual((await service.getGame('ignored')).value, { enabled: true, percentage: 73 });
  await service.setGame('ignored', { enabled: false, percentage: 21 });
  await service.setGlobal({ enabled: true, percentage: 88 });
  assert.deepEqual((await service.getGame('ignored')).value, { enabled: false, percentage: 21 });
  assert.deepEqual((await service.setGame('ignored', null)).value, { enabled: true, percentage: 88 });
  const global = await service.getGlobal();
  assert.equal(global.provider, 'reshade');
  assert.equal(global.requiresRestart, true);
  assert.equal(global.managedGameCount, 1);
});

test('existing unrecognized proxy is refused without modification', async () => {
  const { service, gameDir } = fixture();
  fs.writeFileSync(path.join(gameDir, 'dxgi.dll'), 'unrecognized proxy');
  await assert.rejects(service.install('ignored'), /existing graphics proxy/);
  assert.equal(fs.readFileSync(path.join(gameDir, 'dxgi.dll'), 'utf8'), 'unrecognized proxy');
});

test('a normal D3D12Core.dll does not block direct ReShade installation', async () => {
  const { service, gameDir } = fixture();
  fs.writeFileSync(path.join(gameDir, 'D3D12Core.dll'), 'Agility SDK runtime component');
  assert.equal((await service.install('ignored')).installed, true);
});

test('global defaults skip stale managed games and preserve their ownership record', async () => {
  const root = tempDir();
  const appData = path.join(root, 'appdata');
  const firstDir = path.join(root, 'first');
  const staleDir = path.join(root, 'stale');
  fs.mkdirSync(firstDir); fs.mkdirSync(staleDir);
  const firstExe = makeExe(path.join(firstDir, 'FirstGame.exe'));
  const staleExe = makeExe(path.join(staleDir, 'StaleGame.exe'));
  const targets = new Map([[firstExe.toLowerCase(), firstExe], [staleExe.toLowerCase(), staleExe]]);
  const runtime = Buffer.from('verified-runtime-for-stale-test');
  const service = createPostprocessSharpening({
    dir: appData,
    runtimeProvider: async () => runtime,
    validateTarget: (value) => targets.get(String(value).toLowerCase()) ?? null,
    isRunning: () => false,
    protectedRoots: [],
    expectedRuntimeSha256: createHash('sha256').update(runtime).digest('hex'),
  });
  await service.install(firstExe);
  await service.install(staleExe);
  const firstPreset = path.join(firstDir, 'ArcPowerSharpening', 'preset.ini');
  const stalePreset = path.join(staleDir, 'ArcPowerSharpening', 'preset.ini');
  const staleBefore = fs.readFileSync(stalePreset);
  fs.unlinkSync(staleExe);
  const result = await service.setGlobal({ enabled: true, percentage: 91 });
  assert.equal(result.managedGameCount, 1);
  assert.equal(result.staleGameCount, 1);
  assert.match(fs.readFileSync(firstPreset, 'utf8'), /Sharpness=0\.91/);
  assert.deepEqual(fs.readFileSync(stalePreset), staleBefore);
  const stored = JSON.parse(fs.readFileSync(path.join(appData, 'reshade-managed-games.json'), 'utf8'));
  assert.equal(Object.keys(stored).length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(appData, 'postprocess-sharpening.json'), 'utf8')).global, { enabled: true, percentage: 91 });
});

test('OptiScaler mode preserves proxy and restores only the original configuration on removal', async () => {
  const { service, gameDir } = fixture({ opti: true });
  const optiIni = path.join(gameDir, 'OptiScaler.ini');
  const original = fs.readFileSync(optiIni);
  assert.equal((await service.install('ignored')).mode, 'optiscaler');
  assert.match(fs.readFileSync(optiIni, 'utf8'), /LoadReshade=true/);
  assert.equal(fs.readFileSync(path.join(gameDir, 'dxgi.dll'), 'utf8'), 'external OptiScaler proxy');
  await service.remove('ignored');
  assert.deepEqual(fs.readFileSync(optiIni), original);
  assert.equal(fs.existsSync(path.join(gameDir, 'ReShade64.dll')), false);
});

test('remove refuses files whose content changed after installation', async () => {
  const { service, gameDir } = fixture();
  await service.install('ignored');
  const shader = path.join(gameDir, 'ArcPowerSharpening', 'ArcPowerSharpen.fx');
  fs.appendFileSync(shader, '// external edit\n');
  await assert.rejects(service.remove('ignored'), /modified, linked, or removed/);
  assert.equal(fs.existsSync(path.join(gameDir, 'dxgi.dll')), true);
});

test('failed second-file creation rolls back the first created file', async () => {
  let writes = 0;
  let gameDir;
  const failingFs = Object.create(fs);
  failingFs.openSync = (...args) => fs.openSync(...args);
  failingFs.writeFileSync = (target, ...args) => {
    if (typeof target === 'number' && ++writes === 2) {
      fs.writeFileSync(path.join(gameDir, 'ArcPowerSharpening', 'foreign.txt'), 'preserve me');
      throw new Error('injected second file failure');
    }
    return fs.writeFileSync(target, ...args);
  };
  failingFs.closeSync = (...args) => fs.closeSync(...args);
  const fixtureData = fixture({ fsImpl: failingFs });
  gameDir = fixtureData.gameDir;
  const { service } = fixtureData;
  await assert.rejects(service.install('ignored'), /injected second file failure/);
  assert.equal(fs.existsSync(path.join(gameDir, 'dxgi.dll')), false);
  assert.equal(fs.existsSync(path.join(gameDir, 'ReShade.ini')), false);
  assert.equal(fs.readFileSync(path.join(gameDir, 'ArcPowerSharpening', 'foreign.txt'), 'utf8'), 'preserve me');
});

test('runtime provider is offline and refuses missing or corrupt included binaries', async () => {
  const root = tempDir();
  const filePath = path.join(root, 'ArcPower.ReShade64.dll');
  const binary = Buffer.alloc(128, 65);
  const expectedSha256 = createHash('sha256').update(binary).digest('hex');
  const runtime = createReShadeRuntimeProvider({ filePath, expectedSha256 });
  assert.equal(runtime.isReady(), false);
  await assert.rejects(runtime(), /missing/);
  fs.writeFileSync(filePath, binary);
  assert.equal(runtime.isReady(), true);
  assert.deepEqual(await runtime(), binary);
  fs.writeFileSync(filePath, Buffer.alloc(128, 66));
  assert.equal(runtime.isReady(), false);
  await assert.rejects(runtime(), /integrity/);
  assert.equal(RESHADE_DLL_SHA256.length, 64);
});
