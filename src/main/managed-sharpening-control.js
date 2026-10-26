import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, lstatSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

const MAX_LINE_BYTES = 256;
const MAX_PENDING = 32;
const UINT32_MAX = 0xffff_ffff;
const UINT64_MAX = (1n << 64n) - 1n;

function assertExactKeys(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))) throw new TypeError(`Invalid ${name}`);
}

function uint32(value, name, { nonzero = false } = {}) {
  if (!Number.isInteger(value) || value < (nonzero ? 1 : 0) || value > UINT32_MAX) {
    throw new TypeError(`Invalid ${name}`);
  }
  return value;
}

function filetime(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError('Invalid creationFiletime');
  const parsed = BigInt(value);
  if (parsed === 0n || parsed > UINT64_MAX) throw new TypeError('Invalid creationFiletime');
  return value;
}

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function equalDigest(left, right) {
  if (!/^[0-9a-f]{64}$/i.test(right ?? '')) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function boundedExitWait(exitPromise, timeoutMs, rejectOnTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (rejectOnTimeout) reject(new Error('Managed sharpening bridge did not exit'));
      else resolve();
    }, timeoutMs);
    exitPromise.then(() => { clearTimeout(timer); resolve(); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

export function createManagedSharpeningControl({ executablePath, expectedSha256, spawn = nodeSpawn,
  requestTimeoutMs = 8000, maxLineBytes = MAX_LINE_BYTES, maxPending = MAX_PENDING,
  lstat = lstatSync, hashFile = sha256File } = {}) {
  if (typeof executablePath !== 'string' || !isAbsolute(executablePath) || typeof expectedSha256 !== 'string'
    || !/^[0-9a-f]{64}$/i.test(expectedSha256) || typeof spawn !== 'function'
    || typeof requestTimeoutMs !== 'number' || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0
    || !Number.isInteger(maxLineBytes) || maxLineBytes < 1 || maxLineBytes > MAX_LINE_BYTES
    || !Number.isInteger(maxPending) || maxPending < 1 || maxPending > MAX_PENDING) {
    throw new TypeError('Invalid managed sharpening control configuration');
  }
  // This main-process-only factory does not make pathname hashing atomic with
  // spawn. Its eventual caller must supply an ACL-protected, immutable staged
  // executable and protected parent directories, never a renderer/user path.
  let child = null;
  let starting = null;
  let childExit = null;
  let state = 'idle';
  let lineBuffer = '';
  let nextId = 0;
  const pending = new Map();

  const fail = (error, { kill = true, owner = child } = {}) => {
    if (state === 'failed' || state === 'stopped') return;
    state = 'failed';
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    if (kill && owner && owner === child && !owner.killed) {
      try { owner.kill(); } catch { /* The owned bridge is already exiting. */ }
    }
  };

  const parseLine = (line) => {
    if (!/^[\x20-\x7e]+$/.test(line)) throw new Error('Malformed bridge response');
    const fields = line.split(' ');
    if (fields.some((field) => !field) || fields.length < 3) throw new Error('Malformed bridge response');
    if (fields[0] === 'RESULT' && fields.length === 5) {
      const [, idText, statusText, acceptedText, appliedText] = fields;
      if (![idText, statusText, acceptedText, appliedText].every((item) => /^(0|[1-9][0-9]*)$/.test(item))) throw new Error('Malformed bridge response');
      const id = uint32(Number(idText), 'request id', { nonzero: true });
      const status = uint32(Number(statusText), 'status');
      const acceptedRevision = uint32(Number(acceptedText), 'accepted revision');
      const appliedRevision = uint32(Number(appliedText), 'applied revision');
      if (status !== 0 && status !== 2) throw new Error('Malformed bridge response');
      const request = pending.get(id);
      if (!request) throw new Error('Unexpected bridge response');
      pending.delete(id);
      clearTimeout(request.timer);
      request.resolve({ status, acceptedRevision, appliedRevision });
      return;
    }
    if (fields[0] === 'ERROR' && fields.length === 3) {
      const [, idText, reason] = fields;
      if (!/^(0|[1-9][0-9]*)$/.test(idText) || !['malformed', 'pipe_or_identity'].includes(reason)) throw new Error('Malformed bridge response');
      const id = uint32(Number(idText), 'request id', { nonzero: true });
      const request = pending.get(id);
      if (!request) throw new Error('Unexpected bridge response');
      pending.delete(id);
      clearTimeout(request.timer);
      request.reject(new Error(`Managed sharpening bridge rejected request: ${reason}`));
      return;
    }
    throw new Error('Malformed bridge response');
  };

  const startNow = async () => {
    if (state === 'failed' || state === 'stopped') throw new Error('Managed sharpening bridge is unavailable');
    if (child) return child;
    const stat = lstat(executablePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Managed sharpening bridge executable is not a regular single-link file');
    const actual = await hashFile(executablePath);
    if (!equalDigest(actual, expectedSha256)) throw new Error('Managed sharpening bridge integrity check failed');
    if (state === 'failed' || state === 'stopped') throw new Error('Managed sharpening bridge is unavailable');
    const spawned = spawn(executablePath, ['--serve'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    if (!spawned?.stdin || !spawned?.stdout || !spawned?.stderr || typeof spawned.kill !== 'function') {
      try { spawned?.kill?.(); } catch { /* malformed spawn result */ }
      throw new Error('Unable to start managed sharpening bridge');
    }
    child = spawned;
    state = 'running';
    lineBuffer = '';
    let resolveExit;
    childExit = new Promise((resolve) => { resolveExit = resolve; });
    const isCurrent = () => child === spawned && state === 'running';
    spawned.stdout.on('data', (chunk) => {
      if (!isCurrent()) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (const byte of bytes) {
        if (byte === 10) {
          let line = lineBuffer;
          lineBuffer = '';
          if (line.endsWith('\r')) line = line.slice(0, -1);
          try { parseLine(line); } catch (error) { fail(error); return; }
        } else {
          if ((byte < 0x20 && byte !== 13) || byte > 0x7e || lineBuffer.length >= maxLineBytes) { fail(new Error('Malformed or oversized bridge response'), { owner: spawned }); return; }
          lineBuffer += String.fromCharCode(byte);
        }
      }
    });
    // Drain bounded diagnostic bytes; never let stderr backpressure the bridge.
    let diagnosticBytes = 0;
    spawned.stderr.on('data', (chunk) => { diagnosticBytes = Math.min(4096, diagnosticBytes + (chunk?.length ?? 0)); });
    spawned.stdin.on('error', (error) => { if (isCurrent()) fail(error, { owner: spawned }); });
    spawned.stdout.on('error', (error) => { if (isCurrent()) fail(error, { owner: spawned }); });
    spawned.stderr.on('error', (error) => { if (isCurrent()) fail(error, { owner: spawned }); });
    spawned.on('error', (error) => { if (isCurrent()) fail(error, { owner: spawned }); });
    spawned.on('exit', (code, signal) => {
      resolveExit();
      if (child === spawned) {
        const wasRunning = state === 'running';
        child = null;
        if (wasRunning) fail(new Error(`Managed sharpening bridge exited (${code ?? signal ?? 'unknown'})`), { kill: false, owner: spawned });
      }
    });
    spawned.stdout.on('end', () => {
      if (isCurrent()) fail(new Error(lineBuffer.length ? 'Incomplete bridge response' : 'Bridge stdout closed'), { owner: spawned });
    });
    return spawned;
  };
  const start = () => {
    if (child) return Promise.resolve(child);
    if (!starting) starting = startNow().finally(() => { starting = null; });
    return starting;
  };

  const send = (command, args) => {
    if (state === 'failed' || state === 'stopped') return Promise.reject(new Error('Managed sharpening bridge is unavailable'));
    if (pending.size >= maxPending) return Promise.reject(new Error('Managed sharpening bridge request limit reached'));
    nextId = nextId === UINT32_MAX ? 1 : nextId + 1;
    while (pending.has(nextId)) nextId = nextId === UINT32_MAX ? 1 : nextId + 1;
    const id = nextId;
    const line = `${command} ${id} ${args.join(' ')}\n`;
    if (Buffer.byteLength(line, 'ascii') > MAX_LINE_BYTES) throw new TypeError('Managed sharpening bridge request too large');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('Managed sharpening bridge request timed out')), requestTimeoutMs);
      const record = { resolve, reject, timer };
      pending.set(id, record);
      start().then((target) => {
        if (state !== 'running' || target !== child || pending.get(id) !== record) return;
        try {
          target.stdin.write(line, 'ascii', (error) => { if (error && pending.get(id) === record) fail(error, { owner: target }); });
        } catch (error) { fail(error, { owner: target }); }
      }).catch((error) => {
        if (pending.get(id) === record) fail(error, { kill: false });
      });
    });
  };

  return {
    query(value) {
      assertExactKeys(value, ['pid', 'creationFiletime'], 'query');
      const pid = uint32(value.pid, 'pid', { nonzero: true });
      return send('QUERY', [pid, filetime(value.creationFiletime)]);
    },
    set(value) {
      assertExactKeys(value, ['pid', 'creationFiletime', 'revision', 'enabled', 'percentage'], 'set');
      const pid = uint32(value.pid, 'pid', { nonzero: true });
      const creation = filetime(value.creationFiletime);
      const revision = uint32(value.revision, 'revision', { nonzero: true });
      if (typeof value.enabled !== 'boolean') throw new TypeError('Invalid enabled');
      if (!Number.isInteger(value.percentage) || value.percentage < 0 || value.percentage > 100) throw new TypeError('Invalid percentage');
      return send('SET', [pid, creation, revision, value.enabled ? 1 : 0, value.percentage]);
    },
    async resetFailure() {
      if (state !== 'failed') return;
      const retired = child;
      if (retired) {
        if (!retired.killed) { try { retired.kill(); } catch { /* Wait for the retained process to exit. */ } }
        await boundedExitWait(childExit, 1000, true);
        // stop() is terminal even when it races this asynchronous reaper.
        if (state !== 'failed') return;
        if (child === retired) child = null;
      }
      if (state !== 'failed') return;
      state = 'idle';
      lineBuffer = '';
    },
    async stop() {
      if (state === 'stopped') return;
      const owned = child;
      state = 'stopped';
      const error = new Error('Managed sharpening bridge stopped');
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
      pending.clear();
      if (owned) {
        try { owned.stdin.end(); } catch { /* Continue to bounded owned-process shutdown. */ }
        if (!owned.killed) { try { owned.kill(); } catch { /* Already exited. */ } }
        await boundedExitWait(childExit, 1000, false);
      }
    },
  };
}
