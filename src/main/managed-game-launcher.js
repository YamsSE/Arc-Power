import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { canonicalExePath } from './game-candidate.js';

export function quoteWindowsArgument(value) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw new TypeError('Invalid launch argument');
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

export function encodeManagedLaunchRequest({ exePath, cwd, args = [], runtimePath, runtimeHash, steamId = '' }) {
  if (![exePath, cwd, runtimePath].every((v) => typeof v === 'string' && path.win32.isAbsolute(v) && !/[\0\r\n]/.test(v))
    || !Array.isArray(args) || args.length > 32 || !/^[A-Fa-f0-9]{64}$/.test(runtimeHash)
    || typeof steamId !== 'string' || !/^[0-9]{0,16}$/.test(steamId)) throw new TypeError('Invalid managed launch request');
  const commandLine = [exePath, ...args].map(quoteWindowsArgument).join(' ');
  const fields = [exePath, cwd, commandLine, runtimePath, steamId, runtimeHash.toUpperCase()];
  const header = Buffer.alloc(8); header.writeUInt32LE(0x314c5341, 0); header.writeUInt32LE(fields.length, 4);
  const parts = [header];
  for (const value of fields) {
    if (value.length > 32767) throw new TypeError('Launch request field is too long');
    const length = Buffer.alloc(4); length.writeUInt32LE(value.length); parts.push(length, Buffer.from(value, 'utf16le'));
  }
  const request = Buffer.concat(parts);
  if (request.length > 131072) throw new TypeError('Launch request is too large');
  return request;
}

function pinnedBytes(file, expected) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Managed runtime artifact is not a regular file');
  const bytes = fs.readFileSync(file);
  if (createHash('sha256').update(bytes).digest('hex').toUpperCase() !== expected.toUpperCase()) throw new Error('Managed runtime artifact failed its integrity check');
  return bytes;
}

const CONFIG = `[GENERAL]\nEffectSearchPaths=.\\ArcPowerSharpening\nIntermediateCachePath=.\\Cache\nNoDebugInfo=1\nNoEffectCache=0\nPerformanceMode=0\nPresetPath=.\\ArcPowerSharpening\\preset.ini\nStartupPresetPath=.\\ArcPowerSharpening\\preset.ini\nSkipLoadingDisabledEffects=0\n[INPUT]\nInputProcessing=0\nKeyOverlay=0,0,0,0\nKeyReload=0,0,0,0\nKeyScreenshot=0,0,0,0\n[OVERLAY]\nShowFPS=0\nShowFrameTime=0\nShowClock=0\nShowPresetName=0\n`;
const PRESET = 'Techniques=\nTechniqueSorting=ArcPowerSharpen@ArcPowerSharpen.fx\n[ArcPowerSharpen.fx]\nSharpness=0.0\n';

export function resolveManagedGameLaunchContext(exePath) {
  let cwd = path.win32.dirname(exePath);
  let args = [];
  let steamId = '';
  const steam = /^(.*\\steamapps)\\common\\([^\\]+)(?:\\|$)/i.exec(exePath);
  if (steam) {
    const installRoot = path.win32.join(steam[1], 'common', steam[2]);
    const unreal = /^([^\\]+)\\Binaries\\Win64\\[^\\]+-Win64-Shipping\.exe$/i.exec(path.win32.relative(installRoot, exePath));
    if (unreal) { cwd = installRoot; args = [unreal[1]]; }
    for (const name of fs.readdirSync(steam[1]).filter((v) => /^appmanifest_[0-9]+\.acf$/i.test(v)).slice(0, 1024)) {
      const file = path.win32.join(steam[1], name);
      try {
        if (fs.statSync(file).size > 524288) continue;
        const text = fs.readFileSync(file, 'utf8');
        if (text.match(/"installdir"\s+"([^"\r\n]+)"/i)?.[1]?.toLowerCase() === steam[2].toLowerCase()) {
          steamId = text.match(/"appid"\s+"([0-9]{1,16})"/i)?.[1] ?? ''; break;
        }
      } catch { /* An unrelated launcher's manifest can disappear while scanning. */ }
    }
  }
  return { cwd, args, steamId };
}

/** Explicit game launch only. The native helper lowers to Explorer's normal user before creating the game. */
export function createManagedGameLauncher({ dir, launcherPath, launcherHash, runtimePath, runtimeHash,
  shaderPath, shaderHash, isGameExecutable, resolveLaunch = resolveManagedGameLaunchContext,
  spawn = nodeSpawn, launchTimeoutMs = 25000 } = {}) {
  if (!path.isAbsolute(dir ?? '') || typeof isGameExecutable !== 'function') throw new TypeError('Managed launcher requires an AppData directory and game catalog');
  let launching = false;
  return {
    ready() {
      try { pinnedBytes(launcherPath, launcherHash); pinnedBytes(runtimePath, runtimeHash); pinnedBytes(shaderPath, shaderHash); return true; }
      catch { return false; }
    },
    async launch(exePath) {
      if (launching) throw new Error('A managed game launch is already in progress');
      const key = canonicalExePath(exePath);
      if (!key || !await isGameExecutable(key)) throw new Error('Choose a recognized game from Game Profiles');
      launching = true;
      try {
        pinnedBytes(launcherPath, launcherHash);
        const dll = pinnedBytes(runtimePath, runtimeHash);
        const shader = pinnedBytes(shaderPath, shaderHash);
        const context = await resolveLaunch(exePath);
        const runs = path.join(dir, 'managed-sharpening'); fs.mkdirSync(runs, { recursive: true });
        const runDir = path.join(runs, randomUUID()); fs.mkdirSync(runDir);
        const effects = path.join(runDir, 'ArcPowerSharpening'); fs.mkdirSync(effects);
        const stagedDll = path.join(runDir, 'ReShade64.dll'); fs.writeFileSync(stagedDll, dll, { flag: 'wx' });
        fs.writeFileSync(path.join(effects, 'ArcPowerSharpen.fx'), shader, { flag: 'wx' });
        fs.writeFileSync(path.join(effects, 'preset.ini'), PRESET, { flag: 'wx' });
        fs.writeFileSync(path.join(runDir, 'ReShade.ini'), CONFIG, { flag: 'wx' });
        const requestPath = path.join(runDir, 'launch.bin');
        fs.writeFileSync(requestPath, encodeManagedLaunchRequest({ exePath, cwd: context.cwd,
          args: context.args ?? [], steamId: context.steamId ?? '', runtimePath: stagedDll, runtimeHash }), { flag: 'wx' });
        const child = spawn(launcherPath, ['--launch', requestPath], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        let spawnError = null, exited = false, exitCode = null;
        child.stderr?.on('data', () => {});
        child.on('error', (error) => { spawnError = error; });
        child.on('exit', (code) => { exited = true; exitCode = code; });
        const deadline = Date.now() + launchTimeoutMs;
        const responsePath = `${requestPath}.result.json`;
        while (Date.now() < deadline) {
          if (spawnError) throw spawnError;
          if (fs.existsSync(responsePath)) {
            const stat = fs.lstatSync(responsePath);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('Invalid game launch response');
            let result;
            try { result = JSON.parse(fs.readFileSync(responsePath, 'utf8')); } catch { await new Promise((r) => setTimeout(r, 50)); continue; }
            if (result.ok !== true) throw new Error(result.pid
              ? `The game was started, but sharpening could not attach (Windows ${result.win32 ?? 'unknown'}). Close the game before retrying.`
              : `The game could not be launched with sharpening (${result.error ?? 'unknown error'}).`);
            if (!Number.isInteger(result.pid) || result.pid < 1 || !/^[1-9][0-9]*$/.test(result.creationFiletime)
              || canonicalExePath(result.exePath) !== key || result.integrity !== 8192 || result.injected !== true || result.resumed !== true) throw new Error('Game launch identity could not be verified');
            return { pid: result.pid, creationFiletime: result.creationFiletime, exePath: result.exePath, runtimeDirectory: runDir };
          }
          if (exited && exitCode !== 0) throw new Error(`Managed game launcher exited (${exitCode})`);
          await new Promise((r) => setTimeout(r, 50));
        }
        try { if (!exited) child.kill(); } catch { /* Only the owned launcher is stopped; the game is left alive. */ }
        throw new Error('The managed game launch timed out. Check whether the game started before retrying.');
      } finally { launching = false; }
    },
  };
}
