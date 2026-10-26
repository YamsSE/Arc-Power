// Real Electron/Chromium Advanced Overlay verification against isolated mock state.
import { app } from 'electron';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isolatedDirectory = mkdtempSync(path.join(os.tmpdir(), 'arcpower-advanced-overlay-settings-ui-'));
app.setPath('appData', isolatedDirectory);
os.tmpdir = () => isolatedDirectory;
process.env.RID_MOCK_ADV_OVERLAY = '1';
process.env.RID_MOCK_ADV_OVERLAY_SETTINGS_VERIFY = '1';
process.argv.push('--ui-verify');
await import('../src/main/main.js');
