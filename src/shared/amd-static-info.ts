// Model specifications published by AMD. This narrow, exact-name mapping is
// shared by the main IPC path and dashboard inventory cards.
// Sources: AMD Radeon RX 9000 product specifications and partner data:
// https://www.amd.com/en/products/graphics/desktops/radeon/9000-series/amd-radeon-rx-9070xt.html
// https://www.amd.com/en/partner/browse-by-product/radeon-resources.html
const AMD_COMPUTE_UNITS = Object.freeze([
  { pattern: /^(?:amd\s+)?radeon(?:\s*\(tm\))?\s+rx\s+9070\s+xt(?:\s+16\s*gb)?$/i, units: 64 },
  { pattern: /^(?:amd\s+)?radeon(?:\s*\(tm\))?\s+rx\s+9070\s+gre(?:\s+12\s*gb)?$/i, units: 48 },
  { pattern: /^(?:amd\s+)?radeon(?:\s*\(tm\))?\s+rx\s+9070(?:\s+16\s*gb)?$/i, units: 56 },
  { pattern: /^(?:amd\s+)?radeon(?:\s*\(tm\))?\s+rx\s+9060\s+xt(?:\s+\d+\s*gb)?$/i, units: 32 },
  { pattern: /^(?:amd\s+)?radeon(?:\s*\(tm\))?\s+rx\s+9060(?:\s+8\s*gb)?$/i, units: 28 },
  { pattern: /^(?:amd\s+)?radeon(?:\s*\(tm\))?\s+rx\s+9050(?:\s+\(4\s*gb\))?$/i, units: 16 },
]);

/** Return the published AMD Compute Unit count for a recognized model name. */
export function amdComputeUnitsOf(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const model = value.trim().replace(/\s+/g, ' ');
  if (!model) return null;
  return AMD_COMPUTE_UNITS.find(({ pattern }) => pattern.test(model))?.units ?? null;
}
