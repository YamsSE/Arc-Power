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
const SOURCE_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sharpening-runtime', 'ArcPower.ScreenSharpen.exe');
export const SCREEN_SHARPENING_PAUSED_REASON = 'Arc Image Sharpening is paused because the desktop capture overlay causes game frame-pacing and input-latency regressions. A safe native game-sharpening path is not available on the current Intel driver.';
export const SCREEN_ASR_PAUSED_REASON = 'Arc Super Resolution is paused pending input and performance fixes.';
// Pin the bundled native executable before spawning it from an elevated Portable.
const HELPER_SHA256 = '6C3CB8B205B11A535D2E6D94FD83671ECA94B9FE4B19D39BB625C092CE248073';

function helperIntegrity(helperPath) {
  try {
    const stat = fs.lstatSync(helperPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return false;
    return createHash('sha256').update(fs.readFileSync(helperPath)).digest('hex').toUpperCase() === HELPER_SHA256;
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
    || Object.keys(raw).some((key) => !['global', 'games', 'asr'].includes(key))) throw new Error('Screen post-processing settings file is invalid.');
  const global = validateValue(raw.global ?? DEFAULT);
  const asr = validateAsrValue(raw.asr ?? DEFAULT_ASR);
  const games = raw.games ?? {};
  if (!games || typeof games !== 'object' || Array.isArray(games)) throw new Error('Sharpening game overrides are invalid.');
  const cleanGames = {};
  for (const [key, value] of Object.entries(games)) {
    if (canonicalExePath(key) !== key) throw new Error('Sharpening game override identity is invalid.');
    cleanGames[key] = validateValue(value);
  }
  return { global, games: cleanGames, asr };
}

const MAX_FILETIME = 18_446_744_073_709_551_615n;
const isValidCreationFiletime = (value) => typeof value === 'string' && /^[1-9]\d*$/.test(value) && BigInt(value) <= MAX_FILETIME;

/** Game-scoped screen sharpening. The native helper owns capture and compositing. */
export function createScreenPostprocessSharpening({ dir, detector, isGameExecutable = async () => false, helperPath = SOURCE_HELPER, spawn = nodeSpawn, stageHelper = null, ensureCompatibility = null, pollMs = 1000, allowCaptureOverlay = true, allowAsrCapture = false, createManagedRuntime = null } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new TypeError('An absolute AppData directory is required.');
  if (!detector || (typeof detector.detectProcess !== 'function' && typeof detector.detectProcessIdentity !== 'function')) throw new TypeError('A foreground process detector is required.');
  if (typeof isGameExecutable !== 'function') throw new TypeError('A game catalog lookup is required.');
  if (ensureCompatibility !== null && typeof ensureCompatibility !== 'function') throw new TypeError('The sharpening compatibility check must be a function.');
  const configPath = path.join(dir, SETTINGS);
  const captureOverlayAllowed = allowCaptureOverlay === true;
  const asrCaptureAllowed = allowAsrCapture === true;
  if (createManagedRuntime !== null && typeof createManagedRuntime !== 'function') throw new TypeError('A managed runtime factory is required.');
  const sharpeningAllowed = captureOverlayAllowed || createManagedRuntime !== null;
  let managedRuntime = null;
  let settings = { global: { ...DEFAULT }, games: {}, asr: { ...DEFAULT_ASR } };
  let settingsError = null;
  try { settings = readSettings(configPath); }
  catch (error) { settingsError = error; }
  let child = null;
  let ready = false;
  let overlayActive = false;
  let reason = settingsError ? `Sharpening settings could not be loaded and were preserved: ${settingsError.message}`
    : captureOverlayAllowed || asrCaptureAllowed ? null : SCREEN_SHARPENING_PAUSED_REASON;
  let overlayMode = null;
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
  let nextCompatibilityCheckAt = 0;
  let compatibilityFailure = null;

  const checkCompatibility = async () => {
    if (!ensureCompatibility) return;
    const result = await ensureCompatibility();
    if (result?.ok !== true) throw new Error(result?.error || 'RTSS compatibility could not be verified for Arc Image Sharpening.');
  };

  const runtimeStatus = () => {
    const managed = managedRuntime?.state();
    const asrActive = ready && overlayActive && overlayMode === 'asr' && asrCaptureAllowed;
    const sharpeningActive = managed?.active ?? (ready && overlayActive && overlayMode === 'sharpening' && captureOverlayAllowed);
    return { active: asrActive || sharpeningActive, reason: reason ?? managed?.reason ?? null,
      ...(managed ? { sharpeningActive, asrActive, sharpeningReason: managed.reason ?? null, asrReason: reason ?? null } : {}),
      ...(asrActive ? { mode: 'asr' } : sharpeningActive ? { mode: 'sharpening' } : {}) };
  };
  const sharpeningEnabled = () => captureOverlayAllowed && settings.global.enabled;
  const asrEnabled = () => asrCaptureAllowed && settings.asr.enabled;
  const runtimeEnabled = () => sharpeningEnabled() || asrEnabled();
  const activeMode = () => asrEnabled() ? 'asr' : sharpeningEnabled() ? 'sharpening' : null;
  const idleCommand = () => activeMode() === 'asr' ? 'ASR 0' : 'SET 0 0';
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
    const key = canonicalExePath(exePath);
    const override = key ? settings.games[key] ?? null : null;
    const chosen = override ?? settings.global;
    const enabled = sharpeningAllowed && settings.global.enabled && chosen.enabled && chosen.percentage > 0;
    return { enabled, percentage: enabled ? chosen.percentage : 0 };
  };
  if (createManagedRuntime) managedRuntime = createManagedRuntime({ effectiveFor, isEnabled: () => settings.global.enabled, onChange: publishStatus });
  const globalState = () => {
    const legacy = inspectLegacySharpening(dir);
    const managed = managedRuntime?.state();
    const sharpeningReason = managed ? managed.reason : reason ?? (!captureOverlayAllowed ? SCREEN_SHARPENING_PAUSED_REASON : null);
    return {
      value: { ...settings.global },
      overrideCount: Object.keys(settings.games).length,
      runtimeReady: managed?.runtimeReady ?? (captureOverlayAllowed && helperIntegrity(helperPath)),
      provider: managed ? 'managed' : 'screen',
      requiresRestart: managed?.requiresRestart ?? false,
      ...(managed ? { launchSupported: managed.launchSupported } : {}),
      active: managed?.active ?? (ready && overlayActive && overlayMode === 'sharpening'),
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
    active: ready && overlayActive && overlayMode === 'asr',
    ...(!asrCaptureAllowed ? { reason: SCREEN_ASR_PAUSED_REASON } : reason ? { reason } : {}),
  });
  const gameState = (exePath) => {
    const key = canonicalExePath(exePath);
    const override = key ? settings.games[key] ?? null : null;
    const source = override ?? settings.global;
    const globalGate = settings.global.enabled;
    const effective = { enabled: sharpeningAllowed && globalGate && source.enabled && source.percentage > 0, percentage: sharpeningAllowed && globalGate && source.enabled ? source.percentage : 0 };
    const legacy = inspectLegacySharpening(dir);
    const managed = managedRuntime?.state();
    const sharpeningReason = managed ? managed.reason : reason ?? (!captureOverlayAllowed ? SCREEN_SHARPENING_PAUSED_REASON : null);
    const legacyIntegration = key ? legacy.games.find((game) => canonicalExePath(game.exePath) === key) ?? null : null;
    return { value: { ...effective }, globalValue: { ...settings.global }, override: override ? { ...override } : null, effective, runtimeReady: managed?.runtimeReady ?? (captureOverlayAllowed && helperIntegrity(helperPath)), ...(managed ? { launchSupported: managed.launchSupported, provider: 'managed' } : {}), legacyIntegration, legacyManifestStatus: legacy.status, ...(legacy.reason ? { legacyManifestReason: legacy.reason } : {}), ...(sharpeningReason ? { reason: sharpeningReason } : {}) };
  };

  const writeCommand = (command) => {
    if (!child || !ready || child.stdin.destroyed || command === lastCommand) return;
    try {
      child.stdin.write(`${command}\n`);
      lastCommand = command;
      if ((command === 'SET 0 0' || command === 'ASR 0') && overlayActive) {
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

  const stopHelper = (idle = overlayMode === 'asr' || activeMode() === 'asr' ? 'ASR 0' : 'SET 0 0') => {
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
    if (!started || stopped || timer || polling || !runtimeEnabled() || !child) return;
    timer = setTimeout(async () => {
      timer = null;
      polling = true;
      const token = generation;
      try {
        const mode = activeMode();
        if (mode !== 'asr' && ensureCompatibility && Date.now() >= nextCompatibilityCheckAt) {
          // RTSS can start later. Keep its limiter off this helper's separate
          // presentation path without changing any game or global FPS cap.
          try { await checkCompatibility(); compatibilityFailure = null; }
          catch (error) { compatibilityFailure = error; }
          nextCompatibilityCheckAt = Date.now() + 5000;
        }
        if (token !== generation || stopped || !ready || !runtimeEnabled() || mode !== activeMode()) return;
        if (mode !== 'asr' && compatibilityFailure) throw compatibilityFailure;
        const identity = mode === 'asr' && typeof detector.detectProcessIdentity === 'function'
          ? await detector.detectProcessIdentity()
          : await detector.detectProcess();
        if (token !== generation || stopped || !ready || !runtimeEnabled() || mode !== activeMode()) return;
        const pid = Number.isInteger(identity?.pid) && identity.pid > 0 ? identity.pid : 0;
        const exePath = identity?.exePath;
        const creationFiletime = mode === 'asr' && isValidCreationFiletime(identity?.creationFiletime) ? identity.creationFiletime : null;
        const ownPid = pid === process.pid || canonicalExePath(exePath) === canonicalExePath(process.execPath);
        // Global sharpening is intentionally scoped to executables explicitly
        // present in the user's Game Profile catalog. Unknown desktop programs
        // and catalog lookup failures always clear the native capture target.
        let game = false;
        if (pid > 0 && !ownPid && typeof exePath === 'string' && (mode !== 'asr' || creationFiletime !== null)) {
          try { game = await isGameExecutable(exePath) === true; } catch { game = false; }
        }
        if (token !== generation || stopped || !ready || !runtimeEnabled() || mode !== activeMode()) return;
        if (mode === 'asr') {
          writeCommand(`ASR ${game && creationFiletime !== null ? `${pid} ${creationFiletime}` : '0'}`);
        } else {
          const value = game ? effectiveFor(exePath) : { enabled: false, percentage: 0 };
          writeCommand(`SET ${value.enabled ? pid : 0} ${value.enabled ? value.percentage : 0}`);
        }
      } catch (error) {
        if (token !== generation || stopped) return;
        reason = `Screen sharpening is paused: ${error?.message ?? String(error)}`;
        publishStatus();
        writeCommand(idleCommand());
      } finally {
        polling = false;
        schedulePoll();
      }
    }, Math.max(250, Math.min(5000, pollMs)));
    timer.unref?.();
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
        if (activeMode() !== 'asr') await checkCompatibility();
        if (startupGeneration !== generation || stopped || !runtimeEnabled() || resolved) {
          settleStartupPromise(false);
          return;
        }
        if (activeMode() !== 'asr') {
          compatibilityFailure = null;
          nextCompatibilityCheckAt = Date.now() + 5000;
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
          } else if (/^ACTIVE\s+\d+(?:\s+ASR)?$/.test(message)) {
            const reportedMode = /\sASR$/.test(message) ? 'asr' : 'sharpening';
            if (activeMode() !== reportedMode) { writeCommand(idleCommand()); continue; }
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
      managedRuntime?.start();
      if (runtimeEnabled()) void startHelper();
      else if (!sharpeningAllowed && !asrCaptureAllowed) { reason = SCREEN_SHARPENING_PAUSED_REASON; publishStatus(); }
      return globalState();
    },
    async stop() {
      stopped = true;
      started = false;
      generation++;
      if (timer) clearTimeout(timer);
      timer = null;
      stopHelper();
      await managedRuntime?.stop();
      return globalState();
    },
    async getGlobal() { return globalState(); },
    async getAsr() { return asrState(); },
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
      await managedRuntime?.settingsChanged();
      if (!runtimeEnabled()) {
        generation++;
        if (timer) clearTimeout(timer);
        timer = null;
        stopHelper();
      } else if (started && !child) await startHelper();
      else if (started && child && !ready) await (helperStartup ?? Promise.resolve(false));
      else schedulePoll();
      return globalState();
    },
    async setAsr(value) {
      const nextValue = validateAsrValue(value);
      if (!asrCaptureAllowed && nextValue.enabled) throw new Error(SCREEN_ASR_PAUSED_REASON);
      const wasAsrEnabled = settings.asr.enabled;
      persist({ ...settings, asr: nextValue });
      if (!runtimeEnabled()) {
        generation++;
        if (timer) clearTimeout(timer);
        timer = null;
        stopHelper(wasAsrEnabled ? 'ASR 0' : idleCommand());
      } else if (started && !child) await startHelper();
      else if (started && child && !ready) await (helperStartup ?? Promise.resolve(false));
      else schedulePoll();
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
      await managedRuntime?.settingsChanged();
      if (runtimeEnabled()) schedulePoll();
      return gameState(key);
    },
    async launchGame(exePath) {
      if (!managedRuntime) throw new Error('The managed game launcher is unavailable.');
      const key = canonicalExePath(exePath);
      if (!key || !await isGameExecutable(key)) throw new Error('Choose a recognized game executable.');
      return managedRuntime.launchGame(exePath);
    },
  };
}
