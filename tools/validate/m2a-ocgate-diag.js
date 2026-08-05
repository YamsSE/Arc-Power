// Arc Power — diagnostic: is the frequency offset gated on a raised power limit?
// Dev-only. ALWAYS restores. Auto-waiver allowed (dev machine).
import { IgclBackend } from '../../src/main/backend/igcl-backend.js';

const backend = new IgclBackend({ allowAutoWaiver: true });
await backend.init();
const lib = backend._lib;
await backend.listDevices();
const handle = backend._devices[0].handle;

const before = await backend.getCurrentSettings(0);
console.log('[before] power=' + before.powerLimitW, 'freq=' + before.gpuFreqOffsetMhz, 'volt=' + before.gpuVoltOffsetV);

lib.ctlOverclockWaiverSet(handle);

// Step 1: raise power limit to max (252), verify it sticks this time
const p1 = await backend.applySettings(0, { powerLimitW: 252 });
console.log('[set power 252] ' + JSON.stringify(p1.perControl.powerLimitW));
await new Promise((res) => setTimeout(res, 800));
let st = await backend.getCurrentSettings(0);
console.log('[readback] power=' + st.powerLimitW);

// Step 2: now try the frequency offset
const f1 = await backend.applySettings(0, { gpuFreqOffsetMhz: 5 });
console.log('[set freq +5] ' + JSON.stringify(f1.perControl.gpuFreqOffsetMhz));
await new Promise((res) => setTimeout(res, 800));
st = await backend.getCurrentSettings(0);
console.log('[readback] freq=' + st.gpuFreqOffsetMhz);

// Step 3: voltage offset still works?
const v1 = await backend.applySettings(0, { gpuVoltOffsetV: 0.01 });
console.log('[set volt +0.01] ' + JSON.stringify(v1.perControl.gpuVoltOffsetV));
await new Promise((res) => setTimeout(res, 800));
st = await backend.getCurrentSettings(0);
console.log('[readback] volt=' + st.gpuVoltOffsetV);

// Step 4: restore everything to the pre-run values
const r = await backend.applySettings(0, {
  powerLimitW: before.powerLimitW,
  gpuFreqOffsetMhz: before.gpuFreqOffsetMhz,
  gpuVoltOffsetV: before.gpuVoltOffsetV,
  tempLimitC: before.tempLimitC,
});
console.log('[restore] ' + JSON.stringify(r.perControl));
const after = await backend.getCurrentSettings(0);
console.log('[final] power=' + after.powerLimitW, 'freq=' + after.gpuFreqOffsetMhz, 'volt=' + after.gpuVoltOffsetV);

await backend.close();
process.exit(0);
