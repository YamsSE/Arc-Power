// Positive-only D3D12 OPTIONS16 check for full discrete-VRAM CPU visibility.
// All native graphics work is delegated to a small standalone helper process.

import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const D3D12_UPLOAD_HEAP_TIMEOUT_MS = 4000;
export const D3D12_UPLOAD_HEAP_MAX_TARGETS = 16;
export const D3D12_UPLOAD_HEAP_MAX_OUTPUT_BYTES = 4096;
export const D3D12_UPLOAD_HEAP_EXECUTABLE = 'ArcPower.D3D12UploadHeapQuery.exe';

export function normalizeD3d12Bdf(value) {
  let domain; let bus; let device; let fn;
  if (typeof value === 'string') {
    const match = value.trim().match(/^(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,2}):([0-9a-f]{1,2})\.([0-7])$/i);
    if (!match) return null;
    domain = Number.parseInt(match[1] ?? '0', 16);
    bus = Number.parseInt(match[2], 16);
    device = Number.parseInt(match[3], 16);
    fn = Number.parseInt(match[4], 10);
  } else if (value && typeof value === 'object') {
    domain = Number(value.domain ?? value.segment ?? 0);
    bus = Number(value.bus);
    device = Number(value.device);
    fn = Number(value.function ?? value.func ?? 0);
  } else return null;
  if (![domain, bus, device, fn].every(Number.isInteger) || domain < 0 || domain > 0xffff
    || bus < 0 || bus > 0xff || device < 0 || device > 0x1f || fn < 0 || fn > 7) return null;
  return `${domain.toString(16).padStart(4, '0')}:${bus.toString(16).padStart(2, '0')}:${device.toString(16).padStart(2, '0')}.${fn}`;
}

export function d3d12TargetKey(target) {
  const bdf = normalizeD3d12Bdf(target?.bdf);
  const vendorId = normalizePciId(target?.vendorId ?? target?.pciVendorId);
  const deviceId = normalizePciId(target?.deviceId ?? target?.pciDeviceId);
  return bdf && vendorId !== null && deviceId !== null ? `${bdf}|${vendorId}|${deviceId}` : null;
}

export function resolveD3d12UploadHeapHelperPath(appPath) {
  if (typeof appPath !== 'string' || !appPath.trim()) return null;
  const normalized = appPath.replace(/[\\/]+$/, '');
  const appRoot = /\.asar$/i.test(normalized) ? `${normalized}.unpacked` : normalized;
  return join(appRoot, 'src', 'main', 'native', D3D12_UPLOAD_HEAP_EXECUTABLE);
}

function normalizePciId(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff) return value;
  if (typeof value !== 'string' || !/^(?:0x)?[0-9a-f]{1,8}$/i.test(value.trim())) return null;
  const parsed = Number.parseInt(value.trim().replace(/^0x/i, ''), 16);
  return parsed <= 0xffff ? parsed : null;
}

function normalizeTargets(input) {
  if (!Array.isArray(input) || input.length > D3D12_UPLOAD_HEAP_MAX_TARGETS) return { targets: [], keys: new Set() };
  const byBdf = new Map();
  for (const target of input) {
    const key = d3d12TargetKey(target);
    if (!key) continue;
    const [bdf, vendorId, deviceId] = key.split('|');
    const entry = { bdf, vendorId: Number(vendorId), deviceId: Number(deviceId), key, ambiguous: false };
    const previous = byBdf.get(bdf);
    if (previous) { previous.ambiguous = true; continue; }
    byBdf.set(bdf, entry);
  }
  return {
    targets: [...byBdf.values()].filter((target) => !target.ambiguous),
    keys: new Set([...byBdf.values()].map((target) => target.key)),
  };
}

function encodeBatch(targets) {
  return targets.map(({ bdf, vendorId, deviceId }) => `${bdf},${vendorId.toString(16).padStart(4, '0')},${deviceId.toString(16).padStart(4, '0')}`).join('\n') + '\n';
}

function parseBatchOutput(stdout, targets) {
  const lines = String(stdout ?? '').split(/\r?\n/).filter(Boolean);
  if (lines.length !== targets.length) return null;
  const expected = new Map(targets.map((target) => [target.key, target]));
  const counts = new Map();
  const positives = new Set();
  for (const line of lines) {
    const fields = line.split(',');
    if (fields.length !== 4 || !['positive', 'unknown'].includes(fields[3])) return null;
    const bdf = normalizeD3d12Bdf(fields[0]);
    const vendorId = normalizePciId(fields[1]);
    const deviceId = normalizePciId(fields[2]);
    if (!bdf || vendorId === null || deviceId === null) return null;
    const key = `${bdf}|${vendorId}|${deviceId}`;
    if (!expected.has(key)) return null;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (fields[3] === 'positive') positives.add(key);
  }
  return new Map(targets.map((target) => [target.key, counts.get(target.key) === 1 && positives.has(target.key) ? true : null]));
}

/** Run one bounded helper process for a batch; only exact positive result rows count. */
export function createD3d12UploadHeapEvidence({
  platform = process.platform,
  helperPath,
  spawnProcess = spawn,
  timeoutMs = D3D12_UPLOAD_HEAP_TIMEOUT_MS,
} = {}) {
  let started = false;
  let results = null;
  return {
    start(input) {
      if (started) return;
      started = true;
      const batch = normalizeTargets(input);
      results = new Map([...batch.keys].map((key) => [key, null]));
      if (platform !== 'win32' || !helperPath || batch.targets.length === 0) return;
      let child;
      let settled = false;
      let stdout = '';
      let outputBytes = 0;
      let overflow = false;
      const finish = (message = null, stopChild = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stopChild) { try { child?.kill('SIGKILL'); } catch { /* exact helper already stopped */ } }
        if (message) results = message;
      };
      const timer = setTimeout(() => finish(null, true), timeoutMs);
      try {
        child = spawnProcess(helperPath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
        child.stdout.on('data', (chunk) => {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          outputBytes += data.length;
          if (outputBytes > D3D12_UPLOAD_HEAP_MAX_OUTPUT_BYTES) { overflow = true; finish(null, true); return; }
          stdout += data.toString('utf8');
        });
        child.stdout.once('error', () => finish(null, true));
        // The helper can reject/close stdin before the batch write finishes.
        // Consume EPIPE (and other pipe errors) and stop only this exact child.
        child.stdin.once('error', () => finish(null, true));
        child.once('error', () => finish(null, true));
        child.once('close', (code, signal) => {
          if (code !== 0 || signal || overflow) { finish(); return; }
          finish(parseBatchOutput(stdout, batch.targets));
        });
        child.stdin.end(encodeBatch(batch.targets));
      } catch { finish(null, true); }
    },
    get(target) {
      const key = d3d12TargetKey(target);
      if (!key || !results?.has(key)) return null;
      return results.get(key) ?? null;
    },
  };
}
