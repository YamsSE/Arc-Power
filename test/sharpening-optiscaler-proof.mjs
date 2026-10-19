// Explicit disposable-copy integration proof for the OptiScaler -> ReShade chain.
// Never writes to the source game directory and never redistributes OptiScaler.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createPostprocessSharpening } from '../src/main/sharpening-postprocess.js';
import { RESHADE_DLL_SHA256 } from '../src/main/sharpening-runtime.js';

const artifactRoot = path.resolve(fileURLToPath(new URL('../.codex/task-artifacts/sharpening-render-proof', import.meta.url)));
const sourceProxy = 'D:\\SteamLibrary\\steamapps\\common\\Palworld\\Pal\\Binaries\\Win64\\dxgi.dll';
const expectedProxyHash = '62022e09a6679b12485da569f857220132155bfd2375fe01b4f232e306a76da6';
const runRoot = fs.mkdtempSync(path.join(artifactRoot, 'optiscaler-chain-'));
const hash = value => createHash('sha256').update(value).digest('hex');
const proxyBytes = fs.readFileSync(sourceProxy);
assert.equal(hash(proxyBytes), expectedProxyHash, 'The read-only source OptiScaler proxy changed identity.');
const sourceIni = `[Plugins]\r\nLoadReshade=false\r\n\r\n[Spoofing]\r\nDxgi=false\r\nStreamlineSpoofing=false\r\n\r\n[Hotfix]\r\nCheckForUpdate=false\r\n\r\n[Log]\r\nLogToFile=true\r\n`;
const report = { runRoot, sourceProxy, sourceProxySha256: expectedProxyHash, cases: [], ok: false };
const service = createPostprocessSharpening({
  dir: path.join(runRoot, 'appdata'),
  validateTarget(value) {
    const resolved = path.resolve(value);
    if (!resolved.startsWith(runRoot + path.sep)) throw new Error('Target escaped the disposable artifact root.');
    return resolved;
  },
});
function capture(exe, name, api) {
  const output = path.join(path.dirname(exe), `${name}.bmp`);
  const args = [...(api === 'DX11' ? ['--capture', 'gpu'] : []), '--frames', '480', '--output', output];
  const result = spawnSync(exe, args, { encoding: 'utf8', timeout: 45000, windowsHide: true, cwd: path.dirname(exe) });
  assert.equal(result.status, 0, `${api} probe failed: ${result.stderr || result.error}`);
  const bytes = fs.readFileSync(output);
  assert.equal(bytes.toString('ascii', 0, 2), 'BM');
  return { bytes, offset: bytes.readUInt32LE(10), width: bytes.readInt32LE(18), metadata: JSON.parse(result.stdout.trim().split('\n').at(-1)) };
}
function compare(a, b) {
  let changedPixels = 0, sum = 0, edgeA = 0, edgeB = 0;
  const [x0, y0, width, height] = [100, 100, 760, 440];
  for (let y = y0; y < y0 + height; y++) for (let x = x0; x < x0 + width; x++) {
    const p = a.offset + (y * a.width + x) * 4;
    let difference = 0;
    for (let k = 0; k < 3; k++) {
      difference += Math.abs(a.bytes[p + k] - b.bytes[p + k]);
      sum += Math.abs(a.bytes[p + k] - b.bytes[p + k]);
      edgeA += Math.abs(a.bytes[p + k] - a.bytes[p + 4 + k]);
      edgeB += Math.abs(b.bytes[p + k] - b.bytes[p + 4 + k]);
    }
    if (difference) changedPixels++;
  }
  return { roi: [x0, y0, width, height], changedPixels, meanAbsoluteDelta: sum / (width * height * 3), edgeEnergyRatio: edgeB / edgeA };
}

try {
  assert.equal(hash(fs.readFileSync(sourceProxy)), expectedProxyHash, 'Source proxy must remain untouched.');
  for (const api of ['DX11', 'DX12']) {
    const folder = path.join(runRoot, api);
    fs.mkdirSync(folder);
    const probeName = api === 'DX11' ? 'native-sharpening-probe.exe' : 'native-sharpening-probe-dx12.exe';
    const exe = path.join(folder, probeName);
    fs.copyFileSync(path.join(artifactRoot, probeName), exe);
    const proxy = path.join(folder, 'dxgi.dll');
    const optiIni = path.join(folder, 'OptiScaler.ini');
    fs.writeFileSync(proxy, proxyBytes, { flag: 'wx' });
    fs.writeFileSync(optiIni, sourceIni, { flag: 'wx' });
    const originalIni = fs.readFileSync(optiIni);
    assert.equal(hash(fs.readFileSync(proxy)), expectedProxyHash);

    const installed = await service.install(exe);
    assert.equal(installed.installed, true);
    assert.equal(installed.mode, 'optiscaler', 'The service must positively identify the copied OptiScaler proxy.');
    const patchedIni = fs.readFileSync(optiIni);
    assert.match(patchedIni.toString('latin1'), /\[Plugins\][\s\S]*?LoadReshade=true/);
    assert.equal(fs.existsSync(path.join(folder, 'ReShade64.dll')), true);
    assert.equal(fs.existsSync(path.join(folder, 'dxgi.dll')), true);
    assert.equal(hash(fs.readFileSync(path.join(folder, 'ReShade64.dll'))), RESHADE_DLL_SHA256);

    await service.setGlobal({ enabled: false, percentage: 0 });
    const off = capture(exe, 'off', api);
    await service.setGlobal({ enabled: true, percentage: 100 });
    const full = capture(exe, 'full', api);
    const difference = compare(off, full);
    assert.ok(difference.changedPixels > 1000, `${api} OptiScaler chain did not alter rendered pixels.`);
    assert.ok(difference.edgeEnergyRatio > 1, `${api} output did not gain sharpening edge energy.`);

    const removed = await service.remove(exe);
    assert.equal(removed.installed, false);
    assert.equal(hash(fs.readFileSync(proxy)), expectedProxyHash, 'Removal must retain the copied OptiScaler proxy.');
    assert.deepEqual(fs.readFileSync(optiIni), originalIni, 'Removal must restore the fixture INI byte-for-byte.');
    for (const file of ['ReShade64.dll', 'ReShade.ini']) assert.equal(fs.existsSync(path.join(folder, file)), false, `${file} should be removed.`);
    assert.equal(fs.existsSync(path.join(folder, 'ArcPowerSharpening', 'ArcPowerSharpen.fx')), false);
    const result = { api, adapter: full.metadata.adapter, difference, proxyHashRestored: hash(fs.readFileSync(proxy)), iniRestoredExactly: true, mode: installed.mode };
    report.cases.push(result);
    console.log(JSON.stringify(result));
  }
  report.ok = true;
} finally {
  report.sourceProxyAfterSha256 = hash(fs.readFileSync(sourceProxy));
  report.sourceProxyUntouched = report.sourceProxyAfterSha256 === expectedProxyHash;
  fs.writeFileSync(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Proof report: ${path.join(runRoot, 'report.json')}`);
}
