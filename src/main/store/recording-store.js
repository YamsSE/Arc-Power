// Recording settings and metadata sidecar. It deliberately does not widen
// ProfileStore's schema or migration history.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DEFAULT_RECORDING_SETTINGS, RECORDING_SCHEMA_VERSION, normalizeRecordingSettings, safeVideoExtension, sortRecordingClips } from '../recording-pure.js';

function defaultDataDir() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ArcPower');
}

function safeId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value) ? value : null;
}

const RECORDING_SELECTION_PREFIX = 'arc-gpu-encoder:v1:';

function encoderTargetKey(target) {
  if (!target || typeof target !== 'object') return null;
  const deviceKey = typeof (target.deviceKey ?? target.device_key) === 'string'
    ? (target.deviceKey ?? target.device_key).trim()
    : '';
  const bdfValue = target.bdf;
  const bdf = Array.isArray(bdfValue)
    ? { domain: Number(bdfValue[0]) || 0, bus: Number(bdfValue[1]), device: Number(bdfValue[2]), function: Number(bdfValue[3]) }
    : bdfValue && typeof bdfValue === 'object'
      ? { domain: Number(bdfValue.domain) || 0, bus: Number(bdfValue.bus), device: Number(bdfValue.device), function: Number(bdfValue.function ?? bdfValue.func ?? 0) }
      : null;
  const luid = target.luid ?? target.adapterLuid ?? target.adapter_luid;
  if (!deviceKey && (!bdf || ![bdf.bus, bdf.device, bdf.function].every(Number.isSafeInteger)) && (luid === undefined || luid === null || luid === '')) return null;
  return JSON.stringify({ deviceKey: deviceKey || null, bdf: bdf && [bdf.bus, bdf.device, bdf.function].every(Number.isSafeInteger) ? bdf : null, luid: luid ?? null });
}

function persistedEncoderMatches(value, encoderId, adapterTarget) {
  if (!adapterTarget) return value === encoderId;
  if (typeof value !== 'string' || !value.startsWith(RECORDING_SELECTION_PREFIX)) return false;
  try {
    const requested = encoderId.startsWith(RECORDING_SELECTION_PREFIX)
      ? JSON.parse(Buffer.from(encoderId.slice(RECORDING_SELECTION_PREFIX.length), 'base64url').toString('utf8'))
      : null;
    const expectedCodec = requested?.codec ?? requested?.c ?? encoderId;
    const parsed = JSON.parse(Buffer.from(value.slice(RECORDING_SELECTION_PREFIX.length), 'base64url').toString('utf8'));
    const codec = parsed.codec ?? parsed.c;
    const target = parsed.target ?? {
      ...(typeof parsed.k === 'string' ? { deviceKey: parsed.k } : {}),
      ...(Array.isArray(parsed.b) ? { bdf: parsed.b } : {}),
      ...(parsed.l !== undefined ? { luid: parsed.l } : {}),
    };
    return codec === expectedCodec && encoderTargetKey(target) === encoderTargetKey(adapterTarget);
  } catch {
    return false;
  }
}

const WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT = 0x400;

function hasReparseAttribute(value) {
  if (value === true) return true;
  if (typeof value === 'number') return Number.isFinite(value) && (value & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT) !== 0;
  if (typeof value === 'bigint') return (value & BigInt(WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT)) !== 0n;
  if (!value || typeof value !== 'object') return false;
  return value.reparsePoint === true
    || value.reparse === true
    || hasReparseAttribute(value.value)
    || hasReparseAttribute(value.fileAttributes)
    || hasReparseAttribute(value.win32FileAttributes)
    || hasReparseAttribute(value.dwFileAttributes);
}

function memberIsTrue(value, name) {
  const member = value?.[name];
  if (typeof member === 'function') {
    try { return member.call(value) === true; } catch { return false; }
  }
  return member === true;
}

export function isReparsePoint(...values) {
  return values.some((value) => value && (
    memberIsTrue(value, 'isSymbolicLink')
    || memberIsTrue(value, 'isJunction')
    || memberIsTrue(value, 'isReparsePoint')
    || hasReparseAttribute(value.reparsePoint)
    || hasReparseAttribute(value.reparse)
    || hasReparseAttribute(value.attributes)
    || hasReparseAttribute(value.fileAttributes)
    || hasReparseAttribute(value.win32FileAttributes)
    || hasReparseAttribute(value.dwFileAttributes)
  ));
}

export class RecordingStore {
  constructor({ dir = defaultDataDir(), defaultLocation = '' } = {}) {
    this.dir = dir;
    this.filePath = path.join(dir, 'recording.json');
    this.defaultLocation = defaultLocation;
    this._mutationQueue = Promise.resolve();
  }

  _enqueueMutation(operation) {
    const work = this._mutationQueue.then(() => operation());
    this._mutationQueue = work.catch(() => {});
    return work;
  }

  _write(data) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeFileSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.filePath);
  }

  _read() {
    if (!fs.existsSync(this.filePath)) return null;
    const raw = fs.readFileSync(this.filePath, 'utf8');
    try { return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); }
    catch (err) { throw new Error(`Cannot load recording.json: invalid JSON (${err.message})`); }
  }

  _dataFromRaw(raw) {
    if (raw?.schemaVersion > RECORDING_SCHEMA_VERSION) throw new Error('recording.json was created by a newer Arc Power version');
    const settings = normalizeRecordingSettings(raw?.settings ?? raw ?? {});
    if (!settings.location) settings.location = this.defaultLocation;
    const clips = Array.isArray(raw?.clips)
      ? raw.clips.filter((clip) => clip && safeId(clip.id) && typeof clip.relativePath === 'string' && safeVideoExtension(clip.relativePath))
      : [];
    return { schemaVersion: RECORDING_SCHEMA_VERSION, settings, clips: sortRecordingClips(clips) };
  }

  _readData() {
    const raw = this._read();
    const data = this._dataFromRaw(raw);
    const rawSettings = raw?.settings && typeof raw.settings === 'object' ? raw.settings : raw;
    const modeNeedsMigration = rawSettings && typeof rawSettings === 'object'
      && Object.prototype.hasOwnProperty.call(rawSettings, 'mode')
      && rawSettings.mode !== data.settings.mode;
    return {
      raw,
      data,
      needsMigration: !raw || raw.schemaVersion !== RECORDING_SCHEMA_VERSION || modeNeedsMigration,
    };
  }

  loadSync() {
    return this._dataFromRaw(this._read());
  }

  async load() {
    // Reads must observe every earlier queued write. Without this barrier a
    // recording start arriving at the same time as a settings save could read
    // the previous profile and silently start with stale bitrate/resolution/
    // encoder values.
    await this._mutationQueue;
    const { data, needsMigration } = this._readData();
    if (needsMigration) {
      return this._enqueueMutation(() => {
        const latest = this._readData();
        if (latest.needsMigration) this._write(latest.data);
        return latest.data;
      });
    }
    return data;
  }

  async saveSettings(patch) {
    return this._enqueueMutation(() => {
      const { data: current } = this._readData();
      const settings = normalizeRecordingSettings({
        ...current.settings,
        ...(patch ?? {}),
        audio: {
          ...current.settings.audio,
          ...(patch?.audio ?? {}),
          microphone: { ...current.settings.audio?.microphone, ...(patch?.audio?.microphone ?? {}) },
          system: { ...current.settings.audio?.system, ...(patch?.audio?.system ?? {}) },
        },
        captureTarget: {
          ...current.settings.captureTarget,
          ...(patch?.captureTarget ?? {}),
        },
        hotkeys: { ...current.settings.hotkeys, ...(patch?.hotkeys ?? {}) },
      });
      this._write({ ...current, schemaVersion: RECORDING_SCHEMA_VERSION, settings });
      return settings;
    });
  }

  async demoteEncoder(selectionId, adapterTarget = null) {
    if (typeof selectionId !== 'string' || !selectionId) return this.settings();
    return this._enqueueMutation(() => {
      const { data: current } = this._readData();
      // Compare the codec and concrete target together. The complete
      // versioned selection ID is authoritative for the engine path, while
      // the decoded target keeps legacy `(codec, target)` callers scoped too.
      if (adapterTarget
        ? !persistedEncoderMatches(current.settings.encoderId, selectionId, adapterTarget)
        : current.settings.encoderId !== selectionId) return current.settings;
      const settings = normalizeRecordingSettings({ ...current.settings, encoderId: 'automatic' });
      this._write({ ...current, schemaVersion: RECORDING_SCHEMA_VERSION, settings });
      return settings;
    });
  }

  async listClips() { return (await this.load()).clips; }

  async scanClips() {
    return this._enqueueMutation(() => {
      const { data: current } = this._readData();
      const root = current.settings.location;
      if (!root || !path.isAbsolute(root)) return current.clips;
      const resolvedRoot = path.resolve(root);
      let initialRootStat;
      try { initialRootStat = fs.lstatSync(resolvedRoot); } catch { return current.clips; }
      if (isReparsePoint(initialRootStat) || !initialRootStat.isDirectory()) return current.clips;

      const known = new Map(current.clips.map((clip) => [clip.relativePath, clip]));
      const found = [];
      const walk = (dir, depth = 0) => {
        if (depth > 4) return true;
        let dirStat;
        try { dirStat = fs.lstatSync(dir); } catch { return false; }
        if (isReparsePoint(dirStat) || !dirStat.isDirectory()) return false;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
        for (const entry of entries) {
          if (isReparsePoint(entry)) continue;
          const full = path.join(dir, entry.name);
          let stat;
          try { stat = fs.lstatSync(full); } catch { return false; }
          if (isReparsePoint(entry, stat)) continue;
          if (stat.isDirectory()) {
            if (!walk(full, depth + 1)) return false;
          }
          else if (stat.isFile() && safeVideoExtension(full)) {
            const relativePath = path.relative(root, full);
            const old = known.get(relativePath);
            found.push({
              id: old?.id ?? crypto.randomUUID(),
              fileName: path.basename(full),
              relativePath,
              createdAt: old?.createdAt ?? stat.birthtime.toISOString(),
              modifiedAt: stat.mtime.toISOString(),
              byteLength: stat.size,
            });
          }
        }
        return true;
      };
      if (!walk(resolvedRoot)) return current.clips;

      // Revalidate the configured root after traversal so a root replacement
      // during the scan cannot turn a failed-closed walk into an empty write.
      let finalRootStat;
      try { finalRootStat = fs.lstatSync(resolvedRoot); } catch { return current.clips; }
      if (isReparsePoint(finalRootStat) || !finalRootStat.isDirectory()) return current.clips;

      // The scan can take long enough for another process to update the
      // sidecar. Reload immediately before composing the queued write so the
      // scan never replaces newer settings or encoder state.
      const { data: latest } = this._readData();
      const clips = sortRecordingClips(found);
      this._write({ ...latest, schemaVersion: RECORDING_SCHEMA_VERSION, clips });
      return clips;
    });
  }

  async replaceClips(clips) {
    return this._enqueueMutation(() => {
      const { data: current } = this._readData();
      const next = Array.isArray(clips) ? clips.filter((clip) => clip && safeId(clip.id)).slice(0, 5000) : [];
      const sorted = sortRecordingClips(next);
      this._write({ ...current, schemaVersion: RECORDING_SCHEMA_VERSION, clips: sorted });
      return sorted;
    });
  }

  async clipById(id) {
    const clipId = safeId(id);
    if (!clipId) return null;
    return (await this.load()).clips.find((clip) => clip.id === clipId) ?? null;
  }

  async deleteClip(id) {
    const clipId = safeId(id);
    if (!clipId) return null;
    return this._enqueueMutation(() => {
      const { data: current } = this._readData();
      const clip = current.clips.find((item) => item.id === clipId) ?? null;
      if (!clip) return null;
      const clips = current.clips.filter((item) => item.id !== clipId);
      this._write({ ...current, schemaVersion: RECORDING_SCHEMA_VERSION, clips: sortRecordingClips(clips) });
      return clip;
    });
  }

  async settings() { return (await this.load()).settings; }
}

export { defaultDataDir };
