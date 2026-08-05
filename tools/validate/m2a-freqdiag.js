// Arc Power — diagnostic 3: V1 freq setter + voltage-first ordering.
// Dev-only. ALWAYS restores. Auto-waiver allowed (dev machine).
import koffi from 'koffi';
import { IgclBackend } from '../../src/main/backend/igcl-backend.js';

const backend = new IgclBackend({ allowAutoWaiver: true });
await backend.init();
const lib = backend._lib;
await backend.listDevices();
const handle = backend._devices[0].handle;

const before = await backend.getCurrentSettings(0);
console.log('[before] freq=' + before.gpuFreqOffsetMhz, 'volt=' + before.gpuVoltOffsetV, 'power=' + before.powerLimitW);

lib.ctlOverclockWaiverSet(handle);

// Test A: V1 frequency setter (fixed MHz)
let r = lib.ctlOverclockGpuFrequencyOffsetSet(handle, 5);
console.log('[V1 set freq 5 MHz] result=0x' + (r >>> 0).toString(16));
await new Promise((res) => setTimeout(res, 700));
let st = await backend.getCurrentSettings(0);
console.log('[readback] freq=' + st.gpuFreqOffsetMhz);
r = lib.ctlOverclockGpuFrequencyOffsetSet(handle, 0);
console.log('[V1 set freq 0] result=0x' + (r >>> 0).toString(16));
await new Promise((res) => setTimeout(res, 700));

// Test B: voltage first, then frequency (does volt set engage OC?)
const v1 = await backend.applySettings(0, { gpuVoltOffsetV: 0.02 });
console.log('[set volt +0.02] ' + JSON.stringify(v1.perControl.gpuVoltOffsetV));
await new Promise((res) => setTimeout(res, 700));
const f1 = await backend.applySettings(0, { gpuFreqOffsetMhz: 5 });
console.log('[then set freq +5] ' + JSON.stringify(f1.perControl.gpuFreqOffsetMhz));
await new Promise((res) => setTimeout(res, 700));
st = await backend.getCurrentSettings(0);
console.log('[readback] freq=' + st.gpuFreqOffsetMhz, 'volt=' + st.gpuVoltOffsetV);

// Restore everything
await backend.applySettings(0, {
  powerLimitW: before.powerLimitW,
  gpuFreqOffsetMhz: before.gpuFreqOffsetMhz,
  gpuVoltOffsetV: before.gpuVoltOffsetV,
  tempLimitC: before.tempLimitC,
});
const after = await backend.getCurrentSettings(0);
console.log('[final] freq=' + after.gpuFreqOffsetMhz, 'volt=' + after.gpuVoltOffsetV, 'power=' + after.powerLimitW);

await backend.close();
process.exit(0);
