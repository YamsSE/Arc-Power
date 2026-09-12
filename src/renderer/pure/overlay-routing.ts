/** Identity-only routing helpers shared by the Basic Overlay renderer. */

export interface OverlayIdentity {
  id?: number;
  deviceId?: unknown;
  deviceKey?: unknown;
  deviceKeys?: unknown;
  /** Stable presentation ordinal after the display-driving adapter is first. */
  overlayOrdinal?: number;
  /** Read-only inventory signal: this physical adapter currently drives a display. */
  displayActive?: boolean | null;
  osController?: { displayActive?: boolean | null } | null;
}

export function normalizeOverlayIdentityKey(value: unknown): string | null {
  const key = typeof value === 'string' ? value.trim().replace(/[\u0000\s]+/g, '').toUpperCase() : '';
  return key.length > 0 ? key : null;
}

export function overlayIdentityAliases(value: OverlayIdentity | null | undefined): string[] {
  if (!value) return [];
  return [...new Set([
    value.deviceKey,
    ...(Array.isArray(value.deviceKeys) ? value.deviceKeys : []),
  ].map(normalizeOverlayIdentityKey).filter((key): key is string => key !== null))];
}

export function overlayStableDeviceKey(value: OverlayIdentity): string {
  if (typeof value.deviceKey === 'string' && value.deviceKey.trim().length > 0) return value.deviceKey.trim();
  if (Array.isArray(value.deviceKeys)) {
    const alias = value.deviceKeys.find((key) => typeof key === 'string' && key.trim().length > 0);
    if (alias) return alias.trim();
  }
  return `id:${value.id}`;
}

/** Keep the first inventory row for each physical device. Inventory sources
 * can expose the same adapter more than once with different numeric ids but
 * overlapping durable aliases. */
export function dedupeOverlayDevices<T extends OverlayIdentity>(devices: readonly T[]): T[] {
  const result: T[] = [];
  for (const device of devices) {
    const aliases = overlayIdentityAliases(device);
    const canonical = normalizeOverlayIdentityKey(device.deviceKey);
    const duplicateIndex = result.findIndex((known) => {
      const knownCanonical = normalizeOverlayIdentityKey(known.deviceKey);
      if (canonical && knownCanonical && canonical === knownCanonical) return true;
      const knownAliases = overlayIdentityAliases(known);
      // An overlapping alias alone is not enough: a duplicated PNP string can
      // belong to two real adapters. An exact alias set describes the same
      // physical row exposed by two inventory providers; distinct secondary
      // identities stay independent and selectable.
      return aliases.length > 0
        && knownAliases.length > 0
        && aliases.length === knownAliases.length
        && aliases.every((alias) => knownAliases.includes(alias));
    });
    if (duplicateIndex >= 0) {
      continue;
    }
    result.push(device);
  }
  return result;
}

function displayActiveOf(device: OverlayIdentity): boolean | null {
  if (device.displayActive === true || device.osController?.displayActive === true) return true;
  if (device.displayActive === false || device.osController?.displayActive === false) return false;
  return null;
}

/**
 * Keep the desktop display adapter in the first presentation slot. This only
 * changes the UI/overlay order; it never changes the session-local numeric id
 * used for device-scoped routing. Unknown display state remains in the source
 * order until the inventory can provide physical display proof.
 */
export function overlayDeviceOrder<T extends OverlayIdentity>(devices: readonly T[]): T[] {
  return devices.map((device, index) => ({ device, index })).sort((left, right) => {
    const leftActive = displayActiveOf(left.device);
    const rightActive = displayActiveOf(right.device);
    const activeDiff = Number(rightActive === true) - Number(leftActive === true);
    if (activeDiff !== 0) return activeDiff;
    if (leftActive === true && rightActive === true) {
      const keyDiff = overlayStableDeviceKey(left.device).localeCompare(overlayStableDeviceKey(right.device));
      if (keyDiff !== 0) return keyDiff;
    }
    return left.index - right.index;
  }).map(({ device }) => device);
}

export function overlaySampleMatchesDevice(
  sample: OverlayIdentity | null | undefined,
  device: OverlayIdentity | null | undefined,
): boolean {
  if (!sample || !device) return false;
  const sampleKeys = overlayIdentityAliases(sample);
  const deviceKeys = overlayIdentityAliases(device);
  if (sampleKeys.length > 0 || deviceKeys.length > 0) {
    return sampleKeys.some((key) => deviceKeys.includes(key));
  }
  const sampleId = typeof sample.deviceId === 'number' ? sample.deviceId : sample.id;
  return typeof sampleId === 'number' && sampleId === device.id;
}

export function resolveOverlayDevice<T extends OverlayIdentity & { id: number }>(
  devices: readonly T[],
  requested: string | number,
): T | null {
  const uniqueDevices = dedupeOverlayDevices(devices);
  if (typeof requested === 'number') return uniqueDevices.find((device) => device.id === requested) ?? null;
  const key = normalizeOverlayIdentityKey(requested);
  if (!key) return null;
  const matches = uniqueDevices.filter((device) => overlayIdentityAliases(device).includes(key));
  return matches.length === 1 ? matches[0] : null;
}

export interface OverlayMainSelection {
  deviceId?: number | null;
  deviceKey?: string | null;
}

/** Resolve the CPU/RAM telemetry owner independently from the display GPU.
 * A durable identity is authoritative; a numeric id is only a legacy
 * fallback. An ambiguous durable alias fails closed so a reordered inventory
 * can never silently route the main lane to another physical adapter. */
export function resolveOverlayMainDevice<T extends OverlayIdentity & { id: number }>(
  monitored: readonly T[],
  inventory: readonly T[],
  selection: OverlayMainSelection,
  fallbackId: number | null = null,
): T | null {
  const requestedKey = normalizeOverlayIdentityKey(selection.deviceKey);
  if (requestedKey) {
    const monitoredMatches = monitored.filter((device) => overlayIdentityAliases(device).includes(requestedKey));
    if (monitoredMatches.length === 1) return monitoredMatches[0];
    if (monitoredMatches.length > 1) return null;
    const inventoryMatches = inventory.filter((device) => overlayIdentityAliases(device).includes(requestedKey));
    return inventoryMatches.length === 1 ? inventoryMatches[0] : null;
  }
  const requestedId = Number.isInteger(selection.deviceId) ? selection.deviceId : fallbackId;
  if (!Number.isInteger(requestedId)) return null;
  return monitored.find((device) => device.id === requestedId)
    ?? inventory.find((device) => device.id === requestedId)
    ?? null;
}
