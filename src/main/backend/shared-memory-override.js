// Arc Power - Intel integrated shared GPU/NPU memory override.
//
// Intel Graphics Software persists this control in DxgKrnl's global memory
// manager key rather than through the public IGCL 3D-feature API. The value
// is a system-wide percentage, so the adapter gate belongs to the caller and
// this module only owns the identity-independent registry value.

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isElevated } from '../elevation.js';
import { buildElevatedLaunch } from '../igs-service.js';

const execFile = promisify(nodeExecFile);
const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
export const REG_EXE = 'C:\\Windows\\System32\\reg.exe';

export const GRAPHICS_MEMORY_MANAGER_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers\\MemoryManager';
export const SHARED_MEMORY_OVERRIDE_VALUE = 'SystemPartitionCommitLimitPercentage';
export const SHARED_MEMORY_OVERRIDE_MAX_VALUE = 'SystemPartitionCommitLimitPercentageMax';
export const SHARED_MEMORY_OVERRIDE_MIN = 13;
export const SHARED_MEMORY_OVERRIDE_DEFAULT = 57;
export const SHARED_MEMORY_OVERRIDE_RAM_MIN_BYTES = 10 * 1024 ** 3;
export const SHARED_MEMORY_OVERRIDE_TIMEOUT_MS = 5000;
export const SHARED_MEMORY_OVERRIDE_WRITE_TIMEOUT_MS = 120000;

/** Intel's product gate: Core Ultra Series 2 (200-series) or later. */
export function isCoreUltraSeries2OrLater(cpuName) {
  const match = String(cpuName ?? '').match(/\bCore(?:\s*\([^)]*\))?\s+Ultra(?:\s+\d+)?\s+([2-9]\d{2})[A-Z]{0,3}\b/i);
  return match !== null;
}

/**
 * Shared GPU/NPU Memory Override is not a generic integrated-GPU setting.
 * Keep all eligibility inputs explicit so missing system information fails
 * closed instead of turning a name heuristic into a writable control.
 */
export function sharedMemoryPlatformSupported(device, systemInfo) {
  if (device?.integrated !== true) return false;
  const rawVendor = device?.pciVendorId;
  let vendor = null;
  if (typeof rawVendor === 'number' && Number.isInteger(rawVendor) && rawVendor >= 0 && rawVendor <= 0xffff) {
    vendor = rawVendor.toString(16).padStart(4, '0');
  } else if (typeof rawVendor === 'string') {
    const trimmed = rawVendor.trim().toLowerCase();
    const rawHex = trimmed.replace(/^0x/, '');
    // Device identity decoders may return either a 16-bit value or the
    // zero-padded DWORD form (for example 0x00008086). Normalize both to
    // the canonical four-digit PCI vendor id before applying the gate.
    if (/^[0-9a-f]{1,8}$/.test(rawHex)) {
      const hex = rawHex.replace(/^0+(?=[0-9a-f])/, '');
      if (hex.length <= 4) vendor = hex.padStart(4, '0');
    }
  }
  if (vendor !== '8086') return false;
  const cpuName = systemInfo?.cpu?.name;
  const totalBytes = systemInfo?.ram?.totalBytes;
  return isCoreUltraSeries2OrLater(cpuName)
    && Number.isInteger(totalBytes)
    && totalBytes >= SHARED_MEMORY_OVERRIDE_RAM_MIN_BYTES;
}

/** Copy only the bounded CPU/RAM fields trusted by the parent process. */
export function trustedCpuRamSnapshotOf(systemInfo) {
  const cpuName = typeof systemInfo?.cpu?.name === 'string' ? systemInfo.cpu.name.slice(0, 256) : null;
  const totalBytes = Number.isSafeInteger(systemInfo?.ram?.totalBytes)
    && systemInfo.ram.totalBytes > 0
    && systemInfo.ram.totalBytes <= 1024 ** 5
    ? systemInfo.ram.totalBytes
    : null;
  return cpuName || totalBytes !== null ? { cpu: { name: cpuName }, ram: { totalBytes } } : null;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Parse one REG_DWORD line from reg.exe without trusting locale text. */
export function parseRegistryDword(stdout, valueName) {
  const escaped = String(valueName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(stdout ?? '').match(new RegExp(`^\\s*${escaped}\\s+REG_DWORD\\s+(.+?)\\s*$`, 'im'));
  if (!match) return null;
  const raw = match[1].trim();
  const value = /^0x[0-9a-f]+$/i.test(raw) ? Number.parseInt(raw.slice(2), 16) : Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff ? value : null;
}

export function buildSharedMemoryWriteScript({ enabled, percentage }) {
  const reg = 'C:\\Windows\\System32\\reg.exe';
  const key = psQuote(GRAPHICS_MEMORY_MANAGER_KEY);
  const value = psQuote(SHARED_MEMORY_OVERRIDE_VALUE);
  if (enabled === true) {
    return [
      `$reg = ${psQuote(reg)}`,
      `& $reg add ${key} /v ${value} /t REG_DWORD /d ${psQuote(String(percentage))} /f | Out-Null`,
      'exit $LASTEXITCODE',
    ].join('; ');
  }
  return [
    `$reg = ${psQuote(reg)}`,
    `& $reg delete ${key} /v ${value} /f | Out-Null`,
    // reg.exe returns 1 when the value was already absent. That is the
    // desired disabled state, so normalize that result to success.
    'if ($LASTEXITCODE -eq 1) { exit 0 }; exit $LASTEXITCODE',
  ].join('; ');
}

function validPercentage(value, max = 100) {
  return Number.isInteger(value)
    && value >= SHARED_MEMORY_OVERRIDE_MIN
    && value <= max;
}

async function queryDword(exec, valueName) {
  try {
    const result = await exec(REG_EXE, ['query', GRAPHICS_MEMORY_MANAGER_KEY, '/v', valueName], {
      windowsHide: true,
      timeout: SHARED_MEMORY_OVERRIDE_TIMEOUT_MS,
    });
    return parseRegistryDword(result.stdout, valueName);
  } catch (err) {
    if (err?.code === 1 || err?.code === '1') return null;
    if (err?.code === 'ETIMEDOUT' || err?.killed === true) throw Object.assign(new Error('reg.exe query timed out'), { code: 'ETIMEDOUT' });
    throw Object.assign(new Error('reg.exe query failed'), { code: 'EIO', cause: err });
  }
}

async function writeOverride({ exec, elevated, enabled, percentage, powershellExe }) {
  const key = GRAPHICS_MEMORY_MANAGER_KEY;
  const value = SHARED_MEMORY_OVERRIDE_VALUE;
  if (elevated()) {
    if (enabled === true) {
      await exec(REG_EXE, ['add', key, '/v', value, '/t', 'REG_DWORD', '/d', String(percentage), '/f'], {
        windowsHide: true,
        timeout: SHARED_MEMORY_OVERRIDE_WRITE_TIMEOUT_MS,
      });
    } else {
      try {
        await exec(REG_EXE, ['delete', key, '/v', value, '/f'], {
          windowsHide: true,
          timeout: SHARED_MEMORY_OVERRIDE_WRITE_TIMEOUT_MS,
        });
      } catch (err) {
        // Deleting an already-absent override is an idempotent disable.
        if (err?.code !== 1) throw err;
      }
    }
    return;
  }
  const script = buildSharedMemoryWriteScript({ enabled, percentage });
  await exec(powershellExe, ['-NoProfile', '-Command', buildElevatedLaunch(script)], {
    windowsHide: true,
    timeout: SHARED_MEMORY_OVERRIDE_WRITE_TIMEOUT_MS,
  });
}

/**
 * Create the registry adapter. Product code uses the real Windows registry;
 * tests inject query/write seams and therefore never touch the host.
 */
export function createSharedMemoryOverride(deps = {}) {
  const exec = deps.execFile ?? execFile;
  const elevated = deps.isElevated ?? (() => isElevated());
  const queryValue = deps.queryValue ?? ((valueName) => queryDword(exec, valueName));
  const writeValue = deps.writeValue ?? ((args) => writeOverride({
    ...args,
    exec,
    elevated,
    powershellExe: deps.powershellExe ?? POWERSHELL_EXE,
  }));

  return {
    async read(device) {
      if (device?.integrated !== true) return null;
      const configured = await queryValue(SHARED_MEMORY_OVERRIDE_VALUE);
      const configuredMax = await queryValue(SHARED_MEMORY_OVERRIDE_MAX_VALUE);
      // DxgKrnl documents the max value as runtime-provided. Never invent a
      // ceiling: without it the control is not safely writable.
      if (!validPercentage(configuredMax, 100)) return null;
      const max = configuredMax;
      const percentage = validPercentage(configured, max) ? configured : Math.min(SHARED_MEMORY_OVERRIDE_DEFAULT, max);
      return {
        enabled: validPercentage(configured, max),
        percentage,
        range: { min: SHARED_MEMORY_OVERRIDE_MIN, max, step: 1, default: Math.min(SHARED_MEMORY_OVERRIDE_DEFAULT, max) },
        requiresRestart: true,
        source: 'dxgkrnl-memory-manager',
      };
    },

    async set(device, settings) {
      if (device?.integrated !== true) {
        return { ok: false, errorCode: 'unsupported', message: 'Shared GPU/NPU Memory Override is only available on integrated Intel graphics.' };
      }
      const enabled = settings?.enabled === true;
      let current;
      try {
        current = await this.read(device);
      } catch (err) {
        const timedOut = err?.code === 'ETIMEDOUT' || err?.killed === true;
        return {
          ok: false,
          errorCode: timedOut ? 'timeout' : 'io-failed',
          message: timedOut
            ? 'The Windows graphics-memory read timed out; no change was attempted.'
            : 'The current shared-memory limit could not be read; no change was attempted.',
        };
      }
      if (!current?.range || !validPercentage(current.range.max, 100)) {
        return { ok: false, errorCode: 'unavailable-symbol', message: 'The driver did not provide a safe shared-memory limit.' };
      }
      const max = current.range.max;
      const percentage = Number(settings?.percentage);
      if (enabled && !validPercentage(percentage, max)) {
        return { ok: false, errorCode: 'out-of-range', message: `Memory limit must be between ${SHARED_MEMORY_OVERRIDE_MIN}% and ${max}%.` };
      }
      try {
        await writeValue({ enabled, percentage: validPercentage(percentage, max) ? percentage : Math.min(SHARED_MEMORY_OVERRIDE_DEFAULT, max) });
      } catch (err) {
        const timedOut = err?.code === 'ETIMEDOUT' || err?.killed === true;
        return {
          ok: false,
          errorCode: timedOut ? 'timeout' : 'permission-denied',
          message: timedOut
            ? 'The Windows graphics-memory operation timed out; no change was confirmed.'
            : 'The elevated memory override write failed; no change was confirmed.',
        };
      }
      try {
        const readBack = await this.read(device);
        const readBackEqual = enabled === readBack?.enabled
          && (!enabled || percentage === readBack?.percentage);
        return {
          ok: readBackEqual,
          readBackEqual,
          requiresRestart: true,
          errorCode: readBackEqual ? undefined : 'io-failed',
          message: readBackEqual ? undefined : 'The memory override was written but could not be confirmed.',
        };
      } catch (err) {
        const timedOut = err?.code === 'ETIMEDOUT' || err?.killed === true;
        return {
          ok: false,
          errorCode: timedOut ? 'timeout' : 'io-failed',
          message: timedOut
            ? 'The Windows graphics-memory operation timed out; no change was confirmed.'
            : 'The elevated memory override write failed; no change was confirmed.',
        };
      }
    },
  };
}
