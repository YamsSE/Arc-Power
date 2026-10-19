import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

export const DISPLAY_COLOR_DEFAULTS = Object.freeze({
  hue: 0,
  saturation: 1,
  brightness: 0,
  contrast: 1,
});

export const DISPLAY_COLOR_RANGES = Object.freeze({
  hue: Object.freeze({ min: -180, max: 180, step: 1, default: 0 }),
  saturation: Object.freeze({ min: 0, max: 2, step: 0.02, default: 1 }),
  brightness: Object.freeze({ min: -100, max: 100, step: 2, default: 0 }),
  contrast: Object.freeze({ min: 0, max: 2, step: 0.02, default: 1 }),
});

const GROUP_FIELDS = Object.freeze({
  hueSaturation: Object.freeze(['hue', 'saturation']),
  brightnessContrast: Object.freeze(['brightness', 'contrast']),
});
const EMPTY_SENT = Object.freeze({ hueSaturation: false, brightnessContrast: false });
const MAX_RECORD_BYTES = 16 * 1024;

function defaultDirectory() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ArcPower', 'DisplayColorSettings');
}

function displayFileName(displayKey) {
  return `${createHash('sha256').update(displayKey, 'utf8').digest('hex')}.json`;
}

function cloneDefaults() { return { ...DISPLAY_COLOR_DEFAULTS }; }
function cloneSent(value = EMPTY_SENT) { return { hueSaturation: value.hueSaturation, brightnessContrast: value.brightnessContrast }; }
function okState(values, sent) { return { ok: true, values: { ...values }, sent: cloneSent(sent) }; }
function failure(reason) { return { ok: false, reason }; }

function validateValue(key, value) {
  const range = DISPLAY_COLOR_RANGES[key];
  if (!Number.isFinite(value) || value < range.min || value > range.max) throw new Error(`Invalid ${key} value.`);
  const steps = (value - range.min) / range.step;
  if (Math.abs(steps - Math.round(steps)) > 1e-7) throw new Error(`Invalid ${key} step.`);
  return value;
}

function validateRecord(raw, displayKey) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).length !== 4
    || Object.keys(raw).some((key) => !['version', 'displayKey', 'values', 'sent'].includes(key))
    || raw.version !== 1 || raw.displayKey !== displayKey) throw new Error('Display color record identity or schema is invalid.');
  const values = raw.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)
    || Object.keys(values).length !== 4
    || Object.keys(values).some((key) => !(key in DISPLAY_COLOR_DEFAULTS))) throw new Error('Display color values schema is invalid.');
  const cleanValues = {};
  for (const key of Object.keys(DISPLAY_COLOR_DEFAULTS)) cleanValues[key] = validateValue(key, values[key]);
  const sent = raw.sent;
  if (!sent || typeof sent !== 'object' || Array.isArray(sent)
    || Object.keys(sent).length !== 2
    || Object.keys(sent).some((key) => !(key in EMPTY_SENT))
    || typeof sent.hueSaturation !== 'boolean' || typeof sent.brightnessContrast !== 'boolean') throw new Error('Display color sent-state schema is invalid.');
  return { values: cleanValues, sent: cloneSent(sent) };
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
    throw new Error('Display color record is linked or too large; refusing to trust it.');
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return validateRecord(parsed, displayKey);
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
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Display color settings directory is linked or invalid.');
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

/** Persistent, non-hardware desired color settings keyed by stable display identity. */
export function createDisplayColorStateStore({ dir } = {}) {
  const memoryOnly = dir === null;
  const storageDir = memoryOnly ? null : (dir === undefined ? defaultDirectory() : dir);
  if (!memoryOnly && (typeof storageDir !== 'string' || !path.isAbsolute(storageDir))) {
    throw new TypeError('Display color settings directory must be an absolute path or null.');
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
    if (typeof displayKey !== 'string' || displayKey.length === 0 || displayKey.length > 4096) throw new Error('A valid stable display key is required.');
    if (memoryOnly) {
      const found = memory.get(displayKey);
      return found ? { values: { ...found.values }, sent: cloneSent(found.sent) } : { values: cloneDefaults(), sent: cloneSent() };
    }
    if (!ensureSafeDirectory(storageDir, false)) return { values: cloneDefaults(), sent: cloneSent() };
    const found = readRecord(recordPath(storageDir, displayKey), displayKey);
    return found ?? { values: cloneDefaults(), sent: cloneSent() };
  }

  return Object.freeze({
    async read(displayKey) {
      try {
        const current = load(displayKey);
        return okState(current.values, current.sent);
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },

    async saveGroup(displayKey, group, values) {
      if (!Object.hasOwn(GROUP_FIELDS, group)) return failure('Invalid display color group.');
      const fields = GROUP_FIELDS[group];
      if (typeof displayKey !== 'string' || displayKey.length === 0 || displayKey.length > 4096) return failure('A valid stable display key is required.');
      if (!values || typeof values !== 'object' || Array.isArray(values)
        || Object.keys(values).length !== fields.length
        || Object.keys(values).some((key) => !fields.includes(key))) return failure('Display color group values are invalid.');
      try {
        for (const key of fields) validateValue(key, values[key]);
        return await enqueue(displayKey, () => {
          const current = load(displayKey);
          const next = { values: { ...current.values }, sent: cloneSent(current.sent) };
          for (const key of fields) next.values[key] = values[key];
          next.sent[group] = true;
          if (memoryOnly) memory.set(displayKey, next);
          else {
            ensureSafeDirectory(storageDir, true);
            atomicWrite(recordPath(storageDir, displayKey), { version: 1, displayKey, values: next.values, sent: next.sent });
          }
          return okState(next.values, next.sent);
        });
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
