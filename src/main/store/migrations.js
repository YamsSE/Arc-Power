// Arc Power - M1 store migrations.
//
// Every persisted file (profiles.json, settings.json) carries a
// schemaVersion. Migrations are pure functions chained 0->1->2...; a file
// with an unknown/newer schemaVersion is REFUSED (never silently clobbered).
// v0 = pre-schema files that existed without a schemaVersion field.
//
// M4-D: settings gains startWithWindows + startMinimized. Both ride the
// ABSENT-FIELD DEFAULTS mechanism in loadSettings (like ocMode and
// advancedModeAccepted) - an old file without them reads false, so there is
// deliberately NO SCHEMA_VERSION bump (Round-1 F8).
// M16 (B1): settings gains the M16 overlay stat ids (gpu-voltage +
// gpu-vram-temp). This one DOES bump the schema (v2 -> v3): a persisted
// overlayStats from M15 must gain the new ids ONCE (the new overlay
// fields would silently vanish for upgraded users), and the union must
// NEVER run on a file that already carries the user's post-M16 choices -
// an every-load union would resurrect a stat the user intentionally
// unchecked (the tickbox round-trip regression). The one-time migration
// is the only shape that upgrades old files without re-enabling later
// unchecks.

export const SCHEMA_VERSION = 3;

/**
 * v0 -> v1: adopt schemaVersion and normalize.
 * profiles.json v0: { profiles: [{ name, settings?, ocOnBoot? }] }
 * settings.json v0: { waiverAccepted?, ocOnBoot?, activeProfileId? }
 */
const MIGRATIONS = [
  {
    from: 0,
    to: 1,
    upProfiles: (data) => {
      const raw = Array.isArray(data.profiles) ? data.profiles : [];
      const profiles = raw.map((p, i) => ({
        id: typeof p.id === 'string' && p.id ? p.id : `profile-${i}`,
        name: typeof p.name === 'string' ? p.name : `Profile ${i + 1}`,
        createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date(0).toISOString(),
        schemaVersion: 1,
        settings: p.settings && typeof p.settings === 'object' ? { ...p.settings } : {},
        ocOnBoot: p.ocOnBoot === true,
      }));
      return { schemaVersion: 1, profiles };
    },
    upSettings: (data) => ({
      schemaVersion: 1,
      waiverAccepted: data.waiverAccepted === true,
      ocOnBoot: data.ocOnBoot === true,
      activeProfileId: typeof data.activeProfileId === 'string' ? data.activeProfileId : null,
    }),
  },
  // v1 -> v2 (M3-C-E): settings gains the OC mode slot. The migration does
  // NOT write a value: an ABSENT ocMode means "follow the store default"
  // (real product = stock, mock/ui-verify = advanced) - a hardcoded 'stock'
  // here would leak into mock sessions and break the extended-flow pins.
  // The first explicit toggle persists 'stock'|'advanced' and wins thereafter.
  {
    from: 1,
    to: 2,
    upProfiles: (data) => ({
      ...data,
      schemaVersion: 2,
      profiles: Array.isArray(data.profiles)
        ? data.profiles.map((p) => ({ ...p, schemaVersion: 2 }))
        : data.profiles,
    }),
    upSettings: (data) => {
      const out = {
        schemaVersion: 2,
        waiverAccepted: data.waiverAccepted === true,
        ocOnBoot: data.ocOnBoot === true,
        activeProfileId: typeof data.activeProfileId === 'string' ? data.activeProfileId : null,
      };
      if (data.ocMode === 'advanced' || data.ocMode === 'stock') out.ocMode = data.ocMode;
      return out;
    },
  },
  // v2 -> v3 (M16, B1): settings gains the two M16 overlay stat ids
  // ('gpu-voltage' - the GPU-row voltage field - and 'gpu-vram-temp' - the
  // VRAM row's trailing field). The spread keeps every v2-era field; the
  // union appends ONLY the ids the canonical list gained in M16 onto an
  // EXISTING persisted overlayStats array (in canonical order at the end) -
  // a user's intentional unchecks of pre-existing stats are preserved.
  // Absent/garbage overlayStats is left for the load-time defaults (the
  // full set, which already includes the new ids). The migration is
  // one-time: a file written after the upgrade carries the user's exact
  // choices and is never re-unioned (a stat unchecked in M16 stays
  // unchecked across reboots).
  {
    from: 2,
    to: 3,
    upProfiles: (data) => ({
      ...data,
      schemaVersion: 3,
      profiles: Array.isArray(data.profiles)
        ? data.profiles.map((p) => ({ ...p, schemaVersion: 3 }))
        : data.profiles,
    }),
    upSettings: (data) => {
      const out = { ...data, schemaVersion: 3 };
      if (Array.isArray(data.overlayStats)) {
        const m16Added = ['gpu-voltage', 'gpu-vram-temp'];
        const seen = new Set(data.overlayStats.filter((id) => typeof id === 'string'));
        out.overlayStats = [...data.overlayStats];
        for (const id of m16Added) {
          if (!seen.has(id)) out.overlayStats.push(id);
        }
      }
      return out;
    },
  },
];

function schemaVersionOf(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Cannot migrate store data: expected an object, got ${data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data}`);
  }
  if (data.schemaVersion === undefined || data.schemaVersion === null) return 0;
  const v = data.schemaVersion;
  if (!Number.isInteger(v) || v < 0) {
    throw new Error(`Cannot migrate store data: schemaVersion ${JSON.stringify(v)} is not a non-negative integer`);
  }
  return v;
}

function assertSupported(version) {
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `Store data has schemaVersion ${version}, but this app only supports up to ${SCHEMA_VERSION}. ` +
      'Refusing to load - the file was written by a newer version of Arc Power.',
    );
  }
}

/**
 * Migrate store data to the current schema. Throws on unknown/newer
 * versions and on malformed input. Never mutates the input.
 * @param {object} data
 * @param {'profiles'|'settings'} kind
 * @returns {object} migrated copy at SCHEMA_VERSION
 */
export function migrateStoreData(data, kind) {
  let version = schemaVersionOf(data);
  assertSupported(version);
  let out = data;
  while (version < SCHEMA_VERSION) {
    const migration = MIGRATIONS.find((m) => m.from === version);
    if (!migration) {
      throw new Error(`No migration path from schemaVersion ${version} (corrupt migration chain?)`);
    }
    out = kind === 'profiles' ? migration.upProfiles(out) : migration.upSettings(out);
    version = migration.to;
  }
  return out;
}

/**
 * Validate that loaded data is at the current schema (post-migration).
 * @param {object} data
 */
export function assertCurrentSchema(data) {
  const version = schemaVersionOf(data);
  assertSupported(version);
  if (version !== SCHEMA_VERSION) {
    throw new Error(`Migration failed: expected schemaVersion ${SCHEMA_VERSION}, got ${version}`);
  }
  return data;
}
