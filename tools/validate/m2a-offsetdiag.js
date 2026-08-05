// Arc Power — diagnostic: offset-set behavior on the current driver state.
// Dev-only. ALWAYS restores. Auto-waiver allowed (dev machine).
import { IgclBackend } from '../../src/main/backend/igcl-backend.js';

const backend = new IgclBackend({ allowAutoWaiver: true });
await backend.init();
const lib = backend._lib;
await backend.listDevices();
const handle = backend._devices[0].handle;

const before = await backend.getCurrentSettings(0);
console.log('[before] powerLimitW=' + before.powerLimitW, 'gpuFreqOffsetMhz=' + before.gpuFreqOffsetMhz, 'gpuVoltOffsetV=' + before.gpuVoltOffsetV);

// 1. Waiver result
let r = lib.ctlOverclockWaiverSet(handle);
console.log('[waiver] result=0x' + (r >>> 0).toString(16) + ' ' + r);

// 2. Non-zero frequency offset set + read-back (V2 via backend)
const f1 = await backend.applySettings(0, { gpuFreqOffsetMhz: 5 });
console.log('[set freq +5 MHz] ' + JSON.stringify(f1.perControl.gpuFreqOffsetMhz));
await new Promise((res) => setTimeout(res, 500));
let st = await backend.getCurrentSettings(0);
console.log('[readback] gpuFreqOffsetMhz=' + st.gpuFreqOffsetMhz);

// 3. Non-zero voltage offset set + read-back
const v1 = await backend.applySettings(0, { gpuVoltOffsetV: 0.01 });
console.log('[set volt +0.01 V] ' + JSON.stringify(v1.perControl.gpuVoltOffsetV));
await new Promise((res) => setTimeout(res, 500));
st = await backend.getCurrentSettings(0);
console.log('[readback] gpuVoltOffsetV=' + st.gpuVoltOffsetV);

// 4. Back to exactly zero (the value that failed in smoke)
const f0 = await backend.applySettings(0, { gpuFreqOffsetMhz: 0, gpuVoltOffsetV: 0 });
console.log('[set back to 0] ' + JSON.stringify(f0.perControl.gpuFreqOffsetMhz) + ' ' + JSON.stringify(f0.perControl.gpuVoltOffsetV));

// 5. Restore original values
await backend.applySettings(0, {
  gpuFreqOffsetMhz: before.gpuFreqOffsetMhz,
  gpuVoltOffsetV: before.gpuVoltOffsetV,
  powerLimitW: before.powerLimitW,
  tempLimitC: before.tempLimitC,
});
const after = await backend.getCurrentSettings(0);
console.log('[restored] freq=' + after.gpuFreqOffsetMhz, 'volt=' + after.gpuVoltOffsetV, 'power=' + after.powerLimitW);

await backend.close();
process.exit(0);
