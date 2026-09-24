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
const unpacked = path.join(dist, 'win-unpacked');
const tempConfig = path.join(dist, 'build-dist-config.json');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const baseBuild = packageJson.build;
const formerNsisArchive = path.join(dist, `arc-power-${packageJson.version}-x64.nsis.7z`);

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
  formerNsisArchive,
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

function validateUnpackedExecutable() {
  const target = path.join(unpacked, 'Arc Power.exe');
  if (!existsSync(target)) throw new Error(`missing packaged executable: ${target}`);
  validateWindowsExecutable(target);
}

function validateWindowsExecutable(target) {
  const image = readFileSync(target);
  const text = image.toString('utf8');
  // Check the actual Windows manifest entry, rather than merely accepting
  // the two words anywhere in the PE. This covers both the unpacked app and
  // the portable NSIS wrapper, whose wrapper manifest is the one Windows
  // evaluates before extraction and launch.
  if (!/<requestedExecutionLevel\b[^>]*\blevel="requireAdministrator"/i.test(text)) {
    throw new Error(`packaged executable is not administrator-elevated: ${target}`);
  }
  // Electron Builder must provide a five-image RT_GROUP_ICON resource.
  // This catches a generic Electron/document resource before it reaches the
  // release folder while remaining independent of Windows' icon cache.
  const groupIconHeader = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x05, 0x00]);
  if (image.indexOf(groupIconHeader) < 0) {
    throw new Error(`packaged executable has no branded five-size icon resource: ${target}`);
  }
}

function validatePortableArtifact(artifactPath) {
  if (!existsSync(artifactPath)) throw new Error(`electron-builder did not produce ${artifactPath}`);
  validateWindowsExecutable(artifactPath);
}

function buildUnpackedApp() {
  writeBuildConfig(path.basename(portable), 'dir');
  try {
    runBuilder('dir');
  } finally {
    rmSync(tempConfig, { force: true });
  }
  validateUnpackedExecutable();
}

function buildPortableArtifact(artifactName) {
  writeBuildConfig(artifactName);
  try {
    // Build the wrapper from the already-branded unpacked directory. A
    // Portable wrapper embeds its own copy of the application. The generated
    // configuration supplies the application icon and administrator
    // manifest, so validate those resources directly after packaging.
    runBuilder('portable', ['--prepackaged', unpacked]);
  } finally {
    rmSync(tempConfig, { force: true });
  }
  const artifactPath = path.join(dist, artifactName);
  validatePortableArtifact(artifactPath);
}

buildUnpackedApp();
buildPortableArtifact(path.basename(installer));
buildPortableArtifact(path.basename(portable));
console.log(`Created ${path.basename(installer)} and ${path.basename(portable)} with independent portable builds`);
