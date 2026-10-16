import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalExePath, validateSafeGameCandidate } from './game-candidate.js';
import { createReShadeRuntimeProvider, RESHADE_DLL_SHA256 } from './sharpening-runtime.js';

const DEFAULT = Object.freeze({ enabled: false, percentage: 50 });
const MANIFEST = 'reshade-managed-games.json';
const SETTINGS = 'postprocess-sharpening.json';
const SHADER_SOURCE = fileURLToPath(new URL('./shaders/ArcPowerSharpen.fx', import.meta.url));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function validateValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.enabled !== 'boolean' || !Number.isInteger(value.percentage)
    || value.percentage < 0 || value.percentage > 100
    || Object.keys(value).some((key) => !['enabled', 'percentage'].includes(key))) {
    throw new TypeError('Sharpening must be { enabled: boolean, percentage: integer 0-100 }.');
  }
  return { enabled: value.enabled, percentage: value.percentage };
}

function atomicJson(file, value) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('Sharpening data file is linked; refusing to trust it.');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function parsePe64(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(64);
    if (fs.readSync(fd, head, 0, head.length, 0) !== head.length || head.toString('ascii', 0, 2) !== 'MZ') return false;
    const peOffset = head.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > 16 * 1024 * 1024) return false;
    const pe = Buffer.alloc(26);
    if (fs.readSync(fd, pe, 0, pe.length, peOffset) !== pe.length) return false;
    return pe.readUInt32LE(0) === 0x00004550 && pe.readUInt16LE(4) === 0x8664 && pe.readUInt16LE(24) === 0x20b;
  } finally { fs.closeSync(fd); }
}

function hasReparseAncestor(target, fsApi = fs) {
  let current = path.dirname(target);
  for (;;) {
    const stat = fsApi.lstatSync(current);
    if (stat.isSymbolicLink()) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function encodedCommand(script) { return Buffer.from(script, 'utf16le').toString('base64'); }

const FILE_VERSION_COMMAND = encodedCommand('$v=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:RID_ARC_SHARPEN_TARGET); if ($v.ProductName -match "(?i)OptiScaler") { "OPTISCALER" } else { "OTHER" }');
const RUNNING_PROCESS_COMMAND = encodedCommand('try { $p=Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $_.Name -ieq $env:RID_ARC_SHARPEN_BASENAME }; if ($p) { "RUNNING" } else { "CLEAR" } } catch { exit 2 }');

function defaultProcessRunner(executable, args, options) {
  return new Promise((resolve) => {
    execFile(executable, args, options, (error, stdout, stderr) => {
      const code = Number.isInteger(error?.code) ? error.code : null;
      resolve({ status: error ? code : 0, error: error ?? null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

export async function detectOptiScaler(dllPath, processRunner = defaultProcessRunner) {
  if (process.platform !== 'win32') return false;
  // The static script reads version metadata; the target path is supplied only as environment data.
  const result = await processRunner('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', FILE_VERSION_COMMAND], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true,
    env: { ...process.env, RID_ARC_SHARPEN_TARGET: dllPath },
  });
  return !result.error && result.status === 0 && result.stdout.trim() === 'OPTISCALER';
}

async function isWindowsProcessRunning(exePath, processRunner = defaultProcessRunner) {
  if (process.platform !== 'win32') return true;
  const basename = path.basename(exePath);
  const result = await processRunner('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', RUNNING_PROCESS_COMMAND], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true,
    env: { ...process.env, RID_ARC_SHARPEN_BASENAME: basename },
  });
  if (result.error || result.status !== 0) return true;
  if (result.stdout.trim() === 'CLEAR') return false;
  return true;
}

function makeIni() {
  return `[GENERAL]\r\nEffectSearchPaths=.\\ArcPowerSharpening\r\nPresetPath=.\\ArcPowerSharpening\\preset.ini\r\nStartupPresetPath=.\\ArcPowerSharpening\\preset.ini\r\nPerformanceMode=0\r\n\r\n[OVERLAY]\r\nTutorialProgress=4\r\n\r\n[INPUT]\r\n\r\n`;
}

function makePreset(value) {
  const active = value.enabled && value.percentage > 0;
  return `Techniques=${active ? 'ArcPowerSharpen@ArcPowerSharpen.fx' : ''}\r\n\r\n[ArcPowerSharpen.fx]\r\nSharpness=${(value.percentage / 100).toFixed(2)}\r\n`;
}

function patchLoadReshade(bytes) {
  const text = bytes.toString('latin1');
  const lines = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter((line) => line.length);
  let section = '';
  let found = false;
  const patched = lines.map((line) => {
    const body = line.replace(/[\r\n]+$/, '');
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(body);
    if (header) section = header[1].trim().toLowerCase();
    if (section === 'plugins' && /^\s*LoadReshade\s*=/i.test(body)) {
      if (found) throw new Error('OptiScaler.ini has duplicate LoadReshade entries.');
      found = true;
      const setting = /^(\s*LoadReshade\s*=\s*)(.*)$/i.exec(body);
      const tail = setting[2];
      const commentAt = tail.search(/[;#]/);
      const beforeComment = commentAt < 0 ? tail : tail.slice(0, commentAt);
      const suffix = commentAt < 0 ? '' : tail.slice(commentAt);
      const trailingWhitespace = /\s*$/.exec(beforeComment)[0];
      return `${setting[1]}true${trailingWhitespace}${suffix}${line.slice(body.length)}`;
    }
    return line;
  });
  if (!found) throw new Error('OptiScaler.ini has no [Plugins] LoadReshade setting to enable.');
  return { original: bytes, patched: Buffer.from(patched.join(''), 'latin1') };
}

function hashFile(file) { return sha256(fs.readFileSync(file)); }
function verifyOwnedFile(file, expected, info, fsApi = fs) {
  assertOwnedPath(info, file, fsApi);
  const stat = fsApi.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || hashFile(file) !== expected) {
    throw new Error('An Arc Power managed sharpening file was modified, linked, or removed; refusing to write it.');
  }
}

function isWithin(target, root) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function atomicOwnedReplace(file, expected, content, info, fsApi) {
  const temp = path.join(path.dirname(file), `.arcpower-sharpen-${randomUUID()}.tmp`);
  let handle;
  try {
    assertOwnedPath(info, file, fsApi, { allowMissing: false });
    verifyOwnedFile(file, expected, info, fsApi);
    handle = fsApi.openSync(temp, 'wx', 0o600);
    fsApi.writeFileSync(handle, content);
    fsApi.fsyncSync(handle);
    fsApi.closeSync(handle); handle = undefined;
    assertOwnedPath(info, file, fsApi, { allowMissing: false });
    verifyOwnedFile(file, expected, info, fsApi);
    const backup = `${temp}.bak`;
    fsApi.renameSync(file, backup);
    if (hashFile(backup) !== expected) {
      try { fsApi.renameSync(backup, file); } catch { /* keep the backup if a replacement appeared */ }
      throw new Error('An Arc Power managed sharpening file changed during its update.');
    }
    try { fsApi.linkSync(temp, file); fsApi.unlinkSync(temp); }
    catch (error) {
      try { if (fsApi.existsSync(file) && hashFile(file) === sha256(content)) fsApi.unlinkSync(file); } catch { /* leave recoverable files in place */ }
      try { if (!fsApi.existsSync(file)) fsApi.renameSync(backup, file); } catch { /* preserve backup */ }
      throw error;
    }
    try { fsApi.unlinkSync(backup); } catch { /* the backup is retained if cleanup is blocked */ }
    return sha256(content);
  } catch (error) {
    if (handle !== undefined) { try { fsApi.closeSync(handle); } catch { /* best effort */ } }
    try { if (fsApi.existsSync(temp)) fsApi.unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}

function createOwnedFile(info, file, content, fsApi) {
  assertOwnedPath(info, file, fsApi, { allowMissing: true });
  const temp = path.join(path.dirname(file), `.arcpower-sharpen-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = fsApi.openSync(temp, 'wx', 0o600);
    fsApi.writeFileSync(handle, content);
    fsApi.fsyncSync(handle);
    fsApi.closeSync(handle); handle = undefined;
    assertOwnedPath(info, file, fsApi, { allowMissing: true });
    fsApi.linkSync(temp, file);
    fsApi.unlinkSync(temp);
  } catch (error) {
    if (handle !== undefined) { try { fsApi.closeSync(handle); } catch { /* best effort */ } }
    try { if (fsApi.existsSync(temp)) fsApi.unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}

function assertOwnedPath(info, target, fsApi, { allowMissing = false } = {}) {
  const absolute = path.resolve(target);
  if (!isWithin(absolute, info.dir) || hasReparseAncestor(info.exePath, fsApi)) throw new Error('Managed game paths changed or contain a reparse point.');
  const gameReal = fsApi.realpathSync(info.dir);
  if (path.resolve(gameReal).toLowerCase() !== path.resolve(info.dir).toLowerCase()) throw new Error('Managed game directory changed.');
  let current = path.dirname(absolute);
  const dirs = [];
  while (isWithin(current, info.dir)) {
    dirs.push(current);
    if (path.resolve(current).toLowerCase() === path.resolve(info.dir).toLowerCase()) break;
    current = path.dirname(current);
  }
  for (const dir of dirs.reverse()) {
    try {
      const stat = fsApi.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(fsApi.realpathSync(dir)).toLowerCase() !== path.resolve(dir).toLowerCase()) throw new Error('Managed game paths changed or contain a reparse point.');
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  try {
    const stat = fsApi.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || path.resolve(fsApi.realpathSync(absolute)).toLowerCase() !== absolute.toLowerCase()) throw new Error('Managed game file is linked or redirected.');
    if (allowMissing) throw new Error('A managed destination unexpectedly already exists.');
  } catch (error) {
    if (!allowMissing || error.code !== 'ENOENT') throw error;
  }
}

export function createPostprocessSharpening({
  dir,
  runtimeProvider,
  validateTarget = (value) => validateSafeGameCandidate(value, { requireExists: true }),
  isRunning,
  optiScalerDetector = detectOptiScaler,
  shaderPath = SHADER_SOURCE,
  fsImpl = fs,
  expectedRuntimeSha256 = RESHADE_DLL_SHA256,
  processRunner = defaultProcessRunner,
  protectedRoots = [process.env.SystemRoot, process.env.WINDIR, process.resourcesPath, path.dirname(process.execPath)].filter(Boolean),
} = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new TypeError('An absolute AppData directory is required.');
  const appDir = dir;
  const configPath = path.join(appDir, SETTINGS);
  const manifestPath = path.join(appDir, MANIFEST);
  const runtime = runtimeProvider ?? createReShadeRuntimeProvider();
  const running = isRunning ?? ((exePath) => isWindowsProcessRunning(exePath, processRunner));
  let queue = Promise.resolve();
  const serial = (fn) => { const result = queue.then(fn, fn); queue = result.catch(() => {}); return result; };

  const readConfig = () => {
    const raw = readJson(configPath, {});
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => !['global', 'games'].includes(key))) throw new Error('Sharpening settings file is invalid.');
    const global = validateValue(raw.global ?? DEFAULT);
    const games = raw.games && typeof raw.games === 'object' && !Array.isArray(raw.games) ? raw.games : {};
    if (Object.hasOwn(raw, 'games') && (!raw.games || typeof raw.games !== 'object' || Array.isArray(raw.games))) throw new Error('Sharpening game overrides are invalid.');
    for (const [exePath, value] of Object.entries(games)) {
      if (canonicalExePath(exePath) !== exePath.toLowerCase()) throw new Error('Sharpening game override identity is invalid.');
      validateValue(value);
    }
    return { global, games };
  };
  const readManifest = () => {
    const raw = readJson(manifestPath, {});
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Sharpening ownership manifest is invalid.');
    for (const [key, entry] of Object.entries(raw)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || canonicalExePath(entry.exePath) !== key || entry.exePath.toLowerCase() !== key || !['direct', 'optiscaler'].includes(entry.mode)) throw new Error('Sharpening ownership record is invalid.');
      const gameDir = path.dirname(entry.exePath);
      const runtimeName = entry.mode === 'direct' ? 'dxgi.dll' : 'ReShade64.dll';
      const expectedPaths = [path.join(gameDir, runtimeName), path.join(gameDir, 'ReShade.ini'), path.join(gameDir, 'ArcPowerSharpening', 'ArcPowerSharpen.fx'), path.join(gameDir, 'ArcPowerSharpening', 'preset.ini')];
      const owned = entry.ownedFiles;
      if (!owned || typeof owned !== 'object' || Array.isArray(owned)) throw new Error('Sharpening ownership record is invalid.');
      const actualPaths = Object.keys(owned).map((item) => path.resolve(item).toLowerCase()).sort();
      if (actualPaths.join('\n') !== expectedPaths.map((item) => path.resolve(item).toLowerCase()).sort().join('\n') || Object.values(owned).some((hash) => !/^[a-f0-9]{64}$/i.test(hash))) throw new Error('Sharpening ownership paths are invalid.');
      if (entry.mode === 'optiscaler') {
        const item = entry.optiScalerIni;
        if (!item || path.resolve(item.path).toLowerCase() !== path.resolve(path.join(gameDir, 'OptiScaler.ini')).toLowerCase()
          || !/^[a-f0-9]{64}$/i.test(item.originalSha256) || !/^[a-f0-9]{64}$/i.test(item.patchedSha256)
          || typeof item.original !== 'string' || sha256(Buffer.from(item.original, 'base64')) !== item.originalSha256) throw new Error('OptiScaler ownership record is invalid.');
      } else if (entry.optiScalerIni !== null) throw new Error('Direct ReShade ownership record is invalid.');
    }
    return raw;
  };
  const writeConfig = (value) => { fsImpl.mkdirSync(appDir, { recursive: true }); atomicJson(configPath, value); };
  const writeManifest = (value) => { fsImpl.mkdirSync(appDir, { recursive: true }); atomicJson(manifestPath, value); };

  function targetInfo(value) {
    const safe = validateTarget(value);
    if (!safe || typeof safe !== 'string' || !path.isAbsolute(safe)) throw new Error('The selected executable is not a safe game target.');
    const candidate = path.resolve(safe);
    if (protectedRoots.some((root) => isWithin(candidate, path.resolve(root)))) throw new Error('Windows system and Arc Power application paths cannot be sharpening targets.');
    const canonical = fsImpl.realpathSync(safe);
    if (path.resolve(canonical).toLowerCase() !== path.resolve(safe).toLowerCase() || hasReparseAncestor(canonical, fsImpl)) throw new Error('Game paths containing reparse points are not supported.');
    const stat = fsImpl.lstatSync(canonical);
    if (!stat.isFile() || stat.nlink > 1 || !parsePe64(canonical)) throw new Error('The selected target must be a standalone 64-bit Windows executable.');
    return { exePath: canonical, dir: path.dirname(canonical), key: canonical.toLowerCase() };
  }

  function targetIsMissing(exePath) {
    const dirs = [];
    let current = path.dirname(exePath);
    for (;;) {
      dirs.push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const dir of dirs.reverse()) {
      let stat;
      try { stat = fsImpl.lstatSync(dir); }
      catch (error) { if (error.code === 'ENOENT') return true; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(fsImpl.realpathSync(dir)).toLowerCase() !== path.resolve(dir).toLowerCase()) throw new Error('A managed game directory is redirected or inaccessible.');
    }
    try {
      const stat = fsImpl.lstatSync(exePath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1 || path.resolve(fsImpl.realpathSync(exePath)).toLowerCase() !== path.resolve(exePath).toLowerCase()) throw new Error('A managed game executable is redirected or linked.');
      return false;
    } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }

  function managedGameCounts(manifest) {
    let managedGameCount = 0;
    let staleGameCount = 0;
    for (const entry of Object.values(manifest)) {
      if (targetIsMissing(entry.exePath)) { staleGameCount++; continue; }
      targetInfo(entry.exePath);
      managedGameCount++;
    }
    return { managedGameCount, staleGameCount };
  }

  function currentGame(info, config, manifest) {
    const entry = manifest[info.key];
    const installed = Boolean(entry && entry.exePath?.toLowerCase() === info.key);
    const override = Object.hasOwn(config.games, info.key) ? validateValue(config.games[info.key]) : null;
    const effective = override ?? config.global;
    return { installed, value: { ...effective }, effective: { ...effective }, globalValue: { ...config.global }, override: override && { ...override }, mode: installed ? entry.mode : null };
  }

  async function getRuntimeReady() {
    try { return typeof runtime.isReady === 'function' ? runtime.isReady() === true : false; }
    catch { return false; }
  }

  async function getGlobal() {
    const config = readConfig();
    const manifest = readManifest();
    return { value: { ...config.global }, ...managedGameCounts(manifest), runtimeReady: await getRuntimeReady(), provider: 'reshade', requiresRestart: true };
  }

  async function inspect(exePath) {
    const info = targetInfo(exePath);
    return { info, config: readConfig(), manifest: readManifest() };
  }

  async function install(exePath) {
    return serial(async () => {
      const { info, config, manifest } = await inspect(exePath);
      if (await running(info.exePath)) throw new Error('Close the game before installing sharpening.');
      let entry = manifest[info.key];
      if (entry) return currentGame(info, config, manifest);

      const folder = path.join(info.dir, 'ArcPowerSharpening');
      const dxgi = path.join(info.dir, 'dxgi.dll');
      const reshade64 = path.join(info.dir, 'ReShade64.dll');
      const ini = path.join(info.dir, 'ReShade.ini');
      const optiIni = path.join(info.dir, 'OptiScaler.ini');
      const hasDxgi = fsImpl.existsSync(dxgi);
      const hasOptiIni = fsImpl.existsSync(optiIni);
      const mode = hasDxgi && hasOptiIni && await optiScalerDetector(dxgi, processRunner) ? 'optiscaler' : 'direct';
      if (mode === 'direct' && (hasDxgi || fsImpl.existsSync(reshade64) || hasOptiIni || fsImpl.existsSync(path.join(info.dir, 'd3d11.dll')) || fsImpl.existsSync(path.join(info.dir, 'd3d12.dll')))) {
        throw new Error('The game directory contains an existing graphics proxy or OptiScaler configuration; refusing to chain or replace it.');
      }
      if (mode === 'optiscaler' && fsImpl.existsSync(reshade64)) throw new Error('ReShade64.dll already exists; refusing to replace an unmanaged file.');
      if (mode === 'optiscaler' && (fsImpl.existsSync(path.join(info.dir, 'd3d11.dll')) || fsImpl.existsSync(path.join(info.dir, 'd3d12.dll')))) throw new Error('The game directory contains another graphics proxy; refusing to chain it.');
      if (fsImpl.existsSync(ini) || fsImpl.existsSync(folder)) throw new Error('ReShade.ini or ArcPowerSharpening already exists; refusing to overwrite unmanaged files.');
      const runtimeDll = await runtime();
      if (!Buffer.isBuffer(runtimeDll) || sha256(runtimeDll) !== expectedRuntimeSha256) throw new Error('The ReShade runtime failed its pinned integrity check.');
      const afterRuntime = targetInfo(exePath);
      if (afterRuntime.key !== info.key || await running(info.exePath)) throw new Error('The game target changed or started during runtime preparation.');
      if (fsImpl.existsSync(ini) || fsImpl.existsSync(folder)
        || (mode === 'direct' && fsImpl.existsSync(dxgi)) || (mode === 'optiscaler' && fsImpl.existsSync(reshade64))) {
        throw new Error('A ReShade destination appeared during runtime preparation; refusing to overwrite it.');
      }
      if (mode === 'direct' && (fsImpl.existsSync(optiIni) || fsImpl.existsSync(path.join(info.dir, 'd3d11.dll')) || fsImpl.existsSync(path.join(info.dir, 'd3d12.dll')))) throw new Error('A graphics proxy conflict appeared during runtime preparation.');
      if (mode === 'optiscaler' && (!fsImpl.existsSync(dxgi) || !await optiScalerDetector(dxgi, processRunner) || !fsImpl.existsSync(optiIni))) throw new Error('OptiScaler identity changed during runtime preparation.');
      const shader = fsImpl.readFileSync(shaderPath);
      const preset = Buffer.from(makePreset(config.games[info.key] ? validateValue(config.games[info.key]) : config.global));
      const files = mode === 'direct'
        ? [[dxgi, runtimeDll], [ini, Buffer.from(makeIni(DEFAULT))], [path.join(folder, 'ArcPowerSharpen.fx'), shader], [path.join(folder, 'preset.ini'), preset]]
        : [[reshade64, runtimeDll], [ini, Buffer.from(makeIni(DEFAULT))], [path.join(folder, 'ArcPowerSharpen.fx'), shader], [path.join(folder, 'preset.ini'), preset]];
      let optiOriginal;
      let optiPatched;
      if (mode === 'optiscaler') {
        const stat = fsImpl.lstatSync(optiIni);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('OptiScaler.ini is linked or is not a regular file; refusing to update it.');
        const patched = patchLoadReshade(fsImpl.readFileSync(optiIni));
        optiOriginal = patched.original;
        optiPatched = patched.patched;
      }
      // Recheck fixed targets and hard-link status immediately before writes.
      const again = targetInfo(exePath);
      if (again.key !== info.key || await running(info.exePath)) throw new Error('The game target changed or started during installation.');
      const created = [];
      const snapshots = new Map();
      let folderCreated = false;
      try {
        assertOwnedPath(info, path.join(folder, 'ArcPowerSharpen.fx'), fsImpl, { allowMissing: true });
        if (fsImpl.existsSync(folder)) throw new Error('ArcPowerSharpening appeared during runtime preparation.');
        fsImpl.mkdirSync(folder);
        folderCreated = true;
        for (const [file, content] of files) {
          assertOwnedPath(info, file, fsImpl, { allowMissing: true });
          createOwnedFile(info, file, content, fsImpl);
          created.push({ file, hash: sha256(content) });
        }
        if (mode === 'optiscaler') {
          snapshots.set(optiIni, optiOriginal);
          atomicOwnedReplace(optiIni, sha256(optiOriginal), optiPatched, info, fsImpl);
        }
        entry = {
          exePath: info.exePath, mode,
          ownedFiles: Object.fromEntries(files.map(([file]) => [file, hashFile(file)])),
          optiScalerIni: mode === 'optiscaler' ? { path: optiIni, originalSha256: sha256(optiOriginal), patchedSha256: sha256(optiPatched), original: optiOriginal.toString('base64') } : null,
        };
        const commitCheck = targetInfo(exePath);
        if (commitCheck.key !== info.key || await running(info.exePath)) throw new Error('The game target changed or started before installation could commit.');
        const next = { ...manifest, [info.key]: entry };
        writeManifest(next);
        return currentGame(info, config, next);
      } catch (error) {
        for (const item of created.reverse()) { try { verifyOwnedFile(item.file, item.hash, info, fsImpl); fsImpl.unlinkSync(item.file); } catch { /* preserve files that no longer match our write */ } }
        if (snapshots.has(optiIni)) { try { atomicOwnedReplace(optiIni, sha256(optiPatched), snapshots.get(optiIni), info, fsImpl); } catch { /* best effort guarded rollback */ } }
        if (folderCreated) { try { fsImpl.rmdirSync(folder); } catch { /* preserve any foreign files */ } }
        throw error;
      }
    });
  }

  async function setGlobal(value) {
    return serial(async () => {
      const clean = validateValue(value);
      const config = readConfig();
      const manifest = readManifest();
      // Update only preset files owned by games that inherit the global setting.
      const changed = [];
      let configWritten = false;
      try {
        for (const entry of Object.values(manifest)) {
          if (Object.hasOwn(config.games, entry.exePath.toLowerCase())) continue;
          if (targetIsMissing(entry.exePath)) continue;
          const managedInfo = targetInfo(entry.exePath);
          const presetPath = path.join(path.dirname(entry.exePath), 'ArcPowerSharpening', 'preset.ini');
          if (!entry.ownedFiles?.[presetPath]) continue;
          assertOwnedPath(managedInfo, presetPath, fsImpl);
          verifyOwnedFile(presetPath, entry.ownedFiles[presetPath], managedInfo, fsImpl);
          const old = fsImpl.readFileSync(presetPath);
          const updated = Buffer.from(makePreset(clean));
          const change = { presetPath, old, entry, info: managedInfo, hash: sha256(updated) };
          changed.push(change);
          atomicOwnedReplace(presetPath, entry.ownedFiles[presetPath], updated, managedInfo, fsImpl);
        }
        for (const item of changed) item.entry.ownedFiles[item.presetPath] = item.hash;
        writeConfig({ ...config, global: clean });
        configWritten = true;
        if (changed.length) writeManifest(manifest);
      } catch (error) {
        for (const item of changed.reverse()) { try { atomicOwnedReplace(item.presetPath, item.hash, item.old, item.info, fsImpl); } catch { /* best effort guarded rollback */ } }
        if (configWritten) { try { writeConfig(config); } catch { /* best effort settings rollback */ } }
        throw error;
      }
      return { value: clean, ...managedGameCounts(manifest), runtimeReady: await getRuntimeReady(), provider: 'reshade', requiresRestart: true };
    });
  }

  async function getGame(exePath) {
    const { info, config, manifest } = await inspect(exePath);
    return currentGame(info, config, manifest);
  }

  async function setGame(exePath, value) {
    return serial(async () => {
      const { info, config, manifest } = await inspect(exePath);
      if (!manifest[info.key]) throw new Error('Install sharpening for this game before changing its override.');
      const nextGames = { ...config.games };
      if (value === null) delete nextGames[info.key];
      else nextGames[info.key] = validateValue(value);
      const nextConfig = { ...config, games: nextGames };
      const effective = nextGames[info.key] ?? config.global;
      const entry = manifest[info.key];
      const presetPath = path.join(path.dirname(info.exePath), 'ArcPowerSharpening', 'preset.ini');
      if (!entry.ownedFiles?.[presetPath]) throw new Error('The owned sharpening preset was modified externally.');
      assertOwnedPath(info, presetPath, fsImpl);
      verifyOwnedFile(presetPath, entry.ownedFiles[presetPath], info, fsImpl);
      const old = fsImpl.readFileSync(presetPath);
      const updated = Buffer.from(makePreset(effective));
      let configWritten = false;
      try {
        atomicOwnedReplace(presetPath, entry.ownedFiles[presetPath], updated, info, fsImpl);
        entry.ownedFiles[presetPath] = sha256(updated);
        writeConfig(nextConfig);
        configWritten = true;
        writeManifest(manifest);
      } catch (error) {
        try { atomicOwnedReplace(presetPath, sha256(updated), old, info, fsImpl); } catch { /* best effort guarded rollback */ }
        if (configWritten) { try { writeConfig(config); } catch { /* best effort settings rollback */ } }
        throw error;
      }
      return currentGame(info, nextConfig, manifest);
    });
  }

  async function remove(exePath) {
    return serial(async () => {
      const { info, config, manifest } = await inspect(exePath);
      const entry = manifest[info.key];
      if (!entry) return currentGame(info, config, manifest);
      if (await running(info.exePath)) throw new Error('Close the game before removing sharpening.');
      const again = targetInfo(exePath);
      if (again.key !== info.key || await running(info.exePath)) throw new Error('The game target changed or started during removal.');
      for (const [file, expected] of Object.entries(entry.ownedFiles ?? {})) {
        if (!fsImpl.existsSync(file)) throw new Error('An Arc Power managed sharpening file was modified or removed; refusing cleanup.');
        assertOwnedPath(info, file, fsImpl);
        verifyOwnedFile(file, expected, info, fsImpl);
      }
      if (entry.optiScalerIni) {
        const item = entry.optiScalerIni;
        assertOwnedPath(info, item.path, fsImpl);
        const stat = fsImpl.lstatSync(item.path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('OptiScaler.ini is linked or redirected; refusing cleanup.');
        const current = fsImpl.readFileSync(item.path);
        if (sha256(current) !== item.patchedSha256) throw new Error('OptiScaler.ini changed after Arc Power installed; refusing to restore it.');
      }
      const removed = [];
      const backups = new Map(Object.keys(entry.ownedFiles ?? {}).map((file) => [file, fsImpl.readFileSync(file)]));
      const optiPatched = entry.optiScalerIni ? fsImpl.readFileSync(entry.optiScalerIni.path) : null;
      const next = { ...manifest }; delete next[info.key];
      const nextGames = { ...config.games }; delete nextGames[info.key];
      let configWritten = false;
      try {
        for (const [file, expected] of Object.entries(entry.ownedFiles ?? {})) {
          assertOwnedPath(info, file, fsImpl);
          verifyOwnedFile(file, expected, info, fsImpl);
          fsImpl.unlinkSync(file); removed.push(file);
        }
        if (entry.optiScalerIni) atomicOwnedReplace(entry.optiScalerIni.path, entry.optiScalerIni.patchedSha256, Buffer.from(entry.optiScalerIni.original, 'base64'), info, fsImpl);
        const commitCheck = targetInfo(exePath);
        if (commitCheck.key !== info.key || await running(info.exePath)) throw new Error('The game target changed or started before removal could commit.');
        writeConfig({ ...config, games: nextGames });
        configWritten = true;
        writeManifest(next);
        for (const folder of [path.join(info.dir, 'ArcPowerSharpening')]) { try { fsImpl.rmdirSync(folder); } catch { /* non-empty folder belongs to the user */ } }
        return currentGame(info, { ...config, games: nextGames }, next);
      } catch (error) {
        for (const file of removed.reverse()) {
          try { createOwnedFile(info, file, backups.get(file), fsImpl); } catch { /* rollback best effort */ }
        }
        if (entry.optiScalerIni && optiPatched) { try { atomicOwnedReplace(entry.optiScalerIni.path, entry.optiScalerIni.originalSha256, optiPatched, info, fsImpl); } catch { /* rollback best effort guarded rollback */ } }
        if (configWritten) { try { writeConfig(config); } catch { /* best effort settings rollback */ } }
        throw error;
      }
    });
  }

  return { getGlobal, setGlobal, getGame, install, setGame, remove };
}
