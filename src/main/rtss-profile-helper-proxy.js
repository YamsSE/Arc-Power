// Parent-side RPC client for the RTSS profile controller. RTSSHooks uses
// synchronous native calls, so a hung driver must never block Electron's
// main event loop. A timed-out or crashed worker is terminal for this app
// session: its in-memory ownership snapshots cannot safely be reconstructed.

import { spawn as childProcessSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const RTSS_PROFILE_REQUEST_TIMEOUT_MS = 15000;

const initialState = () => ({
  available: false,
  configured: false,
  renderingMode: 'unknown',
  executablePath: null,
  error: null,
});

const unavailable = (method, message) => {
  if (method === 'getState' || method === 'apply') {
    return { ...initialState(), error: method === 'apply' ? message : null };
  }
  if (method === 'getFrameLimit') {
    return { ok: false, available: false, source: 'igcl', error: message };
  }
  if (method === 'getFrameLimitOwnership') {
    return { ok: false, errorCode: 'unavailable', error: message };
  }
  if (method === 'applyFrameLimit' || method === 'restoreFrameLimit') {
    return { ok: false, used: false, available: false, errorCode: 'unavailable', source: 'rtss', error: message };
  }
  if (method === 'restoreFrameLimitState') {
    return { ok: false, errorCode: 'unavailable', source: 'rtss', error: message };
  }
  return { ok: false, used: false, available: false, errorCode: 'unavailable', source: 'rtss', error: message };
};

/**
 * @param {{
 *   entryPath: string,
 *   getRuntime?: () => Promise<{ executablePath?: string | null, isRunning?: boolean }>,
 *   spawnFn?: typeof childProcessSpawn,
 *   execPath?: string,
 *   env?: NodeJS.ProcessEnv,
 *   timeoutMs?: number,
 *   log?: (message: string) => void,
 * }} options
 */
export function createRtssProfileHelperProxy({
  entryPath,
  getRuntime = async () => ({}),
  spawnFn = childProcessSpawn,
  execPath = process.execPath,
  env = process.env,
  timeoutMs = RTSS_PROFILE_REQUEST_TIMEOUT_MS,
  log = () => {},
} = {}) {
  let child = null;
  let terminalReason = null;
  let cachedState = initialState();
  let queue = Promise.resolve();
  let pending = null;
  let stdoutBuffer = '';

  const markTerminal = (reason) => {
    if (terminalReason) return;
    terminalReason = reason;
    cachedState = { ...initialState(), error: reason };
    const active = pending;
    pending = null;
    if (active?.timer) clearTimeout(active.timer);
    if (active) active.resolve(unavailable(active.method, reason));
    try { child?.stdin?.end?.(); } catch { /* best effort */ }
    try { child?.kill?.(); } catch { /* best effort */ }
    child = null;
    try { log(`RTSS profile worker disabled for this session: ${reason}`); } catch { /* logging is best effort */ }
  };

  const ensureChild = () => {
    if (terminalReason) return null;
    if (child) return child;
    try {
      const proc = spawnFn(execPath, [entryPath], {
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      child = proc;
      proc.stdout?.on?.('data', (chunk) => {
        stdoutBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        for (;;) {
          const newline = stdoutBuffer.indexOf('\n');
          if (newline < 0) break;
          const line = stdoutBuffer.slice(0, newline).trim();
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (!line) continue;
          let message;
          try { message = JSON.parse(line); } catch {
            markTerminal('RTSS profile worker returned an invalid response');
            return;
          }
          if (!pending || message.id !== pending.id) continue;
          const active = pending;
          pending = null;
          if (active.timer) clearTimeout(active.timer);
          if (message.state && typeof message.state === 'object') cachedState = message.state;
          active.resolve(message.error
            ? unavailable(active.method, message.error)
            : message.result);
        }
      });
      proc.once?.('error', (error) => markTerminal(`RTSS profile worker failed to start: ${error?.message ?? String(error)}`));
      proc.once?.('exit', (code, signal) => {
        if (child === proc && !terminalReason) {
          markTerminal(`RTSS profile worker exited unexpectedly (${signal ?? code ?? 'unknown'})`);
        }
      });
      return proc;
    } catch (error) {
      markTerminal(`RTSS profile worker failed to start: ${error?.message ?? String(error)}`);
      return null;
    }
  };

  const dispatch = async (method, args) => {
    if (terminalReason) return unavailable(method, terminalReason);
    const proc = ensureChild();
    if (!proc) return unavailable(method, terminalReason ?? 'RTSS profile worker is unavailable');
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Do not replace this process. It may have completed a write whose
        // reply was lost; only a clean app start can rebuild ownership state.
        markTerminal(`RTSS profile ${method} request timed out`);
      }, timeoutMs);
      pending = { id, method, resolve, timer };
      Promise.resolve().then(getRuntime).then((runtime) => {
        if (terminalReason || pending?.id !== id) return;
        try {
          proc.stdin.write(`${JSON.stringify({ id, method, args, runtime: runtime ?? {} })}\n`, 'utf8');
        } catch (error) {
          markTerminal(`RTSS profile worker request failed: ${error?.message ?? String(error)}`);
        }
      }, (error) => {
        markTerminal(`RTSS runtime state could not be read: ${error?.message ?? String(error)}`);
      });
    });
  };

  const call = (method, args) => {
    const next = queue.catch(() => {}).then(() => dispatch(method, args));
    queue = next.catch(() => {});
    return next;
  };

  return {
    apply: (options = {}) => call('apply', options),
    getFrameLimit: (options = {}) => call('getFrameLimit', options),
    getFrameLimitOwnership: () => call('getFrameLimitOwnership', {}),
    applyFrameLimit: (options = {}) => call('applyFrameLimit', options),
    restoreFrameLimit: (restoreToken = null) => call('restoreFrameLimit', restoreToken),
    restoreFrameLimitState: (options = {}) => call('restoreFrameLimitState', options),
    // This API is intentionally synchronous. The parent only reports the
    // most recent state received from the isolated controller.
    getState: () => ({ ...cachedState }),
    // Kill is synchronous and bounded even if a Koffi call is stuck. The
    // pending request is resolved unavailable and future calls are rejected.
    close: () => markTerminal('RTSS profile worker closed during app shutdown'),
    isTerminal: () => terminalReason !== null,
  };
}
