// M3-A — registry hacks catalog (read-side): catalog well-formedness, the
// pure reg.exe output parsers, per-read/per-entry interpretation, and the
// adapters (real with an injected execFile that never touches the registry,
// and the mock fixture used by tests/--ui-verify).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REGISTRY_CATALOG,
  REG_NOT_FOUND,
  normRegValue,
  parseRegValueOutput,
  parseRegKeyEnum,
  interpretRead,
  interpretEntry,
  readCatalogStates,
  createRegistryCatalog,
  createMockRegistryCatalog,
} from '../src/main/registry-catalog.js';

const DWORD_PRESENT = `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences
    MPOHack    REG_DWORD    0x1
`;
const SZ_PRESENT = `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers
    game.exe    REG_SZ    ~ FULLSCREENOPTIMIZATIONS
    launcher.exe    REG_SZ    ~ D3D9ON12
`;
const NOT_FOUND = 'ERROR: The system was unable to find the specified registry key or value.';

// ---------------------------------------------------------------------------
// Catalog well-formedness
// ---------------------------------------------------------------------------

test('catalog: entries are well-formed (ids unique, reads sane, all need elevation)', () => {
  const ids = REGISTRY_CATALOG.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
  for (const entry of REGISTRY_CATALOG) {
    assert.ok(entry.name.length > 0, `${entry.id}: name`);
    assert.ok(entry.description.length > 0, `${entry.id}: description`);
    assert.ok(entry.reads.length >= 1, `${entry.id}: at least one read`);
    assert.equal(entry.requiresElevation, true, `${entry.id}: every M3-A entry needs elevation (M3-B)`);
    for (const read of entry.reads) {
      assert.ok(read.path.startsWith('HKLM\\') || read.path.startsWith('HKCU\\'), `${entry.id}: hive path`);
      assert.ok(read.type === 'DWORD' || read.type === 'REG_SZ', `${entry.id}: read type`);
      assert.ok(read.on.length > 0, `${entry.id}: 'on' token`);
    }
  }
  assert.deepEqual(ids, ['mpo', 'hags', 'game-dvr', 'fullscreen-optimizations']);
});

// ---------------------------------------------------------------------------
// reg.exe output parsers (pure)
// ---------------------------------------------------------------------------

test('parseRegValueOutput: a present DWORD parses (hex kept raw)', () => {
  assert.deepEqual(parseRegValueOutput(DWORD_PRESENT), { found: true, value: '0x1' });
});

test('parseRegValueOutput: REG_NOT_FOUND (exit 1) reads as absent', () => {
  assert.deepEqual(parseRegValueOutput(NOT_FOUND, REG_NOT_FOUND), { found: false, value: null });
});

test('parseRegValueOutput: garbage / empty output reads as absent (never throws)', () => {
  assert.deepEqual(parseRegValueOutput(''), { found: false, value: null });
  assert.deepEqual(parseRegValueOutput('random noise\nno fields here'), { found: false, value: null });
  assert.deepEqual(parseRegValueOutput(NOT_FOUND), { found: false, value: null });
});

test('parseRegKeyEnum: enumerate output parses every value row', () => {
  const out = parseRegKeyEnum(SZ_PRESENT);
  assert.equal(out.found, true);
  assert.equal(out.values.length, 2);
  assert.equal(out.values[0].name, 'game.exe');
  assert.match(out.values[0].data, /FULLSCREENOPTIMIZATIONS/);
});

test('parseRegKeyEnum: not-found key reads as absent', () => {
  assert.deepEqual(parseRegKeyEnum(NOT_FOUND, REG_NOT_FOUND), { found: false, values: [] });
});

test('normRegValue: DWORD hex + whitespace + case normalization', () => {
  assert.equal(normRegValue('0x1'), '1');
  assert.equal(normRegValue('0X2'), '2');
  assert.equal(normRegValue(' 0x1 '), '1');
  assert.equal(normRegValue('fULLSCREENOPTIMIZATIONS'), 'fullscreenoptimizations');
});

// ---------------------------------------------------------------------------
// Interpretation
// ---------------------------------------------------------------------------

const mpoRead = { path: 'HKLM\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences', value: 'MPOHack', type: 'DWORD', on: '1', off: '0' };

test('interpretRead: DWORD named read — on / off / unexpected / absent', () => {
  assert.deepEqual(interpretRead(mpoRead, { found: true, value: '0x1' }), { state: 'enabled', detail: 'MPOHack=0x1' });
  assert.deepEqual(interpretRead(mpoRead, { found: true, value: '0x0' }), { state: 'disabled', detail: 'MPOHack=0x0' });
  assert.deepEqual(interpretRead(mpoRead, { found: true, value: '0x7' }), { state: 'unknown', detail: 'MPOHack=0x7 (unexpected)' });
  assert.deepEqual(interpretRead(mpoRead, { found: false }), { state: 'default', detail: 'not present' });
});

test('interpretRead: enumerate read — token present / key present without it / absent', () => {
  const enumRead = { path: 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers', value: null, type: 'REG_SZ', on: 'FULLSCREENOPTIMIZATIONS' };
  assert.deepEqual(
    interpretRead(enumRead, { found: true, values: [{ name: 'game.exe', type: 'REG_SZ', data: '~ FULLSCREENOPTIMIZATIONS' }] }),
    { state: 'enabled', detail: '1 app(s) carry the FULLSCREENOPTIMIZATIONS flag' },
  );
  assert.deepEqual(
    interpretRead(enumRead, { found: true, values: [{ name: 'launcher.exe', type: 'REG_SZ', data: '~ D3D9ON12' }] }),
    { state: 'disabled', detail: 'flags present, none carry the token' },
  );
  assert.deepEqual(interpretRead(enumRead, { found: false }), { state: 'default', detail: 'not present' });
});

test('interpretEntry: unknown wins, then enabled > disabled > default', () => {
  const entry = REGISTRY_CATALOG.find((e) => e.id === 'mpo');
  const mk = (resA, resB) => [
    { read: mpoRead, res: resA },
    { read: { ...mpoRead, path: 'HKCU\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences' }, res: resB },
  ];
  // HKLM enabled -> entry enabled even though HKCU is absent.
  assert.equal(interpretEntry(entry, mk({ found: true, value: '0x1' }, { found: false })).state, 'enabled');
  // HKLM disabled + HKCU absent -> disabled.
  assert.equal(interpretEntry(entry, mk({ found: true, value: '0x0' }, { found: false })).state, 'disabled');
  // Both absent -> default (with the entry's absent label).
  assert.deepEqual(interpretEntry(entry, mk({ found: false }, { found: false })), { state: 'default', detail: entry.absentLabel });
  // Any unexpected value -> unknown (the UI must not guess).
  assert.equal(interpretEntry(entry, mk({ found: true, value: '0x1' }, { found: true, value: '0x5' })).state, 'unknown');
  // Enabled in EITHER hive -> enabled.
  assert.equal(interpretEntry(entry, mk({ found: false }, { found: true, value: '0x1' })).state, 'enabled');
});

// ---------------------------------------------------------------------------
// Real adapter (injected execFile — the calls are asserted, never run)
// ---------------------------------------------------------------------------

test('readCatalogStates: queries each read with reg query and interprets (exec injected)', async () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const joined = args.join(' ');
    if (joined.includes('MPOHack') && joined.includes('HKLM')) return { stdout: '    MPOHack    REG_DWORD    0x1\n' };
    if (joined.includes('MPOHack')) return { stdout: NOT_FOUND };
    if (joined.includes('HwSchMode')) return { stdout: '    HwSchMode    REG_DWORD    0x2\n' };
    if (joined.includes('AllowGameDVR')) return { stdout: NOT_FOUND };
    if (joined.includes('AppCompatFlags\\Layers')) return { stdout: SZ_PRESENT };
    throw new Error(`unexpected query: ${joined}`);
  };

  const out = await readCatalogStates(REGISTRY_CATALOG, { exec });
  assert.equal(out.entries.length, 4);
  // Every named read went out as `reg query <path> /v <value>` (no /v for the
  // enumerate read) — read-only, no /add /d ever.
  assert.ok(calls.every((c) => c[0] === 'reg' && c[1] === 'query'));
  const named = calls.filter((c) => c.includes('/v'));
  assert.equal(named.length, 4); // mpo x2 + hags + game-dvr
  assert.equal(calls.length, 5); // + the fullscreen enumerate read
  assert.ok(calls.every((c) => !c.includes('/add') && !c.includes('/d')));

  const byId = Object.fromEntries(out.states.map((s) => [s.id, s]));
  assert.equal(byId.mpo.state, 'enabled');
  assert.equal(byId.hags.state, 'enabled');
  assert.deepEqual(byId.hags.reads[0], {
    read: REGISTRY_CATALOG[1].reads[0],
    found: true,
    value: '0x2',
    state: 'enabled',
    detail: 'HwSchMode=0x2',
  });
  assert.equal(byId['game-dvr'].state, 'default');
  assert.equal(byId['fullscreen-optimizations'].state, 'enabled');
  assert.equal(byId['fullscreen-optimizations'].reads[0].value, null, 'enumerate reads carry no single value');
});

test('readCatalogStates: a spawn failure degrades to default (never throws)', async () => {
  const out = await readCatalogStates(REGISTRY_CATALOG, {
    exec: async () => { throw new Error('reg.exe missing'); },
  });
  assert.ok(out.states.every((s) => s.state === 'default'));
});

// ---------------------------------------------------------------------------
// Mock adapter (tests/--ui-verify/mock mode — never spawns reg.exe)
// ---------------------------------------------------------------------------

test('createMockRegistryCatalog: deterministic fixture states, one per vocabulary entry', async () => {
  const out = await createMockRegistryCatalog().get();
  assert.equal(out.entries.length, 4);
  const byId = Object.fromEntries(out.states.map((s) => [s.id, s]));
  assert.equal(byId.mpo.state, 'disabled');
  assert.equal(byId.hags.state, 'enabled');
  assert.equal(byId['game-dvr'].state, 'default');
  assert.equal(byId['fullscreen-optimizations'].state, 'enabled');
  // Entry ids line up with entries.
  assert.deepEqual(out.states.map((s) => s.id), out.entries.map((e) => e.id));
});

test('createRegistryCatalog: real adapter factory defaults to the module execFile', () => {
  const real = createRegistryCatalog();
  assert.equal(typeof real.get, 'function');
});

test('catalog: every entry explains itself honestly (description + absentLabel present)', () => {
  for (const entry of REGISTRY_CATALOG) {
    assert.ok(entry.absentLabel.length > 0, `${entry.id}: absentLabel`);
    assert.ok(entry.description.length > 80, `${entry.id}: a real description (not a stub)`);
  }
});
