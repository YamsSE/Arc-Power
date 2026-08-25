// Registry fallback for the Intel Graphics Software global VRR mode.
//
// Some driver versions expose the VRR feature through IGCL but reject the
// IGCL SET with ERROR_INSUFFICIENT_PERMISSIONS. Intel Graphics Software
// persists the same global mode in the display-class adapter key. This
// module resolves that key by hardware identity before writing it; registry
// enumeration order and the historically common 0000 key are never used as
// identity.

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isElevated } from '../elevation.js';
import { buildElevatedLaunch } from '../igs-service.js';

const execFile = promisify(nodeExecFile);
const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

export const DISPLAY_CLASS_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
export const GLOBAL_VRR_REGISTRY_VALUE = 'Global_VRRWindowedBLT';
export const DISPLAY_3D_KEYS_SUBKEY = '3DKeys';
export const SCALING_STATE_REGISTRY_VALUE = 'NNScalingState';
export const SCALING_STATE_GPU = 0;
export const SCALING_STATE_DISPLAY = 2;

function normalizeHex(value, width = 4) {
  if (value === null || value === undefined || value === '') return null;
  const raw = typeof value === 'number' || typeof value === 'bigint'
    ? Number(value).toString(16)
    : String(value).trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]+$/i.test(raw)) return null;
  return (raw.replace(/^0+/, '') || '0').toLowerCase().padStart(width, '0');
}

function identityOf(device) {
  const vendor = normalizeHex(device?.pciVendorId, 4);
  const id = normalizeHex(device?.pciDeviceId, 4);
  const subsysVendor = normalizeHex(device?.pciSubsysVendorId, 4);
  const subsysId = normalizeHex(device?.pciSubsysId, 4);
  const subsystemTokens = subsysVendor && subsysId
    ? new Set([`${subsysId}${subsysVendor}`, `${subsysVendor}${subsysId}`])
    : new Set();
  return { vendor, id, subsystemTokens };
}

/**
 * Parse the PCI identity encoded by a display-class MatchingDeviceId.
 * MatchingDeviceId is normally `PCI\\VEN_8086&DEV_56A0&SUBSYS_60011849`;
 * REV and other trailing qualifiers are intentionally ignored.
 */
export function parseMatchingDeviceId(value) {
  const text = String(value ?? '').trim();
  const vendor = text.match(/(?:^|[&\\])VEN_([0-9a-f]{4})(?:&|$)/i)?.[1]?.toLowerCase() ?? null;
  const id = text.match(/(?:^|[&\\])DEV_([0-9a-f]{4})(?:&|$)/i)?.[1]?.toLowerCase() ?? null;
  const subsystem = text.match(/(?:^|[&\\])SUBSYS_([0-9a-f]{8})(?:&|$)/i)?.[1]?.toLowerCase() ?? null;
  return { vendor, id, subsystem };
}

/**
 * Resolve one display-class adapter entry for a device.
 *
 * An exact subsystem match wins over a generic VEN/DEV entry. A unique
 * generic entry is accepted when the device has subsystem data but Windows
 * exposes only the generic key. Ambiguous matches fail closed.
 *
 * @param {Array<{ keyPath: string, matchingDeviceId: string }>} entries
 * @param {object} device
 * @returns {{ keyPath: string, matchingDeviceId: string }|null}
 */
export function resolveVrrAdapterEntry(entries, device) {
  const target = identityOf(device);
  if (!target.vendor || !target.id || !Array.isArray(entries)) return null;
  const candidates = entries.filter((entry) => {
    const parsed = parseMatchingDeviceId(entry?.matchingDeviceId);
    return parsed.vendor === target.vendor && parsed.id === target.id;
  });
  if (candidates.length === 0) return null;

  if (target.subsystemTokens.size > 0) {
    const exact = candidates.filter((entry) => target.subsystemTokens.has(parseMatchingDeviceId(entry.matchingDeviceId).subsystem));
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
    // A subsystem-specific entry for another board is never a safe target.
    // Only a unique generic VEN/DEV entry may be used when Windows omitted
    // subsystem data for this adapter.
    const generic = candidates.filter((entry) => parseMatchingDeviceId(entry.matchingDeviceId).subsystem === null);
    return generic.length === 1 ? generic[0] : null;
  }

  const generic = candidates.filter((entry) => parseMatchingDeviceId(entry.matchingDeviceId).subsystem === null);
  return generic.length === 1 ? generic[0] : null;
}

function parseAdapterKeyPaths(stdout, classKey) {
  const normalizeRoot = (value) => String(value).replace(/^HKEY_LOCAL_MACHINE/i, 'HKLM');
  const prefix = `${normalizeRoot(classKey)}\\`;
  return String(stdout ?? '').split(/\r?\n/)
    .map((line) => line.trim())
    .map(normalizeRoot)
    .filter((line) => line.startsWith(prefix) && !line.slice(prefix.length).includes('\\'));
}

function parseMatchingDeviceIdValue(stdout) {
  const match = String(stdout ?? '').match(/^\s*MatchingDeviceId\s+REG_\w+\s+(.+?)\s*$/im);
  return match?.[1]?.trim() ?? null;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function littleEndianDword(value) {
  const n = Number(value) >>> 0;
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function vrrValueKeyPath(adapterKeyPath) {
  const suffix = `\\${DISPLAY_3D_KEYS_SUBKEY}`;
  return String(adapterKeyPath).endsWith(suffix)
    ? String(adapterKeyPath)
    : `${adapterKeyPath}${suffix}`;
}

function parseRegistryBinaryValue(stdout, valueName) {
  const escaped = String(valueName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(stdout ?? '').match(new RegExp(`^\\s*${escaped}\\s+REG_BINARY\\s+([0-9a-f]+)\\s*$`, 'im'));
  if (!match) return null;
  const bytes = match[1].trim().toLowerCase();
  if (bytes.length !== 8) return null;
  const value = Number.parseInt(bytes.match(/../g).reverse().join(''), 16);
  return Number.isInteger(value) ? value : null;
}

async function queryRegistryBinary(exec, keyPath, valueName) {
  const result = await exec('reg', ['query', keyPath, '/v', valueName], { windowsHide: true });
  return parseRegistryBinaryValue(result.stdout, valueName);
}

export function buildVrrRegistryWriteScript(keyPath, value) {
  const reg = 'C:\\Windows\\System32\\reg.exe';
  return [
    `$reg = ${psQuote(reg)}`,
    `& $reg add ${psQuote(keyPath)} /v ${psQuote(GLOBAL_VRR_REGISTRY_VALUE)} /t REG_DWORD /d ${psQuote(`0x${Number(value).toString(16)}`)} /f | Out-Null`,
    'exit $LASTEXITCODE',
  ].join('; ');
}

export function buildScalingStateWriteScript(keyPath, value) {
  const reg = 'C:\\Windows\\System32\\reg.exe';
  const data = littleEndianDword(value);
  return [
    `$reg = ${psQuote(reg)}`,
    `& $reg add ${psQuote(keyPath)} /v ${psQuote(SCALING_STATE_REGISTRY_VALUE)} /t REG_BINARY /d ${psQuote(data)} /f | Out-Null`,
    'exit $LASTEXITCODE',
  ].join('; ');
}

async function queryRegistryAdapters(exec, classKey) {
  const { stdout } = await exec('reg', ['query', classKey], { windowsHide: true });
  const keyPaths = parseAdapterKeyPaths(stdout, classKey);
  const entries = [];
  for (const keyPath of keyPaths) {
    try {
      const result = await exec('reg', ['query', keyPath, '/v', 'MatchingDeviceId'], { windowsHide: true });
      const matchingDeviceId = parseMatchingDeviceIdValue(result.stdout);
      if (matchingDeviceId) entries.push({ keyPath, matchingDeviceId });
    } catch {
      // A stale/partially removed display key is not a usable candidate.
    }
  }
  return entries;
}

async function writeRegistryDword({ exec, keyPath, value, elevated, powershellExe }) {
  const args = ['add', keyPath, '/v', GLOBAL_VRR_REGISTRY_VALUE, '/t', 'REG_DWORD', '/d', `0x${Number(value).toString(16)}`, '/f'];
  if (elevated()) {
    await exec('reg', args, { windowsHide: true });
    return;
  }
  const script = buildVrrRegistryWriteScript(keyPath, value);
  await exec(powershellExe, ['-NoProfile', '-Command', buildElevatedLaunch(script)], { windowsHide: true });
}

async function writeRegistryBinary({ exec, keyPath, valueName, value, elevated, powershellExe }) {
  const data = littleEndianDword(value);
  const args = ['add', keyPath, '/v', valueName, '/t', 'REG_BINARY', '/d', data, '/f'];
  if (elevated()) {
    await exec('reg', args, { windowsHide: true });
    return;
  }
  const script = buildScalingStateWriteScript(keyPath, value);
  await exec(powershellExe, ['-NoProfile', '-Command', buildElevatedLaunch(script)], { windowsHide: true });
}

/**
 * Create the real registry adapter. `queryAdapters` and `writeDword` are
 * injectable seams for tests; the defaults are the real Windows registry.
 */
export function createVrrRegistry(deps = {}) {
  const exec = deps.execFile ?? execFile;
  const classKey = deps.classKey ?? DISPLAY_CLASS_KEY;
  const queryAdapters = deps.queryAdapters ?? (() => queryRegistryAdapters(exec, classKey));
  const elevated = deps.isElevated ?? (() => isElevated());
  const writeDword = deps.writeDword ?? ((args) => writeRegistryDword({ ...args, exec, elevated, powershellExe: deps.powershellExe ?? POWERSHELL_EXE }));
  return {
    async setGlobalVrrMode(device, value) {
      let entries;
      try {
        entries = await queryAdapters(device);
      } catch {
        return { ok: false, errorCode: 'registry-query-failed', message: 'The display adapter registry could not be queried; no VRR value was changed.' };
      }
      const entry = resolveVrrAdapterEntry(entries, device);
      if (!entry) {
        return { ok: false, errorCode: 'registry-target-not-found', message: 'The matching display adapter registry entry could not be resolved; no VRR value was changed.' };
      }
      try {
        const keyPath = vrrValueKeyPath(entry.keyPath);
        const outcome = await writeDword({ keyPath, value, valueName: GLOBAL_VRR_REGISTRY_VALUE, device });
        if (outcome?.ok === false) return outcome;
        return { ok: true, keyPath };
      } catch {
        return { ok: false, errorCode: 'registry-write-failed', message: 'The elevated VRR registry write failed; no VRR value was changed.' };
      }
    },
    async getScalingState(device) {
      let entries;
      try {
        entries = await queryAdapters(device);
      } catch {
        return { ok: false, errorCode: 'registry-query-failed' };
      }
      const entry = resolveVrrAdapterEntry(entries, device);
      if (!entry) return { ok: false, errorCode: 'registry-target-not-found' };
      try {
        const value = await queryRegistryBinary(exec, entry.keyPath, SCALING_STATE_REGISTRY_VALUE);
        if (value !== SCALING_STATE_GPU && value !== SCALING_STATE_DISPLAY) return { ok: false, errorCode: 'registry-value-invalid', keyPath: entry.keyPath };
        return { ok: true, keyPath: entry.keyPath, value };
      } catch {
        return { ok: false, errorCode: 'registry-read-failed', keyPath: entry.keyPath };
      }
    },
    async setScalingState(device, value) {
      if (value !== SCALING_STATE_GPU && value !== SCALING_STATE_DISPLAY) {
        return { ok: false, errorCode: 'registry-value-invalid', message: 'The requested scaling state is not a supported IGS state.' };
      }
      let entries;
      try {
        entries = await queryAdapters(device);
      } catch {
        return { ok: false, errorCode: 'registry-query-failed', message: 'The display adapter registry could not be queried; no scaling value was changed.' };
      }
      const entry = resolveVrrAdapterEntry(entries, device);
      if (!entry) return { ok: false, errorCode: 'registry-target-not-found', message: 'The matching display adapter registry entry could not be resolved; no scaling value was changed.' };
      try {
        await writeRegistryBinary({
          exec,
          keyPath: entry.keyPath,
          valueName: SCALING_STATE_REGISTRY_VALUE,
          value,
          elevated,
          powershellExe: deps.powershellExe ?? POWERSHELL_EXE,
        });
        const readBack = await queryRegistryBinary(exec, entry.keyPath, SCALING_STATE_REGISTRY_VALUE);
        return readBack === value
          ? { ok: true, keyPath: entry.keyPath, value, readBack }
          : { ok: false, errorCode: 'registry-readback-mismatch', keyPath: entry.keyPath, value, readBack, message: 'The scaling registry write did not read back; no scaling value was confirmed.' };
      } catch {
        return { ok: false, errorCode: 'registry-write-failed', message: 'The elevated scaling registry write failed; no scaling value was confirmed.' };
      }
    },
  };
}
