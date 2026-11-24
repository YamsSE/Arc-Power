import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { TAURI_ROLE_CHANNELS, TAURI_ROLE_EVENTS } from '../src/shared/tauri-roles.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'tauri-dist');
await fs.mkdir(output, { recursive: true });
await fs.cp(path.join(root, 'src/renderer'), path.join(output, 'renderer'), { recursive: true });
await fs.cp(path.join(root, 'src/assets'), path.join(output, 'assets'), { recursive: true });
// Older builds used one shared auxiliary bundle. No page loads it now.
await fs.rm(path.join(output, 'renderer/out/tauri-aux.js'), { force: true });
const preload = await fs.readFile(path.join(root, 'src/preload.cjs'), 'utf8');
const invokeChannels = [...new Set([...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1]))].sort();
const eventChannels = [...new Set([...preload.matchAll(/ipcRenderer\.on\('([^']+)'/g)].map((match) => match[1]))].sort();
if (invokeChannels.length !== 156 || eventChannels.length !== 20) throw new Error(`Preload contract changed: ${invokeChannels.length} invokes, ${eventChannels.length} events; review migration coverage`);
await fs.mkdir(path.join(root, 'src-tauri/generated'), { recursive: true });
await fs.writeFile(path.join(root, 'src-tauri/generated/bridge-contract.json'), JSON.stringify({
  invokeChannels, eventChannels: [...new Set([...eventChannels, ...Object.values(TAURI_ROLE_EVENTS).flat()])].sort(),
  roleChannels: { main: invokeChannels, ...TAURI_ROLE_CHANNELS },
  roleEvents: { main: eventChannels, ...TAURI_ROLE_EVENTS },
}, null, 2) + '\n');
await build({
  absWorkingDir: root,
  entryPoints: ['src/renderer/platform/tauri-main.ts'],
  outdir: path.join(output, 'renderer/out'),
  bundle: true,
  format: 'iife',
  target: 'chrome109',
  alias: { electron: path.join(root, 'src/renderer/platform/tauri-electron-adapter.ts') },
  nodePaths: [path.join(root, 'src-tauri/frontend-deps/node_modules')],
});
for (const document of ['overlay', 'advanced-overlay', 'recording-toast', 'recording-status-pill', 'splash']) {
  const setup = document === 'splash'
    ? "await import('./src/renderer/splash-preload.cjs'); await import('./src/renderer/splash.js');"
    : `await import('./src/preload.cjs'); ${document === 'advanced-overlay' ? 'installDragRegions();' : ''} await import('./src/renderer/${document}.ts');`;
  await build({
    absWorkingDir: root,
    stdin: {
      contents: `import { initializeBridge, installConsoleBridge, installDragRegions, rendererReady, rendererFailed } from './src/renderer/platform/tauri-electron-adapter.ts';
async function start() { await initializeBridge(); installConsoleBridge(); ${setup} await rendererReady(); }
void start().catch(async error => { console.error('[tauri] auxiliary frontend failed', error); await rendererFailed().catch(() => {}); });`,
      resolveDir: root,
      loader: 'ts',
    },
    outfile: path.join(output, `renderer/out/tauri-${document}.js`),
    bundle: true,
    format: 'iife',
    target: 'chrome109',
    alias: { electron: path.join(root, 'src/renderer/platform/tauri-electron-adapter.ts') },
    nodePaths: [path.join(root, 'src-tauri/frontend-deps/node_modules')],
  });
}
for (const [document, entry] of Object.entries({ index: 'app', overlay: 'overlay', 'advanced-overlay': 'advanced-overlay',
  'recording-toast': 'recording-toast', 'recording-status-pill': 'recording-status-pill', splash: 'splash' })) {
const indexPath = path.join(output, `renderer/${document}.html`);
let html = await fs.readFile(indexPath, 'utf8');
// The Rust configuration owns one CSP. Avoid intersecting the old Electron-only
// media scheme policy with WebView2's normalized custom-protocol origin.
html = html.replace(/^.*<meta http-equiv="Content-Security-Policy"[^>]+>\r?\n/m, '');
html = document === 'splash'
  ? html.replace('./splash.js', './out/tauri-splash.js')
  : html.replace(`./out/${entry}.js`, `./out/tauri-${document === 'index' ? 'main' : document}.js`);
await fs.writeFile(indexPath, html);
}
console.log(`Built real Arc Power frontend: ${invokeChannels.length} invokes, ${eventChannels.length} events`);
