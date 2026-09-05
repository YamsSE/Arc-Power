// Arc Power - M4-F pure device-selection helpers (no DOM): the boot
// selection preference, the selector visibility rule and the selector
// option list. The DOM `<select>` lives in components/device-select.ts; the
// switch flow lives in device.ts (createDeviceSwitcher). Unit-tested.

import type { DeviceInfo } from '../types.ts';

/** Return a durable identity only when the value is a non-empty string. */
export function normalizeDeviceKey(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Resolve a main-renderer selection push against the current inventory.
 * Durable identity wins over the session-local numeric id; numeric fallback
 * is allowed only for an unkeyed payload and an unkeyed inventory row.
 */
export function resolveSelectionDevice(
  devices: DeviceInfo[],
  deviceId: number,
  deviceKey: string | null | undefined,
): DeviceInfo | null {
  const key = normalizeDeviceKey(deviceKey);
  if (key !== null) {
    const matches = devices.filter((device) => deviceIdentityMatches(device, key));
    return matches.length === 1 ? matches[0] : null;
  }
  return devices.find((device) => device.id === deviceId
    && device.identityAmbiguous !== true
    && normalizeDeviceKey(device.deviceKey) === null) ?? null;
}

/**
 * Match telemetry to the selected adapter. If either side has a durable
 * identity, both must have the same identity; numeric IDs are a fallback
 * only when neither side is durably identified. A verified alias overlap is
 * allowed for the initial PCI/BDF -> enriched PNP transition, but only when
 * the session id is also unchanged.
 */
export function telemetryMatchesSelection(
  sampleDeviceId: number | null | undefined,
  sampleKey: string | null | undefined,
  selectedDeviceId: number | null,
  selectedKey: string | null | undefined,
  sampleAliases: readonly unknown[] = [],
  selectedAliases: readonly unknown[] = [],
): boolean {
  const sampleIdentity = normalizeDeviceKey(sampleKey);
  const selectedIdentity = normalizeDeviceKey(selectedKey);
  const sampleIdentities = new Set(
    [sampleIdentity, ...(Array.isArray(sampleAliases) ? sampleAliases : [])]
      .map((value) => normalizeDeviceKey(value))
      .filter((value): value is string => value !== null),
  );
  const selectedIdentities = new Set(
    [selectedIdentity, ...(Array.isArray(selectedAliases) ? selectedAliases : [])]
      .map((value) => normalizeDeviceKey(value))
      .filter((value): value is string => value !== null),
  );
  if (sampleIdentity !== null || selectedIdentity !== null) {
    if (sampleIdentity !== null && selectedIdentity !== null && sampleIdentity === selectedIdentity) return true;
    return sampleDeviceId !== undefined
      && selectedDeviceId !== null
      && sampleDeviceId === selectedDeviceId
      && [...sampleIdentities].some((identity) => selectedIdentities.has(identity));
  }
  return sampleDeviceId === undefined || sampleDeviceId === selectedDeviceId;
}

function deviceIdentityValues(device: DeviceInfo): Set<string> {
  return new Set([
    normalizeDeviceKey(device.deviceKey),
    ...(Array.isArray(device.deviceKeys) ? device.deviceKeys.map(normalizeDeviceKey) : []),
    deviceHardwareKey(device),
  ].filter((value): value is string => value !== null));
}

function deviceIdentityMatches(device: DeviceInfo, key: string): boolean {
  if (device.identityAmbiguous === true) return false;
  return deviceIdentityValues(device).has(key);
}

function uniqueIdentityMatch(devices: DeviceInfo[], key: string): DeviceInfo | null {
  const matches = devices.filter((device) => deviceIdentityMatches(device, key));
  return matches.length === 1 ? matches[0] : null;
}

function automaticIdentity(device: DeviceInfo): string {
  return normalizeDeviceKey(device.deviceKey) ?? deviceHardwareKey(device);
}

function uniqueAutomaticCandidates(devices: DeviceInfo[]): DeviceInfo[] {
  const counts = new Map<string, number>();
  for (const device of devices) {
    const identity = automaticIdentity(device);
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  return devices.filter((device) => device.identityAmbiguous !== true
    && counts.get(automaticIdentity(device)) === 1);
}

function sortAutomaticCandidates(devices: DeviceInfo[]): DeviceInfo[] {
  return [...devices].sort((a, b) => automaticIdentity(a).localeCompare(automaticIdentity(b)));
}

/**
 * Resolve a boot selection. With a durable key, identity wins; an explicit
 * null/absent key marks a legacy numeric-only setting as unverified. M151's
 * optional preferred id/key is a read-only automatic startup result. A valid
 * persisted dGPU is an explicit user target and therefore wins over that
 * automatic preference; a persisted iGPU is not allowed to defeat the
 * dGPU-first focus contract.
 */
export function resolveBootDevice(
  devices: DeviceInfo[],
  persistedId: number | null,
  persistedKey?: string | null,
  preferredId?: number | null,
  preferredKey?: string | null,
): number | null {
  if (devices.length === 0) return null;
  const allDiscrete = devices.filter((device) => !device.integrated && !isIntegratedStyleDevice(device));
  const discrete = uniqueAutomaticCandidates(allDiscrete);
  const hasDiscrete = allDiscrete.length > 0;
  const automatic = hasDiscrete ? discrete : uniqueAutomaticCandidates(devices);
  const persisted = typeof persistedKey === 'string' && persistedKey.length > 0
    ? uniqueIdentityMatch(devices, persistedKey)
    : persistedKey === undefined && Number.isInteger(persistedId)
      ? devices.find((device) => device.id === persistedId && device.identityAmbiguous !== true) ?? null
      : null;
  // A valid persisted/manual dGPU is explicit user intent. Keep it even when
  // the current display output is attached to another adapter.
  if (persisted && (!hasDiscrete || discrete.some((candidate) => candidate.id === persisted.id))) {
    return persisted.id;
  }

  if (typeof preferredKey === 'string' && preferredKey.length > 0) {
    const preferred = uniqueIdentityMatch(devices, preferredKey);
    if (preferred && automatic.some((candidate) => candidate.id === preferred.id)) {
      return preferred.id;
    }
  }
  if ((!preferredKey || preferredKey.length === 0)
    && Number.isInteger(preferredId)
    && automatic.some((candidate) => candidate.id === preferredId)) return preferredId as number;
  if (allDiscrete.length > 0) return sortAutomaticCandidates(discrete)[0]?.id ?? null;
  return sortAutomaticCandidates(automatic)[0]?.id ?? null;
}

/**
 * M4-F: the device selector renders ONLY with 2+ devices - the honest
 * single-device degradation (the live 1-GPU machine shows nothing new).
 */
export function showDeviceSelector(devices: DeviceInfo[]): boolean {
  return devices.length > 1;
}

/**
 * M4-F: the selector option list. Each option carries the device NAME
 * (the backend formats the VRAM suffix into device.name at enumeration
 * time - the option text never re-derives it); `selected` marks the
 * current device.
 */
export function deviceSelectorOptions(
  devices: DeviceInfo[],
  currentId: number | null,
): Array<{ id: number; label: string; selected: boolean }> {
  return devices.map((d) => ({ id: d.id, label: d.name, selected: d.id === currentId }));
}

/**
 * M179: preserve the current value in a renderer-owned menu even when its
 * option is disabled. Disabled controls cannot be chosen, so keyboard focus
 * starts on the first enabled option while the selected value stays intact.
 * With an all-disabled inventory the selected and active indices remain on
 * the first available option and no implicit switch is possible.
 */
export function selectorSelectionIndices(
  options: readonly { value: string; disabled?: boolean }[],
  currentValue: string,
): { selectedIndex: number; activeIndex: number } {
  const firstEnabled = options.findIndex((option) => option.disabled !== true);
  const matching = options.findIndex((option) => option.value === currentValue);
  if (matching >= 0) {
    return {
      selectedIndex: matching,
      activeIndex: options[matching]?.disabled === true && firstEnabled >= 0 ? firstEnabled : matching,
    };
  }
  const fallback = firstEnabled >= 0 ? firstEnabled : 0;
  return { selectedIndex: fallback, activeIndex: fallback };
}

/**
 * M4I (final-review F1): strip the VRAM suffix the backend formats into
 * device.name at enumeration ("Name 8GB GDDR6" / "Name 8GB") so a name
 * comparison (the dashboard's matchedController controller lookup) sees
 * the plain GPU name on BOTH sides. The M4H suffix (" 16 GB") was removed
 * by the M4I ceil+type format - without the strip the match falls back to
 * videoControllers[0] and the ReBAR pill can bind to the wrong GPU on
 * multi-GPU machines. Unit-tested.
 */
export function stripVramSuffix(name: string): string {
  return name.trim().replace(/\s+\d+\s*GB(\s+\S+)?$/i, '').trim();
}

/** Stable PCI/BDF identity mirror of the main-side deviceHardwareKey. */
export function deviceHardwareKey(device: Pick<DeviceInfo, 'pciVendorId' | 'pciDeviceId' | 'bdf'>): string {
  const vendor = String(device.pciVendorId ?? '').toLowerCase();
  const pci = String(device.pciDeviceId ?? '').toLowerCase();
  const bus = Number.isInteger(device.bdf?.bus) ? device.bdf.bus : -1;
  const slot = Number.isInteger(device.bdf?.device) ? device.bdf.device : -1;
  const fn = Number.isInteger(device.bdf?.function) ? device.bdf.function : -1;
  const hasBdf = bus !== 0 || slot !== 0 || fn !== 0;
  return `pci:${vendor}:${pci}@${hasBdf ? bus : -1}:${hasBdf ? slot : -1}.${hasBdf ? fn : -1}`;
}

export function isIntegratedStyleDevice(device: Pick<DeviceInfo, 'name'>): boolean {
  const name = String(device.name ?? '').replace(/\s+\d+\s*GB(?:\s+\S+)?$/i, '');
  if (/\b(?:iris|uhd|hd graphics|xe graphics)\b/i.test(name)) return true;
  return /\b(?:amd\s+)?radeon(?:\s*\([^)]*\))?\s+graphics\b/i.test(name)
    || /\b(?:radeon|vega)(?:\s*\([^)]*\))?\s+\d{3,4}m\b/i.test(name)
    || (/\barc\b/i.test(name) && !/\b(?:a\d{3}|b\d{2,3}|pro)\b/i.test(name));
}

export function sortDevicesDiscreteFirst<T extends Pick<DeviceInfo, 'name' | 'pciVendorId' | 'pciDeviceId' | 'bdf'>>(devices: T[]): T[] {
  return devices.map((device, index) => ({ device, index })).sort((a, b) => {
    const classDiff = Number(isIntegratedStyleDevice(a.device)) - Number(isIntegratedStyleDevice(b.device));
    if (classDiff !== 0) return classDiff;
    const keyDiff = deviceHardwareKey(a.device).localeCompare(deviceHardwareKey(b.device));
    return keyDiff !== 0 ? keyDiff : a.index - b.index;
  }).map(({ device }) => device);
}

/**
 * Resolve a featureset swap. A selected read-only/unsupported device keeps
 * its stable-key row when it is still present so its no-tuning surface stays
 * visible; a writable selection follows the newly requested active row.
 */
export function resolveFeaturesetSwapSelection(
  devices: DeviceInfo[],
  selectedKey: string | null,
  activeKey: string | null,
  preserveSelected: boolean,
): { device: DeviceInfo | null; preserved: boolean } {
  const selected = preserveSelected && selectedKey
    ? devices.find((device) => device.deviceKey === selectedKey) ?? null
    : null;
  const active = activeKey
    ? devices.find((device) => device.deviceKey === activeKey) ?? null
    : null;
  return { device: selected ?? active ?? devices[0] ?? null, preserved: selected !== null };
}
