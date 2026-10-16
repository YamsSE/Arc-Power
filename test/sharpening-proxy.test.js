import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSharpeningProxy } from '../src/main/sharpening-proxy.js';
import { validateSharpeningRequest, sharpeningGuardIsLive } from '../src/main/sharpening-contract.js';
import { runSharpeningHelperRequest, validateSharpeningCapability, matchUniqueLuid, interpretSharpeningRead, isParentProcessAlive, resolveLegacySharpeningDllPath, sharpeningReadMatchesRequest } from '../src/main/sharpening-helper-entry.js';
import { CTL_3D_FEATURE, CTL_PROPERTY_VALUE_TYPE, CTL_RESULT } from '../src/main/backend/igcl-bindings.js';

const base = { action: 'read', luid: '9ebf000000000000', deadlineAt: Date.now() + 5000 };
const detail = { featureType: CTL_3D_FEATURE.SHARPENING_FILTER, valueType: CTL_PROPERTY_VALUE_TYPE.INT32,
  intRange: { min: 0, max: 100, step: 1, default: 0 }, defaultEnabled: false };

function fakeChild() {
  const child = new EventEmitter();
  child.connected = true;
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('close', null); };
  child.disconnect = () => { child.connected = false; };
  child.send = (_message, callback) => callback?.();
  return child;
}

test('helper validates the entire request before invoking any native operation', async () => {
  let nativeCalls = 0;
  const execute = async () => { nativeCalls += 1; return { ok: true }; };
  const { action: _action, ...withoutAction } = base;
  assert.equal((await runSharpeningHelperRequest(withoutAction, { execute })).errorCode, 'invalid-argument');
  assert.equal((await runSharpeningHelperRequest({ ...base, action: 'set', enabled: true, percentage: 37.5 }, { execute })).errorCode, 'invalid-argument');
  assert.equal((await runSharpeningHelperRequest({ ...base, action: 'set', enabled: true, percentage: 37, unexpected: true }, { execute })).errorCode, 'invalid-argument');
  assert.equal((await runSharpeningHelperRequest({ ...base, action: 'set', enabled: true, percentage: 37, luid: '0000000000000000' }, { execute })).errorCode, 'invalid-argument');
  assert.equal(nativeCalls, 0);
});

test('helper rejects expired deadlines and disconnected parents before native work', async () => {
  let nativeCalls = 0;
  const execute = async () => { nativeCalls += 1; };
  assert.equal((await runSharpeningHelperRequest({ ...base, deadlineAt: 100 }, { now: () => 100, execute })).errorCode, 'invalid-argument');
  assert.equal((await runSharpeningHelperRequest(base, { isConnected: () => false, execute })).errorCode, 'cancelled');
  assert.equal(nativeCalls, 0);
});

test('OS parent liveness remains independent from IPC event delivery', () => {
  assert.equal(isParentProcessAlive(42, () => {}), true);
  assert.equal(isParentProcessAlive(42, () => { const error = new Error('denied'); error.code = 'EPERM'; throw error; }), true);
  assert.equal(isParentProcessAlive(42, () => { const error = new Error('gone'); error.code = 'ESRCH'; throw error; }), false);
  assert.equal(isParentProcessAlive(0, () => {}), false);
});

test('identity resolution requires exactly one LUID match', () => {
  assert.throws(() => matchUniqueLuid([1, 2], (x) => x === 1 ? 'aaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'), /not found/);
  assert.throws(() => matchUniqueLuid([1, 2], () => 'aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa'), /more than once/);
  assert.equal(matchUniqueLuid([1, 2], (x) => x === 2 ? 'aaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa'), 2);
});

test('capability range and per-read values fail closed; DATA_NOT_FOUND uses advertised defaults', () => {
  assert.equal(validateSharpeningCapability(detail), true);
  assert.equal(validateSharpeningCapability({ ...detail, featureType: CTL_3D_FEATURE.FRAME_LIMIT }), false);
  assert.equal(validateSharpeningCapability({ ...detail, valueType: CTL_PROPERTY_VALUE_TYPE.BOOL }), false);
  assert.equal(validateSharpeningCapability({ ...detail, intRange: { ...detail.intRange, step: 0 } }), false);
  assert.equal(validateSharpeningCapability({ ...detail, intRange: { ...detail.intRange, step: 2 } }), false);
  assert.equal(validateSharpeningCapability({ ...detail, intRange: { ...detail.intRange, default: 101 } }), false);
  assert.deepEqual(interpretSharpeningRead(CTL_RESULT.ERROR_DATA_NOT_FOUND, null, detail), { enabled: false, percentage: 0, isDefault: true });
  assert.match(interpretSharpeningRead(CTL_RESULT.ERROR_DATA_READ, null, detail).error, /ERROR_DATA_READ/);
  assert.match(interpretSharpeningRead(CTL_RESULT.SUCCESS, { enabled: true, percentage: 101 }, detail).error, /invalid/);
  assert.equal(interpretSharpeningRead(CTL_RESULT.SUCCESS, { enabled: true, percentage: 37 }, detail).percentage, 37);
});

test('DATA_NOT_FOUND readback uses advertised nonzero and enabled defaults', () => {
  const detail = { defaultEnabled: true, intRange: { default: 37 } };
  const read = interpretSharpeningRead(CTL_RESULT.ERROR_DATA_NOT_FOUND, null, detail);
  assert.deepEqual(read, { enabled: true, percentage: 37, isDefault: true });
  assert.equal(sharpeningReadMatchesRequest(read, { enabled: true, percentage: 37 }, detail), true);
  assert.equal(sharpeningReadMatchesRequest(read, { enabled: false, percentage: 37 }, detail), false);
  assert.equal(sharpeningReadMatchesRequest(read, { enabled: true, percentage: 36 }, detail), false);
  assert.equal(sharpeningReadMatchesRequest({ enabled: true, percentage: 37, isDefault: false },
    { enabled: true, percentage: 37 }, detail), true);
});

test('legacy sharpening DLL path resolves out of app.asar when oldIgclDllPath returns its archive fallback', () => {
  const legacyPath = 'C:\\ArcPower\\resources\\app.asar\\src\\main\\backend\\igcl2023\\IntelControlLib.dll';
  assert.equal(resolveLegacySharpeningDllPath(legacyPath),
    'C:\\ArcPower\\resources\\app.asar.unpacked\\src\\main\\backend\\igcl2023\\IntelControlLib.dll');
  assert.equal(resolveLegacySharpeningDllPath('C:\\ArcPower\\resources\\app.asar.unpacked\\src\\main\\backend\\igcl2023\\IntelControlLib.dll'),
    'C:\\ArcPower\\resources\\app.asar.unpacked\\src\\main\\backend\\igcl2023\\IntelControlLib.dll');
});

test('request guard denies cancellation, missing or mismatched tokens, and accepts a live matching token', () => {
  const guard = { requestId: 'aa-bb', cancelPath: 'C:\\Temp\\arcpower-cancel-aa-bb.json', tokenPath: 'C:\\Temp\\arcpower-tok-aa-bb.json' };
  assert.equal(validateSharpeningRequest({ ...base, action: 'set', enabled: true, percentage: 37, guard }), true);
  const fakeFs = (cancel, token) => ({ existsSync: (name) => name === guard.cancelPath && cancel,
    readFileSync: () => JSON.stringify(token) });
  assert.equal(sharpeningGuardIsLive(guard, 10, fakeFs(true, { requestId: 'aa-bb', expiresAt: 20 })), false);
  assert.equal(sharpeningGuardIsLive(guard, 10, fakeFs(false, { requestId: 'other', expiresAt: 20 })), false);
  assert.equal(sharpeningGuardIsLive(guard, 20, fakeFs(false, { requestId: 'aa-bb', expiresAt: 20 })), false);
  assert.equal(sharpeningGuardIsLive(guard, 10, fakeFs(false, { requestId: 'aa-bb', expiresAt: 20 })), true);
});

test('helper rechecks a revoked token immediately before its native set callback', async () => {
  const guard = { requestId: 'aa-bb', cancelPath: 'C:\\Temp\\arcpower-cancel-aa-bb.json', tokenPath: 'C:\\Temp\\arcpower-tok-aa-bb.json' };
  let live = true;
  let nativeWrites = 0;
  const request = { ...base, action: 'set', enabled: true, percentage: 37, guard };
  const result = await runSharpeningHelperRequest(request, {
    guardIsLive: () => live,
    execute: async (_request, canContinue) => {
      live = false;
      if (!canContinue()) return { ok: false, errorCode: 'cancelled' };
      nativeWrites += 1;
      return { ok: true };
    },
  });
  assert.equal(result.errorCode, 'cancelled');
  assert.equal(nativeWrites, 0);
});

test('proxy serializes helper calls and kills active and queued work on close', async () => {
  const children = [];
  const proxy = createSharpeningProxy({ spawnFn: () => { const child = fakeChild(); children.push(child); return child; } });
  const first = proxy.run({ ...base, action: 'set', enabled: true, percentage: 37 });
  const second = proxy.run({ ...base, action: 'set', enabled: true, percentage: 42 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 1);
  await proxy.close();
  assert.equal((await first).errorCode, 'cancelled');
  assert.equal((await second).errorCode, 'cancelled');
  assert.equal(children.length, 1);
  assert.equal(children[0].killed, true);
});

test('proxy returns helper verification and kills a timed out child', async () => {
  const child = fakeChild();
  const proxy = createSharpeningProxy({ spawnFn: () => child });
  const pending = proxy.run({ ...base, action: 'set', enabled: true, percentage: 37 });
  await new Promise((resolve) => setImmediate(resolve));
  child.emit('message', { ok: true, readBackEqual: true });
  child.emit('close', 0);
  assert.deepEqual(await pending, { ok: true, readBackEqual: true });

  let timedChild;
  const timeoutProxy = createSharpeningProxy({ timeoutMs: 15, spawnFn: () => (timedChild = fakeChild()) });
  const result = await timeoutProxy.run({ ...base, action: 'set', enabled: true, percentage: 37 });
  assert.equal(result.errorCode, 'timeout');
  assert.equal(timedChild.killed, true);
});

test('packaged helper script uses a real executable directory as cwd', async () => {
  let spawnOptions;
  let child;
  const execPath = 'C:\\ArcPower\\ArcPower.exe';
  const entryPath = 'C:\\ArcPower\\resources\\app.asar\\src\\main\\sharpening-helper-entry.js';
  const proxy = createSharpeningProxy({ execPath, entryPath, spawnFn: (_exe, _args, options) => {
    spawnOptions = options;
    child = fakeChild();
    return child;
  } });
  const pending = proxy.run(base);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawnOptions.cwd, 'C:\\ArcPower');
  assert.doesNotMatch(spawnOptions.cwd, /app\.asar/i);
  child.emit('message', { ok: true });
  child.emit('close', 0);
  assert.equal((await pending).ok, true);
});
