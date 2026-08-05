// Arc Power — M2a real-device cross-validation script.
//
// Applies powerLimit = 200 W (within the A770 range 105..252 W), reads back
// and verifies, then restores the EXACT prior value and verifies by read-back
// — the device is never left in a changed state. The human then visually
// cross-checks the change in Intel Graphics Software (and sees it restored).
//
// SAFETY (hard rules):
//   - this is a DEVELOPER-MACHINE script: it constructs the backend with
//     allowAutoWaiver: true — the ONLY allowed auto-accept, and it prints
//     that it accepted the waiver. Product code never does this.
//   - the prior power-limit value is restored with snapToStep:false so even
//     an off-grid value is written back EXACTLY as read.
//   - no driver/IGS file changes; no other control is touched.
//
// Usage: node tools/validate/m2a-apply.js      (real A770, IGCL via koffi)
//        RID_BACKEND=mock node tools/validate/m2a-apply.js   (dry-run in mock)

import { createBackend } from '../../src/main/backend/index.js';

const mock = process.env.RID_BACKEND === 'mock';
const backend = createBackend({
  kind: mock ? 'mock' : 'igcl',
  igcl: { allowAutoWaiver: true }, // DEV-ONLY: never in product code
  mock: {},
});

const TARGET = 200; // W, within the A770 capability range

async function main() {
  await backend.init();

  const [dev] = await backend.listDevices();
  if (!dev) throw new Error('no devices enumerated');
  console.log(`[device] ${dev.name} (PCI ${dev.pciVendorId}:${dev.pciDeviceId}, driver ${dev.driverVersion})`);

  const caps = await backend.getCapabilities(dev.id);
  const range = caps.ranges.powerLimitW;
  if (!range) throw new Error('powerLimit unsupported on this device — aborting');
  console.log(`[caps] powerLimit range ${range.min}..${range.max} W step ${range.step} default ${range.default}; waiverAccepted=${caps.waiverAccepted}`);
  if (TARGET < range.min || TARGET > range.max) throw new Error(`target ${TARGET} W out of range ${range.min}..${range.max}`);

  const before = await backend.getCurrentSettings(dev.id);
  console.log(`[before] powerLimitW=${before.powerLimitW}`);

  console.log('[waiver] auto-accepting waiver in this dev script ONLY (allowAutoWaiver=true — never in product code)');
  const res = await backend.applySettings(dev.id, { powerLimitW: TARGET });
  console.log(`[apply] perControl=${JSON.stringify(res.perControl)}`);
  if (!res.ok || !res.perControl.powerLimitW.ok) {
    throw new Error(`apply failed: ${JSON.stringify(res.perControl)}`);
  }

  const mid = await backend.getCurrentSettings(dev.id);
  console.log(`[readback] powerLimitW=${mid.powerLimitW} (expected ${TARGET})`);
  if (Math.abs(mid.powerLimitW - TARGET) > 1e-6) throw new Error(`read-back mismatch: ${mid.powerLimitW} != ${TARGET}`);

  // Restore the exact prior value (snapToStep:false preserves off-grid values).
  const restore = await backend.applySettings(dev.id, { powerLimitW: before.powerLimitW }, { snapToStep: false });
  console.log(`[restore] perControl=${JSON.stringify(restore.perControl)}`);
  if (!restore.ok || !restore.perControl.powerLimitW.ok) {
    throw new Error(`restore failed: ${JSON.stringify(restore.perControl)}`);
  }

  const after = await backend.getCurrentSettings(dev.id);
  console.log(`[verify] powerLimitW=${after.powerLimitW} (restored ${before.powerLimitW})`);
  if (Math.abs(after.powerLimitW - before.powerLimitW) > 1e-6) {
    throw new Error(`restore mismatch: ${after.powerLimitW} != ${before.powerLimitW}`);
  }

  await backend.close();
  console.log('[done] device restored to its prior value — cross-check in Intel Graphics Software now');
}

main().catch(async (err) => {
  console.error(`VALIDATION FAILED: ${err.message}`);
  try { await backend.close(); } catch { /* best effort */ }
  process.exitCode = 1;
});
