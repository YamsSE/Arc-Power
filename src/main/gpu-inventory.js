// Arc Power - M30 unified Windows/IGCL GPU inventory.
//
// The renderer uses a short-lived session id.  This module makes that id a
// route into one durable identity, and keeps OS-only adapters read-only.  The
// PNP id is deliberately the primary identity: PCI/BDF is only a fallback.

import { deviceHardwareKey } from './backend/units.js';

const NULL_STATE = Object.freeze({
  powerLimitW: null,
  gpuVoltOffsetV: null,
  gpuFreqOffsetMhz: null,
  tempLimitC: null,
  vramFreqOffsetGts: null,
  vramVoltOffsetV: null,
  gpuLock: null,
  vfCurve: null,
  fanMode: null,
  fanCurve: null,
  fixedFanPct: null,
});

export function normalizePnpDeviceId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/[\u0000\s]+/g, '').toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

export function pnpParts(value) {
  const pnp = normalizePnpDeviceId(value);
  if (!pnp) return null;
  const ven = pnp.match(/(?:^|\\|&)VEN_([0-9A-F]{4})/i)?.[1];
  const dev = pnp.match(/(?:^|\\|&)DEV_([0-9A-F]{4})/i)?.[1];
  const subsys = pnp.match(/(?:^|\\|&)SUBSYS_([0-9A-F]{8})/i)?.[1] ?? null;
  return ven && dev ? { ven: `0x${ven.toLowerCase()}`, dev: `0x${dev.toLowerCase()}`, subsys } : null;
}

function vendorOf(pnp, name = '') {
  const parts = pnpParts(pnp);
  if (parts?.ven === '0x8086' || /\bintel\b/i.test(name)) return 'intel';
  if (parts?.ven === '0x1002' || /\bamd\b|radeon/i.test(name)) return 'amd';
  if (parts?.ven === '0x10de' || /nvidia|geforce|quadro|tesla/i.test(name)) return 'nvidia';
  return 'unknown';
}

function normalizeName(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function pciId(value) {
  const text = typeof value === 'number' && Number.isInteger(value)
    ? value.toString(16)
    : typeof value === 'string' ? value.trim().replace(/^0x/i, '') : '';
  if (!/^[0-9a-f]{1,8}$/i.test(text)) return null;
  // PCI vendor/device identifiers are 16-bit values.  IGCL may expose them
  // as zero-padded 32-bit strings while PNP ids expose the canonical 4-digit
  // value; normalize both representations before fallback matching.
  return `0x${text.toLowerCase().slice(-4).padStart(4, '0')}`;
}

function bdfKey(value) {
  if (typeof value === 'string') {
    const match = value.trim().match(/^(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,2}):([0-9a-f]{1,2})\.([0-7])$/i);
    if (match) return `${Number.parseInt(match[1] ?? '0', 16).toString(16).padStart(4, '0')}:${Number.parseInt(match[2], 16).toString(16).padStart(2, '0')}:${Number.parseInt(match[3], 16).toString(16).padStart(2, '0')}.${match[4]}`;
    const location = value.match(/\bbus\s*(\d+)\s*,?\s*device\s*(\d+)\s*,?\s*function\s*(\d+)/i);
    if (location) return `0000:${Number(location[1]).toString(16).padStart(2, '0')}:${Number(location[2]).toString(16).padStart(2, '0')}.${location[3]}`;
  }
  if (value && typeof value === 'object') {
    const bus = Number(value.bus);
    const device = Number(value.device);
    const fn = Number(value.function ?? value.func ?? 0);
    const domain = Number(value.domain ?? value.segment ?? 0);
    if ([bus, device, fn, domain].every(Number.isInteger) && bus >= 0 && device >= 0 && fn >= 0 && domain >= 0) {
      return `${domain.toString(16).padStart(4, '0')}:${bus.toString(16).padStart(2, '0')}:${device.toString(16).padStart(2, '0')}.${fn}`;
    }
  }
  return null;
}
function legacyKeyOf(vendorId, deviceId, rawBdf) {
  const normalized = bdfKey(rawBdf);
  const match = normalized?.match(/^([0-9a-f]{4}):([0-9a-f]{2}):([0-9a-f]{2})\.([0-7])$/i);
  if (!match) return null;
  return deviceHardwareKey({
    pciVendorId: vendorId,
    pciDeviceId: deviceId,
    bdf: {
      bus: Number.parseInt(match[2], 16),
      device: Number.parseInt(match[3], 16),
      function: Number.parseInt(match[4], 10),
    },
  });
}


function physicalParts(value) {
  const pnp = pnpParts(value?.pnpDeviceId);
  return {
    pnp: normalizePnpDeviceId(value?.pnpDeviceId),
    ven: pnp?.ven ?? pciId(value?.pciVendorId),
    dev: pnp?.dev ?? pciId(value?.pciDeviceId),
    bdf: bdfKey(value?.bdf ?? value?.location ?? value?.locationInfo ?? value?.locationPath),
    luid: value?.luid ?? value?.adapterLuid ?? null,
    token: value?.physicalToken ?? value?.uniqueToken ?? value?.adapterUuid ?? value?.uuid ?? null,
  };
}

function controllerKey(controller, ordinal) {
  const pnp = normalizePnpDeviceId(controller?.pnpDeviceId);
  if (pnp) return `pnp:${pnp}`;
  const parts = physicalParts(controller);
  if (parts.ven && parts.dev && parts.bdf) return `pci:${parts.ven}:${parts.dev}@${parts.bdf}`;
  if (parts.luid !== null && parts.luid !== undefined) return `luid:${JSON.stringify(parts.luid)}`;
  if (parts.token !== null && parts.token !== undefined) return `token:${String(parts.token)}`;
  if (parts.ven && parts.dev) return `pci:${parts.ven}:${parts.dev}`;
  return `os:${normalizeName(controller?.name) || 'gpu'}:${ordinal}`;
}

function igclMatchesController(device, controller) {
  const dpnp = normalizePnpDeviceId(device?.pnpDeviceId);
  const cpnp = normalizePnpDeviceId(controller?.pnpDeviceId);
  if (dpnp && cpnp) {
    if (dpnp !== cpnp) return 0;
    // PNP is primary, but duplicate firmware PNP strings need a stable
    // secondary score so distinct IGCL/OS rows can still be joined one-to-one.
    let score = 100;
    if (normalizeName(device?.name) && normalizeName(device?.name) === normalizeName(controller?.name)) score += 8;
    const dParts = physicalParts(device);
    const cParts = physicalParts(controller);
    if (dParts.bdf && cParts.bdf && dParts.bdf === cParts.bdf) score += 4;
    if (dParts.luid !== null && cParts.luid !== null && JSON.stringify(dParts.luid) === JSON.stringify(cParts.luid)) score += 3;
    if (dParts.token !== null && cParts.token !== null && String(dParts.token) === String(cParts.token)) score += 3;
    return score;
  }
  const dParts = physicalParts(device);
  const cParts = physicalParts(controller);
  if (dParts.bdf && cParts.bdf && dParts.bdf === cParts.bdf) return 95;
  if (dParts.ven && dParts.dev && cParts.ven === dParts.ven && cParts.dev === dParts.dev) return 80;
  if (dParts.luid !== null && cParts.luid !== null && JSON.stringify(dParts.luid) === JSON.stringify(cParts.luid)) return 90;
  if (normalizeName(device?.name) && normalizeName(device?.name) === normalizeName(controller?.name)) return 40;
  return 0;
}

function uniqueKey(base, used) {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base}#${n}`)) n += 1;
  const key = `${base}#${n}`;
  used.add(key);
  return key;
}

function isRealController(controller) {
  const p = physicalParts(controller);
  const name = String(controller?.name ?? '');
  return Boolean(p?.ven === '0x8086' || p?.ven === '0x1002' || p?.ven === '0x10de'
    || /\bintel\b|arc|iris|uhd|radeon|amd|nvidia|geforce|quadro|tesla/i.test(name))
    && !/microsoft basic|displaylink/i.test(name);
}

function osControllerOf(controller) {
  if (!controller) return null;
  return {
    name: typeof controller.name === 'string' ? controller.name : null,
    vramBytes: Number.isInteger(controller.vramBytes) && controller.vramBytes > 0 ? controller.vramBytes : null,
    pnpDeviceId: normalizePnpDeviceId(controller.pnpDeviceId),
    pciVendorId: pciId(controller.pciVendorId) ?? pnpParts(controller.pnpDeviceId)?.ven ?? null,
    pciDeviceId: pciId(controller.pciDeviceId) ?? pnpParts(controller.pnpDeviceId)?.dev ?? null,
    bdf: bdfKey(controller.bdf ?? controller.location ?? controller.locationInfo ?? controller.locationPath),
    driverVersion: typeof controller.driverVersion === 'string' ? controller.driverVersion : null,
    rebarActive: controller.rebarActive === true ? true : controller.rebarActive === false ? false : null,
    luid: controller.luid ?? controller.adapterLuid ?? null,
    physicalToken: controller.physicalToken ?? controller.uniqueToken ?? controller.adapterUuid ?? controller.uuid ?? null,
  };
}

function mergedPhysicalParts(device, controller) {
  const backendParts = physicalParts(device);
  const controllerParts = physicalParts(controller);
  return {
    pnp: backendParts.pnp ?? controllerParts.pnp,
    ven: backendParts.ven ?? controllerParts.ven,
    dev: backendParts.dev ?? controllerParts.dev,
    bdf: backendParts.bdf ?? controllerParts.bdf,
    luid: backendParts.luid ?? controllerParts.luid,
    token: backendParts.token ?? controllerParts.token,
  };
}

/**
 * Build a one-to-one inventory.  IGCL entries are matched first; an OS row
 * can be consumed by at most one IGCL row.  Every remaining real OS row is
 * appended as an OS-only read-only entry.
 */
export function buildGpuInventory({ backendDevices = [], videoControllers = [], backendKind = 'igcl' } = {}) {
  const controllers = (Array.isArray(videoControllers) ? videoControllers : []).filter(isRealController);
  const usedControllers = new Set();
  const usedKeys = new Set();
  const rows = [];
  const igcl = Array.isArray(backendDevices) ? backendDevices : [];

  for (let backendIndex = 0; backendIndex < igcl.length; backendIndex += 1) {
    const device = igcl[backendIndex];
    const candidates = controllers.map((controller, i) => ({ i, score: usedControllers.has(i) ? 0 : igclMatchesController(device, controller) }))
      .filter((candidate) => candidate.score > 0);
    const bestScore = Math.max(0, ...candidates.map((candidate) => candidate.score));
    const bestCandidates = candidates.filter((candidate) => candidate.score === bestScore);
    // Never associate two physically indistinguishable controllers by their
    // enumeration order.  An unresolved OS association is safer than
    // presenting another adapter's LUID/ReBAR/readouts under this row.
    const best = bestCandidates.length === 1 ? bestCandidates[0].i : -1;
    if (best >= 0) usedControllers.add(best);
    const controller = best >= 0 ? controllers[best] : null;
    const parts = mergedPhysicalParts(device, controller);
    const pnp = parts.pnp;
    const base = pnp ? `pnp:${pnp}` : parts.ven && parts.dev && parts.bdf
      ? `pci:${parts.ven}:${parts.dev}@${parts.bdf}`
      : parts.luid !== null && parts.luid !== undefined
        ? `luid:${JSON.stringify(parts.luid)}`
        : parts.token !== null && parts.token !== undefined
          ? `token:${String(parts.token)}`
          : `pci:${parts.ven ?? 'unknown'}:${parts.dev ?? 'unknown'}`;
    rows.push({
      ...device,
      id: rows.length,
      sessionId: rows.length,
      backendId: Number.isInteger(device?.id) ? device.id : backendIndex,
      backendKind,
      synthetic: false,
      deviceKey: null,
      identityBase: base,
      identityTie: JSON.stringify([device?.name ?? '', parts.ven, parts.dev, parts.bdf, parts.luid, parts.token]),
      pnpDeviceId: pnp,
      gpuVendor: vendorOf(pnp, device?.name),
      pciVendorId: device?.pciVendorId ?? parts.ven ?? null,
      pciDeviceId: device?.pciDeviceId ?? parts.dev ?? null,
      bdf: device?.bdf ?? parts.bdf ?? null,
      physicalToken: parts.token,
      osController: osControllerOf(controller),
      osLuid: controller?.luid ?? controller?.adapterLuid ?? null,
    });
  }

  controllers.forEach((controller, index) => {
    if (usedControllers.has(index)) return;
    const parts = physicalParts(controller);
    const pnp = normalizePnpDeviceId(controller?.pnpDeviceId);
    const base = controllerKey(controller, index);
    const parsedVendor = parts?.ven ?? '';
    const vendor = vendorOf(pnp, controller?.name);
    const pciVendorId = parts?.ven ?? (parsedVendor ? `0x${parsedVendor}` : '0x00000000');
    const pciDeviceId = parts?.dev ?? '0x00000000';
    rows.push({
      id: rows.length,
      sessionId: rows.length,
      backendId: null,
      backendKind: 'os',
      synthetic: true,
      deviceKey: null,
      identityBase: base,
      identityTie: JSON.stringify([controller?.name ?? '', controller?.pnpDeviceId ?? '', controller?.luid ?? controller?.adapterLuid ?? null]),
      pnpDeviceId: pnp,
      gpuVendor: vendor,
      vendorIndex: controllers.slice(0, index).filter((c) => vendorOf(c?.pnpDeviceId, c?.name) === vendor).length,
      name: controller?.name ?? 'GPU',
      type: 'GRAPHICS',
      pciVendorId,
      pciDeviceId,
      revId: 0,
      bdf: parts.bdf ?? null,
      driverVersion: controller?.driverVersion ?? '',
      graphicsClockMHz: 0,
      numXeCores: 0,
      vramBytes: controller?.vramBytes ?? null,
      memType: null,
      osController: osControllerOf(controller),
      osLuid: controller?.luid ?? controller?.adapterLuid ?? null,
      physicalToken: parts.token,
    });
  });

  // PNP is the primary identity. If malformed firmware reports the same PNP
  // string twice, assign the collision suffix from a deterministic secondary
  // signature rather than enumeration order so a reorder cannot swap keys.
  const byBase = new Map();
  for (const row of rows) {
    const list = byBase.get(row.identityBase) ?? [];
    list.push(row);
    byBase.set(row.identityBase, list);
  }
  for (const [base, list] of byBase) {
    const pnpIdentities = list.map((row) => normalizePnpDeviceId(row.pnpDeviceId)).filter(Boolean);
    const duplicatePnp = list.length > 1
      && pnpIdentities.length === list.length
      && new Set(pnpIdentities).size === 1;
    const stableSecondary = (row) => {
      const parts = physicalParts({
        ...row,
        luid: row.osLuid ?? row.osController?.luid,
        physicalToken: row.physicalToken ?? row.osController?.physicalToken,
      });
      if (parts.bdf) return `bdf:${parts.bdf}`;
      if (parts.luid !== null && parts.luid !== undefined && parts.luid !== '') return `luid:${JSON.stringify(parts.luid)}`;
      if (parts.token !== null && parts.token !== undefined && parts.token !== '') return `token:${String(parts.token)}`;
      return null;
    };
    const secondaryKeys = list.map(stableSecondary);
    const hasUniqueStableSecondary = secondaryKeys.every(Boolean)
      && new Set(secondaryKeys).size === secondaryKeys.length;
    if (duplicatePnp && !hasUniqueStableSecondary) {
      // A duplicate PNP string plus names (or any other non-physical hint)
      // does not prove which provider row is which adapter. Keep the rows
      // visible for inspection, but never turn enumeration order or a rename
      // into a durable writable identity.
      for (const row of list) {
        row.deviceKey = null;
        row.identityAmbiguous = true;
      }
      continue;
    }
    const hasNoPnp = list.every((row) => !normalizePnpDeviceId(row.pnpDeviceId));
    if (list.length > 1 && hasNoPnp && !hasUniqueStableSecondary) {
      // A same-vendor/device duplicate with no PNP, BDF, LUID, or provider
      // token has no durable identity. Keep the rows visible for read-only
      // inspection, but never manufacture an ordinal collision key that can
      // move to another adapter after provider reorder.
      for (const row of list) {
        row.deviceKey = null;
        row.identityAmbiguous = true;
      }
      continue;
    }
    // Collision suffixes are sorted only by physical proof. Names are not a
    // durable tie-breaker: a driver rename must not move #2 to another GPU.
    list.sort((a, b) => String(stableSecondary(a) ?? a.identityTie).localeCompare(String(stableSecondary(b) ?? b.identityTie)));
    list.forEach((row, index) => {
      row.deviceKey = index === 0 ? base : `${base}#${index + 1}`;
    });
  }
  for (const row of rows) {
    delete row.identityBase;
    delete row.identityTie;
  }

  const vendorCounts = new Map();
  for (const row of rows) {
    const vendor = row.gpuVendor;
    const next = vendorCounts.get(vendor) ?? 0;
    if (row.vendorIndex === undefined || row.vendorIndex < next) row.vendorIndex = next;
    vendorCounts.set(vendor, Math.max(next, row.vendorIndex + 1));
  }
  for (const row of rows) row.vendorCount = vendorCounts.get(row.gpuVendor) ?? 0;

  return rows;
}

function syntheticCapabilities(device) {
  return {
    oemName: device.gpuVendor ? `${device.gpuVendor} (Windows)` : 'Windows GPU',
    deviceName: device.name,
    deviceKey: device.deviceKey,
    memType: device.memType ?? null,
    waiverAccepted: false,
    overclockingSupported: false,
    controls: {
      gpuFreqOffset: false, gpuVoltOffset: false, gpuLock: false,
      vramFreqOffset: false, vramVoltOffset: false, powerLimit: false,
      tempLimit: false, vfCurve: false,
    },
    ranges: {},
    fan: { canControl: false, modes: [], maxRpm: 0, maxCurvePoints: 0 },
    pciDeviceId: device.pciDeviceId ?? null,
    aibVendor: null,
    aibModel: null,
  };
}

function unsupportedResult(settings) {
  const perControl = {};
  for (const key of Object.keys(settings ?? {})) {
    perControl[key] = { ok: false, errorCode: 'unsupported', message: 'overclocking is not supported on this GPU' };
  }
  return { ok: Object.keys(perControl).length === 0, perControl };
}

export function nullDeviceState() {
  return { ...NULL_STATE };
}

export function physicalTargetOf(device) {
  if (!device) return null;
  const controller = device.osController ?? null;
  // Accept raw IGCL object BDFs, already-normalized strings, and Windows
  // LocationInfo strings at this boundary. The elevated worker may receive
  // any of these shapes after JSON serialization.
  const rawBdf = device.bdf
    ?? device.location
    ?? device.locationInfo
    ?? device.locationPath
    ?? controller?.bdf
    ?? controller?.location
    ?? controller?.locationInfo
    ?? controller?.locationPath;
  const rawVendorId = device.pciVendorId ?? controller?.pciVendorId;
  const rawDeviceId = device.pciDeviceId ?? controller?.pciDeviceId;
  // The unified inventory key is PNP-first, but the bundled 2023 runtime
  // still enumerates its own PCI/BDF key. Preserve that legacy key in the
  // physical proof so extended PL/TL writes can target the same adapter
  // after the M30 identity migration (including the elevated JSON boundary).
  const legacyDeviceKey = legacyKeyOf(rawVendorId, rawDeviceId, rawBdf);
  return {
    pnpDeviceId: normalizePnpDeviceId(device.pnpDeviceId ?? controller?.pnpDeviceId),
    pciVendorId: pciId(rawVendorId),
    pciDeviceId: pciId(rawDeviceId),
    bdf: bdfKey(rawBdf),
    osLuid: device.osLuid ?? controller?.luid ?? device.luid ?? device.adapterLuid ?? null,
    controllerBdf: bdfKey(controller?.bdf),
    controllerLuid: controller?.luid ?? controller?.adapterLuid ?? null,
    physicalToken: device.physicalToken ?? controller?.physicalToken ?? device.uniqueToken ?? device.adapterUuid ?? device.uuid ?? null,
    legacyDeviceKey,
    synthetic: device.synthetic === true,
  };
}

export function physicalTargetMatches(device, proof, inventory = [device]) {
  const actual = physicalParts({
    ...device,
    bdf: device.bdf ?? device.osController?.bdf,
    luid: device.osLuid ?? device.osController?.luid ?? device.luid,
    physicalToken: device.physicalToken ?? device.osController?.physicalToken,
  });
  const expected = physicalParts({
    ...proof,
    bdf: proof?.bdf ?? proof?.controllerBdf,
    luid: proof?.osLuid ?? proof?.controllerLuid ?? proof?.luid ?? proof?.adapterLuid,
    physicalToken: proof?.physicalToken ?? proof?.uniqueToken,
  });
  // PNP is the strongest identity when both sides expose it. A worker-side
  // IGCL row can legitimately omit PNP even though the parent Windows row
  // supplied it in the proof, so a missing actual PNP is resolved by the
  // remaining physical proof or the unique vendor/device fallback below.
  if (expected.pnp && actual.pnp && expected.pnp !== actual.pnp) return false;
  const pnpCount = expected.pnp && actual.pnp
    ? inventory.filter((row) => normalizePnpDeviceId(row?.pnpDeviceId ?? row?.osController?.pnpDeviceId) === actual.pnp).length
    : 0;
  const strong = [
    ['bdf', expected.bdf, actual.bdf],
    ['luid', expected.luid, actual.luid],
    ['token', expected.token, actual.token],
  ].filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (expected.pnp && actual.pnp && expected.pnp === actual.pnp) {
    // PNP is the primary durable identity. An exact PNP proof is sufficient
    // when this inventory has one row with that PNP. Duplicate PNP rows need
    // a matching, present secondary identity that uniquely selects one row;
    // names, ordinals, and missing/conflicting secondary data are not proof.
    if (pnpCount === 1) {
      return strong.every(([kind, expectedValue, actualValue]) => {
        if (actualValue === null || actualValue === undefined || actualValue === '') return true;
        return kind === 'luid'
          ? JSON.stringify(expectedValue) === JSON.stringify(actualValue)
          : expectedValue === actualValue;
      });
    }
    if (pnpCount < 2 || strong.length === 0) return false;
    if (!strong.every(([kind, expectedValue, actualValue]) => {
      if (actualValue === null || actualValue === undefined || actualValue === '') return false;
      return kind === 'luid'
        ? JSON.stringify(expectedValue) === JSON.stringify(actualValue)
        : expectedValue === actualValue;
    })) return false;
    const duplicateRows = inventory.filter((row) => normalizePnpDeviceId(
      row?.pnpDeviceId ?? row?.osController?.pnpDeviceId,
    ) === actual.pnp);
    return strong.some(([kind, expectedValue]) => {
      const matching = duplicateRows.filter((row) => {
        const rowParts = physicalParts({
          ...row,
          bdf: row.bdf ?? row.osController?.bdf,
          luid: row.osLuid ?? row.osController?.luid ?? row.luid,
          physicalToken: row.physicalToken ?? row.osController?.physicalToken,
        });
        const value = rowParts[kind];
        return value !== null && value !== undefined && value !== ''
          && (kind === 'luid'
            ? JSON.stringify(value) === JSON.stringify(expectedValue)
            : value === expectedValue);
      });
      return matching.length === 1;
    });
  }
  if (strong.length > 0) {
    return strong.every(([kind, expectedValue, actualValue]) => kind === 'luid'
      ? actualValue !== null && actualValue !== undefined && JSON.stringify(expectedValue) === JSON.stringify(actualValue)
      : actualValue === expectedValue);
  }
  const duplicateCount = inventory.filter((row) => {
    const parts = physicalParts({
      ...row,
      luid: row.osLuid ?? row.osController?.luid,
      physicalToken: row.physicalToken ?? row.osController?.physicalToken,
    });
    return parts.ven === expected.ven && parts.dev === expected.dev;
  }).length;
  return duplicateCount === 1;
}

/** Wrap an IOCBackend so every device-scoped call uses the inventory route. */
export function createUnifiedGpuBackend({ backend, sysinfo, videoControllers = null } = {}) {
  if (!backend) throw new Error('createUnifiedGpuBackend requires a backend');
  let inventory = [];
  let refreshPromise = null;
  let buildingInventory = false;
  let lastSysinfo = null;
  const routes = new Map();
  const sessionIds = new Map();
  const retiredIds = new Set();
  let nextSessionId = 0;
  let initialized = false;
  const getSysinfo = async () => {
    if (Array.isArray(videoControllers)) return { videoControllers };
    // createDriverReBar asks the backend for a device list while the lazy
    // sysinfo adapter is still resolving. Returning the last snapshot here
    // avoids a recursive refresh/deadlock; the next refresh sees the full
    // controller list.
    // During the first refresh there is no snapshot to return yet.  The
    // provider must still run so the IGCL row can join its Windows controller
    // (including ReBAR state).  Once a snapshot exists, keep the re-entrancy
    // guard to avoid the recursive refresh/deadlock path.
    if (buildingInventory && lastSysinfo !== null) return lastSysinfo;
    try { return typeof sysinfo?.get === 'function' ? await sysinfo.get() : sysinfo; } catch { return null; }
  };
  const refresh = async () => {
    if (refreshPromise) return buildingInventory ? inventory : refreshPromise;
    refreshPromise = (async () => {
      buildingInventory = true;
      let backendDevices = [];
      try { backendDevices = await backend.listDevices(); } catch { backendDevices = []; }
      const info = await getSysinfo();
      lastSysinfo = info ?? lastSysinfo;
      const fresh = buildGpuInventory({ backendDevices, videoControllers: info?.videoControllers ?? [], backendKind: backend.kind ?? 'igcl' });
      const used = new Set();
      for (const row of fresh) {
        const durableKey = typeof row.deviceKey === 'string' && row.deviceKey.length > 0 ? row.deviceKey : null;
        const prior = durableKey === null ? null : sessionIds.get(durableKey);
        if (Number.isInteger(prior) && !used.has(prior)) {
          row.id = prior;
          row.sessionId = prior;
          used.add(prior);
        }
      }
      for (const row of fresh) {
        const durableKey = typeof row.deviceKey === 'string' && row.deviceKey.length > 0 ? row.deviceKey : null;
        if (durableKey !== null && sessionIds.has(durableKey)) continue;
        const preferred = !initialized && Number.isInteger(row.backendId) && row.backendId >= 0
          ? row.backendId : null;
        let id = preferred !== null && !retiredIds.has(preferred) && !used.has(preferred) ? preferred : nextSessionId;
        while (used.has(id) || retiredIds.has(id)) id += 1;
        row.id = id;
        row.sessionId = id;
        used.add(id);
      }
      for (const old of inventory) if (!fresh.some((row) => row.deviceKey === old.deviceKey)) retiredIds.add(old.id);
      for (const row of fresh) {
        if (typeof row.deviceKey === 'string' && row.deviceKey.length > 0) sessionIds.set(row.deviceKey, row.id);
        nextSessionId = Math.max(nextSessionId, row.id + 1);
      }
      inventory = fresh;
      initialized = true;
      routes.clear();
      inventory.forEach((d) => routes.set(d.id, d));
      return inventory;
    })().finally(() => { buildingInventory = false; refreshPromise = null; });
    return refreshPromise;
  };
  const route = async (id) => {
    const rows = await refresh();
    const target = rows.find((d) => d.id === id);
    if (!target) throw new Error(`unknown device id ${id}`);
    return target;
  };
  const writeTarget = async (id) => {
    const target = await route(id);
    if (target.synthetic || target.backendKind === 'os') throw new Error('selected GPU is read-only and does not support this write');
    if (target.identityAmbiguous === true) throw new Error('selected GPU has ambiguous physical identity');
    if (!Number.isInteger(target.backendId)) throw new Error('selected GPU has no writable backend target');
    return target;
  };
  const call = (method, id, ...args) => writeTarget(id).then((d) => backend[method](d.backendId, ...args));
  const wrapper = {
    kind: backend.kind,
    get initError() { return backend.initError; },
    get extendedCapable() { return backend.extendedCapable; },
    async init() { return backend.init?.(); },
    async close() { return backend.close?.(); },
    async listDevices() { return (await refresh()).map((d) => ({ ...d, osController: d.osController ? { ...d.osController } : null })); },
    async getTarget(id) { return route(id); },
    async resolveTarget(target) {
      const rows = await refresh();
      if (!target || typeof target.deviceKey !== 'string') return null;
      return rows.find((d) => d.deviceKey === target.deviceKey) ?? null;
    },
    async assertDeviceTarget(id, expectedKey, physicalProof = null) {
      const rows = await refresh();
      const target = rows.find((d) => d.id === id);
      if (!target) throw new Error(`unknown device id ${id}`);
      if (target.synthetic === true || target.backendKind === 'os') {
        if (physicalProof?.synthetic === true) throw new Error('selected GPU is read-only and does not support elevated writes');
      }
      const hasPhysicalProof = physicalProof !== null && typeof physicalProof === 'object' && !Array.isArray(physicalProof);
      const writableTarget = target.synthetic !== true && target.backendKind !== 'os'
        && Number.isInteger(target.backendId) && target.identityAmbiguous !== true;
      if (target.identityAmbiguous === true && (hasPhysicalProof || typeof expectedKey === 'string')) {
        throw new Error('selected GPU has ambiguous physical identity');
      }
      if (hasPhysicalProof && !physicalTargetMatches(target, physicalProof, rows)) {
        throw new Error(`stale GPU target: device id ${id} physical proof does not match`);
      }
      const physicalMatch = hasPhysicalProof ? physicalTargetMatches(target, physicalProof, rows) : false;
      if (typeof expectedKey === 'string' && target.deviceKey !== expectedKey) {
        // The elevated worker intentionally rebuilds inventory without the
        // parent OS snapshot. A unique worker row may therefore have a
        // PCI/BDF durable key while the parent supplied the PNP durable key.
        // The physical proof is authoritative for this one reconciliation;
        // it must still match and the worker row must not claim a conflicting
        // PNP of its own.
        const workerProofReconciliation = physicalMatch
          && !normalizePnpDeviceId(target.pnpDeviceId)
          && normalizePnpDeviceId(physicalProof?.pnpDeviceId);
        if (!workerProofReconciliation) {
          throw new Error(`stale GPU target: device id ${id} no longer resolves to ${expectedKey}`);
        }
      }
      if (writableTarget && typeof expectedKey === 'string' && !hasPhysicalProof) {
        throw new Error(`missing physical proof for elevated GPU target ${id}`);
      }
      return target;
    },
    async getCapabilities(id) {
      const d = await route(id);
      if (d.synthetic) return syntheticCapabilities(d);
      const caps = await backend.getCapabilities(d.backendId);
      return { ...caps, deviceKey: d.deviceKey };
    },
    async getCurrentSettings(id) { const d = await route(id); return d.synthetic ? nullDeviceState() : backend.getCurrentSettings(d.backendId); },
    async getGraphicsSettings(id) { const d = await route(id); return d.synthetic ? { supported: { frameGen: false, flipModes: false, frameLimit: false, lowLatency: false }, supportedOptions: { frameGen: [], flipModes: [], lowLatency: [] }, frameLimitRange: null, values: { frameGenOverride: null, flipMode: null, frameLimit: null, lowLatency: null } } : backend.getGraphicsSettings(d.backendId); },
    async setGraphicsSettings(id, settings) { const d = await route(id); return d.synthetic ? unsupportedResult(settings) : backend.setGraphicsSettings((await writeTarget(id)).backendId, settings); },
    async applySettings(id, settings, opts) { const d = await writeTarget(id); return backend.applySettings(d.backendId, settings, opts); },
    async resetToDefaults(id) { return call('resetToDefaults', id); },
    async setWaiverAccepted(id) { return call('setWaiverAccepted', id); },
    async restoreWaiverState(id, accepted) { const d = await route(id); return d.synthetic ? undefined : backend.restoreWaiverState(d.backendId, accepted); },
    async sampleRawTelemetry(id) { const d = await route(id); return d.synthetic ? { t: Date.now(), throttle: {} } : backend.sampleRawTelemetry(d.backendId); },
    onRawTelemetry(id, cb) { const d = routes.get(id); return d && !d.synthetic ? backend.onRawTelemetry(d.backendId, cb) : () => {}; },
    async pciProperties(id) { const d = await route(id); return d.synthetic ? null : backend.pciProperties?.(d.backendId) ?? null; },
    async recordApplyRefusals(id, result, settings) { const d = await route(id); return d.synthetic ? undefined : backend.recordApplyRefusals?.(d.backendId, result, settings); },
    async extendedApply(control, value, id = 0) {
      const d = await writeTarget(id);
      return backend.extendedApply(control, value, d.backendId);
    },
    async backendIdOf(id) { return (await route(id)).backendId; },
    setOcMode(mode) { return backend.setOcMode?.(mode); },
    setVramBytesOf(fn) { return backend.setVramBytesOf?.(fn); },
    async health() { return backend.health(); },
    async devicePciIdOf(id) { return (await route(id)).pciDeviceId ?? null; },
    async deviceTelemetryTarget(id) { const d = await route(id); return { ...d }; },
    async getDeviceTarget(id, expectedKey = null, physicalProof = null) { return wrapper.assertDeviceTarget(id, expectedKey, physicalProof); },
  };
  return new Proxy(wrapper, {
    get(target, property) {
      if (property in target) return target[property];
      const value = backend[property];
      return typeof value === 'function' ? value.bind(backend) : value;
    },
  });
}
