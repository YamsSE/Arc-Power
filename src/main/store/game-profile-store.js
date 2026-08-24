// Per-game profile associations. This deliberately lives beside, but not
// inside, profiles.json: ProfileStore sanitizes OC settings and must remain
// backward compatible with the existing boot/apply schema.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const GAME_PROFILE_SCHEMA_VERSION = 1;

export function deterministicArtworkKey(value) {
  const text = String(value ?? '').toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `fallback-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function isValidArtwork(value) {
  if (typeof value !== 'string' || value.length > 750000) return false;
  if (/^(?:local:arc-power|fallback-[a-z0-9_-]{1,48})$/.test(value)) return true;
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function sanitizeArtwork(value, fallback) {
  if (isValidArtwork(value)) return value;
  return fallback;
}

function defaultDataDir() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ArcPower');
}

export function canonicalExePath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 32768) return null;
  let winPath = trimmed.replaceAll('/', '\\');
  // The scanner and Windows APIs can return an extended prefix for the same
  // ordinary drive path.  Keep the user-facing spelling out of identity and
  // reduce only the two supported drive forms to a Win32 drive path.
  winPath = winPath.replace(/^\\\\[?.]\\(?=[a-z]:\\)/i, '');
  // UNC extended paths and device namespaces are not safe to treat as a
  // normal executable identity.  Standard UNC paths remain supported below.
  if (/^\\\\(?:[?.]|Device|GlobalRoot)(?:\\|$)/i.test(winPath)) return null;
  const normalized = path.win32.normalize(winPath);
  if ((!/^[a-z]:\\/i.test(normalized) && !normalized.startsWith('\\\\')) || !/\.exe$/i.test(normalized)) return null;
  return normalized.toLowerCase();
}

function cleanText(value, max, fallback = '') {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, max) : fallback;
}

function cleanGraphics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  if (['application-default', 'vsync-on', 'vsync-off', 'smooth-sync', 'speed-frame'].includes(value.flipMode)) out.flipMode = value.flipMode;
  if (value.frameLimit && typeof value.frameLimit === 'object' && typeof value.frameLimit.enabled === 'boolean'
    && typeof value.frameLimit.value === 'number' && Number.isFinite(value.frameLimit.value)) {
    out.frameLimit = { enabled: value.frameLimit.enabled, value: Math.max(1, Math.min(1000, Math.round(value.frameLimit.value))) };
  }
  if (['off', 'on', 'on-boost'].includes(value.lowLatency)) out.lowLatency = value.lowLatency;
  return out;
}

export function normalizeAssociation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const exePath = canonicalExePath(raw.exePath);
  if (!exePath || typeof raw.profileId !== 'string' || !/^\S+$/.test(raw.profileId)) return null;
  const id = cleanText(raw.id, 160) || `game-${Buffer.from(`${raw.profileId}|${exePath}`).toString('hex').slice(0, 32)}`;
  const processName = cleanText(raw.processName, 260, path.win32.basename(exePath));
  const displayName = cleanText(raw.displayName, 260, path.win32.basename(exePath, '.exe'));
  return {
    id,
    profileId: raw.profileId,
    exePath,
    processName,
    displayName,
    artwork: sanitizeArtwork(raw.artwork, deterministicArtworkKey(exePath)),
    source: raw.source === 'manual' ? 'manual' : 'scan',
    enabled: raw.enabled !== false,
    graphics: cleanGraphics(raw.graphics),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
}

export function normalizeAssociations(raw, validProfileIds = null) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const association = normalizeAssociation(item);
    if (!association || (validProfileIds && !validProfileIds.has(association.profileId))) continue;
    const key = `${association.profileId}|${association.exePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(association);
  }
  return out.sort((a, b) => `${a.displayName}\0${a.exePath}`.localeCompare(`${b.displayName}\0${b.exePath}`, undefined, { sensitivity: 'base' }));
}

export class GameProfileStore {
  constructor(opts = {}) {
    this.dir = opts.dir ?? defaultDataDir();
    this.filePath = path.join(this.dir, 'game-profiles.json');
    this._mutation = Promise.resolve();
    this._tmpCounter = 0;
  }

  _ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
    // Remove interrupted writes from older versions and stale unique temp
    // files.  Current writes use a unique name, so this cannot collide with
    // another mutation in this process.
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    const prefix = path.basename(this.filePath) + '.';
    const now = Date.now();
    for (const name of names) {
      if (name !== `${path.basename(this.filePath)}.tmp` && !name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      const target = path.join(this.dir, name);
      try {
        const age = now - fs.statSync(target).mtimeMs;
        if (name === `${path.basename(this.filePath)}.tmp` || age > 5 * 60 * 1000) fs.rmSync(target, { force: true });
      } catch { /* stale cleanup is best effort */ }
    }
  }

  _writeAtomic(data) {
    this._ensureDir();
    const tmp = `${this.filePath}.${process.pid}.${++this._tmpCounter}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    try { fs.renameSync(tmp, this.filePath); }
    finally { try { fs.rmSync(tmp, { force: true }); } catch { /* already renamed */ } }
  }

  _loadUnlocked(validProfileIds = null) {
    if (!fs.existsSync(this.filePath)) return [];
    const raw = fs.readFileSync(this.filePath, 'utf8');
    let data;
    try { data = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); }
    catch (err) { throw new Error(`Cannot load game-profiles.json: invalid JSON (${err.message})`); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Cannot load game-profiles.json: root must be an object');
    }
    if (!Number.isInteger(data.schemaVersion) || data.schemaVersion < 1) {
      throw new Error('Cannot load game-profiles.json: invalid schema version');
    }
    if (data.schemaVersion > GAME_PROFILE_SCHEMA_VERSION) throw new Error('game-profiles.json uses a newer unsupported schema');
    if (!Array.isArray(data.associations)) {
      throw new Error('Cannot load game-profiles.json: associations must be an array');
    }
    const associations = normalizeAssociations(data.associations, validProfileIds);
    if (validProfileIds && associations.length !== data.associations.length) {
      this._saveUnlocked(associations);
    }
    return associations;
  }

  async load(validProfileIds = null) {
    await this._mutation;
    return this._loadUnlocked(validProfileIds);
  }

  _mutate(work) {
    const next = this._mutation.then(work, work);
    this._mutation = next.catch(() => {});
    return next;
  }

  _saveUnlocked(associations) {
    const clean = normalizeAssociations(associations);
    this._writeAtomic({ schemaVersion: GAME_PROFILE_SCHEMA_VERSION, associations: clean });
    return clean;
  }

  async save(associations) {
    return this._mutate(() => this._saveUnlocked(associations));
  }

  async upsert(raw, validProfileIds = null) {
    const association = normalizeAssociation(raw);
    if (!association) throw new Error('game-profile-save: invalid association');
    if (validProfileIds && !validProfileIds.has(association.profileId)) throw new Error('game-profile-save: profile not found');
    return this._mutate(() => {
      const current = this._loadUnlocked(validProfileIds);
      const key = `${association.profileId}|${association.exePath}`;
      const next = current.filter((item) => `${item.profileId}|${item.exePath}` !== key);
      next.push(association);
      return this._saveUnlocked(next);
    });
  }

  async delete(profileId, exePath, validProfileIds = null) {
    if (typeof profileId !== 'string' || !/^\S+$/.test(profileId)) throw new Error('game-profile-delete: invalid profile id');
    const canonical = canonicalExePath(exePath);
    if (!canonical) throw new Error('game-profile-delete: invalid executable path');
    return this._mutate(() => {
      const current = this._loadUnlocked(validProfileIds);
      const next = current.filter((item) => !(item.profileId === profileId && item.exePath === canonical));
      if (next.length !== current.length) this._saveUnlocked(next);
      return next;
    });
  }

  async cleanupProfile(profileId, validProfileIds = null) {
    return this._mutate(() => {
      const current = this._loadUnlocked(validProfileIds);
      const next = current.filter((item) => item.profileId !== profileId);
      if (next.length !== current.length) this._saveUnlocked(next);
      return next;
    });
  }
}
