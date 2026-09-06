// Versioned, path-free Arc Power profile transfer envelope.

export const PROFILE_TRANSFER_FORMAT = 'arc-power-profile-transfer';
export const PROFILE_TRANSFER_SCHEMA_VERSION = 1;
const MAX_PROFILES = 500;
const MAX_DEVICE_KEYS = 256;

const GLOBAL_KEYS = [
  'theme', 'overlayEnabled', 'overlayHotkeyLetter', 'overlayPosition', 'overlayScale',
  'overlayColor', 'overlayStats', 'overlayDeviceKeys', 'overlayBgEnabled', 'overlayBgColor',
  'overlayBgOpacity', 'overlayChipNames', 'overlayPollMs', 'overlayTheme', 'overlayRecordingPill',
  'advancedOverlayEnabled', 'advancedOverlayHotkeyLetter', 'advancedOverlayPosition',
  'activeProfileId', 'activeProfileIds',
];
const RECORDING_KEYS = [
  'mode', 'fps', 'resolution', 'encoderId', 'bitrateKbps', 'captureTarget', 'captureColorMode',
  'showCursor', 'replayLengthSec', 'instantReplayAutoStart', 'replayMarkersEnabled', 'hotkeys', 'audio',
];

function cloneJson(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

function pick(source, keys) {
  const out = {};
  for (const key of keys) if (source && Object.prototype.hasOwnProperty.call(source, key)) out[key] = cloneJson(source[key]);
  return out;
}

function stableKeyOf(device) {
  if (typeof device?.deviceKey === 'string' && device.deviceKey.trim()) return device.deviceKey.trim();
  if (typeof device?.pnpDeviceId === 'string' && device.pnpDeviceId.trim()) return `pnp:${device.pnpDeviceId.trim()}`;
  const bdf = device?.bdf;
  if (bdf && Number.isInteger(Number(bdf.bus)) && Number.isInteger(Number(bdf.device))) {
    return `bdf:${Number(bdf.domain ?? 0)}:${Number(bdf.bus)}:${Number(bdf.device)}.${Number(bdf.function ?? 0)}`;
  }
  return null;
}

export function profileTransferDeviceKey(device) {
  return stableKeyOf(device);
}

function normalizePathPolicy(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const mode = source.mode === 'portable' ? 'portable' : 'stripped';
  const roots = Array.isArray(source.roots)
    ? [...new Set(source.roots.filter((root) => typeof root === 'string' && root.trim() && root.length <= 4096).map((root) => root.trim()))].slice(0, 16)
    : [];
  if (mode === 'portable' && roots.length === 0) throw new Error('Portable profile paths require at least one validated root');
  return { mode, roots };
}

export function createProfileTransferEnvelope({ appVersion = '0.0.0', profiles = [], settings = {}, recordingSettings = {}, devices = [], pathPolicy = { mode: 'stripped', roots: [] }, now = new Date().toISOString() } = {}) {
  const deviceKeys = [...new Set(devices.map(stableKeyOf).filter(Boolean))].slice(0, MAX_DEVICE_KEYS);
  const cleanProfiles = (Array.isArray(profiles) ? profiles : []).slice(0, MAX_PROFILES).map((profile) => ({
    id: typeof profile?.id === 'string' ? profile.id : '',
    name: typeof profile?.name === 'string' ? profile.name.slice(0, 128) : 'Profile',
    createdAt: typeof profile?.createdAt === 'string' ? profile.createdAt : now,
    schemaVersion: Number.isInteger(profile?.schemaVersion) ? profile.schemaVersion : 1,
    settings: cloneJson(profile?.settings) ?? {},
    ocOnBoot: profile?.ocOnBoot === true,
    ...(typeof profile?.deviceKey === 'string' && profile.deviceKey.trim() ? { deviceKey: profile.deviceKey.trim() } : {}),
    ...(typeof profile?.deviceName === 'string' && profile.deviceName.trim() ? { deviceName: profile.deviceName.trim().slice(0, 256) } : {}),
  }));
  return {
    format: PROFILE_TRANSFER_FORMAT,
    schemaVersion: PROFILE_TRANSFER_SCHEMA_VERSION,
    productVersion: String(appVersion),
    exportedAt: now,
    pathPolicy: normalizePathPolicy(pathPolicy),
    deviceKeys,
    profiles: cleanProfiles,
    settings: pick(settings, GLOBAL_KEYS),
    recording: pick(recordingSettings, RECORDING_KEYS),
  };
}

export function validateProfileTransferEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Profile import must be a JSON object');
  if (value.format !== PROFILE_TRANSFER_FORMAT) throw new Error('Profile import is not an Arc Power profile export');
  if (!Number.isInteger(value.schemaVersion) || value.schemaVersion < 1) throw new Error('Profile import has an invalid schema version');
  if (value.schemaVersion > PROFILE_TRANSFER_SCHEMA_VERSION) throw new Error('Profile import uses a newer unsupported schema');
  const pathPolicy = normalizePathPolicy(value.pathPolicy);
  if (!Array.isArray(value.profiles) || value.profiles.length > MAX_PROFILES) throw new Error('Profile import contains too many profiles');
  const profiles = value.profiles.map((profile) => {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Profile import contains an invalid profile');
    if (typeof profile.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(profile.id)) throw new Error('Profile import contains an invalid profile id');
    if (typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 128) throw new Error('Profile import contains an invalid profile name');
    if (profile.schemaVersion !== undefined && (!Number.isInteger(profile.schemaVersion) || profile.schemaVersion < 1)) throw new Error('Profile import contains an invalid profile schema version');
    const settings = cloneJson(profile.settings);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Profile import contains invalid tuning settings');
    return {
      ...profile,
      name: profile.name.trim(),
      settings,
      ocOnBoot: profile.ocOnBoot === true,
      ...(typeof profile.deviceKey === 'string' && profile.deviceKey.trim() ? { deviceKey: profile.deviceKey.trim() } : {}),
      ...(typeof profile.deviceName === 'string' && profile.deviceName.trim() ? { deviceName: profile.deviceName.trim().slice(0, 256) } : {}),
    };
  });
  const settings = value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings) ? pick(value.settings, GLOBAL_KEYS) : {};
  const recording = value.recording && typeof value.recording === 'object' && !Array.isArray(value.recording) ? pick(value.recording, RECORDING_KEYS) : {};
  const deviceKeys = Array.isArray(value.deviceKeys)
    ? [...new Set(value.deviceKeys.filter((key) => typeof key === 'string' && key.trim()).map((key) => key.trim()))].slice(0, MAX_DEVICE_KEYS)
    : [];
  return { format: PROFILE_TRANSFER_FORMAT, schemaVersion: PROFILE_TRANSFER_SCHEMA_VERSION, productVersion: String(value.productVersion ?? ''), exportedAt: String(value.exportedAt ?? ''), pathPolicy, deviceKeys, profiles, settings, recording };
}

function profileSchemaVersion(profile) {
  return Number.isInteger(profile?.schemaVersion) ? profile.schemaVersion : 1;
}

function importedName(name, usedNames) {
  const base = String(name).trim();
  if (!usedNames.has(base.toLowerCase())) return base;
  let suffix = 1;
  let candidate = `${base} (imported ${suffix})`;
  while (usedNames.has(candidate.toLowerCase())) candidate = `${base} (imported ${++suffix})`;
  return candidate;
}

/**
 * Validate identity and plan a complete import before any store mutation.
 * The plan retains orphaned bindings, so a later device reappearance can
 * resolve them without silently changing which GPU owns a profile.
 */
export function planProfileTransferImport({ incoming, existing = [], devices = [], currentSettings = {} } = {}) {
  const envelope = validateProfileTransferEnvelope(incoming);
  const current = Array.isArray(existing) ? existing : [];
  const deviceKeys = (Array.isArray(devices) ? devices : []).map(profileTransferDeviceKey).filter(Boolean);
  const deviceCounts = new Map();
  for (const key of deviceKeys) deviceCounts.set(key, (deviceCounts.get(key) ?? 0) + 1);
  const byId = new Map(current.map((profile) => [profile.id, profile]));
  const usedNames = new Set(current.map((profile) => String(profile?.name ?? '').trim().toLowerCase()).filter(Boolean));
  const applied = [];
  const skipped = [];
  const orphaned = [];
  const identityWarnings = [];
  const replacements = new Map();
  const orphanIds = new Set();

  for (const profile of envelope.profiles) {
    const previous = byId.get(profile.id);
    if (previous && profileSchemaVersion(profile) <= profileSchemaVersion(previous)) {
      skipped.push(profile.id);
      continue;
    }
    const deviceKey = typeof profile.deviceKey === 'string' && profile.deviceKey.trim() ? profile.deviceKey.trim() : null;
    if (deviceKey && (deviceCounts.get(deviceKey) ?? 0) !== 1) {
      orphaned.push(profile.id);
      orphanIds.add(profile.id);
      identityWarnings.push({ type: deviceCounts.has(deviceKey) ? 'duplicate-device-key' : 'missing-device-key', profileId: profile.id, deviceKey });
    } else {
      applied.push(profile.id);
    }
    const name = importedName(profile.name, usedNames);
    usedNames.add(name.toLowerCase());
    replacements.set(profile.id, { ...profile, name });
  }

  const mergedProfiles = current.slice();
  for (const [id, profile] of replacements) {
    const index = mergedProfiles.findIndex((item) => item.id === id);
    if (index >= 0) mergedProfiles[index] = profile;
    else mergedProfiles.push(profile);
  }

  const mergedSettings = { ...currentSettings };
  for (const [key, value] of Object.entries(envelope.settings)) {
    if (key !== 'activeProfileId' && key !== 'activeProfileIds') mergedSettings[key] = value;
  }
  const appliedSet = new Set(applied);
  if (Object.prototype.hasOwnProperty.call(envelope.settings, 'activeProfileId')) {
    const id = envelope.settings.activeProfileId;
    if (typeof id === 'string' && appliedSet.has(id) && !orphanIds.has(id)) mergedSettings.activeProfileId = id;
    else identityWarnings.push({ type: 'active-profile-skipped', scope: 'scalar', profileId: id ?? null });
  }
  if (Object.prototype.hasOwnProperty.call(envelope.settings, 'activeProfileIds')) {
    const active = currentSettings.activeProfileIds && typeof currentSettings.activeProfileIds === 'object'
      ? { ...currentSettings.activeProfileIds }
      : {};
    const importedActive = envelope.settings.activeProfileIds && typeof envelope.settings.activeProfileIds === 'object' ? envelope.settings.activeProfileIds : {};
    for (const [deviceKey, profileId] of Object.entries(importedActive)) {
      const profile = replacements.get(profileId);
      const boundKey = typeof profile?.deviceKey === 'string' ? profile.deviceKey : null;
      if (!appliedSet.has(profileId) || orphanIds.has(profileId) || boundKey !== deviceKey) {
        identityWarnings.push({ type: 'active-profile-skipped', scope: 'device', deviceKey, profileId });
        continue;
      }
      if (active[deviceKey] && active[deviceKey] !== profileId) {
        identityWarnings.push({ type: 'active-profile-conflict', scope: 'device', deviceKey, profileId, existingProfileId: active[deviceKey] });
        continue;
      }
      active[deviceKey] = profileId;
    }
    mergedSettings.activeProfileIds = active;
  }
  return {
    envelope,
    profiles: mergedProfiles,
    settings: mergedSettings,
    applied,
    skipped,
    orphaned,
    identityWarnings,
  };
}

export { GLOBAL_KEYS as PROFILE_TRANSFER_GLOBAL_KEYS, RECORDING_KEYS as PROFILE_TRANSFER_RECORDING_KEYS };
