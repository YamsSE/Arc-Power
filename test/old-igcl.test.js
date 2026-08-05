// M2C-C — bundled 2023 IGCL runtime tests (old-igcl.js): the init/enum/
// waiver sequence, the mW<->W conversions, the extended ceilings, the
// momentary-lie delayed verification, and the not-capable degradation.
// A fake bound lib is injected — the real DLL is never loaded here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import koffi from 'koffi';
import {
  OldIgcl, wToMw, mwToW, checkOldPropsSize,
  EXTENDED_PL_MAX_W, EXTENDED_PL_MIN_W, EXTENDED_TL_MAX_C, EXTENDED_TL_MIN_C,
  DELAYED_VERIFY_MS, EXTENDED_PL_RANGE, EXTENDED_TL_RANGE, OLD_IGCL_VERSION,
} from '../src/main/old-igcl.js';
import { CTL_RESULT } from '../src/main/backend/igcl-bindings.js';
import { EXTENDED_UNAVAILABLE_MSG } from '../src/main/apply-routing.js';

// ---------------------------------------------------------------------------
// Conversions + ceilings
// ---------------------------------------------------------------------------

test('mW <-> W conversions', () => {
  assert.equal(wToMw(300), 300000);
  assert.equal(wToMw(228), 228000);
  assert.equal(mwToW(315000), 315);
  assert.equal(mwToW(280000), 280);
});

test('extended ceilings are the verified KMD limits', () => {
  assert.equal(EXTENDED_PL_MAX_W, 315);
  assert.equal(EXTENDED_PL_MIN_W, 105);
  assert.equal(EXTENDED_TL_MAX_C, 115);
  assert.equal(EXTENDED_TL_MIN_C, 60);
  assert.equal(DELAYED_VERIFY_MS, 400);
  assert.equal(OLD_IGCL_VERSION, '1.0.100');
  assert.deepEqual(EXTENDED_PL_RANGE, { min: 105, max: 315, step: 1 });
  assert.deepEqual(EXTENDED_TL_RANGE, { min: 60, max: 115, step: 1 });
});

// ---------------------------------------------------------------------------
// Fake bound lib (OldIgcl duck)
// ---------------------------------------------------------------------------

/**
 * Build a fake IGCL lib. Handles are encoded into the koffi buffers (a
 * non-zero external passes the class's NULL checks); the OC setters mutate a
 * device state so the read-back helpers can observe real writes.
 */
function fakeLib({ failInit = false, failWaiver = false, failEnum = false, setterResults = {} } = {}) {
  const state = { powerMw: 228000, tempC: 90 };
  const calls = [];
  const lib = {
    calls,
    state,
    unavailable: [],
    ctlInit: (args, out) => {
      calls.push(['ctlInit', koffi.decode(args, 'ctl_init_args_t')]);
      if (failInit) return CTL_RESULT.ERROR_UNSUPPORTED_VERSION;
      koffi.encode(out, 'void*', 1);
      return CTL_RESULT.SUCCESS;
    },
    ctlClose: () => CTL_RESULT.SUCCESS,
    ctlEnumerateDevices: (_api, countBuf, listBuf) => {
      calls.push(['ctlEnumerateDevices']);
      if (failEnum) return CTL_RESULT.ERROR_NOT_AVAILABLE;
      koffi.encode(countBuf, 'uint32', 1);
      if (listBuf !== null) koffi.encode(listBuf, 'void*', 1);
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockWaiverSet: () => {
      calls.push(['ctlOverclockWaiverSet']);
      return failWaiver ? CTL_RESULT.ERROR_CORE_OVERCLOCK_WAIVER_NOT_SET : CTL_RESULT.SUCCESS;
    },
    ctlOverclockGetProperties: () => CTL_RESULT.ERROR_UNSUPPORTED_VERSION,
    ctlOverclockPowerLimitSet: (_dev, mw) => {
      calls.push(['ctlOverclockPowerLimitSet', mw]);
      const forced = setterResults.powerLimitW;
      if (forced !== undefined) return forced;
      state.powerMw = mw;
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockPowerLimitGet: () => CTL_RESULT.SUCCESS,
    ctlOverclockTemperatureLimitSet: (_dev, c) => {
      calls.push(['ctlOverclockTemperatureLimitSet', c]);
      const forced = setterResults.tempLimitC;
      if (forced !== undefined) return forced;
      state.tempC = c;
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockTemperatureLimitGet: () => CTL_RESULT.SUCCESS,
  };
  return { lib, calls, state };
}

/** Override the read path (koffi getters are opaque in tests). */
function withRead(old, readFn) {
  old._read = readFn;
  return old;
}

test('isCapable: init + enum + waiver SUCCESS -> true; sequence runs exactly once', async () => {
  const { lib, calls } = fakeLib();
  const old = new OldIgcl({ lib, sleep: async () => {} });
  assert.equal(await old.isCapable(), true);
  assert.equal(await old.isCapable(), true);
  assert.equal(calls.filter((c) => c[0] === 'ctlInit').length, 1);
  assert.equal(calls.filter((c) => c[0] === 'ctlEnumerateDevices').length, 2, 'two-pass enumeration (null list + fill)');
  assert.equal(calls.filter((c) => c[0] === 'ctlOverclockWaiverSet').length, 1);
  await old.close();
});

test('isCapable: init failure -> false with the honest error (never throws from isCapable)', async () => {
  const { lib } = fakeLib({ failInit: true });
  const old = new OldIgcl({ lib, sleep: async () => {} });
  assert.equal(await old.isCapable(), false);
  assert.match(old.lastError, /init failed/);
  assert.equal(await old.isCapable(), false, 'cached — no re-init after a failure');
});

test('isCapable: waiver failure -> false', async () => {
  const { lib } = fakeLib({ failWaiver: true });
  const old = new OldIgcl({ lib, sleep: async () => {} });
  assert.equal(await old.isCapable(), false);
  assert.match(old.lastError, /waiver failed/);
});

test('isCapable: enumeration failure -> false', async () => {
  const { lib } = fakeLib({ failEnum: true });
  const old = new OldIgcl({ lib, sleep: async () => {} });
  assert.equal(await old.isCapable(), false);
});

test('isCapable: DLL missing -> false (mock findDll) — the degradation path', async () => {
  const old = new OldIgcl({ lib: null, findDll: () => null, sleep: async () => {} });
  assert.equal(await old.isCapable(), false);
  assert.match(old.lastError, /not found/);
});

test('setPowerLimitW: writes mW, immediate read-back match -> ok', async () => {
  const { lib, state } = fakeLib();
  const old = withRead(new OldIgcl({ lib, sleep: async () => {} }), () => mwToW(state.powerMw));
  const per = await old.setPowerLimitW(300);
  assert.equal(per.ok, true);
  assert.equal(per.readBackEqual, true);
  assert.ok(lib.calls.some((c) => c[0] === 'ctlOverclockPowerLimitSet' && c[1] === 300000), 'V1 setter in mW');
  assert.equal(state.powerMw, 300000);
});

test('setTempLimitC: writes C directly, immediate read-back match -> ok', async () => {
  const { lib, state } = fakeLib();
  const old = withRead(new OldIgcl({ lib, sleep: async () => {} }), () => state.tempC);
  const per = await old.setTempLimitC(110);
  assert.equal(per.ok, true);
  assert.ok(lib.calls.some((c) => c[0] === 'ctlOverclockTemperatureLimitSet' && c[1] === 110));
});

test('the momentary-lie guard: immediate mismatch + delayed match = ok (persisted)', async () => {
  const { lib } = fakeLib();
  const reads = [];
  const seq = [228, 300]; // the write lands between the immediate read and the delayed re-read
  const old = withRead(new OldIgcl({ lib, sleep: async () => {} }), () => {
    reads.push(seq[0]);
    return seq.shift();
  });
  const per = await old.setPowerLimitW(300);
  assert.equal(per.ok, true, 'delayed re-read match = the write persisted');
  assert.deepEqual(reads, [228, 300], 'one immediate read + exactly ONE delayed re-read');
});

test('M1: the lie is caught even on match-then-REVERT — the delayed re-read ALWAYS runs (ok:false)', async () => {
  const { lib } = fakeLib();
  const sleeps = [];
  const reads = [];
  const seq = [300, 228]; // SUCCESS + momentary read-back MATCH, then revert
  const old = withRead(new OldIgcl({ lib, sleep: async (ms) => { sleeps.push(ms); } }), () => {
    reads.push(seq[0]);
    return seq.shift();
  });
  const per = await old.setPowerLimitW(300);
  assert.equal(per.ok, false, 'the match-then-revert lie must be an honest fail');
  assert.equal(per.errorCode, 'io-failed');
  assert.match(per.message, /read-back 228 != requested 300/);
  assert.deepEqual(reads, [300, 228], 'immediate match + one ALWAYS delayed re-read');
  assert.deepEqual(sleeps, [400], 'the delayed re-read ran even though the immediate read matched');
});

test('M1: match-then-PERSIST -> ok (the delayed re-read confirms the write)', async () => {
  const { lib } = fakeLib();
  const sleeps = [];
  const reads = [];
  const old = withRead(new OldIgcl({ lib, sleep: async (ms) => { sleeps.push(ms); } }), () => {
    reads.push(300);
    return 300;
  });
  const per = await old.setPowerLimitW(300);
  assert.equal(per.ok, true);
  assert.equal(per.readBackEqual, true);
  assert.deepEqual(reads, [300, 300], 'immediate + delayed read both match');
  assert.deepEqual(sleeps, [400], 'ok is only reported after the delayed re-read');
});

test('the momentary-lie guard: immediate + delayed mismatch = honest per-control fail', async () => {
  const { lib } = fakeLib();
  const reads = [];
  const old = withRead(new OldIgcl({ lib, sleep: async () => {} }), () => { reads.push(228); return 228; });
  const per = await old.setPowerLimitW(300);
  assert.equal(per.ok, false);
  assert.equal(per.readBackEqual, false);
  assert.equal(per.errorCode, 'io-failed');
  assert.match(per.message, /read-back 228 != requested 300/);
  assert.equal(reads.length, 2, 'immediate + one delayed re-read, then an honest fail');
});

test('setter refusal (0x44000004 power outside range) maps to out-of-range', async () => {
  const { lib } = fakeLib({ setterResults: { powerLimitW: 0x44000004 } });
  const old = withRead(new OldIgcl({ lib, sleep: async () => {} }), () => 228);
  const per = await old.setPowerLimitW(300);
  assert.equal(per.ok, false);
  assert.equal(per.errorCode, 'out-of-range');
  assert.match(per.message, /IGCL ERROR_CORE_OVERCLOCK_POWER_OUTSIDE_RANGE/);
});

test('values are clamped to the verified ceilings (never above 315 W / 115 C)', async () => {
  const { lib, state } = fakeLib();
  const old = withRead(new OldIgcl({ lib, sleep: async () => {} }), () => mwToW(state.powerMw));
  const per = await old.setPowerLimitW(999);
  assert.equal(per.ok, true);
  assert.equal(state.powerMw, 315000, 'clamped to 315 W — the KMD ceiling');

  const f2 = fakeLib();
  const old2 = withRead(new OldIgcl({ lib: f2.lib, sleep: async () => {} }), () => f2.state.tempC);
  const per2 = await old2.setTempLimitC(999);
  assert.equal(per2.ok, true);
  assert.equal(f2.state.tempC, 115, 'clamped to 115 C — the KMD ceiling');
});

test('not capable -> setters answer with the honest unavailable message', async () => {
  const old = new OldIgcl({ lib: null, findDll: () => null, sleep: async () => {} });
  const per = await old.setPowerLimitW(300);
  assert.equal(per.ok, false);
  assert.equal(per.errorCode, 'unsupported');
  assert.equal(per.message, EXTENDED_UNAVAILABLE_MSG);
});

test('the 400 ms delayed-verify delay is honored via the injected sleep', async () => {
  const { lib } = fakeLib();
  const sleeps = [];
  const old = withRead(new OldIgcl({ lib, sleep: async (ms) => { sleeps.push(ms); } }), () => 228);
  await old.setPowerLimitW(300);
  assert.deepEqual(sleeps, [400]);
});

// ---------------------------------------------------------------------------
// Init-args fixture (the 2023-era contract the class must always send)
// ---------------------------------------------------------------------------

test('init args fixture: Size 36, Version 0, AppVersion 1.0, LZ flag, zero UID', async () => {
  const { lib, calls } = fakeLib();
  const old = new OldIgcl({ lib, sleep: async () => {} });
  await old.isCapable();
  const init = calls.find((c) => c[0] === 'ctlInit');
  assert.ok(init, 'ctlInit called');
  const args = init[1];
  assert.equal(args.Size, 36);
  assert.equal(args.Version, 0);
  assert.equal(args.AppVersion, 0x00010000, 'MAKE_VERSION(1,0)');
  assert.equal(args.flags, 1, 'CTL_INIT_FLAG_USE_LEVEL_ZERO');
  assert.equal(args.Size, 36);
  assert.equal(args.Version, 0);
  assert.equal(args.ApplicationUID.Data1, 0);
  assert.equal(args.ApplicationUID.Data2, 0);
  assert.equal(args.ApplicationUID.Data3, 0);
  assert.deepEqual([...args.ApplicationUID.Data4], [0, 0, 0, 0, 0, 0, 0, 0], 'zero UID');
});

test('N2: the layout assert moved into the constructor — module import never throws; checkOldPropsSize throws on mismatch', () => {
  // This whole file imports the module — if the assert ran at import time,
  // none of the tests above would have loaded. The check now lives behind
  // the injectable helper the constructor calls.
  assert.equal(checkOldPropsSize(() => 296), 296, 'the real 296-byte layout passes');
  assert.throws(() => checkOldPropsSize(() => 295), /Layout mismatch/);
  assert.throws(() => checkOldPropsSize(() => 300), /Layout mismatch/);
  assert.doesNotThrow(() => new OldIgcl({ lib: null, findDll: () => null, sleep: async () => {} }), 'construction (the load path) is where the check runs');
});
