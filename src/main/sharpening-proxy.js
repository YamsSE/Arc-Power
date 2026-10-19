import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSharpeningRequest } from './sharpening-contract.js';

const ENTRY = fileURLToPath(new URL('./sharpening-helper-entry.js', import.meta.url));
const TIMEOUT_MS = 12_000;

export function createSharpeningProxy({ spawnFn = spawn, execPath = process.execPath, entryPath = ENTRY, timeoutMs = TIMEOUT_MS } = {}) {
  let queue = Promise.resolve();
  let closed = false;
  const active = new Set();
  const run = (input) => {
    if (closed) return Promise.resolve({ ok: false, errorCode: 'cancelled', message: 'The sharpening backend is closed.' });
    const request = { ...input, deadlineAt: Date.now() + timeoutMs };
    if (!validateSharpeningRequest(request)) return Promise.resolve({ ok: false, errorCode: 'invalid-argument', message: 'Invalid sharpening request.' });
    const operation = queue.then(() => new Promise((resolve) => {
      if (closed) { resolve({ ok: false, errorCode: 'cancelled', message: 'The sharpening backend is closed.' }); return; }
      if (request.deadlineAt <= Date.now()) { resolve({ ok: false, errorCode: 'timeout', message: 'The sharpening request expired while queued.' }); return; }
      let child;
      let settled = false;
      let timedOut = false;
      let result = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        active.delete(record);
        resolve(value);
      };
      const record = { kill: () => {
        try { child?.disconnect?.(); } catch { /* IPC can already be closed */ }
        try { child?.kill(); } catch { /* child may already have exited */ }
      } };
      const timer = setTimeout(() => {
        timedOut = true;
        record.kill();
        if (!child) finish({ ok: false, errorCode: 'timeout', message: 'The isolated sharpening operation timed out.' });
      }, Math.max(1, request.deadlineAt - Date.now()));
      try {
        child = spawnFn(execPath, [entryPath], {
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          shell: false,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          // Packaged helpers live inside app.asar, which is virtual and
          // cannot be used as a process working directory. The script path
          // itself stays absolute; use the real executable directory.
          cwd: path.dirname(execPath),
        });
        active.add(record);
        child.once('message', (message) => { result = message; });
        child.once('error', () => finish({ ok: false, errorCode: timedOut ? 'timeout' : 'helper-failed', message: timedOut ? 'The isolated sharpening operation timed out.' : 'The isolated sharpening helper could not start.' }));
        child.once('close', () => {
          if (settled) return;
          if (timedOut) finish({ ok: false, errorCode: 'timeout', message: 'The isolated sharpening operation timed out.' });
          else if (closed) finish({ ok: false, errorCode: 'cancelled', message: 'The sharpening backend was closed.' });
          else finish(result ?? { ok: false, errorCode: 'helper-failed', message: 'The sharpening helper exited without a result.' });
        });
        if (child.connected === false) {
          record.kill();
          finish({ ok: false, errorCode: 'helper-failed', message: 'The sharpening helper IPC channel is unavailable.' });
        } else child.send(request, (error) => {
          if (error) { record.kill(); finish({ ok: false, errorCode: 'helper-failed', message: 'The sharpening request could not reach its helper.' }); }
        });
      } catch {
        finish({ ok: false, errorCode: 'helper-failed', message: 'The isolated sharpening helper could not start.' });
      }
    }));
    queue = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const child of active) child.kill();
    await Promise.all([...active].map(() => queue));
  };
  return { run, close };
}
