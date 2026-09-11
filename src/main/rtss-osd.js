// Arc Power telemetry OSD publisher for RivaTuner Statistics Server.
//
// RTSS owns the normal telemetry surface. Arc Power publishes native RTSS
// hypertext and, when supported by the installed RTSS version, an embedded
// frametime graph through RTSSSharedMemoryV2. The Advanced Overlay remains a
// separate Electron surface and is intentionally not routed through here.

import koffi from 'koffi';

export const RTSS_OSD_MAPPING_NAME = 'RTSSSharedMemoryV2';
export const RTSS_FILE_MAP_ALL_ACCESS = 0xF001F;
export const RTSS_OSD_SIGNATURE = 0x52545353;
export const RTSS_OSD_MIN_VERSION = 0x00020000;
export const RTSS_OSD_FORMAT_VERSION = 0x0002000B;
export const RTSS_OSD_EXT_VERSION = 0x00020007;
export const RTSS_OSD_BUFFER_VERSION = 0x0002000C;
export const RTSS_OSD_BUSY_VERSION = 0x0002000E;
export const RTSS_OSD_EX2_VERSION = 0x00020014;
export const RTSS_OSD_UPDATED = 1;
export const RTSS_OSD_OWNER = 'ArcPower';
export const RTSS_OSD_HEADER = Object.freeze({
  signature: 0,
  version: 4,
  appEntrySize: 8,
  appArrOffset: 12,
  appArrSize: 16,
  osdEntrySize: 20,
  osdArrOffset: 24,
  osdArrSize: 28,
  frame: 32,
  busy: 36,
});
export const RTSS_OSD_ENTRY = Object.freeze({ text: 0, owner: 256, ex: 512, buffer: 4608, ex2: 266752 });
export const RTSS_OSD_ENTRY_MIN = 512;
export const RTSS_OSD_EX_SIZE = 4096;
export const RTSS_OSD_BUFFER_SIZE = 262144;
export const RTSS_OSD_EX2_SIZE = 32768;
export const RTSS_OSD_MAX_TEXT = 4095;
export const RTSS_OSD_MAX_MAPPING_BYTES = 64 * 1024 * 1024;

const DEFAULT_STATS = Object.freeze([
  'cpu-util', 'cpu-temp', 'cpu-power',
  'memory-util',
  'gpu-util', 'gpu-temp', 'gpu-power', 'gpu-vram',
  'fps', 'api', 'frametime',
]);

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const rounded = (value, digits = 0) => {
  if (!finite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
const numberText = (value, digits = 0, fallback = '-') => {
  const out = rounded(value, digits);
  return out === null ? fallback : String(out);
};
const has = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);

// RTSS consumes ANSI hypertext. Keep line breaks/tabs, drop all other control
// and non-ASCII characters, and never allow a user-provided value to become a
// format tag. Format tags emitted by this module are added after escaping.
function safeRtssText(value, { lineBreaks = true, backspace = false } = {}) {
  const source = String(value ?? '');
  let out = '';
  for (const char of source) {
    const code = char.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7E) out += char;
    else if (backspace && char === '\b') out += char;
    else if (lineBreaks && (char === '\n' || char === '\r' || char === '\t')) out += char;
  }
  return out;
}

const SHORT_GPU_DROP_TOKENS = new Set([
  'nvidia', 'geforce', 'intel', 'arc', 'amd', 'ati', 'radeon',
  'graphics', 'gpu', 'laptop', 'mobile', 'display', 'adapter', 'controller', 'video',
  'corporation', 'inc', 'r', 'tm',
  'mock', 'fixture', 'fixtures', 'test', 'testing', 'sample',
]);

export function shortGpuLabel(value, fallback = 'GPU') {
  const source = safeRtssText(value, { lineBreaks: false })
    .replace(/\((?:r|tm)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!source) return fallback;
  // Keep generic fallback names intact; dropping the word GPU from "GPU 2"
  // would otherwise leave the misleading model label "2".
  if (/^gpu\s*\d+$/i.test(source)) return fallback;

  // Intel Arc names are commonly decorated with a trailing "Graphics"
  // token. Prefer the stable model token so the same physical adapter is
  // shown as A770/B580 regardless of the vendor string or suffix wording.
  const arcModel = source.match(/\bArc\b[\s\S]*?\b([AB]\d{3,4})\b/i);
  if (arcModel) return arcModel[1].toUpperCase();

  const kept = [];
  const tokens = source.split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (/^\d+(?:gb|gib|mb|mib)$/i.test(token) || /^gddr\d+$/i.test(token)) break;
    if (SHORT_GPU_DROP_TOKENS.has(token.toLowerCase())) continue;
    if (/^rx$/i.test(token) && /^\d+$/.test(tokens[index + 1] ?? '')) {
      kept.push(`RX${tokens[index + 1]}`);
      index += 1;
      continue;
    }
    kept.push(token);
  }
  return kept.length > 0 ? kept.join(' ') : fallback;
}

function canonicalizeRtssApi(value) {
  const api = safeRtssText(value, { lineBreaks: false }).trim();
  if (!api) return '';
  const normalized = api.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const aliases = {
    vulkan: 'VULKAN',
    vk: 'VULKAN',
    opengl: 'OGL',
    ogl: 'OGL',
    dx9: 'DX9',
    directx9: 'DX9',
    dx10: 'DX10',
    d3d10: 'DX10',
    directx10: 'DX10',
    dx11: 'DX11',
    d3d11: 'DX11',
    directx11: 'DX11',
    dx12: 'DX12',
    d3d12: 'DX12',
    directx12: 'DX12',
    dxgi: 'DXGI',
    d3d9: 'DX9',
    other: 'OTHER',
  };
  return aliases[normalized] ?? '';
}

function cleanOwner(value) {
  return safeRtssText(value, { lineBreaks: false }).replace(/\0/g, '');
}

function escapeRtssValue(value) {
  return safeRtssText(value).replaceAll('\\', '\\\\').replaceAll('<', '\\<').replaceAll('>', '\\>');
}

function clamp(value, min, max, fallback) {
  return finite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function statsOf(settings) {
  if (!Array.isArray(settings?.stats)) return new Set(DEFAULT_STATS);
  return new Set(settings.stats.filter((value) => typeof value === 'string'));
}

function statEnabled(stats, id) {
  return stats.has(id);
}

function colorHex(value, fallback = '#ffffff') {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.slice(1).toUpperCase() : fallback.slice(1).toUpperCase();
}

function positionTag(position) {
  switch (position) {
    case 'top-right': return '<P2>';
    case 'bottom-left': return '<P6>';
    case 'bottom-right': return '<P8>';
    case 'top-left':
    default: return '<P0>';
  }
}

function scaleTag(scale, theme = 'arc') {
  // RTSS's hypertext FNT tag is the per-layer size control. The application
  // slider is 0.5..2.0; map it to RTSS's 1..4 Raster3D zoom range. Keeping
  // this in the emitted text makes a live setting change affect the existing
  // RTSS slot immediately instead of merely changing Arc Power state.
  const zoom = Math.round(clamp(scale, 0.5, 2, 1) * 2);
  // Raster3D supports the FNT face/weight/zoom tag. Use a distinct face for
  // the two persisted themes so switching themes remains visible on RTSS,
  // whose native surface cannot consume Arc Power's HTML/CSS theme tokens.
  const face = theme === 'classic' ? 'Tahoma' : 'Consolas';
  const weight = theme === 'classic' ? 700 : 400;
  return `<FNT=${face},8,${weight},${Math.max(1, Math.min(4, zoom))}>`;
}

function valueOrNull(...values) {
  for (const value of values) if (finite(value)) return value;
  return null;
}

function byteSizeToGb(value) {
  return finite(value) && value >= 0 ? `${Math.round(value / 1_000_000_000)} GB` : '-';
}

function ramSizeToGb(value) {
  return finite(value) && value >= 0 ? `${(value / 1_000_000_000).toFixed(1)} GB` : '-';
}

function gpuLike(value) {
  if (!value || typeof value !== 'object') return false;
  return [
    'gpuClockMhz', 'memClockMhz', 'tempC', 'gpuVoltageV', 'fanRpm',
    'utilPct', 'gpuUtilPct', 'powerW', 'gpuMemUsedBytes',
    'utilization', 'temperatureC', 'vramUsedMb',
  ].some((key) => has(value, key));
}

function gpuEntries(telemetry) {
  if (Array.isArray(telemetry?.gpus)) return telemetry.gpus.filter(gpuLike);
  if (gpuLike(telemetry?.gpu)) return [telemetry.gpu];
  return gpuLike(telemetry) ? [telemetry] : [];
}

function normalizeGpu(gpu, index) {
  const aliases = [
    gpu?.deviceKey,
    ...(Array.isArray(gpu?.deviceKeys) ? gpu.deviceKeys : []),
    Number.isInteger(gpu?.deviceId) ? `id:${gpu.deviceId}` : null,
  ].filter((value) => typeof value === 'string' && value.length > 0);
  return {
    key: aliases[0] ?? null,
    aliases,
    name: gpu?.deviceName ?? gpu?.name ?? gpu?.label ?? `GPU ${index + 1}`,
    // IGCL's device-wide activity counter is the closest match to the
    // vendor tools' total GPU-busy reading. The WMI GPUEngine aggregate is
    // the fallback when the native counter is unavailable.
    util: valueOrNull(gpu?.utilPct, gpu?.gpuUtilPct, gpu?.utilization),
    clock: valueOrNull(gpu?.gpuClockMhz),
    memClock: valueOrNull(gpu?.memClockMhz),
    temp: valueOrNull(gpu?.tempC, gpu?.temperatureC),
    vramTemp: valueOrNull(gpu?.vramTempC, gpu?.memTempC),
    voltage: valueOrNull(gpu?.gpuVoltageV),
    power: valueOrNull(gpu?.powerW),
    fan: Array.isArray(gpu?.fanRpm) ? valueOrNull(gpu.fanRpm[0]) : null,
    vram: valueOrNull(
      gpu?.gpuMemUsedBytes,
      gpu?.memoryUsedBytes,
      finite(gpu?.vramUsedMb) ? gpu.vramUsedMb * 1_000_000 : null,
    ),
  };
}

function row(label, fields) {
  return fields.length > 0 ? `${label} ${fields.join(' ')}` : '';
}

function gpuOrdinalOf(gpu, fallbackIndex, deviceOrdinals) {
  if (deviceOrdinals instanceof Map) {
    for (const alias of gpu.aliases) {
      const ordinal = deviceOrdinals.get(alias);
      if (Number.isInteger(ordinal) && ordinal > 0) return ordinal;
    }
  }
  return fallbackIndex + 1;
}

function disambiguateGpuLabel(label, ordinal, seenLabels) {
  const occurrence = seenLabels.get(label) ?? 0;
  seenLabels.set(label, occurrence + 1);
  if (occurrence === 0 || /^GPU\d*$/i.test(label)) return label;
  // Two physical adapters can legitimately share the same model name. Keep
  // the short model label for the display-driving GPU and add a readable
  // suffix to later occurrences so RTSS never makes identical rows look like
  // one lane. The ordinal remains the durable identity used by the VRAM row.
  return `${label} ${occurrence === 1 ? 'Secondary' : ordinal}`;
}

function formatGpuRows(telemetry, settings, stats, deviceOrdinals = null) {
  const selected = Array.isArray(settings?.monitoredDeviceKeys)
    ? settings.monitoredDeviceKeys.filter((value) => typeof value === 'string' && value.length > 0)
    : null;
  const source = gpuEntries(telemetry).map(normalizeGpu);
  const selectedRows = selected && selected.length > 0
    ? source.filter((gpu) => gpu.aliases.some((alias) => selected.includes(alias)))
    : source;
  // Persisted physical identities can outlive a driver replacement or a
  // device re-enumeration. Match IPC's stale-selection behavior and render
  // the currently available adapters instead of silently producing no GPU
  // rows when none of the saved aliases still match.
  const filtered = selected && selected.length > 0 && selectedRows.length > 0
    ? selectedRows
    : source;
  const rows = [];
  const seenLabels = new Map();
  filtered.forEach((gpu, index) => {
    const ordinal = gpuOrdinalOf(gpu, index, deviceOrdinals);
    // The RTSS HUD keeps the existing setting semantics: chip-name mode uses
    // a compact physical model label, while the stock mode keeps GPU1/GPU2
    // ordinals. In neither mode can the full CIM/IGCL adapter name leak out.
    const compactLabel = shortGpuLabel(gpu.name, `GPU${ordinal}`).slice(0, 24);
    const label = settings?.overlayChipNames === true
      ? disambiguateGpuLabel(compactLabel, ordinal, seenLabels).slice(0, 24)
      : `GPU${ordinal}`;
    const gpuFields = [];
    if (statEnabled(stats, 'gpu-util')) gpuFields.push(`${numberText(gpu.util)}%`);
    if (statEnabled(stats, 'gpu-clock')) gpuFields.push(`${numberText(gpu.clock)} MHz`);
    if (statEnabled(stats, 'gpu-voltage')) gpuFields.push(`${numberText(gpu.voltage, 3)} V`);
    if (statEnabled(stats, 'gpu-temp')) gpuFields.push(`${numberText(gpu.temp)}°C`);
    if (statEnabled(stats, 'gpu-power')) gpuFields.push(`${numberText(gpu.power, 1)} W`);
    if (statEnabled(stats, 'gpu-fan')) gpuFields.push(`${numberText(gpu.fan)} RPM`);
    const gpuRow = row(label, gpuFields);
    if (gpuRow) rows.push(gpuRow);

    const vramFields = [];
    if (statEnabled(stats, 'gpu-mem-clock')) vramFields.push(`${numberText(gpu.memClock)} MHz`);
    if (statEnabled(stats, 'gpu-vram')) vramFields.push(byteSizeToGb(gpu.vram));
    if (statEnabled(stats, 'gpu-vram-temp')) vramFields.push(`${numberText(gpu.vramTemp)}°C`);
    const vramRow = row(`VRAM${ordinal}`, vramFields);
    if (vramRow) rows.push(vramRow);
  });
  return rows;
}

export function encodeRtssGraphObject({ values = [], width = -32, height = -5, margin = 1, min = 0, max = 50, flags = 0 } = {}) {
  const samples = Array.from(values).filter(finite).slice(-512);
  const actual = Buffer.alloc(36 + samples.length * 4);
  const safeMin = finite(min) ? min : 0;
  const safeMax = finite(max) && max > safeMin ? max : safeMin + 1;
  actual.writeUInt32LE(0x47523030, 0); // RTSS_EMBEDDED_OBJECT_GRAPH_SIGNATURE ('GR00')
  actual.writeUInt32LE(actual.length, 4);
  actual.writeInt32LE(Math.max(-32768, Math.min(32767, width | 0)), 8);
  actual.writeInt32LE(Math.max(-32768, Math.min(32767, height | 0)), 12);
  actual.writeInt32LE(Math.max(-32768, Math.min(32767, margin | 0)), 16);
  actual.writeUInt32LE(flags >>> 0, 20);
  actual.writeFloatLE(safeMin, 24);
  actual.writeFloatLE(safeMax, 28);
  actual.writeUInt32LE(samples.length, 32);
  samples.forEach((value, index) => actual.writeFloatLE(value, 36 + index * 4));
  return actual;
}

/**
 * Build RTSS-safe hypertext for the normal telemetry surface.
 *
 * The function intentionally accepts the flat TelemetrySample shape used by
 * ipc-core as well as a `gpus` aggregate, which keeps it independently
 * testable and makes the publisher resilient to future telemetry batching.
 */
export function buildRtssTelemetryText({
  telemetry = {},
  fps = {},
  settings = {},
  graphObjectTagsSupported = false,
  formatTagsSupported = true,
  graphObjectOffset = 0,
  deviceOrdinals = null,
} = {}) {
  const stats = statsOf(settings);
  const lines = [];
  const addRow = (line) => { if (line) lines.push(line); };

  const fpsFields = [];
  if (statEnabled(stats, 'fps')) fpsFields.push(fps?.fps > 0 ? numberText(fps.fps) : '-');
  if (statEnabled(stats, 'fps-avg')) fpsFields.push(`AVG ${numberText(fps?.avgFps)}`);
  if (statEnabled(stats, 'fps-1pct-low')) fpsFields.push(`1% ${numberText(fps?.low1Pct)}`);
  if (statEnabled(stats, 'fps-01pct-low')) fpsFields.push(`0.1% ${numberText(fps?.low01Pct)}`);
  if (statEnabled(stats, 'fps-99pct')) fpsFields.push(`99% ${numberText(fps?.p99)}`);
  addRow(row('FPS', fpsFields));

  const cpuFields = [];
  if (statEnabled(stats, 'cpu-util')) cpuFields.push(`${numberText(telemetry.cpuUtilPct ?? telemetry.cpuUsage ?? telemetry.cpuPercent)}%`);
  if (statEnabled(stats, 'cpu-clock')) cpuFields.push(`${numberText(finite(telemetry.cpuFreqMhz) ? telemetry.cpuFreqMhz / 1000 : null, 1)} GHz`);
  if (statEnabled(stats, 'cpu-temp')) cpuFields.push(`${numberText(telemetry.cpuTempC ?? telemetry.cpuTemperatureC)}°C`);
  if (statEnabled(stats, 'cpu-power')) cpuFields.push(`${numberText(telemetry.cpuPowerW, 1)} W`);
  addRow(row('CPU', cpuFields));

  if (statEnabled(stats, 'memory-util')) {
    const ramBytes = finite(telemetry.memoryUsedBytes)
      ? telemetry.memoryUsedBytes
      : finite(telemetry.memoryUsedMb) ? telemetry.memoryUsedMb * 1_000_000 : finite(telemetry.ramUsedMb) ? telemetry.ramUsedMb * 1_000_000 : null;
    addRow(row('RAM', [ramSizeToGb(ramBytes)]));
  }

  formatGpuRows(telemetry, settings, stats, deviceOrdinals).forEach(addRow);

  if (statEnabled(stats, 'api')) {
    const api = canonicalizeRtssApi(fps?.api ?? telemetry.api ?? '');
    if (api) addRow(api);
  }
  if (statEnabled(stats, 'frametime')) {
    addRow(row('Frametime', [`${numberText(fps?.frameTimeMs ?? telemetry.frameTimeMs, 2)} ms`]));
  }

  const body = lines.map(escapeRtssValue).join('\n');
  const graph = formatTagsSupported && graphObjectTagsSupported && statEnabled(stats, 'frametime')
    ? `\n<OBJ=${Math.max(0, graphObjectOffset >>> 0).toString(16).padStart(8, '0').toUpperCase()}>`
    : '';
  if (!formatTagsSupported) return safeRtssText(`${body}${graph}`, { lineBreaks: true }).slice(0, RTSS_OSD_MAX_TEXT);

  const prefix = [
    positionTag(settings.position),
    scaleTag(settings.scale, 'classic'),
    `<C0=${colorHex(settings.color)}><C0>`,
  ].join('');
  return `${prefix}${body}${graph}`.slice(0, RTSS_OSD_MAX_TEXT);
}

function validHandle(value) {
  return value !== null && value !== undefined && value !== 0 && value !== 0n;
}

const RTSS_COMPARE_EXCHANGE_PROTO = koffi.proto('int32 ArcPowerCompareExchange32(void *destination, int32 exchange, int32 comparand)');
let rtssAtomicBinding = null;

function createRtssAtomicBinding(kernel32) {
  if (rtssAtomicBinding) return rtssAtomicBinding;
  const virtualAlloc = kernel32.func('VirtualAlloc', 'void*', ['void*', 'size_t', 'uint32', 'uint32']);
  const virtualFree = kernel32.func('VirtualFree', 'int32', ['void*', 'size_t', 'uint32']);
  const virtualProtect = kernel32.func('VirtualProtect', 'bool', [
    'void*', 'size_t', 'uint32', koffi.out(koffi.pointer('uint32')),
  ]);
  const flushInstructionCache = kernel32.func('FlushInstructionCache', 'bool', ['void*', 'void*', 'size_t']);
  const getCurrentProcess = kernel32.func('GetCurrentProcess', 'void*', []);
  const compareExchangeCode = Buffer.from([0x44, 0x89, 0xC0, 0xF0, 0x0F, 0xB1, 0x11, 0xC3]);
  const compareExchangeThunk = virtualAlloc(null, compareExchangeCode.length, 0x3000, 0x04);
  if (!validHandle(compareExchangeThunk)) throw new Error('unable to allocate RTSS atomic thunk');
  try {
    koffi.encode(compareExchangeThunk, 0, `uint8[${compareExchangeCode.length}]`, compareExchangeCode);
    const oldProtection = Buffer.alloc(4);
    if (!virtualProtect(compareExchangeThunk, compareExchangeCode.length, 0x20, oldProtection)) {
      throw new Error('unable to make RTSS atomic thunk executable');
    }
    if (!flushInstructionCache(getCurrentProcess(), compareExchangeThunk, compareExchangeCode.length)) {
      throw new Error('unable to flush RTSS atomic thunk');
    }
  } catch (error) {
    try { virtualFree(compareExchangeThunk, 0, 0x8000); } catch { /* best effort */ }
    throw error;
  }
  // One publisher exists per Arc Power process. Keep this tiny executable
  // page cached for the process lifetime so repeated binding construction
  // neither registers a duplicate Koffi prototype nor leaks another page.
  rtssAtomicBinding = {
    compareExchange: (view, offset, exchange, comparand) => {
      const destination = koffi.address(view) + BigInt(offset);
      return Number(koffi.call(
        compareExchangeThunk,
        RTSS_COMPARE_EXCHANGE_PROTO,
        destination,
        exchange | 0,
        comparand | 0,
      ));
    },
  };
  return rtssAtomicBinding;
}

function defaultBindings() {
  if (process.platform !== 'win32') return null;
  try {
    const kernel32 = koffi.load('kernel32.dll');
    const mapView = kernel32.func('MapViewOfFile', 'void*', ['void*', 'uint32', 'uint32', 'uint32', 'size_t']);
    const open = kernel32.func('OpenFileMappingW', 'void*', ['uint32', 'bool', 'str16']);
    const virtualQuery = kernel32.func('VirtualQuery', 'size_t', ['void*', 'void*', 'size_t']);
    const pointerSize = process.arch === 'x64' || process.arch === 'arm64' ? 8 : 4;
    const querySize = pointerSize === 8 ? 48 : 28;
    const regionSizeOffset = pointerSize === 8 ? 24 : 12;
    const pointerType = pointerSize === 8 ? 'uint64' : 'uint32';
    const getViewLength = (view) => {
      const info = Buffer.alloc(querySize);
      const result = Number(virtualQuery(view, info, querySize));
      if (!Number.isFinite(result) || result < querySize) return null;
      const viewAddress = BigInt(koffi.address(view));
      const regionBase = BigInt(koffi.decode(info, 0, pointerType));
      const regionSize = BigInt(koffi.decode(info, regionSizeOffset, pointerType));
      const regionEnd = regionBase + regionSize;
      if (regionSize <= 0n || viewAddress < regionBase || viewAddress >= regionEnd) return null;
      const remaining = regionEnd - viewAddress;
      return remaining > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(remaining);
    };
    // Electron forbids Koffi external ArrayBuffer views, so Atomics cannot
    // operate on the mapped RTSS address. Use a tiny x64 compare-exchange
    // thunk instead. The instruction is the Windows x64 ABI equivalent of
    // InterlockedCompareExchange(Destination, Exchange, Comparand): RCX is
    // the destination, EDX the exchange value, and R8D the comparand.
    // Unsupported architectures fail closed in the outer binding guard;
    // RTSS then stays unavailable without affecting normal app startup.
    if (process.arch !== 'x64') throw new Error('RTSS atomic binding requires x64');
    const atomic = createRtssAtomicBinding(kernel32);
    return {
      open: (access, inheritHandle, name) => open(access, inheritHandle, name),
      map: (handle) => mapView(handle, RTSS_FILE_MAP_ALL_ACCESS, 0, 0, 0),
      getViewLength,
      requireViewLength: true,
      // Keep the RTSS busy-lock operation atomic across the RTSS and Arc Power
      // processes without asking Electron for an external ArrayBuffer view.
      compareExchange32: (view, offset, exchange, comparand) => {
        return atomic.compareExchange(view, offset, exchange, comparand);
      },
      unmap: kernel32.func('UnmapViewOfFile', 'int32', ['void*']),
      close: kernel32.func('CloseHandle', 'int32', ['void*']),
      read: (view, offset, type = 'uint32') => koffi.decode(view, offset, type),
      write: (view, offset, value, type = 'uint32') => koffi.encode(view, offset, type, value),
      readText: (view, offset, size) => {
        let text = '';
        for (let index = 0; index < size; index += 1) {
          const code = koffi.decode(view, offset + index, 'uint8');
          if (!code) break;
          text += String.fromCharCode(code);
        }
        return cleanOwner(text);
      },
      writeBytes: (view, offset, buffer) => koffi.encode(view, offset, `uint8[${buffer.length}]`, buffer),
    };
  } catch {
    return null;
  }
}

function deviceKeyOf(sample) {
  if (typeof sample?.deviceKey === 'string' && sample.deviceKey.length > 0) return sample.deviceKey;
  if (Number.isInteger(sample?.deviceId)) return `id:${sample.deviceId}`;
  return null;
}

function hasSystemTelemetry(sample) {
  return [
    'cpuUtilPct', 'cpuTempC', 'cpuFreqMhz', 'cpuPowerW', 'memoryUsedBytes',
  ].some((key) => has(sample, key));
}

function sampleTime(sample) {
  return finite(sample?.t) ? sample.t : 0;
}

/** Create the native RTSS writer. All mapping access is lazy and optional. */
export function createRtssOsdPublisher(deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const getFpsSample = typeof deps.getFpsSample === 'function' ? deps.getFpsSample : null;
  const bindings = deps.open && deps.map ? deps : defaultBindings();
  let handle = null;
  let view = null;
  let length = null;
  let version = null;
  let entrySize = null;
  let entryOffset = null;
  let slot = null;
  let last = 0;
  let settings = {};
  let visibleState = true;
  let writeTail = null;
  let fallbackSample = null;
  const latestByDevice = new Map();
  let knownDeviceKeys = null;
  let knownDeviceOrder = null;
  let knownDeviceOrdinals = null;
  const frameHistory = [];
  let clearRetryTimer = null;
  let stopped = false;

  const readValue = (offset, type = 'uint32') => {
    if (deps.readUint32 && type === 'uint32') return deps.readUint32(view, offset) >>> 0;
    if (deps.read) return deps.read(view, offset, type);
    if (Buffer.isBuffer(view)) return type === 'uint32' ? view.readUInt32LE(offset) : view[offset];
    return koffi.decode(view, offset, type);
  };
  const writeValue = (offset, value, type = 'uint32') => {
    if (deps.writeUint32 && type === 'uint32') return deps.writeUint32(view, offset, value >>> 0);
    if (deps.write) return deps.write(view, offset, value, type);
    if (Buffer.isBuffer(view)) {
      if (type === 'uint32') view.writeUInt32LE(value >>> 0, offset);
      else view[offset] = value & 0xFF;
      return undefined;
    }
    return koffi.encode(view, offset, type, value);
  };
  const read32 = (offset) => Number(readValue(offset, 'uint32')) >>> 0;
  const write32 = (offset, value) => writeValue(offset, value, 'uint32');
  const bounds = (offset, size) => Number.isSafeInteger(offset)
    && Number.isSafeInteger(size)
    && offset >= 0
    && size >= 0
    && (!Number.isSafeInteger(length) || offset + size <= length);
  const readText = (offset, size) => {
    if (deps.readText) return cleanOwner(deps.readText(view, offset, size));
    if (Buffer.isBuffer(view)) return cleanOwner(view.subarray(offset, offset + size).toString('latin1').split('\0')[0]);
    if (deps.read) {
      let text = '';
      for (let index = 0; index < size; index += 1) {
        const code = Number(deps.read(view, offset + index, 'uint8')) & 0xFF;
        if (!code) break;
        text += String.fromCharCode(code);
      }
      return cleanOwner(text);
    }
    return cleanOwner(koffi.decode(view, offset, `char[${size}]`));
  };
  const writeBytes = (offset, value, size, { preserveBackspace = false } = {}) => {
    if (!bounds(offset, size)) throw new RangeError('RTSS OSD write is outside mapped view');
    const buffer = Buffer.alloc(size);
    const source = Buffer.isBuffer(value)
      ? value
      : Buffer.from(safeRtssText(value, { backspace: preserveBackspace }), 'ascii');
    const copySize = Buffer.isBuffer(value) ? Math.min(size, source.length) : Math.min(Math.max(0, size - 1), source.length);
    source.copy(buffer, 0, 0, copySize);
    if (deps.writeBytes) return deps.writeBytes(view, offset, buffer);
    if (Buffer.isBuffer(view)) return buffer.copy(view, offset);
    if (deps.write) return deps.write(view, offset, buffer, `uint8[${size}]`);
    return koffi.encode(view, offset, `uint8[${size}]`, buffer);
  };

  const compareExchange32 = (offset, exchange, comparand) => {
    if (deps.compareExchange32) {
      return Number(deps.compareExchange32(view, offset, exchange | 0, comparand | 0)) >>> 0;
    }
    if (bindings?.compareExchange32) {
      return Number(bindings.compareExchange32(view, offset, exchange | 0, comparand | 0)) >>> 0;
    }
    // Buffer fixtures are single-threaded, but retain the same CAS contract
    // so lifecycle/locking tests exercise the exact publisher state machine.
    if (Buffer.isBuffer(view)) {
      const previous = view.readUInt32LE(offset);
      if (previous === (comparand >>> 0)) view.writeUInt32LE(exchange >>> 0, offset);
      return previous;
    }
    return null;
  };
  const acquireBusy = () => {
    if (version < RTSS_OSD_BUSY_VERSION) return true;
    if (!bounds(RTSS_OSD_HEADER.busy, 4)) return false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = read32(RTSS_OSD_HEADER.busy);
      if (current & 1) return false;
      const previous = compareExchange32(RTSS_OSD_HEADER.busy, current | 1, current);
      if (previous === current) return true;
      if (previous === null) return false;
    }
    return false;
  };
  const releaseBusy = () => {
    if (version < RTSS_OSD_BUSY_VERSION) return true;
    if (!bounds(RTSS_OSD_HEADER.busy, 4)) return false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = read32(RTSS_OSD_HEADER.busy);
      if (!(current & 1)) return true;
      const previous = compareExchange32(RTSS_OSD_HEADER.busy, current & ~1, current);
      if (previous === current) return true;
      if (previous === null) return false;
    }
    return false;
  };

  const scheduleClearRetry = () => {
    if (visibleState || clearRetryTimer !== null) return;
    clearRetryTimer = setTimeout(() => {
      clearRetryTimer = null;
      if (!visibleState) clear();
    }, 50);
    clearRetryTimer.unref?.();
  };

  const mappingHealthy = () => {
    if (view === null || !bounds(0, 40)) return false;
    try {
      return read32(RTSS_OSD_HEADER.signature) === RTSS_OSD_SIGNATURE
        && read32(RTSS_OSD_HEADER.version) >= RTSS_OSD_MIN_VERSION;
    } catch {
      return false;
    }
  };

  const close = () => {
    if (clearRetryTimer !== null) {
      clearTimeout(clearRetryTimer);
      clearRetryTimer = null;
    }
    try { if (view !== null) bindings?.unmap?.(view); } catch { /* best effort */ }
    try { if (validHandle(handle)) bindings?.close?.(handle); } catch { /* best effort */ }
    view = null;
    handle = null;
    length = null;
    version = null;
    entrySize = null;
    entryOffset = null;
    slot = null;
  };

  const open = () => {
    if (stopped) return false;
    if (view !== null) {
      if (slot !== null && mappingHealthy()) return true;
      close();
    }
    if (!bindings) return false;
    try {
      handle = bindings.open(RTSS_FILE_MAP_ALL_ACCESS, false, RTSS_OSD_MAPPING_NAME);
      if (!validHandle(handle)) { handle = null; return false; }
      view = bindings.map(handle, RTSS_FILE_MAP_ALL_ACCESS);
      if (!validHandle(view)) { close(); return false; }
      length = deps.getViewLength?.(view)
        ?? bindings.getViewLength?.(view)
        ?? (view?.byteLength ?? null);
      if (bindings.requireViewLength && !Number.isSafeInteger(length)) { close(); return false; }
      if (!bounds(0, 40)) { close(); return false; }
      const signature = read32(RTSS_OSD_HEADER.signature);
      version = read32(RTSS_OSD_HEADER.version);
      entrySize = read32(RTSS_OSD_HEADER.osdEntrySize);
      entryOffset = read32(RTSS_OSD_HEADER.osdArrOffset);
      const count = read32(RTSS_OSD_HEADER.osdArrSize);
      const end = entryOffset + entrySize * count;
      if (signature !== RTSS_OSD_SIGNATURE
        || version < RTSS_OSD_MIN_VERSION
        || entrySize < RTSS_OSD_ENTRY_MIN
        || entrySize > 1024 * 1024
        || entryOffset < 40
        || count < 2
        || count > 256
        || !Number.isSafeInteger(end)
        || end > RTSS_OSD_MAX_MAPPING_BYTES
        || !bounds(entryOffset, entrySize * count)) {
        close();
        return false;
      }
      if (version >= RTSS_OSD_EXT_VERSION && entrySize < RTSS_OSD_ENTRY.ex + RTSS_OSD_EX_SIZE) {
        close();
        return false;
      }
      // Recover an interrupted Arc Power session before claiming a fresh
      // slot. Otherwise an empty earlier slot can hide the old ArcPower slot
      // and leave two telemetry HUDs registered after a restart.
      for (let pass = 0; pass < 2 && slot === null; pass += 1) {
        for (let index = 1; index < count; index += 1) {
          const base = entryOffset + index * entrySize;
          if (!bounds(base, RTSS_OSD_ENTRY_MIN)) continue;
          const owner = readText(base + RTSS_OSD_ENTRY.owner, Math.min(256, entrySize - RTSS_OSD_ENTRY.owner));
          if (pass === 0 ? owner !== RTSS_OSD_OWNER : owner !== '') continue;
          let lockHeld = false;
          let claimed = false;
          try {
            // OSD slots are shared by every RTSS client. Re-check the owner
            // after taking the v2.14+ writer lock so two Arc Power instances
            // cannot race an empty slot into a false claim.
            if (version >= RTSS_OSD_BUSY_VERSION) {
              if (!acquireBusy()) continue;
              lockHeld = true;
            }
            const currentOwner = readText(base + RTSS_OSD_ENTRY.owner, Math.min(256, entrySize - RTSS_OSD_ENTRY.owner));
            const stillClaimable = pass === 0
              ? currentOwner === RTSS_OSD_OWNER
              : currentOwner === '';
            if (stillClaimable) {
              if (pass === 1) writeBytes(base + RTSS_OSD_ENTRY.owner, RTSS_OSD_OWNER, 256);
              claimed = version < RTSS_OSD_BUSY_VERSION || releaseBusy();
              lockHeld = false;
            }
          } catch {
            claimed = false;
          } finally {
            if (lockHeld) {
              try { releaseBusy(); } catch { /* best effort */ }
            }
          }
          if (claimed) {
            slot = index;
            break;
          }
        }
      }
      if (slot === null) {
        close();
        return false;
      }
      return true;
    } catch {
      close();
      return false;
    }
  };

  const graphSupported = () => version >= RTSS_OSD_BUFFER_VERSION
    && entrySize >= RTSS_OSD_ENTRY.buffer + RTSS_OSD_BUFFER_SIZE
    && bounds(entryOffset + slot * entrySize + RTSS_OSD_ENTRY.buffer, RTSS_OSD_BUFFER_SIZE);

  const rememberTelemetry = (telemetry) => {
    if (!telemetry || typeof telemetry !== 'object') return;
    const key = deviceKeyOf(telemetry);
    if (key) latestByDevice.set(key, telemetry);
    else fallbackSample = telemetry;
    rememberFrameTimes(telemetry.frametimeHistory);
    rememberFrameTime(telemetry.frameTimeMs);
  };

  const rememberFrameTime = (value) => {
    if (!finite(value) || value <= 0) return;
    frameHistory.push(value);
    if (frameHistory.length > 512) frameHistory.shift();
  };
  const rememberFrameTimes = (values) => {
    if (!Array.isArray(values)) return;
    values.filter((value) => finite(value) && value > 0).slice(-512).forEach(rememberFrameTime);
  };

  const selectedSamples = () => {
    const all = [...latestByDevice.entries()]
      .filter(([key]) => knownDeviceKeys === null || knownDeviceKeys.has(key))
      .map(([, sample]) => sample);
    if (fallbackSample) all.push(fallbackSample);
    if (knownDeviceOrder !== null) {
      const order = (sample) => {
        const key = deviceKeyOf(sample);
        const index = key === null ? -1 : knownDeviceOrder.indexOf(key);
        return index < 0 ? Number.MAX_SAFE_INTEGER : index;
      };
      return all.sort((left, right) => order(left) - order(right));
    }
    return all.sort((left, right) => sampleTime(right) - sampleTime(left));
  };

  const composeTelemetry = (current) => {
    const samples = selectedSamples();
    const system = samples.find(hasSystemTelemetry) ?? current ?? {};
    const gpuSamples = samples.flatMap((sample) => gpuEntries(sample));
    const currentGpus = gpuEntries(current);
    const unique = new Map();
    [...gpuSamples, ...currentGpus].forEach((gpu, index) => {
      const key = deviceKeyOf(gpu) ?? gpu?.deviceName ?? `gpu:${index}`;
      unique.set(key, gpu);
    });
    const composed = { ...current, ...system, gpus: [...unique.values()] };
    // Keep the current lane's GPU fields when it is a flat sample. If the
    // current sample only carries system fields, the newest GPU lane supplies
    // the primary row so the OSD never flickers to '-'.
    const currentGpu = gpuLike(current) ? current : samples.find(gpuLike);
    if (currentGpu) Object.assign(composed, currentGpu);
    return composed;
  };

  const publishNow = (payload = {}, fpsOverride = undefined) => {
    if (stopped || !visibleState || settings.enabled === false || !open()) return false;
    if (!mappingHealthy()) { close(); return false; }
    let lockHeld = false;
    try {
      if (version >= RTSS_OSD_BUSY_VERSION) {
        if (!acquireBusy()) return false;
        lockHeld = true;
      }
      const base = entryOffset + slot * entrySize;
      const incoming = typeof payload === 'string' ? {} : (payload.telemetry ?? payload);
      rememberTelemetry(incoming);
      const telemetry = composeTelemetry(incoming);
      const fps = fpsOverride === undefined ? payload.fps : fpsOverride;
      // The native RTSS FPS lane is the source of truth for the live
      // frametime graph. TelemetryService may not carry a frameTimeMs field,
      // so retain the RTSS sample separately from the GPU/system snapshot.
      rememberFrameTime(fps?.frameTimeMs);
      const text = typeof payload === 'string'
        ? payload
        : payload.text ?? buildRtssTelemetryText({
            telemetry,
            fps: fps ?? {},
            settings,
            formatTagsSupported: version >= RTSS_OSD_FORMAT_VERSION,
            graphObjectTagsSupported: graphSupported(),
            graphObjectOffset: 0,
            deviceOrdinals: knownDeviceOrdinals,
          });
      const textOffset = version >= RTSS_OSD_EXT_VERSION ? RTSS_OSD_ENTRY.ex : RTSS_OSD_ENTRY.text;
      const textSize = version >= RTSS_OSD_EXT_VERSION ? RTSS_OSD_EX_SIZE : 256;
      writeBytes(base + textOffset, text, textSize, {
        preserveBackspace: typeof payload !== 'string' && payload.text === undefined,
      });
      if (graphSupported() && version >= RTSS_OSD_BUFFER_VERSION && statEnabled(statsOf(settings), 'frametime')) {
        writeBytes(base + RTSS_OSD_ENTRY.buffer, encodeRtssGraphObject({ values: frameHistory }), RTSS_OSD_BUFFER_SIZE);
      }
      write32(RTSS_OSD_HEADER.frame, (read32(RTSS_OSD_HEADER.frame) + 1) >>> 0);
      last = now();
      return true;
    } catch {
      return false;
    } finally {
      if (lockHeld) {
        try { releaseBusy(); } catch { /* best effort */ }
      }
    }
  };

  const publish = (payload = {}) => {
    if (stopped) return false;
    const needsSample = typeof payload !== 'string' && payload.fps === undefined && getFpsSample;
    const task = async () => {
      let fps = payload?.fps;
      if (needsSample) {
        try { fps = await getFpsSample(); } catch { fps = null; }
      }
      if (stopped) return false;
      return publishNow(payload, fps);
    };
    if (!needsSample && !writeTail) return publishNow(payload, payload?.fps);
    const prior = writeTail ?? Promise.resolve();
    const next = prior.then(task, task);
    let cleanup;
    cleanup = next.finally(() => { if (writeTail === cleanup) writeTail = null; });
    writeTail = cleanup;
    return next;
  };

  const clear = ({ schedule = true } = {}) => {
    if (slot === null || view === null) return false;
    if (!mappingHealthy()) { close(); return false; }
    let lockHeld = false;
    try {
      if (version >= RTSS_OSD_BUSY_VERSION) {
        if (!acquireBusy()) {
          if (schedule) scheduleClearRetry();
          return false;
        }
        lockHeld = true;
      }
      const base = entryOffset + slot * entrySize;
      writeBytes(base + RTSS_OSD_ENTRY.text, '', Math.min(256, entrySize));
      if (version >= RTSS_OSD_EXT_VERSION) writeBytes(base + RTSS_OSD_ENTRY.ex, '', Math.min(RTSS_OSD_EX_SIZE, entrySize - RTSS_OSD_ENTRY.ex));
      writeBytes(base + RTSS_OSD_ENTRY.owner, '', Math.min(256, entrySize - RTSS_OSD_ENTRY.owner));
      write32(RTSS_OSD_HEADER.frame, (read32(RTSS_OSD_HEADER.frame) + 1) >>> 0);
      if (lockHeld && !releaseBusy()) {
        if (schedule) scheduleClearRetry();
        return false;
      }
      lockHeld = false;
      slot = null;
      close();
      return true;
    } catch {
      if (!visibleState && schedule) scheduleClearRetry();
      return false;
    } finally {
      if (lockHeld) {
        try { releaseBusy(); } catch { /* best effort */ }
      }
    }
  };

  const updateSettings = (next = {}) => {
    if (next && typeof next === 'object') settings = { ...settings, ...next };
    return { ...settings };
  };
  const setKnownDeviceKeys = (keys, order = keys, groups = null) => {
    if (!Array.isArray(keys)) {
      knownDeviceKeys = null;
      knownDeviceOrder = null;
      knownDeviceOrdinals = null;
      return null;
    }
    knownDeviceKeys = new Set(keys.filter((key) => typeof key === 'string' && key.length > 0));
    knownDeviceOrder = Array.isArray(order)
      ? [...new Set(order.filter((key) => typeof key === 'string' && knownDeviceKeys.has(key)))]
      : [...knownDeviceKeys];
    knownDeviceOrdinals = Array.isArray(groups)
      ? new Map(groups.flatMap((aliases, index) => (Array.isArray(aliases) ? aliases : [])
        .filter((key) => typeof key === 'string' && key.length > 0)
        .map((key) => [key, index + 1])))
      : null;
    for (const key of latestByDevice.keys()) {
      if (!knownDeviceKeys.has(key)) latestByDevice.delete(key);
    }
    return [...knownDeviceKeys];
  };
  const setVisible = (next) => {
    if (stopped) return false;
    visibleState = Boolean(next);
    if (!visibleState) clear();
    else if (settings.enabled !== false) open();
    return visibleState;
  };

  const stop = async () => {
    if (stopped && slot === null && view === null) return;
    stopped = true;
    visibleState = false;
    const pending = writeTail;
    if (pending) {
      try { await pending; } catch { /* a deferred native read must not block teardown */ }
    }
    // RTSS may briefly hold dwBusy while it refreshes the game surface. Give
    // that renderer a bounded hand-off window before falling back to the
    // existing unref'd retry timer. Do not unmap a still-owned slot while its
    // text is live: that would leave ArcPower registered until RTSS restarts.
    for (let attempt = 0; attempt < 8 && slot !== null && view !== null; attempt += 1) {
      if (clear({ schedule: false })) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (slot === null || view === null) close();
    else scheduleClearRetry();
  };

  return {
    publish,
    clear,
    updateSettings,
    setKnownDeviceKeys,
    setVisible,
    stop,
    available: () => !stopped && visibleState && settings.enabled !== false && open(),
    getState: () => ({
      exists: view !== null,
      visible: visibleState,
      bounds: null,
      position: settings.position ?? 'top-left',
      scale: settings.scale ?? 1,
      enabled: visibleState && settings.enabled !== false,
      hotkeyRegistered: false,
      available: view !== null && slot !== null,
      provider: 'rtss',
      version,
      slot,
      lastPublishedAt: last,
    }),
  };
}
