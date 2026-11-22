import { execFile as nodeExecFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { normalizePnpDeviceId, physicalTargetOf, pnpParts } from './gpu-inventory.js';

const execFile = promisify(nodeExecFile);
const SNAPSHOT_TTL_MS = 1500;
const POWERSHELL_PATH = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
let snapshotCache = null;
let snapshotPromise = null;
let snapshotGeneration = 0;

/**
 * One bounded, read-only Windows query. The exact PNP instance ID and its
 * current LocationInfo are collected together so callers can bind a raw
 * IGCL PCI/BDF row to the live Windows device instance.
 */
export function readWindowsPnpLocationSnapshot({
  execFile: run = execFile,
  platform = process.platform,
  now = () => Date.now(),
  maxAgeMs = SNAPSHOT_TTL_MS,
  fresh = false,
} = {}) {
  if (platform !== 'win32') return Promise.resolve([]);
  const cacheEnabled = Number.isFinite(maxAgeMs) && maxAgeMs > 0;
  if (!fresh && cacheEnabled && snapshotCache && now() < snapshotCache.expiresAt) {
    return Promise.resolve(snapshotCache.rows);
  }
  if (!fresh && snapshotPromise) return snapshotPromise;
  {
    // A fresh request supersedes any older in-flight result. Generation checks
    // also prevent a pre-reset request from repopulating the cache.
    const generation = ++snapshotGeneration;
    if (fresh) snapshotCache = null;
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "@(Get-CimInstance Win32_VideoController | ForEach-Object { $id=$_.PNPDeviceID; $loc=$null; try { $loc=(Get-PnpDeviceProperty -InstanceId $id -KeyName DEVPKEY_Device_LocationInfo -ErrorAction Stop).Data } catch {}; [pscustomobject]@{ pnpDeviceId=$id; locationInfo=$loc } }) | ConvertTo-Json -Depth 3 -Compress",
    ].join('; ');
    const pending = Promise.resolve().then(() => run(POWERSHELL_PATH, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
    ], { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 })).then(({ stdout }) => {
      if (!stdout?.trim()) return [];
      const rows = JSON.parse(stdout);
      return (Array.isArray(rows) ? rows : [rows]).filter((row) => typeof row?.pnpDeviceId === 'string');
    }).catch(() => []);
    const tracked = pending.then((rows) => {
      if (generation === snapshotGeneration) {
        if (cacheEnabled && rows.length > 0) snapshotCache = { rows, expiresAt: now() + maxAgeMs };
        else snapshotCache = null;
      }
      return rows;
    }).finally(() => {
      if (snapshotPromise === tracked) snapshotPromise = null;
    });
    snapshotPromise = tracked;
    return tracked;
  }
}

export function resetWindowsPnpLocationSnapshotForTests() {
  snapshotGeneration += 1;
  snapshotCache = null;
  snapshotPromise = null;
}

function writable(device) {
  return device?.synthetic !== true && device?.backendKind !== 'os'
    && device?.identityAmbiguous !== true && Number.isInteger(device?.id)
    && typeof device?.deviceKey === 'string' && device.deviceKey.length > 0;
}

function hasUnsupportedPciSegment(location) {
  if (typeof location !== 'string') return false;
  const declarations = [...location.matchAll(/\b(?:segment|domain)\b/gi)];
  if (declarations.length === 0) return false;
  if (declarations.length !== 1) return true;
  const index = declarations[0].index + declarations[0][0].length;
  const tail = location.slice(index);
  const value = tail.match(/^\s*(?:number\s*)?[:=#]?\s*(0x[0-9a-f]+|\d+)/i);
  if (!value) return true;
  const segment = /^0x/i.test(value[1]) ? Number.parseInt(value[1].slice(2), 16) : Number(value[1]);
  return !Number.isSafeInteger(segment) || segment !== 0;
}

/**
 * Resolve a durable PNP key only through an exact live PNP-instance to BDF
 * bridge. Subsystem/vendor/model equality is insufficient to bind instances.
 * Returns a writable device only when both sides of the bridge are unique.
 */
export function resolvePnpDeviceByLiveLocation(pnpKey, devices, snapshot) {
  const expected = normalizePnpDeviceId(String(pnpKey ?? '').replace(/^pnp:/i, ''));
  const parts = pnpParts(expected);
  const sameModel = (devices ?? []).filter((device) => {
    if (!parts) return false;
    const row = physicalTargetOf(device);
    return row.pciVendorId === parts.ven && row.pciDeviceId === parts.dev;
  });
  if (!expected) return { device: null, ambiguousDevices: [] };
  if (!Array.isArray(snapshot)) return { device: null, ambiguousDevices: sameModel.filter(writable) };
  const exactPnpRows = snapshot.filter((row) => normalizePnpDeviceId(row?.pnpDeviceId ?? row?.instanceId) === expected);
  if (exactPnpRows.length !== 1) {
    return { device: null, ambiguousDevices: sameModel.filter(writable) };
  }
  const location = exactPnpRows[0].locationInfo ?? exactPnpRows[0].location ?? exactPnpRows[0].locationPath;
  // Raw IGCL BDFs omit the PCI segment/domain, so only segment zero can be
  // bridged through the currently supported LocationInfo parser.
  if (hasUnsupportedPciSegment(location)) {
    return { device: null, ambiguousDevices: sameModel.filter(writable) };
  }
  const targetBdf = physicalTargetOf(exactPnpRows[0]).bdf;
  if (!targetBdf) return { device: null, ambiguousDevices: sameModel.filter(writable) };
  const bdfRows = (devices ?? []).filter((device) => physicalTargetOf(device).bdf === targetBdf);
  if (bdfRows.length !== 1 || !writable(bdfRows[0])) {
    return { device: null, ambiguousDevices: sameModel.filter(writable) };
  }
  const candidate = bdfRows[0];
  const pci = physicalTargetOf(candidate);
  if (!parts || pci.pciVendorId !== parts.ven || pci.pciDeviceId !== parts.dev) {
    return { device: null, ambiguousDevices: sameModel.filter(writable) };
  }
  if (parts.subsys && parts.subsys !== '00000000') {
    const normalizePciId = (value) => {
      const text = typeof value === 'number' && Number.isInteger(value)
        ? value.toString(16)
        : typeof value === 'string' ? value.trim().replace(/^0x/i, '') : '';
      return /^[0-9a-f]{1,8}$/i.test(text) ? `0x${text.toLowerCase().slice(-4).padStart(4, '0')}` : null;
    };
    const expectedVendor = `0x${parts.subsys.slice(4).toLowerCase()}`;
    const expectedDevice = `0x${parts.subsys.slice(0, 4).toLowerCase()}`;
    const actualVendor = normalizePciId(candidate.pciSubsysVendorId);
    const actualDevice = normalizePciId(candidate.pciSubsysId);
    const contradicts = (actual, expectedPart) => actual !== null && actual !== '0x0000' && actual !== expectedPart;
    if (contradicts(actualVendor, expectedVendor) || contradicts(actualDevice, expectedDevice)) {
      return { device: null, ambiguousDevices: sameModel.filter(writable) };
    }
  }
  return { device: candidate, ambiguousDevices: [] };
}
