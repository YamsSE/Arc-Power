// Arc Power — M1 headless smoke sequence.
//
// Exercises the M1 acceptance path against the real A770 without a UI:
// init -> discover runtime -> listDevices -> getCapabilities ->
// getCurrentSettings -> no-op apply round trips (each supported control set
// to its own current value, snapToStep:false so off-grid current values are
// written back exactly) -> telemetry ticks (>=50 ms apart) -> reset ONLY if
// a change was detected -> health -> close.
//
// Safety (hard rules):
//   - never sets a value different from the current read-back;
//   - reset only when a change was detected;
//   - fan setters only when the EFFECTIVE canControl === true — M3-D: the
//     A770's canControl=false property is a lie; the first caps read now
//     triggers ONE reversible fan probe (write sample table + read-back +
//     SetDefaultMode restore), so the packaged --headless smoke performs a
//     single write+restore pair on the real card;
//   - gpuLock is never written when the device reports dynamic (0,0) —
//     writing 0,0 would switch lock modes (probe rule);
//   - the waiver is accepted only under allowAutoWaiver (constructor flag
//     set by the smoke entry point, never by product code).

/**
 * @typedef {import('./backend/backend.interface.js').IOCBackend} IOCBackend
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SmokeFailure extends Error {}

/**
 * @param {IOCBackend} backend
 * @param {{ log?: (s: string) => void }} opts
 * @returns {Promise<{ ok: true, lines: string[] }>}
 */
export async function runSmoke(backend, opts = {}) {
  const log = opts.log ?? ((s) => console.log(s));
  const lines = [];
  const step = (n, msg) => {
    lines.push(`[${n}] ${msg}`);
    log(`[${n}] ${msg}`);
  };
  const fail = (n, msg) => {
    throw new SmokeFailure(`smoke step ${n}: ${msg}`);
  };

  // --- init + discovery -----------------------------------------------------
  step('init', 'backend.init() (zero UID + CTL_INIT_FLAG_USE_LEVEL_ZERO)');
  try {
    await backend.init();
  } catch (err) {
    fail('init', err.message);
  }

  let health = await backend.health();
  step('health', `igclLoaded=${health.igclLoaded} driverVersion=${health.driverVersion} levelZeroOk=${health.levelZeroOk}${health.error ? ` error=${health.error}` : ''}`);
  if (!health.igclLoaded || !health.levelZeroOk) fail('init', 'IGCL runtime not loaded / Level Zero not ok');

  let devices;
  try {
    devices = await backend.listDevices();
  } catch (err) {
    fail('discovery', err.message);
  }
  if (devices.length === 0) fail('discovery', 'no devices enumerated');
  step('discovery', `${devices.length} device(s): ${devices.map((d) => d.name).join(', ')}`);

  for (const dev of devices) {
    step('device', `=== ${dev.name} (PCI ${dev.pciVendorId}:${dev.pciDeviceId}, driver ${dev.driverVersion}) ===`);

    // --- capabilities --------------------------------------------------------
    let caps;
    try {
      caps = await backend.getCapabilities(dev.id);
    } catch (err) {
      fail('caps', err.message);
    }
    const supported = Object.entries(caps.controls).filter(([, v]) => v).map(([k]) => k);
    step('caps', `supported=[${supported.join(', ')}] ranges=${JSON.stringify(caps.ranges)} fan={canControl:${caps.fan.canControl}, modes:[${caps.fan.modes.join(',')}], maxPoints:${caps.fan.maxCurvePoints}} waiverAccepted=${caps.waiverAccepted}`);

    // --- read-back + no-op round trips --------------------------------------
    let before;
    try {
      before = await backend.getCurrentSettings(dev.id);
    } catch (err) {
      fail('state', err.message);
    }
    step('state', `current=${JSON.stringify(before)}`);

    const noop = {};
    for (const [key, value] of Object.entries(before)) {
      if (value === null || value === undefined) continue;
      // Safety: never write fan controls on a read-only fan (M3-D: the
      // probe already ran its single reversible write+restore inside the
      // first getCapabilities — no further fan writes here), never write a
      // vfCurve (write switches curve type), never write a dynamic (0,0)
      // gpuLock (would switch lock modes).
      if (['fanMode', 'fanCurve', 'fixedFanPct', 'vfCurve'].includes(key)) continue;
      if (key === 'gpuLock' && value.voltageV === 0 && value.freqMhz === 0) continue;
      // M2C-C: zero-valued OC scalars are refused by the driver by design
      // (0x40000007 — verified; "0-value no-ops most refused"). A no-op round
      // trip of the CURRENT state must not fail on values the driver refuses
      // to write at all, so zero-valued scalars are skipped (their absence
      // from the set is exactly what the honest refusal would report anyway).
      if (typeof value === 'number' && value === 0) continue;
      // M3-D: a CURRENT state holding extended values (>252 W / >90 C — e.g.
      // the card is running a 300 W profile) cannot no-op round-trip through
      // the DriverStore runtime: it refuses them client-side (0x44000004).
      // Extended values are the old-2023-runtime domain, verified by the
      // dedicated probes (M2C-C/M3-C) — the no-op covers the in-range set.
      if (key === 'powerLimitW' && typeof value === 'number' && value > 252) continue;
      if (key === 'tempLimitC' && typeof value === 'number' && value > 90) continue;
      noop[key] = value;
    }
    let applyRes;
    try {
      applyRes = await backend.applySettings(dev.id, noop, { snapToStep: false });
    } catch (err) {
      fail('noop', `applySettings threw: ${err.message}`);
    }
    step('noop', `applied current values as no-op: ${JSON.stringify(applyRes.perControl)}`);
    if (!applyRes.ok) fail('noop', `no-op apply reported failures: ${JSON.stringify(applyRes.perControl)}`);

    // --- verify nothing changed ---------------------------------------------
    let after;
    try {
      after = await backend.getCurrentSettings(dev.id);
    } catch (err) {
      fail('verify', err.message);
    }
    const changedKeys = [];
    for (const key of Object.keys(noop)) {
      const a = before[key];
      const b = after[key];
      const equal = typeof a === 'object' && a !== null
        ? JSON.stringify(a) === JSON.stringify(b)
        : Math.abs(a - b) < 1e-6;
      if (!equal) changedKeys.push(key);
    }
    step('verify', changedKeys.length === 0
      ? 'no value changes detected — state untouched'
      : `CHANGE DETECTED on [${changedKeys.join(', ')}]`);

    // --- telemetry ticks (>=50 ms apart) -------------------------------------
    for (let i = 0; i < 3; i++) {
      if (i > 0) await sleep(60);
      let sample;
      try {
        sample = await backend.sampleRawTelemetry(dev.id);
      } catch (err) {
        fail('telemetry', err.message);
      }
      step('telemetry', `sample[${i}] clock=${sample.gpuClockMhz}MHz temp=${sample.tempC}C vramTemp=${sample.vramTempC}C energy=${sample.gpuEnergyJ}J t=${sample.t} fanRpm=${JSON.stringify(sample.fanRpm)} throttle=${JSON.stringify(sample.throttle)}`);
    }

    // --- reset ONLY if a change was detected --------------------------------
    if (changedKeys.length > 0) {
      try {
        await backend.resetToDefaults(dev.id);
        step('reset', `change detected (${changedKeys.join(', ')}) -> ctlOverclockResetToDefault called`);
      } catch (err) {
        fail('reset', err.message);
      }
    } else {
      step('reset', 'no changes detected — reset NOT called (state untouched)');
    }
  }

  // --- final health -----------------------------------------------------------
  health = await backend.health();
  step('health', `final: igclLoaded=${health.igclLoaded} driverVersion=${health.driverVersion} levelZeroOk=${health.levelZeroOk}${health.error ? ` error=${health.error}` : ''}`);

  await backend.close();
  step('close', 'backend closed');
  return { ok: true, lines };
}
