// Arc Power - M17o3 the RUN-AS-NODE sysman-helper entry (ELECTRON-FREE).
//
// WHY (the live finding, 2026-08-14): the packaged helper spawned as the
// ELECTRON EXE fails its ze init EVERY time (zesInit: ERROR_UNINITIALIZED -
// the measured 3/3 packaged-helper failures at 19:04/19:05/19:34 while a
// node-process init succeeded in the same minutes; the M17i-era 'the
// consumer's zesInit fails inside an ELECTRON process' was right all along,
// and the old matrix's 'bare electron OK' cell was a window-era fluke). The
// electron binary run with ELECTRON_RUN_AS_NODE=1 is a PLAIN NODE process -
// its ze init works (live-proven: RUNASNODE-VERDICT PL1 300 PL2 252).
//
// This entry is the --sysman-helper-pipe branch's wiring in a NO-ELECTRON
// file: the helper-mode + the consumer + process.exit. It imports NOTHING
// from 'electron' - the RUN-AS-NODE node cannot destructure the electron
// module (require('electron') yields the exe path in that mode).
//
// The proxy spawns it with: ELECTRON_RUN_AS_NODE=1 + the helper-entry path
// (the dev-tree: the real src file; the packaged: the app.asar's internal
// path) + '--sysman-helper-pipe' (parity with the M17m arg contract; the
// entry itself does not need it).

import { createSysmanPowerLimits } from './power-limits.js';
import { runSysmanHelperPipeMode, createSysmanHelperLogFileWriter } from './helper-mode.js';
import { createIgclWaiverBridge } from '../backend/igcl-bindings.js';

const helperLog = createSysmanHelperLogFileWriter();
// The Sysman voltage-target API is the writer, but this driver gates that
// writer on the IGCL overclock-waiver state. The bridge is lazy and is only
// initialized for an explicitly accepted voltage write, before Sysman itself
// initializes in the consumer.
const igclWaiver = createIgclWaiverBridge({ log: (s) => helperLog(`[igcl-waiver] ${s}`) });
// Open the IGCL context before the Sysman consumer performs its first
// `zesInit`; this ordering is required by the current Intel driver.
igclWaiver.warm();

// M17o4 THE EXIT-CRASH PROBE (N3): the user's A770 showed the 0xC0000409
// crash AFTER the helper's 'helper exiting (code 77)' log line (the
// packaged helper's failed-init exit). Registered FIRST (the very top of
// the entry, before the mode runs - the first 'exit' listener) and
// appending ONE SYNC line via the existing helperLog writer (a sync
// appendFileSync - legal in 'exit' handlers). The line appears on EVERY
// exit (0 / 77 / 1 - natural or process.exit), so the read-out is:
//   - 'exit-handler phase reached' present -> the crash is AFTER the JS
//     exit-handler phase (the C-level teardown - the koffi/IGCL DLL unload
//     at process teardown): document + accept;
//   - MISSING -> the crash is INSIDE the exit-handler phase -> check
//     BOTH teardown paths: power-limits.js for a koffi teardown (a
//     koffi.unload / DLL unload) to call BEFORE process.exit AND the
//     mode-teardown path (helper-mode.js finish() -> resolveExit -> the
//     entry's process.exit) for anything it leaves armed.
// process.exit stays: the electron-free entry's only teardown surface
// (process.exitCode + a natural exit would run MORE teardown - the crash
// class under investigation).
process.on('exit', () => {
  helperLog('exit-handler phase reached');
});

const code = await runSysmanHelperPipeMode({
  // A fresh consumer per init attempt - the real createSysmanPowerLimits
  // LATCHES its degrade, so each attempt must be a new instance. The
  // consumer's log is pinned to the helper's OWN log file.
  createConsumer: () => createSysmanPowerLimits({
    ensureVoltageWaiver: ({ physicalTarget, accepted }) => igclWaiver.setForTarget(physicalTarget, accepted),
    log: (s) => helperLog(`[sysman] ${s}`),
  }),
  log: (s) => helperLog(s),
});

process.exit(code);
