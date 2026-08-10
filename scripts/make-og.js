// Arc Power - OpenGraph card generator (Electron offscreen capture).
//
// Renders scripts/og-card.html (a fixed 1200x630 card matching the website
// palette) in a hidden Electron window and writes website/assets/og.png -
// the social preview for GitHub / Discord / WhatsApp link shares.
//
// Usage: npm run make:og

import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARD = path.join(ROOT, 'scripts', 'og-card.html');
const OUT = path.join(ROOT, 'website', 'assets', 'og.png');
const W = 1200;
const H = 630;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: W,
      height: H,
      show: false,
      frame: false,
      useContentSize: true,
      webPreferences: { backgroundThrottling: false },
    });
    await win.loadFile(CARD);
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true);
    await wait(800);

    let shot = null;
    for (let i = 0; i < 15 && !shot; i++) {
      try {
        const image = await win.webContents.capturePage();
        if (image.getSize().width > 0 && image.getSize().height > 0) shot = image;
      } catch {
        // retry
      }
      if (!shot) {
        // Compositor may not have painted a hidden window yet - nudge it;
        // as a last resort park the window off-screen and show it.
        if (i === 7) {
          win.setPosition(-10000, 0);
          win.show();
        }
        win.webContents.invalidate();
        await wait(250);
      }
    }
    if (!shot) throw new Error('capturePage returned no painted frame');

    writeFileSync(OUT, shot.toPNG());
    const size = shot.getSize();
    console.log(`[make-og] wrote ${path.relative(ROOT, OUT)} (${size.width}x${size.height})`);
  } catch (err) {
    console.error('[make-og] failed:', err.message);
    process.exitCode = 1;
  } finally {
    app.exit(0);
  }
});
