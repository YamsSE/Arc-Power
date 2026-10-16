// Run the focused sharpening UI assertions in a real Electron Chromium window.
import { app } from 'electron';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isolatedDirectory = mkdtempSync(path.join(os.tmpdir(), 'arcpower-sharpening-ui-'));
app.setPath('appData', isolatedDirectory);
// Mock game fixtures and both application stores stay inside this temporary
// directory; the user's profile and installed driver are never read/written.
os.tmpdir = () => isolatedDirectory;
process.env.RID_MOCK_GAME_SCAN = '1';
process.env.RID_MOCK_FEATURESET = 'b580';
process.env.RID_MOCK_SHARPENING_VERIFY = '1';
process.argv.push('--ui-verify');
await import('../src/main/main.js');
