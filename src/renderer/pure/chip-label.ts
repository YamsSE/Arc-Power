// Arc Power - M17b/M17c/M17d chip-name labels (pure, DOM-free; unit-tested
// in test/pure-chip-label.test.ts - the cheap-oracle seam of the milestone).
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
//   M17c: the Ryzen collapse runs FIRST - 'AMD Ryzen 5 3600' -> 'R5 3600'
//   (Ryzen 3/5/7/9 + the model token collapse to R<N>); Threadripper /
//   Athlon / non-Ryzen AMD names fall through unchanged.
//   M17d (the user's exact shapes): the family passes run BEFORE the
//   general cut-down:
//     - Threadripper -> 'TR' ('AMD Ryzen Threadripper 1920X' -> 'TR 1920X'
//       - the Ryzen word + the Threadripper token collapse to TR; the M17c
//       "Threadripper stays unchanged" pin FLIPS);
//     - Xeon: keep 'Xeon', drop the E5-series token ONLY in the exact
//       E5-<model> shape ('Intel(R) Xeon(R) CPU E5-1860V2 @ 3.40GHz' ->
//       'Xeon 1860V2'); the counter-example stays ('Intel(R) Xeon(R) CPU
//       E3-1230 v3' -> 'Xeon E3 1230 v3' - the E-drop fires only in the
//       exact E5-<model>-token shape);
//   and the TAIL drop runs AFTER the general cut-down - the CORE-COUNT /
//   'processor' tail tokens ({eight, quad, dual, six, twelve, core,
//   processor} - the 'Eight-Core'/'Quad Core' shapes tokenize to two
//   tokens) drop from the END only: 'AMD FX(tm)-8350 Eight-Core Processor'
//   -> 'FX 8350' and 'AMD Athlon(tm) 860K Quad Core' -> 'Athlon 860K'.
//   TAIL-ONLY is PINNED: a mid-name token is never dropped by the tail
//   rule (a name whose middle carries 'Core' keeps it).
//
// Fallback: an empty/unknown name resolves null - the caller keeps the
// stock 'CPU '/'GPU ' prefix (never an invented label).

/** The vendor/legal/generic GPU tokens - dropped, never part of the label.
 *  '(R)' / '(TM)' split into 'R' / 'TM' by the tokenizer. */
const GPU_DROP_TOKENS = new Set(['nvidia', 'geforce', 'intel', 'arc', 'amd', 'radeon', 'graphics', 'r', 'tm']);

/** The vendor/legal/tail CPU tokens - dropped, never part of the label.
 *  ('core' stays GLOBALLY dropped here - the M17b Intel pins
 *  'Intel(R) Core(TM) i7-5775C' -> 'i7 5775C' depend on it; the M17d TAIL
 *  drop below is a separate, end-only rule.) */
const CPU_DROP_TOKENS = new Set(['intel', 'amd', 'core', 'r', 'tm', 'cpu']);

/** M17d: the CORE-COUNT / 'processor' TAIL tokens - dropped from the END of
 *  the label only (a mid-name token is never dropped by this rule). The
 *  'Eight-Core' / 'Quad Core' shapes tokenize to two tokens - the set holds
 *  the single-token halves. */
const CPU_TAIL_DROP_TOKENS = new Set(['eight', 'quad', 'dual', 'six', 'twelve', 'core', 'processor']);

/** A clock token like '3.30GHz' / '4300MHz' (dropped by the CPU rules). */
const CLOCK_TOKEN_RE = /^\d+(\.\d+)?(ghz|mhz|khz)$/i;

/** Split a raw device name into its alphanumeric tokens. */
function tokensOf(name: string): string[] {
  return name.split(/[^A-Za-z0-9]+/).filter((t) => t.length > 0);
}

/** M17d: the TAIL drop - remove the trailing CPU_TAIL_DROP_TOKENS from the
 *  end of the kept-token list (TAIL-ONLY: the drop stops at the first
 *  non-tail token, so a mid-name token is never touched). Mutates the
 *  passed array. */
function dropCpuTailTokens(kept: string[]): void {
  while (kept.length > 0 && CPU_TAIL_DROP_TOKENS.has(kept[kept.length - 1].toLowerCase())) {
    kept.pop();
  }
}

/**
 * M17d: the Threadripper collapse - 'AMD Ryzen Threadripper 1920X' ->
 * 'TR 1920X'. The Ryzen word + the Threadripper token collapse to 'TR'
 * (the user's exact shape - the M17c "Threadripper stays unchanged" pin
 * FLIPS); the model = the remaining tokens after 'Threadripper' (joined
 * with a single space, input casing kept). Only the exact
 * /Ryzen\s+Threadripper/i shape matches - a bare 'Threadripper' name or
 * a non-Ryzen Threadripper never collapses. Empty -> null.
 * @param {unknown} name the raw CPU name
 * @returns {string | null}
 */
export function chipLabelThreadripper(name: unknown): string | null {
  const s = typeof name === 'string' ? name.trim() : '';
  if (s.length === 0) return null;
  const m = s.match(/\bRyzen\s+Threadripper\b/i);
  if (!m) return null;
  const after = s.slice(m.index! + m[0].length).trim();
  const model = after.split(/[^A-Za-z0-9]+/).filter((t) => t.length > 0).join(' ');
  return model.length > 0 ? `TR ${model}` : 'TR';
}

/**
 * M17d: the Xeon E5-series drop - 'Intel(R) Xeon(R) CPU E5-1860V2 @
 * 3.40GHz' -> 'Xeon 1860V2'. The E5-<model> token drops ONLY in the exact
 * E5-<model> shape (the hyphenated token whose tag is 'E5'): the name is
 * rewritten with the E5 tag removed (the model token survives) and the
 * general cut-down runs on it. The counter-example stays untouched:
 * 'Intel(R) Xeon(R) CPU E3-1230 v3' has no E5 token - 'Xeon E3 1230 v3'
 * survives (round-1 N7). Non-Xeon names -> null (never rewritten).
 * @param {unknown} name the raw CPU name
 * @returns {string | null} the REWRITTEN name (the general cut-down still
 *   runs on it) or null when the E5 shape is not present
 */
export function chipLabelXeonE5(name: unknown): string | null {
  const s = typeof name === 'string' ? name.trim() : '';
  if (s.length === 0) return null;
  if (!/\bXeon\b/i.test(s)) return null;
  const m = s.match(/\bE5-([A-Za-z0-9]+)\b/i);
  if (!m) return null;
  return s.replace(/\bE5-[A-Za-z0-9]+\b/i, m[1]);
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
 * M17c: the Ryzen collapse - 'AMD Ryzen 5 3600' -> 'R5 3600'. A Ryzen name
 * (case-insensitive) whose tier token is one of 3/5/7/9 collapses to
 * 'R<tier> <model>' (the model = the token after the tier - '5800X3D',
 * '7950X', ...). The tier must be a REAL Ryzen tier digit - 'AMD Ryzen
 * Threadripper 3990X' (the next token is not a tier) stays unchanged (the
 * M17d TR pass handles Threadripper), and Athlon/other AMD parts never
 * match (no 'Ryzen' token). The model token keeps the INPUT casing (like
 * the general cut-down). Empty -> null.
 * @param {unknown} name the raw CPU name
 * @returns {string | null}
 */
export function chipLabelRyzen(name: unknown): string | null {
  const s = typeof name === 'string' ? name.trim() : '';
  if (s.length === 0) return null;
  const m = s.match(/\bRyzen\s+([3579])\s+(\S+)/i);
  if (!m) return null;
  return `R${m[1]} ${m[2]}`;
}

/**
 * M17b/M17c/M17d: the CPU chip-name cut-down. The family passes run FIRST
 * (Ryzen collapse, then the M17d Threadripper + Xeon-E5 passes), then the
 * vendor/legal/tail tokens drop (Intel, AMD, Core, (R), (TM), CPU, @,
 * clock tokens like '3.30GHz'), the remaining tokens split on
 * non-alphanumerics and join with spaces ('i7-5775C' -> 'i7 5775C'), and
 * finally the M17d TAIL drop removes the trailing core-count/'processor'
 * tokens. Empty/unknown -> null (the caller keeps the stock 'CPU ' prefix).
 * @param name the sysinfo CPU name
 * @returns {string | null}
 */
export function chipLabelCpu(name: unknown): string | null {
  const s = typeof name === 'string' ? name.trim() : '';
  if (s.length === 0) return null;
  // M17c: the Ryzen collapse ('AMD Ryzen 5 3600' -> 'R5 3600').
  const ryzen = chipLabelRyzen(s);
  if (ryzen !== null) return ryzen;
  // M17d: the Threadripper collapse ('AMD Ryzen Threadripper 1920X' ->
  // 'TR 1920X' - runs after the tier collapse: 'Threadripper' is not a
  // tier digit, so the tier collapse never claims it).
  const tr = chipLabelThreadripper(s);
  if (tr !== null) return tr;
  // M17d: the Xeon E5-series drop ('Intel(R) Xeon(R) CPU E5-1860V2 @
  // 3.40GHz' -> 'Xeon 1860V2' - the E5-<model> token only; the E3 shape
  // stays untouched).
  const xeon = chipLabelXeonE5(s);
  const cut = xeon ?? s;
  // The clock token is dropped BEFORE the tokenizer split - '3.30GHz'
  // would otherwise leak three tokens ('3', '30', 'GHz') into the label.
  const withoutClocks = cut.split(/\s+/).filter((t) => !CLOCK_TOKEN_RE.test(t)).join(' ');
  const kept: string[] = [];
  for (const t of tokensOf(withoutClocks)) {
    const lower = t.toLowerCase();
    if (CPU_DROP_TOKENS.has(lower)) continue;
    kept.push(t);
  }
  // M17d: the TAIL drop - the core-count/'processor' tail tokens come off
  // the END only ('AMD FX(tm)-8350 Eight-Core Processor' -> 'FX 8350').
  dropCpuTailTokens(kept);
  return kept.length === 0 ? null : kept.join(' ');
}
