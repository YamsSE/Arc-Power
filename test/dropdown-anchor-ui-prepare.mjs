import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import electronPath from 'electron';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const dir = mkdtempSync(path.join(os.tmpdir(), 'arc-dropdown-anchor-'));
const bundle = path.join(dir, 'dropdown.js');
const html = path.join(dir, 'fixture.html');
const artifacts = path.join(root, '.codex', 'task-artifacts', 'dropdown-125');
const runner = path.join(root, 'test', 'dropdown-anchor-ui-runner.mjs');
console.log('Preparing isolated dropdown fixture');
const build = spawnSync(process.execPath, [
  path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  'src/renderer/components/dropdown.ts', '--bundle', '--format=iife', '--global-name=Dropdown', `--outfile=${bundle}`,
], { cwd: root, encoding: 'utf8', timeout: 20_000, windowsHide: true });
if (build.stdout) process.stdout.write(build.stdout);
if (build.stderr) process.stderr.write(build.stderr);
assert.ifError(build.error);
assert.equal(build.status, 0, `esbuild exited with status ${build.status}`);
writeFileSync(html, `<meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(root, 'src/renderer/styles.css'))}"><link rel="stylesheet" href="${pathToFileURL(path.join(root, 'src/renderer/advanced-overlay.css'))}"><style>*{box-sizing:border-box;animation:none!important;transition:none!important}body{margin:0}.scroller{position:absolute;left:40px;top:40px;width:240px;height:180px;overflow:auto;border:1px solid}.content{height:600px;padding-top:40px}.anchor{position:relative;width:180px;height:32px;margin-top:29px}.graphics-card{position:absolute;left:350px;top:40px;width:220px;height:64px;overflow:hidden;padding:4px}</style><div class="scroller"><div class="content"><div id="anchor" class="anchor"></div></div></div><div id="compact-card" class="graphics-card"></div><script src="${bundle.replaceAll('\\', '/')}"></script>`);
const run = spawnSync(electronPath, [runner, html, artifacts], {
  cwd: root,
  encoding: 'utf8',
  timeout: 20_000,
  windowsHide: true,
});
if (run.stdout || run.error?.stdout) process.stdout.write(run.stdout || run.error.stdout.toString());
if (run.stderr || run.error?.stderr) process.stderr.write(run.stderr || run.error.stderr.toString());
assert.ifError(run.error);
assert.equal(run.signal, null, `Electron exited by signal ${run.signal}`);
assert.equal(run.status, 0, `Electron fixture exited with status ${run.status}`);
