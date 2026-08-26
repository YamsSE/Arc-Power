// Per-game profile associations. This deliberately lives beside, but not
// inside, profiles.json: ProfileStore sanitizes OC settings and must remain
// backward compatible with the existing boot/apply schema.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { canonicalExePath, validateSafeGameCandidate } from '../game-candidate.js';

// Backward-compatible export for existing store callers/tests.
export { canonicalExePath } from '../game-candidate.js';

export const GAME_PROFILE_SCHEMA_VERSION = 2;
export const MAX_BANNER_DATA_LENGTH = 12_000_000;

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

/** Banner data is cached separately from the executable icon fallback. */
export function isValidBanner(value) {
  if (typeof value !== 'string' || value.length > MAX_BANNER_DATA_LENGTH) return false;
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function sanitizeArtwork(value, fallback) {
  if (isValidArtwork(value)) return value;
  return fallback;
}

function sanitizeBanner(value) {
  return isValidBanner(value) ? value : null;
}

function defaultDataDir() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ArcPower');
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
  if (['off', 'on'].includes(value.enduranceGaming)) out.enduranceGaming = value.enduranceGaming;
  if (['app-choice', '2x', '3x', '4x'].includes(value.frameGenOverride)) out.frameGenOverride = value.frameGenOverride;
  return out;
}

function cleanTime(value, fallback) {
  return typeof value === 'string' && value.length <= 80 ? value : fallback;
}

export function normalizeGameSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const exePath = canonicalExePath(raw.exePath);
  if (!exePath) return null;
  const now = new Date().toISOString();
  return {
    exePath,
    // A discovered game is inert until the user explicitly enables its
    // per-game profile. This prevents a newly scanned catalog from changing
    // game behavior merely by existing.
    enabled: raw.enabled === true,
    tuningProfileId: typeof raw.tuningProfileId === 'string' && /^\S+$/.test(raw.tuningProfileId)
      ? raw.tuningProfileId
      : null,
    graphics: cleanGraphics(raw.graphics),
    createdAt: cleanTime(raw.createdAt, now),
    updatedAt: cleanTime(raw.updatedAt, now),
  };
}

export function normalizeCatalogEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const exePath = canonicalExePath(raw.exePath);
  if (!exePath) return null;
  const now = new Date().toISOString();
  const processName = cleanText(raw.processName, 260, path.win32.basename(exePath));
  const displayName = cleanText(raw.displayName, 260, path.win32.basename(exePath, '.exe'));
  return {
    exePath,
    processName,
    displayName,
    artwork: sanitizeArtwork(raw.artwork, deterministicArtworkKey(exePath)),
    banner: sanitizeBanner(raw.banner),
    source: raw.source === 'manual' ? 'manual' : 'scan',
    createdAt: cleanTime(raw.createdAt, now),
    updatedAt: cleanTime(raw.updatedAt, now),
  };
}

function normalizeCatalog(raw) {
  const byPath = new Map();
  for (const item of Array.isArray(raw) ? raw : []) {
    const entry = normalizeCatalogEntry(item);
    if (!entry) continue;
    const previous = byPath.get(entry.exePath);
    // New scanner metadata wins, but never discard a previously enriched icon.
    byPath.set(entry.exePath, previous ? {
      ...previous,
      ...entry,
      artwork: isValidArtwork(item.artwork) && !/^fallback-/.test(item.artwork) ? entry.artwork : previous.artwork,
      createdAt: previous.createdAt || entry.createdAt,
    } : entry);
  }
  return [...byPath.values()].sort((a, b) => `${a.displayName}\0${a.exePath}`.localeCompare(`${b.displayName}\0${b.exePath}`, undefined, { sensitivity: 'base' }));
}

function normalizeSettings(raw) {
  const byPath = new Map();
  for (const item of Array.isArray(raw) ? raw : []) {
    const settings = normalizeGameSettings(item);
    if (!settings) continue;
    const previous = byPath.get(settings.exePath);
    byPath.set(settings.exePath, previous ? { ...previous, ...settings, graphics: { ...previous.graphics, ...settings.graphics }, createdAt: previous.createdAt || settings.createdAt } : settings);
  }
  return [...byPath.values()].sort((a, b) => a.exePath.localeCompare(b.exePath));
}

function safeCatalogRecords(raw) {
  // Game-only filtering belongs at the scan ingress. Do not re-apply the
  // title heuristic while loading: old/manual records and test fixtures are
  // valid persisted identities even when their names are generic.
  return (Array.isArray(raw) ? raw : []).filter((item) => Boolean(validateSafeGameCandidate(item?.exePath)));
}

function canKeepLegacyAssociationOnly(association) {
  if (!validateSafeGameCandidate(association?.exePath, { requireExists: false })) return false;
  try {
    return !fs.existsSync(association.exePath);
  } catch {
    return false;
  }
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
    banner: sanitizeBanner(raw.banner),
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

function emptyData() {
  return { schemaVersion: GAME_PROFILE_SCHEMA_VERSION, associations: [], catalog: [], settings: [] };
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

  _loadDataUnlocked(validProfileIds = null) {
    if (!fs.existsSync(this.filePath)) return emptyData();
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
    const migratedCatalog = data.schemaVersion === 1 ? data.associations : data.catalog;
    const migratedSettings = data.schemaVersion === 1
      ? data.associations.map((item) => ({ ...item, exePath: item.exePath, graphics: item.graphics, enabled: item.enabled }))
      : data.settings;
    const clean = {
      schemaVersion: GAME_PROFILE_SCHEMA_VERSION,
      associations,
      catalog: normalizeCatalog(safeCatalogRecords(migratedCatalog)).map((entry) => {
        const association = associations.find((item) => item.exePath === entry.exePath);
        return association ? {
          ...entry,
          processName: association.processName,
          displayName: association.displayName,
          artwork: isValidArtwork(association.artwork) ? association.artwork : entry.artwork,
          banner: isValidBanner(association.banner) ? association.banner : entry.banner,
        } : entry;
      }),
      settings: normalizeSettings(safeCatalogRecords(migratedSettings)),
    };
    // A v1 association is promoted to a catalog entry/settings record while
    // its legacy row remains intact for the OC profile browser.
    for (const association of associations) {
      if (!validateSafeGameCandidate(association.exePath)) continue;
      if (!clean.catalog.some((item) => item.exePath === association.exePath)) {
        clean.catalog.push(normalizeCatalogEntry(association));
      }
      if (!clean.settings.some((item) => item.exePath === association.exePath)) {
        clean.settings.push(normalizeGameSettings(association));
      }
    }
    clean.catalog = normalizeCatalog(clean.catalog);
    clean.settings = normalizeSettings(clean.settings);
    const hasUnsafeCatalogRecord = (Array.isArray(data.catalog) ? data.catalog : []).some((item) => !validateSafeGameCandidate(item?.exePath));
    const hasUnsafeSettingsRecord = (Array.isArray(data.settings) ? data.settings : []).some((item) => !validateSafeGameCandidate(item?.exePath));
    const needsWrite = data.schemaVersion !== GAME_PROFILE_SCHEMA_VERSION
      || associations.length !== data.associations.length
      || hasUnsafeCatalogRecord
      || hasUnsafeSettingsRecord
      || JSON.stringify(clean.catalog) !== JSON.stringify(normalizeCatalog(safeCatalogRecords(data.catalog)))
      || JSON.stringify(clean.settings) !== JSON.stringify(normalizeSettings(safeCatalogRecords(data.settings)));
    if (needsWrite) this._writeAtomic(clean);
    return clean;
  }

  _loadUnlocked(validProfileIds = null) { return this._loadDataUnlocked(validProfileIds).associations; }

  async load(validProfileIds = null) {
    return this._mutate(() => this._loadUnlocked(validProfileIds));
  }

  _mutate(work) {
    const next = this._mutation.then(work, work);
    this._mutation = next.catch(() => {});
    return next;
  }

  _saveDataUnlocked(data) {
    const clean = {
      schemaVersion: GAME_PROFILE_SCHEMA_VERSION,
      associations: normalizeAssociations(data.associations),
      catalog: normalizeCatalog(safeCatalogRecords(data.catalog)),
      settings: normalizeSettings(safeCatalogRecords(data.settings)),
    };
    this._writeAtomic(clean);
    return clean;
  }

  _saveUnlocked(associations) {
    const data = this._loadDataUnlocked();
    data.associations = associations;
    return this._saveDataUnlocked(data).associations;
  }

  async save(associations) {
    return this._mutate(() => this._saveUnlocked(associations));
  }

  async upsert(raw, validProfileIds = null) {
    const association = normalizeAssociation(raw);
    if (!association) throw new Error('game-profile-save: invalid association');
    if (validProfileIds && !validProfileIds.has(association.profileId)) throw new Error('game-profile-save: profile not found');
    const safePath = validateSafeGameCandidate(association.exePath);
    if (!safePath && !canKeepLegacyAssociationOnly(association)) {
      throw new Error('game-profile-save: executable is not a safe existing game candidate');
    }
    return this._mutate(() => {
      const data = this._loadDataUnlocked(validProfileIds);
      const current = data.associations;
      const key = `${association.profileId}|${association.exePath}`;
      const next = current.filter((item) => `${item.profileId}|${item.exePath}` !== key);
      next.push(association);
      data.associations = next;
      if (safePath) {
        const existingCatalog = data.catalog.find((item) => item.exePath === association.exePath);
        data.catalog = data.catalog.filter((item) => item.exePath !== association.exePath);
        data.catalog.push(normalizeCatalogEntry({ ...(existingCatalog ?? {}), ...association,
          artwork: isValidArtwork(association.artwork) && !/^fallback-/.test(association.artwork)
            ? association.artwork : existingCatalog?.artwork,
          banner: isValidBanner(association.banner) ? association.banner : existingCatalog?.banner,
        }));
        const existingSettings = data.settings.find((item) => item.exePath === association.exePath);
        data.settings = data.settings.filter((item) => item.exePath !== association.exePath);
        data.settings.push(normalizeGameSettings({ ...(existingSettings ?? {}), ...association, graphics: { ...(existingSettings?.graphics ?? {}), ...(association.graphics ?? {}) } }));
      }
      return this._saveDataUnlocked(data).associations;
    });
  }

  async delete(profileId, exePath, validProfileIds = null) {
    if (typeof profileId !== 'string' || !/^\S+$/.test(profileId)) throw new Error('game-profile-delete: invalid profile id');
    const canonical = canonicalExePath(exePath);
    if (!canonical) throw new Error('game-profile-delete: invalid executable path');
    return this._mutate(() => {
      const data = this._loadDataUnlocked(validProfileIds);
      const current = data.associations;
      const next = current.filter((item) => !(item.profileId === profileId && item.exePath === canonical));
      if (next.length !== current.length) { data.associations = next; this._saveDataUnlocked(data); }
      return next;
    });
  }

  async cleanupProfile(profileId, validProfileIds = null) {
    return this._mutate(() => {
      const data = this._loadDataUnlocked(validProfileIds);
      const current = data.associations;
      const next = current.filter((item) => item.profileId !== profileId);
      if (next.length !== current.length) { data.associations = next; this._saveDataUnlocked(data); }
      return next;
    });
  }

  async loadCatalog() {
    return this._mutate(() => {
      const data = this._loadDataUnlocked();
      return { catalog: data.catalog, settings: data.settings };
    });
  }

  async syncCatalog(entries, options = {}) {
    return this._mutate(() => {
      if (!Array.isArray(entries)) throw new Error('game-catalog-sync: entries must be an array');
      for (const entry of entries) {
        if (!validateSafeGameCandidate(entry?.exePath ?? entry?.ExecutablePath)) {
          throw new Error('game-catalog-sync: executable is not a safe existing game candidate');
        }
      }
      const data = this._loadDataUnlocked();
      const incoming = normalizeCatalog(entries);
      const incomingPaths = new Set(incoming.map((item) => item.exePath));
      // The real full-machine scan opts into authoritative replacement. The
      // default remains merge-safe for older callers and concurrent sidecar
      // mutations: two queued partial syncs must not delete one another's
      // rows before a settings save reaches the queue.
      const authoritative = options?.authoritative === true;
      const byPath = new Map(data.catalog
        .filter((item) => !authoritative || item.source === 'manual' || incomingPaths.has(item.exePath))
        .map((item) => [item.exePath, item]));
      for (const entry of incoming) {
        const previous = byPath.get(entry.exePath);
        byPath.set(entry.exePath, previous ? {
          ...previous,
          ...entry,
          // Icon extraction is best-effort. A transient failure yields a
          // deterministic fallback and must not erase a prior real artwork.
          artwork: isValidArtwork(entry.artwork) && !/^fallback-/.test(entry.artwork)
            ? entry.artwork : previous.artwork,
          // Banner resolution is part of the scan cache. An authoritative
          // refresh therefore replaces (including clearing) the prior value;
          // stale local art must not survive after the file is removed.
          banner: entry.banner,
          createdAt: previous.createdAt || entry.createdAt,
        } : entry);
      }
      data.catalog = [...byPath.values()];
      const catalogPaths = new Set(data.catalog.map((item) => item.exePath));
      if (authoritative) data.settings = data.settings.filter((item) => catalogPaths.has(item.exePath));
      return this._saveDataUnlocked(data).catalog;
    });
  }

  /** Add one user-selected executable without replacing scan results. */
  async addCatalogEntry(raw) {
    const safePath = validateSafeGameCandidate(raw?.exePath, { requireExists: true });
    if (!safePath) throw new Error('game-catalog-add: executable is not a safe existing game candidate');
    return this._mutate(() => {
      const data = this._loadDataUnlocked();
      const incoming = normalizeCatalogEntry({ ...raw, exePath: safePath, source: 'manual' });
      const previous = data.catalog.find((item) => item.exePath === safePath);
      const entry = previous ? {
        ...previous,
        ...incoming,
        source: 'manual',
        artwork: isValidArtwork(raw?.artwork) && !/^fallback-/.test(raw.artwork) ? raw.artwork : previous.artwork,
        banner: incoming.banner,
        createdAt: previous.createdAt || incoming.createdAt,
      } : incoming;
      data.catalog = normalizeCatalog([...data.catalog.filter((item) => item.exePath !== safePath), entry]);
      return this._saveDataUnlocked(data);
    });
  }

  async saveSettings(raw) {
    const settings = normalizeGameSettings(raw);
    if (!settings) throw new Error('game-settings-save: invalid executable settings');
    const safePath = validateSafeGameCandidate(settings.exePath);
    if (!safePath) throw new Error('game-settings-save: executable is not a safe existing game candidate');
    return this._mutate(() => {
      const data = this._loadDataUnlocked();
      if (!data.catalog.some((item) => item.exePath === safePath)) {
        throw new Error('game-settings-save: executable is not present in the game catalog');
      }
      const previous = data.settings.find((item) => item.exePath === settings.exePath);
      data.settings = data.settings.filter((item) => item.exePath !== settings.exePath);
      data.settings.push({ ...settings, createdAt: previous?.createdAt ?? settings.createdAt });
      return this._saveDataUnlocked(data).settings.find((item) => item.exePath === settings.exePath);
    });
  }

  async deleteSettings(exePath) {
    const canonical = canonicalExePath(exePath);
    if (!canonical) throw new Error('game-settings-delete: invalid executable path');
    return this._mutate(() => {
      const data = this._loadDataUnlocked();
      data.settings = data.settings.filter((item) => item.exePath !== canonical);
      this._saveDataUnlocked(data);
      return { catalog: data.catalog, settings: data.settings };
    });
  }
}
