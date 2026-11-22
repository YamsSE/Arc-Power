/**
 * Normalized GPU caption for the Dashboard "Live Monitoring" card.
 *
 * The raw Windows/IGCL device name is decorative and redundant
 * (`Intel(R) Arc(TM) B580 Graphics 12GB GDDR6`), and the memory type is not
 * part of the model. This module produces the short label the dashboard shows
 * under/above the retail artwork (`Intel Arc B580 12GB`) and falls back to the
 * cleaned raw name whenever it cannot normalize confidently - never to a
 * half-parsed or empty string.
 *
 * Pure: no DOM, no app state, no side effects.
 */

export interface GpuDisplayNameInput {
  /** Raw device name as reported by IGCL/Windows. */
  name?: unknown;
  /** Backend vendor tag (`intel` / `nvidia` / `amd` / `ati`) when known. */
  vendor?: unknown;
  /**
   * Discrete VRAM in GB (the device's memory size, not its memory type).
   * Unknown, zero or non-finite means "omit the size".
   */
  vramGb?: unknown;
}

type GpuVendor = 'intel' | 'nvidia' | 'amd';

/** `(R)`, `(TM)`, `(C)`, and the bare symbols. */
const DECORATION = /\s*(?:\((?:r|tm|c)\)|®|™)\s*/gi;

/** Memory-size / memory-type / boilerplate words that may trail a model name. */
const MODEL_TAIL = /\s+(\d{1,3}\s?GB|GDDR\d*[XW]?|HBM\d*[Ee]?|LPDDR\d*X?|DDR\d|Graphics|Series)$/i;

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Collapse whitespace and drop vendor decorations. */
function cleanName(value: unknown): string {
  return stringOf(value).replace(DECORATION, ' ').replace(/\s+/g, ' ').trim();
}

function sizeOf(value: unknown): number | null {
  const parsed = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())
    ? Number(value.trim())
    : typeof value === 'number'
      ? value
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const rounded = Math.round(parsed);
  return rounded > 0 ? rounded : null;
}

/**
 * Strip trailing `Graphics`/`Series`, the memory type and the name-carried
 * size. The name-carried size is retained as a fallback so a device that
 * reports no VRAM still shows the size printed in its own name.
 */
function peelModelTail(value: string): { model: string; nameSizeGb: number | null } {
  let model = value;
  let nameSizeGb: number | null = null;
  for (let guard = 0; guard < 8; guard += 1) {
    const match = model.match(MODEL_TAIL);
    if (!match) break;
    if (/^\d{1,3}\s?GB$/i.test(match[1])) {
      const size = sizeOf(match[1].replace(/\s?GB$/i, ''));
      if (size !== null) nameSizeGb = size;
    }
    model = model.slice(0, match.index).trim();
  }
  return { model, nameSizeGb };
}

function vendorOf(input: GpuDisplayNameInput, cleaned: string): GpuVendor | null {
  const declared = stringOf(input.vendor).trim().toLowerCase();
  if (declared === 'intel') return 'intel';
  if (declared === 'nvidia') return 'nvidia';
  if (declared === 'amd' || declared === 'ati') return 'amd';
  if (/\bnvidia\b|\bgeforce\b|\brtx\b|\bgtx\b/i.test(cleaned)) return 'nvidia';
  if (/\bamd\b|\bradeon\b|\bati\b|\brx\s?\d{3}/i.test(cleaned)) return 'amd';
  if (/\bintel\b|\barc\b/i.test(cleaned)) return 'intel';
  return null;
}

/** Intel: `Intel(R) Arc(TM) B580 Graphics` -> `Intel Arc B580`. */
function intelModel(model: string): string | null {
  if (!/\barc\b/i.test(model)) return null;
  const sku = model
    .replace(/^intel\s*/i, '')
    .replace(/^arc\s*/i, '')
    .trim();
  // A real Arc SKU (B580, A770, B370, Pro B50, 140V). A bare "Graphics" name
  // means an iGPU with no model, so the cleaned raw name is more honest.
  if (!/^(?:pro\s+)?[ab]?\d{2,4}[a-z]*$/i.test(sku)) return null;
  return `Intel Arc ${sku}`;
}

/** NVIDIA: `NVIDIA GeForce RTX 2080 Ti` -> `Nvidia RTX 2080TI`. */
function nvidiaModel(model: string): string | null {
  const rest = model
    .replace(/^nvidia\s*/i, '')
    .replace(/^geforce\s*/i, '')
    .trim();
  if (!/^(?:rtx|gtx)\s+[a-z]?\d{3,4}(?:\s+(?:ti|super))*$/i.test(rest)) return null;
  return `Nvidia ${rest
    .replace(/\b(rtx|gtx)\b/gi, (token) => token.toUpperCase())
    .replace(/\b(\d{3,4})\s*ti\b/gi, (_match, digits: string) => `${digits}TI`)}`;
}

/** AMD: `AMD Radeon RX 580 Series` -> `AMD RX 580`. */
function amdModel(model: string): string | null {
  const rest = model
    .replace(/^amd\s*/i, '')
    .replace(/^radeon\s*/i, '')
    .trim();
  const match = rest.match(/^rx\s?(\d{3,4}(?:\s+(?:xt|xtx|m))?)$/i);
  if (!match) return null;
  return `AMD RX ${match[1].toUpperCase()}`;
}

/**
 * Normalized GPU label for the Dashboard visual column.
 *
 * `Intel(R) Arc(TM) B580 Graphics 12GB GDDR6` + 12 -> `Intel Arc B580 12GB`.
 * Unrecognized names return the cleaned raw name and never a size, so the
 * caption cannot claim a capacity the device did not report.
 */
export function gpuDisplayName(input: GpuDisplayNameInput): string {
  const cleaned = cleanName(input.name);
  if (!cleaned) return 'GPU';
  const { model: peeled, nameSizeGb } = peelModelTail(cleaned);
  const vendor = vendorOf(input, cleaned);
  const normalized = vendor === 'intel'
    ? intelModel(peeled)
    : vendor === 'nvidia'
      ? nvidiaModel(peeled)
      : vendor === 'amd'
        ? amdModel(peeled)
        : null;
  if (!normalized) return cleaned;
  const size = sizeOf(input.vramGb) ?? nameSizeGb;
  return size === null ? normalized : `${normalized} ${size}GB`;
}
