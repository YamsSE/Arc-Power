// Per-physical-GPU driver observation sidecar. It never uses enumeration
// ordinals, so a reordered multi-GPU inventory cannot create a false change.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DRIVER_MONITOR_SCHEMA_VERSION = 1;
const MAX_OBSERVATIONS = 256;

function defaultDir() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ArcPower');
}

export function stableDriverDeviceKey(device) {
  if (typeof device?.deviceKey === 'string' && device.deviceKey.trim()) return device.deviceKey.trim();
  if (typeof device?.pnpDeviceId === 'string' && device.pnpDeviceId.trim()) return `pnp:${device.pnpDeviceId.trim()}`;
  if (typeof device?.osController?.pnpDeviceId === 'string' && device.osController.pnpDeviceId.trim()) return `pnp:${device.osController.pnpDeviceId.trim()}`;
  const bdf = device?.bdf;
  const bus = Number(bdf?.bus);
  const slot = Number(bdf?.device);
  const func = Number(bdf?.function ?? bdf?.func ?? 0);
  if ([bus, slot, func].every(Number.isInteger)) return `bdf:${Number(bdf?.domain ?? 0)}:${bus}:${slot}.${func}`;
  const luid = device?.osLuid ?? device?.luid ?? device?.adapterLuid;
  if (typeof luid === 'string' && luid.trim()) return `luid:${luid.trim()}`;
  return null;
}

export function normalizeDriverObservation(value) {
  const source = value && typeof value === 'object' ? value : {};
  const deviceKey = typeof source.deviceKey === 'string' && source.deviceKey.trim() ? source.deviceKey.trim() : null;
  if (!deviceKey) return null;
  const version = typeof source.driverVersion === 'string' && source.driverVersion.trim() ? source.driverVersion.trim().slice(0, 256) : null;
  const date = typeof source.driverDate === 'string' && source.driverDate.trim() ? source.driverDate.trim().slice(0, 128) : null;
  return { deviceKey, driverVersion: version, driverDate: date, observedAt: Number.isFinite(source.observedAt) ? Math.round(source.observedAt) : Date.now() };
}

export class DriverMonitor {
  constructor({ dir = defaultDir(), fileName = 'driver-observations.json', clock = () => Date.now() } = {}) {
    this.dir = dir;
    this.filePath = path.join(dir, fileName);
    this.clock = clock;
  }

  _read() {
    if (!fs.existsSync(this.filePath)) return { schemaVersion: DRIVER_MONITOR_SCHEMA_VERSION, observations: {}, transitions: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8').replace(/^\uFEFF/, ''));
      if (raw?.schemaVersion > DRIVER_MONITOR_SCHEMA_VERSION) throw new Error('driver observations use a newer unsupported schema');
      return {
        schemaVersion: DRIVER_MONITOR_SCHEMA_VERSION,
        observations: raw?.observations && typeof raw.observations === 'object' ? raw.observations : {},
        transitions: raw?.transitions && typeof raw.transitions === 'object' ? raw.transitions : {},
      };
    } catch (error) {
      if (error?.message?.includes('newer unsupported')) throw error;
      return { schemaVersion: DRIVER_MONITOR_SCHEMA_VERSION, observations: {}, transitions: {} };
    }
  }

  _write(data) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  status() {
    return this._read();
  }

  observe(devices = [], { driverDate = null, now = this.clock() } = {}) {
    const current = this._read();
    const changes = [];
    const observations = { ...current.observations };
    const transitions = { ...current.transitions };
    for (const device of Array.isArray(devices) ? devices : []) {
      const deviceKey = stableDriverDeviceKey(device);
      if (!deviceKey) continue;
      const next = normalizeDriverObservation({
        deviceKey,
        driverVersion: device.driverVersion ?? device.osController?.driverVersion,
        driverDate: device.driverDate ?? driverDate,
        observedAt: now,
      });
      if (!next) continue;
      const previous = normalizeDriverObservation(observations[deviceKey]);
      if (previous && (previous.driverVersion !== next.driverVersion || previous.driverDate !== next.driverDate)) {
        const dedupeKey = `${deviceKey}|${previous.driverVersion ?? ''}|${previous.driverDate ?? ''}|${next.driverVersion ?? ''}|${next.driverDate ?? ''}`;
        if (!transitions[dedupeKey]) {
          const change = { deviceKey, previous, current: next, observedAt: now, dedupeKey };
          changes.push(change);
          transitions[dedupeKey] = change;
        }
      }
      observations[deviceKey] = next;
    }
    const keys = Object.keys(observations).slice(-MAX_OBSERVATIONS);
    const transitionKeys = Object.keys(transitions).slice(-MAX_OBSERVATIONS * 2);
    const result = {
      schemaVersion: DRIVER_MONITOR_SCHEMA_VERSION,
      observations: Object.fromEntries(keys.map((key) => [key, observations[key]])),
      transitions: Object.fromEntries(transitionKeys.map((key) => [key, transitions[key]])),
    };
    this._write(result);
    return { ...result, changes };
  }
}

export function createDriverMonitor(options = {}) {
  return new DriverMonitor(options);
}

export { DRIVER_MONITOR_SCHEMA_VERSION };
