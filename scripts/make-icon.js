// Arc Power — M2C-B B6 blue "AP" icon generator (PURE JS, no deps).
//
// Renders the brand icon procedurally and writes:
//   build/icon.ico           — multi-size ICO for electron-builder
//   build/icon.png           — 256 px reference PNG (build resources)
//   src/assets/icon.png      — 256 px runtime icon (BrowserWindow + sidebar)
//   src/assets/tray-icon.png — 32 px runtime tray icon
//   src/assets/favicon.png   — 16 px page favicon
//
// Design (for the user to approve visually later — the machine is asleep):
//   - blue rounded square (corner radius 22%) with a vertical gradient
//     #40b2ff (top) -> #1466b8 (bottom) — the app's accent-blue family;
//   - a white "AP" monogram, glyph-dominant so it reads at 16 px:
//     the 'A' is a clean triangle with a crossbar, the 'P' a stem + bowl;
//   - a thin white arc (the fan-curve / "Arc" motif) sweeping under the
//     letters, echoing the fan page's curve shape.
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

// Palette (RGB).
const COLOR_TOP = [64, 178, 255];     // #40b2ff
const COLOR_BOTTOM = [20, 102, 184];  // #1466b8
const WHITE = [255, 255, 255];

// ---------------------------------------------------------------------------
// Shape tests (normalized 0..1 coordinates, y grows DOWN — SVG convention)
// ---------------------------------------------------------------------------

function roundedSquareAlpha(x, y) {
  const r = 0.22;
  const dx = Math.abs(x - 0.5);
  const dy = Math.abs(y - 0.5);
  if (dx > 0.5 || dy > 0.5) return 0;
  const cx = Math.max(dx - (0.5 - r), 0);
  const cy = Math.max(dy - (0.5 - r), 0);
  return cx * cx + cy * cy <= r * r ? 1 : 0;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  const qx = x1 + t * dx - px;
  const qy = y1 + t * dy - py;
  return Math.sqrt(qx * qx + qy * qy);
}

// 'A': triangle with a crossbar (apex (0.29, 0.16), base corners on y 0.72).
function inA(x, y, t) {
  if (distToSegment(x, y, 0.29, 0.16, 0.12, 0.72) <= t) return true;
  if (distToSegment(x, y, 0.29, 0.16, 0.46, 0.72) <= t) return true;
  if (x >= 0.185 && x <= 0.395 && y >= 0.44 - t && y <= 0.44 + t) return true;
  return false;
}

// 'P': vertical stem (x 0.56..0.645) + a bowl (half circle opening right).
function inP(x, y, t) {
  if (x >= 0.56 && x <= 0.56 + 2.2 * t && y >= 0.16 && y <= 0.72) return true;
  if (x < 0.645) return false;
  const dx = x - 0.71;
  const dy = y - 0.365;
  if (dx * dx + dy * dy > 0.15 * 0.15) return false;
  if (y < 0.20 || y > 0.44) return false;
  return true;
}

// The fan-curve arc under the letters (center (0.5, 1.02), r 0.28, sweep
// 215°..325° in y-down coordinates — a shallow ∪ under the monogram).
function inArc(x, y, t) {
  const dx = x - 0.5;
  const dy = y - 1.02;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (Math.abs(d - 0.28) > t) return false;
  const ang = Math.atan2(dy, dx); // y-down: 180..360 = lower half
  const deg = ((ang * 180) / Math.PI + 360) % 360;
  return deg >= 215 && deg <= 325;
}

function sample(x, y, glyphT) {
  // Color: glyph white on the blue gradient; everything else blue gradient.
  const base = [
    COLOR_TOP[0] + (COLOR_BOTTOM[0] - COLOR_TOP[0]) * y,
    COLOR_TOP[1] + (COLOR_BOTTOM[1] - COLOR_TOP[1]) * y,
    COLOR_TOP[2] + (COLOR_BOTTOM[2] - COLOR_TOP[2]) * y,
  ];
  const white = inA(x, y, glyphT) || inP(x, y, glyphT) || inArc(x, y, glyphT);
  return { color: white ? WHITE : base, alpha: roundedSquareAlpha(x, y) };
}

// ---------------------------------------------------------------------------
// Renderer (4x supersample -> box downsample)
// ---------------------------------------------------------------------------

function renderIcon(size) {
  const SS = 4; // supersample factor
  const N = size * SS;
  const glyphT = Math.max(0.062, 2.0 / size); // stroke thickness (px-normalized)
  // Accumulate RGBA over the supersample grid.
  const acc = new Float64Array(size * size * 4);
  for (let sy = 0; sy < N; sy++) {
    for (let sx = 0; sx < N; sx++) {
      const x = (sx + 0.5) / N;
      const y = (sy + 0.5) / N;
      const { color, alpha } = sample(x, y, glyphT);
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
