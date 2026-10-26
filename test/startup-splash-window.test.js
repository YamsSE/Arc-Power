import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const splashSource = readFileSync(path.join(projectRoot, 'src/main/splash.js'), 'utf8');
const windowOptions = splashSource.match(/new BrowserWindow\(\{([\s\S]*?)\n  \}\);/)?.[1] ?? '';

test('startup splash stays in normal z-order and does not force itself above other windows', () => {
  assert.notEqual(windowOptions, '');
  assert.doesNotMatch(windowOptions, /\balwaysOnTop\s*:\s*true/);
  assert.doesNotMatch(splashSource, /splash\.setAlwaysOnTop\s*\(/);
  assert.match(splashSource, /splash\.showInactive\(\)/);
});

test('ready-to-show passively shows the splash before promoting an available update prompt', () => {
  const readyHandler = splashSource.match(/splash\.once\('ready-to-show', \(\) => \{([\s\S]*?)\n  \}\);/)?.[1] ?? '';
  const passiveShow = readyHandler.indexOf('splash.showInactive()');
  const promptPromotion = readyHandler.indexOf('presentation.windowReady()');
  assert.notEqual(passiveShow, -1);
  assert.notEqual(promptPromotion, -1);
  assert.ok(passiveShow < promptPromotion, 'passive show must run before actionable prompt promotion');
});
