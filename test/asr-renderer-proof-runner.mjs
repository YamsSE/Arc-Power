// Hidden Electron/Chromium regression for the global sharpening/ASR status
// merge. This launches only the mock UI verification path with isolated state.
import { app } from 'electron';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isolatedDirectory = mkdtempSync(path.join(os.tmpdir(), 'arcpower-asr-renderer-proof-'));
app.setPath('appData', isolatedDirectory);
os.tmpdir = () => isolatedDirectory;
process.env.RID_MOCK_POSTPROCESS_VERIFY = '1';
process.env.RID_MOCK_POSTPROCESS_RENDERER_PROOF = '1';
process.argv.push('--ui-verify');
await import('../src/main/main.js');
