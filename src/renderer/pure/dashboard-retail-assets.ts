export interface DashboardRetailAssetInput {
  name: unknown;
  gpuVendor?: unknown;
  integrated?: unknown;
  mobile?: unknown;
  aibVendor?: unknown;
  aibVendorId?: unknown;
  aibModel?: unknown;
}

const ASSET_ROOT = '../assets/dashboard/gpu/';

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function numberOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value.trim())) return Number.parseInt(value.trim(), 16);
  return null;
}

function hasModel(model: string, value: string): boolean {
  return new RegExp(`\\b${model}\\b`).test(value);
}

function nvidiaAsset(model: string): string | null {
  const tiers: Array<[string, string]> = [
    ['2080', '2070'],
    ['3080', '3070'],
    ['4080', '4070'],
    ['5080', '5070'],
  ];
  for (const [high, mid] of tiers) {
    if (hasModel(high, model) && new RegExp(`\\brtx\\s+${high}\\b`).test(model)) {
      return `${ASSET_ROOT}nvidia-rtx-${high}-reference.png`;
    }
    if (hasModel(mid, model) && new RegExp(`\\brtx\\s+${mid}\\b`).test(model)) {
      return `${ASSET_ROOT}nvidia-rtx-${mid}-reference.png`;
    }
  }
  return null;
}

function isIntelIntegratedModel(model: string): boolean {
  return /\bigpu\b|\b(?:uhd|iris)\b|\bintegrated\b|\bintel graphics\b|\barc(?:\s*\([^)]*\))?\s+graphics\b|\barc\s+b370\b/.test(model);
}

/** Pure dashboard-only retail portrait selection. It has no Apply or device-routing side effects. */
export function dashboardRetailAssetPath(input: DashboardRetailAssetInput): string | null {
  const model = textOf(input.name);
  const normalizedModel = model.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const gpuVendor = textOf(input.gpuVendor);
  const aibVendor = textOf(input.aibVendor);
  const aibVendorId = numberOf(input.aibVendorId);
  const isAmd = gpuVendor === 'amd' || gpuVendor === 'ati' || model.includes('amd') || model.includes('radeon');
  const isIntel = gpuVendor === 'intel' || model.includes('intel') || model.includes('arc');
  const isNvidia = gpuVendor === 'nvidia' || model.includes('nvidia') || model.includes('rtx') || model.includes('gtx');

  if (isAmd && input.mobile === true) return `${ASSET_ROOT}amd-radeon-mobile-module.png`;
  if (isAmd && input.integrated === true) return `${ASSET_ROOT}amd-radeon-igpu-chip.png`;

  if (isIntel) {
    // Check the integrated flag before the broad Arc-family fallback. Intel
    // iGPU names can contain "Arc", but they must use the chip portrait.
    if (input.integrated === true || isIntelIntegratedModel(normalizedModel)) {
      return `${ASSET_ROOT}intel-igpu-chip.png`;
    }
    if (/\barc\s+pro\b|\bpro\s+arc\b/.test(normalizedModel)) return `${ASSET_ROOT}intel-arc-pro-reference.png`;
    if (hasModel('a310', model) || hasModel('a380', model)) return `${ASSET_ROOT}intel-arc-a310-a380-reference.png`;
    if (hasModel('a750', model)) return `${ASSET_ROOT}intel-arc-a750.png`;
    if (hasModel('a770', model)) return `${ASSET_ROOT}intel-arc-a770.png`;
    if (hasModel('b570', model)) {
      if (aibVendor === 'acer') return `${ASSET_ROOT}intel-arc-b570-acer.png`;
      if (aibVendor === 'asrock') return `${ASSET_ROOT}intel-arc-b570-asrock.png`;
      if (aibVendor === 'sparkle' || aibVendorId === 0x172f) return `${ASSET_ROOT}intel-arc-b570-sparkle.png`;
      // Do not invent a partner-board portrait when the subsystem vendor is
      // unknown. The existing SVG fallback is intentionally more honest than
      // presenting an unverified reference design as the detected hardware.
      return null;
    }
    if (hasModel('b580', model)) return `${ASSET_ROOT}intel-arc-b580.png`;
    if (/\barc\b/.test(model)) return `${ASSET_ROOT}intel-arc-a770.png`;
  }

  if (isNvidia) {
    const tierAsset = nvidiaAsset(model);
    if (tierAsset) return tierAsset;
    if (/\brtx\b/.test(model)) return `${ASSET_ROOT}nvidia-rtx-reference.png`;
    if (/\bgtx\b/.test(model)) return `${ASSET_ROOT}nvidia-gtx-reference.png`;
  }

  if (/\bvega\b/.test(model)) return `${ASSET_ROOT}amd-radeon-vega-reference.png`;
  if (/\brx\s*?(?:7|9)\d{3}\b/.test(model)) return `${ASSET_ROOT}amd-radeon-rx-7000-9000-reference.png`;
  if (/\brx\s*?[56]\d{3}\b/.test(model)) return `${ASSET_ROOT}amd-radeon-rx-5000-6000-reference.png`;
  if (/\brx\s*?[45]\d{2}\b/.test(model)) return `${ASSET_ROOT}amd-radeon-rx-480-580-reference.png`;
  if (/\br9\s*[23]\d{2}\b/.test(model)) return `${ASSET_ROOT}amd-radeon-r9-200-300-reference.png`;
  return null;
}
