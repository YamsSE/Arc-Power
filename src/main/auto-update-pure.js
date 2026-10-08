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
    assetSize: Number.isSafeInteger(asset.size) && asset.size > 0 ? asset.size : null,
    assetDigest: typeof asset.digest === 'string' ? asset.digest : null,
  };
}

export function parseSha256Digest(value) {
  if (typeof value !== 'string') return null;
  const match = /^sha256:([a-f0-9]{64})$/i.exec(value.trim());
  return match ? match[1].toLowerCase() : null;
}

/** Keep update paths and digest receipts private to the main process. */
export function createUpdateReceiptRegistry({ createToken } = {}) {
  if (typeof createToken !== 'function') throw new TypeError('update receipt token generator is required');
  const receipts = new Map();
  const installing = new Set();
  return {
    issue(receipt) {
      const token = createToken();
      receipts.set(token, receipt);
      return token;
    },
    async install(token, buildKind, performInstall) {
      if (typeof token !== 'string' || !/^[a-f0-9-]{36}$/i.test(token)) throw new Error('Invalid update receipt');
      const receipt = receipts.get(token);
      if (!receipt || receipt.buildKind !== buildKind) throw new Error('Update receipt is unavailable; download the update again');
      if (installing.has(token)) throw new Error('This update is already being installed');
      if (typeof performInstall !== 'function') throw new TypeError('update install operation is required');
      installing.add(token);
      try {
        const result = await performInstall(receipt);
        receipts.delete(token);
        return result;
      } finally {
        // A failed handoff can be retried with the same verified receipt.
        installing.delete(token);
      }
    },
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
  [Parameter(Mandatory = $true)][string]$ExpectedSha256,
  [Parameter(Mandatory = $true)][string]$TargetPath,
  [Parameter(Mandatory = $true)][string]$DiagnosticPath,
  [Parameter(Mandatory = $true)][string]$ResultPath
)

$ErrorActionPreference = 'Stop'
function Write-Diagnostic([string]$message) {
  try { Add-Content -LiteralPath $DiagnosticPath -Value ("{0:u} {1}" -f [DateTime]::UtcNow, $message) -Encoding UTF8 } catch {}
}
function Write-Result([string]$state, [string]$message) {
  try {
    $temporary = "$ResultPath.tmp"
    @{ state = $state; message = $message; completedUtc = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $ResultPath -Force
  } catch { Write-Diagnostic ("could not write durable handoff result: {0}" -f $_.Exception.Message) }
}
while (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
  Start-Sleep -Milliseconds 250
}

$moved = $false
$stagedPath = "$TargetPath.arc-power-update-$ParentPid.tmp"
$backupPath = "$TargetPath.arc-power-backup-$ParentPid.tmp"
for ($attempt = 0; $attempt -lt 20 -and -not $moved; $attempt++) {
  try {
    if ((Test-Path -LiteralPath $backupPath -PathType Leaf) -and -not (Test-Path -LiteralPath $TargetPath -PathType Leaf)) {
      Move-Item -LiteralPath $backupPath -Destination $TargetPath -Force
    }
    Remove-Item -LiteralPath $stagedPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
    if ($ExpectedSha256 -notmatch '^[A-Fa-f0-9]{64}$') { throw 'trusted update SHA-256 digest is invalid' }
    $sourceHash = (Get-FileHash -LiteralPath $DownloadedPath -Algorithm SHA256).Hash
    if ($sourceHash -ne $ExpectedSha256.ToUpperInvariant()) { throw 'downloaded update SHA-256 does not match the trusted release digest' }
    $sourceLength = (Get-Item -LiteralPath $DownloadedPath).Length
    Copy-Item -LiteralPath $DownloadedPath -Destination $stagedPath -Force
    $stagedLength = (Get-Item -LiteralPath $stagedPath).Length
    $stagedHash = (Get-FileHash -LiteralPath $stagedPath -Algorithm SHA256).Hash
    if ($sourceLength -le 0 -or $stagedLength -ne $sourceLength -or $stagedHash -ne $ExpectedSha256.ToUpperInvariant()) { throw 'staged update does not match the trusted release digest' }

    if (Test-Path -LiteralPath $TargetPath -PathType Leaf) {
      try {
        [System.IO.File]::Replace($stagedPath, $TargetPath, $backupPath, $true)
      } catch {
        $currentHash = if (Test-Path -LiteralPath $TargetPath -PathType Leaf) { (Get-FileHash -LiteralPath $TargetPath -Algorithm SHA256).Hash } else { '' }
        if ((Test-Path -LiteralPath $backupPath -PathType Leaf) -and ($currentHash -eq $sourceHash)) {
          # File.Replace completed but surfaced a late error; the verified
          # replacement is already in place and the backup can be discarded.
          $moved = $true
        } else {
          if (Test-Path -LiteralPath $TargetPath -PathType Leaf) {
            Move-Item -LiteralPath $TargetPath -Destination $backupPath -Force
          }
          try {
            Move-Item -LiteralPath $stagedPath -Destination $TargetPath -Force
          } catch {
            if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
              Move-Item -LiteralPath $backupPath -Destination $TargetPath -Force
            }
            throw
          }
        }
      }
    } else {
      Move-Item -LiteralPath $stagedPath -Destination $TargetPath -Force
    }
    $targetHash = if (Test-Path -LiteralPath $TargetPath -PathType Leaf) { (Get-FileHash -LiteralPath $TargetPath -Algorithm SHA256).Hash } else { '' }
    $moved = (Test-Path -LiteralPath $TargetPath -PathType Leaf) -and ((Get-Item -LiteralPath $TargetPath).Length -eq $sourceLength) -and ($targetHash -eq $sourceHash)
    if (-not $moved) {
      if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
        Remove-Item -LiteralPath $TargetPath -Force -ErrorAction SilentlyContinue
        Move-Item -LiteralPath $backupPath -Destination $TargetPath -Force
      }
      throw 'replacement hash verification failed'
    }
  } catch {
    Write-Diagnostic ("replacement attempt {0} failed: {1}" -f $attempt, $_.Exception.Message)
    Remove-Item -LiteralPath $stagedPath -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
      Remove-Item -LiteralPath $TargetPath -Force -ErrorAction SilentlyContinue
      try { Move-Item -LiteralPath $backupPath -Destination $TargetPath -Force -ErrorAction Stop } catch {
        Write-Diagnostic ("could not restore the prior wrapper: {0}" -f $_.Exception.Message)
      }
    }
    Start-Sleep -Milliseconds 250
  }
}

if (-not $moved) {
  Write-Diagnostic 'portable update replacement failed; attempting to restore and relaunch the existing executable'
  if ((Test-Path -LiteralPath $backupPath -PathType Leaf) -and -not (Test-Path -LiteralPath $TargetPath -PathType Leaf)) {
    Move-Item -LiteralPath $backupPath -Destination $TargetPath -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $stagedPath -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $TargetPath -PathType Leaf) {
    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
  } elseif (Test-Path -LiteralPath $backupPath -PathType Leaf) {
    Write-Diagnostic ("prior wrapper backup was preserved at {0}" -f $backupPath)
  }
  if (Test-Path -LiteralPath $TargetPath -PathType Leaf) {
    try { Start-Process -FilePath $TargetPath -ErrorAction Stop | Out-Null } catch {
      Write-Diagnostic ("could not relaunch the existing executable: {0}" -f $_.Exception.Message)
    }
  }
  Write-Result 'failed' 'Portable replacement failed; the previous executable was relaunched when possible.'
  try {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
      "Arc Power could not complete the update. The existing version was relaunched when possible. Details: $DiagnosticPath",
      'Arc Power update failed', 'OK', 'Warning'
    ) | Out-Null
  } catch { Write-Diagnostic 'could not display the update failure dialog' }
  exit 1
}
try {
  $relaunch = Start-Process -FilePath $TargetPath -PassThru -ErrorAction Stop
  if (-not $relaunch) { throw 'portable update relaunch did not start' }
  Start-Sleep -Seconds 8
  $relaunch.Refresh()
  if ($relaunch.HasExited) { throw 'updated Arc Power exited during startup' }
  Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $DownloadedPath -Force -ErrorAction SilentlyContinue
  Write-Result 'succeeded' 'Updated Arc Power remained running after restart.'
} catch {
  Write-Diagnostic ("portable update relaunch failed: {0}" -f $_.Exception.Message)
  if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
    try {
      Remove-Item -LiteralPath $TargetPath -Force -ErrorAction SilentlyContinue
      Move-Item -LiteralPath $backupPath -Destination $TargetPath -Force
      Start-Process -FilePath $TargetPath -ErrorAction Stop | Out-Null
      Write-Diagnostic 'restored and relaunched the previous executable'
    } catch { Write-Diagnostic ("could not restore and relaunch previous executable: {0}" -f $_.Exception.Message) }
  }
  Write-Result 'failed' 'Updated Arc Power failed to start; the previous executable was restored when possible.'
  try {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
      "Arc Power was updated but could not be started automatically. Start this file manually: $TargetPath. Details: $DiagnosticPath",
      'Arc Power update could not relaunch', 'OK', 'Warning'
    ) | Out-Null
  } catch { Write-Diagnostic 'could not display the relaunch failure dialog' }
  exit 1
}
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
`;
}

export { ASSET_NAMES };
