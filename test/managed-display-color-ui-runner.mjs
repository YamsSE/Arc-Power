// Real Electron/Chromium managed display-color verification. --ui-verify
// forces MockBackend, and this runner never enables the sharpening verifier.
import { app } from 'electron';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isolatedDirectory = mkdtempSync(path.join(os.tmpdir(), 'arcpower-managed-display-color-ui-'));
app.setPath('appData', isolatedDirectory);
os.tmpdir = () => isolatedDirectory;
process.env.RID_MOCK_GAME_SCAN = '1';
process.env.RID_MOCK_FEATURESET = 'b580';
process.env.RID_MOCK_DISPLAY_COLOR_VERIFY = '1';
process.argv.push('--ui-verify');
await import('../src/main/main.js');
