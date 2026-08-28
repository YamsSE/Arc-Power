// Electron-free updater decisions and validation.

import { basename, extname, relative, resolve, isAbsolute } from 'node:path';

const RELEASE_REPO_PREFIX = '/YamsSE/Arc-Power/releases/download/';
const ASSET_NAMES = Object.freeze({
  installed: 'Arc-Power_Installer.exe',
  portable: 'Arc-Power_Portable.exe',
});

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

export function parseReleaseTag(tag) {
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(String(tag ?? ''));
  return match ? match[1] : null;
}

export function expectedAssetName(buildKind) {
  if (buildKind === 'portable') return ASSET_NAMES.portable;
  if (buildKind === 'installed') return ASSET_NAMES.installed;
  return null;
}

/** Return a normalized URL only for the Arc Power GitHub release path. */
export function validateReleaseAssetUrl(value, expectedName = null) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') return null;
  if (!parsed.pathname.startsWith(RELEASE_REPO_PREFIX)) return null;
  const name = basename(parsed.pathname);
  if (!/\.exe$/i.test(name)) return null;
  if (expectedName && name.toLowerCase() !== expectedName.toLowerCase()) return null;
  return parsed.toString();
}

export function selectReleaseAsset(release, buildKind) {
  const expectedName = expectedAssetName(buildKind);
  if (!expectedName) return null;
  const asset = (Array.isArray(release?.assets) ? release.assets : []).find((candidate) => (
    typeof candidate?.name === 'string'
      && candidate.name.toLowerCase() === expectedName.toLowerCase()
      && validateReleaseAssetUrl(candidate.browser_download_url, expectedName)
  ));
  if (!asset) return null;
  return {
    assetName: expectedName,
    assetUrl: validateReleaseAssetUrl(asset.browser_download_url, expectedName),
  };
}

/** Validate that an update file is the expected asset inside our temp folder. */
export function validateDownloadedUpdatePath(filePath, { buildKind, tempDir }) {
  if (typeof filePath !== 'string' || typeof tempDir !== 'string') return null;
  const expectedName = expectedAssetName(buildKind);
  if (!expectedName) return null;
  const candidate = resolve(filePath);
  const root = resolve(tempDir);
  const child = relative(root, candidate);
  if (!child || child.startsWith('..') || isAbsolute(child)) return null;
  if (basename(candidate).toLowerCase() !== expectedName.toLowerCase()) return null;
  if (extname(candidate).toLowerCase() !== '.exe') return null;
  return candidate;
}

export function validatePortableTargetPath(targetPath, downloadedPath) {
  if (typeof targetPath !== 'string' || typeof downloadedPath !== 'string') return null;
  const target = resolve(targetPath);
  const downloaded = resolve(downloadedPath);
  if (target === downloaded || extname(target).toLowerCase() !== '.exe') return null;
  if (!isAbsolute(targetPath)) return null;
  return target;
}

/** Resolve the same validated wrapper target used for portable classification. */
export function resolvePortableUpdateTarget({ portableWrapperPath = null, downloadedPath } = {}) {
  return validatePortableTargetPath(portableWrapperPath, downloadedPath);
}

export function installedUpdateArguments({ parentPid, installDir } = {}) {
  if (!Number.isInteger(parentPid) || parentPid < 1) throw new TypeError('parent PID must be a positive integer');
  if (typeof installDir !== 'string' || !isAbsolute(installDir)) throw new TypeError('install directory must be absolute');
  return ['--update', '--update-parent-pid', String(parentPid), '--update-install-dir', resolve(installDir)];
}

/**
 * PowerShell handoff used by portable builds. It waits for this app to exit,
 * stages the downloaded executable beside the target (so the initial copy can
 * cross volumes), replaces the original on its own volume, verifies the
 * replacement, and relaunches that same path. A failed replacement never
 * starts a second copy.
 */
export function createPortableHandoffScript() {
  return `param(
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$DownloadedPath,
  [Parameter(Mandatory = $true)][string]$TargetPath,
  [Parameter(Mandatory = $true)][string]$DiagnosticPath
)

$ErrorActionPreference = 'Stop'
function Write-Diagnostic([string]$message) {
  try { Add-Content -LiteralPath $DiagnosticPath -Value ("{0:u} {1}" -f [DateTime]::UtcNow, $message) -Encoding UTF8 } catch {}
}
while (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
  Start-Sleep -Milliseconds 250
}

$moved = $false
$stagedPath = "$TargetPath.arc-power-update-$ParentPid.tmp"
for ($attempt = 0; $attempt -lt 20 -and -not $moved; $attempt++) {
  try {
    Remove-Item -LiteralPath $stagedPath -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $DownloadedPath -Destination $stagedPath -Force
    $sourceLength = (Get-Item -LiteralPath $DownloadedPath).Length
    $stagedLength = (Get-Item -LiteralPath $stagedPath).Length
    if ($sourceLength -le 0 -or $stagedLength -ne $sourceLength) { throw 'staged update length mismatch' }

    if (Test-Path -LiteralPath $TargetPath -PathType Leaf) {
      try {
        [System.IO.File]::Replace($stagedPath, $TargetPath, $null, $true)
      } catch {
        Move-Item -LiteralPath $stagedPath -Destination $TargetPath -Force
      }
    } else {
      Move-Item -LiteralPath $stagedPath -Destination $TargetPath -Force
    }
    $moved = (Test-Path -LiteralPath $TargetPath -PathType Leaf) -and ((Get-Item -LiteralPath $TargetPath).Length -eq $sourceLength)
  } catch {
    Write-Diagnostic ("replacement attempt {0} failed: {1}" -f $attempt, $_.Exception.Message)
    Remove-Item -LiteralPath $stagedPath -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 250
  }
}

if (-not $moved) {
  Write-Diagnostic 'portable update replacement failed; the original executable was not relaunched'
  Remove-Item -LiteralPath $stagedPath -Force -ErrorAction SilentlyContinue
  exit 1
}
Remove-Item -LiteralPath $DownloadedPath -Force -ErrorAction SilentlyContinue
try {
  $relaunch = Start-Process -FilePath $TargetPath -PassThru -ErrorAction Stop
  if (-not $relaunch -or $relaunch.HasExited) { throw 'portable update relaunch did not start' }
} catch {
  Write-Diagnostic ("portable update relaunch failed: {0}" -f $_.Exception.Message)
  exit 1
}
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
`;
}

export { ASSET_NAMES };
