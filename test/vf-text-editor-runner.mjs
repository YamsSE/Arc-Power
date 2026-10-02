// Run with Electron: electron test/vf-text-editor-runner.mjs
import { app } from 'electron';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const isolatedDirectory = mkdtempSync(path.join(os.tmpdir(), 'arcpower-vf-text-'));
// Exercise profile capture's unsupported surfaces before the real Chromium run.
const captureModule = path.join(isolatedDirectory, 'profile-capture.mjs');
await build({ entryPoints: ['src/renderer/pages/profiles.ts'], bundle: true, platform: 'node', format: 'esm', outfile: captureModule });
globalThis.window = { arcPower: {} };
const { captureProfileSettings, settingsFromState } = await import(pathToFileURL(captureModule).href);
const curve = [{ voltageV: 0.6, freqMhz: 1800 }, { voltageV: 0.7, freqMhz: 2000 }];
const alchemist = { deviceId: 0, devices: [], caps: { deviceName: 'Intel Arc A580', deviceKey: 'a580' }, state: { powerLimitW: 180, vfCurve: curve, vfCurveDefault: curve } };
const a580Capture = await captureProfileSettings({ store: { get: () => alchemist } });
assert.deepEqual(a580Capture.settings.vfCurve, curve);
assert.ok(!('vfCurveStockReference' in a580Capture.settings), 'A580 cached save must not add a Battlemage STOCK reference');
assert.ok(!('vfCurveStockReference' in settingsFromState(alchemist.state)), 'Legacy state conversion must omit STOCK reference');
const vfModule = path.join(isolatedDirectory, 'vf-reference.mjs');
await build({ entryPoints: ['src/renderer/pure/vf-curve.ts'], bundle: true, platform: 'node', format: 'esm', outfile: vfModule });
const { rebaseVfCurveToReference } = await import(pathToFileURL(vfModule).href);
const stock = [...curve, { voltageV: 0.8, freqMhz: 2200 }];
const edited = stock.map((point, index) => ({ ...point, voltageV: point.voltageV + (index === 1 ? 0.01 : 0) }));
const freshStock = stock.map((point) => ({ ...point, voltageV: point.voltageV + 0.05 }));
const rebased = rebaseVfCurveToReference(edited, stock, freshStock, {
  voltageMinV: 0.4, voltageMaxV: 1.5, freqMinMhz: 400, freqMaxMhz: 4300,
  voltageStepV: 0.001, frequencyStepMhz: 10, maxPoints: 10,
});
assert.ok(Math.abs(rebased[1].voltageV - freshStock[1].voltageV - 0.01) < 1e-6, 'Native reference helper must preserve the explicit per-point voltage delta');
assert.deepEqual(rebased.map(point => point.freqMhz), edited.map(point => point.freqMhz));
const unsupported = { deviceId: 0, devices: [], caps: { deviceName: 'Intel Arc B580', deviceKey: 'b580', controls: {} }, state: { powerLimitW: 100 } };
const scalarCapture = await captureProfileSettings({ store: { get: () => unsupported } });
assert.deepEqual(scalarCapture.settings, { powerLimitW: 100 }, 'Unsupported B580 must retain scalar profile saving');
// Minimal DOM records the refusal toast; no hardware backend is invoked.
const toastItems = [];
globalThis.document = {
  getElementById: (id) => id === 'toast-stack' ? { append: (item) => toastItems.push(item) } : null,
  createElement: () => ({ dataset: {}, children: [], setAttribute() {}, addEventListener() {}, append(child) { this.children.push(child); } }),
};
window.location = { hash: '#/tuning' };
window.setTimeout = () => 0;
unsupported.caps.controlStatus = { vfCurve: { state: 'runtime-refused' } };
assert.equal(await captureProfileSettings({ store: { get: () => unsupported } }), null, 'Runtime-refused B580 must fail closed');
assert.equal(toastItems.length, 1, 'Runtime refusal must explain failed profile capture');
delete unsupported.caps.controlStatus;
unsupported.state.vfCurve = curve;
assert.equal(await captureProfileSettings({ store: { get: () => unsupported } }), null, 'Existing VF state without a range must fail closed');
delete globalThis.document;
delete globalThis.window;
app.setPath('appData', isolatedDirectory);
// The existing mock store resolves its directory through os.tmpdir().
os.tmpdir = () => isolatedDirectory;
process.env.RID_MOCK_FEATURESET = 'b580';
process.env.RID_MOCK_VF_TEXT_EDITOR_VERIFY = '1';
process.argv.push('--ui-verify');
await import('../src/main/main.js');
