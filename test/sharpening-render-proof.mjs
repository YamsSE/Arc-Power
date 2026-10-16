// Explicit integration harness: requires both locally built D3D probe EXEs.
// It never installs into a user game. All files stay in the owned artifact root.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const serviceModule = process.env.RID_SHARPENING_PROOF_MODULE
  ? pathToFileURL(path.resolve(process.env.RID_SHARPENING_PROOF_MODULE)).href
  : new URL('../src/main/sharpening-postprocess.js', import.meta.url).href;
const { createPostprocessSharpening } = await import(serviceModule);

const root = path.resolve(fileURLToPath(new URL('../.codex/task-artifacts/sharpening-render-proof', import.meta.url)));
const runRoot = fs.mkdtempSync(path.join(root, 'offline-integration-'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = { directory: runRoot, serviceModule, cases: [], ok: false };
const service = createPostprocessSharpening({
  dir: path.join(runRoot, 'appdata'),
  validateTarget(value) {
    const resolved = path.resolve(value);
    if (!resolved.startsWith(runRoot + path.sep)) throw new Error('Probe target escaped its artifact directory.');
    return resolved;
  },
});
function capture(exe, name, api) {
  const output = path.join(path.dirname(exe), name + '.bmp');
  const args = [...(api === 'DX11' ? ['--capture', 'gpu'] : []), '--frames', '480', '--output', output];
  const owned = ['ReShade.ini', 'ArcPowerSharpening/ArcPowerSharpen.fx', 'ArcPowerSharpening/preset.ini'];
  const before = owned.map(relative => hash(path.join(path.dirname(exe), relative)));
  const result = spawnSync(exe, args, { encoding: 'utf8', timeout: 45_000, windowsHide: true, cwd: path.dirname(exe) });
  assert.equal(result.status, 0, `${api} renderer failed: ${result.stderr || result.error}`);
  const after = owned.map(relative => hash(path.join(path.dirname(exe), relative)));
  assert.deepEqual(after, before, 'The managed runtime must not rewrite its config/preset/shader.');
  const bytes = fs.readFileSync(output);
  assert.equal(bytes.toString('ascii', 0, 2), 'BM');
  return { output, bytes, offset: bytes.readUInt32LE(10), width: bytes.readInt32LE(18), metadata: JSON.parse(result.stdout.trim().split('\n').at(-1)) };
}
function compare(a, b) {
  let changedPixels = 0, sum = 0, edgeA = 0, edgeB = 0;
  const x0 = 100, y0 = 100, width = 760, height = 440;
  for (let y = y0; y < y0 + height; y++) for (let x = x0; x < x0 + width; x++) {
    const p = a.offset + (y * a.width + x) * 4;
    let difference = 0;
    for (let k = 0; k < 3; k++) {
      const delta = Math.abs(a.bytes[p + k] - b.bytes[p + k]);
      difference += delta; sum += delta;
      edgeA += Math.abs(a.bytes[p + k] - a.bytes[p + 4 + k]);
      edgeB += Math.abs(b.bytes[p + k] - b.bytes[p + 4 + k]);
    }
    if (difference) changedPixels++;
  }
  return { roi: [x0, y0, width, height], changedPixels, meanAbsoluteDelta: sum / (width * height * 3), edgeEnergyA: edgeA, edgeEnergyB: edgeB, edgeEnergyRatio: edgeB / edgeA };
}
try {
  for (const api of ['DX11', 'DX12']) {
    const folder = path.join(runRoot, api); fs.mkdirSync(folder);
    const source = path.join(root, api === 'DX11' ? 'native-sharpening-probe.exe' : 'native-sharpening-probe-dx12.exe');
    const exe = path.join(folder, path.basename(source)); fs.copyFileSync(source, exe);
    assert.equal((await service.install(exe)).installed, true);
    await service.setGlobal({ enabled: false, percentage: 0 });
    const off = capture(exe, 'off', api);
    await service.setGlobal({ enabled: true, percentage: 0 });
    const zero = capture(exe, 'zero', api);
    assert.equal(compare(off, zero).changedPixels, 0, '0% must preserve the disabled image.');
    await service.setGlobal({ enabled: true, percentage: 50 });
    const half = capture(exe, 'half', api);
    await service.setGlobal({ enabled: true, percentage: 100 });
    const full = capture(exe, 'full', api);
    await service.setGame(exe, { enabled: true, percentage: 0 });
    const override = capture(exe, 'override-zero', api);
    assert.equal(compare(zero, override).changedPixels, 0, 'A game override of 0% must mask global 100%.');
    const halfDifference = compare(zero, half), fullDifference = compare(zero, full);
    assert.ok(fullDifference.changedPixels > 1000, 'The enabled filter must change rendered pixels.');
    assert.ok(fullDifference.edgeEnergyRatio > 1, 'Sharpening must increase edge energy in the test pattern.');
    assert.ok(fullDifference.meanAbsoluteDelta > halfDifference.meanAbsoluteDelta, 'The % slider must change strength.');
    await service.setGame(exe, null);
    assert.deepEqual((await service.getGame(exe)).value, { enabled: true, percentage: 100 });
    assert.equal((await service.remove(exe)).installed, false);
    assert.equal(fs.existsSync(path.join(folder, 'dxgi.dll')), false);
    assert.equal(fs.existsSync(path.join(folder, 'ReShade.ini')), false);
    report.cases.push({ api, adapter: full.metadata.adapter, halfDifference, fullDifference, configHashesUnchanged: true, overrideZeroMatchesDisabled: true, removeSucceeded: true });
    console.log(JSON.stringify(report.cases.at(-1)));
  }
  report.ok = true;
} finally {
  fs.writeFileSync(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Proof report: ${path.join(runRoot, 'report.json')}`);
}
