import { initializeBridge, installConsoleBridge, installDragRegions, rendererReady, rendererFailed } from './tauri-electron-adapter.ts';

async function start(): Promise<void> {
  await initializeBridge();
  installConsoleBridge();
  const documentName = location.pathname.split('/').pop();
  if (documentName === 'splash.html') {
    // @ts-expect-error Original CommonJS preload has no TypeScript declaration.
    await import('../splash-preload.cjs');
    // @ts-expect-error Original splash renderer is plain JavaScript.
    await import('../splash.js');
  } else {
    // @ts-expect-error Original CommonJS preload has no TypeScript declaration.
    await import('../../preload.cjs');
    switch (documentName) {
      case 'overlay.html': await import('../overlay.ts'); break;
      case 'advanced-overlay.html': installDragRegions(); await import('../advanced-overlay.ts'); break;
      case 'recording-toast.html': await import('../recording-toast.ts'); break;
      case 'recording-status-pill.html': await import('../recording-status-pill.ts'); break;
      default: throw new Error('Unknown native frontend document');
    }
  }
  await rendererReady();
}
void start().catch(async error => {
  console.error('[tauri] auxiliary frontend failed', error);
  await rendererFailed().catch(() => {});
});
