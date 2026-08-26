import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createPortableHandoffScript,
  expectedAssetName,
  parseReleaseTag,
  selectReleaseAsset,
  validateDownloadedUpdatePath,
  validatePortableTargetPath,
  validateReleaseAssetUrl,
} from '../src/main/auto-update-pure.js';

const release = {
  tag_name: 'v1.0.6',
  assets: [
    {
      name: 'Arc-Power_Installer.exe',
      browser_download_url: 'https://github.com/YamsSE/Arc-Power/releases/download/v1.0.6/Arc-Power_Installer.exe',
    },
    {
      name: 'Arc-Power_Portable.exe',
      browser_download_url: 'https://github.com/YamsSE/Arc-Power/releases/download/v1.0.6/Arc-Power_Portable.exe',
    },
  ],
};

test('release tags and build-specific assets are parsed deterministically', () => {
  assert.equal(parseReleaseTag('v1.0.6'), '1.0.6');
  assert.equal(parseReleaseTag('1.0.6'), '1.0.6');
  assert.equal(parseReleaseTag('release-1.0.6'), null);
  assert.equal(expectedAssetName('installed'), 'Arc-Power_Installer.exe');
  assert.equal(expectedAssetName('portable'), 'Arc-Power_Portable.exe');
  assert.equal(expectedAssetName('dev'), 'Arc-Power_Installer.exe');
  assert.deepEqual(selectReleaseAsset(release, 'installed'), {
    assetName: 'Arc-Power_Installer.exe',
    assetUrl: release.assets[0].browser_download_url,
  });
  assert.deepEqual(selectReleaseAsset(release, 'portable'), {
    assetName: 'Arc-Power_Portable.exe',
    assetUrl: release.assets[1].browser_download_url,
  });
});

test('release asset validation rejects non-GitHub, non-HTTPS, wrong-repository, and wrong-name URLs', () => {
  const valid = release.assets[1].browser_download_url;
  assert.equal(validateReleaseAssetUrl(valid, 'Arc-Power_Portable.exe'), valid);
  assert.equal(validateReleaseAssetUrl('http://github.com/YamsSE/Arc-Power/releases/download/v1.0.6/Arc-Power_Portable.exe'), null);
  assert.equal(validateReleaseAssetUrl('https://example.com/Arc-Power_Portable.exe'), null);
  assert.equal(validateReleaseAssetUrl('https://github.com/other/project/releases/download/v1.0.6/Arc-Power_Portable.exe'), null);
  assert.equal(validateReleaseAssetUrl(valid, 'Arc-Power_Installer.exe'), null);
});

test('downloaded update paths stay inside the update temp folder and match the selected build', () => {
  const root = join(tmpdir(), 'arc-power-updates');
  const portable = join(root, 'Arc-Power_Portable.exe');
  const installer = join(root, 'Arc-Power_Installer.exe');
  assert.equal(validateDownloadedUpdatePath(portable, { buildKind: 'portable', tempDir: root }), portable);
  assert.equal(validateDownloadedUpdatePath(installer, { buildKind: 'installed', tempDir: root }), installer);
  assert.equal(validateDownloadedUpdatePath(installer, { buildKind: 'portable', tempDir: root }), null);
  assert.equal(validateDownloadedUpdatePath(join(root, 'nested', '..', 'Arc-Power_Portable.exe'), { buildKind: 'portable', tempDir: root }), portable);
  assert.equal(validateDownloadedUpdatePath(join(root, '..', 'Arc-Power_Portable.exe'), { buildKind: 'portable', tempDir: root }), null);
});

test('portable handoff validates the target and supports cross-volume replacement before relaunching', () => {
  const downloaded = join(tmpdir(), 'arc-power-updates', 'Arc-Power_Portable.exe');
  const target = join(tmpdir(), 'Arc Power', 'Arc-Power_Portable.exe');
  assert.equal(validatePortableTargetPath(target, downloaded), target);
  assert.equal(validatePortableTargetPath(downloaded, downloaded), null);
  assert.equal(validatePortableTargetPath('Arc-Power_Portable.exe', downloaded), null);

  const script = createPortableHandoffScript();
  assert.match(script, /Get-Process -Id \$ParentPid/);
  assert.match(script, /Copy-Item -LiteralPath \$DownloadedPath -Destination \$stagedPath -Force/);
  assert.match(script, /\[System\.IO\.File\]::Replace\(\$stagedPath, \$TargetPath/);
  assert.match(script, /Move-Item -LiteralPath \$stagedPath -Destination \$TargetPath -Force/);
  assert.match(script, /Test-Path -LiteralPath \$TargetPath -PathType Leaf/);
  assert.match(script, /Remove-Item -LiteralPath \$DownloadedPath -Force/);
  assert.match(script, /Start-Process -FilePath \$TargetPath/);
  assert.ok(script.indexOf('Copy-Item') < script.indexOf('Start-Process'));
  assert.ok(script.indexOf('Remove-Item -LiteralPath \$stagedPath') < script.indexOf('Start-Process'));
});

test('portable handoff script is self-contained after the parent exits', () => {
  const script = createPortableHandoffScript();
  assert.match(script, /while \(Get-Process -Id \$ParentPid -ErrorAction SilentlyContinue\)/);
  assert.match(script, /Start-Sleep -Milliseconds 250/);
  assert.match(script, /if \(-not \$moved\) \{[\s\S]*?exit 1[\s\S]*?\}/);
});
