import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RTSS_WINGET_ID,
  detectRtssInstallation,
  installRtss,
} from '../src/main/rtss-install.js';

test('RTSS detection recognizes the normal installation path without invoking WinGet', async () => {
  const calls = [];
  const result = await detectRtssInstallation({
    platform: 'win32',
    env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
    exists: (filePath) => filePath.endsWith('RivaTuner Statistics Server\\RTSS.exe'),
    execFileAsync: async (...args) => { calls.push(args); return { stdout: '', stderr: '' }; },
  });
  assert.deepEqual(result, { installed: true, source: 'filesystem' });
  assert.equal(calls.length, 0);
});

test('RTSS detection tries the display-name query after an ID no-match', async () => {
  const calls = [];
  const result = await detectRtssInstallation({
    platform: 'win32',
    env: {},
    exists: () => false,
    execFileAsync: async (_file, args) => {
      calls.push(args);
      if (calls.length === 1) {
        const error = new Error('No package found');
        error.code = 1;
        throw error;
      }
      return { stdout: 'RivaTuner Statistics Server 7.3.7', stderr: '' };
    },
  });
  assert.equal(result.installed, true);
  assert.equal(result.source, 'winget');
  assert.deepEqual(calls.map((args) => args.slice(0, 3)), [
    ['list', '--id', RTSS_WINGET_ID],
    ['list', '--name', 'RivaTuner Statistics Server'],
  ]);
});

test('RTSS install returns alreadyInstalled and never invokes install when detection succeeds', async () => {
  let installs = 0;
  const result = await installRtss({
    platform: 'win32',
    detect: async () => ({ installed: true, source: 'winget' }),
    execFileAsync: async () => { installs += 1; return { stdout: '', stderr: '' }; },
  });
  assert.deepEqual(result, { ok: true, installed: true, alreadyInstalled: true, source: 'winget' });
  assert.equal(installs, 0);
});
