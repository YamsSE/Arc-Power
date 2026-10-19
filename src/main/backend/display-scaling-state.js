import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

const MAX_RECORD_BYTES = 16 * 1024;
const NATIVE_SCALING_TYPES = new Set([0, 1, 2, 4, 8, 16]);

function defaultDirectory() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ArcPower', 'DisplayScalingSettings');
}

function displayFileName(displayKey) {
  return `${createHash('sha256').update(displayKey, 'utf8').digest('hex')}.json`;
}

function failure(reason) { return { ok: false, reason }; }
function cloneState(state) { return state ? { ...state } : null; }
function okState(state) { return { ok: true, state: cloneState(state) }; }
function emptyState() { return { identityScaling: null, nativePreferredScalingType: null, customX: null, customY: null }; }

function validateDisplayKey(displayKey) {
  if (typeof displayKey !== 'string' || displayKey.length === 0 || displayKey.length > 4096) {
    throw new Error('A valid stable display key is required.');
  }
}

function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || Object.keys(state).length !== 4
    || Object.keys(state).some((key) => !['identityScaling', 'nativePreferredScalingType', 'customX', 'customY'].includes(key))) {
    throw new Error('Display scaling state schema is invalid.');
  }
  if (typeof state.identityScaling !== 'boolean') throw new Error('Display identity scaling selection is invalid.');
  if (state.nativePreferredScalingType !== null
    && (!Number.isInteger(state.nativePreferredScalingType) || !NATIVE_SCALING_TYPES.has(state.nativePreferredScalingType))) {
    throw new Error('Display native preferred scaling type is invalid.');
  }
  const hasCustomX = state.customX !== null;
  const hasCustomY = state.customY !== null;
  if (hasCustomX !== hasCustomY) throw new Error('Custom display scaling values must be paired.');
  for (const key of ['customX', 'customY']) {
    if (state[key] !== null && (!Number.isInteger(state[key]) || state[key] < 0 || state[key] > 100)) {
      throw new Error(`Display ${key} scaling value is invalid.`);
    }
  }
  return { identityScaling: state.identityScaling, nativePreferredScalingType: state.nativePreferredScalingType, customX: state.customX, customY: state.customY };
}

function validateRecord(raw, displayKey) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).length !== 3
    || Object.keys(raw).some((key) => !['version', 'displayKey', 'state'].includes(key))
    || raw.version !== 1 || raw.displayKey !== displayKey) throw new Error('Display scaling record identity or schema is invalid.');
  return validateState(raw.state);
}

function recordPath(dir, displayKey) { return path.join(dir, displayFileName(displayKey)); }

function readRecord(file, displayKey) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_RECORD_BYTES) {
    throw new Error('Display scaling record is linked or too large; refusing to trust it.');
  }
  return validateRecord(JSON.parse(fs.readFileSync(file, 'utf8')), displayKey);
}

function ensureSafeDirectory(dir, create) {
  let stat;
  try { stat = fs.lstatSync(dir); }
  catch (error) {
    if (error?.code !== 'ENOENT' || !create) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    fs.mkdirSync(dir, { recursive: true });
    stat = fs.lstatSync(dir);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Display scaling settings directory is linked or invalid.');
  return true;
}

function atomicWrite(file, record) {
  const temp = `${file}.${process.pid}.${createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 16)}.tmp`;
  let fd = null;
  let created = false;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    created = true;
    fs.writeFileSync(fd, JSON.stringify(record), { encoding: 'utf8' });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
    created = false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best effort close after a failed write */ }
    }
    if (created) {
      try { fs.unlinkSync(temp); } catch { /* clean up only this operation's temporary file */ }
    }
  }
}

/** Persistent, non-hardware scaling editor selections keyed by stable display identity. */
export function createDisplayScalingStateStore({ dir } = {}) {
  const memoryOnly = dir === null;
  const storageDir = memoryOnly ? null : (dir === undefined ? defaultDirectory() : dir);
  if (!memoryOnly && (typeof storageDir !== 'string' || !path.isAbsolute(storageDir))) {
    throw new TypeError('Display scaling settings directory must be an absolute path or null.');
  }

  const memory = new Map();
  const queues = new Map();
  function enqueue(key, work) {
    const prior = queues.get(key) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(work);
    queues.set(key, current);
    return current.finally(() => { if (queues.get(key) === current) queues.delete(key); });
  }
  function load(displayKey) {
    validateDisplayKey(displayKey);
    if (memoryOnly) return cloneState(memory.get(displayKey)) ?? emptyState();
    if (!ensureSafeDirectory(storageDir, false)) return emptyState();
    return readRecord(recordPath(storageDir, displayKey), displayKey) ?? emptyState();
  }

  return Object.freeze({
    async read(displayKey) {
      try {
        const state = load(displayKey);
        return okState(state.identityScaling === null ? null : state);
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },

    async saveSelection(displayKey, selection) {
      try {
        validateDisplayKey(displayKey);
        if (!selection || typeof selection !== 'object' || Array.isArray(selection)) throw new Error('Display scaling selection is invalid.');
        const keys = Object.keys(selection);
        if (keys.some((key) => !['identityScaling', 'nativePreferredScalingType', 'customX', 'customY'].includes(key))
          || !Object.hasOwn(selection, 'identityScaling') || !Object.hasOwn(selection, 'nativePreferredScalingType')) {
          throw new Error('Display scaling selection schema is invalid.');
        }
        if (typeof selection.identityScaling !== 'boolean') throw new Error('Display identity scaling selection is invalid.');
        if (selection.nativePreferredScalingType !== null
          && (!Number.isInteger(selection.nativePreferredScalingType) || !NATIVE_SCALING_TYPES.has(selection.nativePreferredScalingType))) {
          throw new Error('Display native preferred scaling type is invalid.');
        }
        const hasX = Object.hasOwn(selection, 'customX');
        const hasY = Object.hasOwn(selection, 'customY');
        if (hasX !== hasY) throw new Error('Custom display scaling values must be paired.');
        if (hasX) {
          for (const key of ['customX', 'customY']) {
            if (!Number.isInteger(selection[key]) || selection[key] < 0 || selection[key] > 100) throw new Error(`Display ${key} scaling value is invalid.`);
          }
        }
        return await enqueue(displayKey, () => {
          const current = load(displayKey);
          const next = {
            identityScaling: selection.identityScaling,
            nativePreferredScalingType: selection.nativePreferredScalingType,
            customX: hasX ? selection.customX : current.customX,
            customY: hasY ? selection.customY : current.customY,
          };
          if (memoryOnly) memory.set(displayKey, next);
          else {
            ensureSafeDirectory(storageDir, true);
            atomicWrite(recordPath(storageDir, displayKey), { version: 1, displayKey, state: next });
          }
          return okState(next);
        });
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
