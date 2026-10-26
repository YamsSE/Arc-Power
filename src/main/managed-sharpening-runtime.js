import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createManagedGameLauncher } from './managed-game-launcher.js';
import { createManagedSharpeningControl } from './managed-sharpening-control.js';
import { createManagedGameSharpening } from './managed-game-sharpening.js';
import { stageScreenSharpeningHelper } from './sharpening-helper-stage.js';
import { getElevationStatus } from './elevation.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const nativePath = (leaf) => path.join(ROOT, 'sharpening-runtime', leaf).replace(/app\.asar(?=[\\/]|$)/i, 'app.asar.unpacked');
export const MANAGED_SHARPENING_ARTIFACTS = Object.freeze({
  launcher: { path: nativePath('ArcPower.GameSharpening.exe'), hash: '25A04DDF86290EC69BC3BB9CFAD4C01098AA643DB079D339123A300F99BBEA0C' },
  control: { path: nativePath('ArcPower.ManagedSharpeningControl.exe'), hash: '3476CEAF4063D600EB16163049696C6B7C7A2BF1F9E6D9B49CDEBFF4DF37ED59' },
  runtime: { path: nativePath('ArcPower.ReShade64.dll'), hash: 'EFC04FE58F8544A3AB839FC759A2382A3259708FED7B1F59FC5A84C0C6AD5759' },
  shader: { path: path.join(ROOT, 'shaders', 'ArcPowerSharpen.fx').replace(/app\.asar(?=[\\/]|$)/i, 'app.asar.unpacked'), hash: '61DA69EBE33D9661AA6719676469221B2250B9064AF99389AA7DC5593E342426' },
});
function artifactsReady() {
  try {
    return Object.values(MANAGED_SHARPENING_ARTIFACTS).every((artifact) => {
      const stat = fs.lstatSync(artifact.path);
      return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
        && createHash('sha256').update(fs.readFileSync(artifact.path)).digest('hex').toUpperCase() === artifact.hash;
    });
  } catch { return false; }
}

export function createProductionManagedSharpening({ dir, detector, isGameExecutable, resolveLaunch, ...policy }) {
  const elevation = getElevationStatus();
  const ready = artifactsReady() && elevation.verified;
  const staged = [];
  let resources = null;
  let stopping = false;
  const prepare = () => {
    if (stopping) return Promise.reject(new Error('Managed sharpening is stopping'));
    if (!resources) resources = (async () => {
      if (!ready) throw new Error('The bundled sharpening runtime failed its integrity check');
      const artifacts = MANAGED_SHARPENING_ARTIFACTS;
      // Elevated Arc Power executes only protected copies. An already-normal
      // process needs no elevated relay staging and remains at normal integrity.
      const launchStage = elevation.elevated
        ? await stageScreenSharpeningHelper(artifacts.launcher.path, artifacts.launcher.hash,
          { fileName: 'ArcPower.GameSharpening.exe', userReadExecute: true })
        : { path: artifacts.launcher.path, cleanup() {} };
      staged.push(launchStage);
      const controlStage = elevation.elevated
        ? await stageScreenSharpeningHelper(artifacts.control.path, artifacts.control.hash,
          { fileName: 'ArcPower.ManagedSharpeningControl.exe' })
        : { path: artifacts.control.path, cleanup() {} };
      staged.push(controlStage);
      if (stopping) throw new Error('Managed sharpening is stopping');
      return {
        control: createManagedSharpeningControl({ executablePath: controlStage.path, expectedSha256: artifacts.control.hash }),
        launcher: createManagedGameLauncher({ dir, launcherPath: launchStage.path, launcherHash: artifacts.launcher.hash,
          runtimePath: artifacts.runtime.path, runtimeHash: artifacts.runtime.hash, shaderPath: artifacts.shader.path,
          shaderHash: artifacts.shader.hash, isGameExecutable, ...(resolveLaunch ? { resolveLaunch } : {}) }),
      };
    })();
    return resources;
  };
  const control = {
    query: async (value) => (await prepare()).control.query(value),
    set: async (value) => (await prepare()).control.set(value),
    async stop() {
      stopping = true;
      try { if (resources) await (await resources).control.stop(); } catch { /* Staging can be cancelled during app shutdown. */ }
      for (const artifact of staged.splice(0)) { try { artifact.cleanup(); } catch { /* Windows can retain a recently closed native image. */ } }
    },
  };
  return createManagedGameSharpening({ ...policy, dir, detector, isGameExecutable, control,
    launcher: { ready: () => ready, launch: async (exePath) => (await prepare()).launcher.launch(exePath) } });
}
