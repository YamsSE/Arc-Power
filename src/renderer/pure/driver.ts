// Arc Power — driver display helpers (pure, DOM-free).
//
// DeviceInfo.driverVersion from IGCL is a hex uint64 whose four 16-bit
// words are the dotted version parts, MSB first: 0x002000000065229d ->
// major 0x0020 = 32, minor 0x0000 = 0, subminor 0x0065 = 101, build
// 0x229d = 8861 -> "32.0.101.8861". The date comes from the Windows
// display-driver registry `DriverDate` value ("7-5-2026") via the
// driver-info IPC channel; this module formats it en-US ("Jul 05, 2026").

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const XE_CORES_PER_SUBSLICE = 16;
export const SHADER_UNITS_PER_EU = 8;

/**
 * Decode the IGCL uint64 driver version into dotted form. Non-hex strings
 * (already-dotted versions, degraded reports) pass through verbatim; null/
 * empty input returns null (the caller hides the line).
 */
export function decodeDriverVersion(hex: string | null | undefined): string | null {
  if (typeof hex !== 'string' || hex.length === 0) return null;
  const trimmed = hex.trim();
  if (trimmed.length === 0) return null;
  const m = trimmed.match(/^0x([0-9a-fA-F]{1,16})$/);
  if (!m) return trimmed;
  const v = BigInt('0x' + m[1]);
  const major = Number((v >> 48n) & 0xffffn);
  const minor = Number((v >> 32n) & 0xffffn);
  const subminor = Number((v >> 16n) & 0xffffn);
  const build = Number(v & 0xffffn);
  return `${major}.${minor}.${subminor}.${build}`;
}

/**
 * Format a Windows display-driver DriverDate ("M-d-yyyy", e.g. "7-5-2026")
 * as "Jul 05, 2026" (en-US month name, zero-padded day). Unparseable input
 * returns null (the caller shows the version without a date).
 */
export function formatDriverDate(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${MONTHS[month - 1]} ${String(day).padStart(2, '0')}, ${year}`;
}

/**
 * Shader units for a GPU with `numXeCores` Xe cores: 16 EUs per Xe core,
 * 8 shader lanes per EU (A770: 32 * 16 * 8 = 4096).
 */
export function shaderUnits(numXeCores: number): number {
  return numXeCores * XE_CORES_PER_SUBSLICE * SHADER_UNITS_PER_EU;
}
