// Electron-free child entry for synchronous RTSSHooks/Koffi calls. Electron
// launches this file with ELECTRON_RUN_AS_NODE=1; never import main.js here.

import readline from 'node:readline';
import { createRtssProfileController } from './rtss-profile.js';

let runtime = { executablePath: null, isRunning: false };
const controller = createRtssProfileController({
  getExecutablePath: async () => runtime.executablePath,
  isRunning: async () => runtime.isRunning === true,
});

let queue = Promise.resolve();
const methods = new Set([
  'apply',
  'getFrameLimit',
  'getFrameLimitOwnership',
  'applyFrameLimit',
  'restoreFrameLimit',
  'restoreFrameLimitState',
]);

const handleLine = (line) => {
  queue = queue.catch(() => {}).then(async () => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    if (!request || typeof request.id !== 'string' || !methods.has(request.method)) return;
    runtime = {
      executablePath: typeof request.runtime?.executablePath === 'string' ? request.runtime.executablePath : null,
      isRunning: request.runtime?.isRunning === true,
    };
    try {
      const result = await controller[request.method](request.args);
      process.stdout.write(`${JSON.stringify({ id: request.id, result, state: controller.getState() })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
        state: controller.getState(),
      })}\n`);
    }
  });
};

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', handleLine);
input.on('close', () => {
  // The parent normally kills this process on app shutdown. If stdin closes
  // cleanly, let Node exit naturally after any queued request completes.
  void queue.finally(() => process.exit(0));
});
