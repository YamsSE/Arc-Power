import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalExePath } from './game-candidate.js';
import { inspectLegacySharpening } from './legacy-sharpening-audit.js';

const DEFAULT = Object.freeze({ enabled: false, percentage: 50 });
const DEFAULT_ASR = Object.freeze({ enabled: false });
const SETTINGS = 'postprocess-sharpening.json';
const WINDOW_SELECT_SECONDS = 5;
const IDLE_SCALE_COMMAND = 'SCALE 0 0 0 0';
const SOURCE_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sharpening-runtime', 'ArcPower.ScreenSharpen.exe');
export const SCREEN_SHARPENING_PAUSED_REASON = 'Arc Image Sharpening capture is unavailable on this system.';
export const SCREEN_ASR_PAUSED_REASON = 'Arc Super Resolution capture is unavailable on this system.';
// Pin the bundled native executable before spawning it from an elevated Portable.
const HELPER_SHA256 = 'B3A0252FB839013AF2D4BC7C884A1D79E2A67405F3131E61CB1DD5D12038709C';
const FSR_ASSETS = Object.freeze({
  'ArcPower.Fsr1.hlsl': '57E00E580F8AD852F1AAD9FC471842BB5586898CD1DD69058A9FB8AF7FB4EC07',
  'ffx_a.h': 'F60E2722FCD13989523B9164D776AB382B3692791767F3BF8BB19967F763F3FB',
  'ffx_fsr1.h': '93C3922362EA7FC99CBCC698CA30C98DE4F8C246D1FBB0B09E015DDEF38CE3A5',
});

function helperIntegrity(helperPath) {
  try {
    const stat = fs.lstatSync(helperPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return false;
    if (createHash('sha256').update(fs.readFileSync(helperPath)).digest('hex').toUpperCase() !== HELPER_SHA256) return false;
    const assetsDir = path.join(path.dirname(helperPath), 'fsr1');
    return Object.entries(FSR_ASSETS).every(([name, expectedHash]) => {
      const assetPath = path.join(assetsDir, name);
      const assetStat = fs.lstatSync(assetPath);
      return assetStat.isFile() && !assetStat.isSymbolicLink() && assetStat.nlink === 1
        && createHash('sha256').update(fs.readFileSync(assetPath)).digest('hex').toUpperCase() === expectedHash;
    });
  } catch { return false; }
}

function validateValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.enabled !== 'boolean' || !Number.isInteger(value.percentage)
    || value.percentage < 0 || value.percentage > 100
    || Object.keys(value).some((key) => !['enabled', 'percentage'].includes(key))) {
    throw new TypeError('Sharpening must be { enabled: boolean, percentage: integer 0-100 }.');
  }
  return { enabled: value.enabled, percentage: value.percentage };
}

function validateAsrValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.enabled !== 'boolean'
    || Object.keys(value).some((key) => key !== 'enabled')) {
    throw new TypeError('Arc Super Resolution must be { enabled: boolean }.');
  }
  return { enabled: value.enabled };
}

function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  try { fs.renameSync(temp, file); }
  catch (error) { try { fs.unlinkSync(temp); } catch { /* best effort */ } throw error; }
}

function readSettings(file) {
  let raw;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('Sharpening settings file is linked; refusing to trust it.');
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') raw = {};
    else throw error;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some((key) => !['global', 'games', 'asr', 'asrGames'].includes(key))) throw new Error('Screen post-processing settings file is invalid.');
  const global = validateValue(raw.global ?? DEFAULT);
  const asr = validateAsrValue(raw.asr ?? DEFAULT_ASR);
  const games = raw.games ?? {};
  if (!games || typeof games !== 'object' || Array.isArray(games)) throw new Error('Sharpening game overrides are invalid.');
  const cleanGames = {};
  for (const [key, value] of Object.entries(games)) {
    if (canonicalExePath(key) !== key) throw new Error('Sharpening game override identity is invalid.');
    cleanGames[key] = validateValue(value);
  }
  const asrGames = raw.asrGames ?? {};
  if (!asrGames || typeof asrGames !== 'object' || Array.isArray(asrGames)) throw new Error('ASR game overrides are invalid.');
  const cleanAsrGames = {};
  for (const [key, value] of Object.entries(asrGames)) {
    if (canonicalExePath(key) !== key) throw new Error('ASR game override identity is invalid.');
    cleanAsrGames[key] = validateAsrValue(value);
  }
  return { global, games: cleanGames, asr, asrGames: cleanAsrGames };
}

const MAX_FILETIME = 18_446_744_073_709_551_615n;
const isValidCreationFiletime = (value) => typeof value === 'string' && /^[1-9]\d*$/.test(value) && BigInt(value) <= MAX_FILETIME;

/** Game-scoped screen sharpening. The native helper owns capture and compositing. */
export function createScreenPostprocessSharpening({ dir, detector, helperPath = SOURCE_HELPER, spawn = nodeSpawn, stageHelper = null, allowCaptureOverlay = true, allowAsrCapture = false } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new TypeError('An absolute AppData directory is required.');
  if (!detector || (typeof detector.detectProcess !== 'function' && typeof detector.detectProcessIdentity !== 'function')) throw new TypeError('A foreground process detector is required.');
  const configPath = path.join(dir, SETTINGS);
  const captureOverlayAllowed = allowCaptureOverlay === true;
  const asrCaptureAllowed = allowAsrCapture === true;
  const sharpeningAllowed = captureOverlayAllowed;
  let settings = { global: { ...DEFAULT }, games: {}, asr: { ...DEFAULT_ASR }, asrGames: {} };
  let settingsError = null;
  try { settings = readSettings(configPath); }
  catch (error) { settingsError = error; }
  let child = null;
  let ready = false;
  let overlayActive = false;
  let reason = settingsError ? `Sharpening settings could not be loaded and were preserved: ${settingsError.message}`
    : captureOverlayAllowed || asrCaptureAllowed ? null : SCREEN_SHARPENING_PAUSED_REASON;
  let overlayMode = null;
  let windowSelection = { phase: 'idle', secondsRemaining: 0, targetName: null, target: null, upscale: false, sharpness: 0 };
  let selectionGeneration = 0;
  let started = false;
  let stopped = false;
  let timer = null;
  let lastCommand = null;
  let stdoutBuffer = '';
  let generation = 0;
  let polling = false;
  let helperStartup = null;
  let settleStartup = null;
  const stagedHelpers = new Map();
  const statusListeners = new Set();
  let publishedStatus = null;
  const selectionStatus = () => ({ phase: windowSelection.phase, secondsRemaining: windowSelection.secondsRemaining,
    targetName: windowSelection.targetName });
  const runtimeStatus = () => {
    const selectedCaptureActive = ready && overlayActive && overlayMode === 'scale';
    const asrActive = selectedCaptureActive && windowSelection.upscale;
    const windowSharpeningActive = selectedCaptureActive && windowSelection.sharpness > 0;
    const sharpeningActive = windowSharpeningActive;
    return { active: asrActive || sharpeningActive, reason: reason ?? null,
      ...(selectedCaptureActive ? { sharpeningActive, asrActive,
        sharpeningReason: reason ?? null, asrReason: reason ?? null } : {}),
      ...(selectedCaptureActive ? { mode: 'scale' } : asrActive ? { mode: 'asr' } : sharpeningActive ? { mode: 'sharpening' } : {}),
      selection: selectionStatus() };
  };
  const sharpeningEnabled = () => captureOverlayAllowed && settings.global.enabled;
  const asrEnabled = () => asrCaptureAllowed && settings.asr.enabled;
  const runtimeConfigured = () => sharpeningEnabled() || asrEnabled();
  const runtimeEnabled = () => runtimeConfigured() && windowSelection.phase === 'selected' && !!windowSelection.target;
  const effectiveAsrFor = (exePath) => {
    const key = canonicalExePath(exePath);
    return { enabled: asrCaptureAllowed && (settings.asrGames[key]?.enabled ?? settings.asr.enabled) };
  };
  const idleCommand = () => IDLE_SCALE_COMMAND;
  const publishStatus = () => {
    const next = runtimeStatus();
    const signature = JSON.stringify(next);
    if (signature === publishedStatus) return;
    publishedStatus = signature;
    for (const listener of statusListeners) {
      try { listener({ ...next }); } catch { /* a renderer listener cannot break the helper */ }
    }
  };

  const cleanupStagedHelper = (proc) => {
    const staged = stagedHelpers.get(proc);
    if (!staged) return;
    stagedHelpers.delete(proc);
    try { staged.cleanup?.(); } catch { /* helper may already have exited during shutdown */ }
  };

  const persist = (next) => {
    if (settingsError) throw new Error(`${reason}. Repair the settings file before changing screen post-processing.`);
    fs.mkdirSync(dir, { recursive: true });
    atomicJson(configPath, next);
    settings = next;
  };
  const effectiveFor = (exePath) => {
    const enabled = sharpeningAllowed && settings.global.enabled && settings.global.percentage > 0;
    return { enabled, percentage: enabled ? settings.global.percentage : 0 };
  };
  const globalState = () => {
    const legacy = inspectLegacySharpening(dir);
    const sharpeningReason = reason ?? (!captureOverlayAllowed ? SCREEN_SHARPENING_PAUSED_REASON : null);
    return {
      value: { ...settings.global },
      overrideCount: Object.keys(settings.games).length,
      runtimeReady: captureOverlayAllowed && helperIntegrity(helperPath),
      provider: 'screen',
      requiresRestart: false,
      active: runtimeStatus().sharpeningActive === true,
      selection: selectionStatus(),
      legacyIntegrations: legacy.games,
      legacyManifestPath: legacy.manifestPath,
      legacyManifestStatus: legacy.status,
      ...(legacy.reason ? { legacyManifestReason: legacy.reason } : {}),
      ...(sharpeningReason ? { reason: sharpeningReason } : {}),
    };
  };
  const asrState = () => ({
    value: { ...settings.asr },
    runtimeReady: asrCaptureAllowed && helperIntegrity(helperPath),
    requiresRestart: false,
    active: runtimeStatus().asrActive === true,
    selection: selectionStatus(),
    ...(!asrCaptureAllowed ? { reason: SCREEN_ASR_PAUSED_REASON } : reason ? { reason } : {}),
  });
  const asrGameState = (exePath) => {
    const key = canonicalExePath(exePath);
    const override = settings.asrGames[key] ?? null;
    return { globalValue: { ...settings.asr }, override: override ? { ...override } : null,
      effective: effectiveAsrFor(exePath), runtimeReady: asrCaptureAllowed && helperIntegrity(helperPath),
      ...(!asrCaptureAllowed ? { reason: SCREEN_ASR_PAUSED_REASON } : {}) };
  };
  const gameState = (exePath) => {
    const key = canonicalExePath(exePath);
    const override = key ? settings.games[key] ?? null : null;
    const source = override ?? settings.global;
    const effective = { enabled: sharpeningAllowed && settings.global.enabled && source.enabled && source.percentage > 0,
      percentage: sharpeningAllowed && settings.global.enabled && source.enabled ? source.percentage : 0 };
    const legacy = inspectLegacySharpening(dir);
    const legacyIntegration = key ? legacy.games.find((game) => canonicalExePath(game.exePath) === key) ?? null : null;
    const sharpeningReason = reason ?? (!captureOverlayAllowed ? SCREEN_SHARPENING_PAUSED_REASON : null);
    return { value: { ...effective }, globalValue: { ...settings.global }, override: override ? { ...override } : null,
      effective, runtimeReady: captureOverlayAllowed && helperIntegrity(helperPath), legacyIntegration,
      legacyManifestStatus: legacy.status, ...(legacy.reason ? { legacyManifestReason: legacy.reason } : {}),
      ...(sharpeningReason ? { reason: sharpeningReason } : {}) };
  };
  const writeCommand = (command) => {
    if (!child || !ready || child.stdin.destroyed || command === lastCommand) return;
    try {
      child.stdin.write(`${command}\n`);
      lastCommand = command;
      if ((command === 'SET 0 0' || command === 'ASR 0' || command === IDLE_SCALE_COMMAND) && overlayActive) {
        overlayActive = false;
        overlayMode = null;
        publishStatus();
      }
    } catch (error) {
      reason = `Sharpening helper command failed: ${error.message}`;
      ready = false;
      publishStatus();
    }
  };

  const applySelectedWindow = () => {
    const target = windowSelection.phase === 'selected' ? windowSelection.target : null;
    if (!target || !ready || !child) { if (ready) writeCommand(IDLE_SCALE_COMMAND); return; }
    const sharpening = effectiveFor();
    const upscale = asrEnabled();
    windowSelection = { ...windowSelection, upscale, sharpness: sharpening.enabled ? sharpening.percentage : 0 };
    if (!upscale && windowSelection.sharpness <= 0) writeCommand(IDLE_SCALE_COMMAND);
    else writeCommand(`SCALE ${target.pid} ${target.creationFiletime} ${upscale ? 1 : 0} ${windowSelection.sharpness}`);
    publishStatus();
  };

  const cancelWindowSelection = () => {
    selectionGeneration += 1;
    windowSelection = { phase: 'idle', secondsRemaining: 0, targetName: null, target: null, upscale: false, sharpness: 0 };
    if (ready) writeCommand(IDLE_SCALE_COMMAND);
    stopHelper();
    publishStatus();
  };

  const selectForegroundTarget = async (token) => {
    if (!runtimeConfigured()) throw new Error('Turn on Arc Image Sharpening or Arc Super Resolution before pressing Scale.');
    if (token !== selectionGeneration) return { canceled: true, selection: selectionStatus() };
    windowSelection = { phase: 'countdown', secondsRemaining: 0, targetName: null, target: null, upscale: false, sharpness: 0 };
    publishStatus();
    let identity = null;
    try { identity = await detector.detectProcessIdentity?.(); }
    catch (error) { throw new Error(`Could not identify the foreground game window: ${error?.message ?? String(error)}`); }
    if (token !== selectionGeneration) return { canceled: true, selection: selectionStatus() };
    const exePath = canonicalExePath(identity?.exePath);
    const pid = identity?.pid;
    if (!Number.isInteger(pid) || pid < 1 || pid === process.pid || !exePath
      || exePath === canonicalExePath(process.execPath)
      || !isValidCreationFiletime(identity?.creationFiletime)) {
      throw new Error('No game window was selected. Focus a game first, then press Scale again.');
    }
    windowSelection = { phase: 'selected', secondsRemaining: 0, targetName: path.win32.basename(exePath),
      target: { pid, exePath, creationFiletime: identity.creationFiletime }, upscale: false, sharpness: 0 };
    const helperReady = await startHelper();
    if (token !== selectionGeneration) return { canceled: true, selection: selectionStatus() };
    if (!helperReady || !ready) throw new Error(reason || 'The window-processing helper is not ready.');
    schedulePoll();
    publishStatus();
    return { canceled: false, selection: selectionStatus(), sharpening: globalState(), asr: asrState() };
  };

  const stopHelper = (idle = IDLE_SCALE_COMMAND) => {
    const current = child;
    child = null;
    ready = false;
    overlayActive = false;
    overlayMode = null;
    lastCommand = null;
    publishStatus();
    settleStartup?.(false);
    if (!current) return;
    current.once('exit', () => cleanupStagedHelper(current));
    try {
      if (!current.stdin.destroyed) {
        current.stdin.write(`${idle}\n`);
        current.stdin.write('STOP\n');
      }
    } catch { /* best effort */ }
    let exited = current.exitCode !== null || current.signalCode !== null;
    let killTimer = null;
    current.once('exit', () => { exited = true; if (killTimer) clearTimeout(killTimer); });
    killTimer = setTimeout(() => {
      if (!exited && current.exitCode === null) { try { current.kill(); } catch { /* best effort */ } }
    }, 2000);
    killTimer.unref?.();
    try { current.stdin.end(); } catch { /* best effort */ }
  };

  const schedulePoll = () => {
    if (!started || stopped || !runtimeEnabled() || !child || !ready) return;
    applySelectedWindow();
  };

  const refreshSelectedRuntime = async () => {
    if (!runtimeConfigured()) {
      if (timer) clearTimeout(timer);
      timer = null;
      cancelWindowSelection();
      return;
    }
    if (!runtimeEnabled()) {
      if (child || helperStartup) stopHelper();
      publishStatus();
      return;
    }
    if (started && !child) await startHelper();
    else if (started && child && !ready) await (helperStartup ?? Promise.resolve(false));
    else schedulePoll();
  };

  const startHelper = () => {
    if (!runtimeEnabled()) {
      reason = asrEnabled() ? null : SCREEN_SHARPENING_PAUSED_REASON;
      publishStatus();
      return Promise.resolve(false);
    }
    if (child) return helperStartup ?? Promise.resolve(ready);
    if (helperStartup) return helperStartup;
    if (!runtimeEnabled() || stopped) return Promise.resolve(false);
    if (!helperIntegrity(helperPath)) {
      reason = 'The included screen sharpening helper is missing or damaged.';
      publishStatus();
      return Promise.resolve(false);
    }
    reason = null;
    publishStatus();
    stdoutBuffer = '';
    lastCommand = null;
    overlayActive = false;
    let resolved = false;
    let readyTimer = null;
    let resolveStartup;
    const startupPromise = new Promise((resolve) => { resolveStartup = resolve; });
    const startupGeneration = generation;
    const settleStartupPromise = (value) => {
      if (resolved) return;
      resolved = true;
      if (readyTimer) clearTimeout(readyTimer);
      if (helperStartup === startupPromise) helperStartup = null;
      if (settleStartup === settleStartupPromise) settleStartup = null;
      resolveStartup(value);
    };
    helperStartup = startupPromise;
    settleStartup = settleStartupPromise;
    let staged = null;
    void (async () => {
      try {
        if (startupGeneration !== generation || stopped || !runtimeEnabled() || resolved) {
          settleStartupPromise(false);
          return;
        }
        staged = stageHelper ? await stageHelper(helperPath, HELPER_SHA256) : null;
        const launchPath = staged?.path ?? helperPath;
        if (!launchPath || (stageHelper && !helperIntegrity(launchPath))) {
          throw new Error('The protected screen sharpening helper failed its post-copy integrity check.');
        }
        if (startupGeneration !== generation || stopped || !runtimeEnabled() || resolved) {
          try { staged?.cleanup?.(); } catch { /* stop raced with asynchronous staging */ }
          settleStartupPromise(false);
          return;
        }
      const proc = spawn(launchPath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      if (staged) stagedHelpers.set(proc, staged);
      child = proc;
      proc.stdout?.setEncoding?.('utf8');
      proc.stdout?.on('data', (chunk) => {
        stdoutBuffer += String(chunk);
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const message = line.trim();
          if (child !== proc) continue;
          if (/^READY(?:\s|$)/.test(message)) {
          if (!runtimeEnabled()) { stopHelper(); continue; }
            ready = true;
            publishStatus();
            schedulePoll();
            settleStartupPromise(true);
          } else if (/^ACTIVE\s+\d+(?:\s+(?:ASR|SCALE))?$/.test(message)) {
            const reportedMode = /\sSCALE$/.test(message) ? 'scale' : /\sASR$/.test(message) ? 'asr' : 'sharpening';
            overlayActive = true;
            overlayMode = reportedMode;
            reason = null;
            publishStatus();
          } else if (message === 'IDLE') {
            overlayActive = false;
            overlayMode = null;
            publishStatus();
          }
        }
      });
      proc.stderr?.setEncoding?.('utf8');
      proc.stderr?.on('data', (chunk) => {
        const message = String(chunk).trim();
        if (message) {
          reason = message.slice(0, 1000);
          publishStatus();
          if (/^ERROR\s+fatal\b/i.test(message)) {
            generation++;
            stopHelper();
          }
        }
      });
      proc.once('error', (error) => {
        cleanupStagedHelper(proc);
        if (child !== proc) return;
        generation++;
        child = null;
        ready = false;
        overlayActive = false;
        overlayMode = null;
        reason = `Unable to start screen sharpening helper: ${error.message}`;
        publishStatus();
        settleStartup?.(false);
      });
      proc.once('exit', (code, signal) => {
        cleanupStagedHelper(proc);
        if (child !== proc) return;
        generation++;
        child = null;
        ready = false;
        overlayActive = false;
        overlayMode = null;
        if (timer) clearTimeout(timer);
        timer = null;
        reason = `Screen sharpening helper exited (${signal ?? code ?? 'unknown'}). Toggle sharpening off and on to retry.`;
        publishStatus();
        settleStartup?.(false);
      });
      readyTimer = setTimeout(() => {
        if (child === proc && !ready && generation === startupGeneration) {
          reason = 'Screen sharpening helper did not become ready.';
          publishStatus();
          generation++;
          stopHelper();
        }
      }, 5000);
      readyTimer.unref?.();
      } catch (error) {
        try { staged?.cleanup?.(); } catch { /* best effort cleanup after a failed launch */ }
        if (startupGeneration !== generation || stopped || !runtimeEnabled() || resolved) {
          settleStartupPromise(false);
          return;
        }
        child = null;
        ready = false;
        reason = `Unable to start screen sharpening helper: ${error.message}`;
        publishStatus();
        settleStartupPromise(false);
      }
    })();
    return startupPromise;
  };

  return {
    async start() {
      if (started) return globalState();
      started = true;
      stopped = false;
      if (!sharpeningAllowed && !asrCaptureAllowed) { reason = SCREEN_SHARPENING_PAUSED_REASON; publishStatus(); }
      return globalState();
    },
    async stop() {
      stopped = true;
      started = false;
      generation++;
      cancelWindowSelection();
      if (timer) clearTimeout(timer);
      timer = null;
      stopHelper();
      return globalState();
    },
    async getGlobal() { return globalState(); },
    async getAsr() { return asrState(); },
    async selectWindow() {
      if (!runtimeConfigured()) throw new Error('Turn on Arc Image Sharpening or Arc Super Resolution before pressing Scale.');
      const token = ++selectionGeneration;
      if (timer) clearTimeout(timer);
      timer = null;
      windowSelection = { phase: 'countdown', secondsRemaining: WINDOW_SELECT_SECONDS, targetName: null, target: null, upscale: false, sharpness: 0 };
      if (ready) writeCommand(IDLE_SCALE_COMMAND);
      stopHelper();
      publishStatus();
      try {
        for (let remaining = WINDOW_SELECT_SECONDS; remaining > 0; remaining -= 1) {
          if (token !== selectionGeneration) return { canceled: true, selection: selectionStatus() };
          windowSelection = { ...windowSelection, secondsRemaining: remaining };
          publishStatus();
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        if (token !== selectionGeneration) return { canceled: true, selection: selectionStatus() };
        windowSelection = { ...windowSelection, secondsRemaining: 0 };
        publishStatus();
        return await selectForegroundTarget(token);
      } catch (error) {
        if (token === selectionGeneration) cancelWindowSelection();
        throw error;
      }
    },
    async selectForegroundWindow() {
      const token = ++selectionGeneration;
      if (timer) clearTimeout(timer);
      timer = null;
      try { return await selectForegroundTarget(token); }
      catch (error) { if (token === selectionGeneration) cancelWindowSelection(); throw error; }
    },
    async toggleScaleFromHotkey() {
      if (windowSelection.phase === 'selected') {
        await this.stopWindowSelection();
        return { stopped: true, selection: selectionStatus() };
      }
      return this.selectForegroundWindow();
    },
    async stopWindowSelection() {
      cancelWindowSelection();
      return { selection: selectionStatus(), sharpening: globalState(), asr: asrState() };
    },
    async getAsrGame(exePath) { return asrGameState(exePath); },
    async setAsrGame(exePath, override) {
      const key = canonicalExePath(exePath);
      if (!key) throw new Error('Choose a valid game executable.');
      const next = override === null ? null : validateAsrValue(override);
      if (!asrCaptureAllowed && next?.enabled) throw new Error(SCREEN_ASR_PAUSED_REASON);
      const asrGames = { ...settings.asrGames };
      if (next === null) delete asrGames[key]; else asrGames[key] = next;
      persist({ ...settings, asrGames });
      if (!runtimeConfigured()) cancelWindowSelection();
      else schedulePoll();
      return asrGameState(key);
    },
    subscribeStatus(listener) {
      if (typeof listener !== 'function') throw new TypeError('A sharpening status listener is required.');
      statusListeners.add(listener);
      try { listener(runtimeStatus()); } catch { /* a renderer listener cannot break the helper */ }
      return () => statusListeners.delete(listener);
    },
    async setGlobal(value) {
      const nextValue = validateValue(value);
      if (!sharpeningAllowed && nextValue.enabled) throw new Error(SCREEN_SHARPENING_PAUSED_REASON);
      persist({ ...settings, global: nextValue });
      await refreshSelectedRuntime();
      return globalState();
    },
    async setAsr(value) {
      const nextValue = validateAsrValue(value);
      if (!asrCaptureAllowed && nextValue.enabled) throw new Error(SCREEN_ASR_PAUSED_REASON);
      persist({ ...settings, asr: nextValue });
      await refreshSelectedRuntime();
      return asrState();
    },
    async getGame(exePath) { return gameState(exePath); },
    async setGame(exePath, override) {
      const key = canonicalExePath(exePath);
      if (!key) throw new Error('Choose a valid game executable.');
      if (!sharpeningAllowed && override?.enabled === true) throw new Error(SCREEN_SHARPENING_PAUSED_REASON);
      const games = { ...settings.games };
      if (override === null) delete games[key];
      else games[key] = validateValue(override);
      persist({ ...settings, games });
      if (!runtimeConfigured()) cancelWindowSelection();
      else schedulePoll();
      return gameState(key);
    },
  };
}
