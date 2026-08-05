// Arc Power — M1 store migrations.
//
// Every persisted file (profiles.json, settings.json) carries a
// schemaVersion. Migrations are pure functions chained 0->1->2...; a file
// with an unknown/newer schemaVersion is REFUSED (never silently clobbered).
// v0 = pre-schema files that existed without a schemaVersion field.

export const SCHEMA_VERSION = 1;

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
      'Refusing to load — the file was written by a newer version of Arc Power.',
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
