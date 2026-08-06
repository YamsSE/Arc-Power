// Arc Power — M3-C-C "new minimal mark" icon generator (PURE JS, no deps).
//
// Renders the brand icon procedurally and writes:
//   build/icon.ico           — multi-size ICO for electron-builder
//   build/icon.png           — 256 px reference PNG (build resources)
//   src/assets/icon.png      — 256 px runtime icon (BrowserWindow)
//   src/assets/tray-icon.png — 32 px runtime tray icon
//   src/assets/favicon.png   — 16 px page favicon
//
// Design (user: "new minimal mark", M3-C-C):
//   - a DARK rounded square (corner radius 24%) with a subtle vertical
//     gradient #1a2132 (top) -> #0f131f (bottom) — the app's dark surface
//     family, so the mark reads as a dark tile on any background;
//   - a single BOLD blue "A" in #4cc2ff — EXACTLY the sidebar accent
//     (styles.css --accent), the one brand color the app already uses;
//     a filled triangle with a cut counter + a crossbar, so it stays a
//     crisp "A" from 256 px down to 16 px (the favicon).
//
// The PNG encoder is hand-rolled (zlib for IDAT + manual chunks + CRC32)
// and the ICO is a PNG-in-ICO container — no sharp/canvas/npm deps.
// Rendering uses 4x supersampling + box downsampling for smooth edges.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = path.join(ROOT, 'build');
const ASSETS_DIR = path.join(ROOT, 'src', 'assets');

const SIZES = [16, 32, 64, 128, 256];

// Palette (RGB). ACCENT is styles.css --accent (#4cc2ff) verbatim — the
// sidebar accent the mark must match.
const ACCENT = [76, 194, 255];        // #4cc2ff
const BG_TOP = [26, 33, 50];          // #1a2132
const BG_BOTTOM = [15, 19, 31];       // #0f131f

// ---------------------------------------------------------------------------
// Shape tests (normalized 0..1 coordinates, y grows DOWN — SVG convention)
// ---------------------------------------------------------------------------

function roundedSquareAlpha(x, y) {
  const r = 0.24;
  const dx = Math.abs(x - 0.5);
  const dy = Math.abs(y - 0.5);
  if (dx > 0.5 || dy > 0.5) return 0;
  const cx = Math.max(dx - (0.5 - r), 0);
  const cy = Math.max(dy - (0.5 - r), 0);
  return cx * cx + cy * cy <= r * r ? 1 : 0;
}

/** Point-in-triangle (half-plane test, CCW vertices). */
function inTriangle(px, py, a, b, c) {
  const sign = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const d1 = sign(px, py, a[0], a[1], b[0], b[1]);
  const d2 = sign(px, py, b[0], b[1], c[0], c[1]);
  const d3 = sign(px, py, c[0], c[1], a[0], a[1]);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// The "A": apex (0.5, 0.16), base corners (0.22, 0.80) / (0.78, 0.80). The
// counter (the hole) is the same triangle scaled toward its centroid by
// 0.55, so the strokes stay proportional at every size. The crossbar is a
// band between the legs at y 0.48.
const TRI = [[0.5, 0.16], [0.22, 0.80], [0.78, 0.80]];
const CENTROID = [(0.5 + 0.22 + 0.78) / 3, (0.16 + 0.80 + 0.80) / 3];
const COUNTER_SCALE = 0.55;
const INNER = TRI.map(([x, y]) => [
  CENTROID[0] + (x - CENTROID[0]) * COUNTER_SCALE,
  CENTROID[1] + (y - CENTROID[1]) * COUNTER_SCALE,
]);

// Crossbar: the leg x-positions at y 0.48 (0.36 / 0.64), band 0.455..0.515.
function inCrossbar(x, y) {
  return x >= 0.36 && x <= 0.64 && y >= 0.455 && y <= 0.515;
}

function inA(x, y) {
  if (!inTriangle(x, y, TRI[0], TRI[1], TRI[2])) return false;
  if (inTriangle(x, y, INNER[0], INNER[1], INNER[2])) return false;
  return true;
}

function sample(x, y) {
  // Dark rounded square background (subtle vertical gradient); the bold
  // accent-blue "A" on top.
  const base = [
    BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * y,
    BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * y,
    BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * y,
  ];
  const blue = inA(x, y) || inCrossbar(x, y);
  return { color: blue ? ACCENT : base, alpha: roundedSquareAlpha(x, y) };
}

// ---------------------------------------------------------------------------
// Renderer (4x supersample -> box downsample)
// ---------------------------------------------------------------------------

function renderIcon(size) {
  const SS = 4; // supersample factor
  const N = size * SS;
  const acc = new Float64Array(size * size * 4);
  for (let sy = 0; sy < N; sy++) {
    for (let sx = 0; sx < N; sx++) {
      const x = (sx + 0.5) / N;
      const y = (sy + 0.5) / N;
      const { color, alpha } = sample(x, y);
      if (alpha <= 0) continue;
      const ox = Math.floor(sx / SS);
      const oy = Math.floor(sy / SS);
      const oi = (oy * size + ox) * 4;
      acc[oi] += color[0] * alpha;
      acc[oi + 1] += color[1] * alpha;
      acc[oi + 2] += color[2] * alpha;
      acc[oi + 3] += alpha;
    }
  }
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const a = acc[i * 4 + 3];
    const alpha = a / (SS * SS);
    out[i * 4] = Math.round(acc[i * 4] / (a || 1));
    out[i * 4 + 1] = Math.round(acc[i * 4 + 1] / (a || 1));
    out[i * 4 + 2] = Math.round(acc[i * 4 + 2] / (a || 1));
    out[i * 4 + 3] = Math.round(alpha * 255);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder (zlib + manual chunks + CRC32) — no deps
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode raw RGBA pixels (filter 0 per row) as a PNG. */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// ICO container (PNG-in-ICO — valid for Vista+; entries carry PNG blobs)
// ---------------------------------------------------------------------------

function encodeIco(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);
  const entries = [];
  const blobs = [];
  let offset = 6 + count * 16;
  for (const { size, png } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size === 256 ? 0 : size, 0);  // width (0 = 256)
    e.writeUInt8(size === 256 ? 0 : size, 1);  // height
    e.writeUInt8(0, 2);                        // palette
    e.writeUInt8(0, 3);                        // reserved
    e.writeUInt16LE(1, 4);                     // planes
    e.writeUInt16LE(32, 6);                    // bpp
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    blobs.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

mkdirSync(BUILD_DIR, { recursive: true });
mkdirSync(ASSETS_DIR, { recursive: true });

const pngs = SIZES.map((size) => ({ size, png: encodePng(size, renderIcon(size)) }));
const bySize = new Map(pngs.map((p) => [p.size, p.png]));
const ico = encodeIco(pngs);

const files = [
  [path.join(BUILD_DIR, 'icon.ico'), ico],
  [path.join(BUILD_DIR, 'icon.png'), bySize.get(256)],
  [path.join(ASSETS_DIR, 'icon.png'), bySize.get(256)],
  [path.join(ASSETS_DIR, 'tray-icon.png'), bySize.get(32)],
  [path.join(ASSETS_DIR, 'favicon.png'), bySize.get(16)],
];
for (const [file, buf] of files) writeFileSync(file, buf);

console.log(`[make-icon] wrote ${files.length} assets:`);
for (const [file, buf] of files) {
  console.log(`  ${path.relative(ROOT, file)} (${buf.length} bytes)`);
}
console.log(`[make-icon] ICO contains ${pngs.length} sizes: ${pngs.map((p) => `${p.size}px`).join(', ')}`);
