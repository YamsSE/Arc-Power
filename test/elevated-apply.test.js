// M2C-C — elevation-aware apply runner tests (elevated-apply.js): the
// in-process path when elevated, the worker-spawn path when not, the
// UAC-cancel path (missing result file -> honest error), the launch-line
// quoting, and the worker timeout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplyRunner, buildWorkerLaunch, sweepStaleWorkerFiles, APPLY_CANCELED_ERROR, TOKEN_TTL_MS } from '../src/main/elevated-apply.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function testDir(name) {
  return path.join(os.tmpdir(), `arcpower-elev-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

const noopInProcess = {
  apply: async ({ deviceId, settings }) => ({ result: { ok: true, perControl: {} }, state: { powerLimitW: settings.powerLimitW ?? 0 } }),
  waiverAccept: async () => {},
  reset: async () => ({ state: {} }),
};

test('buildWorkerLaunch: quotes our exe + req/out args, RunAs -Wait -PassThru', () => {
  const launch = buildWorkerLaunch('C:\\Program Files\\Arc Power\\Arc Power.exe', null, 'C:\\tmp\\req 1.json', 'C:\\tmp\\out.json');
  assert.match(launch, /Start-Process -FilePath 'C:\\Program Files\\Arc Power\\Arc Power\.exe'/);
  // Every argument is wrapped in embedded double quotes (the Start-Process
  // -ArgumentList quoting trap: space-containing elements are NOT quoted
  // automatically — found live at CP3a).
  assert.match(launch, /-ArgumentList '"--apply-worker"', '"C:\\tmp\\req 1\.json"', '"C:\\tmp\\out\.json"'/);
  assert.match(launch, /-Verb RunAs -Wait -PassThru -ErrorAction Stop/);
  assert.match(launch, /exit \$p\.ExitCode/);
});

test('buildWorkerLaunch: dev mode (electron) passes the app dir via -WorkingDirectory + a relative app path', () => {
  const launch = buildWorkerLaunch('C:\\electron\\electron.exe', 'C:\\repo\\arc power', 'C:\\tmp\\req.json', 'C:\\tmp\\out.json');
  // The space-containing app path never enters the argument list (electron's
  // own CLI parsing hangs on a quoted space-containing app path — CP3a):
  // the working directory carries it and '.' names it.
  assert.match(launch, /-WorkingDirectory 'C:\\repo\\arc power'/);
  assert.match(launch, /-ArgumentList '\.', '"--apply-worker"', '"C:\\tmp\\req\.json"', '"C:\\tmp\\out\.json"'/);
  assert.doesNotMatch(launch, /"C:\\repo\\arc power"/, 'the app path must not appear in the argument list');
});

test('runner: elevated process applies IN-PROCESS (no worker, no files, no spawn)', async () => {
  const dir = testDir('elev');
  fs.mkdirSync(dir, { recursive: true });
  try {
    let spawned = 0;
    const runner = createApplyRunner({
      isElevated: () => true,
      tmpdir: () => dir,
      spawnFn: async () => { spawned += 1; },
      inProcess: noopInProcess,
      log: () => {},
    });
    assert.equal(runner.needsWorker(), false);
    const out = await runner.apply({ deviceId: 0, settings: { powerLimitW: 220 } });
    assert.equal(out.worker, false);
    assert.equal(out.result.ok, true);
    assert.equal(out.state.powerLimitW, 220);
    assert.equal(spawned, 0);
    assert.equal(fs.readdirSync(dir).length, 0, 'no request/result files written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: non-elevated process spawns the worker with a request file and returns the result', async () => {
  const dir = testDir('worker');
  fs.mkdirSync(dir, { recursive: true });
  try {
    let launchCmd = null;
    // Emulate the elevated worker: read the request file (the runner writes
    // it to tmpdir before spawning), write the result file.
    const spawnFn = (cmd, args, opts) => {
      launchCmd = args[2]; // -Command script
      const reqFile = fs.readdirSync(dir).find((f) => f.includes('arcpower-req'));
      const req = JSON.parse(fs.readFileSync(path.join(dir, reqFile), 'utf8'));
      const outPath = path.join(dir, reqFile.replace('arcpower-req-', 'arcpower-out-'));
      fs.writeFileSync(outPath, JSON.stringify({
        requestId: req.requestId, op: 'apply', ok: true, perControl: {}, state: { powerLimitW: 300 },
      }));
      const child = { on: () => {}, kill: () => {} };
      setTimeout(() => child.exit(0), 10);
      return child;
    };
    const runner = createApplyRunner({
      isElevated: () => false,
      tmpdir: () => dir,
      spawnFn: (cmd, args, opts) => {
        const child = spawnFn(cmd, args, opts);
        const handlers = {};
        child.on = (ev, cb) => { handlers[ev] = cb; return child; };
        child.exit = (code) => handlers.exit?.(code);
        return child;
      },
      inProcess: noopInProcess,
      log: () => {},
    });
    assert.equal(runner.needsWorker(), true);
    const out = await runner.apply({ deviceId: 0, settings: { powerLimitW: 300 } });
    assert.equal(out.worker, true);
    assert.equal(out.result.ok, true);
    assert.equal(out.state.powerLimitW, 300);
    assert.ok(launchCmd, 'the worker was spawned via the PowerShell launch line');
    // the request file is cleaned up after the run
    await sleep(20);
    assert.equal(fs.readdirSync(dir).filter((f) => f.includes('arcpower-req')).length, 0, 'request file cleaned up');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: UAC canceled/denied (no result file) -> honest APPLY_CANCELED_ERROR', async () => {
  const dir = testDir('cancel');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const runner = createApplyRunner({
      isElevated: () => false,
      tmpdir: () => dir,
      workerTimeoutMs: 100,
      spawnFn: async () => {
        // The spawned child never emits exit and never writes a result file
        // (UAC declined) — the runner times out and kills it.
        const child = { on: () => {}, kill: () => {} };
        return child;
      },
      inProcess: noopInProcess,
      log: () => {},
    });
    await assert.rejects(() => runner.apply({ deviceId: 0, settings: { powerLimitW: 220 } }), {
      message: APPLY_CANCELED_ERROR,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: worker timeout kills the child and reports the cancellation honestly', async () => {
  const dir = testDir('timeout');
  fs.mkdirSync(dir, { recursive: true });
  try {
    let killed = false;
    const runner = createApplyRunner({
      isElevated: () => false,
      tmpdir: () => dir,
      workerTimeoutMs: 50,
      spawnFn: async () => {
        const child = { on: () => {}, kill: () => { killed = true; } };
        return child;
      },
      inProcess: noopInProcess,
      log: () => {},
    });
    await assert.rejects(() => runner.apply({ deviceId: 0, settings: { powerLimitW: 220 } }), {
      message: APPLY_CANCELED_ERROR,
    });
    assert.equal(killed, true, 'the timed-out worker is killed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: waiverAccept + reset delegate to the worker when not elevated, in-process when elevated', async () => {
  const dir = testDir('ops');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const ops = [];
    const runner = createApplyRunner({
      isElevated: () => true,
      tmpdir: () => dir,
      inProcess: {
        apply: async (r) => { ops.push(['apply', r]); return { result: { ok: true, perControl: {} }, state: {} }; },
        waiverAccept: async (id) => { ops.push(['waiver', id]); },
        reset: async (id) => { ops.push(['reset', id]); return { state: {} }; },
      },
      log: () => {},
    });
    await runner.waiverAccept(0);
    await runner.reset(0);
    await runner.apply({ deviceId: 0, settings: {} });
    assert.deepEqual(ops, [['waiver', 0], ['reset', 0], ['apply', { deviceId: 0, settings: {} }]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: an explicit worker error result surfaces as the error message', async () => {
  const dir = testDir('err');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const runner = createApplyRunner({
      isElevated: () => false,
      tmpdir: () => dir,
      workerTimeoutMs: 300,
      spawnFn: (cmd, args, opts) => {
        // Emulate the worker writing an error result: the out path mirrors
        // the request file's name (the runner writes req before spawning).
        const reqFile = fs.readdirSync(dir).find((f) => f.includes('arcpower-req'));
        const outPath = reqFile ? path.join(dir, reqFile.replace('arcpower-req-', 'arcpower-out-')) : null;
        setTimeout(() => {
          if (outPath) {
            fs.writeFileSync(outPath, JSON.stringify({ requestId: 'x', op: 'apply', ok: false, error: 'backend exploded' }));
          }
        }, 20);
        const child = { on: () => {}, kill: () => {} };
        return child;
      },
      inProcess: noopInProcess,
      log: () => {},
    });
    // The child never exits in this fake; the runner reads the result file
    // after the timeout and surfaces the worker's error message.
    await assert.rejects(() => runner.apply({ deviceId: 0, settings: { powerLimitW: 220 } }), /backend exploded/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('S2: the apply request JSON carries the parent-side waiverAccepted flag', async () => {
  const dir = testDir('s2-flag');
  fs.mkdirSync(dir, { recursive: true });
  try {
    let requestSeen = null;
    const runner = createApplyRunner({
      isElevated: () => false,
      tmpdir: () => dir,
      spawnFn: (cmd, args, opts) => {
        const reqFile = fs.readdirSync(dir).find((f) => f.includes('arcpower-req'));
        requestSeen = JSON.parse(fs.readFileSync(path.join(dir, reqFile), 'utf8'));
        const outPath = path.join(dir, reqFile.replace('arcpower-req-', 'arcpower-out-'));
        fs.writeFileSync(outPath, JSON.stringify({ requestId: requestSeen.requestId, op: 'apply', ok: true, perControl: {}, state: {} }));
        const handlers = {};
        const child = { on: (ev, cb) => { handlers[ev] = cb; return child; }, kill: () => {} };
        child.exit = (code) => handlers.exit?.(code);
        setTimeout(() => child.exit(0), 10);
        return child;
      },
      inProcess: noopInProcess,
      log: () => {},
    });
    const out = await runner.apply({ deviceId: 0, settings: { powerLimitW: 220 }, waiverAccepted: true });
    assert.equal(out.worker, true);
    assert.equal(out.result.ok, true);
    assert.equal(requestSeen.waiverAccepted, true, 'the flag must ride in the worker request');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M2: the parent writes the token BEFORE the request file (the worker contract)', async () => {
  const dir = testDir('s2-tok');
  fs.mkdirSync(dir, { recursive: true });
  try {
    let sawToken = false;
    const runner = createApplyRunner({
      isElevated: () => false,
      tmpdir: () => dir,
      spawnFn: (cmd, args, opts) => {
        // At spawn time BOTH the token and the request must already exist.
        const files = fs.readdirSync(dir);
        const reqFile = files.find((f) => f.includes('arcpower-req'));
        const tokFile = files.find((f) => f.includes('arcpower-tok'));
        assert.ok(reqFile, 'request file written before spawn');
        assert.ok(tokFile, 'token file written before spawn');
        const req = JSON.parse(fs.readFileSync(path.join(dir, reqFile), 'utf8'));
        const tok = JSON.parse(fs.readFileSync(path.join(dir, tokFile), 'utf8'));
        assert.equal(tok.requestId, req.requestId, 'token keyed by the SAME requestId');
        assert.equal(typeof tok.expiresAt, 'number');
        assert.ok(tok.expiresAt > Date.now(), 'token starts live');
        sawToken = true;
        const outPath = path.join(dir, reqFile.replace('arcpower-req-', 'arcpower-out-'));
        fs.writeFileSync(outPath, JSON.stringify({ requestId: req.requestId, op: 'apply', ok: true, perControl: {}, state: {} }));
        const handlers = {};
        const child = { on: (ev, cb) => { handlers[ev] = cb; return child; }, kill: () => {} };
        child.exit = (code) => handlers.exit?.(code);
        setTimeout(() => child.exit(0), 10);
        return child;
      },
      inProcess: noopInProcess,
      log: () => {},
    });
    await runner.apply({ deviceId: 0, settings: { powerLimitW: 220 } });
    assert.equal(sawToken, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M2: a worker timeout NEVER unlinks the result file (the worker may still write it)', async () => {
  const dir = testDir('timeout-race');
  fs.mkdirSync(dir, { recursive: true });
  try {
    let outPath = null;
    let reqFileSeen = null;
    const runner = createApplyRunner({
      isElevated: () => false,
      tmpdir: () => dir,
      workerTimeoutMs: 50,
      spawnFn: (cmd, args, opts) => {
        // Emulate the elevated worker: it captured the request path at spawn
        // time and writes the result LATE (80 ms — after the parent's 50 ms
        // timeout already reported the cancellation).
        reqFileSeen = fs.readdirSync(dir).find((f) => f.includes('arcpower-req'));
        outPath = reqFileSeen ? path.join(dir, reqFileSeen.replace('arcpower-req-', 'arcpower-out-')) : null;
        setTimeout(() => {
          if (outPath) {
            fs.writeFileSync(outPath, JSON.stringify({ requestId: 'late', op: 'apply', ok: true, perControl: {} }));
          }
        }, 80);
        const child = { on: () => {}, kill: () => {} };
        return child;
      },
      inProcess: noopInProcess,
      log: () => {},
    });
    await assert.rejects(() => runner.apply({ deviceId: 0, settings: { powerLimitW: 220 } }), {
      message: APPLY_CANCELED_ERROR,
    });
    await sleep(120); // let the late write land
    assert.ok(outPath, 'the emulated worker knew its out path');
    assert.ok(fs.existsSync(outPath), 'the late result write must NOT have been raced by an unlink (no stray-file race)');
    assert.equal(
      fs.readdirSync(dir).filter((f) => f.includes('arcpower-req') || f.includes('arcpower-tok')).length,
      0,
      'the dead request + token are removed — a late worker then fails honestly',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M2: sweepStaleWorkerFiles removes expired triples + old no-token files, keeps live ones', async () => {
  const dir = testDir('sweep');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const now = Date.now();
    // Expired triple (a crashed parent's leftovers).
    fs.writeFileSync(path.join(dir, 'arcpower-tok-stale.json'), JSON.stringify({ requestId: 'stale', expiresAt: now - 1000 }));
    fs.writeFileSync(path.join(dir, 'arcpower-req-stale.json'), JSON.stringify({ requestId: 'stale' }));
    fs.writeFileSync(path.join(dir, 'arcpower-out-stale.json'), JSON.stringify({ ok: true }));
    // Old no-token files (pre-token-era garbage, older than the TTL).
    const oldNoTok = path.join(dir, 'arcpower-req-old.json');
    fs.writeFileSync(oldNoTok, JSON.stringify({}));
    const oldOut = path.join(dir, 'arcpower-out-old.json');
    fs.writeFileSync(oldOut, JSON.stringify({}));
    const t0 = new Date(now - TOKEN_TTL_MS - 60000);
    fs.utimesSync(oldNoTok, t0, t0);
    fs.utimesSync(oldOut, t0, t0);
    // Live triple (fresh token) — must survive.
    fs.writeFileSync(path.join(dir, 'arcpower-tok-live.json'), JSON.stringify({ requestId: 'live', expiresAt: now + 600000 }));
    fs.writeFileSync(path.join(dir, 'arcpower-req-live.json'), JSON.stringify({ requestId: 'live' }));
    fs.writeFileSync(path.join(dir, 'arcpower-out-live.json'), JSON.stringify({ ok: true }));
    // Expired token with no matching request — also swept.
    fs.writeFileSync(path.join(dir, 'arcpower-tok-orphan.json'), JSON.stringify({ requestId: 'orphan', expiresAt: now - 1000 }));

    const removed = await sweepStaleWorkerFiles(dir, { now, tokenTtlMs: TOKEN_TTL_MS });
    const remaining = fs.readdirSync(dir).sort();
    assert.equal(removed, 6, 'expired triple (3) + old no-token pair (2) + orphan token (1)');
    assert.deepEqual(remaining, ['arcpower-out-live.json', 'arcpower-req-live.json', 'arcpower-tok-live.json'], 'only the live triple survives');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M2: a stale leftover from a crashed parent is swept before the next run', async () => {
  const dir = testDir('sweep-run');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const now = Date.now();
    fs.writeFileSync(path.join(dir, 'arcpower-tok-crash.json'), JSON.stringify({ requestId: 'crash', expiresAt: now - 1000 }));
    fs.writeFileSync(path.join(dir, 'arcpower-req-crash.json'), JSON.stringify({ requestId: 'crash' }));
    fs.writeFileSync(path.join(dir, 'arcpower-out-crash.json'), JSON.stringify({ ok: true }));

    const runner = createApplyRunner({
      isElevated: () => false,
      tmpdir: () => dir,
      spawnFn: (cmd, args, opts) => {
        const reqFile = fs.readdirSync(dir).find((f) => f.includes('arcpower-req'));
        const req = JSON.parse(fs.readFileSync(path.join(dir, reqFile), 'utf8'));
        const outPath = path.join(dir, reqFile.replace('arcpower-req-', 'arcpower-out-'));
        fs.writeFileSync(outPath, JSON.stringify({ requestId: req.requestId, op: 'apply', ok: true, perControl: {}, state: {} }));
        const handlers = {};
        const child = { on: (ev, cb) => { handlers[ev] = cb; return child; }, kill: () => {} };
        child.exit = (code) => handlers.exit?.(code);
        setTimeout(() => child.exit(0), 10);
        return child;
      },
      inProcess: noopInProcess,
      log: () => {},
    });
    const out = await runner.apply({ deviceId: 0, settings: { powerLimitW: 220 } });
    assert.equal(out.result.ok, true, 'the current apply still works');
    const remaining = fs.readdirSync(dir);
    assert.equal(remaining.filter((f) => f.includes('crash')).length, 0, 'the crashed parent\'s leftovers are gone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('N2: a TORN token write is treated as expired — swept even while its req/out files are fresh', async () => {
  const dir = testDir('sweep-torn');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const now = Date.now();
    // Torn token write (the parent's apply already failed mid-write; no
    // worker was spawned) + a matching req/out pair that is still FRESH —
    // the old code left the token forever because only the age rule applied.
    fs.writeFileSync(path.join(dir, 'arcpower-tok-torn.json'), '{"requestId": "torn", "expiresAt": '); // partial JSON
    fs.writeFileSync(path.join(dir, 'arcpower-req-torn.json'), JSON.stringify({ requestId: 'torn' }));
    fs.writeFileSync(path.join(dir, 'arcpower-out-torn.json'), JSON.stringify({ ok: true }));
    // Orphan torn token with no siblings — must not linger either.
    fs.writeFileSync(path.join(dir, 'arcpower-tok-orphan.json'), 'garbage');
    // A live request's VALID fresh token must still survive untouched.
    fs.writeFileSync(path.join(dir, 'arcpower-tok-live.json'), JSON.stringify({ requestId: 'live', expiresAt: now + 600000 }));
    fs.writeFileSync(path.join(dir, 'arcpower-req-live.json'), JSON.stringify({ requestId: 'live' }));
    fs.writeFileSync(path.join(dir, 'arcpower-out-live.json'), JSON.stringify({ ok: true }));

    const removed = await sweepStaleWorkerFiles(dir, { now, tokenTtlMs: TOKEN_TTL_MS });
    const remaining = fs.readdirSync(dir).sort();
    assert.equal(removed, 4, 'torn triple (3) + orphan torn token (1)');
    assert.deepEqual(remaining, ['arcpower-out-live.json', 'arcpower-req-live.json', 'arcpower-tok-live.json'], 'only the live triple survives');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('N3: a runner WITHOUT inProcess fails honestly — never a TypeError', async () => {
  const dir = testDir('no-inprocess');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const runner = createApplyRunner({
      isElevated: () => false, // not elevated, but no in-process executor either
      tmpdir: () => dir,
      log: () => {},
    });
    assert.equal(runner.needsWorker(), false, 'without inProcess the runner cannot claim the in-process path');
    await assert.rejects(() => runner.apply({ deviceId: 0, settings: { powerLimitW: 220 } }), /no in-process executor/);
    await assert.rejects(() => runner.waiverAccept(0), /no in-process executor/);
    await assert.rejects(() => runner.reset(0), /no in-process executor/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('N3: an ELEVATED runner without inProcess fails honestly too (same contract)', async () => {
  const runner = createApplyRunner({ isElevated: () => true, log: () => {} });
  assert.equal(runner.needsWorker(), false);
  await assert.rejects(() => runner.apply({ deviceId: 0, settings: {} }), /no in-process executor/);
});
