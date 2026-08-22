// Arc Power - M42 Acer Predator BiFrost packaged apply bridge.
//
// This module deliberately owns no renderer or routing policy.  The caller
// supplies the one-time interactive/opt-in gates and a physical target.  The
// bridge is a defensive transaction: every unavailable Windows primitive is
// an explicit refusal, never a guessed native call and never a fake success.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { TextDecoder } from 'node:util';

export const ACER_PACKAGE_FULL_NAME = 'ULICTekInc.StereoBox_1.0.172.0_x64__nt9dgb7efx6bt';
export const ACER_PACKAGE_VERSION = '1.0.172.0';
export const ACER_PACKAGE_FAMILY_NAME = 'ULICTekInc.StereoBox_nt9dgb7efx6bt';
export const ACER_PACKAGE_APP_ID = 'App';
export const ACER_PACKAGE_IDENTITY = `${ACER_PACKAGE_FAMILY_NAME}!${ACER_PACKAGE_APP_ID}`;
export const ACER_PACKAGE_SHELL_IDENTITY = `shell:AppsFolder\\${ACER_PACKAGE_IDENTITY}`;
export const ACER_PROFILE_XML_NAME = 'Predator BiFrost Intelr ArcT A770.xml';
export const ACER_A770_PCI_DEVICE_ID = '0x000056a0';
export const ACER_ORDINARY_POWER_THRESHOLD_W = 252;
export const ACER_JOURNAL_VERSION = 1;
const ACER_JOURNAL_PHASES = Object.freeze([
  'prepared',
  'settings-replaced',
  'xml-replaced',
  'activation-pending',
  'activated',
  'rollback-activation-pending',
  'rollback-activated',
  'recovery-required',
  'route-recovery',
  'committed',
]);
const ACER_HARDWARE_MUTATING_PHASES = Object.freeze([
  'activation-pending',
  'activated',
  'rollback-activation-pending',
  'rollback-activated',
  'recovery-required',
  'committed',
  'route-recovery',
]);

export const ACER_BRIDGE_ERROR_CODES = Object.freeze({
  UNSUPPORTED_PLATFORM: 'unsupported-platform',
  UNSUPPORTED: 'unsupported',
  NOT_OPTED_IN: 'not-opted-in',
  NON_INTERACTIVE: 'non-interactive',
  INVALID_REQUEST: 'invalid-request',
  DEVICE_NOT_SUPPORTED: 'device-not-supported',
  STOCK_THRESHOLD: 'stock-threshold',
  PACKAGE_NOT_FOUND: 'package-not-found',
  PACKAGE_VERSION_MISMATCH: 'package-version-mismatch',
  PACKAGE_IDENTITY_AMBIGUOUS: 'package-identity-ambiguous',
  PROCESS_SNAPSHOT_FAILED: 'process-snapshot-failed',
  ALREADY_RUNNING: 'already-running',
  UNKNOWN_PROCESS: 'unknown-process',
  LOCK_BUSY: 'lock-busy',
  LOCK_FAILED: 'lock-failed',
  JOURNAL_INVALID: 'journal-invalid',
  RECOVERY_REQUIRED: 'recovery-required',
  FILE_UNAVAILABLE: 'file-unavailable',
  FILE_IDENTITY: 'file-identity',
  FILE_MODIFIED: 'file-modified',
  FILE_PARSE_FAILED: 'file-parse-failed',
  FILE_SHAPE_AMBIGUOUS: 'file-shape-ambiguous',
  WRITE_FAILED: 'write-failed',
  ACTIVATION_FAILED: 'activation-failed',
  WINDOW_FAILED: 'window-failed',
  TERMINATION_FAILED: 'termination-failed',
  READBACK_UNAVAILABLE: 'readback-unavailable',
  READBACK_TIMEOUT: 'readback-timeout',
  READBACK_MISMATCH: 'readback-mismatch',
  STATE_CHANGED: 'state-changed',
  ROLLBACK_FAILED: 'rollback-failed',
  RESTORE_FAILED: 'restore-failed',
});

const C = ACER_BRIDGE_ERROR_CODES;
const PACKAGE_ROOT = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DEFAULT_SETTINGS_PATH = path.join(PACKAGE_ROOT, 'PredatorBifrost', 'Settings.json');
const DEFAULT_XML_PATH = path.join(PACKAGE_ROOT, 'PredatorBifrost', 'Presets', ACER_PROFILE_XML_NAME);
const DEFAULT_JOURNAL_PATH = path.join(PACKAGE_ROOT, 'ArcPower', 'acer-packaged-bridge.journal.json');
const DEFAULT_LOCK_PATH = path.join(PACKAGE_ROOT, 'ArcPower', 'acer-packaged-bridge.lock');

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (v) => (v instanceof Error ? v.message : String(v));
const clone = (value) => {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
};
const jsonStable = (value) => JSON.stringify(value);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const asBuffer = (value) => Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value ?? '');
const normalizePci = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return `0x${value.toString(16).padStart(8, '0')}`;
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(s)) return null;
  return `0x${s.slice(2).padStart(8, '0')}`;
};
const escapedXml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const moduleRequire = createRequire(import.meta.url);
let saxParser = null;
try { saxParser = moduleRequire('sax').parser; } catch {}
function wellFormedXml(value) {
  if (typeof value !== 'string' || value.includes('\u0000') || typeof saxParser !== 'function') return false;
  let error = null;
  try {
    const parser = saxParser(true, { trim: false, normalize: false });
    parser.onerror = (err) => { error = err; parser.resume(); };
    parser.write(value).close();
  } catch (err) { error = err; }
  return error === null;
}
function parseJsonUnique(source) {
  if (typeof source !== 'string') throw new Error('JSON source must be text');
  let index = 0;
  const fail = (message) => { throw new Error(`${message} at byte ${index}`); };
  const skip = () => {
    while (index < source.length && /\s/.test(source[index])) index++;
  };
  const stringValue = () => {
    if (source[index] !== '"') fail('expected JSON string');
    const start = index;
    index++;
    while (index < source.length) {
      const ch = source[index++];
      if (ch === '\\') {
        if (index >= source.length) fail('incomplete JSON escape');
        index++;
      } else if (ch === '"') {
        try { return JSON.parse(source.slice(start, index)); } catch { fail('invalid JSON string'); }
      } else if (ch < ' ') fail('unescaped JSON control character');
    }
    fail('unterminated JSON string');
  };
  const numberValue = () => {
    const match = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) fail('invalid JSON number');
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail('JSON number is not finite');
    return value;
  };
  const value = () => {
    skip();
    const ch = source[index];
    if (ch === '{') {
      index++;
      const object = Object.create(null);
      const keys = new Set();
      skip();
      if (source[index] === '}') { index++; return object; }
      while (index < source.length) {
        skip();
        const key = stringValue();
        const folded = key.toLowerCase();
        if (keys.has(folded)) fail(`duplicate JSON object key '${key}'`);
        keys.add(folded);
        skip();
        if (source[index++] !== ':') fail('expected JSON object colon');
        object[key] = value();
        skip();
        if (source[index] === '}') { index++; return object; }
        if (source[index++] !== ',') fail('expected JSON object comma');
      }
      fail('unterminated JSON object');
    }
    if (ch === '[') {
      index++;
      const array = [];
      skip();
      if (source[index] === ']') { index++; return array; }
      while (index < source.length) {
        array.push(value());
        skip();
        if (source[index] === ']') { index++; return array; }
        if (source[index++] !== ',') fail('expected JSON array comma');
      }
      fail('unterminated JSON array');
    }
    if (ch === '"') return stringValue();
    if (source.startsWith('true', index)) { index += 4; return true; }
    if (source.startsWith('false', index)) { index += 5; return false; }
    if (source.startsWith('null', index)) { index += 4; return null; }
    if (ch === '-' || (ch >= '0' && ch <= '9')) return numberValue();
    fail('invalid JSON value');
  };
  const parsed = value();
  skip();
  if (index !== source.length) fail('trailing JSON content');
  return parsed;
}


function result(requestedW, errorCode, message, extra = {}) {
  return {
    ok: false,
    requestedW,
    ...(errorCode ? { errorCode } : {}),
    ...(message ? { message } : {}),
    ...extra,
  };
}

function success(requestedW, observed, extra = {}) {
  return { ok: true, requestedW, readBackEqual: true, observed, ...extra };
}

function decodeBytes(raw) {
  const bytes = asBuffer(raw);
  let encoding = 'utf8';
  let bom = Buffer.alloc(0);
  let body = bytes;
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    encoding = 'utf8'; bom = bytes.subarray(0, 3); body = bytes.subarray(3);
  } else if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    encoding = 'utf16le'; bom = bytes.subarray(0, 2); body = bytes.subarray(2);
    if (body.length % 2 !== 0) throw new Error('UTF-16LE payload has an incomplete code unit');
  } else if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    encoding = 'utf16be'; bom = bytes.subarray(0, 2);
    const encoded = bytes.subarray(2);
    if (encoded.length % 2 !== 0) throw new Error('UTF-16BE payload has an incomplete code unit');
    body = Buffer.alloc(encoded.length);
    for (let i = 0; i < encoded.length; i += 2) { body[i] = encoded[i + 1]; body[i + 1] = encoded[i]; }
  }
  let decoded;
  try {
    decoded = new TextDecoder(encoding === 'utf8' ? 'utf-8' : 'utf-16le', { fatal: true }).decode(body);
  } catch (error) {
    throw new Error(`invalid ${encoding} payload: ${text(error)}`);
  }
  const eol = decoded.includes('\r\n') ? '\r\n' : (decoded.includes('\r') ? '\r' : '\n');
  return { encoding, bom, eol, text: decoded };
}

function encodeBytes(decoded, value) {
  const normalized = String(value).replace(/\r\n|\r|\n/g, decoded.eol);
  let body;
  if (decoded.encoding === 'utf16be') {
    const le = Buffer.from(normalized, 'utf16le');
    body = Buffer.alloc(le.length);
    for (let i = 0; i < le.length; i += 2) { body[i] = le[i + 1]; body[i + 1] = le[i]; }
  } else body = Buffer.from(normalized, decoded.encoding === 'utf16le' ? 'utf16le' : 'utf8');
  return Buffer.concat([decoded.bom, body]);
}

function pathFind(root, predicate, found = []) {
  if (!root || typeof root !== 'object') return found;
  if (predicate(root)) found.push(root);
  if (Array.isArray(root)) for (const item of root) pathFind(item, predicate, found);
  else for (const value of Object.values(root)) pathFind(value, predicate, found);
  return found;
}

function keyOf(object, wanted) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return null;
  return Object.keys(object).find((key) => key.toLowerCase() === wanted.toLowerCase()) ?? null;
}

function setTag(fragment, tag, value) {
  const re = new RegExp(`(<${tag}\\b[^>]*>)([\\s\\S]*?)(</${tag}>)`, 'gi');
  const matches = [...fragment.matchAll(re)];
  if (matches.length !== 1) return { ok: false, reason: `${tag} occurs ${matches.length} times` };
  return { ok: true, text: fragment.replace(re, `$1${escapedXml(value)}$3`) };
}

function getTag(fragment, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = fragment.match(re);
  return match ? match[1].trim() : null;
}
const ACER_PROFILE_REQUIRED_TAGS = Object.freeze([
  'PFMode',
  'CoreBoostClock',
  'MEMBoostClock',
  'GPUVoltageLimit',
  'PowerLimit',
  'TemperatureLimit',
  'TemperatureScale',
  'FanSpeedOption',
  'AeroBlade',
  'FrostBlade',
  'LinkSpeed',
]);
function hasCompleteProfileSchema(fragment) {
  return ACER_PROFILE_REQUIRED_TAGS.every((tag) => {
    const matches = [...String(fragment).matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'))];
    return matches.length === 1;
  });
}

function profileNodes(xml) {
  const re = /<profile\b[^>]*\bname\s*=\s*(["'])(.*?)\1[^>]*>[\s\S]*?<\/profile>/gi;
  return [...xml.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length, name: m[2], text: m[0] }));
}

function selectedProfileName(settings) {
  const homes = pathFind(settings, (node) => keyOf(node, 'HomeSettings') !== null);
  const home = homes.length === 1 ? homeValue(homes[0]) : null;
  if (!home || typeof home !== 'object') return null;
  const key = keyOf(home, 'OverClockingId');
  const value = key ? home[key] : null;
  if (Array.isArray(value)) return value.length === 1 && typeof value[0] === 'string' ? value[0] : null;
  return typeof value === 'string' ? value : null;
}

function homeValue(wrapper) {
  const key = keyOf(wrapper, 'HomeSettings');
  return key ? wrapper[key] : null;
}

function profileList(settings, selected) {
  const candidates = pathFind(settings, (node) => {
    if (!Array.isArray(node) || node.length === 0) return false;
    return node.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
      && node.some((entry) => Object.values(entry).some((v) => typeof v === 'string' && v === selected));
  });
  return { value: candidates.length === 1 ? candidates[0] : null, ambiguous: candidates.length > 1 };
}

function profileNameKey(profile) { return keyOf(profile, 'name') ?? keyOf(profile, 'id') ?? keyOf(profile, 'ProfileName') ?? null; }
function selectedTargetMatches(settings, physicalTarget) {
  const targetIndex = Number.isInteger(physicalTarget?.displayCardIndex)
    ? physicalTarget.displayCardIndex
    : Number.isInteger(physicalTarget?.index) ? physicalTarget.index : null;
  const fields = pathFind(settings, (node) => keyOf(node, 'DisplayCardIndex') !== null);
  // Acer's profile is card-indexed. An absent index is ambiguous, never a
  // wildcard: mutating the hard-coded A770 document without this proof could
  // edit another adapter's profile.
  if (fields.length !== 1 || targetIndex === null) return false;
  const key = keyOf(fields[0], 'DisplayCardIndex');
  const value = Number(fields[0][key]);
  return Number.isInteger(value) && value === targetIndex;
}
function setNestedScalar(profile, wanted, value) {
  const found = pathFind(profile, (node) => keyOf(node, wanted) !== null);
  if (found.length !== 1) return false;
  found[0][keyOf(found[0], wanted)] = value;
  return true;
}
const PROFILE_CORE_VOLTAGE_TAGS = ['CoreBoostClock', 'MEMBoostClock', 'GPUVoltageLimit', 'VoltageOffset'];
function profileCoreVoltageOf(rawText, selected) {
  const candidates = profileNodes(rawText).filter((node) => node.name === selected);
  if (candidates.length !== 1) return null;
  const values = {};
  for (const tag of PROFILE_CORE_VOLTAGE_TAGS) {
    const value = getTag(candidates[0].text, tag);
    if (value !== null) values[tag] = value;
  }
  return Object.keys(values).length > 0 ? values : null;
}
function hasUsableAbsoluteCoreVoltage(coreVoltage) {
  if (!coreVoltage || typeof coreVoltage !== 'object' || Array.isArray(coreVoltage)) return false;
  const fields = ['CoreBoostClock', 'MEMBoostClock', 'GPUVoltageLimit', 'VoltageOffset'];
  const present = fields.filter((field) => field in coreVoltage);
  if (present.length === 0) return false;
  return present.every((field) => {
    const raw = String(coreVoltage[field]).trim();
    if (!/^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(raw)) return false;
    return Number.isFinite(Number(raw.replace(',', '.')));
  });
}

function applyLiveCoreVoltage(profile, coreVoltage) {
  if (!coreVoltage || typeof coreVoltage !== 'object') return { ok: false, reason: 'live core/voltage baseline is unavailable' };
  // The driver state normally exposes offsets, while Acer's profile stores
  // absolute scalar fields. Only explicit Acer-shaped baseline fields may be
  // copied; an offset must never be interpreted as an absolute clock/voltage.
  const aliases = {
    CoreBoostClock: ['CoreBoostClock'],
    coreBoostClockMhz: ['CoreBoostClock'],
    MEMBoostClock: ['MEMBoostClock'],
    memBoostClockMhz: ['MEMBoostClock'],
    GPUVoltageLimit: ['GPUVoltageLimit'],
    gpuVoltageLimit: ['GPUVoltageLimit'],
    VoltageOffset: ['VoltageOffset'],
  };
  const liveOffsetKeys = new Set(['gpuFreqOffsetMhz', 'gpuVoltOffsetV', 'gpuCoreClockMhz', 'gpuVoltageV', 'voltageV']);
  for (const [source, value] of Object.entries(coreVoltage)) {
    const wanted = aliases[source];
    if (!wanted && liveOffsetKeys.has(source)) {
      if (value !== 0) return { ok: false, reason: `live core/voltage offset ${source} cannot be represented as an Acer absolute field` };
      // A zero driver offset is an explicit no-op; do not reinterpret it as
      // an Acer absolute clock/voltage value.
      continue;
    }
    if (!wanted) return { ok: false, reason: `live core/voltage field ${source} cannot be represented safely` };
    const key = wanted.find((name) => keyOf(profile, name) !== null);
    if (!key || !setNestedScalar(profile, key, value)) {
      return { ok: false, reason: `live core/voltage field ${source} cannot be represented` };
    }
  }
  return { ok: true };
}

function transformSettings(settings, selected, bridgeName, requestedW, temperatureC, coreVoltage) {
  const out = clone(settings);
  const homes = pathFind(out, (node) => keyOf(node, 'HomeSettings') !== null);
  if (homes.length !== 1) return { ok: false, reason: 'Settings.json does not contain exactly one HomeSettings object' };
  const home = homeValue(homes[0]);
  const idKey = keyOf(home, 'OverClockingId');
  if (!idKey || !Array.isArray(home[idKey]) || home[idKey].length !== 1 || typeof home[idKey][0] !== 'string') {
    return { ok: false, reason: 'HomeSettings.OverClockingId is not a single selected profile' };
  }
  if (selected && home[idKey][0] !== selected) return { ok: false, reason: 'selected profile changed while reading Settings.json' };
  const boostKey = keyOf(home, 'EnableCoreBoost');
  if (!boostKey || !['boolean', 'number'].includes(typeof home[boostKey])) {
    return { ok: false, reason: 'HomeSettings.EnableCoreBoost is missing or ambiguous' };
  }
  home[boostKey] = typeof home[boostKey] === 'boolean' ? false : 0;
  // Current Acer Settings.json stores profiles in the mapped XML, not in the
  // settings document. Preserve support for fixtures that inline a profile
  // list, but never require a list that the installed package does not have.
  const profile = profileList(out, selected || home[idKey][0]);
  if (profile.ambiguous) return { ok: false, reason: 'Settings.json contains multiple profile lists for the selected profile' };
  const list = profile.value;
  if (list) {
    const selectedEntry = list.filter((entry) => Object.values(entry).some((value) => value === (selected || home[idKey][0])));
    if (selectedEntry.length !== 1) return { ok: false, reason: 'Settings.json selected profile is ambiguous' };
    const bridgeProfile = clone(selectedEntry[0]);
    const nameKey = profileNameKey(bridgeProfile);
    if (!nameKey) return { ok: false, reason: 'Settings.json selected profile has no stable name/id field' };
    bridgeProfile[nameKey] = bridgeName;
    if (!setNestedScalar(bridgeProfile, 'PFMode', 'CustomUser')) return { ok: false, reason: 'Acer JSON profile lacks PFMode' };
    if (!setNestedScalar(bridgeProfile, 'PowerLimit', requestedW)) return { ok: false, reason: 'Acer JSON profile lacks PowerLimit' };
    if (!setNestedScalar(bridgeProfile, 'TemperatureLimit', temperatureC)) return { ok: false, reason: 'Acer JSON profile lacks TemperatureLimit' };
    if (!setNestedScalar(bridgeProfile, 'FanSpeedOption', 'Auto')) return { ok: false, reason: 'Acer JSON profile lacks FanSpeedOption' };
    const live = applyLiveCoreVoltage(bridgeProfile, coreVoltage);
    if (!live.ok) return live;
    const enableBoostLocations = pathFind(bridgeProfile, (node) => keyOf(node, 'EnableCoreBoost') !== null);
    if (enableBoostLocations.length !== 1) return { ok: false, reason: 'Acer JSON profile lacks a unique EnableCoreBoost field' };
    enableBoostLocations[0][keyOf(enableBoostLocations[0], 'EnableCoreBoost')] = false;
    list.push(bridgeProfile);
  }
  home[idKey][0] = bridgeName;
  return { ok: true, value: out };
}
function transformXml(rawText, selected, bridgeName, requestedW, temperatureC, coreVoltage) {
  const nodes = profileNodes(rawText);
  const candidates = nodes.filter((node) => node.name === selected && getTag(node.text, 'PowerLimit') !== null);
  if (candidates.length !== 1) return { ok: false, reason: `A770 XML has ${candidates.length} matching editable profiles` };
  let fragment = candidates[0].text;
  if (!hasCompleteProfileSchema(fragment)) return { ok: false, reason: 'A770 XML selected profile has an incomplete schema' };
  const nameRe = /(\bname\s*=\s*)(["'])(.*?)\2/i;
  if (!nameRe.test(fragment)) return { ok: false, reason: 'A770 XML target has no profile name attribute' };
  fragment = fragment.replace(nameRe, `$1$2${escapedXml(bridgeName)}$2`);
  for (const [tag, value] of [['PFMode', 'CustomUser'], ['PowerLimit', requestedW], ['TemperatureLimit', temperatureC], ['FanSpeedOption', 'Auto']]) {
    const changed = setTag(fragment, tag, value);
    if (!changed.ok) return { ok: false, reason: `Acer XML ${changed.reason}` };
    fragment = changed.text;
  }
  const aliases = {
    CoreBoostClock: ['CoreBoostClock'],
    coreBoostClockMhz: ['CoreBoostClock'],
    MEMBoostClock: ['MEMBoostClock'],
    memBoostClockMhz: ['MEMBoostClock'],
    GPUVoltageLimit: ['GPUVoltageLimit'],
    gpuVoltageLimit: ['GPUVoltageLimit'],
    VoltageOffset: ['VoltageOffset'],
  };
  if (!coreVoltage || typeof coreVoltage !== 'object') {
    return { ok: false, reason: 'live core/voltage baseline is unavailable' };
  }
  const liveOffsetKeys = new Set(['gpuFreqOffsetMhz', 'gpuVoltOffsetV', 'gpuCoreClockMhz', 'gpuVoltageV', 'voltageV']);
  for (const [source, value] of Object.entries(coreVoltage)) {
    const candidatesForField = aliases[source];
    if (!candidatesForField && liveOffsetKeys.has(source)) {
      if (value !== 0) return { ok: false, reason: `live core/voltage offset ${source} cannot be represented as an Acer absolute field` };
      // A zero driver offset is an explicit no-op; do not reinterpret it as
      // an Acer absolute clock/voltage value.
      continue;
    }
    if (!candidatesForField) return { ok: false, reason: `live core/voltage field ${source} cannot be represented safely` };
    const tag = candidatesForField.find((candidate) => getTag(fragment, candidate) !== null);
    if (!tag) return { ok: false, reason: `Acer XML cannot represent live core/voltage field ${source}` };
    const changed = setTag(fragment, tag, value);
    if (!changed.ok) return { ok: false, reason: `Acer XML ${changed.reason}` };
    fragment = changed.text;
  }
  if (!hasCompleteProfileSchema(fragment)) return { ok: false, reason: 'generated Acer XML profile has an incomplete schema' };
  // Keep the user's selected profile intact and append a complete clone.
  const value = rawText.slice(0, candidates[0].end) + fragment + rawText.slice(candidates[0].end);
  const generated = profileNodes(value);
  if (generated.filter((node) => node.name === selected).length !== 1
    || generated.filter((node) => node.name === bridgeName).length !== 1) {
    return { ok: false, reason: 'generated Acer XML profile references are ambiguous' };
  }
  return { ok: true, text: value };
}

function envelope(payload) {
  const body = jsonStable(payload);
  return { version: ACER_JOURNAL_VERSION, integrity: sha256(Buffer.from(body)), payload };
}

function validateEnvelope(value) {
  if (!value || value.version !== ACER_JOURNAL_VERSION || !value.payload || typeof value.integrity !== 'string') return null;
  const body = jsonStable(value.payload);
  return value.integrity === sha256(Buffer.from(body)) ? value.payload : null;
}

function normalizeSnapshot(value) {
  const list = Array.isArray(value) ? value : (Array.isArray(value?.processes) ? value.processes : (Array.isArray(value?.pids) ? value.pids : null));
  if (!list) return null;
  const out = [];
  for (const item of list) {
    const pid = typeof item === 'number' ? item : item?.pid;
    if (!Number.isInteger(pid) || pid <= 0) return null;
    out.push(typeof item === 'number' ? { pid } : { ...item, pid });
  }
  return out;
}
function creationTimeMs(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const dmtf = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,6}))?([+-])(\d{3})$/);
  if (dmtf) {
    const fraction = Number(`0.${dmtf[7] ?? '0'}`) * 1000;
    const utc = Date.UTC(Number(dmtf[1]), Number(dmtf[2]) - 1, Number(dmtf[3]), Number(dmtf[4]), Number(dmtf[5]), Number(dmtf[6]), Math.floor(fraction));
    const offsetMinutes = Number(dmtf[9]) * (dmtf[8] === '-' ? -1 : 1);
    return utc - offsetMinutes * 60_000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function excludePreexistingBrokers(list, activationStartedAt) {
  return list.filter((item) => {
    if (item?.processKind !== 'owned-broker') return true;
    const created = creationTimeMs(item.creationDate);
    return created === null || created >= activationStartedAt;
  });
}
function pairOf(value) {
  if (!value || typeof value !== 'object'
    || !finite(value.sustainedW) || !finite(value.burstW)) return null;
  return { sustainedW: value.sustainedW, burstW: value.burstW };
}
function bridgeProfileName(selected, requestedW) {
  const safeSelected = typeof selected === 'string' && selected.length > 0 ? selected : 'AcerProfile';
  const safePower = String(requestedW).replace(/[^0-9A-Za-z_-]/g, '_');
  return `${safeSelected}__ArcPower_${safePower}W`;
}
function verificationOk(value) {
  return value === true || value?.ok === true;
}

function equalPair(a, b) { return !!a && !!b && a.sustainedW === b.sustainedW && a.burstW === b.burstW; }


export function resolveAcerPackagedHelper({ modulePath = fileURLToPath(import.meta.url), exists = fs.existsSync } = {}) {
  const dir = path.dirname(modulePath);
  const candidates = /app\.asar[\\/]/i.test(dir)
    ? [
        dir.replace(/app\.asar/i, 'app.asar.unpacked') + path.sep + 'acer-packaged-helper.cjs',
        dir.replace(/app\.asar/i, 'app.asar.unpacked') + path.sep + 'backend' + path.sep + 'presentmon' + path.sep + 'acer-packaged-helper.cjs',
      ]
    : [
        path.join(dir, 'acer-packaged-helper.cjs'),
        path.join(dir, 'backend', 'presentmon', 'acer-packaged-helper.cjs'),
      ];
  try { return candidates.find((candidate) => exists(candidate)) ?? null; } catch { return null; }
}

export function createAcerPackagedBridge(deps = {}) {
  const api = deps.fs?.promises ?? deps.fs ?? fs.promises;
  const platform = deps.platform ?? process.platform;
  const processApi = deps.process ?? process;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? sleepDefault;
  const log = deps.log ?? (() => {});
  const settingsPath = deps.settingsPath ?? DEFAULT_SETTINGS_PATH;
  const xmlPath = deps.xmlPath ?? DEFAULT_XML_PATH;
  const journalPath = deps.journalPath ?? DEFAULT_JOURNAL_PATH;
  const lockPath = deps.lockPath ?? DEFAULT_LOCK_PATH;
  let packageBridge = deps.packageBridge ?? deps.helper ?? null;
  if (!packageBridge) {
    try {
      const helperPath = resolveAcerPackagedHelper();
      if (helperPath) packageBridge = createRequire(import.meta.url)(helperPath);
    } catch { packageBridge = null; }
  }
  const activate = packageBridge?.activate ?? deps.activate;
  let active = false;
  let lockHandle = null;
  let lockNonce = null;
  let orphanedLockNonce = null;
  let reservationTimer = null;
  let reservationExpired = false;
  let recoveryRequired = false;
  let retainedRouteRecovery = null;
  const consumedContextTokens = new Set();
  const call = async (fn, ...args) => {
    if (typeof fn !== 'function') return undefined;
    return await fn(...args);
  };
  const verifyAbsoluteCoreVoltage = async ({ baseline, deviceId, deviceKey, physicalTarget }) => {
    const expected = baseline?.coreVoltageProfile;
    if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.keys(expected).length === 0) {
      return { ok: false, message: 'Acer absolute core/voltage profile baseline is unavailable' };
    }
    if (typeof deps.readAcerCoreVoltage !== 'function') {
      return { ok: false, message: 'Acer absolute core/voltage readback hook is unavailable' };
    }
    let actual;
    try { actual = await deps.readAcerCoreVoltage({ deviceId, deviceKey, physicalTarget, expected: clone(expected) }); } catch (error) {
      return { ok: false, message: text(error) };
    }
    if (actual?.ok === false) return actual;
    actual = actual?.value ?? actual;
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return { ok: false, message: 'Acer absolute core/voltage readback was unavailable' };
    const same = Object.entries(expected).every(([key, value]) => {
      if (!(key in actual)) return false;
      const left = Number(String(value).trim().replace(',', '.'));
      const right = Number(String(actual[key]).trim().replace(',', '.'));
      return Number.isFinite(left) && Number.isFinite(right) ? left === right : String(value).trim() === String(actual[key]).trim();
    });
    return same ? { ok: true } : { ok: false, message: 'Acer absolute core/voltage readback mismatch or omission' };
  };
  const mkdirFor = async (filePath) => {
    const mkdir = api.mkdir ?? api.promises?.mkdir;
    if (mkdir) await mkdir(path.dirname(filePath), { recursive: true });
  };
  const readRaw = async (filePath) => {
    const read = api.readFile ?? api.promises?.readFile;
    if (!read) throw new Error('filesystem readFile unavailable');
    return asBuffer(await read(filePath));
  };
  const readAbsoluteCoreVoltageForTarget = async ({ deviceId, deviceKey = null, physicalTarget } = {}) => {
    if (!physicalTarget || physicalTarget.synthetic === true || physicalTarget.backendKind === 'os'
      || physicalTarget.identityAmbiguous === true || physicalTarget.displayCardIndex !== 0) {
      return { ok: false, errorCode: C.DEVICE_NOT_SUPPORTED, message: 'selected Acer target physical proof is unavailable' };
    }
    if (typeof deps.assertDeviceTarget === 'function') {
      await deps.assertDeviceTarget(deviceId, deviceKey, physicalTarget);
    }
    await assertNoReparse(settingsPath);
    await assertNoReparse(xmlPath);
    const settingsDecoded = decodeBytes(await readRaw(settingsPath));
    const xmlDecoded = decodeBytes(await readRaw(xmlPath));
    const settings = parseJsonUnique(settingsDecoded.text);
    const selected = selectedProfileName(settings);
    if (!selected || !selectedTargetMatches(settings, physicalTarget)) {
      return { ok: false, errorCode: C.DEVICE_NOT_SUPPORTED, message: 'Acer package files do not map to the selected physical target' };
    }
    const value = profileCoreVoltageOf(xmlDecoded.text, selected);
    return hasUsableAbsoluteCoreVoltage(value)
      ? { ok: true, value }
      : { ok: false, errorCode: C.READBACK_UNAVAILABLE, message: 'Acer selected profile absolute core/voltage fields are unavailable' };
  };
  const verifyAcerAbsolute = async (args = {}) => {
    if (typeof deps.verifyAcerAbsoluteCoreVoltage !== 'function') {
      return { ok: false, errorCode: C.UNSUPPORTED, message: 'Acer absolute core/voltage verifier is unavailable' };
    }
    return deps.verifyAcerAbsoluteCoreVoltage({
      ...args,
      readAbsoluteCoreVoltageForTarget,
    });
  };
  const statRaw = async (filePath) => {
    const stat = api.stat ?? api.promises?.stat;
    if (!stat) throw new Error('filesystem stat unavailable');
    return await stat(filePath);
  };
  const assertNoReparse = async (filePath) => {
    const lstat = api.lstat ?? api.promises?.lstat;
    if (!lstat) throw new Error('filesystem lstat unavailable for reparse-point proof');
    const stats = await lstat(filePath);
    if ((typeof stats?.isSymbolicLink === 'function' && stats.isSymbolicLink())
      || (typeof stats?.isFile === 'function' && !stats.isFile())) {
      throw new Error(`${filePath} is a reparse point or not a regular file`);
    }
    return stats;
  };
  const writeAtomic = async (filePath, bytes, fileMetadata = null) => {
    try { await assertNoReparse(filePath); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const open = api.open ?? api.promises?.open;
    const rename = api.rename ?? api.promises?.rename;
    const writeFile = api.writeFile ?? api.promises?.writeFile;
    if (!rename || !open) throw new Error('filesystem atomic write unavailable');
    await mkdirFor(filePath);
    const temp = `${filePath}.acer-${crypto.randomUUID()}.tmp`;
    let fd = null;
    try {
      fd = await open(temp, 'wx');
      await assertNoReparse(temp);
      if (typeof fd.write === 'function') await fd.write(bytes, 0, bytes.length, 0);
      else if (writeFile) await writeFile(temp, bytes);
      else throw new Error('filesystem write unavailable');
      if (typeof fd.sync === 'function') await fd.sync();
    } finally { if (fd && typeof fd.close === 'function') await fd.close(); }
    if (fileMetadata) {
      try {
        const chmod = api.chmod ?? api.promises?.chmod;
        if (chmod && fileMetadata.mode !== undefined) await chmod(temp, fileMetadata.mode);
        const utimes = api.utimes ?? api.promises?.utimes;
        if (utimes && finite(fileMetadata.atimeMs) && finite(fileMetadata.mtimeMs)) {
          await utimes(temp, new Date(fileMetadata.atimeMs), new Date(fileMetadata.mtimeMs));
        }
        if (typeof deps.restoreFileMetadata !== 'function' || fileMetadata.metadata === null) {
          throw new Error('file metadata/ACL restore is unavailable');
        }
        const metadataResult = await deps.restoreFileMetadata(temp, fileMetadata.metadata);
        if (metadataResult?.ok !== true) throw new Error(metadataResult?.message ?? 'file metadata did not restore on temporary replacement');
      } catch (error) {
        try { const unlink = api.unlink ?? api.promises?.unlink; if (unlink) await unlink(temp); } catch {}
        throw error;
      }
    }
    try { await rename(temp, filePath); } catch (error) {
      try { const unlink = api.unlink ?? api.promises?.unlink; if (unlink) await unlink(temp); } catch {}
      throw error;
    }
  };
  const remove = async (filePath) => {
    const unlink = api.unlink ?? api.promises?.unlink;
    if (!unlink) throw new Error('filesystem unlink unavailable');
    try { await unlink(filePath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  };
  const readJournal = async () => {
    let raw;
    try { raw = await readRaw(journalPath); } catch (error) { if (error?.code === 'ENOENT') return { none: true }; throw error; }
    let parsed;
    try { parsed = parseJsonUnique(raw.toString('utf8')); } catch { return { invalid: true }; }
    const payload = validateEnvelope(parsed);
    const hashPattern = /^[0-9a-f]{64}$/i;
    const encodedBytesMatchHash = (encoded, expectedHash) => {
      if (typeof encoded !== 'string' || encoded.length === 0 || !hashPattern.test(expectedHash ?? '')) return false;
      try {
        const decoded = Buffer.from(encoded, 'base64');
        return decoded.length > 0 && sha256(decoded).toLowerCase() === expectedHash.toLowerCase();
      } catch {
        return false;
      }
    };
    const validFile = (file) => !!file
      && typeof file.path === 'string' && file.path.length > 0
      && typeof file.originalBytes === 'string' && file.originalBytes.length > 0
      && typeof file.originalHash === 'string' && hashPattern.test(file.originalHash)
      && encodedBytesMatchHash(file.originalBytes, file.originalHash)
      && (file.temporaryHash === null || (typeof file.temporaryHash === 'string' && hashPattern.test(file.temporaryHash)))
      && (file.rollbackTemporaryHash === undefined || file.rollbackTemporaryHash === null
        || (typeof file.rollbackTemporaryHash === 'string' && hashPattern.test(file.rollbackTemporaryHash)))
      && typeof file.replaced === 'boolean'
      && file.metadata && typeof file.metadata === 'object'
      && typeof file.metadata.sddl === 'string'
      && Number.isInteger(file.metadata.attributes)
      && typeof file.metadata.creationFileTime === 'string'
      && /^\d+$/.test(file.metadata.creationFileTime)
      && Number.isInteger(file.mode)
      && finite(file.atimeMs) && finite(file.mtimeMs);
    const validOwnedProcess = (item, ownerNonce) => !!item
      && Number.isInteger(item.pid) && item.pid > 0
      && item.ownerNonce === ownerNonce
      && typeof item.creationDate === 'string' && item.creationDate.length > 0
      && typeof item.executablePath === 'string' && item.executablePath.length > 0
      && item.packageFullName === ACER_PACKAGE_FULL_NAME;
    const hardwareOnly = payload?.phase === 'route-recovery';
    const filesValid = hardwareOnly
      ? Array.isArray(payload?.files) && payload.files.length === 0
      : Array.isArray(payload?.files)
        && payload.files.length === 2
        && new Set(payload.files.map((file) => file?.path)).size === 2
        && payload.files.every((file) => file?.path === settingsPath || file?.path === xmlPath)
        && payload.files.every((file) => validFile(file));
    if (!payload
      || !filesValid
      || payload.packageFullName !== ACER_PACKAGE_FULL_NAME
      || payload.packageVersion !== ACER_PACKAGE_VERSION
      || typeof payload.ownerNonce !== 'string' || payload.ownerNonce.length < 16
      || !Number.isInteger(payload.ownerPid) || payload.ownerPid <= 0
      || !Number.isInteger(payload.deviceId) || payload.deviceId < 0
      || !finite(payload.requestedW)
      || !payload.physicalTarget || typeof payload.physicalTarget !== 'object' || Array.isArray(payload.physicalTarget)
      || !payload.baseline || typeof payload.baseline !== 'object' || Array.isArray(payload.baseline)
      || !Array.isArray(payload.ownedPids)
      || !ACER_JOURNAL_PHASES.includes(payload.phase)
      || payload.ownedPids.some((item) => !validOwnedProcess(item, payload.ownerNonce))
      || (!['activated', 'rollback-activated', 'recovery-required', 'route-recovery'].includes(payload.phase) && payload.ownedPids.length !== 0)) return { invalid: true };
    return { payload };
  };
  const writeJournal = async (payload) => writeAtomic(journalPath, Buffer.from(JSON.stringify(envelope(payload), null, 2), 'utf8'));
  const snapshot = async () => {
    try {
      const fn = packageBridge?.snapshotPackageProcesses ?? deps.snapshotPackageProcesses;
      if (typeof fn !== 'function') return null;
      const value = await call(fn, ACER_PACKAGE_FULL_NAME);
      const normalized = normalizeSnapshot(value);
      if (!normalized) return null;
      if (normalized.some((item) => typeof item.creationDate !== 'string' || item.creationDate.length === 0 || typeof item.executablePath !== 'string' || item.executablePath.length === 0 || item.packageFullName !== ACER_PACKAGE_FULL_NAME)) return null;
      return normalized;
    } catch { return null; }
  };
  const packageInstalled = async () => {
    try {
      const fn = packageBridge?.isInstalled ?? deps.isInstalled;
      if (typeof fn !== 'function') return { ok: false, errorCode: C.UNSUPPORTED, message: 'the fixed Acer package helper is unavailable' };
      const value = await fn(ACER_PACKAGE_FULL_NAME, ACER_PACKAGE_VERSION);
      const installed = value?.installed === true && value?.fullName === ACER_PACKAGE_FULL_NAME
        && value?.version === ACER_PACKAGE_VERSION && typeof value?.installLocation === 'string' && value.installLocation.length > 0;
      if (!installed) return { ok: false, errorCode: value?.version ? C.PACKAGE_VERSION_MISMATCH : C.PACKAGE_NOT_FOUND, message: 'the exact Acer package identity, version, and install location are required' };
      return { ok: true, value };
    } catch (error) { return { ok: false, errorCode: C.PACKAGE_NOT_FOUND, message: text(error) }; }
  };
  const pidLiveness = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0 || typeof processApi.kill !== 'function') return null;
    try {
      processApi.kill(pid, 0);
      return true;
    } catch (error) {
      if (error?.code === 'ESRCH') return false;
      if (error?.code === 'EPERM') return true;
      return null;
    }
  };
  const acquire = async (owner, staleReclaimed = false) => {
    const open = api.open ?? api.promises?.open;
    if (!open) return { ok: false, errorCode: C.LOCK_FAILED, message: 'cross-process lock primitive unavailable' };
    let handle = null;
    try {
      await mkdirFor(lockPath);
      handle = await open(lockPath, 'wx');
      const body = Buffer.from(JSON.stringify(owner), 'utf8');
      if (typeof handle.write === 'function') await handle.write(body, 0, body.length, 0);
      else if (typeof api.writeFile === 'function') await api.writeFile(lockPath, body);
      if (typeof handle.sync === 'function') await handle.sync();
      lockHandle = handle;
      lockNonce = owner.ownerNonce;
      orphanedLockNonce = null;
      return { ok: true };
    } catch (error) {
      if (error?.code === 'EEXIST' && !staleReclaimed) {
        try {
          const raw = await readRaw(lockPath);
          const existing = parseJsonUnique(raw.toString('utf8'));
          const reclaimOwned = Number.isInteger(existing?.pid)
            && existing.pid === processApi.pid
            && existing.ownerNonce === orphanedLockNonce;
          const reclaimDead = Number.isInteger(existing?.pid)
            && existing.pid > 0
            && pidLiveness(existing.pid) === false;
          if (reclaimOwned || reclaimDead) {
            await remove(lockPath);
            if (reclaimOwned) orphanedLockNonce = null;
            return acquire(owner, true);
          }
        } catch { /* ownership is not proven stale; retain the lock */ }
      }
      let removed = false;
      if (handle) {
        try {
          const raw = await readRaw(lockPath);
          const current = parseJsonUnique(raw.toString('utf8'));
          if (current?.ownerNonce === owner.ownerNonce) {
            await remove(lockPath);
            removed = true;
          }
        } catch { /* ownership is unproven: retain the lock */ }
      }
      try { if (handle?.close) await handle.close(); } catch {}
      if (!removed && handle) {
        try {
          const raw = await readRaw(lockPath);
          const current = parseJsonUnique(raw.toString('utf8'));
          if (current?.ownerNonce === owner.ownerNonce) {
            await remove(lockPath);
            removed = true;
          }
        } catch { /* the lock remains reclaimable after this process exits */ }
      }
      return { ok: false, errorCode: error?.code === 'EEXIST' ? C.LOCK_BUSY : C.LOCK_FAILED, message: removed ? text(error) : `${text(error)}; lock retained because ownership cleanup was unproven` };
    }
  };
  const release = async (expectedNonce = null) => {
    const handle = lockHandle;
    const nonce = lockNonce;
    if (!handle || !nonce) return { ok: true };
    if (!expectedNonce || nonce !== expectedNonce) {
      return { ok: false, errorCode: C.LOCK_FAILED, message: 'Acer bridge lock is owned by another invocation' };
    }
    lockHandle = null;
    lockNonce = null;
    let ok = true;
    let message = null;
    let removed = false;
    // Remove while the owner handle is still open. Closing first creates a
    // cross-process gap in which a successor can acquire and then be unlinked
    // by this release.
    try {
      await remove(lockPath);
      removed = true;
    } catch (error) {
      ok = false;
      message = text(error);
    }
    try {
      if (handle?.close) await handle.close();
    } catch (error) {
      ok = false;
      message = message ?? text(error);
    }
    // Windows may reject unlink while the file handle is open. Retry only
    // after closing, and prove the nonce before removing anything.
    if (!removed) {
      try {
        const raw = await readRaw(lockPath);
        const current = parseJsonUnique(raw.toString('utf8'));
        if (current?.ownerNonce === nonce) {
          await remove(lockPath);
          removed = true;
        }
      } catch (error) {
        message = message ?? text(error);
      }
    }
    if (removed) orphanedLockNonce = null;
    else orphanedLockNonce = nonce;
    return removed && ok
      ? { ok: true }
      : { ok: false, errorCode: C.LOCK_FAILED, message: message ?? 'Acer bridge lock cleanup failed' };
  };
  const readPair = async (physicalTarget, deviceId, deviceKey = null) => {
    try {
      if (typeof deps.readSysmanPair !== 'function') return null;
      return pairOf(await deps.readSysmanPair(physicalTarget, deviceId, deviceKey));
    } catch { return null; }
  };
  const setPair = async (physicalTarget, deviceId, pair, deviceKey = null) => {
    try {
      if (typeof deps.setSysmanPair !== 'function') return { ok: false, errorCode: C.READBACK_UNAVAILABLE, message: 'physical-target Sysman setter unavailable' };
      return await deps.setSysmanPair(physicalTarget, pair, deviceId, deviceKey);
    } catch (error) { return { ok: false, errorCode: C.READBACK_UNAVAILABLE, message: text(error) }; }
  };
  const terminateOwned = async (owned) => {
    const expected = (Array.isArray(owned) ? owned : []).map((item) => typeof item === 'number' ? { pid: item } : item).filter((item) => Number.isInteger(item?.pid) && item.pid > 0);
    if (expected.length === 0) return { ok: true };
    try {
      const current = await snapshot();
      if (!current) return { ok: false, errorCode: C.PROCESS_SNAPSHOT_FAILED, message: 'Acer process exit could not be verified' };
      const expectedByPid = new Map(expected.map((item) => [item.pid, item]));
      if (current.some((item) => {
        const proof = expectedByPid.get(item.pid);
        return !proof
          || item.packageFullName !== ACER_PACKAGE_FULL_NAME
          || (proof.creationDate && proof.creationDate !== item.creationDate)
          || (proof.executablePath && proof.executablePath.toLowerCase() !== item.executablePath.toLowerCase());
      })) {
        return { ok: false, errorCode: C.UNKNOWN_PROCESS, message: 'an unknown Acer process is present during termination' };
      }
      const live = expected.filter((item) => current.some((process) => process.pid === item.pid));
      if (live.length === 0) return { ok: true };
      const fn = packageBridge?.terminatePids ?? deps.terminatePids;
      if (typeof fn !== 'function') return { ok: false, errorCode: C.TERMINATION_FAILED, message: 'targeted Acer PID termination is unavailable' };
      const answer = await fn(live.map((item) => item.pid), { packageFullName: ACER_PACKAGE_FULL_NAME, identities: live });
      if (answer?.ok === false) return answer;
      const after = await snapshot();
      if (!after) return { ok: false, errorCode: C.PROCESS_SNAPSHOT_FAILED, message: 'Acer process exit could not be verified' };
      if (after.some((item) => {
        const proof = expectedByPid.get(item.pid);
        return !proof
          || item.packageFullName !== ACER_PACKAGE_FULL_NAME
          || (proof.creationDate && proof.creationDate !== item.creationDate)
          || (proof.executablePath && proof.executablePath.toLowerCase() !== item.executablePath.toLowerCase());
      })) return { ok: false, errorCode: C.UNKNOWN_PROCESS, message: 'unknown Acer process remains after termination' };
      const remaining = new Set(after.map((item) => item.pid));
      if (live.some((item) => remaining.has(item.pid))) return { ok: false, errorCode: C.TERMINATION_FAILED, message: 'one or more transaction-owned Acer processes are still running' };
      return { ok: true };
    } catch (error) { return { ok: false, errorCode: C.TERMINATION_FAILED, message: text(error) }; }
  };
  const assertQuiescent = async (boundary) => {
    const current = await snapshot();
    if (!current) return { ok: false, errorCode: C.PROCESS_SNAPSHOT_FAILED, message: `Acer process identity unavailable before ${boundary}` };
    if (current.length > 0) return { ok: false, errorCode: C.UNKNOWN_PROCESS, message: `an Acer process appeared before ${boundary}` };
    return { ok: true };
  };
  const statMetadataMatches = async (entry) => {
    await assertNoReparse(entry.path);
    const stats = await statRaw(entry.path);
    const timestampsMatch = finite(entry.atimeMs) && finite(entry.mtimeMs)
      && Math.abs(stats.atimeMs - entry.atimeMs) <= 1
      && Math.abs(stats.mtimeMs - entry.mtimeMs) <= 1;
    return Number.isInteger(stats.mode) && stats.mode === entry.mode && timestampsMatch;
  };
  const restoreFile = async (entry) => {
    try { await assertNoReparse(entry.path); } catch (error) {
      return { ok: false, errorCode: C.FILE_MODIFIED, message: `${entry.path} reparse-point proof failed: ${text(error)}` };
    }
    const current = await readRaw(entry.path);
    const hash = sha256(current);
    const rollbackTemporaryHash = entry.rollbackTemporaryHash;
    if (hash !== entry.originalHash && hash !== entry.temporaryHash && hash !== rollbackTemporaryHash) {
      return { ok: false, errorCode: C.FILE_MODIFIED, message: `${entry.path} changed outside the transaction` };
    }
    try {
      if (typeof deps.verifyFileMetadata !== 'function' || entry.metadata === null) {
        return { ok: false, errorCode: C.FILE_MODIFIED, message: `${entry.path} metadata changed outside the transaction` };
      }
      await assertNoReparse(entry.path);
      const currentMetadata = await deps.verifyFileMetadata(entry.path, entry.metadata);
      if (currentMetadata !== true && currentMetadata?.ok !== true) {
        return { ok: false, errorCode: C.FILE_MODIFIED, message: `${entry.path} metadata changed outside the transaction` };
      }
      if (!await statMetadataMatches(entry)) {
        return { ok: false, errorCode: C.FILE_MODIFIED, message: `${entry.path} metadata changed outside the transaction` };
      }
    } catch (error) {
      return { ok: false, errorCode: C.FILE_MODIFIED, message: `${entry.path} metadata ownership could not be verified: ${text(error)}` };
    }
    if (hash !== entry.originalHash) await writeAtomic(entry.path, Buffer.from(entry.originalBytes, 'base64'), { metadata: entry.metadata, mode: entry.mode, atimeMs: entry.atimeMs, mtimeMs: entry.mtimeMs });
    try { await assertNoReparse(entry.path); } catch (error) {
      return { ok: false, errorCode: C.RESTORE_FAILED, message: `${entry.path} reparse-point proof failed after restore: ${text(error)}` };
    }
    if (sha256(await readRaw(entry.path)) !== entry.originalHash) return { ok: false, errorCode: C.RESTORE_FAILED, message: `${entry.path} did not restore exactly` };
    try {
      if (entry.metadata === null
        || typeof deps.restoreFileMetadata !== 'function'
        || typeof deps.verifyFileMetadata !== 'function') {
        return { ok: false, errorCode: C.RESTORE_FAILED, message: `${entry.path} metadata/ACL proof unavailable` };
      }
      const chmod = api.chmod ?? api.promises?.chmod;
      if (chmod && entry.mode !== undefined) await chmod(entry.path, entry.mode);
      const utimes = api.utimes ?? api.promises?.utimes;
      if (utimes && finite(entry.atimeMs) && finite(entry.mtimeMs)) await utimes(entry.path, new Date(entry.atimeMs), new Date(entry.mtimeMs));
      await assertNoReparse(entry.path);
      const metadataResult = await deps.restoreFileMetadata(entry.path, entry.metadata);
      if (metadataResult?.ok !== true) return { ok: false, errorCode: C.RESTORE_FAILED, message: metadataResult?.message ?? `${entry.path} metadata did not restore` };
      await assertNoReparse(entry.path);
      const verified = await deps.verifyFileMetadata(entry.path, entry.metadata);
      if (verified !== true && verified?.ok !== true) return { ok: false, errorCode: C.RESTORE_FAILED, message: `${entry.path} metadata verification failed` };
      if (!await statMetadataMatches(entry)) return { ok: false, errorCode: C.RESTORE_FAILED, message: `${entry.path} mode/timestamp metadata verification failed` };
    } catch (error) { return { ok: false, errorCode: C.RESTORE_FAILED, message: text(error) }; }
    return { ok: true };
  };
  const verifyRestoredFile = async (entry) => {
    try {
      await assertNoReparse(entry.path);
      if (sha256(await readRaw(entry.path)) !== entry.originalHash) {
        return { ok: false, errorCode: C.FILE_MODIFIED, message: `${entry.path} changed during final verification` };
      }
      await assertNoReparse(entry.path);
      const metadata = await deps.verifyFileMetadata(entry.path, entry.metadata);
      if (metadata !== true && metadata?.ok !== true) {
        return { ok: false, errorCode: C.FILE_MODIFIED, message: `${entry.path} metadata changed during final verification` };
      }
      if (!await statMetadataMatches(entry)) {
        return { ok: false, errorCode: C.FILE_MODIFIED, message: `${entry.path} mode/timestamp metadata changed during final verification` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, errorCode: C.FILE_MODIFIED, message: `${entry.path} final verification failed: ${text(error)}` };
    }
  };
  const rollbackViaAcerInternal = async ({ target, deviceId, baselineW, payload }) => {
    if (!payload?.files || payload.files.length !== 2 || !finite(baselineW)) {
      return { ok: false, message: 'owned Acer rollback baseline is unavailable' };
    }
    const installed = await packageInstalled();
    if (!installed.ok) return installed;
    const originalBytes = payload.files.map((entry) => Buffer.from(entry.originalBytes, 'base64'));
    const currentBytes = [];
    const currentHashes = [];
    let owned = [];
    let cleanupError = null;
    try {
      for (const entry of payload.files) {
        const quiet = await assertQuiescent(`rollback file ownership ${entry.path}`);
        if (!quiet.ok) return { ok: false, message: quiet.message };
        await assertNoReparse(entry.path);
        const current = await readRaw(entry.path);
        const hash = sha256(current);
        if (hash !== entry.originalHash && hash !== entry.temporaryHash && hash !== entry.rollbackTemporaryHash) {
          return { ok: false, message: `${entry.path} changed outside the transaction` };
        }
        await assertNoReparse(entry.path);
        const metadata = await deps.verifyFileMetadata(entry.path, entry.metadata);
        if (metadata !== true && metadata?.ok !== true) {
          return { ok: false, message: `${entry.path} metadata ownership could not be verified` };
        }
        currentBytes.push(current);
        currentHashes.push(hash);
      }
      const settingsDecoded = decodeBytes(originalBytes[0]);
      const xmlDecoded = decodeBytes(originalBytes[1]);
      const settings = parseJsonUnique(settingsDecoded.text);
      const selected = selectedProfileName(settings);
      const baseline = payload.baseline ?? {};
      const coreVoltage = baseline.coreVoltageProfile;
      const temperatureC = finite(baseline.tempLimitC)
        ? baseline.tempLimitC
        : (finite(baseline.temperatureLimitC) ? baseline.temperatureLimitC : null);
      if (!selected || !hasUsableAbsoluteCoreVoltage(coreVoltage) || !finite(temperatureC)
        || !selectedTargetMatches(settings, target)) {
        return { ok: false, message: 'owned Acer rollback baseline is not representable' };
      }
      const rollbackName = `${bridgeProfileName(selected, baselineW)}__Rollback_${String(now()).replace(/[^0-9]/g, '')}`;
      const changedSettings = transformSettings(settings, selected, rollbackName, baselineW, temperatureC, coreVoltage);
      if (!changedSettings.ok) return { ok: false, message: changedSettings.reason };
      const changedXml = transformXml(xmlDecoded.text, selected, rollbackName, baselineW, temperatureC, coreVoltage);
      if (!changedXml.ok) return { ok: false, message: changedXml.reason };
      if (!wellFormedXml(changedXml.text)) return { ok: false, message: 'generated rollback Acer XML failed validation' };
      const temporary = [
        encodeBytes(settingsDecoded, JSON.stringify(changedSettings.value, null, 2)),
        encodeBytes(xmlDecoded, changedXml.text),
      ];
      for (let i = 0; i < payload.files.length; i++) {
        payload.files[i].rollbackTemporaryHash = sha256(temporary[i]);
      }
      // Publish ownership of the fallback bytes before the first rename.
      // Recovery can then distinguish a transaction-owned rollback document
      // from an external edit even if the process dies between replacements.
      payload.phase = 'rollback-activation-pending';
      payload.ownedPids = [];
      await writeJournal(payload);
      for (let i = 0; i < payload.files.length; i++) {
        const entry = payload.files[i];
        const quiet = await assertQuiescent(`rollback file replacement ${entry.path}`);
        if (!quiet.ok) return { ok: false, message: quiet.message };
        await assertNoReparse(entry.path);
        const current = await readRaw(entry.path);
        const currentHash = sha256(current);
        if (currentHash !== currentHashes[i]) return { ok: false, message: `${entry.path} changed during rollback preparation` };
        await writeAtomic(entry.path, temporary[i], { metadata: entry.metadata, mode: entry.mode, atimeMs: entry.atimeMs, mtimeMs: entry.mtimeMs });
        await assertNoReparse(entry.path);
        if (sha256(await readRaw(entry.path)) !== entry.rollbackTemporaryHash) {
          return { ok: false, message: `${entry.path} rollback replacement did not verify` };
        }
        await writeJournal(payload);
      }
      const before = await snapshot();
      if (!before) return { ok: false, message: 'Acer rollback process snapshot unavailable before activation' };
      if (before.length > 0) return { ok: false, message: 'an Acer process appeared before rollback activation' };
      let activated;
      try {
        activated = await activate(ACER_PACKAGE_SHELL_IDENTITY, {
          packageFullName: ACER_PACKAGE_FULL_NAME,
          packageVersion: ACER_PACKAGE_VERSION,
          requestId: `rollback-${payload.ownerNonce ?? crypto.randomUUID()}`,
        });
      } catch (error) {
        return { ok: false, message: `Acer rollback activation failed: ${text(error)}` };
      }
      const activationPid = Number(activated?.activationPid);
      if (activated?.ok !== true || !finite(activated?.activationStartedAt)
        || !Number.isInteger(activationPid) || activationPid <= 0) {
        return { ok: false, message: activated?.message ?? 'Acer rollback activation did not return a bound process identity' };
      }
      const activatedSnapshotRaw = normalizeSnapshot(activated.processes ?? activated.pids);
      const activatedSnapshot = activatedSnapshotRaw ? excludePreexistingBrokers(activatedSnapshotRaw, activated.activationStartedAt) : null;
      const afterRaw = await snapshot();
      const after = afterRaw ? excludePreexistingBrokers(afterRaw, activated.activationStartedAt) : null;
      const packageRoots = (list) => list?.filter((item) => item?.processKind === 'package' || item?.processKind === undefined) ?? [];
      const activatedRoots = packageRoots(activatedSnapshot);
      const afterRoots = packageRoots(after);
      if (!activatedSnapshot || activatedSnapshot.length === 0 || !after
        || activatedSnapshot.some((item) => typeof item.creationDate !== 'string'
          || creationTimeMs(item.creationDate) === null
          || creationTimeMs(item.creationDate) < activated.activationStartedAt
          || item.packageFullName !== ACER_PACKAGE_FULL_NAME
          || typeof item.executablePath !== 'string' || item.executablePath.length === 0)
        || activatedRoots.length !== 1 || afterRoots.length !== 1
        || activatedRoots[0].pid !== activationPid
        || activatedRoots[0].pid !== afterRoots[0].pid
        || activatedRoots[0].creationDate !== afterRoots[0].creationDate
        || activatedRoots[0].executablePath.toLowerCase() !== afterRoots[0].executablePath.toLowerCase()
        || after.length !== activatedSnapshot.length
        || after.some((item) => {
          const proof = activatedSnapshot.find((candidate) => candidate.pid === item.pid);
          return !proof || proof.creationDate !== item.creationDate
            || proof.executablePath.toLowerCase() !== item.executablePath.toLowerCase()
            || item.packageFullName !== ACER_PACKAGE_FULL_NAME;
        })) {
        return { ok: false, message: 'Acer rollback activation produced unattributable processes' };
      }
      owned = after.map((item) => ({ ...item, ownerNonce: payload.ownerNonce ?? null }));
      payload.phase = 'rollback-activated';
      payload.ownedPids = owned;
      await writeJournal(payload);
      const hide = packageBridge?.hideWindow ?? deps.hideWindow;
      if (typeof hide !== 'function') return { ok: false, message: 'Acer rollback window control is unavailable' };
      const hidden = await hide(owned.map((item) => item.pid), {
        packageFullName: ACER_PACKAGE_FULL_NAME,
        packageRoot: installed.value.installLocation,
        ownerNonce: payload.ownerNonce ?? null,
        identities: owned,
      });
      if (hidden?.ok !== true || hidden?.noWindow === true) return { ok: false, message: hidden?.message ?? 'Acer rollback window control failed' };
      const deadline = now() + (finite(deps.readbackTimeoutMs) ? deps.readbackTimeoutMs : 5000);
      let observed = null;
      while (now() <= deadline) {
        observed = await readPair(target, deviceId, payload.deviceKey ?? null);
        if (equalPair(observed, { sustainedW: baselineW, burstW: baselineW })) break;
        await sleep(Math.min(100, Math.max(1, deadline - now())));
      }
      const terminated = await terminateOwned(owned);
      if (!terminated.ok) return terminated;
      owned = [];
      payload.phase = 'rollback-activation-pending';
      payload.ownedPids = [];
      await writeJournal(payload);
      return equalPair(observed, { sustainedW: baselineW, burstW: baselineW })
        ? { ok: true, observed }
        : { ok: false, message: 'Acer rollback activation did not restore the baseline pair' };
    } catch (error) {
      return { ok: false, message: text(error) };
    } finally {
      if (owned.length > 0) {
        const terminated = await terminateOwned(owned);
        if (!terminated.ok) cleanupError = terminated;
        owned = [];
      }
      if (!cleanupError) for (let i = 0; i < payload.files.length; i++) {
        if (!currentBytes[i]) continue;
        try {
          const quiet = await assertQuiescent(`rollback restore ${payload.files[i].path}`);
          if (!quiet.ok) throw new Error(quiet.message);
          const current = await readRaw(payload.files[i].path);
          const rollbackHash = payload.files[i].rollbackTemporaryHash;
          if (sha256(current) !== currentHashes[i] && sha256(current) !== rollbackHash) throw new Error(`${payload.files[i].path} changed outside rollback ownership`);
          if (typeof deps.restoreFileMetadata !== 'function' || payload.files[i].metadata === null) {
            throw new Error(`${payload.files[i].path} metadata/ACL restore is unavailable`);
          }
          if (!await statMetadataMatches(payload.files[i])) throw new Error(`${payload.files[i].path} metadata changed outside rollback ownership`);
          await writeAtomic(payload.files[i].path, currentBytes[i], { metadata: payload.files[i].metadata, mode: payload.files[i].mode, atimeMs: payload.files[i].atimeMs, mtimeMs: payload.files[i].mtimeMs });
          const chmod = api.chmod ?? api.promises?.chmod;
          if (chmod && payload.files[i].mode !== undefined) await chmod(payload.files[i].path, payload.files[i].mode);
          const utimes = api.utimes ?? api.promises?.utimes;
          if (utimes && finite(payload.files[i].atimeMs) && finite(payload.files[i].mtimeMs)) {
            await utimes(payload.files[i].path, new Date(payload.files[i].atimeMs), new Date(payload.files[i].mtimeMs));
          }
          const metadataResult = await deps.restoreFileMetadata(payload.files[i].path, payload.files[i].metadata);
          if (metadataResult?.ok !== true) throw new Error(metadataResult?.message ?? `${payload.files[i].path} metadata did not restore`);
          const verified = await deps.verifyFileMetadata(payload.files[i].path, payload.files[i].metadata);
          if (verified !== true && verified?.ok !== true) throw new Error(`${payload.files[i].path} metadata verification failed`);
          if (!await statMetadataMatches(payload.files[i])) throw new Error(`${payload.files[i].path} mode/timestamp metadata verification failed`);
        } catch (error) {
          cleanupError = cleanupError ?? { message: text(error) };
        }
      }
      if (cleanupError) throw new Error(cleanupError.message ?? 'Acer rollback cleanup failed');
    }
  };

  const restoreRouteVoltageOffset = async (baseline, deviceId, deviceKey, physicalTarget) => {
    const offsetV = baseline?.sysmanVoltageOffsetV;
    if (!finite(offsetV)) return { ok: true };
    if (typeof deps.restoreSysmanVoltageOffset !== 'function') {
      return { ok: false, errorCode: C.READBACK_UNAVAILABLE, message: 'the Sysman voltage offset restore hook is unavailable' };
    }
    try {
      const restored = await deps.restoreSysmanVoltageOffset({ offsetV, deviceId, deviceKey, physicalTarget });
      return restored?.ok === true
        ? restored
        : { ok: false, errorCode: restored?.errorCode ?? C.RESTORE_FAILED, message: restored?.message ?? 'the Sysman voltage offset restore did not verify' };
    } catch (error) {
      return { ok: false, errorCode: C.RESTORE_FAILED, message: text(error) };
    }
  };
  const rollbackBaseline = async (payload, deviceId) => {
    const pair = pairOf(payload?.baseline?.power);
    if (!pair) return { ok: false, errorCode: C.ROLLBACK_FAILED, message: 'captured baseline power pair is not representable' };
    const target = payload.physicalTarget;
    const direct = await setPair(target, deviceId, pair, payload.deviceKey ?? null);
    if (direct?.ok === true) {
      const observed = await readPair(target, deviceId, payload.deviceKey ?? null);
      if (equalPair(observed, pair)) {
        const voltage = await restoreRouteVoltageOffset(payload.baseline, deviceId, payload.deviceKey ?? null, target);
        return voltage.ok ? { ok: true, observed } : voltage;
      }
    }
    // Prefer the injected seam in tests/host integrations; production uses
    // the owned Acer transaction below.
    const rollbackAcer = typeof deps.rollbackViaAcer === 'function' ? deps.rollbackViaAcer : rollbackViaAcerInternal;
    if (pair.sustainedW !== pair.burstW || typeof rollbackAcer !== 'function') {
      return { ok: false, errorCode: C.ROLLBACK_FAILED, message: 'physical-target Sysman baseline rollback did not verify' };
    }
    try {
      const fallback = await rollbackAcer({ target, deviceId, deviceKey: payload.deviceKey ?? null, baselineW: pair.sustainedW, payload });
      if (fallback?.ok !== true) return { ok: false, errorCode: C.ROLLBACK_FAILED, message: fallback?.message ?? 'owned Acer rollback was unavailable' };
      const observed = await readPair(target, deviceId, payload.deviceKey ?? null);
      if (!equalPair(observed, pair)) {
        return { ok: false, errorCode: C.ROLLBACK_FAILED, message: 'owned Acer baseline rollback did not verify' };
      }
      const voltage = await restoreRouteVoltageOffset(payload.baseline, deviceId, payload.deviceKey ?? null, target);
      return voltage.ok
        ? { ok: true, observed, via: 'acer' }
        : voltage;
    } catch (error) {
      return { ok: false, errorCode: C.ROLLBACK_FAILED, message: text(error) };
    }
  };

  const cleanupCompleted = Symbol('cleanupCompleted');
  const cleanupFailedTransaction = async ({ payload, ownedPids, deviceId, entries, observed, failure }) => {
    const rollback = { required: true, observed: null };
    if (ownedPids.length > 0) {
      const terminated = await terminateOwned(ownedPids);
      if (!terminated.ok) return { ...failure, rollback: { ...rollback, ok: false, message: terminated.message }, errorCode: C.TERMINATION_FAILED };
    }
    const quietBeforeRollback = await assertQuiescent('baseline rollback');
    if (!quietBeforeRollback.ok) return { ...failure, rollback: { ...rollback, ok: false, message: quietBeforeRollback.message }, errorCode: quietBeforeRollback.errorCode };
    const rolled = await rollbackBaseline(payload, deviceId);
    rollback.ok = rolled.ok;
    rollback.observed = rolled.observed ?? null;
    rollback.via = rolled.via;
    if (!rolled.ok) return { ...failure, rollback, errorCode: C.ROLLBACK_FAILED, message: rolled.message };
    const quietBeforeCore = await assertQuiescent('core/voltage restore');
    if (!quietBeforeCore.ok) return { ...failure, rollback: { ...rollback, ok: false, message: quietBeforeCore.message }, errorCode: quietBeforeCore.errorCode };
    const core = await deps.restoreCoreVoltage(payload.baseline?.coreVoltage ?? null, { deviceId, deviceKey: payload.deviceKey ?? null, physicalTarget: payload.physicalTarget });
    if (!verificationOk(core)) return { ...failure, rollback, errorCode: C.RESTORE_FAILED, message: core?.message ?? 'core/voltage restore failed' };
    const quietBeforeTemperature = await assertQuiescent('temperature restore');
    if (!quietBeforeTemperature.ok) return { ...failure, rollback: { ...rollback, ok: false, message: quietBeforeTemperature.message }, errorCode: quietBeforeTemperature.errorCode };
    const temperature = await deps.restoreTemperature(payload.baseline?.tempLimitC ?? payload.baseline?.temperatureLimitC ?? null, { deviceId, deviceKey: payload.deviceKey ?? null, physicalTarget: payload.physicalTarget });
    if (!verificationOk(temperature)) return { ...failure, rollback, errorCode: C.RESTORE_FAILED, message: temperature?.message ?? 'temperature restore failed' };
    const quietBeforeFan = await assertQuiescent('fan restore');
    if (!quietBeforeFan.ok) return { ...failure, rollback: { ...rollback, ok: false, message: quietBeforeFan.message }, errorCode: quietBeforeFan.errorCode };
    const fan = await deps.restoreFanState(payload.baseline?.fan ?? payload.baseline?.fanState ?? null, { deviceId, deviceKey: payload.deviceKey ?? null, physicalTarget: payload.physicalTarget });
    if (!verificationOk(fan)) return { ...failure, rollback, errorCode: C.RESTORE_FAILED, message: fan?.message ?? 'fan state restore failed' };
    for (const entry of entries ?? payload.files ?? []) {
      const quietBeforeFile = await assertQuiescent(`file restore ${entry.path}`);
      if (!quietBeforeFile.ok) return { ...failure, rollback: { ...rollback, ok: false, message: quietBeforeFile.message }, errorCode: quietBeforeFile.errorCode };
      const restored = await restoreFile(entry);
      if (!restored.ok) return { ...failure, rollback, errorCode: C.RESTORE_FAILED, message: restored.message };
    }
    const finalBaseline = await readPair(payload.physicalTarget, deviceId, payload.deviceKey ?? null);
    if (!equalPair(finalBaseline, rollback.observed)) return { ...failure, rollback, errorCode: C.ROLLBACK_FAILED, message: 'baseline power read-back was not stable after cleanup' };
    const verified = await deps.verifyFinalState({ baseline: payload.baseline, expectedPower: finalBaseline, deviceId, deviceKey: payload.deviceKey ?? null, physicalTarget: payload.physicalTarget });
    if (!verificationOk(verified)) return { ...failure, rollback, errorCode: C.STATE_CHANGED, message: verified?.message ?? 'baseline core/voltage/fan verification failed' };
    const absoluteVerified = await verifyAcerAbsolute({ baseline: payload.baseline, deviceId, deviceKey: payload.deviceKey ?? null, physicalTarget: payload.physicalTarget });
    if (!verificationOk(absoluteVerified)) return { ...failure, rollback, errorCode: C.STATE_CHANGED, message: absoluteVerified?.message ?? 'Acer absolute core/voltage cleanup verification failed' };
    const finalCleanupBoundary = await assertQuiescent('cleanup journal removal');
    if (!finalCleanupBoundary.ok) {
      return { ...failure, rollback: { ...rollback, ok: false, message: finalCleanupBoundary.message }, errorCode: finalCleanupBoundary.errorCode };
    }
    for (const entry of entries ?? payload.files ?? []) {
      const finalFile = await verifyRestoredFile(entry);
      if (!finalFile.ok) return { ...failure, rollback, errorCode: C.RESTORE_FAILED, message: finalFile.message };
    }
    const cleaned = { ...failure, rollback };
    Object.defineProperty(cleaned, cleanupCompleted, { value: true });
    return cleaned;
  };

  async function recover({ lockHeld = false } = {}) {
    if (active && !lockHeld) {
      return { ok: false, recovered: false, errorCode: C.LOCK_BUSY, message: 'another Acer packaged transaction is active' };
    }
    let recoveryLock = false;
    let recoveryOwnerNonce = null;
    let recoveryPayload = null;
    let journalRemovalPending = false;
    try {
      // The journal owner is authoritative even if a crash removed the lock
      // file. Never recover a transaction whose recorded owner is still live.
      const initialJournal = await readJournal();
      if (initialJournal.payload) {
        const ownerState = pidLiveness(initialJournal.payload.ownerPid);
        if (ownerState === true) {
          recoveryRequired = true;
          return { ok: false, recovered: false, errorCode: C.LOCK_BUSY, message: 'Acer journal is owned by a live process' };
        }
        if (ownerState !== false) {
          recoveryRequired = true;
          return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: 'Acer journal owner liveness could not be verified' };
        }
      }
      if (!lockHeld) {
        try {
          const raw = await readRaw(lockPath);
          const owner = parseJsonUnique(raw.toString('utf8'));
          if (!owner?.ownerNonce || !Number.isInteger(owner.pid) || owner.pid <= 0) {
            recoveryRequired = true;
            return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: 'orphan Acer lock ownership is ambiguous' };
          }
          const ownerState = pidLiveness(owner.pid);
          if (ownerState === true) {
            return { ok: false, recovered: false, errorCode: C.LOCK_BUSY, message: 'Acer bridge lock is owned by a live process' };
          }
          if (ownerState !== false) {
            recoveryRequired = true;
            return { ok: false, recovered: false, errorCode: C.LOCK_BUSY, message: 'Acer bridge lock ownership could not be verified' };
          }
          await remove(lockPath);
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            recoveryRequired = true;
            return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: 'orphan Acer lock could not be reconciled' };
          }
        }
        recoveryOwnerNonce = crypto.randomUUID();
        const locked = await acquire({ ownerNonce: recoveryOwnerNonce, pid: processApi.pid, requestId: null, packageFullName: ACER_PACKAGE_FULL_NAME, recovery: true });
        if (!locked.ok) {
          recoveryRequired = true;
          return { ok: false, recovered: false, errorCode: locked.errorCode ?? C.LOCK_BUSY, message: locked.message ?? 'Acer recovery lock could not be acquired' };
        }
        recoveryLock = true;
      }
      const journal = await readJournal();
      if (journal.none) {
        if (recoveryLock || lockHeld) {
          recoveryRequired = false;
          return { ok: true, recovered: false };
        }
        recoveryRequired = false;
        return { ok: true, recovered: false };
      }
      if (journal.invalid) {
        recoveryRequired = true;
        return { ok: false, recovered: false, errorCode: C.JOURNAL_INVALID, message: 'Acer recovery journal is malformed, stale-versioned, or integrity-invalid' };
      }
      const payload = journal.payload;
      recoveryPayload = clone(payload);
      if (ACER_HARDWARE_MUTATING_PHASES.includes(payload.phase)
        && (payload.ownedPids ?? []).some((item) => !item || typeof item !== 'object'
          || !Number.isInteger(item.pid) || item.pid <= 0
          || typeof item.creationDate !== 'string' || item.creationDate.length === 0
          || typeof item.executablePath !== 'string' || item.executablePath.length === 0
          || item.packageFullName !== ACER_PACKAGE_FULL_NAME)) {
        recoveryRequired = true;
        return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: 'Acer recovery ownership proof is incomplete' };
      }
      const current = await snapshot();
      if (!current) {
        recoveryRequired = true;
        return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: 'Acer process identity could not be established during recovery' };
      }
      const recorded = new Set((payload.ownedPids ?? []).map((item) => typeof item === 'number' ? item : item?.pid));
      if (current.some((item) => item.packageFullName !== ACER_PACKAGE_FULL_NAME || !recorded.has(item.pid))) {
        recoveryRequired = true;
        return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: 'unknown Acer process appeared during recovery' };
      }
      if (ACER_HARDWARE_MUTATING_PHASES.includes(payload.phase)
        && (typeof deps.restoreCoreVoltage !== 'function'
          || typeof deps.restoreTemperature !== 'function'
          || typeof deps.restoreFanState !== 'function'
          || typeof deps.verifyFinalState !== 'function'
          || typeof deps.verifyAcerAbsoluteCoreVoltage !== 'function')) {
        recoveryRequired = true;
        return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: 'Acer recovery hooks are unavailable' };
      }
      const terminated = await terminateOwned(payload.ownedPids ?? []);
      if (!terminated.ok) {
        recoveryRequired = true;
        return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: terminated.message ?? 'Acer process recovery failed' };
      }
      const quietAfterTermination = await assertQuiescent('recovery restore');
      if (!quietAfterTermination.ok) {
        recoveryRequired = true;
        return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: quietAfterTermination.message };
      }
      if (ACER_HARDWARE_MUTATING_PHASES.includes(payload.phase)) {
        const rolled = await rollbackBaseline(payload, payload.deviceId);
        if (!rolled.ok) {
          recoveryRequired = true;
          return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: rolled.message ?? 'Acer baseline rollback failed' };
        }
        const quietBeforeCore = await assertQuiescent('recovery core/voltage restore');
        if (!quietBeforeCore.ok) {
          recoveryRequired = true;
          return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: quietBeforeCore.message };
        }
        const core = await deps.restoreCoreVoltage(payload.baseline?.coreVoltage ?? null, { deviceId: payload.deviceId, deviceKey: payload.deviceKey ?? null, physicalTarget: payload.physicalTarget });
        if (!verificationOk(core)) {
          recoveryRequired = true;
          return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: core?.message ?? 'Acer core/voltage recovery failed' };
        }
        const quietBeforeTemperature = await assertQuiescent('recovery temperature restore');
        if (!quietBeforeTemperature.ok) {
          recoveryRequired = true;
          return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: quietBeforeTemperature.message };
        }
        const temperature = await deps.restoreTemperature(payload.baseline?.tempLimitC ?? payload.baseline?.temperatureLimitC ?? null, { deviceId: payload.deviceId, deviceKey: payload.deviceKey ?? null, physicalTarget: payload.physicalTarget });
        if (!verificationOk(temperature)) {
          recoveryRequired = true;
          return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: temperature?.message ?? 'Acer temperature recovery failed' };
        }
        const quietBeforeFan = await assertQuiescent('recovery fan restore');
        if (!quietBeforeFan.ok) {
          recoveryRequired = true;
          return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: quietBeforeFan.message };
        }
        const fan = await deps.restoreFanState(payload.baseline?.fan ?? payload.baseline?.fanState ?? null, { deviceId: payload.deviceId, deviceKey: payload.deviceKey ?? null, physicalTarget: payload.physicalTarget });
        if (!verificationOk(fan)) {
          recoveryRequired = true;
          return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: fan?.message ?? 'Acer fan recovery failed' };
        }
        const verified = await deps.verifyFinalState({ baseline: payload.baseline, expectedPower: payload.baseline?.power, deviceId: payload.deviceId, deviceKey: payload.deviceKey ?? null, physicalTarget: payload.physicalTarget });
        if (!verificationOk(verified)) {
          recoveryRequired = true;
          return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: verified?.message ?? 'Acer baseline recovery verification failed' };
        }
        const absoluteVerified = await verifyAcerAbsolute({ baseline: payload.baseline, deviceId: payload.deviceId, deviceKey: payload.deviceKey ?? null, physicalTarget: payload.physicalTarget });
        if (!verificationOk(absoluteVerified)) {
          recoveryRequired = true;
          return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: absoluteVerified?.message ?? 'Acer absolute core/voltage recovery verification failed' };
        }
      }
      for (const file of payload.files ?? []) {
        const quietBeforeFile = await assertQuiescent(`recovery file restore ${file.path}`);
        if (!quietBeforeFile.ok) {
          recoveryRequired = true;
          return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: quietBeforeFile.message };
        }
        const restored = await restoreFile(file);
        if (!restored.ok) {
          recoveryRequired = true;
          return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: restored.message };
        }
      }
      const finalRecoveryBoundary = await assertQuiescent('recovery journal removal');
      if (!finalRecoveryBoundary.ok) {
        recoveryRequired = true;
        return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: finalRecoveryBoundary.message };
      }
      for (const file of payload.files ?? []) {
        const finalFile = await verifyRestoredFile(file);
        if (!finalFile.ok) {
          recoveryRequired = true;
          return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: finalFile.message };
        }
      }
      const finalPower = await readPair(payload.physicalTarget, payload.deviceId, payload.deviceKey ?? null);
      if (!equalPair(finalPower, pairOf(payload.baseline?.power))) {
        recoveryRequired = true;
        return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: 'Acer recovery power read-back changed before journal removal' };
      }
      const finalState = await deps.verifyFinalState({ baseline: payload.baseline, expectedPower: finalPower, deviceId: payload.deviceId, deviceKey: payload.deviceKey ?? null, physicalTarget: payload.physicalTarget });
      if (!verificationOk(finalState)) {
        recoveryRequired = true;
        return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: finalState?.message ?? 'Acer recovery state changed before journal removal' };
      }
      const finalAbsolute = await verifyAcerAbsolute({ baseline: payload.baseline, deviceId: payload.deviceId, deviceKey: payload.deviceKey ?? null, physicalTarget: payload.physicalTarget });
      if (!verificationOk(finalAbsolute)) {
        recoveryRequired = true;
        return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: finalAbsolute?.message ?? 'Acer recovery absolute core/voltage state changed before journal removal' };
      }
      if (recoveryLock) {
        // Keep the recovery journal authoritative until the recovery lock has
        // been released successfully. Removing it first would leave a
        // reserve-visible gap if lock cleanup failed.
        journalRemovalPending = true;
        return { ok: true, recovered: true };
      }
      await remove(journalPath);
      recoveryRequired = false;
      return { ok: true, recovered: true };
    } catch (error) {
      recoveryRequired = true;
      return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: text(error) };
    } finally {
      if (recoveryLock) {
        let released;
        try { released = await release(recoveryOwnerNonce); } catch (error) {
          released = { ok: false, errorCode: C.LOCK_FAILED, message: text(error) };
        }
        if (!released.ok) {
          recoveryRequired = true;
          try {
            const payload = recoveryPayload ? clone(recoveryPayload) : null;
            if (payload) {
              payload.phase = 'recovery-required';
              payload.ownedPids = [];
              await writeJournal(payload);
            }
          } catch {}
          throw new Error(`Acer recovery lock cleanup failed: ${released.message}`);
        }
        if (journalRemovalPending) {
          try {
            await remove(journalPath);
            recoveryRequired = false;
          } catch (error) {
            recoveryRequired = true;
            try {
              const payload = recoveryPayload ? clone(recoveryPayload) : null;
              if (payload) {
                payload.phase = 'recovery-required';
                payload.ownedPids = [];
                await writeJournal(payload);
              }
            } catch {}
            throw new Error(`Acer recovery journal cleanup failed: ${text(error)}`);
          }
        }
      }
    }

  }
  async function preflight({
    deviceId,
    deviceKey = null,
    physicalTarget,
    requestedW,
    baseline = null,
    interactiveContext = null,
    allowAcerBridge = deps.allowAcerBridge,
    acerPackagedApplyEnabled = deps.acerPackagedApplyEnabled,
  } = {}) {
    const refuse = (errorCode, message) => result(requestedW, errorCode, message);
    if (active) return refuse(C.LOCK_BUSY, 'another Acer packaged transaction is active');
    if (platform !== 'win32') return refuse(C.UNSUPPORTED_PLATFORM, 'Acer packaged apply is supported only on Windows');
    if (!finite(requestedW)) return refuse(C.INVALID_REQUEST, 'requestedW must be a finite number');
    let gate = ACER_ORDINARY_POWER_THRESHOLD_W;
    try {
      const candidate = typeof deps.deviceGateThresholds === 'function'
        ? Number(deps.deviceGateThresholds(deps.limitsKey ?? physicalTarget, false)?.plMax)
        : NaN;
      if (finite(candidate)) gate = candidate;
    } catch {}
    if (requestedW <= ACER_ORDINARY_POWER_THRESHOLD_W || requestedW <= gate) {
      return refuse(C.STOCK_THRESHOLD, `requested power must exceed the ordinary ${Math.max(ACER_ORDINARY_POWER_THRESHOLD_W, gate)} W path`);
    }
    if (recoveryRequired) return refuse(C.RECOVERY_REQUIRED, 'Acer packaged apply is blocked until the previous transaction is recovered');
    if (allowAcerBridge !== true || acerPackagedApplyEnabled !== true) return refuse(C.NOT_OPTED_IN, 'Acer packaged apply is not enabled');
    const context = interactiveContext;
    const verifier = deps.validateInteractiveContext ?? deps.verifyInteractiveContext;
    if (!context || context.applyContext !== 'interactive'
      || typeof context.owner !== 'string' || typeof context.token !== 'string'
      || typeof context.requestId !== 'string' || context.requestId.length < 8
      || context.requestBinding !== context.requestId || typeof verifier !== 'function') {
      return refuse(C.NON_INTERACTIVE, 'Acer packaged apply requires a validated one-time interactive context');
    }
    let verifiedContext = false;
    try { verifiedContext = await verifier(context); } catch {}
    if (!verifiedContext) return refuse(C.NON_INTERACTIVE, 'Acer packaged apply requires a validated one-time interactive context');
    if (physicalTarget?.synthetic === true || physicalTarget?.backendKind === 'os') {
      return refuse(C.DEVICE_NOT_SUPPORTED, 'the physical target is a read-only or synthetic GPU');
    }
    const pci = normalizePci(physicalTarget?.pciDeviceId ?? physicalTarget?.pciId ?? deps.pciDeviceId);
    const vendor = normalizePci(physicalTarget?.pciVendorId ?? physicalTarget?.vendorId ?? deps.pciVendorId);
    if (vendor !== '0x00008086' || pci !== ACER_A770_PCI_DEVICE_ID || physicalTarget?.displayCardIndex !== 0) {
      return refuse(C.DEVICE_NOT_SUPPORTED, 'the physical target is not the supported Intel Arc A770 display card');
    }
    const requiredHooks = [
      ['readSysmanPair', deps.readSysmanPair],
      ['captureFileMetadata', deps.captureFileMetadata],
      ['restoreFileMetadata', deps.restoreFileMetadata],
      ['verifyFileMetadata', deps.verifyFileMetadata],
      ['verifyCoreVoltage', deps.verifyCoreVoltage],
      ['restoreCoreVoltage', deps.restoreCoreVoltage],
      ['restoreTemperature', deps.restoreTemperature],
      ['restoreFanState', deps.restoreFanState],
      ['verifyFinalState', deps.verifyFinalState],
      ['activate', activate],
      ['hideWindow', packageBridge?.hideWindow ?? deps.hideWindow],
      ['terminatePids', packageBridge?.terminatePids ?? deps.terminatePids],
      ['verifyAcerAbsoluteCoreVoltage', deps.verifyAcerAbsoluteCoreVoltage],
    ];
    if (requiredHooks.some(([, hook]) => typeof hook !== 'function')) return refuse(C.UNSUPPORTED, 'required Acer apply, rollback, and process primitives are unavailable');
    const fsHooks = [
      ['readFile', api.readFile ?? api.promises?.readFile],
      ['stat', api.stat ?? api.promises?.stat],
      ['open', api.open ?? api.promises?.open],
      ['rename', api.rename ?? api.promises?.rename],
      ['writeFile', api.writeFile ?? api.promises?.writeFile],
      ['unlink', api.unlink ?? api.promises?.unlink],
      ['mkdir', api.mkdir ?? api.promises?.mkdir],
    ];
    if (fsHooks.some(([, hook]) => typeof hook !== 'function')) return refuse(C.UNSUPPORTED, 'required Acer filesystem and recovery primitives are unavailable');
    if (deps.requireFileMetadata !== true) return refuse(C.UNSUPPORTED, 'Windows metadata/ACL proof is required for Acer packaged apply');
    const journal = await readJournal();
    if (!journal.none) return refuse(C.RECOVERY_REQUIRED, journal.invalid ? 'the Acer bridge journal is invalid' : 'the previous Acer bridge transaction requires recovery');
    try {
      const rawLock = await readRaw(lockPath);
      const owner = parseJsonUnique(rawLock.toString('utf8'));
      const reclaimOwned = Number.isInteger(owner?.pid)
        && owner.pid === processApi.pid
        && owner.ownerNonce === orphanedLockNonce;
      const reclaimDead = Number.isInteger(owner?.pid)
        && owner.pid > 0
        && pidLiveness(owner.pid) === false;
      if (reclaimOwned || reclaimDead) {
        await remove(lockPath);
        if (reclaimOwned) orphanedLockNonce = null;
      } else {
        return refuse(C.LOCK_BUSY, 'Acer bridge lock is already owned');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return refuse(C.LOCK_FAILED, `Acer bridge lock state could not be verified: ${text(error)}`);
      }
    }
    const installed = await packageInstalled();
    if (!installed.ok) return refuse(installed.errorCode, installed.message);
    const processes = await snapshot();
    if (!processes) return refuse(C.PROCESS_SNAPSHOT_FAILED, 'Acer package process identity could not be established');
    if (processes.length > 0) return refuse(C.ALREADY_RUNNING, 'Acer must be closed before a packaged apply');
    if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return refuse(C.READBACK_UNAVAILABLE, 'the complete pre-apply Acer rollback baseline is unavailable');
    const baselinePair = pairOf(baseline.power);
    const physicalPair = await readPair(physicalTarget, deviceId, deviceKey);
    if (!physicalPair) return refuse(C.READBACK_UNAVAILABLE, 'the physical-target Sysman baseline pair is unavailable');
    if (baselinePair && !equalPair(baselinePair, physicalPair)) return refuse(C.STATE_CHANGED, 'the physical-target baseline pair changed before Acer preflight');
    const coreVoltage = baseline.coreVoltage;
    if (!coreVoltage || typeof coreVoltage !== 'object' || Array.isArray(coreVoltage)
      || Object.keys(coreVoltage).length === 0 || Object.values(coreVoltage).some((value) => !finite(value))) {
      return refuse(C.READBACK_UNAVAILABLE, 'the live core/voltage baseline is unavailable');
    }
    const fanState = baseline.fan ?? baseline.fanState;
    if (!fanState || typeof fanState !== 'object' || Array.isArray(fanState)
      || !Object.keys(fanState).some((key) => fanState[key] !== null && fanState[key] !== undefined)) {
      return refuse(C.READBACK_UNAVAILABLE, 'the effective fan baseline is unavailable');
    }
    const temperatureC = finite(baseline.tempLimitC)
      ? baseline.tempLimitC
      : (finite(baseline.temperatureLimitC) ? baseline.temperatureLimitC : null);
    if (!finite(temperatureC)) return refuse(C.READBACK_UNAVAILABLE, 'the effective Acer temperature baseline is unavailable');
    if (typeof deps.setSysmanPair !== 'function'
      && !(physicalPair.sustainedW === physicalPair.burstW && typeof deps.rollbackViaAcer === 'function')) {
      return refuse(C.ROLLBACK_FAILED, 'a proven physical-target rollback route is unavailable');
    }
    const entries = [];
    for (const filePath of [settingsPath, xmlPath]) {
      let raw; let stats; let metadata;
      try {
        await assertNoReparse(filePath);
        raw = await readRaw(filePath);
        stats = await statRaw(filePath);
        metadata = await deps.captureFileMetadata(filePath);
        if (!metadata || metadata.ok === false
          || typeof metadata.sddl !== 'string'
          || !Number.isInteger(metadata.attributes)
          || typeof metadata.creationFileTime !== 'string'
          || !/^\d+$/.test(metadata.creationFileTime)) return refuse(C.FILE_UNAVAILABLE, `${filePath}: metadata/ACL proof unavailable`);
        if (!stats || !Number.isInteger(stats.mode) || !finite(stats.atimeMs) || !finite(stats.mtimeMs)) return refuse(C.FILE_UNAVAILABLE, `${filePath}: file timestamp/mode metadata is unavailable`);
      } catch (error) {
        return refuse(C.FILE_UNAVAILABLE, `${filePath}: ${text(error)}`);
      }
      entries.push(raw);
    }
    let settingsDecoded; let xmlDecoded;
    try {
      settingsDecoded = decodeBytes(entries[0]);
      xmlDecoded = decodeBytes(entries[1]);
    } catch (error) {
      return refuse(C.FILE_PARSE_FAILED, `Acer packaged profile decoding failed: ${text(error)}`);
    }
    let settings;
    try { settings = parseJsonUnique(settingsDecoded.text); } catch (error) {
      return refuse(C.FILE_PARSE_FAILED, `Settings.json is not valid JSON: ${text(error)}`);
    }
    const selected = selectedProfileName(settings);
    if (!selected) return refuse(C.FILE_SHAPE_AMBIGUOUS, 'Settings.json has no unique selected Acer profile');
    const baselineTemperature = finite(baseline.tempLimitC)
      ? baseline.tempLimitC
      : baseline.temperatureLimitC;
    const profileCoreVoltage = profileCoreVoltageOf(xmlDecoded.text, selected);
    if (!hasUsableAbsoluteCoreVoltage(profileCoreVoltage)) {
      return refuse(C.READBACK_UNAVAILABLE, 'Acer XML selected profile has no usable absolute core/voltage baseline');
    }
    const absoluteBaseline = await verifyAcerAbsolute({ expected: profileCoreVoltage, baseline, deviceId, deviceKey, physicalTarget, phase: 'preflight' });
    if (!verificationOk(absoluteBaseline)) return refuse(C.READBACK_UNAVAILABLE, absoluteBaseline?.message ?? 'Acer absolute core/voltage readback is unavailable');
    const completeCoreVoltage = { ...profileCoreVoltage, ...coreVoltage };
    const bridgeName = bridgeProfileName(selected, requestedW);
    const transformedSettings = transformSettings(settings, selected, bridgeName, requestedW, baselineTemperature, completeCoreVoltage);
    if (!transformedSettings.ok) return refuse(C.FILE_SHAPE_AMBIGUOUS, transformedSettings.reason);
    const transformedXml = transformXml(xmlDecoded.text, selected, bridgeName, requestedW, baselineTemperature, completeCoreVoltage);
    if (!transformedXml.ok || !wellFormedXml(transformedXml.text)) return refuse(C.FILE_PARSE_FAILED, transformedXml.reason ?? 'generated Acer profile XML failed validation');
    try {
      const generatedSettings = parseJsonUnique(JSON.stringify(transformedSettings.value));
      if (selectedProfileName(generatedSettings) !== bridgeName
        || profileNodes(transformedXml.text).filter((node) => node.name === selected).length !== 1
        || profileNodes(transformedXml.text).filter((node) => node.name === bridgeName).length !== 1) {
        return refuse(C.FILE_SHAPE_AMBIGUOUS, 'generated Acer documents have an incoherent selected-profile mapping');
      }
      const generatedProfile = profileList(generatedSettings, bridgeName);
      if (generatedProfile.ambiguous
        || (generatedProfile.value && generatedProfile.value.filter((entry) => Object.values(entry).some((value) => value === bridgeName)).length !== 1)) {
        return refuse(C.FILE_SHAPE_AMBIGUOUS, 'generated Settings.json profile reference is ambiguous');
      }
    } catch (error) {
      return refuse(C.FILE_PARSE_FAILED, `generated Acer documents failed validation: ${text(error)}`);
    }
    if (!selectedTargetMatches(settings, physicalTarget)) return refuse(C.DEVICE_NOT_SUPPORTED, 'Acer Settings.json does not map to the selected physical A770 target');
    if (!wellFormedXml(xmlDecoded.text)) return refuse(C.FILE_PARSE_FAILED, 'Acer profile XML failed well-formedness validation');
    return { ok: true, requestedW, physicalPair, profileCoreVoltage: clone(profileCoreVoltage), selectedProfile: selected, package: installed.value };
  }

  async function reserve({ requestId = null, requireAcerClosed = true } = {}) {
    if (recoveryRequired) return { ok: false, errorCode: C.RECOVERY_REQUIRED, message: 'Acer packaged apply is blocked until the previous transaction is recovered' };
    if (active) return { ok: false, errorCode: C.LOCK_BUSY, message: 'another Acer packaged transaction is active' };
    let journal;
    try {
      journal = await readJournal();
    } catch (error) {
      recoveryRequired = true;
      return { ok: false, errorCode: C.RECOVERY_REQUIRED, message: `Acer recovery journal could not be read: ${text(error)}` };
    }
    if (!journal.none) {
      recoveryRequired = true;
      return {
        ok: false,
        errorCode: C.RECOVERY_REQUIRED,
        message: journal.invalid
          ? 'Acer recovery journal is invalid; recovery is required before any write'
          : 'Acer recovery journal is pending; recovery is required before any write',
      };
    }
    const ownerNonce = crypto.randomUUID();
    const locked = await acquire({
      ownerNonce,
      pid: processApi.pid,
      requestId,
      packageFullName: ACER_PACKAGE_FULL_NAME,
      reservation: true,
    });
    let journalAfterLock;
    try {
      journalAfterLock = await readJournal();
    } catch (error) {
      recoveryRequired = true;
      const released = await release(ownerNonce);
      return {
        ok: false,
        errorCode: released.ok ? C.RECOVERY_REQUIRED : C.LOCK_FAILED,
        message: released.ok ? `Acer recovery journal could not be read: ${text(error)}` : released.message,
      };
    }
    if (!journalAfterLock.none) {
      recoveryRequired = true;
      const released = await release(ownerNonce);
      return {
        ok: false,
        errorCode: released.ok ? C.RECOVERY_REQUIRED : C.LOCK_FAILED,
        message: released.ok
          ? (journalAfterLock.invalid ? 'Acer recovery journal is invalid; recovery is required before any write' : 'Acer recovery journal is pending; recovery is required before any write')
          : released.message,
      };
    }
    if (requireAcerClosed) {
      const processes = await snapshot();
      if (!processes || processes.length > 0) {
        const released = await release(ownerNonce);
        return {
          ok: false,
          errorCode: released.ok ? (processes ? C.ALREADY_RUNNING : C.PROCESS_SNAPSHOT_FAILED) : C.LOCK_FAILED,
          message: released.ok
            ? (processes ? 'Acer must be closed before a packaged apply' : 'Acer package process identity could not be established')
            : released.message,
        };
      }
    }
    active = true;
    reservationExpired = false;
    // The lock itself is the durable watchdog. Never expire a live
    // reservation while the routed caller may still be in a write phase:
    // releasing here would permit a second apply to race the first caller's
    // rollback. A crashed owner is reclaimed by PID-liveness checks.
    reservationTimer = null;
    return { ok: true, ownerNonce };
  }
  async function persistRecovery({ deviceId, deviceKey = null, physicalTarget, baseline, requestedW, requestId = null } = {}) {
    if (active) return { ok: false, errorCode: C.LOCK_BUSY, message: 'another Acer packaged transaction is active' };
    const pair = pairOf(baseline?.power);
    const recoveryW = finite(requestedW) ? requestedW : pair?.sustainedW;
    if (!pair || !finite(recoveryW) || !physicalTarget || typeof physicalTarget !== 'object' || !baseline || typeof baseline !== 'object') {
      recoveryRequired = true;
      return { ok: false, errorCode: C.RECOVERY_REQUIRED, message: 'durable Acer recovery baseline is unavailable' };
    }
    const ownerNonce = crypto.randomUUID();
    const locked = await acquire({
      ownerNonce,
      pid: processApi.pid,
      requestId,
      packageFullName: ACER_PACKAGE_FULL_NAME,
      recovery: true,
    });
    if (!locked.ok) {
      recoveryRequired = true;
      return locked;
    }
    active = true;
    let outcome = { ok: false, errorCode: C.RECOVERY_REQUIRED, message: 'durable Acer recovery journal was not written' };
    try {
      await writeJournal({
        phase: 'route-recovery',
        ownerNonce,
        ownerPid: processApi.pid,
        requestId,
        packageFullName: ACER_PACKAGE_FULL_NAME,
        packageVersion: ACER_PACKAGE_VERSION,
        deviceId,
        deviceKey,
        requestedW: recoveryW,
        physicalTarget: clone(physicalTarget),
        baseline: clone({ ...baseline, power: pair }),
        files: [],
        ownedPids: [],
      });
      recoveryRequired = true;
      outcome = { ok: true, recoveryRequired: true };
    } catch (error) {
      recoveryRequired = true;
      outcome = { ok: false, errorCode: C.RECOVERY_REQUIRED, message: text(error) };
    } finally {
      const released = await release(ownerNonce);
      active = false;
      if (!released.ok) {
        recoveryRequired = true;
        outcome = { ok: false, errorCode: C.LOCK_FAILED, message: released.message };
      }
    }
    return outcome;
  }
  async function prepareRouteRecovery({ deviceId, deviceKey = null, physicalTarget, baseline, requestedW, requestId = null, reservation = null } = {}) {
    const ownerNonce = typeof reservation?.ownerNonce === 'string' ? reservation.ownerNonce : null;
    if (!ownerNonce || !active || lockNonce !== ownerNonce || reservationExpired) {
      return { ok: false, errorCode: C.LOCK_BUSY, message: 'Acer route recovery reservation is not owned' };
    }
    const pair = pairOf(baseline?.power);
    if (!pair || !finite(requestedW) || !physicalTarget || typeof physicalTarget !== 'object' || !baseline || typeof baseline !== 'object') {
      return { ok: false, errorCode: C.RECOVERY_REQUIRED, message: 'durable Acer route recovery baseline is unavailable' };
    }
    const journal = await readJournal();
    if (!journal.none) {
      return { ok: false, errorCode: C.RECOVERY_REQUIRED, message: 'an Acer recovery journal already exists' };
    }
    try {
      const payload = {
        phase: 'route-recovery',
        ownerNonce,
        ownerPid: processApi.pid,
        requestId,
        packageFullName: ACER_PACKAGE_FULL_NAME,
        packageVersion: ACER_PACKAGE_VERSION,
        deviceId,
        deviceKey,
        requestedW,
        physicalTarget: clone(physicalTarget),
        baseline: clone({ ...baseline, power: pair }),
        files: [],
        ownedPids: [],
      };
      await writeJournal(payload);
      retainedRouteRecovery = clone(payload);
      return { ok: true, recoveryRequired: false, ownerNonce };
    } catch (error) {
      return { ok: false, errorCode: C.RECOVERY_REQUIRED, message: text(error) };
    }
  }
  async function clearPreparedRouteRecovery({ reservation = null, requestId = null } = {}) {
    const ownerNonce = typeof reservation?.ownerNonce === 'string' ? reservation.ownerNonce : null;
    if (!ownerNonce || !active || lockNonce !== ownerNonce || reservationExpired) {
      return { ok: false, errorCode: C.LOCK_BUSY, message: 'Acer route recovery reservation is not owned' };
    }
    const journal = await readJournal();
    if (journal.none) return { ok: true };
    if (journal.invalid || journal.payload?.phase !== 'route-recovery'
      || journal.payload.ownerNonce !== ownerNonce
      || (requestId !== null && journal.payload.requestId !== requestId)) {
      return { ok: false, errorCode: C.RECOVERY_REQUIRED, message: 'Acer route recovery journal ownership changed' };
    }
    retainedRouteRecovery = clone(journal.payload);
    await remove(journalPath);
    return { ok: true };
  }
  async function clearRouteRecovery({ ownerNonce = null, requestId = null } = {}) {
    if (typeof ownerNonce !== 'string' || ownerNonce.length < 16) {
      return { ok: false, errorCode: C.RECOVERY_REQUIRED, message: 'Acer route recovery owner is unavailable' };
    }
    const journal = await readJournal();
    if (journal.none) return { ok: true };
    if (journal.invalid || journal.payload?.phase !== 'route-recovery'
      || journal.payload.ownerNonce !== ownerNonce
      || (requestId !== null && journal.payload.requestId !== requestId)) {
      return { ok: false, errorCode: C.RECOVERY_REQUIRED, message: 'Acer route recovery journal ownership changed' };
    }
    const cleanupOwner = crypto.randomUUID();
    const locked = await acquire({
      ownerNonce: cleanupOwner,
      pid: processApi.pid,
      requestId,
      packageFullName: ACER_PACKAGE_FULL_NAME,
      recovery: true,
    });
    let removedRouteRecovery = null;
    if (!locked.ok) return locked;
    let outcome;
    try {
      const current = await readJournal();
      if (current.none) outcome = { ok: true };
      else if (current.invalid || current.payload?.phase !== 'route-recovery'
        || current.payload.ownerNonce !== ownerNonce
        || (requestId !== null && current.payload.requestId !== requestId)) {
        outcome = { ok: false, errorCode: C.RECOVERY_REQUIRED, message: 'Acer route recovery journal ownership changed' };
      } else {
        removedRouteRecovery = clone(current.payload);
        retainedRouteRecovery = clone(removedRouteRecovery);
        outcome = { ok: true };
      }
    } catch (error) {
      outcome = { ok: false, errorCode: C.RECOVERY_REQUIRED, message: text(error) };
    }
    let released;
    try { released = await release(cleanupOwner); } catch (error) {
      released = { ok: false, errorCode: C.LOCK_FAILED, message: text(error) };
    }
    if (released?.ok !== true && outcome?.ok === true) {
      recoveryRequired = true;
      return { ok: false, errorCode: C.LOCK_FAILED, message: released?.message ?? 'Acer recovery cleanup lock release failed' };
    }
    if (outcome?.ok === true && removedRouteRecovery) {
      try {
        await remove(journalPath);
      } catch (error) {
        recoveryRequired = true;
        return { ok: false, errorCode: C.RECOVERY_REQUIRED, message: `Acer route recovery journal cleanup failed: ${text(error)}` };
      }
    }
    return outcome;
  }
  async function releaseReservation({ ownerNonce, retainRecoveryOnFailure = false } = {}) {
    if (typeof ownerNonce !== 'string' || lockNonce !== ownerNonce) return { ok: false, errorCode: C.LOCK_FAILED, message: 'Acer bridge reservation ownership changed' };
    if (reservationTimer) { clearTimeout(reservationTimer); reservationTimer = null; }
    const preserveRecovery = retainRecoveryOnFailure && retainedRouteRecovery;
    if (preserveRecovery) {
      const payload = clone(retainedRouteRecovery);
      payload.phase = 'route-recovery';
      payload.files = [];
      payload.ownedPids = [];
      try {
        await writeJournal(payload);
      } catch (error) {
        recoveryRequired = true;
        return { ok: false, errorCode: C.RECOVERY_REQUIRED, message: `Acer route recovery journal retention failed: ${text(error)}` };
      }
    }
    let released;
    try {
      released = await release(ownerNonce);
    } catch (error) {
      released = { ok: false, errorCode: C.LOCK_FAILED, message: text(error) };
    }
    active = false;
    reservationExpired = false;
    if (released?.ok !== true) {
      recoveryRequired = true;
      return released;
    }
    if (preserveRecovery) {
      const cleared = await clearRouteRecovery({ ownerNonce });
      if (cleared?.ok !== true) {
        recoveryRequired = true;
        return cleared;
      }
      retainedRouteRecovery = null;
    }
    return released;
  }


  async function apply({ deviceId, deviceKey, physicalTarget, requestedW, temperatureC, baseline = null, currentSettings = {}, log: requestLog, allowAcerBridge = deps.allowAcerBridge, acerPackagedApplyEnabled = deps.acerPackagedApplyEnabled, interactiveContext = deps.interactiveContext, leaveRequestedPair = false, reservation = null, retainReservation = false } = {}) {
    const reservationOwnerNonce = typeof reservation?.ownerNonce === 'string' ? reservation.ownerNonce : null;
    const writeLog = typeof requestLog === 'function' ? requestLog : log;
    const abandonReservation = async () => {
      if (!reservationOwnerNonce || lockNonce !== reservationOwnerNonce) return;
      if (retainReservation) return;
      if (reservationTimer) { clearTimeout(reservationTimer); reservationTimer = null; }
      reservationExpired = true;
      try { await release(reservationOwnerNonce); } finally { active = false; }
    };
    const reject = async (errorCode, message) => {
      await abandonReservation();
      return result(requestedW, errorCode, message, { rollback: { ok: true, untouched: true } });
    };
    const preJournalResult = (errorCode, message) => result(requestedW, errorCode, message, { rollback: { ok: true, untouched: true } });
    let journal;
    try {
      journal = await readJournal();
    } catch (error) {
      recoveryRequired = true;
      return preJournalResult(C.RECOVERY_REQUIRED, `Acer recovery journal could not be read: ${text(error)}`);
    }
    const journalOwnedByReservation = reservationOwnerNonce
      && journal.payload?.phase === 'route-recovery'
      && journal.payload.ownerNonce === reservationOwnerNonce;
    if (journal.invalid || (!journal.none && !journalOwnedByReservation)) {
      recoveryRequired = true;
      return preJournalResult(
        C.RECOVERY_REQUIRED,
        journal.invalid
          ? 'Acer recovery journal is invalid; recovery is required before any write'
          : 'Acer recovery journal is pending; recovery is required before any write',
      );
    }
    if (reservationOwnerNonce && (reservationExpired || !active || lockNonce !== reservationOwnerNonce)) {
      return preJournalResult(C.LOCK_BUSY, 'Acer packaged bridge reservation expired or is no longer owned');
    }
    if (active && (!reservationOwnerNonce || lockNonce !== reservationOwnerNonce)) return reject(C.LOCK_BUSY, 'another Acer packaged transaction is active');
    if (platform !== 'win32') return reject(C.UNSUPPORTED_PLATFORM, 'Acer packaged apply is supported only on Windows');
    if (!finite(requestedW)) return reject(C.INVALID_REQUEST, 'requestedW must be a finite number');
    if (recoveryRequired) return reject(C.RECOVERY_REQUIRED, 'Acer packaged apply is blocked until the previous transaction is recovered');
    if (allowAcerBridge !== true) return reject(C.NOT_OPTED_IN, 'Acer packaged apply is not enabled');
    if (acerPackagedApplyEnabled !== true) return reject(C.NOT_OPTED_IN, 'Acer packaged apply is not enabled');
    const context = interactiveContext;
    const verifier = deps.verifyInteractiveContext;
    if (!context || context.applyContext !== 'interactive'
      || typeof context.owner !== 'string' || context.owner.length === 0
      || typeof context.token !== 'string' || context.token.length < 16
      || typeof context.requestId !== 'string' || context.requestId.length < 8
      || context.requestBinding !== context.requestId
      || consumedContextTokens.has(context.token)
      || typeof verifier !== 'function') {
      return reject(C.NON_INTERACTIVE, 'Acer packaged apply requires a validated one-time interactive context');
    }
    const requiredHooks = [
      ['captureBaseline', deps.captureBaseline],
      ['verifyCoreVoltage', deps.verifyCoreVoltage],
      ['restoreCoreVoltage', deps.restoreCoreVoltage],
      ['restoreTemperature', deps.restoreTemperature],
      ['restoreFanState', deps.restoreFanState],
      ['verifyFinalState', deps.verifyFinalState],
      ['verifyAcerAbsoluteCoreVoltage', deps.verifyAcerAbsoluteCoreVoltage],
      ['setSysmanPair', deps.setSysmanPair],
    ];
    const missingHooks = requiredHooks.filter(([, hook]) => typeof hook !== 'function').map(([name]) => name);
    if (missingHooks.length > 0) {
      return reject(C.UNSUPPORTED, `required Acer baseline, Sysman, and final-state verification hooks are unavailable: ${missingHooks.join(', ')}`);
    }
    if (physicalTarget?.synthetic === true || physicalTarget?.backendKind === 'os') {
      return reject(C.DEVICE_NOT_SUPPORTED, 'the physical target is a read-only or synthetic GPU');
    }
    const pci = normalizePci(physicalTarget?.pciDeviceId ?? physicalTarget?.pciId ?? deps.pciDeviceId);
    const vendor = normalizePci(physicalTarget?.pciVendorId ?? physicalTarget?.vendorId ?? deps.pciVendorId);
    if (vendor !== '0x00008086' || pci !== ACER_A770_PCI_DEVICE_ID || physicalTarget?.displayCardIndex !== 0) {
      return reject(C.DEVICE_NOT_SUPPORTED, 'the physical target is not the supported Intel Arc A770 display card');
    }
    if (typeof deps.captureFileMetadata !== 'function'
      || typeof deps.restoreFileMetadata !== 'function'
      || typeof deps.verifyFileMetadata !== 'function') {
      return reject(C.UNSUPPORTED, 'Windows metadata/ACL capture, restore, and verification primitives are unavailable');
    }
    if (deps.requireFileMetadata !== true) {
      return reject(C.UNSUPPORTED, 'Windows metadata/ACL proof is required for Acer packaged apply');
    }
    if (leaveRequestedPair === true && typeof deps.setSysmanPair !== 'function') {
      return reject(C.UNSUPPORTED, 'requested Acer power finalization requires the physical-target Sysman setter');
    }
    let gate = ACER_ORDINARY_POWER_THRESHOLD_W;
    try {
      const candidate = typeof deps.deviceGateThresholds === 'function'
        ? Number(deps.deviceGateThresholds(deps.limitsKey ?? physicalTarget, false)?.plMax)
        : NaN;
      if (finite(candidate)) gate = candidate;
    } catch { /* malformed gate input is the safe ordinary threshold */ }
    if (requestedW <= ACER_ORDINARY_POWER_THRESHOLD_W || requestedW <= gate) {
      return reject(C.STOCK_THRESHOLD, `requested power must exceed the ordinary ${Math.max(ACER_ORDINARY_POWER_THRESHOLD_W, gate)} W path`);
    }
    // Reserve this bridge invocation synchronously before the first await.
    active = true;
    if (reservationOwnerNonce && reservationTimer) {
      clearTimeout(reservationTimer);
      reservationTimer = null;
    }
    let verifiedContext = false;
    try { verifiedContext = await verifier(context); } catch {}
    if (!verifiedContext) {
      await abandonReservation();
      active = false;
      return preJournalResult(C.NON_INTERACTIVE, 'Acer packaged apply requires a validated one-time interactive context');
    }
    consumedContextTokens.add(context.token);
    const installed = await packageInstalled();
    if (!installed.ok) { await abandonReservation(); active = false; return preJournalResult(installed.errorCode, installed.message); }
    const before = await snapshot();
    if (!before) { await abandonReservation(); active = false; return preJournalResult(C.PROCESS_SNAPSHOT_FAILED, 'Acer package process identity could not be established'); }
    if (before.length > 0) { await abandonReservation(); active = false; return preJournalResult(C.ALREADY_RUNNING, 'Acer must be closed before a packaged apply'); }
    const ownerNonce = reservationOwnerNonce ?? crypto.randomUUID();
    let journalPayload = null;
    let entries = [];
    let ownedPids = [];
    let cleanupFailure = null;
    let transactionSucceeded = false;
    let journalCommitted = false;
    let ownerReleased = false;
    let cleanupComplete = false;
    let journalRemovalPending = false;
    let ownerReleaseFailed = false;
    const finalizeCleaned = (cleaned) => {
      if (cleaned[cleanupCompleted] === true) {
        ownedPids = [];
        cleanupComplete = true;
        journalRemovalPending = true;
      } else cleanupFailure = cleaned;
      return cleaned;
    };
    let retainReservationOnCleanupFailure = false;
    try {
      const locked = reservationOwnerNonce
        ? (active && !reservationExpired && lockNonce === reservationOwnerNonce ? { ok: true } : { ok: false, errorCode: C.LOCK_BUSY, message: 'Acer packaged bridge reservation expired or is no longer owned' })
        : await acquire({ ownerNonce, pid: processApi.pid, requestId: context.requestId, packageFullName: ACER_PACKAGE_FULL_NAME });
      if (!locked.ok) {
        return preJournalResult(locked.errorCode, locked.message);
      }
      const oldJournal = await readJournal();
      const ownedRouteJournal = oldJournal?.payload?.phase === 'route-recovery'
        && reservationOwnerNonce
        && oldJournal.payload.ownerNonce === reservationOwnerNonce
        && oldJournal.payload.requestId === context.requestId;
      if (!oldJournal.none && !ownedRouteJournal) {
        const recovered = await recover({ lockHeld: true });
        if (!recovered.ok) {
          recoveryRequired = true;
          return preJournalResult(C.RECOVERY_REQUIRED, recovered.message);
        }
      }
      // The routed caller captures this state before any direct phase. Use it
      // when present; re-reading here would snapshot the post-write device and
      // make rollback restore the wrong values. Direct bridge callers without
      // a preflight state retain the authoritative capture hook.
      let capturedBaseline = baseline && typeof baseline === 'object'
        ? clone(baseline)
        : null;
      if (capturedBaseline) {
        const coreVoltage = capturedBaseline.coreVoltage
          ?? Object.fromEntries(['gpuFreqOffsetMhz', 'gpuVoltOffsetV'].filter((key) => key in capturedBaseline).map((key) => [key, capturedBaseline[key]]));
        const fan = capturedBaseline.fan
          ?? capturedBaseline.fanState
          ?? Object.fromEntries(['fanMode', 'fanCurve', 'fixedFanPct', 'vfCurve'].filter((key) => key in capturedBaseline).map((key) => [key, capturedBaseline[key]]));
        capturedBaseline = { ...capturedBaseline, coreVoltage, fan };
      }
      try {
        if (!capturedBaseline) {
          const captured = await deps.captureBaseline({ deviceId, deviceKey, physicalTarget, currentSettings });
          if (captured && typeof captured === 'object') capturedBaseline = clone(captured);
        }
      } catch (error) {
        return preJournalResult(C.READBACK_UNAVAILABLE, `Acer baseline capture failed: ${text(error)}`);
      }
      if (!capturedBaseline) {
        return preJournalResult(C.READBACK_UNAVAILABLE, 'the Acer baseline capture was unavailable');
      }
      const coreVoltage = capturedBaseline.coreVoltage;
      if (!coreVoltage || typeof coreVoltage !== 'object' || Object.keys(coreVoltage).length === 0
        || Object.values(coreVoltage).some((value) => !finite(value))) {
        return preJournalResult(C.READBACK_UNAVAILABLE, 'the live core/voltage baseline is unavailable');
      }
      const fanState = capturedBaseline.fan ?? capturedBaseline.fanState;
      if (!fanState || typeof fanState !== 'object' || Array.isArray(fanState)
        || !Object.keys(fanState).some((key) => fanState[key] !== null && fanState[key] !== undefined)) {
        return preJournalResult(C.READBACK_UNAVAILABLE, 'the effective fan baseline is unavailable');
      }
      const pair = await readPair(physicalTarget, deviceId, deviceKey);
      if (!pair) return preJournalResult(C.READBACK_UNAVAILABLE, 'the physical-target Sysman baseline pair is unavailable');
      if (typeof deps.setSysmanPair !== 'function' && !(pair.sustainedW === pair.burstW && typeof deps.rollbackViaAcer === 'function')) {
        return preJournalResult(C.ROLLBACK_FAILED, 'a proven physical-target rollback route is unavailable');
      }
      const stateForProfile = capturedBaseline;
      const liveCoreVoltage = stateForProfile.coreVoltage
        ?? Object.fromEntries(['coreClockMhz', 'gpuCoreClockMhz', 'gpuVoltOffsetV', 'gpuVoltageV', 'voltageV'].filter((key) => key in stateForProfile).map((key) => [key, stateForProfile[key]]));
      const capturedTemp = finite(stateForProfile.tempLimitC)
        ? stateForProfile.tempLimitC
        : (finite(stateForProfile.temperatureLimitC) ? stateForProfile.temperatureLimitC : null);
      const tempC = finite(temperatureC) ? temperatureC : capturedTemp;
      if (!finite(tempC)) return preJournalResult(C.READBACK_UNAVAILABLE, 'the effective Acer temperature baseline is unavailable');
      for (const filePath of [settingsPath, xmlPath]) {
        let raw; let stats; let metadata = null;
        try {
          await assertNoReparse(filePath);
          raw = await readRaw(filePath);
          stats = await statRaw(filePath);
          metadata = await deps.captureFileMetadata(filePath);
          if (!metadata || metadata.ok === false
            || typeof metadata.sddl !== 'string'
            || !Number.isInteger(metadata.attributes)
            || typeof metadata.creationFileTime !== 'string'
            || !/^\d+$/.test(metadata.creationFileTime)) return preJournalResult(C.FILE_UNAVAILABLE, `${filePath}: metadata/ACL proof unavailable`);
          if (!stats || !Number.isInteger(stats.mode) || !finite(stats.atimeMs) || !finite(stats.mtimeMs)) return preJournalResult(C.FILE_UNAVAILABLE, `${filePath}: file timestamp/mode metadata is unavailable`);
        } catch (error) { return preJournalResult(C.FILE_UNAVAILABLE, `${filePath}: ${text(error)}`); }
        entries.push({ path: filePath, originalBytes: raw.toString('base64'), originalHash: sha256(raw), temporaryHash: null, replaced: false, metadata, mode: stats.mode, atimeMs: stats.atimeMs, mtimeMs: stats.mtimeMs });
      }
      const settingsRaw = Buffer.from(entries[0].originalBytes, 'base64');
      const xmlRaw = Buffer.from(entries[1].originalBytes, 'base64');
      const settingsDecoded = decodeBytes(settingsRaw);
      const xmlDecoded = decodeBytes(xmlRaw);
      let settings;
      try { settings = parseJsonUnique(settingsDecoded.text); } catch (error) { return preJournalResult(C.FILE_PARSE_FAILED, `Settings.json is not valid JSON: ${text(error)}`); }
      const selected = selectedProfileName(settings);
      if (!selectedTargetMatches(settings, physicalTarget)) return preJournalResult(C.DEVICE_NOT_SUPPORTED, 'Acer Settings.json does not map to the selected physical A770 target');
      if (!selected) return preJournalResult(C.FILE_SHAPE_AMBIGUOUS, 'Settings.json has no unique selected Acer profile');
      const bridgeName = bridgeProfileName(selected, requestedW);
      if (!wellFormedXml(xmlDecoded.text)) return preJournalResult(C.FILE_PARSE_FAILED, 'Acer profile XML failed well-formedness validation');
      const profileCoreVoltage = profileCoreVoltageOf(xmlDecoded.text, selected);
      if (!hasUsableAbsoluteCoreVoltage(profileCoreVoltage)) return preJournalResult(C.READBACK_UNAVAILABLE, 'Acer XML selected profile has no usable absolute core/voltage baseline');
      const absoluteBaseline = await verifyAcerAbsolute({ expected: profileCoreVoltage, baseline: capturedBaseline, deviceId, deviceKey, physicalTarget, phase: 'preflight' });
      if (!verificationOk(absoluteBaseline)) return preJournalResult(C.READBACK_UNAVAILABLE, absoluteBaseline?.message ?? 'Acer absolute core/voltage readback is unavailable');
      const completeCoreVoltage = { ...profileCoreVoltage, ...liveCoreVoltage };
      capturedBaseline.coreVoltageProfile = clone(profileCoreVoltage);
      const changedSettings = transformSettings(settings, selected, bridgeName, requestedW, tempC, completeCoreVoltage);
      if (!changedSettings.ok) return preJournalResult(C.FILE_SHAPE_AMBIGUOUS, changedSettings.reason);
      const changedXml = transformXml(xmlDecoded.text, selected, bridgeName, requestedW, tempC, completeCoreVoltage);
      if (!changedXml.ok || !wellFormedXml(changedXml.text)) return preJournalResult(C.FILE_PARSE_FAILED, changedXml.reason ?? 'generated Acer profile XML failed validation');
      const temporary = [
        encodeBytes(settingsDecoded, JSON.stringify(changedSettings.value, null, 2)),
        encodeBytes(xmlDecoded, changedXml.text),
      ];
      // Validate complete generated documents and cross-file selection mapping.
      let generatedSettings;
      try { generatedSettings = parseJsonUnique(decodeBytes(temporary[0]).text); } catch { return preJournalResult(C.FILE_PARSE_FAILED, 'generated Settings.json failed validation'); }
      if (selectedProfileName(generatedSettings) !== bridgeName
        || profileNodes(decodeBytes(temporary[1]).text).filter((node) => node.name === selected).length !== 1
        || profileNodes(decodeBytes(temporary[1]).text).filter((node) => node.name === bridgeName).length !== 1) {
        return preJournalResult(C.FILE_PARSE_FAILED, 'generated Acer documents have an incoherent selected-profile mapping');
      }
      const generatedProfile = profileList(generatedSettings, bridgeName);
      if (generatedProfile.ambiguous
        || (generatedProfile.value && generatedProfile.value.filter((entry) => Object.values(entry).some((value) => value === bridgeName)).length !== 1)) {
        return preJournalResult(C.FILE_PARSE_FAILED, 'generated Settings.json profile reference is ambiguous');
      }
      const state = { ...capturedBaseline, power: pair };
      journalPayload = { ownerNonce, ownerPid: processApi.pid, packageFullName: ACER_PACKAGE_FULL_NAME, packageVersion: ACER_PACKAGE_VERSION, deviceId, deviceKey: deviceKey ?? null, phase: 'prepared', requestedW, physicalTarget: clone(physicalTarget), ownedPids: [], baseline: state, files: entries };
      await writeJournal(journalPayload);
      const preparationSnapshot = await snapshot();
      if (!preparationSnapshot) {
        cleanupFailure = { ok: false, errorCode: C.PROCESS_SNAPSHOT_FAILED, message: 'Acer process identity could not be established before file mutation' };
        return result(requestedW, C.PROCESS_SNAPSHOT_FAILED, cleanupFailure.message);
      }
      if (preparationSnapshot.length > 0) {
        cleanupFailure = { ok: false, errorCode: C.ALREADY_RUNNING, message: 'Acer started before file mutation; refusing activation' };
        return result(requestedW, C.ALREADY_RUNNING, cleanupFailure.message);
      }
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const quietBefore = await assertQuiescent(`file replacement ${entry.path}`);
        if (!quietBefore.ok) {
          cleanupFailure = quietBefore;
          return result(requestedW, quietBefore.errorCode, quietBefore.message);
        }
        const currentHash = sha256(await readRaw(entry.path));
        if (currentHash !== entry.originalHash) return result(requestedW, C.FILE_MODIFIED, `${entry.path} changed before replacement`);
        entry.temporaryHash = sha256(temporary[i]);
        journalPayload.phase = i === 0 ? 'settings-replaced' : 'xml-replaced';
        entry.replaced = true;
        // The journal must describe the bytes that may be present BEFORE
        // the replacement starts. A crash between rename and the next
        // journal write is therefore recoverable without guessing.
        await writeJournal(journalPayload);
        const quietImmediatelyBefore = await assertQuiescent(`file replacement ${entry.path}`);
        if (!quietImmediatelyBefore.ok) {
          cleanupFailure = quietImmediatelyBefore;
          return result(requestedW, quietImmediatelyBefore.errorCode, quietImmediatelyBefore.message);
        }
        const finalHash = sha256(await readRaw(entry.path));
        if (finalHash !== entry.originalHash) return result(requestedW, C.FILE_MODIFIED, `${entry.path} changed before replacement`);
        await writeAtomic(entry.path, temporary[i], { metadata: entry.metadata, mode: entry.mode, atimeMs: entry.atimeMs, mtimeMs: entry.mtimeMs });
      }
      const quietBeforeActivationFiles = await assertQuiescent('activation file verification');
      if (!quietBeforeActivationFiles.ok) {
        cleanupFailure = quietBeforeActivationFiles;
        return result(requestedW, quietBeforeActivationFiles.errorCode, quietBeforeActivationFiles.message);
      }
      for (const entry of entries) {
        const currentHash = sha256(await readRaw(entry.path));
        if (currentHash !== entry.temporaryHash) {
          cleanupFailure = { ok: false, errorCode: C.FILE_MODIFIED, message: `${entry.path} changed before activation` };
          return result(requestedW, C.FILE_MODIFIED, cleanupFailure.message);
        }
        const metadata = await deps.verifyFileMetadata(entry.path, entry.metadata);
        if (metadata !== true && metadata?.ok !== true) {
          cleanupFailure = { ok: false, errorCode: C.FILE_MODIFIED, message: `${entry.path} metadata changed before activation` };
          return result(requestedW, C.FILE_MODIFIED, cleanupFailure.message);
        }
      }
      const beforeActivation = await snapshot();
      if (!beforeActivation) {
        cleanupFailure = { ok: false, errorCode: C.PROCESS_SNAPSHOT_FAILED, message: 'Acer process identity could not be established immediately before activation' };
        return result(requestedW, C.PROCESS_SNAPSHOT_FAILED, cleanupFailure.message);
      }
      if (beforeActivation.length > 0) {
        cleanupFailure = { ok: false, errorCode: C.ALREADY_RUNNING, message: 'Acer started during profile replacement; refusing activation' };
        return result(requestedW, C.ALREADY_RUNNING, cleanupFailure.message);
      }
      journalPayload.phase = 'activation-pending';
      journalPayload.ownedPids = [];
      await writeJournal(journalPayload);
      let activated;
      try {
        activated = await activate(ACER_PACKAGE_SHELL_IDENTITY, { packageFullName: ACER_PACKAGE_FULL_NAME, packageVersion: ACER_PACKAGE_VERSION, requestId: context.requestId });
      } catch (error) {
        cleanupFailure = { ok: false, errorCode: C.ACTIVATION_FAILED, message: `Acer package activation failed: ${text(error)}` };
        return result(requestedW, C.ACTIVATION_FAILED, cleanupFailure.message);
      }
      if (activated?.ok !== true) {
        cleanupFailure = { ok: false, errorCode: C.ACTIVATION_FAILED, message: activated?.message ?? 'Acer package activation was not acknowledged' };
        return result(requestedW, C.ACTIVATION_FAILED, cleanupFailure.message);
      }
      const activationPid = Number(activated.activationPid);
      if (!Number.isInteger(activationPid) || activationPid <= 0) {
        cleanupFailure = { ok: false, errorCode: C.PROCESS_SNAPSHOT_FAILED, message: 'Acer activation did not return a bound process identity' };
        return result(requestedW, C.PROCESS_SNAPSHOT_FAILED, cleanupFailure.message);
      }
      if (!finite(activated?.activationStartedAt) || activated.activationStartedAt > now()) {
        cleanupFailure = { ok: false, errorCode: C.PROCESS_SNAPSHOT_FAILED, message: 'Acer activation did not return a valid launch provenance marker' };
        return result(requestedW, C.PROCESS_SNAPSHOT_FAILED, cleanupFailure.message);
      }
      const afterRaw = await snapshot();
      const after = afterRaw ? excludePreexistingBrokers(afterRaw, activated.activationStartedAt) : null;
      if (!after) {
        cleanupFailure = { ok: false, errorCode: C.PROCESS_SNAPSHOT_FAILED, message: 'post-activation Acer process identity could not be established' };
        return result(requestedW, C.PROCESS_SNAPSHOT_FAILED, cleanupFailure.message);
      }
      const activatedSnapshotRaw = normalizeSnapshot(activated?.processes ?? activated?.pids);
      const activatedSnapshot = activatedSnapshotRaw ? excludePreexistingBrokers(activatedSnapshotRaw, activated.activationStartedAt) : null;
      if (!activatedSnapshot || activatedSnapshot.length === 0
        || activatedSnapshot.some((item) => typeof item.creationDate !== 'string' || item.creationDate.length === 0
          || creationTimeMs(item.creationDate) === null
          || creationTimeMs(item.creationDate) < activated.activationStartedAt
          || creationTimeMs(item.creationDate) > now()
          || typeof item.executablePath !== 'string' || item.executablePath.length === 0
          || item.packageFullName !== ACER_PACKAGE_FULL_NAME)) {
        cleanupFailure = { ok: false, errorCode: C.PROCESS_SNAPSHOT_FAILED, message: 'Acer activation did not return attributable post-launch process identities' };
        return result(requestedW, C.PROCESS_SNAPSHOT_FAILED, cleanupFailure.message);
      }
      const packageRoots = (list) => list.filter((item) => item?.processKind === 'package' || item?.processKind === undefined);
      const activatedRoots = packageRoots(activatedSnapshot);
      const afterRoots = packageRoots(after);
      if (activatedRoots.length !== 1 || afterRoots.length !== 1
        || activatedRoots[0].pid !== activationPid
        || activatedRoots[0].pid !== afterRoots[0].pid
        || activatedRoots[0].creationDate !== afterRoots[0].creationDate
        || activatedRoots[0].executablePath?.toLowerCase() !== afterRoots[0].executablePath?.toLowerCase()) {
        cleanupFailure = { ok: false, errorCode: C.UNKNOWN_PROCESS, message: 'Acer activation produced an unowned or ambiguous package-root process' };
        return result(requestedW, C.UNKNOWN_PROCESS, cleanupFailure.message);
      }
      const activatedByPid = new Map(activatedSnapshot.map((item) => [item.pid, item]));
      const afterIds = new Set(after.map((item) => item.pid));
      if (activatedSnapshot.some((item) => !afterIds.has(item.pid))) {
        cleanupFailure = { ok: false, errorCode: C.ACTIVATION_FAILED, message: 'an attributed Acer process exited before ownership was established' };
        return result(requestedW, C.ACTIVATION_FAILED, cleanupFailure.message);
      }
      if (after.some((item) => {
        const proof = activatedByPid.get(item.pid);
        return !proof
          || proof.creationDate !== item.creationDate
          || proof.executablePath.toLowerCase() !== item.executablePath.toLowerCase()
          || item.packageFullName !== ACER_PACKAGE_FULL_NAME;
      })) {
        cleanupFailure = { ok: false, errorCode: C.UNKNOWN_PROCESS, message: 'an unknown Acer process appeared during activation' };
        return result(requestedW, C.UNKNOWN_PROCESS, cleanupFailure.message);
      }
      ownedPids = after.map((item) => ({ ...item, ownerNonce }));
      if (ownedPids.length === 0) {
        cleanupFailure = { ok: false, errorCode: C.ACTIVATION_FAILED, message: 'Acer activation produced no attributable process' };
        return result(requestedW, C.ACTIVATION_FAILED, cleanupFailure.message);
      }
      journalPayload.phase = 'activated';
      journalPayload.ownedPids = ownedPids;
      await writeJournal(journalPayload);
      const hide = packageBridge?.hideWindow ?? deps.hideWindow;
      if (typeof hide !== 'function') return result(requestedW, C.WINDOW_FAILED, 'owned Acer window verification is unavailable');
      const hidden = await hide(ownedPids.map((item) => item.pid), { packageFullName: ACER_PACKAGE_FULL_NAME, packageRoot: installed.value?.installLocation ?? '', ownerNonce, identities: ownedPids });
      if (hidden?.ok !== true || hidden?.noWindow === true) return result(requestedW, C.WINDOW_FAILED, hidden?.message ?? 'owned Acer activation produced no controllable window');
      const coreVerified = await deps.verifyCoreVoltage({ baseline: journalPayload.baseline, deviceId, deviceKey, physicalTarget });
      if (!verificationOk(coreVerified)) return result(requestedW, C.STATE_CHANGED, coreVerified?.message ?? 'Acer changed the captured core or voltage state');
      const absoluteCoreVerified = await verifyAcerAbsolute({ baseline: journalPayload.baseline, deviceId, deviceKey, physicalTarget });
      if (!verificationOk(absoluteCoreVerified)) return result(requestedW, C.STATE_CHANGED, absoluteCoreVerified?.message ?? 'Acer absolute core/voltage hardware verification failed');
      const deadline = now() + (finite(deps.readbackTimeoutMs) ? deps.readbackTimeoutMs : 5000);
      let observed = null;
      while (now() <= deadline) {
        observed = await readPair(physicalTarget, deviceId, deviceKey);
        if (observed && observed.sustainedW === requestedW && observed.burstW === requestedW) break;
        await sleep(Math.min(100, Math.max(1, deadline - now())));
      }
      if (!observed || observed.sustainedW !== requestedW || observed.burstW !== requestedW) {
        const code = observed ? C.READBACK_MISMATCH : C.READBACK_TIMEOUT;
        const failed = result(requestedW, code, observed ? `Acer requested ${requestedW} W but Sysman read back ${observed.sustainedW}/${observed.burstW} W` : 'physical-target Sysman read-back timed out', { readBackEqual: false, observed });
        const cleaned = await cleanupFailedTransaction({ payload: journalPayload, ownedPids, deviceId, entries, observed, failure: failed });
        return finalizeCleaned(cleaned);
      }
      const terminated = await terminateOwned(ownedPids);
      if (!terminated.ok) { cleanupFailure = terminated; return result(requestedW, C.TERMINATION_FAILED, terminated.message, { observed }); }
      ownedPids = [];
      const quietAfterTermination = await assertQuiescent('success restore');
      if (!quietAfterTermination.ok) {
        cleanupFailure = quietAfterTermination;
        return result(requestedW, quietAfterTermination.errorCode, quietAfterTermination.message, { observed, rollback: { required: true } });
      }
      const rolled = await rollbackBaseline(journalPayload, deviceId);
      if (!rolled.ok) {
        cleanupFailure = rolled;
        return result(requestedW, C.ROLLBACK_FAILED, rolled.message, { observed, rollback: { required: true } });
      }
      const core = await deps.restoreCoreVoltage(journalPayload.baseline?.coreVoltage ?? null, { deviceId, deviceKey, physicalTarget });
      if (!verificationOk(core)) { cleanupFailure = core; return result(requestedW, C.RESTORE_FAILED, core?.message ?? 'core/voltage restore failed', { observed }); }
      const quietBeforeTemperature = await assertQuiescent('success temperature restore');
      if (!quietBeforeTemperature.ok) {
        cleanupFailure = quietBeforeTemperature;
        return result(requestedW, quietBeforeTemperature.errorCode, quietBeforeTemperature.message, { observed, rollback: { required: true } });
      }
      const temperature = await deps.restoreTemperature(journalPayload.baseline?.tempLimitC ?? journalPayload.baseline?.temperatureLimitC ?? null, { deviceId, deviceKey, physicalTarget });
      if (!verificationOk(temperature)) { cleanupFailure = temperature; return result(requestedW, C.RESTORE_FAILED, temperature?.message ?? 'temperature restore failed', { observed }); }
      const quietBeforeFan = await assertQuiescent('success fan restore');
      if (!quietBeforeFan.ok) {
        cleanupFailure = quietBeforeFan;
        return result(requestedW, quietBeforeFan.errorCode, quietBeforeFan.message, { observed, rollback: { required: true } });
      }
      const fan = await deps.restoreFanState(journalPayload.baseline?.fan ?? journalPayload.baseline?.fanState ?? null, { deviceId, deviceKey, physicalTarget });
      if (!verificationOk(fan)) { cleanupFailure = fan; return result(requestedW, C.RESTORE_FAILED, fan?.message ?? 'fan restore failed', { observed }); }
      for (const entry of entries) {
        const quietBeforeFile = await assertQuiescent(`success file restore ${entry.path}`);
        if (!quietBeforeFile.ok) {
          cleanupFailure = quietBeforeFile;
          return result(requestedW, quietBeforeFile.errorCode, quietBeforeFile.message, { observed, rollback: { required: true } });
        }
        const restored = await restoreFile(entry);
        if (!restored.ok) { cleanupFailure = restored; return result(requestedW, C.RESTORE_FAILED, restored.message, { observed }); }
      }
      const quietBeforeFinalVerify = await assertQuiescent('success final verification');
      if (!quietBeforeFinalVerify.ok) {
        cleanupFailure = quietBeforeFinalVerify;
        return result(requestedW, quietBeforeFinalVerify.errorCode, quietBeforeFinalVerify.message, { observed, rollback: { required: true } });
      }
      const finalObserved = await readPair(physicalTarget, deviceId, deviceKey);
      const baselinePair = pairOf(journalPayload.baseline?.power);
      if (!equalPair(finalObserved, baselinePair)) {
        const failure = result(requestedW, C.READBACK_MISMATCH, 'final physical-target power read-back did not match the restored baseline pair', { observed, finalObserved, readBackEqual: false });
        const cleaned = await cleanupFailedTransaction({ payload: journalPayload, ownedPids, deviceId, entries, observed: finalObserved, failure });
        return finalizeCleaned(cleaned);
      }
      const verified = await deps.verifyFinalState({ baseline: journalPayload.baseline, expectedPower: baselinePair, deviceId, deviceKey, physicalTarget });
      if (!verificationOk(verified)) {
        const failure = result(requestedW, C.STATE_CHANGED, verified?.message ?? 'final core/voltage/fan verification failed', { observed, finalObserved });
        const cleaned = await cleanupFailedTransaction({ payload: journalPayload, ownedPids, deviceId, entries, observed: finalObserved, failure });
        return finalizeCleaned(cleaned);
      }
      const absoluteFinalVerified = await verifyAcerAbsolute({ baseline: journalPayload.baseline, deviceId, deviceKey, physicalTarget });
      if (!verificationOk(absoluteFinalVerified)) {
        const failure = result(requestedW, C.STATE_CHANGED, absoluteFinalVerified?.message ?? 'Acer absolute core/voltage final verification failed', { observed, finalObserved });
        const cleaned = await cleanupFailedTransaction({ payload: journalPayload, ownedPids, deviceId, entries, observed: finalObserved, failure });
        return finalizeCleaned(cleaned);
      }
      if (leaveRequestedPair === true) {
        const requestedPair = { sustainedW: requestedW, burstW: requestedW };
        const quietBeforeRequested = await assertQuiescent('requested pair finalization');
        if (!quietBeforeRequested.ok) {
          const failure = result(requestedW, quietBeforeRequested.errorCode, quietBeforeRequested.message, { observed, finalObserved, readBackEqual: false });
          const cleaned = await cleanupFailedTransaction({ payload: journalPayload, ownedPids, deviceId, entries, observed: finalObserved, failure });
          return finalizeCleaned(cleaned);
        }
        const requestedSet = await setPair(physicalTarget, deviceId, requestedPair, deviceKey);
        const quietAfterRequested = await assertQuiescent('requested pair finalization');
        if (!quietAfterRequested.ok) {
          const failure = result(requestedW, quietAfterRequested.errorCode, quietAfterRequested.message, { observed, finalObserved, readBackEqual: false });
          const cleaned = await cleanupFailedTransaction({ payload: journalPayload, ownedPids, deviceId, entries, observed: finalObserved, failure });
          return finalizeCleaned(cleaned);
        }
        const requestedObserved = await readPair(physicalTarget, deviceId, deviceKey);
        if (requestedSet?.ok !== true || !equalPair(requestedObserved, requestedPair)) {
          const failure = result(
            requestedW,
            requestedSet?.errorCode ?? C.READBACK_MISMATCH,
            requestedSet?.message ?? `final physical-target power read-back did not match requested ${requestedW}/${requestedW} W`,
            { observed: requestedObserved, restoredBaseline: finalObserved, readBackEqual: false },
          );
          const cleaned = await cleanupFailedTransaction({
            payload: journalPayload,
            ownedPids,
            deviceId,
            entries,
            observed: requestedObserved,
            failure,
          });
          return finalizeCleaned(cleaned);
        }
        observed = requestedObserved;
      }
      const finalFileBoundary = await assertQuiescent('success final file verification');
      if (!finalFileBoundary.ok) {
        const failure = result(requestedW, finalFileBoundary.errorCode, finalFileBoundary.message, { observed, finalObserved, readBackEqual: true });
        const cleaned = await cleanupFailedTransaction({ payload: journalPayload, ownedPids, deviceId, entries, observed: finalObserved, failure });
        return finalizeCleaned(cleaned);
      }
      for (const entry of entries) {
        const verifiedFile = await verifyRestoredFile(entry);
        if (!verifiedFile.ok) {
          const failure = result(requestedW, verifiedFile.errorCode, verifiedFile.message, { observed, finalObserved, readBackEqual: true });
          const cleaned = await cleanupFailedTransaction({ payload: journalPayload, ownedPids, deviceId, entries, observed: finalObserved, failure });
          return finalizeCleaned(cleaned);
        }
      }
      const finalHardwareBoundary = await assertQuiescent('final hardware verification');
      if (!finalHardwareBoundary.ok) {
        const failure = result(requestedW, finalHardwareBoundary.errorCode, finalHardwareBoundary.message, { observed, finalObserved, readBackEqual: true });
        const cleaned = await cleanupFailedTransaction({ payload: journalPayload, ownedPids, deviceId, entries, observed: finalObserved, failure });
        return finalizeCleaned(cleaned);
      }
      const lastExpectedPower = leaveRequestedPair ? { sustainedW: requestedW, burstW: requestedW } : baselinePair;
      const lastObserved = await readPair(physicalTarget, deviceId, deviceKey);
      if (!equalPair(lastObserved, lastExpectedPower)) {
        const failure = result(requestedW, C.READBACK_MISMATCH, 'final physical-target power read-back changed before journal removal', { observed: lastObserved, finalObserved, readBackEqual: false });
        const cleaned = await cleanupFailedTransaction({ payload: journalPayload, ownedPids, deviceId, entries, observed: lastObserved, failure });
        return finalizeCleaned(cleaned);
      }
      const lastVerified = await deps.verifyFinalState({ baseline: journalPayload.baseline, expectedPower: lastExpectedPower, deviceId, deviceKey, physicalTarget });
      if (!verificationOk(lastVerified)) {
        const failure = result(requestedW, C.STATE_CHANGED, lastVerified?.message ?? 'final hardware state changed before journal removal', { observed: lastObserved, finalObserved });
        const cleaned = await cleanupFailedTransaction({ payload: journalPayload, ownedPids, deviceId, entries, observed: lastObserved, failure });
        return finalizeCleaned(cleaned);
      }
      const lastAbsolute = await verifyAcerAbsolute({ baseline: journalPayload.baseline, deviceId, deviceKey, physicalTarget });
      if (!verificationOk(lastAbsolute)) {
        const failure = result(requestedW, C.STATE_CHANGED, lastAbsolute?.message ?? 'absolute core/voltage state changed before journal removal', { observed: lastObserved, finalObserved });
        const cleaned = await cleanupFailedTransaction({ payload: journalPayload, ownedPids, deviceId, entries, observed: lastObserved, failure });
        return finalizeCleaned(cleaned);
      }
      const finalRemovalBoundary = await assertQuiescent('journal removal');
      if (!finalRemovalBoundary.ok) {
        const failure = result(requestedW, finalRemovalBoundary.errorCode, finalRemovalBoundary.message, { observed, finalObserved, readBackEqual: true });
        const cleaned = await cleanupFailedTransaction({ payload: journalPayload, ownedPids, deviceId, entries, observed: finalObserved, failure });
        return finalizeCleaned(cleaned);
      }
      for (const entry of entries) {
        const finalFile = await verifyRestoredFile(entry);
        if (!finalFile.ok) {
          const failure = result(requestedW, finalFile.errorCode, finalFile.message, { observed, finalObserved, readBackEqual: true });
          const cleaned = await cleanupFailedTransaction({ payload: journalPayload, ownedPids, deviceId, entries, observed: finalObserved, failure });
          return finalizeCleaned(cleaned);
        }
      }
      journalPayload.phase = 'committed';
      journalPayload.ownedPids = [];
      await writeJournal(journalPayload);
      journalCommitted = true;
      if (retainReservation) {
        // The routed apply owns the reservation through its post-bridge
        // fan/VF phase. Keep the committed journal and lock for the caller;
        // finally() converts the journal to route-recovery.
        transactionSucceeded = true;
        writeLog(`[acer-bridge] applied ${requestedW} W with exact ${observed.sustainedW}/${observed.burstW} W read-back`);
        return success(requestedW, observed, { restoredBaseline: finalObserved });
      }
      // Keep the committed journal authoritative through owner-lock release.
      // Reservations refuse while any journal exists, so a successor cannot
      // create a replacement journal before this transaction removes it.
      let released;
      try {
        released = await release(ownerNonce);
      } catch (error) {
        released = { ok: false, errorCode: C.LOCK_FAILED, message: text(error) };
      }
      ownerReleased = true;
      if (!released.ok) {
        cleanupFailure = released;
        recoveryRequired = true;
        try {
          journalPayload.phase = 'recovery-required';
          journalPayload.ownedPids = ownedPids;
          await writeJournal(journalPayload);
        } catch {}
        return result(requestedW, C.LOCK_FAILED, released.message, { rollback: { required: true } });
      }
      try {
        await remove(journalPath);
      } catch (error) {
        cleanupFailure = {
          ok: false,
          errorCode: C.RECOVERY_REQUIRED,
          message: `Acer committed journal cleanup failed: ${text(error)}`,
        };
        recoveryRequired = true;
        try {
          journalPayload.phase = 'recovery-required';
          journalPayload.ownedPids = ownedPids;
          await writeJournal(journalPayload);
        } catch {}
        return result(requestedW, C.RECOVERY_REQUIRED, cleanupFailure.message, { rollback: { required: true } });
      }
      transactionSucceeded = true;
      writeLog(`[acer-bridge] applied ${requestedW} W with exact ${observed.sustainedW}/${observed.burstW} W read-back`);
      return success(requestedW, observed, { restoredBaseline: finalObserved });
    } catch (error) {
      return result(requestedW, C.RECOVERY_REQUIRED, text(error), { rollback: { required: true } });
    } finally {
      if (journalPayload && !transactionSucceeded && !cleanupFailure && !journalCommitted && !cleanupComplete) {
        if (ownedPids.length > 0) {
          const terminated = await terminateOwned(ownedPids);
          if (!terminated.ok) cleanupFailure = terminated;
          else ownedPids = [];
        }
        if (!cleanupFailure) {
          const quiet = await assertQuiescent('transaction cleanup');
          if (!quiet.ok) cleanupFailure = quiet;
        }
        if (!cleanupFailure) {
          let rollbackOk = true;
          if (['activation-pending', 'activated', 'rollback-activation-pending', 'rollback-activated'].includes(journalPayload.phase)) {
            const rolled = await rollbackBaseline(journalPayload, deviceId);
            rollbackOk = rolled.ok;
            if (!rollbackOk) cleanupFailure = rolled;
          }
          if (rollbackOk) {
            const quietBeforeCore = await assertQuiescent('transaction core/voltage restore');
            if (!quietBeforeCore.ok) cleanupFailure = quietBeforeCore;
            if (!cleanupFailure) try {
              const core = await deps.restoreCoreVoltage(journalPayload.baseline?.coreVoltage ?? null, { deviceId, deviceKey: journalPayload.deviceKey ?? null, physicalTarget: journalPayload.physicalTarget });
              if (!verificationOk(core)) cleanupFailure = core;
              if (!cleanupFailure) {
                const quietBeforeTemperature = await assertQuiescent('transaction temperature restore');
                if (!quietBeforeTemperature.ok) cleanupFailure = quietBeforeTemperature;
              }
              if (!cleanupFailure) {
                const temperature = await deps.restoreTemperature(journalPayload.baseline?.tempLimitC ?? journalPayload.baseline?.temperatureLimitC ?? null, { deviceId, deviceKey: journalPayload.deviceKey ?? null, physicalTarget: journalPayload.physicalTarget });
                if (!verificationOk(temperature)) cleanupFailure = temperature;
              }
              if (!cleanupFailure) {
                const quietBeforeFan = await assertQuiescent('transaction fan restore');
                if (!quietBeforeFan.ok) cleanupFailure = quietBeforeFan;
              }
              if (!cleanupFailure) {
                const fan = await deps.restoreFanState(journalPayload.baseline?.fan ?? journalPayload.baseline?.fanState ?? null, { deviceId, deviceKey: journalPayload.deviceKey ?? null, physicalTarget: journalPayload.physicalTarget });
                if (!verificationOk(fan)) cleanupFailure = fan;
              }
              if (!cleanupFailure) {
                for (const entry of entries) {
                  const quietBeforeFile = await assertQuiescent(`transaction file restore ${entry.path}`);
                  if (!quietBeforeFile.ok) { cleanupFailure = quietBeforeFile; break; }
                  const restored = await restoreFile(entry);
                  if (!restored.ok) { cleanupFailure = restored; break; }
                }
              }
              if (!cleanupFailure) {
                const verified = await deps.verifyFinalState({ baseline: journalPayload.baseline, expectedPower: journalPayload.baseline?.power, deviceId, deviceKey: journalPayload.deviceKey ?? null, physicalTarget });
                if (!verificationOk(verified)) cleanupFailure = { ok: false, errorCode: C.STATE_CHANGED, message: verified?.message ?? 'final cleanup verification failed' };
              }
              if (!cleanupFailure) {
                const finalQuiet = await assertQuiescent('transaction journal removal');
                if (!finalQuiet.ok) cleanupFailure = finalQuiet;
              }
              if (!cleanupFailure) await remove(journalPath);
            } catch (error) { cleanupFailure = { ok: false, errorCode: C.RESTORE_FAILED, message: text(error) }; }
          }
        }
      } else if (journalPayload && !transactionSucceeded && ownedPids.length > 0) {
        const terminated = await terminateOwned(ownedPids);
        if (!terminated.ok) cleanupFailure = terminated;
        else ownedPids = [];
      }
      if (cleanupFailure && journalPayload) {
        recoveryRequired = true;
        try {
          journalPayload.phase = 'recovery-required';
          journalPayload.ownedPids = ownedPids;
          await writeJournal(journalPayload);
        } catch {}
      }
      if (journalPayload && transactionSucceeded && !cleanupFailure && retainReservation) {
        const routeRecoveryFiles = journalPayload.files;
        journalPayload.phase = 'route-recovery';
        journalPayload.files = [];
        journalPayload.ownedPids = [];
        try {
          await writeJournal(journalPayload);
        } catch (error) {
          cleanupFailure = {
            ok: false,
            errorCode: C.RECOVERY_REQUIRED,
            message: `durable route recovery journal write failed: ${text(error)}`,
          };
          recoveryRequired = true;
          retainReservationOnCleanupFailure = true;
          try {
            journalPayload.phase = 'recovery-required';
            journalPayload.files = routeRecoveryFiles;
            await writeJournal(journalPayload);
          } catch {}
        }
      }
      const retainRouteReservation = retainReservation && journalPayload && transactionSucceeded
        && (!cleanupFailure || retainReservationOnCleanupFailure);
      if (!retainRouteReservation && !ownerReleased) {
        let released;
        try { released = await release(ownerNonce); } catch (error) {
          released = { ok: false, errorCode: C.LOCK_FAILED, message: text(error) };
        }
        ownerReleased = true;
        ownerReleaseFailed = !released.ok;
        if (!released.ok) {
          recoveryRequired = true;
          cleanupFailure = released;
          if (journalPayload) {
            try {
              journalPayload.phase = 'recovery-required';
              journalPayload.ownedPids = ownedPids;
              await writeJournal(journalPayload);
            } catch {}
          }
        }
        active = false;
      } else if (!retainRouteReservation) {
        active = false;
      }
      if (journalRemovalPending && journalPayload && ownerReleased && !ownerReleaseFailed && !cleanupFailure) {
        try {
          await remove(journalPath);
          journalPayload = null;
          journalRemovalPending = false;
        } catch (error) {
          cleanupFailure = {
            ok: false,
            errorCode: C.RECOVERY_REQUIRED,
            message: `Acer cleanup journal removal failed: ${text(error)}`,
          };
          recoveryRequired = true;
          try {
            journalPayload.phase = 'recovery-required';
            journalPayload.ownedPids = ownedPids;
            await writeJournal(journalPayload);
          } catch {}
          return result(requestedW, C.RECOVERY_REQUIRED, cleanupFailure.message, { rollback: { required: true } });
        }
      }
      if (retainReservationOnCleanupFailure) {
        throw new Error(cleanupFailure?.message ?? 'durable route recovery journal write failed');
      }
    }
  }
  return { apply, preflight, reserve, releaseReservation, prepareRouteRecovery, clearPreparedRouteRecovery, clearRouteRecovery, persistRecovery, recover, recovery: recover, isRecoveryRequired: () => recoveryRequired, markRecoveryRequired: () => { recoveryRequired = true; }, assertQuiescent: () => assertQuiescent('external rollback'), resolveHelper: () => resolveAcerPackagedHelper() };
}

export async function recoverAcerPackagedBridge(deps = {}) {
  try { return await createAcerPackagedBridge(deps).recover(); }
  catch (error) { return { ok: false, recovered: false, errorCode: C.RECOVERY_REQUIRED, message: text(error) }; }
}

// Kept for consumers that need to inspect the fixed launch contract without
// constructing the adapter.  The default activation primitive is intentionally
// guessed shell command from this module.
export const ACER_PACKAGE_LAUNCH = Object.freeze({
  fullName: ACER_PACKAGE_FULL_NAME,
  version: ACER_PACKAGE_VERSION,
  identity: ACER_PACKAGE_IDENTITY,
  shellIdentity: ACER_PACKAGE_SHELL_IDENTITY,
});
