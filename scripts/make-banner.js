// Arc Power - Discord server banner generator (Electron offscreen capture).
//
// Renders scripts/discord-banner.html (a fixed 1920x360 banner matching the
// website palette and wordmark) in a hidden Electron window and writes
// website/assets/discord-banner.png - the server banner for the Discord
// community server.
//
// Usage: npm run make:banner

import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARD = path.join(ROOT, 'scripts', 'discord-banner.html');
const OUT = path.join(ROOT, 'website', 'assets', 'discord-banner.png');
const W = 1920;
const H = 360;

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
    console.log(`[make-banner] wrote ${path.relative(ROOT, OUT)} (${size.width}x${size.height})`);
  } catch (err) {
    console.error('[make-banner] failed:', err.message);
    process.exitCode = 1;
  } finally {
    app.exit(0);
  }
});
