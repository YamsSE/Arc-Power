// M2a diagnostic (temporary): does a NON-no-op IGCL OC set stick on this A770?
// Tries powerLimit/tempLimit/freqOffset changes, re-reads after delays, then
// RESTORES every value it touched. Not part of the product.

import { createBackend } from '../../src/main/backend/index.js';

const backend = createBackend({
  kind: 'igcl',
  igcl: { allowAutoWaiver: true },
  mock: {},
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TARGETS = [
  ['powerLimitW', 230],
  ['tempLimitC', 85],
  ['gpuFreqOffsetMhz', 100],
];

async function main() {
  await backend.init();
  const [dev] = await backend.listDevices();
  const before = await backend.getCurrentSettings(dev.id);
  console.log('[before]', JSON.stringify(before));

  await backend.setWaiverAccepted(dev.id);
  const caps = await backend.getCapabilities(dev.id);
  console.log('[waiver] accepted =', caps.waiverAccepted);

  for (const [control, value] of TARGETS) {
    const res = await backend.applySettings(dev.id, { [control]: value });
    console.log(`[set ${control}=${value}]`, JSON.stringify(res.perControl[control]));
    const immediate = await backend.getCurrentSettings(dev.id);
    console.log(`  read-back immediate: ${control}=${immediate[control]}`);
    await sleep(1500);
    const later = await backend.getCurrentSettings(dev.id);
    console.log(`  read-back after 1.5s: ${control}=${later[control]}`);
  }

  // restore everything
  const restore = await backend.applySettings(dev.id, {
    powerLimitW: before.powerLimitW,
    tempLimitC: before.tempLimitC,
    gpuFreqOffsetMhz: before.gpuFreqOffsetMhz,
  }, { snapToStep: false });
  console.log('[restore]', JSON.stringify(restore.perControl));
  const after = await backend.getCurrentSettings(dev.id);
  console.log('[after]', JSON.stringify(after));
  await backend.close();
}

main().catch(async (err) => { console.error('DIAG FAILED:', err.message); try { await backend.close(); } catch {} process.exitCode = 1; });
