import { app } from 'electron';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isolatedDirectory = mkdtempSync(path.join(os.tmpdir(), 'arcpower-fan-resume-ui-'));
app.setPath('appData', isolatedDirectory);
os.tmpdir = () => isolatedDirectory;
process.env.RID_MOCK_GAME_SCAN = '1';
process.env.RID_MOCK_FEATURESET = 'b580';
process.env.RID_MOCK_ELEVATED = '1';
process.env.RID_MOCK_FAN_RESUME_VERIFY = '1';
process.argv.push('--ui-verify');
await import('../src/main/main.js');
