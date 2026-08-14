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

const helperLog = createSysmanHelperLogFileWriter();

const code = await runSysmanHelperPipeMode({
  // A fresh consumer per init attempt - the real createSysmanPowerLimits
  // LATCHES its degrade, so each attempt must be a new instance. The
  // consumer's log is pinned to the helper's OWN log file.
  createConsumer: () => createSysmanPowerLimits({ log: (s) => helperLog(`[sysman] ${s}`) }),
  log: (s) => helperLog(s),
});

process.exit(code);
