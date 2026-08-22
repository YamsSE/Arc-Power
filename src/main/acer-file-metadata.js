// Arc Power - Windows file metadata/ACL seams for the Acer bridge.
//
// The bridge replaces two user-owned files temporarily. Byte restoration alone
// is insufficient on Windows: ACLs and file attributes must survive the swap.
// Keep the PowerShell scripts fixed and pass paths/SDDL only through the
// environment; callers never interpolate a user path into a command string.

import { spawn } from 'node:child_process';

const POWERSHELL = process.env.ComSpec
  ? 'powershell.exe'
  : 'powershell.exe';
const CAPTURE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$item = Get-Item -LiteralPath $env:ARC_POWER_METADATA_PATH -Force',
  '$acl = Get-Acl -LiteralPath $env:ARC_POWER_METADATA_PATH',
  '[pscustomobject]@{ ok = $true; sddl = [string]$acl.Sddl; attributes = [int]$item.Attributes; creationFileTime = [string]$item.CreationTimeUtc.ToFileTimeUtc() } | ConvertTo-Json -Compress',
].join('; ');
const RESTORE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$acl = Get-Acl -LiteralPath $env:ARC_POWER_METADATA_PATH',
  '$acl.SetSecurityDescriptorSddlForm($env:ARC_POWER_METADATA_SDDL)',
  'Set-Acl -LiteralPath $env:ARC_POWER_METADATA_PATH -AclObject $acl',
  '$item = Get-Item -LiteralPath $env:ARC_POWER_METADATA_PATH -Force',
  '$item.Attributes = [System.IO.FileAttributes]([int]$env:ARC_POWER_METADATA_ATTRIBUTES)',
  '$item.CreationTimeUtc = [DateTime]::FromFileTimeUtc([int64]$env:ARC_POWER_METADATA_CREATION_FILETIME)',
  '[pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress',
].join('; ');
const VERIFY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$item = Get-Item -LiteralPath $env:ARC_POWER_METADATA_PATH -Force',
  '$acl = Get-Acl -LiteralPath $env:ARC_POWER_METADATA_PATH',
  '$sameSddl = ([string]$acl.Sddl) -ceq $env:ARC_POWER_METADATA_SDDL',
  '$sameAttributes = ([int]$item.Attributes) -eq [int]$env:ARC_POWER_METADATA_ATTRIBUTES',
  '$sameCreation = ([string]$item.CreationTimeUtc.ToFileTimeUtc()) -ceq $env:ARC_POWER_METADATA_CREATION_FILETIME',
  '[pscustomobject]@{ ok = ($sameSddl -and $sameAttributes -and $sameCreation); sameSddl = $sameSddl; sameAttributes = $sameAttributes; sameCreation = $sameCreation } | ConvertTo-Json -Compress',
].join('; ');

function runPowerShell(script, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(reject, new Error('PowerShell metadata operation timed out'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish(reject, error));
    child.once('exit', (code) => {
      if (code !== 0) {
        finish(reject, new Error(stderr.trim() || `PowerShell metadata operation exited ${code}`));
        return;
      }
      try { finish(resolve, JSON.parse(stdout.trim())); }
      catch { finish(reject, new Error('PowerShell metadata operation returned invalid JSON')); }
    });
  });
}

function unavailable(message) {
  return { ok: false, errorCode: 'metadata-unavailable', message };
}

export function createAcerFileMetadataOps({ platform = process.platform, timeoutMs = 10000, run = runPowerShell } = {}) {
  const available = platform === 'win32' && typeof run === 'function';
  const capture = async (filePath) => {
    if (!available || typeof filePath !== 'string' || filePath.length === 0) return unavailable('Windows ACL metadata is unavailable');
    try {
      const value = await run(CAPTURE_SCRIPT, { ARC_POWER_METADATA_PATH: filePath }, timeoutMs);
      if (value?.ok !== true || typeof value.sddl !== 'string' || !Number.isInteger(value.attributes)
        || typeof value.creationFileTime !== 'string' || !/^\d+$/.test(value.creationFileTime)) return unavailable('Windows ACL metadata proof is incomplete');
      return { ok: true, sddl: value.sddl, attributes: value.attributes, creationFileTime: value.creationFileTime };
    } catch (error) { return unavailable(error instanceof Error ? error.message : String(error)); }
  };
  const restore = async (filePath, metadata) => {
    if (!available || typeof filePath !== 'string' || typeof metadata?.sddl !== 'string'
      || !Number.isInteger(metadata.attributes) || typeof metadata.creationFileTime !== 'string'
      || !/^\d+$/.test(metadata.creationFileTime)) return unavailable('Windows ACL metadata is unavailable');
    try {
      const value = await run(RESTORE_SCRIPT, {
        ARC_POWER_METADATA_PATH: filePath,
        ARC_POWER_METADATA_SDDL: metadata.sddl,
        ARC_POWER_METADATA_ATTRIBUTES: String(metadata.attributes),
        ARC_POWER_METADATA_CREATION_FILETIME: metadata.creationFileTime,
      }, timeoutMs);
      return value?.ok === true ? { ok: true } : unavailable('Windows ACL metadata restore was not acknowledged');
    } catch (error) { return unavailable(error instanceof Error ? error.message : String(error)); }
  };
  const verify = async (filePath, metadata) => {
    if (!available || typeof filePath !== 'string' || typeof metadata?.sddl !== 'string'
      || !Number.isInteger(metadata.attributes) || typeof metadata.creationFileTime !== 'string'
      || !/^\d+$/.test(metadata.creationFileTime)) return false;
    try {
      const value = await run(VERIFY_SCRIPT, {
        ARC_POWER_METADATA_PATH: filePath,
        ARC_POWER_METADATA_SDDL: metadata.sddl,
        ARC_POWER_METADATA_ATTRIBUTES: String(metadata.attributes),
        ARC_POWER_METADATA_CREATION_FILETIME: metadata.creationFileTime,
      }, timeoutMs);
      return value?.ok === true && value.sameSddl === true && value.sameAttributes === true && value.sameCreation === true;
    } catch { return false; }
  };
  return { capture, restore, verify };
}

export const ACER_FILE_METADATA_SCRIPTS = Object.freeze({ CAPTURE_SCRIPT, RESTORE_SCRIPT, VERIFY_SCRIPT });
