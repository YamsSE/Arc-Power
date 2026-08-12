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
export function createVendorFixtureAdapter(vendorId) {
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
    // `notes`/`vendor` fixture metadata never rides the sample).
    sample: async () => {
      if (!fixture) return null;
      const out = {};
      for (const [k, v] of Object.entries(fixture)) {
        if ((k === 'notes' || k === 'vendor') || v === null || v === undefined) continue;
        out[k] = v;
      }
      return out;
    },
    close: () => {},
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

  async function start() {
    if (started) return adapter;
    started = true;
    try {
      const knob = process.env.RID_MOCK_VENDOR;
      if (knob === 'nvml' || knob === 'adl') {
        adapter = createVendorFixtureAdapter(knob);
        return adapter;
      }
      let payload = null;
      try {
        payload = await sysinfo?.get?.();
      } catch {
        payload = null; // degraded - no vendor readouts
      }
      const vendor = vendorOf(payload);
      if (!vendor) return (adapter = null);
      const candidates = adapters ?? [
        createNvmlAdapter(),
        createAdlAdapter(),
      ];
      for (const a of candidates) {
        if (a?.vendor !== vendor) continue;
        try {
          a.init();
        } catch {
          continue;
        }
        if (a.available?.()) {
          adapter = a;
          return adapter;
        }
      }
      return (adapter = null);
    } catch {
      return (adapter = null);
    }
  }

  return {
    start,
    /** The resolved adapter (null before start / when none matched). */
    get adapter() {
      return adapter;
    },
  };
}
