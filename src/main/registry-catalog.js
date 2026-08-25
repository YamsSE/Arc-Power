// Arc Power - M3-A/M3-B registry hacks CATALOG (file-driven data).
//
// The catalog is file-driven data: what each known, reversible Windows GPU
// tweak is, which registry values prove its current state, and how to read
// that state - all read-only (reg.exe `query`, no elevation). Each entry
// also carries the M3-B APPLY descriptor: the exact elevated reg.exe
// commands that write the tweak's enabled/disabled state and the revert
// (restore prior value). APPLYING runs ELEVATED (every entry requires
// administrator) and is orchestrated by registry-apply.js, never here.
//
// The parsers are pure (no process calls) and unit-tested; the real adapter
// runs `reg query` with an injectable execFile; the default adapter for
// tests/--ui-verify/mock mode is the MOCK (never spawns reg.exe).
//
// Catalog state vocabulary per entry:
//   enabled  - a read value matches the entry's `on` (the tweak is active);
//   disabled - a read value matches the entry's `off`;
//   default  - the key/value is not present (system default behavior);
//   unknown  - present but with an unexpected value (honest: show the raw).
// Entry state = any unknown wins; otherwise enabled > disabled > default.

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);

// reg.exe exit code when the queried key/value does not exist.
export const REG_NOT_FOUND = 1;

// ---------------------------------------------------------------------------
// The catalog (file-driven data - public knowledge, each entry marked
// "verify on this machine in M3-B" where the key/value could vary by
// driver/Windows build).
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   description: string,
 *   requiresElevation: boolean,
 *   absentLabel: string,
 *   reads: Array<{
 *     path: string,
 *     value: string | null,     // null = enumerate the key (token search)
 *     type: 'DWORD' | 'REG_SZ',
 *     on: string,               // value (or token for enumerate reads) meaning "tweak active"
 *     off?: string,             // value meaning "tweak off" (named reads)
 *   }>,
 *   apply: {                     // M3-B: elevated apply descriptor (see registry-apply.js)
 *     applyable: boolean,        // false = read-only info entry (no commands)
 *     revertNote: string,        // what the revert restores (shown on the card)
 *     actions?: {                // present iff applyable
 *       enable: RegistryApplyStep[],   // write the tweak's active state
 *       disable: RegistryApplyStep[],  // write the tweak's inactive state
 *       revert: RegistryApplyStep[],   // restore the prior value (delete = system default)
 *     },
 *   },
 * }} RegistryEntry
 */

/**
 * @typedef {{
 *   kind: 'add' | 'delete',
 *   path: string,       // hive-qualified key path ("HKLM\..." / "HKCU\...")
 *   value: string,      // value name ('' for delete-by-path-only - unused today)
 *   type?: string,      // REG_DWORD etc. (add steps only)
 *   data?: string,      // the value data (add steps only; decimal - reg.exe stores DWORD)
 * }} RegistryApplyStep
 */

export const REGISTRY_CATALOG = [
  {
    id: 'mpo',
    name: 'Multiplane Overlay (MPO)',
    // M3-C-H: plain-language, 1-2 lines (the long canonical-location /
    // hive-caveat prose is gone).
    description:
      'Windows uses MPO to composite windows on separate planes; some setups see stutter, flicker, or black screens. It is off by default in Windows. Enable this tweak to disable MPO for compatibility testing.',
    requiresElevation: true,
    absentLabel: 'Not set - MPO follows the driver default (usually on)',
    reads: [
      { path: 'HKLM\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences', value: 'MPOHack', type: 'DWORD', on: '1', off: '0' },
      { path: 'HKCU\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences', value: 'MPOHack', type: 'DWORD', on: '1', off: '0' },
    ],
    // M3-B apply: MPOHack=1 disables MPO (the tweak's active state). The
    // inactive state is MPOHack=0; REVERT deletes the value in both hives,
    // which restores the system default (MPO on). The live e2e confirms the
    // canonical key/value on this machine (see the description note above).
    apply: {
      applyable: true,
      revertNote: 'Revert deletes MPOHack from both hives - MPO follows the driver default again (usually on).',
      actions: {
        enable: [
          { kind: 'add', path: 'HKLM\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences', value: 'MPOHack', type: 'REG_DWORD', data: '1' },
          { kind: 'add', path: 'HKCU\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences', value: 'MPOHack', type: 'REG_DWORD', data: '1' },
        ],
        disable: [
          { kind: 'add', path: 'HKLM\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences', value: 'MPOHack', type: 'REG_DWORD', data: '0' },
          { kind: 'add', path: 'HKCU\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences', value: 'MPOHack', type: 'REG_DWORD', data: '0' },
        ],
        revert: [
          { kind: 'delete', path: 'HKLM\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences', value: 'MPOHack' },
          { kind: 'delete', path: 'HKCU\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences', value: 'MPOHack' },
        ],
      },
    },
  },
  {
    id: 'hags',
    name: 'Hardware-accelerated GPU scheduling',
    description:
      'HAGS lets the GPU scheduler manage VRAM instead of the CPU driver thread - better input latency on some systems, stutter on others. Needs a reboot to take effect.',
    requiresElevation: true,
    absentLabel: 'Not set - follows the Windows default (on for recent builds)',
    reads: [
      { path: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers', value: 'HwSchMode', type: 'DWORD', on: '2', off: '1' },
    ],
    // M3-B apply: HwSchMode 2 = on / 1 = off; REVERT deletes the value so
    // the Windows default applies.
    apply: {
      applyable: true,
      revertNote: 'Revert deletes HwSchMode - the Windows default applies (on for recent builds).',
      actions: {
        enable: [
          { kind: 'add', path: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers', value: 'HwSchMode', type: 'REG_DWORD', data: '2' },
        ],
        disable: [
          { kind: 'add', path: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers', value: 'HwSchMode', type: 'REG_DWORD', data: '1' },
        ],
        revert: [
          { kind: 'delete', path: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers', value: 'HwSchMode' },
        ],
      },
    },
  },
  {
    id: 'game-dvr',
    name: 'Game DVR / Background Recording',
    description:
      'Game Bar background recording can cost a few percent of FPS; this disables it machine-wide.',
    requiresElevation: true,
    absentLabel: 'Not configured - recording follows the user setting',
    reads: [
      { path: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\GameDVR', value: 'AllowGameDVR', type: 'DWORD', on: '0', off: '1' },
    ],
    // M3-B apply: AllowGameDVR=0 disables background recording (the tweak's
    // active state); 1 = inactive. REVERT deletes the VALUE and keeps the
    // policy key (safer than deleting the key - other policies may live in
    // it), so recording follows the per-user Game Bar setting again.
    apply: {
      applyable: true,
      revertNote: 'Revert deletes AllowGameDVR (the policy key stays) - recording follows the per-user Game Bar setting again.',
      actions: {
        enable: [
          { kind: 'add', path: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\GameDVR', value: 'AllowGameDVR', type: 'REG_DWORD', data: '0' },
        ],
        disable: [
          { kind: 'add', path: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\GameDVR', value: 'AllowGameDVR', type: 'REG_DWORD', data: '1' },
        ],
        revert: [
          { kind: 'delete', path: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\GameDVR', value: 'AllowGameDVR' },
        ],
      },
    },
  },
  {
    id: 'fullscreen-optimizations',
    name: 'Fullscreen Optimizations (per-app)',
    description:
      'A per-app compatibility flag - some games stutter with fullscreen optimizations on. There is no system-wide switch; this lists the apps carrying the flag.',
    requiresElevation: true,
    absentLabel: 'No per-app compatibility flags set',
    reads: [
      { path: 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers', value: null, type: 'REG_SZ', on: 'FULLSCREENOPTIMIZATIONS' },
    ],
    // M3-B: read-only INFO entry - there is no single system-wide switch to
    // write (the flag is per-app), so this entry has NO apply commands.
    apply: {
      applyable: false,
      revertNote: 'Read-only - no system-wide setting to apply or revert.',
    },
  },
];

// ---------------------------------------------------------------------------
// Pure parsers (unit-testable, no process calls)
// ---------------------------------------------------------------------------

/** Strip a DWORD hex prefix + whitespace for comparison ("0x1" -> "1"). */
export function normRegValue(v) {
  return String(v ?? '').trim().toLowerCase().replace(/^0x/, '');
}

/**
 * Parse `reg query <path> /v <name>` stdout into the value's data.
 * @param {string} stdout
 * @param {number} [exitCode]
 * @returns {{ found: boolean, value: string | null }}
 */
export function parseRegValueOutput(stdout, exitCode = 0) {
  if (exitCode === REG_NOT_FOUND) return { found: false, value: null };
  const m = String(stdout ?? '').match(/^[ \t]*\S+\s+REG_(?:DWORD|SZ|EXPAND_SZ|BINARY)\s+(\S+)\s*$/m);
  if (!m) return { found: false, value: null };
  return { found: true, value: m[1] };
}

/**
 * Parse `reg query <path>` (no /v - key enumeration) stdout into the
 * key's values.
 * @param {string} stdout
 * @param {number} [exitCode]
 * @returns {{ found: boolean, values: Array<{ name: string, type: string, data: string }> }}
 */
export function parseRegKeyEnum(stdout, exitCode = 0) {
  if (exitCode === REG_NOT_FOUND) return { found: false, values: [] };
  const values = [];
  for (const m of String(stdout ?? '').matchAll(/^[ \t]*(\S+)\s+REG_\w+\s+(.+?)\s*$/gm)) {
    values.push({ name: m[1], type: 'REG_SZ', data: m[2] });
  }
  return { found: values.length > 0, values };
}

/**
 * Interpret ONE read result against its read spec.
 * @param {import('../renderer/types.ts').RegistryRead} read
 * @param {{ found: boolean, value?: string | null, values?: Array<{ name: string, type: string, data: string }> }} res
 * @returns {{ state: 'enabled'|'disabled'|'unknown'|'default', detail: string }}
 */
export function interpretRead(read, res) {
  if (!res.found) return { state: 'default', detail: 'not present' };
  // Enumerate-style read: the `on` field is a token searched in any value.
  if (read.value === null) {
    const flagged = (res.values ?? []).filter((v) => normRegValue(v.data).includes(normRegValue(read.on)));
    if (flagged.length > 0) {
      return { state: 'enabled', detail: `${flagged.length} app(s) carry the ${read.on} flag` };
    }
    return { state: 'disabled', detail: 'flags present, none carry the token' };
  }
  const value = res.value;
  const norm = normRegValue(value);
  if (norm === normRegValue(read.on)) return { state: 'enabled', detail: `${read.value}=${value}` };
  if (read.off !== undefined && norm === normRegValue(read.off)) return { state: 'disabled', detail: `${read.value}=${value}` };
  return { state: 'unknown', detail: `${read.value}=${value} (unexpected)` };
}

/**
 * Combine per-read states into the entry state. Unknown (unexpected value)
 * wins - the UI must not guess; then enabled > disabled > default.
 * @param {import('../renderer/types.ts').RegistryEntry} entry
 * @param {Array<{ read: object, res: { found: boolean, value?: string|null, values?: Array<object> } }>} reads
 * @returns {{ state: 'enabled'|'disabled'|'unknown'|'default', detail: string }}
 */
export function interpretEntry(entry, reads) {
  const interpreted = reads.map(({ read, res }) => ({ read, res, out: interpretRead(read, res) }));
  if (interpreted.some(({ out }) => out.state === 'unknown')) return { state: 'unknown', detail: 'Unexpected registry values - inspect the reads below' };
  if (interpreted.some(({ out }) => out.state === 'enabled')) {
    return { state: 'enabled', detail: interpreted.map(({ out }) => out.detail).join(' · ') };
  }
  if (interpreted.some(({ out }) => out.state === 'disabled')) {
    return { state: 'disabled', detail: interpreted.map(({ out }) => out.detail).join(' · ') };
  }
  return { state: 'default', detail: entry.absentLabel };
}

// ---------------------------------------------------------------------------
// Real adapter (read-only reg.exe queries via injectable execFile)
// ---------------------------------------------------------------------------

/**
 * Query one registry value read-only. Never throws - an absent key/value,
 * a spawn failure or a timeout all degrade to { found: false }.
 */
async function queryRead(read, exec) {
  const args = read.value === null
    ? ['query', read.path]
    : ['query', read.path, '/v', read.value];
  try {
    const { stdout } = await exec('reg', args, { windowsHide: true, maxBuffer: 64 * 1024, timeout: 10000 });
    return read.value === null
      ? parseRegKeyEnum(stdout)
      : parseRegValueOutput(stdout);
  } catch (err) {
    // reg.exe exits 1 for absent keys/values; anything else (spawn failure,
    // timeout) also degrades to not-found - the catalog reads as 'default'.
    return read.value === null
      ? parseRegKeyEnum(typeof err?.stdout === 'string' ? err.stdout : '', err?.code)
      : parseRegValueOutput(typeof err?.stdout === 'string' ? err.stdout : '', err?.code);
  }
}

/**
 * Read every catalog entry's current state.
 * @param {RegistryEntry[]} [catalog]
 * @param {{ exec?: typeof execFile }} [deps]
 * @returns {Promise<{ entries: RegistryEntry[], states: Array<{ id: string, state: string, detail: string, reads: Array<{ read: object, found: boolean, value: string|null, state: string, detail: string }> }> }>}
 */
export async function readCatalogStates(catalog = REGISTRY_CATALOG, { exec = execFile } = {}) {
  const states = [];
  for (const entry of catalog) {
    const reads = [];
    for (const read of entry.reads) {
      const res = await queryRead(read, exec);
      const { state, detail } = interpretRead(read, res);
      reads.push({
        read,
        res,
        found: res.found,
        value: res.found && read.value !== null ? (res.value ?? null) : null,
        state,
        detail,
      });
    }
    const { state, detail } = interpretEntry(entry, reads.map((r) => ({ read: r.read, res: r.res })));
    states.push({
      id: entry.id,
      state,
      detail,
      reads: reads.map(({ read, found, value, state: s, detail: d }) => ({ read, found, value, state: s, detail: d })),
    });
  }
  return { entries: catalog, states };
}

/**
 * Real adapter - injected into the IPC handlers in the product path.
 */
export function createRegistryCatalog(deps = {}) {
  return { get: () => readCatalogStates(REGISTRY_CATALOG, { exec: deps.execFile ?? execFile }) };
}

// ---------------------------------------------------------------------------
// Mock registry STATE - a mutable, in-memory stand-in for the real registry
// shared by the mock READ adapter (createMockRegistryCatalog) and the mock
// APPLY adapter (createMockRegistryApply in registry-apply.js). Applying a
// command step mutates the state exactly like the real reg.exe command
// would (add -> value present; delete -> value absent), so the read side
// honestly reflects what the apply side "wrote". Never touches the real
// registry.
// ---------------------------------------------------------------------------

const MOCK_READ_STATES = {
  // MPO: HKLM unset, HKCU explicitly 0x0 (an app reset it) -> entry 'disabled'.
  mpo: [
    { found: false, value: null, state: 'default', detail: 'not present' },
    { found: true, value: '0x0', state: 'disabled', detail: 'MPOHack=0x0' },
  ],
  // HAGS on (HwSchMode=2 - the common Win11 default).
  hags: [{ found: true, value: '0x2', state: 'enabled', detail: 'HwSchMode=0x2' }],
  // Game DVR policy not configured.
  'game-dvr': [{ found: false, value: null, state: 'default', detail: 'not present' }],
  // One app flagged for fullscreen-optimizations-off (enumerate read).
  'fullscreen-optimizations': [{
    found: true,
    value: null,
    values: [{ name: 'game.exe', type: 'REG_SZ', data: '~ FULLSCREENOPTIMIZATIONS' }],
    state: 'enabled',
    detail: '1 app(s) carry the FULLSCREENOPTIMIZATIONS flag',
  }],
};

/**
 * Create a mutable mock registry state, seeded from the deterministic
 * fixture states (one per vocabulary entry). The returned `applyStep`
 * applies ONE command step (the exact shape the M3-B descriptors use):
 * add -> the matching read becomes present with the step's data; delete ->
 * the matching read becomes absent. A step that matches no read is a no-op
 * (the catalog only writes what it reads - but it must not throw).
 * @param {RegistryEntry[]} [catalog]
 */
export function createMockRegistryState(catalog = REGISTRY_CATALOG) {
  const state = new Map();
  for (const entry of catalog) {
    const readStates = MOCK_READ_STATES[entry.id] ?? entry.reads.map(() => ({ found: false, value: null, state: 'default', detail: 'not present' }));
    state.set(entry.id, entry.reads.map((read, i) => ({
      read,
      found: readStates[i]?.found ?? false,
      value: readStates[i]?.value ?? null,
      values: readStates[i]?.values ?? null,
    })));
  }
  return {
    applyStep(step) {
      for (const reads of state.values()) {
        for (const rec of reads) {
          if (rec.read.value === null || rec.read.path !== step.path || rec.read.value !== step.value) continue;
          if (step.kind === 'add') {
            rec.found = true;
            rec.value = `0x${String(step.data).toLowerCase()}`;
            rec.values = null;
          } else if (step.kind === 'delete') {
            rec.found = false;
            rec.value = null;
            rec.values = null;
          }
        }
      }
    },
    readsOf(entryId) {
      return state.get(entryId) ?? [];
    },
  };
}

/**
 * Mock adapter - used whenever the app runs in mock mode (tests, --ui-verify,
 * RID_BACKEND=mock). Deterministic fixture states, one per vocabulary entry;
 * never spawns reg.exe. When a `state` (createMockRegistryState) is shared
 * with the mock apply adapter, applies are reflected in subsequent reads.
 * @param {RegistryEntry[]} [catalog]
 * @param {{ state?: ReturnType<typeof createMockRegistryState> }} [deps]
 */
export function createMockRegistryCatalog(catalog = REGISTRY_CATALOG, { state = createMockRegistryState(catalog) } = {}) {
  return {
    get: async () => {
      const states = catalog.map((entry) => {
        const readStates = state.readsOf(entry.id);
        const reads = entry.reads.map((read, i) => {
          const rec = readStates[i] ?? { found: false, value: null };
          const { state: s, detail } = interpretRead(read, { found: rec.found, value: rec.value, values: rec.values ?? undefined });
          return {
            read,
            res: { found: rec.found, value: rec.value, values: rec.values ?? undefined },
            found: rec.found,
            value: rec.value,
            state: s,
            detail,
          };
        });
        const { state: s, detail } = interpretEntry(entry, reads.map((r) => ({ read: r.read, res: r.res })));
        return { id: entry.id, state: s, detail, reads: reads.map(({ read, found, value, state: st, detail: d }) => ({ read, found, value, state: st, detail: d })) };
      });
      return { entries: catalog, states };
    },
  };
}
