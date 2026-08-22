// Arc Power - M17c the vendor-telemetry lane (non-Intel GPU readouts; user
// scope: ONLY non-Intel GPUs).
//
// HOOK: the no-device telemetry path (ipc-core startNullTelemetry) - when
// the ACTIVE device is non-Intel, the lane detects the sysinfo controller
// vendor (/VEN_10DE -> NVIDIA, /VEN_1002 -> AMD - the sysinfo.js vendor
// predicate) and chooses the adapter: the first AVAILABLE of [NVML, ADL]
// matching the vendor. A machine with an IGCL iGPU + a non-Intel dGPU gets
// vendor readouts only when the ACTIVE device is non-Intel (the device
// telemetry path never runs this lane).
//
// The sample shape is the existing TelemetrySample contract
// (backend.interface.js:138-150) - the overlay/monitoring render is
// unchanged; honest '-' per field when a source is absent; no crash when
// the DLL is missing. Rebar stays Intel-only (no generic user-mode PCI-
// config path) - honest '-' on non-Intel. NO WMI widening (the sys-stats
// path already works on any GPU).
//
// The env knob RID_MOCK_VENDOR=nvml|adl (the mock-backend/env-knob
// pattern) substitutes a FIXTURE adapter (mock/vendor/<vendor>.json - the
// fake-vendor fixture samples) so the lane is testable + verifiable
// without the vendor DLLs; an unset knob runs the REAL koffi adapters
// (absent DLLs degrade to the null adapter - deterministic in tests).
//
// M17d (round-1 S2): the STATIC-INFO seam - every adapter (real + fixture)
// also exposes deviceInfo(): { vramBytes, computeCores } (the NVML memory
// total + nvmlDeviceGetNumGpuCores; ADL mirrors the honest nulls). The
// no-Intel dashboard VRAM/Compute rows read it via the 'vendor-info:get'
// channel (ipc-core.js) - the renderer falls back to the OS controller
// bytes when the lane has no source.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNvmlAdapter } from './nvml.js';
import { createAdlAdapter } from './adl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// src/main/vendor-telemetry -> repo root (dev); app.asar/src/main/
// vendor-telemetry in the packaged app (mock/ is optional there - a
// missing dir degrades to the real adapters, never a crash).
export const VENDOR_FIXTURES_DIR = path.resolve(__dirname, '..', '..', '..', 'mock', 'vendor');

/** The vendor id -> canonical name map (the sysinfo vendor predicate:
 *  /VEN_10DE -> NVIDIA, /VEN_1002 -> AMD). */
export function controllerVendorOf(pnpDeviceId) {
  if (typeof pnpDeviceId !== 'string') return null;
  if (/VEN_10DE/i.test(pnpDeviceId)) return 'nvidia';
  if (/VEN_1002/i.test(pnpDeviceId)) return 'amd';
  return null;
}

/**
 * The sysinfo controller vendor: the FIRST real-GPU controller whose
 * pnpDeviceId carries a non-Intel vendor id (Intel controllers are
 * skipped - the lane only serves non-Intel GPUs). Garbage/absent ->
 * null (no vendor lane).
 * @param {unknown} sysinfoPayload the sysinfo:get payload
 *   ({ videoControllers: [{ pnpDeviceId }] })
 * @returns {'nvidia'|'amd'|null}
 */
export function vendorOf(sysinfoPayload) {
  const rows = Array.isArray(sysinfoPayload?.videoControllers)
    ? sysinfoPayload.videoControllers
    : [];
  for (const c of rows) {
    const vendor = controllerVendorOf(c?.pnpDeviceId);
    if (vendor) return vendor;
  }
  return null;
}

/**
 * The fixture adapter (RID_MOCK_VENDOR path): reads mock/vendor/<id>.json
 * (the fake-vendor fixture sample - the deterministic shape the ui-verify
 * pins) and reports it verbatim on every sample.
 * @param {'nvml'|'adl'} vendorId
 * @returns {object} the fixture adapter duck type
 */
export function createVendorFixtureAdapter(vendorId, index = 0) {
  const file = path.join(VENDOR_FIXTURES_DIR, `${vendorId}.json`);
  let fixture = null;
  let error = null;
  try {
    fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return {
    vendor: vendorId === 'adl' ? 'amd' : 'nvidia',
    available: () => fixture !== null,
    initError: () => error,
    init: () => {},
    // Emit only the non-null SAMPLE fields (a null fixture field = the
    // honest absent source - never a literal null in the sample; the
    // `notes`/`vendor` fixture metadata never rides the sample). M17d:
    // `vramBytes` is the deviceInfo()-ONLY static field (the NVML total) -
    // it must never leak into the telemetry sample (it is not a
    // TelemetrySample field).
    sample: async () => {
      if (!fixture) return null;
      const out = {};
      for (const [k, v] of Object.entries(fixture)) {
        if ((k === 'notes' || k === 'vendor' || k === 'vramBytes') || v === null || v === undefined) continue;
        out[k] = v;
      }
      return out;
    },
    /**
     * M17d: the STATIC-INFO seam - the fixture mirror of the NVML
     * deviceInfo() (vramBytes = the fixture's NVML-total field, computeCores
     * = the fixture's numCores; the ADL fixture mirrors the honest nulls).
     * Never throws.
     * @returns {{ vramBytes: number | null, computeCores: number | null }}
     */
    deviceInfo: () => {
      if (!fixture) return { vramBytes: null, computeCores: null };
      const vramBytes = typeof fixture.vramBytes === 'number' && Number.isFinite(fixture.vramBytes) && fixture.vramBytes > 0
        ? Math.floor(fixture.vramBytes)
        : null;
      const computeCores = typeof fixture.numCores === 'number' && Number.isFinite(fixture.numCores) && fixture.numCores > 0
        ? Math.floor(fixture.numCores)
        : null;
      return { vramBytes, computeCores };
    },
    close: () => {},
    deviceIndex: index,
    physicalPnp: typeof fixture?.pnpDeviceId === 'string' ? fixture.pnpDeviceId : null,
    physicalBdf: fixture?.bdf ?? null,
    physicalToken: typeof fixture?.physicalToken === 'string' ? fixture.physicalToken : null,
  };
}

/**
 * The vendor-telemetry lane. Resolves the adapter lazily on start():
 *   - RID_MOCK_VENDOR=nvml|adl -> the fixture adapter (tests/ui-verify);
 *   - otherwise the sysinfo controller vendor -> the first AVAILABLE
 *     adapter of [NVML, ADL] matching the vendor (an absent DLL / failed
 *     init degrades to the next; none -> the null adapter - honest no
 *     vendor readouts, never a crash).
 * The resolved adapter is reused for the whole session (the DLL load is a
 * one-time cost; `close()` releases it on the telemetry stop).
 * @param {{
 *   sysinfo?: { get: () => Promise<unknown> },   // the sysinfo adapter
 *   adapters?: Array<{ vendor: string, ... }>,   // injected adapter list (tests)
 * }} deps
 * @returns {{
 *   start: () => Promise<{ vendor: 'nvidia'|'amd'|null, sample: () => Promise<object|null> } | null>,
 * }}
 */
export function createVendorTelemetry({ sysinfo = null, adapters = null } = {}) {
  let adapter = null;
  let started = false;
  let liveBoundDeviceKey = null;

  const normalizeIdentity = (value) => typeof value === 'string' ? value.trim().toUpperCase() : null;
  const targetIdentity = (target) => ({
    pnp: normalizeIdentity(target?.pnpDeviceId ?? target?.osController?.pnpDeviceId),
    bdf: normalizeIdentity(target?.bdf ?? target?.osController?.bdf),
    token: normalizeIdentity(target?.physicalToken ?? target?.uniqueToken ?? target?.osController?.physicalToken),
    luid: target?.osLuid ?? target?.osController?.luid ?? target?.luid ?? target?.adapterLuid ?? null,
  });
  const sameLuid = (left, right) => left !== null && left !== undefined && right !== null && right !== undefined
    && JSON.stringify(left) === JSON.stringify(right);
  const identityMatches = (candidate, identity) => (
    (identity.pnp && normalizeIdentity(candidate?.physicalPnp) === identity.pnp)
    || (identity.bdf && normalizeIdentity(candidate?.physicalBdf) === identity.bdf)
    || (identity.token && normalizeIdentity(candidate?.physicalToken ?? candidate?.physicalUniqueToken) === identity.token)
    || sameLuid(candidate?.physicalLuid, identity.luid)
  );
  const release = (released) => {
    if (adapter !== released) return;
    adapter = null;
    started = false;
    liveBoundDeviceKey = null;
  };
  const manage = (candidate, targetKey, owner) => {
    if (!candidate) return null;
    if (!candidate.__vendorTelemetryManaged) {
      const rawClose = typeof candidate.close === 'function' ? candidate.close.bind(candidate) : null;
      candidate.__vendorTelemetryManaged = true;
      candidate.close = () => {
        try { rawClose?.(); } finally { release(candidate); }
      };
    }
    candidate.boundDeviceKey = targetKey;
    if (owner === 'telemetry') liveBoundDeviceKey = targetKey;
    adapter = candidate;
    started = true;
    return candidate;
  };

  async function startFor(target = null, { owner = 'static' } = {}) {
    const knob = process.env.RID_MOCK_VENDOR;
    const wantedVendor = target?.gpuVendor === 'nvidia' || target?.gpuVendor === 'amd'
      ? target.gpuVendor
      : vendorOf({ videoControllers: [target?.osController ?? target] })
        ?? (target == null && (knob === 'nvml' ? 'nvidia' : knob === 'adl' ? 'amd' : null));
    const wantedKey = typeof target?.deviceKey === 'string' ? target.deviceKey : null;
    const wantedIndex = Number.isInteger(target?.vendorIndex) ? target.vendorIndex : 0;
    const identity = targetIdentity(target);
    const hasPhysicalTarget = Boolean(identity.pnp || identity.bdf || identity.token || identity.luid !== null);
    const matchesPhysicalTarget = (candidate) => {
      if (wantedKey && candidate?.deviceKey === wantedKey) return true;
      return identityMatches(candidate, identity);
    };
    const providerIdentityComparable = (candidate) => Boolean(
      normalizeIdentity(candidate?.physicalPnp)
      || normalizeIdentity(candidate?.physicalBdf)
      || sameLuid(candidate?.physicalLuid, identity.luid)
      || (identity.token && normalizeIdentity(candidate?.physicalToken ?? candidate?.physicalUniqueToken)),
    );
    const closeRejectedCandidate = (candidate) => {
      // The selected telemetry owner is closed by the telemetry stop path.
      // Every candidate that does not become the owner must release any
      // native library state acquired by init(), including partial init.
      if (!candidate || candidate === adapter && liveBoundDeviceKey !== null) return;
      try { candidate.close?.(); } catch { /* best effort */ }
    };
    if (started && adapter && ((wantedKey && adapter.boundDeviceKey === wantedKey)
      || (!hasPhysicalTarget && adapter.deviceIndex === wantedIndex && liveBoundDeviceKey === null)
      || (hasPhysicalTarget && matchesPhysicalTarget(adapter)))) return adapter;
    // Static info may observe a live adapter, but must never close it while
    // its telemetry timer still owns the sampling object.
    if (liveBoundDeviceKey !== null && owner !== 'telemetry') return null;
    if (adapter?.close) { try { adapter.close(); } catch { /* best effort */ } }
    started = true;
    adapter = null;
    liveBoundDeviceKey = null;
    try {
      if ((knob === 'nvml' && wantedVendor === 'nvidia') || (knob === 'adl' && wantedVendor === 'amd')) {
        adapter = createVendorFixtureAdapter(knob, wantedIndex);
        adapter.deviceKey = wantedKey;
        return manage(adapter, wantedKey, owner);
      }
      if (!wantedVendor) return null;
      const candidates = adapters ?? [
        wantedVendor === 'nvidia' ? createNvmlAdapter({ index: wantedIndex }) : createAdlAdapter({ index: wantedIndex }),
      ];
      for (const a of candidates) {
        let selected = false;
        try {
          if (a?.vendor !== wantedVendor) continue;
          try { a.init(); } catch { continue; }
          if (!a.available?.()) continue;
          let resolved = false;
          let provenSingle = false;
          const directMatched = hasPhysicalTarget && matchesPhysicalTarget(a);
          const enumerated = directMatched ? null : await a.enumerateDevices?.();
          if (directMatched) {
            resolved = true;
          } else if (Array.isArray(enumerated)) {
            provenSingle = enumerated.length === 1 && wantedIndex === 0;
            if (hasPhysicalTarget) {
              const matches = enumerated.filter((entry) => identityMatches(entry, identity));
              if (matches.length === 1) {
                const selectedOk = typeof a.selectDevice === 'function'
                  ? a.selectDevice(matches[0].index)
                  : true;
                resolved = selectedOk !== false;
              } else if (provenSingle && (target?.vendorCount === 1 || !providerIdentityComparable(enumerated[0]))) {
                // A real NVML adapter commonly exposes PCI BDF while the
                // Windows inventory exposes only PNP. When both sides prove
                // there is exactly one adapter for this vendor, the sole
                // provider row is a safe physical join even though its
                // identity is comparable but not equal. Never use this path
                // for a multi-adapter vendor inventory.
                const selectedOk = typeof a.selectDevice === 'function'
                  ? a.selectDevice(enumerated[0].index)
                  : true;
                resolved = selectedOk !== false;
              }
            } else if (enumerated.length > 1) {
              // No durable target identity means an ordinal would be unsafe.
              continue;
            }
          } else if (enumerated === null && target?.vendorCount === 1 && wantedIndex === 0) {
            // A provider that cannot enumerate still has a safe sole-vendor
            // join when the unified inventory proves there is one adapter.
            provenSingle = true;
            resolved = true;
          }
          const physicallyMatched = matchesPhysicalTarget(a);
          if (hasPhysicalTarget && !resolved && !physicallyMatched) continue;
          if (!hasPhysicalTarget && (!provenSingle || (Number.isInteger(a?.deviceIndex) && a.deviceIndex !== wantedIndex))) continue;
          selected = true;
          return manage(a, wantedKey, owner);
        } finally {
          if (!selected) closeRejectedCandidate(a);
        }
      }
      return null;
    } catch {
      adapter = null;
      liveBoundDeviceKey = null;
      return null;
    }
  }

  async function start() {
    if (started) return adapter;
    try {
      let payload = null;
      try {
        payload = await sysinfo?.get?.();
      } catch {
        payload = null; // degraded - no vendor readouts
      }
      const knob = process.env.RID_MOCK_VENDOR;
      const vendor = vendorOf(payload)
        ?? (knob === 'nvml' ? 'nvidia' : knob === 'adl' ? 'amd' : null);
      const row = payload?.videoControllers?.find((c) => controllerVendorOf(c?.pnpDeviceId));
      return startFor({ gpuVendor: vendor, osController: row, vendorIndex: 0 }, { owner: 'telemetry' });
    } catch {
      adapter = null;
      liveBoundDeviceKey = null;
      return null;
    }
  }

  return {
    start,
    startFor,
    close: () => { try { adapter?.close?.(); } catch { /* best effort */ } },
    /** The resolved adapter (null before start / when none matched). */
    get adapter() {
      return adapter;
    },
  };
}
