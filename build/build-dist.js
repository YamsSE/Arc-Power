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
const tempConfig = path.join(dist, 'build-dist-config.json');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const baseBuild = packageJson.build;

mkdirSync(dist, { recursive: true });

function writeBuildConfig(artifactName) {
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
      target: ['portable'],
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
  path.join(dist, 'Arc-Power_Installer.exe.blockmap'),
  path.join(dist, 'latest.yml'),
  path.join(dist, 'arc-power-1.0.5-x64.nsis.7z'),
]) rmSync(artifact, { force: true });
function buildPortableArtifact(artifactName) {
  writeBuildConfig(artifactName);
  try {
    const result = spawnSync(process.execPath, [builderCli, '--win', 'portable', '--config', tempConfig], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  } finally {
    rmSync(tempConfig, { force: true });
  }
  const artifactPath = path.join(dist, artifactName);
  if (!existsSync(artifactPath)) throw new Error(`electron-builder did not produce ${artifactPath}`);
}

buildPortableArtifact(path.basename(installer));
buildPortableArtifact(path.basename(portable));
console.log(`Created ${path.basename(installer)} and ${path.basename(portable)} with independent portable builds`);
