import { initializeBridge, installDragRegions, installConsoleBridge, rendererReady, rendererFailed } from './tauri-electron-adapter.ts';

async function start(): Promise<void> {
  await initializeBridge();
  installConsoleBridge();
  // The dynamic import runs the unchanged real preload before app.ts evaluates
  // its static `window.arcPower` import, preserving all 153 public invokes.
  // @ts-expect-error Existing CommonJS sandbox preload has no TS declaration.
  await import('../../preload.cjs');
  installDragRegions();
  await import('../app.ts');
  await rendererReady();
}

void start().catch(async (error) => {
  console.error('[tauri] frontend initialization failed', error);
  const failure = document.createElement('pre');
  failure.textContent = `Arc Power could not start: ${error instanceof Error ? error.message : String(error)}`;
  failure.style.cssText = 'padding:24px;color:#f4f7ff;background:#101522;white-space:pre-wrap';
  document.body.replaceChildren(failure);
  await rendererFailed().catch(cause => console.error('[tauri] could not reveal startup failure', cause));
});
