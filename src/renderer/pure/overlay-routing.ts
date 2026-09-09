/** Identity-only routing helpers shared by the Basic Overlay renderer. */

export interface OverlayIdentity {
  id?: number;
  deviceId?: unknown;
  deviceKey?: unknown;
  deviceKeys?: unknown;
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
  if (typeof requested === 'number') return devices.find((device) => device.id === requested) ?? null;
  const key = normalizeOverlayIdentityKey(requested);
  if (!key) return null;
  const matches = devices.filter((device) => overlayIdentityAliases(device).includes(key));
  return matches.length === 1 ? matches[0] : null;
}
