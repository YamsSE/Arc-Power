// Arc Power - M17b chip-name labels (pure, DOM-free; unit-tested in
// test/pure-chip-label.test.ts - the cheap-oracle seam of the milestone).
//
// The overlay chip-name toggle (overlayChipNames) replaces the stock
// 'CPU '/'GPU ' row prefixes with the actual chip model when it is on.
// This module owns the CUT-DOWN rules (user-requested heuristics - the
// M17b plan §2c; the stock-prefix fallback bounds the damage, rule tweaks
// are a one-function change with pins):
//
//   GPU: drop legal/generic tokens (vendor words, '(R)'/'(TM)', the
//   'Graphics' tail), keep the model tokens joined with a single space -
//   'NVIDIA GeForce RTX 4070' -> 'RTX 4070';
//   'Intel(R) Arc(TM) A770 Graphics' -> 'A770';
//   'AMD Radeon RX 590 Graphics' -> 'RX590' (drop AMD/Radeon/Graphics AND
//   merge an RX token with the following all-digit token - the user's
//   exact RX590 rendering).
//
//   CPU: drop vendor/legal/tail tokens (Intel, AMD, Core, (R), (TM), CPU,
//   @, clock tokens like 3.30GHz), split the remaining tokens on
//   non-alphanumerics, join with spaces -
//   'Intel(R) Core(TM) i7-5775C CPU @ 3.30GHz' -> 'i7 5775C'.
//
// Fallback: an empty/unknown name resolves null - the caller keeps the
// stock 'CPU '/'GPU ' prefix (never an invented label).

/** The vendor/legal/generic GPU tokens - dropped, never part of the label.
 *  '(R)' / '(TM)' split into 'R' / 'TM' by the tokenizer. */
const GPU_DROP_TOKENS = new Set(['nvidia', 'geforce', 'intel', 'arc', 'amd', 'radeon', 'graphics', 'r', 'tm']);

/** The vendor/legal/tail CPU tokens - dropped, never part of the label. */
const CPU_DROP_TOKENS = new Set(['intel', 'amd', 'core', 'r', 'tm', 'cpu']);

/** A clock token like '3.30GHz' / '4300MHz' (dropped by the CPU rules). */
const CLOCK_TOKEN_RE = /^\d+(\.\d+)?(ghz|mhz|khz)$/i;

/** Split a raw device name into its alphanumeric tokens. */
function tokensOf(name: string): string[] {
  return name.split(/[^A-Za-z0-9]+/).filter((t) => t.length > 0);
}

/**
 * M17b: the GPU chip-name cut-down. Drops the vendor/legal/generic tokens
 * and joins the surviving model tokens with a single space; an RX token
 * directly followed by an all-digit token merges into one ('RX' + '590' ->
 * 'RX590' - the user's exact rendering). Empty/unknown -> null (the caller
 * keeps the stock 'GPU ' prefix).
 * @param name the sysinfo primary video-controller name
 * @returns {string | null}
 */
export function chipLabelGpu(name: unknown): string | null {
  const s = typeof name === 'string' ? name.trim() : '';
  if (s.length === 0) return null;
  const kept: string[] = [];
  const tokens = tokensOf(s);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (GPU_DROP_TOKENS.has(t.toLowerCase())) continue;
    // The RX merge: an 'RX' token + the following all-digit token -> one
    // token ('RX590'), never two ('RX 590').
    if (/^rx$/i.test(t) && i + 1 < tokens.length && /^\d+$/.test(tokens[i + 1])) {
      kept.push(t + tokens[i + 1]);
      i++;
      continue;
    }
    kept.push(t);
  }
  return kept.length === 0 ? null : kept.join(' ');
}

/**
 * M17b: the CPU chip-name cut-down. Drops the vendor/legal/tail tokens
 * (Intel, AMD, Core, (R), (TM), CPU, @, clock tokens like '3.30GHz'),
 * splits the remaining tokens on non-alphanumerics and joins them with
 * spaces ('i7-5775C' -> 'i7 5775C'). Empty/unknown -> null (the caller
 * keeps the stock 'CPU ' prefix).
 * @param name the sysinfo CPU name
 * @returns {string | null}
 */
export function chipLabelCpu(name: unknown): string | null {
  const s = typeof name === 'string' ? name.trim() : '';
  if (s.length === 0) return null;
  // The clock token is dropped BEFORE the tokenizer split - '3.30GHz'
  // would otherwise leak three tokens ('3', '30', 'GHz') into the label.
  const withoutClocks = s.split(/\s+/).filter((t) => !CLOCK_TOKEN_RE.test(t)).join(' ');
  const kept: string[] = [];
  for (const t of tokensOf(withoutClocks)) {
    const lower = t.toLowerCase();
    if (CPU_DROP_TOKENS.has(lower)) continue;
    kept.push(t);
  }
  return kept.length === 0 ? null : kept.join(' ');
}
