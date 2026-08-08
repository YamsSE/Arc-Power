// Arc Power - M4L CPU temp + wattage via PawnIO (electron-free, koffi).
//
// The HWiNFO/GPU-Z/LHM-class route: a signed kernel driver reading the CPU's
// MSRs. Windows exposes NO user-mode CPU temperature/wattage on this machine
// (the ACPI zone is a fake board sensor; the PowerMeter class is absent) -
// the plan's ground truth. PawnIO (namazso/PawnIO, GPL-2.0 + the special
// exception: independent modules communicating solely via the device IOCTL
// interface are exempt - exactly this app's use) is the successor to the
// dead WinRing0. The app loads the LGPL-2.1 IntelMSR.bin module (PawnIO.
// Modules 0.2.10) and executes "ioctl_read_msr" per sample.
//
// Protocol (pawnio_um.h + PawnIOLib.cpp, source-verified 2026-08-08):
//   CreateFile("\\?\GLOBALROOT\Device\PawnIO", R/W, share R/W/DELETE);
//   IOCTL_PIO_LOAD_BINARY = CTL_CODE(41394, 0x821, BUFFERED, ANY) = 0xA1B22084
//     - the input buffer IS the module bytes (no output);
//   IOCTL_PIO_EXECUTE_FN   = CTL_CODE(41394, 0x841, BUFFERED, ANY) = 0xA1B22104
//     - input  = 32-byte zero-padded function name + the ULONG64 input array;
//     - output = the ULONG64 output array (the written byte count / 8 = the
//       number of returned values; out[0] = the 64-bit MSR value).
//   The calling path matches LibreHardwareMonitor's PawnIo.cs / IntelMsr.cs
//   (the LHM precedent, MPL-2.0): same device path, same ioctls, same
//   32-byte name field + long[] layout.
//
// Every read returns null on ANY error (device absent, module load refused,
// AV quarantine, an unelevated process) - the honest degrade, never a fake
// number and never a thrown exception. The driver open + module load happen
// ONCE per session (lazy, at the first sample), never per tick.
//
// The MSR math (LHM IntelCpu.cs-verified):
//   packageTempC = TjMax - DTS where
//     TjMax = (MSR_IA32_TEMPERATURE_TARGET 0x1A2 >> 16) & 0xFF,
//     DTS   = (MSR_IA32_PACKAGE_THERM_STATUS 0x1B1 & 0x007F0000) >> 16,
//     VALID ONLY when 0x1B1 bit 31 is set.
//   packagePowerW = (dE * 2^-ESU) / dt where
//     ESU = (MSR_RAPL_POWER_UNIT 0x606 >> 8) & 0x1F,
//     dE  = the 32-bit wrapped delta of MSR_PKG_ENERGY_STATUS 0x611,
//     dt  >= 10 ms from a monotonic wall-clock (no time-unit register).
//   The first energy sample calibrates (null until the second).

import koffi from 'koffi';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);

export const PAWNIO_DEVICE_PATH = '\\\\?\\GLOBALROOT\\Device\\PawnIO';
export const IOCTL_LOAD_BINARY = 0xA1B22084;
export const IOCTL_EXECUTE = 0xA1B22104;
export const FN_NAME_LENGTH = 32;
export const IOCTL_READ_MSR = 'ioctl_read_msr';
// The MSRs (LHM IntelCpu.cs constants).
export const MSR_TEMPERATURE_TARGET = 0x1A2; // TjMax
export const MSR_PACKAGE_THERM_STATUS = 0x1B1; // the package DTS
export const MSR_RAPL_POWER_UNIT = 0x606; // ESU
export const MSR_PKG_ENERGY_STATUS = 0x611; // the package energy counter

export const GENERIC_READ = 0x80000000;
export const GENERIC_WRITE = 0x40000000;
export const FILE_SHARE_READ = 0x1;
export const FILE_SHARE_WRITE = 0x2;
export const FILE_SHARE_DELETE = 0x4;
export const OPEN_EXISTING = 3;

// The official silent install flags (resolved at C0 from the setup's own
// UTF-16 usage strings): "-install -silent" installs the OFFICIAL signed
// edition with no UI - "-unrestricted" is NEVER passed (N3: the module
// signature check must not be silently skipped).
export const PAWNIO_SETUP_INSTALL_ARGS = ['-install', '-silent'];

/** The download-link degrade text (a failed/declined install's honest note). */
export const PAWNIO_DOWNLOAD_LINK = 'https://pawnio.eu';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested without any native layer)
// ---------------------------------------------------------------------------

/**
 * M4L: the TjMax half of the package temperature - the temperature target
 * register's bits 23:16. Null for a garbage/absent register value.
 * @param {bigint | number | null | undefined} msr1A2
 * @returns {number | null}
 */
export function tjMaxOf(msr1A2) {
  const v = typeof msr1A2 === 'bigint' ? msr1A2 : typeof msr1A2 === 'number' ? BigInt(Math.trunc(msr1A2)) : null;
  if (v === null) return null;
  return Number((v >> 16n) & 0xFFn);
}

/**
 * M4L: the package DTS - MSR_IA32_PACKAGE_THERM_STATUS bits 22:16, VALID
 * ONLY when bit 31 is set (the temperature-reading valid flag). Returns
 * null when the register is absent or the valid bit is clear.
 * @param {bigint | number | null | undefined} msr1B1
 * @returns {number | null}
 */
export function dtsOf(msr1B1) {
  const v = typeof msr1B1 === 'bigint' ? msr1B1 : typeof msr1B1 === 'number' ? BigInt(Math.trunc(msr1B1)) : null;
  if (v === null) return null;
  if ((v & 0x80000000n) === 0n) return null; // bit 31 clear -> reading invalid
  return Number((v & 0x007F0000n) >> 16n);
}

/**
 * M4L: the package temperature = TjMax - DTS (both pieces decoded by the
 * helpers above; a null piece degrades the whole reading to null - never a
 * partial number).
 * @param {bigint | number | null | undefined} msr1A2
 * @param {bigint | number | null | undefined} msr1B1
 * @returns {number | null}
 */
export function packageTempC(msr1A2, msr1B1) {
  const tj = tjMaxOf(msr1A2);
  const dts = dtsOf(msr1B1);
  if (tj === null || dts === null) return null;
  return tj - dts;
}

/**
 * M4L: the RAPL energy units - ESU = MSR_RAPL_POWER_UNIT bits 12:8 (the
 * energy-2^ESU exponent). Null for a garbage register.
 * @param {bigint | number | null | undefined} msr606
 * @returns {number | null}
 */
export function esuOf(msr606) {
  const v = typeof msr606 === 'bigint' ? msr606 : typeof msr606 === 'number' ? BigInt(Math.trunc(msr606)) : null;
  if (v === null) return null;
  return Number((v >> 8n) & 0x1Fn);
}

/**
 * M4L: the 32-bit WRAPPED energy delta - the PKG_ENERGY_STATUS register is
 * a 32-bit counter; the difference is computed modulo 2^32 (a wrap between
 * two samples must not produce a huge negative spike). The LHM precedent
 * uses C#'s unchecked uint subtraction - the JS equivalent:
 * (now - prev) >>> 0.
 * @param {bigint | number} prev
 * @param {bigint | number} now
 * @returns {number} the wrapped delta (0..2^32-1)
 */
export function energyDelta32(prev, now) {
  const a = typeof prev === 'bigint' ? Number(prev & 0xFFFFFFFFn) : Number(prev) >>> 0;
  const b = typeof now === 'bigint' ? Number(now & 0xFFFFFFFFn) : Number(now) >>> 0;
  return (b - a) >>> 0;
}

/**
 * M4L: the RAPL package power - (dE * 2^-ESU) / dt. dt in SECONDS with the
 * >= 10 ms guard (the plan's dt >= 10 ms; a shorter window would amplify
 * counter noise into nonsense). Null when any piece is invalid or the
 * window is too short.
 * @param {number | null} esu
 * @param {number} dE the wrapped 32-bit energy delta
 * @param {number} dtSeconds
 * @returns {number | null}
 */
export function raplPowerW(esu, dE, dtSeconds) {
  if (esu === null || typeof dE !== 'number' || !Number.isFinite(dE) || dE <= 0) return null;
  if (typeof dtSeconds !== 'number' || !Number.isFinite(dtSeconds) || dtSeconds < 0.01) return null;
  return (dE / 2 ** esu) / dtSeconds;
}

// ---------------------------------------------------------------------------
// The native layer (injectable for tests - the igcl-deps pattern)
// ---------------------------------------------------------------------------

/**
 * Bind the kernel32 functions the reader needs. `libDep` may be a loaded
 * koffi library (product path) or a FAKE object with func() (tests - the
 * fake-handle layer). Never throws: a bind failure makes the reader report
 * null reads honestly.
 * @param {object} libDep
 * @param {object} koffiMod
 * @returns {object}
 */
export function bindKernel32(libDep, koffiMod = koffi) {
  let lib;
  try {
    lib = libDep ?? koffiMod.load('kernel32.dll');
  } catch {
    lib = null; // the honest degrade: every bound call reports unavailable
  }
  const out = { unavailable: [] };
  const bind = (name, ret, params) => {
    try {
      if (!lib) throw new Error('kernel32 load failed');
      out[name] = lib.func(name, ret, params);
    } catch {
      out.unavailable.push(name);
    }
  };
  // void* return: koffi wraps the HANDLE as a pointer object; INVALID_HANDLE
  // (-1) is detected via koffi.address() (numeric - never dereferenced).
  bind('CreateFileW', 'void*', ['str16', 'uint32', 'uint32', 'void*', 'uint32', 'uint32', 'void*']);
  bind('DeviceIoControl', 'int', ['void*', 'uint32', 'void*', 'uint32', 'void*', 'uint32', 'uint32*', 'void*']);
  bind('CloseHandle', 'int', ['void*']);
  bind('GetLastError', 'uint32', []);
  return out;
}

/**
 * Resolve the bundled setup exe path. Packaged: the asar-unpacked copy
 * (spawning a file inside the asar is impossible - the same reason koffi
 * and igcl2023 are unpacked). Dev tree: the source path.
 * @returns {string}
 */
export function bundledSetupPath() {
  const devPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'backend', 'PawnIO_setup.exe');
  const unpacked = process.resourcesPath
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'main', 'backend', 'PawnIO_setup.exe')
    : null;
  if (unpacked && fs.existsSync(unpacked)) return unpacked;
  return devPath;
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

/**
 * M4L: the PawnIO MSR reader. Lazily opens the device + loads the module ONCE
 * per session (at the first successful read attempt); every read returns
 * null on any error. The install-state check: when the device is ABSENT the
 * bundled official setup runs silently once (-install -silent); a
 * failed/declined install degrades honestly (null reads + the pawnio.eu
 * download link in `status()`).
 * @param {{
 *   lib?: object,            // injectable kernel32 (the igcl-deps pattern)
 *   koffiMod?: object,       // injectable koffi module
 *   modulePath?: string,     // the IntelMSR.bin path (default: the vendored copy)
 *   setupPath?: string,      // the PawnIO_setup.exe path (default: bundledSetupPath())
 *   execFile?: Function,     // injectable (install-state check)
 *   now?: () => number,      // injectable clock (RAPL window; default Date.now)
 *   installAttempts?: number // test hook: how often the setup may run (default 1)
 * }} [deps]
 */
export function createMsrReader(deps = {}) {
  const koffiMod = deps.koffiMod ?? koffi;
  const lib = bindKernel32(deps.lib, koffiMod);
  const modulePath = deps.modulePath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'backend', 'IntelMSR.bin');
  const setupPath = deps.setupPath ?? bundledSetupPath();
  const exec = deps.execFile ?? execFile;
  const nowFn = deps.now ?? (() => performance.now()); // monotonic (review nit 2: Date.now is a wall clock)
  const installAttempts = deps.installAttempts ?? 1;

  let handle = null; // the koffi pointer (or null while closed)
  let ready = false;
  let attempted = false; // open+load attempted once per session
  let installsDone = 0;
  let status = 'closed';
  let closed = false;
  // RAPL window state (per session).
  let prevEnergy = null;
  let prevEnergyTime = null;

  const lastErrorText = () => {
    try { return lib.GetLastError(); } catch { return 0; }
  };

  const errName = (code) => {
    const names = {
      2: 'ERROR_FILE_NOT_FOUND', 3: 'ERROR_PATH_NOT_FOUND', 5: 'ERROR_ACCESS_DENIED',
      6: 'ERROR_INVALID_HANDLE', 87: 'ERROR_INVALID_PARAMETER', 50: 'ERROR_NOT_SUPPORTED',
      577: 'ERROR_INVALID_IMAGE_HASH', 1920: 'ERROR_CANNOT_LOAD_THE_DRIVER',
      127: 'ERROR_PROC_NOT_FOUND', 740: 'ERROR_ELEVATION_REQUIRED',
    };
    return names[code] ?? `ERROR_${code}`;
  };

  const invalidHandle = (ptr) => {
    if (ptr === null) return true;
    // The fake test layer returns plain numbers (a numeric handle);
    // koffi wraps the real HANDLE as a pointer object (INVALID_HANDLE = -1
    // via koffi.address() - numeric, never dereferenced).
    if (typeof ptr === 'number') return ptr <= 0;
    try {
      const addr = koffiMod.address(ptr);
      return addr === 0xFFFFFFFFFFFFFFFFn || addr === -1n;
    } catch {
      return true; // an undecodable pointer is not a usable handle
    }
  };

  /**
   * Open the device + load the module - ONCE per session. Returns true when
   * ready (subsequent calls are no-ops either way). Never throws.
   * @returns {Promise<boolean>}
   */
  const ensureReady = async () => {
    if (ready) return true;
    if (attempted) return false;
    attempted = true;
    try {
      if (lib.unavailable.includes('CreateFileW') || lib.unavailable.includes('DeviceIoControl')) {
        status = 'bind-failed';
        return false;
      }
      // The install-state check: open WITHOUT the install first (the common
      // path - PawnIO is installed by its own setup; the app never creates
      // services). ERROR_FILE_NOT_FOUND / ERROR_PATH_NOT_FOUND = the device
      // is absent -> run the bundled official setup silently once.
      handle = lib.CreateFileW(PAWNIO_DEVICE_PATH, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, null, OPEN_EXISTING, 0, null);
      if (invalidHandle(handle)) {
        const le = lastErrorText();
        const absent = le === 2 || le === 3;
        if (absent && installsDone < installAttempts) {
          installsDone += 1;
          try {
            await exec(setupPath, PAWNIO_SETUP_INSTALL_ARGS, { windowsHide: true, timeout: 120000 });
            // re-open after the (possibly successful) silent install
            handle = lib.CreateFileW(PAWNIO_DEVICE_PATH, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, null, OPEN_EXISTING, 0, null);
          } catch {
            status = 'install-failed';
            handle = null;
          }
        }
        if (invalidHandle(handle)) {
          // A refused/declined install or an absent device: the honest
          // degrade - null reads + the download link.
          status = le === 5 ? 'access-denied' : (installsDone > 0 ? 'install-failed' : 'device-absent');
          handle = null;
          return false;
        }
      }
      // Load the module bytes ONCE (the asar byte-read on the packaged app).
      const blob = fs.readFileSync(modulePath);
      let written = koffiMod.alloc('uint32', 1);
      const ok = lib.DeviceIoControl(handle, IOCTL_LOAD_BINARY, blob, blob.length, null, 0, written, null);
      if (!ok) {
        status = 'load-refused';
        try { lib.CloseHandle(handle); } catch { /* best effort */ }
        handle = null;
        return false;
      }
      ready = true;
      status = 'ready';
      return true;
    } catch {
      // Any failure (module unreadable, bind broken, koffi error) degrades
      // honestly - the AV-quarantine shape included.
      try { if (handle && !invalidHandle(handle)) lib.CloseHandle(handle); } catch { /* best effort */ }
      handle = null;
      status = 'error';
      return false;
    }
  };

  /**
   * Execute a module function with the given 64-bit inputs; returns the
   * ULONG64 output array or null on any error.
   * @param {string} name
   * @param {Array<bigint>} input
   * @param {number} outLen number of ULONG64 output slots
   * @returns {Array<bigint> | null}
   */
  const execute = (name, input, outLen) => {
    if (!ready || handle === null) return null;
    try {
      const nameBuf = Buffer.alloc(FN_NAME_LENGTH, 0);
      nameBuf.write(name, 'ascii');
      const inBuf = Buffer.alloc(FN_NAME_LENGTH + input.length * 8);
      nameBuf.copy(inBuf, 0);
      input.forEach((v, i) => inBuf.writeBigUInt64LE(typeof v === 'bigint' ? v : BigInt(v), FN_NAME_LENGTH + i * 8));
      const outBuf = Buffer.alloc(outLen * 8);
      const written = koffiMod.alloc('uint32', 1);
      const ok = lib.DeviceIoControl(handle, IOCTL_EXECUTE, inBuf, inBuf.length, outBuf, outBuf.length, written, null);
      if (!ok) return null;
      const count = koffiMod.decode(written, 0, 'uint32') / 8;
      const out = [];
      for (let i = 0; i < count && i < outLen; i++) out.push(outBuf.readBigUInt64LE(i * 8));
      return out;
    } catch {
      return null;
    }
  };

  return {
    /**
     * Read one MSR as a BigInt (out[0] = the 64-bit value). Lazy open+load
     * on the first call; null on any error - the honest degrade.
     * @param {number} index
     * @returns {Promise<bigint | null>}
     */
    async readMsr(index) {
      await ensureReady();
      const out = execute(IOCTL_READ_MSR, [BigInt(index)], 1);
      return out && out.length > 0 ? out[0] : null;
    },

    /**
     * M4L: the CPU package temperature = TjMax - DTS (bit-31 gated). Null on
     * any error (device absent, load refused, AV quarantine, invalid DTS).
     * @returns {Promise<number | null>}
     */
    async packageTempC() {
      const tj = await this.readMsr(MSR_TEMPERATURE_TARGET);
      if (tj === null) return null;
      const dts = await this.readMsr(MSR_PACKAGE_THERM_STATUS);
      if (dts === null) return null;
      return packageTempC(tj, dts);
    },

    /**
     * M4L: the CPU package wattage via RAPL - (dE * 2^-ESU) / dt with the
     * 32-bit wrap and the >= 10 ms window guard. The FIRST sample
     * calibrates (null until the second - the plan's contract). Null on any
     * error.
     * @returns {Promise<number | null>}
     */
    async packagePowerW() {
      const esuMsr = await this.readMsr(MSR_RAPL_POWER_UNIT);
      if (esuMsr === null) return null;
      const esu = esuOf(esuMsr);
      const energy = await this.readMsr(MSR_PKG_ENERGY_STATUS);
      if (energy === null) return null;
      const t = nowFn();
      if (prevEnergy === null || prevEnergyTime === null) {
        prevEnergy = energy;
        prevEnergyTime = t;
        return null; // the first sample calibrates
      }
      const dE = energyDelta32(prevEnergy, energy);
      const dtSeconds = (t - prevEnergyTime) / 1000;
      prevEnergy = energy;
      prevEnergyTime = t;
      return raplPowerW(esu, dE, dtSeconds);
    },

    /**
     * Release the device handle (wired into main.js's before-quit
     * teardown). Idempotent; never throws.
     */
    close() {
      if (closed) return;
      closed = true;
      ready = false;
      if (handle !== null) {
        try { lib.CloseHandle(handle); } catch { /* best effort */ }
        handle = null;
      }
      status = 'closed';
    },

    /**
     * The reader's honest state - 'closed' | 'ready' | 'bind-failed' |
     * 'device-absent' | 'install-failed' | 'access-denied' | 'load-refused'
     * | 'error'. The install-failed/device-absent texts carry the download
     * link (pawnio.eu) for the degrade note.
     * @returns {string}
     */
    status() {
      return status;
    },

    /**
     * The human-readable degrade text (the honest note for the log/report) -
     * includes the pawnio.eu download link on the install/absent states.
     * @returns {string}
     */
    describe() {
      switch (status) {
        case 'ready': return 'PawnIO MSR reader ready';
        case 'closed': return 'PawnIO MSR reader closed';
        case 'bind-failed': return `PawnIO: kernel32 binding unavailable (${lib.unavailable.join(',')})`;
        case 'device-absent': return `PawnIO driver not installed - CPU temp/wattage unavailable; download the official setup from ${PAWNIO_DOWNLOAD_LINK}`;
        case 'install-failed': return `PawnIO setup could not be installed - CPU temp/wattage unavailable; download the official setup from ${PAWNIO_DOWNLOAD_LINK}`;
        case 'access-denied': return `PawnIO device access denied (${errName(lastErrorText())}) - CPU temp/wattage unavailable`;
        case 'load-refused': return `PawnIO refused the IntelMSR.bin module load (${errName(lastErrorText())}) - CPU temp/wattage unavailable`;
        default: return `PawnIO error (${status}, ${errName(lastErrorText())}) - CPU temp/wattage unavailable`;
      }
    },
  };
}
