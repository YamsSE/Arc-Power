import fs from 'node:fs';
import path from 'node:path';

const MAX_LAYOUTS = 20;
const LAYOUT_SCHEMA_VERSION = 1;
const POSITIONS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
const ADVANCED_POSITIONS = new Set(['left', 'right']);

function safeText(value, fallback, max = 80) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= max ? text : fallback;
}

function safeColor(value, fallback) { return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback; }

export function normalizeOverlayLayout(raw = {}, fallback = {}) {
  const id = safeText(raw.id, safeText(fallback.id, 'default'), 96).replace(/[^A-Za-z0-9_-]/g, '_');
  const name = safeText(raw.name, safeText(fallback.name, 'Default'), 64);
  const stats = Array.isArray(raw.stats ?? fallback.stats) ? [...new Set((raw.stats ?? fallback.stats).filter((id) => typeof id === 'string').slice(0, 64))] : [];
  const deviceKeys = Array.isArray(raw.deviceKeys ?? fallback.deviceKeys) ? [...new Set((raw.deviceKeys ?? fallback.deviceKeys).filter((key) => typeof key === 'string' && key.length <= 256).slice(0, 64))] : null;
  return {
    id, name,
    position: POSITIONS.has(raw.position) ? raw.position : (POSITIONS.has(fallback.position) ? fallback.position : 'top-left'),
    scale: Math.min(2, Math.max(.5, Number.isFinite(Number(raw.scale ?? fallback.scale)) ? Number(raw.scale ?? fallback.scale) : 1)),
    theme: raw.theme === 'classic' || raw.theme === 'arc' ? raw.theme : (fallback.theme === 'classic' ? 'classic' : 'arc'),
    stats,
    deviceKeys,
    background: {
      enabled: raw.background?.enabled === true || (raw.background === undefined && fallback.background?.enabled === true),
      color: safeColor(raw.background?.color ?? fallback.background?.color, '#000000'),
      opacity: Math.min(1, Math.max(0, Number(raw.background?.opacity ?? fallback.background?.opacity ?? .5))),
    },
    advancedPosition: ADVANCED_POSITIONS.has(raw.advancedPosition) ? raw.advancedPosition : (ADVANCED_POSITIONS.has(fallback.advancedPosition) ? fallback.advancedPosition : 'right'),
  };
}

export class OverlayLayoutStore {
  constructor({ dir, defaults = {} } = {}) {
    this.filePath = path.join(dir, 'overlay-layouts.json');
    this.defaults = defaults;
  }

  _defaults() { return typeof this.defaults === 'function' ? this.defaults() : this.defaults; }

  _read() {
    if (!fs.existsSync(this.filePath)) return { schemaVersion: LAYOUT_SCHEMA_VERSION, activeId: 'default', layouts: [normalizeOverlayLayout({ id: 'default', name: 'Default' }, this._defaults())] };
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8').replace(/^\uFEFF/, ''));
    if (raw?.schemaVersion > LAYOUT_SCHEMA_VERSION) throw new Error('overlay-layouts.json was created by a newer Arc Power version');
    const defaults = this._defaults();
    const layouts = Array.isArray(raw?.layouts) ? raw.layouts.map((item) => normalizeOverlayLayout(item, defaults)).slice(0, MAX_LAYOUTS) : [];
    const safe = layouts.length ? layouts : [normalizeOverlayLayout({ id: 'default', name: 'Default' }, defaults)];
    const activeId = safe.some((item) => item.id === raw?.activeId) ? raw.activeId : safe[0].id;
    return { schemaVersion: LAYOUT_SCHEMA_VERSION, activeId, layouts: safe };
  }

  _write(data) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  load() { return this._read(); }
  save(layout) {
    const data = this._read();
    const normalized = normalizeOverlayLayout(layout, this._defaults());
    const layouts = [...data.layouts.filter((item) => item.id !== normalized.id), normalized].slice(0, MAX_LAYOUTS);
    this._write({ ...data, layouts });
    return { ...data, layouts };
  }
  rename(id, name) {
    const data = this._read();
    const target = data.layouts.find((item) => item.id === id);
    if (!target) throw new Error('Overlay layout not found');
    target.name = safeText(name, target.name, 64);
    this._write(data);
    return data;
  }
  select(id) {
    const data = this._read();
    if (!data.layouts.some((item) => item.id === id)) throw new Error('Overlay layout not found');
    data.activeId = id;
    this._write(data);
    return data;
  }
  delete(id) {
    const data = this._read();
    if (data.layouts.length <= 1) throw new Error('The default overlay layout cannot be deleted');
    data.layouts = data.layouts.filter((item) => item.id !== id);
    if (!data.layouts.some((item) => item.id === data.activeId)) data.activeId = data.layouts[0].id;
    this._write(data);
    return data;
  }
}

export { MAX_LAYOUTS, LAYOUT_SCHEMA_VERSION };
