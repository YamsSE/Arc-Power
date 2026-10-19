// Real Electron/Chromium UI verification against the source-only postprocess mock.
import { app } from 'electron';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isolatedDirectory = mkdtempSync(path.join(os.tmpdir(), 'arcpower-postprocess-sharpening-ui-'));
app.setPath('appData', isolatedDirectory);
// Keep application stores and fixture catalog isolated; the postprocess mock
// never installs a runtime or writes to the selected game's directory.
os.tmpdir = () => isolatedDirectory;
process.env.RID_MOCK_GAME_SCAN = '1';
process.env.RID_MOCK_FEATURESET = 'b580';
process.env.RID_MOCK_POSTPROCESS_VERIFY = '1';
process.argv.push('--ui-verify');
await import('../src/main/main.js');
