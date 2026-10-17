import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import koffi from 'koffi';

const execFileAsync = promisify(execFile);

export function querySystemWindowsDirectory({ platform = process.platform, load = koffi.load } = {}) {
  if (platform !== 'win32') throw new Error('System Windows directory lookup is available only on Windows.');
  const kernel32 = load('kernel32.dll');
  const getSystemWindowsDirectory = kernel32.func('GetSystemWindowsDirectoryW', 'uint32', ['void*', 'uint32']);
  const capacity = 32768;
  const buffer = Buffer.alloc(capacity * 2);
  const length = Number(getSystemWindowsDirectory(buffer, capacity));
  if (!Number.isInteger(length) || length < 1 || length >= capacity) {
    throw new Error('Windows could not resolve its shared system directory.');
  }
  return buffer.toString('utf16le', 0, length * 2);
}

function validateWindowsDirectory(windowsDirectory) {
  const normalizedWindowsDirectory = path.win32.normalize(windowsDirectory);
  if (!path.win32.isAbsolute(normalizedWindowsDirectory)
    || path.win32.parse(normalizedWindowsDirectory).root.startsWith('\\\\')
    || normalizedWindowsDirectory !== windowsDirectory
    || /[\r\n\0]/.test(windowsDirectory)) {
    throw new Error('Windows returned an invalid system directory for protected runtime setup.');
  }
  const powershellPath = path.win32.join(normalizedWindowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const expectedPowerShellPath = path.win32.resolve(normalizedWindowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (powershellPath.toLowerCase() !== expectedPowerShellPath.toLowerCase()) {
    throw new Error('Windows returned an invalid PowerShell executable path for protected runtime setup.');
  }
  return powershellPath;
}

async function createProtectedDirectory(execFileAsyncImpl, powershellPath) {
  const id = randomUUID();
  const script = `
$ErrorActionPreference = 'Stop'
$suffix = '${id}'
$base = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
if ([string]::IsNullOrWhiteSpace($base)) { throw 'CommonApplicationData is unavailable.' }
$directory = [IO.Path]::Combine($base, 'ArcPower-ScreenSharpen-' + $suffix)
if ([IO.Directory]::Exists($directory) -or [IO.File]::Exists($directory)) { throw 'The protected runtime directory already exists.' }
$admins = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($admins)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($admins, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($system, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
[IO.Directory]::CreateDirectory($directory, $acl) | Out-Null
$actual = Get-Acl -LiteralPath $directory
if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $admins.Value) { throw 'The protected runtime owner or ACL could not be verified.' }
$rules = $actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
if ($rules.Count -ne 2) { throw 'The protected runtime ACL contains unexpected entries.' }
foreach ($rule in $rules) {
  if ($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $rule.InheritanceFlags -ne $inherit -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or $rule.IdentityReference.Value -notin @($admins.Value, $system.Value)) { throw 'The protected runtime ACL is not restricted to Administrators and SYSTEM.' }
}
Write-Output $base
Write-Output $directory
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execFileAsyncImpl(powershellPath, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded,
  ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const lines = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const base = lines.at(-2);
  const directory = lines.at(-1);
  if (!base || !directory || !path.win32.isAbsolute(base) || !path.win32.isAbsolute(directory)
    || path.win32.dirname(directory).toLowerCase() !== path.win32.resolve(base).toLowerCase()
    || path.win32.basename(directory) !== `ArcPower-ScreenSharpen-${id}`) {
    throw new Error('Windows returned an unexpected protected runtime path.');
  }
  return directory;
}

/** Copy the pinned helper to an elevated-only directory before launching it. */
export async function stageScreenSharpeningHelper(sourcePath, expectedSha256, {
  platform = process.platform,
  fsApi = fs,
  execFileAsyncImpl = execFileAsync,
  getWindowsDirectory = querySystemWindowsDirectory,
} = {}) {
  if (platform !== 'win32') throw new Error('Protected screen sharpening helper staging is available only on Windows.');
  const source = fsApi.readFileSync(sourcePath);
  const sourceHash = createHash('sha256').update(source).digest('hex').toUpperCase();
  if (sourceHash !== String(expectedSha256).toUpperCase()) throw new Error('The bundled screen sharpening helper failed its integrity check.');

  const windowsDirectory = getWindowsDirectory({ platform });
  const powershellPath = validateWindowsDirectory(windowsDirectory);
  const directory = await createProtectedDirectory(execFileAsyncImpl, powershellPath);
  const stagedPath = path.win32.join(directory, 'ArcPower.ScreenSharpen.exe');
  try {
    fsApi.writeFileSync(stagedPath, source, { flag: 'wx' });
    const stat = fsApi.lstatSync(stagedPath);
    const stagedHash = createHash('sha256').update(fsApi.readFileSync(stagedPath)).digest('hex').toUpperCase();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stagedHash !== sourceHash) {
      throw new Error('The protected screen sharpening helper failed its post-copy integrity check.');
    }
  } catch (error) {
    try { fsApi.rmSync(directory, { recursive: true, force: true }); } catch { /* leave a recoverable protected directory */ }
    throw error;
  }

  return {
    path: stagedPath,
    cleanup() {
      try { fsApi.rmSync(directory, { recursive: true, force: true }); } catch { /* process exit may leave a protected temporary directory */ }
    },
  };
}
