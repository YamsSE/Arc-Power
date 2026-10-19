import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { querySystemWindowsDirectory, stageScreenSharpeningHelper } from '../src/main/sharpening-helper-stage.js';

const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/main/sharpening-runtime/ArcPower.ScreenSharpen.exe');

test('helper stager gets the Windows directory from the native API and asynchronously protects the staged copy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-power-helper-stage-'));
  let stagedDirectory;
  let powerShellPath;
  let directoryQueryCount = 0;
  const contents = fs.readFileSync(HELPER);
  const expectedHash = createHash('sha256').update(contents).digest('hex').toUpperCase();
  const staged = await stageScreenSharpeningHelper(HELPER, expectedHash, {
    platform: 'win32',
    getWindowsDirectory({ platform }) {
      directoryQueryCount++;
      assert.equal(platform, 'win32');
      return 'C:\\Windows';
    },
    execFileAsyncImpl: async (file, args) => {
      powerShellPath = file;
      assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle']);
      assert.equal(file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      const id = script.match(/\$suffix = '([0-9a-f-]+)'/i)?.[1];
      assert.ok(id, 'protected directory name uses a generated GUID');
      const base = path.win32.resolve(root);
      stagedDirectory = path.win32.join(base, `ArcPower-ScreenSharpen-${id}`);
      fs.mkdirSync(stagedDirectory);
      return { stdout: `${base}\r\n${stagedDirectory}\r\n`, stderr: '' };
    },
  });
  try {
    assert.equal(directoryQueryCount, 1);
    assert.equal(powerShellPath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(fs.readFileSync(staged.path).compare(contents), 0);
    assert.equal(fs.statSync(staged.path).nlink, 1);
  } finally {
    staged.cleanup();
    assert.equal(fs.existsSync(stagedDirectory), false, 'shutdown cleanup removes the per-run stage');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('helper stager fails closed if the native Windows-directory query is invalid', async () => {
  let powerShellLaunched = false;
  await assert.rejects(() => stageScreenSharpeningHelper(HELPER, createHash('sha256').update(fs.readFileSync(HELPER)).digest('hex'), {
    platform: 'win32',
    getWindowsDirectory() { return 'relative\\Windows'; },
    execFileAsyncImpl: async () => { powerShellLaunched = true; return { stdout: '', stderr: '' }; },
  }), /invalid system directory/i);
  assert.equal(powerShellLaunched, false);
});

test('helper stager rejects a modified source before resolving system paths or creating a runtime directory', async () => {
  let directoryQueried = false;
  await assert.rejects(() => stageScreenSharpeningHelper(HELPER, '0'.repeat(64), {
    platform: 'win32',
    getWindowsDirectory() { directoryQueried = true; return 'C:\\Windows'; },
    execFileAsyncImpl: async () => ({ stdout: '', stderr: '' }),
  }), /integrity check/i);
  assert.equal(directoryQueried, false);
});

test('native Windows-directory query uses GetSystemWindowsDirectoryW and decodes its WCHAR result', () => {
  // Keep the Win32 boundary injectable so this shape can be checked on every CI host.
  const directory = 'C:\\Windows';
  let apiName;
  const kernel32 = {
    func(name, result, args) {
      apiName = name;
      assert.equal(result, 'uint32');
      assert.deepEqual(args, ['void*', 'uint32']);
      return (output, capacity) => {
        assert.equal(capacity, 32768);
        assert.equal(output.length, capacity * 2);
        output.write(directory, 0, 'utf16le');
        return directory.length;
      };
    },
  };
  assert.equal(querySystemWindowsDirectory({ platform: 'win32', load: (name) => {
    assert.equal(name, 'kernel32.dll');
    return kernel32;
  } }), directory);
  assert.equal(apiName, 'GetSystemWindowsDirectoryW');
});
