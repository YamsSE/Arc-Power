// Build the normal portable app plus the self-contained custom installer.
// Each artifact gets its own electron-builder portable wrapper. The runtime
// selects installer mode from the wrapper filename via the portable marker or
// its Windows parent-process fallback.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const installer = path.join(dist, 'Arc-Power_Installer.exe');
const portable = path.join(dist, 'Arc-Power_Portable.exe');
const builderCli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const rceditCli = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
const iconPath = path.join(root, 'build', 'icon.ico');
const unpacked = path.join(dist, 'win-unpacked');
const tempConfig = path.join(dist, 'build-dist-config.json');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const baseBuild = packageJson.build;

mkdirSync(dist, { recursive: true });

function writeBuildConfig(artifactName, target = 'portable') {
  // Passing only a small override config makes electron-builder fall back to
  // its default "include the project" file set. That accidentally packages
  // the repository and can produce multi-gigabyte app.asar files. Keep the
  // complete application file contract in both generated configurations.
  writeFileSync(tempConfig, JSON.stringify({
    appId: baseBuild.appId,
    productName: baseBuild.productName,
    icon: path.join(root, baseBuild.icon),
    files: baseBuild.files,
    asarUnpack: baseBuild.asarUnpack,
    extraResources: baseBuild.extraResources,
    win: {
      ...baseBuild.win,
      target: [target],
      // Both distributed artifacts require administrator approval at launch;
      // this keeps hardware-control and bundled-runtime paths consistent.
      requestedExecutionLevel: 'requireAdministrator',
    },
    portable: {
      ...baseBuild.portable,
      artifactName,
      requestExecutionLevel: 'admin',
    },
    directories: {
      ...baseBuild.directories,
      output: dist,
    },
  }, null, 2));
}

// Remove artifacts from the former NSIS pipeline as well. Leaving a stale
// blockmap/latest.yml beside the new EXEs makes the distribution look like it
// still contains the old installer even though it is no longer built.
for (const artifact of [
  installer,
  portable,
  tempConfig,
  unpacked,
  path.join(dist, 'Arc-Power_Installer.exe.blockmap'),
  path.join(dist, 'latest.yml'),
  path.join(dist, 'arc-power-1.1.0-x64.nsis.7z'),
]) rmSync(artifact, { force: true, recursive: artifact === unpacked });

function runBuilder(target, extraArgs = []) {
  const result = spawnSync(process.execPath, [builderCli, '--win', target, ...extraArgs, '--config', tempConfig], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function patchUnpackedExecutable() {
  const target = path.join(unpacked, 'Arc Power.exe');
  if (!existsSync(target)) throw new Error(`missing packaged executable for icon patch: ${target}`);
  const result = spawnSync(rceditCli, [target, '--set-icon', iconPath], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`rcedit failed for ${target} with exit code ${result.status}`);
}

function peImageEnd(buffer) {
  if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) {
    throw new Error('portable wrapper does not start with a DOS header');
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset < 0x40 || peOffset + 24 > buffer.length || buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('portable wrapper does not contain a valid PE header');
  }
  const sectionCount = buffer.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = buffer.readUInt16LE(peOffset + 20);
  const sectionsStart = peOffset + 24 + optionalHeaderSize;
  if (sectionsStart + sectionCount * 40 > buffer.length) throw new Error('portable wrapper section table is truncated');
  let end = sectionsStart + sectionCount * 40;
  for (let index = 0; index < sectionCount; index += 1) {
    const section = sectionsStart + index * 40;
    const rawSize = buffer.readUInt32LE(section + 16);
    const rawPointer = buffer.readUInt32LE(section + 20);
    end = Math.max(end, rawPointer + rawSize);
  }
  return end;
}

function patchPortableWrapperIcon(artifactPath) {
  // A portable EXE is an NSIS wrapper: its PE stub is followed by an
  // integrity-sensitive installer payload. rcedit must receive only the PE
  // stub; editing the complete wrapper destroys the NSIS payload and leaves
  // Windows with a broken or generic shell entry.
  const original = readFileSync(artifactPath);
  const imageEnd = peImageEnd(original);
  if (imageEnd <= 0 || imageEnd >= original.length) throw new Error(`portable wrapper has no NSIS payload: ${artifactPath}`);
  const stubPath = `${artifactPath}.icon-stub.tmp`;
  try {
    writeFileSync(stubPath, original.subarray(0, imageEnd));
    const result = spawnSync(rceditCli, [stubPath, '--set-icon', iconPath], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`rcedit failed for portable stub ${artifactPath} with exit code ${result.status}`);
    const brandedStub = readFileSync(stubPath);
    if (brandedStub.length > imageEnd) throw new Error(`branded portable stub grew into the NSIS payload: ${artifactPath}`);
    writeFileSync(artifactPath, Buffer.concat([
      brandedStub,
      Buffer.alloc(imageEnd - brandedStub.length),
      original.subarray(imageEnd),
    ]));
  } finally {
    rmSync(stubPath, { force: true });
  }
}

function buildUnpackedApp() {
  writeBuildConfig(path.basename(portable), 'dir');
  try {
    runBuilder('dir');
  } finally {
    rmSync(tempConfig, { force: true });
  }
  patchUnpackedExecutable();
}

function buildPortableArtifact(artifactName) {
  writeBuildConfig(artifactName);
  try {
    // Build the wrapper from the already-branded unpacked directory. A
    // Portable wrapper embeds its own copy of the application; patching
    // win-unpacked after creating the wrapper leaves that embedded copy with
    // electron-builder's placeholder executable icon. The wrapper itself is
    // branded below through a PE-stub-only edit so its NSIS payload remains
    // intact.
    runBuilder('portable', ['--prepackaged', unpacked]);
  } finally {
    rmSync(tempConfig, { force: true });
  }
  const artifactPath = path.join(dist, artifactName);
  if (!existsSync(artifactPath)) throw new Error(`electron-builder did not produce ${artifactPath}`);
  patchPortableWrapperIcon(artifactPath);
}

buildUnpackedApp();
buildPortableArtifact(path.basename(installer));
buildPortableArtifact(path.basename(portable));
console.log(`Created ${path.basename(installer)} and ${path.basename(portable)} with independent portable builds`);
