// Arc Power — M0 IGCL probe
// Proves the Intel Graphics Control Library runtime can be driven from Node via
// koffi against the real Arc A770: init (+Level Zero), device enumeration,
// OC capability matrix, fan properties/config/state, waiver, SAFE no-op apply
// round trips, power telemetry sampling, VF curve read.
//
// Safety: every Set call writes back the exact value just read from the device
// (no-op). No state is changed. ctlOverclockResetToDefault is NOT called
// unless a real change was detected (it never should be).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import koffi from 'koffi';
import {
  CTL_INIT_FLAG_USE_LEVEL_ZERO, CTL_RESULT, describeResult, makeVersion,
  loadIgcl, findIgclDll, decodeItem, decodeVfCurve,
  CTL_FAN_SPEED_MODE, CTL_FAN_SPEED_UNITS, CTL_DEVICE_TYPE, CTL_VF_CURVE_TYPE,
} from './igcl.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const APP_UID = {
  Data1: 0x52494441, // 'RIDA'
  Data2: 0x5243,     // 'RC'
  Data3: 0x504F,     // 'PO'
  Data4: [0x52, 0x49, 0x44, 0x41, 0x50, 0x4F, 0x57, 0x21], // 'RIDAPOW!'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => `0x${(Number(n) >>> 0).toString(16).padStart(8, '0')}`;

function check(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Step 1: load the DLL
// ---------------------------------------------------------------------------

const dllPath = findIgclDll();
check(dllPath, 'IGCL runtime DLL not found. Expected ControlLib.dll in System32 or the DriverStore igfx package.');
console.log(`[1] IGCL runtime: ${dllPath}`);
const lib = loadIgcl(dllPath);

// ---------------------------------------------------------------------------
// Step 2: ctlInit with Level Zero flag
// ---------------------------------------------------------------------------

const initArgs = koffi.alloc('ctl_init_args_t', 1);
koffi.encode(initArgs, 'ctl_init_args_t', {
  Size: koffi.sizeof('ctl_init_args_t'),
  Version: 0,
  AppVersion: makeVersion(1, 1),
  flags: CTL_INIT_FLAG_USE_LEVEL_ZERO,
  SupportedVersion: 0,
  ApplicationUID: APP_UID,
});

const apiHandleBuf = koffi.alloc('void*', 1);
let usedUid = 'APP_UID';
let result = lib.ctlInit(initArgs, apiHandleBuf);
let initOut = koffi.decode(initArgs, 'ctl_init_args_t');
console.log(`[2] ctlInit(flags=USE_LEVEL_ZERO) -> ${describeResult(result)}`);

if (result === CTL_RESULT.ERROR_UNKNOWN_APPLICATION_UID) {
  console.log(`[2] UID rejected; retrying with zero UID (driver default).`);
  koffi.encode(initArgs, koffi.offsetof('ctl_init_args_t', 'ApplicationUID'), 'ctl_application_id_t', { Data1: 0, Data2: 0, Data3: 0, Data4: [0, 0, 0, 0, 0, 0, 0, 0] });
  usedUid = 'ZERO';
  result = lib.ctlInit(initArgs, apiHandleBuf);
  initOut = koffi.decode(initArgs, 'ctl_init_args_t');
  console.log(`[2] ctlInit(zero UID) -> ${describeResult(result)}`);
}

const apiHandle = koffi.decode(apiHandleBuf, 0, 'void*');
check(result === CTL_RESULT.SUCCESS, `ctlInit failed (${describeResult(result)}) — aborting.`);
check(apiHandle, 'ctlInit returned success but API handle is NULL');

const levelZeroOk = Boolean(
  [...process.env.PATH.split(';'), 'C:\\Windows\\System32']
    .find((p) => p && fs.existsSync(path.join(p, 'ze_loader.dll')))
);
console.log(`[2] Level Zero: ze_loader.dll on PATH/System32 -> ${levelZeroOk} (SupportedVersion=${initOut.SupportedVersion >>> 0})`);

try {
  // ---------------------------------------------------------------------------
  // Step 3: enumerate devices
  // ---------------------------------------------------------------------------
  const countBuf = koffi.alloc('uint32', 1);
  koffi.encode(countBuf, 'uint32', 0);
  result = lib.ctlEnumerateDevices(apiHandle, countBuf, null);
  check(result === CTL_RESULT.SUCCESS, `ctlEnumerateDevices (count) failed: ${describeResult(result)}`);
  const devCount = koffi.decode(countBuf, 'uint32');
  check(devCount > 0, `ctlEnumerateDevices returned ${devCount} device(s) — nothing to probe. Aborting.`);
  console.log(`[3] ctlEnumerateDevices -> ${devCount} device(s)`);

  const handlesBuf = koffi.alloc('void*', devCount);
  koffi.encode(countBuf, 'uint32', devCount);
  result = lib.ctlEnumerateDevices(apiHandle, countBuf, handlesBuf);
  check(result === CTL_RESULT.SUCCESS, `ctlEnumerateDevices (fill) failed: ${describeResult(result)}`);

  const devices = [];
  for (let i = 0; i < devCount; i++) {
    const devHandle = koffi.decode(handlesBuf, i * 8, 'void*');

    const propsBuf = koffi.alloc('ctl_device_adapter_properties_t', 1);
    koffi.encode(propsBuf, 'ctl_device_adapter_properties_t', {
      Size: koffi.sizeof('ctl_device_adapter_properties_t'),
      Version: 3,
    });
    result = lib.ctlGetDeviceProperties(devHandle, propsBuf);
    check(result === CTL_RESULT.SUCCESS, `ctlGetDeviceProperties(${i}) failed: ${describeResult(result)}`);
    const p = koffi.decode(propsBuf, 'ctl_device_adapter_properties_t');
    const dev = {
      index: i,
      name: (p.name || '').replace(/\0+$/, ''),
      type: CTL_DEVICE_TYPE[p.device_type] ?? p.device_type,
      pciVendorId: hex(p.pci_vendor_id),
      pciDeviceId: hex(p.pci_device_id),
      revId: p.rev_id,
      pciSubsysId: p.pci_subsys_id,
      pciSubsysVendorId: p.pci_subsys_vendor_id,
      bdf: { bus: p.adapter_bdf.bus, device: p.adapter_bdf.device, function: p.adapter_bdf.function },
      driverVersion: '0x' + p.driver_version.toString(16).padStart(16, '0'),
      graphicsClockMHz: p.Frequency,
      numXeCores: p.num_xe_cores,
      handle: devHandle,
    };
    console.log(`[3]   device[${i}]: "${dev.name}" type=${dev.type} PCI=${dev.pciVendorId}:${dev.pciDeviceId} rev=${dev.revId} driver=${dev.driverVersion}`);
    devices.push(dev);
  }

  const capDevices = [];

  for (const dev of devices) {
    console.log(`\n=== Device[${dev.index}] "${dev.name}" ===`);
    const d = { ...dev, ocProperties: null, fans: [], telemetry: [], noop: null, vfCurve: null };
    delete d.handle;
    capDevices.push(d);

    // ---------------------------------------------------------------------------
    // Step 4: overclock capability matrix
    // ---------------------------------------------------------------------------
    const ocBuf = koffi.alloc('ctl_oc_properties_t', 1);
    koffi.encode(ocBuf, 'ctl_oc_properties_t', { Size: koffi.sizeof('ctl_oc_properties_t'), Version: 1 });
    result = lib.ctlOverclockGetProperties(dev.handle, ocBuf);
    console.log(`[4] ctlOverclockGetProperties -> ${describeResult(result)}`);
    if (result !== CTL_RESULT.SUCCESS) {
      d.ocError = describeResult(result);
      continue;
    }
    const oc = koffi.decode(ocBuf, 'ctl_oc_properties_t');
    const controlNames = [
      'gpuFrequencyOffset', 'gpuVoltageOffset', 'vramFrequencyOffset', 'vramVoltageOffset',
      'powerLimit', 'temperatureLimit', 'vramMemSpeedLimit',
      'gpuVFCurveVoltageLimit', 'gpuVFCurveFrequencyLimit',
    ];
    const controls = {};
    for (const name of controlNames) {
      const c = oc[name];
      controls[name] = {
        bSupported: c.bSupported,
        bRelative: c.bRelative,
        bReference: c.bReference,
        units: c.units,
        min: c.min,
        max: c.max,
        step: c.step,
        Default: c.Default,
        reference: c.reference,
      };
      if (c.bSupported) {
        console.log(`[4]   ${name.padEnd(26)} supported=${c.bSupported} units=${c.units} min=${c.min} max=${c.max} step=${c.step} default=${c.Default}`);
      }
    }
    d.ocProperties = { bSupported: oc.bSupported, controls };

    // ---------------------------------------------------------------------------
    // Step 5: fans
    // ---------------------------------------------------------------------------
    const fanCountBuf = koffi.alloc('uint32', 1);
    koffi.encode(fanCountBuf, 'uint32', 0);
    result = lib.ctlEnumFans(dev.handle, fanCountBuf, null);
    console.log(`[5] ctlEnumFans -> ${describeResult(result)} count=${koffi.decode(fanCountBuf, 'uint32')}`);
    const fanCount = koffi.decode(fanCountBuf, 'uint32');
    if (fanCount > 0) {
      const fanBuf = koffi.alloc('void*', fanCount);
      koffi.encode(fanCountBuf, 'uint32', fanCount);
      result = lib.ctlEnumFans(dev.handle, fanCountBuf, fanBuf);
      if (result !== CTL_RESULT.SUCCESS) {
        console.log(`[5]   ctlEnumFans(fill) -> ${describeResult(result)}`);
      } else {
        for (let f = 0; f < fanCount; f++) {
          const fanHandle = koffi.decode(fanBuf, f * 8, 'void*');
          const fan = {};

          const propBuf = koffi.alloc('ctl_fan_properties_t', 1);
          koffi.encode(propBuf, 'ctl_fan_properties_t', { Size: koffi.sizeof('ctl_fan_properties_t'), Version: 0 });
          result = lib.ctlFanGetProperties(fanHandle, propBuf);
          if (result === CTL_RESULT.SUCCESS) {
            const fp = koffi.decode(propBuf, 'ctl_fan_properties_t');
            fan.properties = {
              canControl: fp.canControl,
              supportedModes: (fp.supportedModes >>> 0).toString(2).padStart(4, '0'),
              supportedModesList: Object.entries(CTL_FAN_SPEED_MODE)
                .filter(([v]) => (fp.supportedModes & (1 << Number(v))) !== 0)
                .map(([, n]) => n),
              supportedUnitsList: Object.entries(CTL_FAN_SPEED_UNITS)
                .filter(([v]) => (fp.supportedUnits & (1 << Number(v))) !== 0)
                .map(([, n]) => n),
              maxRPM: fp.maxRPM,
              maxPoints: fp.maxPoints,
            };
            console.log(`[5]   fan[${f}] canControl=${fp.canControl} modes=${fan.properties.supportedModesList} units=${fan.properties.supportedUnitsList} maxRPM=${fp.maxRPM} maxPoints=${fp.maxPoints}`);
          } else {
            console.log(`[5]   fan[${f}] ctlFanGetProperties -> ${describeResult(result)}`);
          }

          const cfgBuf = koffi.alloc('ctl_fan_config_t', 1);
          koffi.encode(cfgBuf, 'ctl_fan_config_t', { Size: koffi.sizeof('ctl_fan_config_t'), Version: 0 });
          result = lib.ctlFanGetConfig(fanHandle, cfgBuf);
          if (result === CTL_RESULT.SUCCESS) {
            const cfg = koffi.decode(cfgBuf, 'ctl_fan_config_t');
            const table = [];
            for (let t = 0; t < Math.max(0, cfg.speedTable.numPoints); t++) {
              const tp = cfg.speedTable.table[t];
              table.push({ temperature: tp.temperature, speed: tp.speed.speed, units: CTL_FAN_SPEED_UNITS[tp.speed.units] });
            }
            fan.config = {
              mode: CTL_FAN_SPEED_MODE[cfg.mode] ?? cfg.mode,
              speedFixed: { speed: cfg.speedFixed.speed, units: CTL_FAN_SPEED_UNITS[cfg.speedFixed.units] ?? cfg.speedFixed.units },
              speedTable: { numPoints: cfg.speedTable.numPoints, table },
            };
            console.log(`[5]   fan[${f}] mode=${fan.config.mode} fixed=${cfg.speedFixed.speed}${fan.config.speedFixed.units} tablePoints=${cfg.speedTable.numPoints}`);
          } else {
            console.log(`[5]   fan[${f}] ctlFanGetConfig -> ${describeResult(result)}`);
          }

            fan.state = {};
            for (const [unitsKey, unitsVal] of Object.entries(CTL_FAN_SPEED_UNITS)) {
              const speedBuf = koffi.alloc('int32', 1);
              koffi.encode(speedBuf, 'int32', 0);
              result = lib.ctlFanGetState(fanHandle, Number(unitsKey), speedBuf);
              const speed = koffi.decode(speedBuf, 'int32');
              fan.state[unitsVal] = result === CTL_RESULT.SUCCESS ? speed : `ERR ${describeResult(result)}`;
            }
          console.log(`[5]   fan[${f}] state rpm=${fan.state.RPM} pct=${fan.state.PERCENT}`);
          d.fans.push(fan);
        }
      }
    }

    // ---------------------------------------------------------------------------
    // Step 6: waiver (developer's own machine, headless probe — allowed)
    // ---------------------------------------------------------------------------
    result = lib.ctlOverclockWaiverSet(dev.handle);
    console.log(`[6] ctlOverclockWaiverSet -> ${describeResult(result)}`);
    d.waiver = { result: result >>> 0, ok: result === CTL_RESULT.SUCCESS };

    // ---------------------------------------------------------------------------
    // Step 7: NO-OP apply round trips
    // ---------------------------------------------------------------------------
    const g = (fn, buf) => { const r = fn(dev.handle, buf); return { result: r >>> 0, value: koffi.decode(buf, 'double') }; };
    const s = (fn, v) => { const r = fn(dev.handle, v); return r >>> 0; };
    const equal = (a, b) => Math.abs(a - b) < 1e-9;

    const noops = { changed: false, changeReasons: [], results: [] };
    const runNoop = async (label, getFn, setFn, supported, delayMs = 0) => {
      if (typeof getFn !== 'function' || typeof setFn !== 'function') {
        noops.results.push({ control: label, get1: null, note: 'symbol unavailable in runtime (degraded)' });
        console.log(`[7]   ${label.padEnd(30)} symbol unavailable in runtime — skipped`);
        return;
      }
      const buf = koffi.alloc('double', 1);
      const g1 = g(getFn, buf);
      if (g1.result !== CTL_RESULT.SUCCESS) {
        noops.results.push({ control: label, get1: g1.result, note: 'get failed, skipped' });
        return;
      }
      if (delayMs) await sleep(delayMs);
      const setResult = s(setFn, g1.value);
      if (delayMs) await sleep(delayMs);
      const g2 = g(getFn, buf);
      const ok = setResult === CTL_RESULT.SUCCESS && g2.result === CTL_RESULT.SUCCESS && equal(g1.value, g2.value);
      const valueMismatch = g2.result === CTL_RESULT.SUCCESS && !equal(g1.value, g2.value);
      const readbackFailedAfterSet = setResult === CTL_RESULT.SUCCESS && g2.result !== CTL_RESULT.SUCCESS;
      if (valueMismatch || readbackFailedAfterSet) {
        // Conservative: a set that succeeded but cannot be verified is
        // treated as a possible state change so Step 10 resets the device.
        noops.changed = true;
        noops.changeReasons.push(`${label}: ${valueMismatch ? 'value mismatch after set' : 'set succeeded but read-back failed'}`);
      }
      noops.results.push({
        control: label,
        get1: g1.result,
        set: setResult,
        get2: g2.result,
        valueBefore: g1.value,
        valueAfter: g2.value,
        equal: ok,
        note: supported === false ? 'control reports bSupported=false' : undefined,
      });
      console.log(`[7]   ${label.padEnd(30)} get1=${describeResult(g1.result)} set=${describeResult(setResult)} get2=${describeResult(g2.result)} roundtrip=${ok ? 'OK' : 'MISMATCH'}${ok ? '' : ` (${g1.value} -> ${g2.value})`}`);
    };

    const c = d.ocProperties?.controls ?? {};
    console.log(`[7] no-op applies (set value = current value; no behavior change)`);
    await runNoop('gpuFrequencyOffset(V1)', lib.ctlOverclockGpuFrequencyOffsetGet, lib.ctlOverclockGpuFrequencyOffsetSet, c.gpuFrequencyOffset?.bSupported);
    await runNoop('gpuFrequencyOffset(V2)', lib.ctlOverclockGpuFrequencyOffsetGetV2, lib.ctlOverclockGpuFrequencyOffsetSetV2, c.gpuFrequencyOffset?.bSupported, 60);
    await runNoop('gpuVoltageOffset(V1, mV)', lib.ctlOverclockGpuVoltageOffsetGet, lib.ctlOverclockGpuVoltageOffsetSet, c.gpuVoltageOffset?.bSupported);
    await runNoop('gpuVoltageOffset(V2, V)', lib.ctlOverclockGpuMaxVoltageOffsetGetV2, lib.ctlOverclockGpuMaxVoltageOffsetSetV2, c.gpuVoltageOffset?.bSupported, 60);
    await runNoop('powerLimit(V1, mW)', lib.ctlOverclockPowerLimitGet, lib.ctlOverclockPowerLimitSet, c.powerLimit?.bSupported);
    await runNoop('powerLimit(V2, W)', lib.ctlOverclockPowerLimitGetV2, lib.ctlOverclockPowerLimitSetV2, c.powerLimit?.bSupported, 60);
    await runNoop('temperatureLimit(V1)', lib.ctlOverclockTemperatureLimitGet, lib.ctlOverclockTemperatureLimitSet, c.temperatureLimit?.bSupported);
    await runNoop('temperatureLimit(V2)', lib.ctlOverclockTemperatureLimitGetV2, lib.ctlOverclockTemperatureLimitSetV2, c.temperatureLimit?.bSupported, 60);
    await runNoop('vramFrequencyOffset(V1)', lib.ctlOverclockVramFrequencyOffsetGet, lib.ctlOverclockVramFrequencyOffsetSet, c.vramFrequencyOffset?.bSupported);
    await runNoop('vramVoltageOffset(V1)', lib.ctlOverclockVramVoltageOffsetGet, lib.ctlOverclockVramVoltageOffsetSet, c.vramVoltageOffset?.bSupported, 60);
    await runNoop('vramMemSpeedLimit(V2)', lib.ctlOverclockVramMemSpeedLimitGetV2, lib.ctlOverclockVramMemSpeedLimitSetV2, c.vramMemSpeedLimit?.bSupported, 60);

    // GPU lock: only no-op when a lock is already active (0,0 = dynamic = skip)
    {
      if (typeof lib.ctlOverclockGpuLockGet !== 'function' || typeof lib.ctlOverclockGpuLockSet !== 'function') {
        noops.results.push({ control: 'gpuLock', get1: null, note: 'symbol unavailable in runtime (degraded)' });
      } else {
        const lockBuf = koffi.alloc('ctl_oc_vf_pair_t', 1);
        koffi.encode(lockBuf, 'ctl_oc_vf_pair_t', { Size: koffi.sizeof('ctl_oc_vf_pair_t'), Version: 0 });
        result = lib.ctlOverclockGpuLockGet(dev.handle, lockBuf);
        const lock = koffi.decode(lockBuf, 'ctl_oc_vf_pair_t');
        if (result === CTL_RESULT.SUCCESS && (lock.Voltage !== 0 || lock.Frequency !== 0)) {
          const setResult = lib.ctlOverclockGpuLockSet(dev.handle, lock);
          const lock2Buf = koffi.alloc('ctl_oc_vf_pair_t', 1);
          koffi.encode(lock2Buf, 'ctl_oc_vf_pair_t', { Size: koffi.sizeof('ctl_oc_vf_pair_t'), Version: 0 });
          const g2r = lib.ctlOverclockGpuLockGet(dev.handle, lock2Buf);
          const lock2 = koffi.decode(lock2Buf, 'ctl_oc_vf_pair_t');
          const ok = setResult === CTL_RESULT.SUCCESS && g2r === CTL_RESULT.SUCCESS && lock2.Voltage === lock.Voltage && lock2.Frequency === lock.Frequency;
          const valueMismatch = g2r === CTL_RESULT.SUCCESS && (lock2.Voltage !== lock.Voltage || lock2.Frequency !== lock.Frequency);
          const readbackFailedAfterSet = setResult === CTL_RESULT.SUCCESS && g2r !== CTL_RESULT.SUCCESS;
          if (valueMismatch || readbackFailedAfterSet) {
            noops.changed = true;
            noops.changeReasons.push(`gpuLock: ${valueMismatch ? 'value mismatch after set' : 'set succeeded but read-back failed'}`);
          }
          noops.results.push({ control: 'gpuLock', get1: result, set: setResult, get2: g2r, equal: ok, valueBefore: { Voltage: lock.Voltage, Frequency: lock.Frequency }, valueAfter: { Voltage: lock2.Voltage, Frequency: lock2.Frequency } });
          console.log(`[7]   gpuLock no-op set -> ${describeResult(setResult)} roundtrip=${ok ? 'OK' : 'MISMATCH'}`);
        } else if (result !== CTL_RESULT.SUCCESS) {
          noops.results.push({ control: 'gpuLock', get1: result, note: `gpuLockGet failed (${describeResult(result)}); set skipped by safety rule` });
          console.log(`[7]   gpuLock: ${describeResult(result)} — set skipped (safety: would be a state change)`);
        } else {
          noops.results.push({ control: 'gpuLock', get1: result, note: 'no active lock (0,0=dynamic); set skipped by safety rule' });
          console.log(`[7]   gpuLock: no active lock, set skipped (safety: would be a state change)`);
        }
      }
    }

    d.noop = noops;
    console.log(`[7] any value actually changed: ${noops.changed}`);

    // ---------------------------------------------------------------------------
    // Step 8: VF curve (read-only — a write even of identical points switches
    // the curve type, i.e. a state change, so no-op write is intentionally skipped)
    // ---------------------------------------------------------------------------
    {
      d.vfCurve = {};
      if (typeof lib.ctlOverclockReadVFCurve !== 'function') {
        for (const typeVal of Object.values(CTL_VF_CURVE_TYPE)) {
          d.vfCurve[typeVal] = { error: 'symbol unavailable in runtime (degraded)', numPoints: 0 };
        }
        console.log(`[8]   VF curve read: symbol unavailable in runtime — skipped`);
      } else {
        for (const [typeKey, typeVal] of Object.entries(CTL_VF_CURVE_TYPE)) {
          const curveType = Number(typeKey);
          const numBuf = koffi.alloc('uint32', 1);
          koffi.encode(numBuf, 'uint32', 0);
          result = lib.ctlOverclockReadVFCurve(dev.handle, curveType, 2, numBuf, null); // ELABORATE
          const num = koffi.decode(numBuf, 'uint32');
          if (result === CTL_RESULT.SUCCESS && num > 0 && num < 10000) {
            const curveBuf = koffi.alloc('ctl_voltage_frequency_point_t', num);
            result = lib.ctlOverclockReadVFCurve(dev.handle, curveType, 2, numBuf, curveBuf);
            d.vfCurve[typeVal] = result === CTL_RESULT.SUCCESS
              ? { numPoints: num, points: decodeVfCurve(curveBuf, num) }
              : { error: describeResult(result) };
            console.log(`[8]   VF curve ${typeVal}: ${result === CTL_RESULT.SUCCESS ? `${num} points (first=${JSON.stringify(d.vfCurve[typeVal].points[0])}, last=${JSON.stringify(d.vfCurve[typeVal].points[num - 1])})` : describeResult(result)}`);
          } else {
            d.vfCurve[typeVal] = { error: describeResult(result), numPoints: num };
            console.log(`[8]   VF curve ${typeVal}: ${describeResult(result)}`);
          }
        }
      }
    }

    // ---------------------------------------------------------------------------
    // Step 9: power telemetry (3 samples, >50 ms apart)
    // ---------------------------------------------------------------------------
    const telNames = [
      'timeStamp', 'gpuEnergyCounter', 'gpuVoltage', 'gpuCurrentClockFrequency', 'gpuCurrentTemperature',
      'globalActivityCounter', 'renderComputeActivityCounter', 'mediaActivityCounter',
      'vramEnergyCounter', 'vramVoltage', 'vramCurrentClockFrequency', 'vramCurrentEffectiveFrequency',
      'vramReadBandwidthCounter', 'vramWriteBandwidthCounter', 'vramCurrentTemperature',
      'totalCardEnergyCounter', 'gpuVrTemp', 'vramVrTemp', 'saVrTemp', 'gpuEffectiveClock',
      'gpuOverVoltagePercent', 'gpuPowerPercent', 'gpuTemperaturePercent', 'vramReadBandwidth', 'vramWriteBandwidth',
    ];
    for (let sample = 0; sample < 3; sample++) {
      if (sample > 0) await sleep(60); // respect the 50 ms telemetry rate limit
      const telBuf = koffi.alloc('ctl_power_telemetry_t', 1);
      koffi.encode(telBuf, 'ctl_power_telemetry_t', { Size: koffi.sizeof('ctl_power_telemetry_t'), Version: 1 });
      result = lib.ctlPowerTelemetryGet(dev.handle, telBuf);
      if (result !== CTL_RESULT.SUCCESS) {
        d.telemetry.push({ error: describeResult(result) });
        console.log(`[9]   telemetry[${sample}] -> ${describeResult(result)}`);
        break;
      }
      const t = { sample, error: undefined, items: {}, flags: {}, psu: [], fanSpeed: [] };
      for (const name of telNames) t.items[name] = decodeItem(telBuf, 'ctl_power_telemetry_t', name);
      for (const name of ['gpuPowerLimited', 'gpuTemperatureLimited', 'gpuCurrentLimited', 'gpuVoltageLimited', 'gpuUtilizationLimited']) {
        t.flags[name] = koffi.decode(telBuf, koffi.offsetof('ctl_power_telemetry_t', name), 'bool');
      }
      const psuOff = koffi.offsetof('ctl_power_telemetry_t', 'psu');
      const fanOff = koffi.offsetof('ctl_power_telemetry_t', 'fanSpeed');
      const itemSz = koffi.sizeof('ctl_oc_telemetry_item_t');
      const psuSz = koffi.sizeof('ctl_psu_info_t');
      for (let i = 0; i < 5; i++) {
        t.psu.push(koffi.decode(telBuf, psuOff + i * psuSz, 'ctl_psu_info_t'));
        t.fanSpeed.push(koffi.decode(telBuf, fanOff + i * itemSz, 'ctl_oc_telemetry_item_t'));
      }
      d.telemetry.push(t);

      const gpuE = t.items.gpuEnergyCounter;
      const ts = t.items.timeStamp;
      const clock = t.items.gpuCurrentClockFrequency;
      const temp = t.items.gpuCurrentTemperature;
      const util = t.items.globalActivityCounter;
      console.log(`[9]   telemetry[${sample}]: clock=${clock.value}${clock.units} temp=${temp.value}C util=${util.value}${util.units} gpuEnergy=${gpuE.value}J${ts ? ` ts=${ts.value}` : ''} flags=${Object.entries(t.flags).filter(([, v]) => v).map(([k]) => k).join(',') || 'none'}`);
    }
    if (d.telemetry.length >= 2 && d.telemetry[0]?.items?.gpuEnergyCounter && d.telemetry[1]?.items?.gpuEnergyCounter) {
      // Energy/timestamp come as doubles in the telemetry item value; use them
      // directly (rawInt exists only for INT64/UINT64 items).
      const e0 = Number(d.telemetry[0].items.gpuEnergyCounter.value);
      const e1 = Number(d.telemetry[1].items.gpuEnergyCounter.value);
      const t0 = Number(d.telemetry[0].items.timeStamp.value);
      const t1 = Number(d.telemetry[1].items.timeStamp.value);
      if (Number.isFinite(e0) && Number.isFinite(e1) && Number.isFinite(t0) && Number.isFinite(t1) && e1 > e0 && t1 > t0) {
        const dt = t1 - t0;
        const powerW = (e1 - e0) / dt;
        console.log(`[9]   derived GPU power ~= ${powerW.toFixed(1)} W (energy delta ${(e1 - e0).toFixed(4)} J over ${(dt * 1000).toFixed(0)} ms)`);
        d.derivedPowerW = { deltaJ: e1 - e0, deltaS: dt, powerW: Number(powerW.toFixed(1)) };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 10: teardown — reset ONLY if the probe changed a value (it must not)
  // ---------------------------------------------------------------------------
  for (const dev of devices) {
    const d = capDevices[dev.index];
    if (d.noop?.changed) {
      const r = lib.ctlOverclockResetToDefault(dev.handle);
      const reasons = (d.noop.changeReasons ?? []).join('; ');
      console.log(`[10] value change detected on device ${dev.index} (${reasons}) — ctlOverclockResetToDefault -> ${describeResult(r)}`);
    } else {
      console.log(`[10] no value changes detected — ctlOverclockResetToDefault NOT called (state untouched).`);
    }
  }
  const closeResult = lib.ctlClose(apiHandle);
  console.log(`[10] ctlClose -> ${describeResult(closeResult)}`);

  // ---------------------------------------------------------------------------
  // Write outputs
  // ---------------------------------------------------------------------------
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const meta = {
    generatedAt: new Date().toISOString(),
    igclDll: dllPath,
    initResult: 'SUCCESS',
    levelZeroOk: levelZeroOk,
    supportedVersion: initOut.SupportedVersion >>> 0,
    applicationUID: usedUid === 'ZERO'
      ? { Data1: 0, Data2: 0, Data3: 0, Data4: [0, 0, 0, 0, 0, 0, 0, 0] }
      : APP_UID,
    applicationUidRetried: usedUid === 'ZERO',
  };

  const jsonReplacer = (key, value) => (typeof value === 'bigint' ? value.toString() : value);

  fs.writeFileSync(path.join(OUT_DIR, 'a770-capabilities.json'), JSON.stringify({ meta, devices: capDevices }, jsonReplacer, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'fans.json'), JSON.stringify({ meta, devices: capDevices.map((d) => ({ index: d.index, name: d.name, fans: d.fans })) }, jsonReplacer, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'telemetry.json'), JSON.stringify({ meta, devices: capDevices.map((d) => ({ index: d.index, name: d.name, derivedPowerW: d.derivedPowerW, telemetry: d.telemetry })) }, jsonReplacer, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'noop.json'), JSON.stringify({ meta, devices: capDevices.map((d) => ({ index: d.index, name: d.name, waiver: d.waiver, noop: d.noop })) }, jsonReplacer, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'run-summary.json'), JSON.stringify({ meta, devices: capDevices.map((d) => ({ index: d.index, name: d.name, ocProperties: d.ocProperties, waiver: d.waiver, noop: d.noop, derivedPowerW: d.derivedPowerW })) }, jsonReplacer, 2));

  console.log(`\nOutputs written to ${OUT_DIR}`);
} catch (err) {
  console.error(`\nPROBE FAILED: ${err.message}`);
  try { lib.ctlClose(apiHandle); } catch { /* ignore */ }
  process.exit(1);
}
