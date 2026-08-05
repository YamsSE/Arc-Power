// Arc Power — M2a diagnostic: does V1 (mW) power-limit set stick where V2 (W) doesn't?
// Dev-only script. ALWAYS restores the prior value. Auto-waiver allowed here (dev machine).
import koffi from 'koffi';
import { IgclBackend } from '../../src/main/backend/igcl-backend.js';

const backend = new IgclBackend({ allowAutoWaiver: true });
await backend.init();
const lib = backend._lib;
await backend.listDevices(); // populate _devices
const handle = backend._devices[0].handle;
const before = await backend.getCurrentSettings(0);
console.log('[before] powerLimitW=' + before.powerLimitW);

await backend.setWaiverAccepted(0);
const waive = lib.ctlOverclockWaiverSet(handle);
console.log('[waiver set] result=' + waive + ' (0=SUCCESS)');

// --- V1 path: set 230000 mW, read back via V1 and V2 ---
let res = lib.ctlOverclockPowerLimitSet(handle, 230000);
console.log('[v1 set 230000 mW] result=' + res);
await new Promise((r) => setTimeout(r, 700));
let buf = koffi.alloc('double', 1);
lib.ctlOverclockPowerLimitGet(handle, buf);
console.log('[v1 read] mW=' + koffi.decode(buf, 0, 'double'));
let v2 = await backend.getCurrentSettings(0);
console.log('[v2 read] W=' + v2.powerLimitW);

// --- V2 path for comparison: 230 W ---
res = await backend.applySettings(0, { powerLimitW: 230 });
console.log('[v2 set 230 W] ' + JSON.stringify(res.perControl.powerLimitW));
await new Promise((r) => setTimeout(r, 700));
v2 = await backend.getCurrentSettings(0);
console.log('[v2 read] W=' + v2.powerLimitW);

// --- Restore through V1 ---
const origMw = Math.round(before.powerLimitW * 1000);
res = lib.ctlOverclockPowerLimitSet(handle, origMw);
console.log('[restore v1 set ' + origMw + ' mW] result=' + res);
await new Promise((r) => setTimeout(r, 700));
const after = await backend.getCurrentSettings(0);
console.log('[restored] powerLimitW=' + after.powerLimitW, '(was ' + before.powerLimitW + ')');

await backend.close();
process.exit(0);
