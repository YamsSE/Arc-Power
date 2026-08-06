// M2C-B B6 — icon asset validity tests: the generated PNGs (IHDR magic +
// dimensions + a few sample pixels decoded via zlib) and the ICO container
// (ICONDIR header + one PNG entry per size). All rows are written with
// filter 0 by scripts/make-icon.js, so decoding is a plain inflate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Parse a PNG: returns { width, height, rgba (unfiltered, filter 0), chunks }. */
function parsePng(buf) {
  assert.ok(buf.length >= 33 && buf.subarray(0, 8).equals(PNG_MAGIC), 'PNG magic');
  let off = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'bit depth 8');
      assert.equal(data[9], 6, 'color type RGBA');
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    off += 12 + len;
  }
  assert.equal(width, height, 'square');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  assert.equal(raw.length, stride * height, 'raw scanline length (filter byte + RGBA)');
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * stride], 0, `filter byte of row ${y} is none`);
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    raw.copy(rgba, y * width * 4, y * stride + 1, (y + 1) * stride);
  }
  return { width, height, rgba };
}

const px = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2], img.rgba[i + 3]];
};

function isBlueish(rgb) {
  return rgb[2] > rgb[0] && rgb[2] > 120;
}
function isDarkish(rgb) {
  return rgb[0] < 90 && rgb[1] < 100 && rgb[2] < 120;
}

const ASSETS = [
  ['src/assets/icon.png', 256],
  ['src/assets/tray-icon.png', 32],
  ['src/assets/favicon.png', 16],
];

test('M3-C-C: runtime PNG assets are valid, square, and render the minimal dark-square + blue-A mark', () => {
  for (const [rel, size] of ASSETS) {
    const img = parsePng(readFileSync(path.join(ROOT, rel)));
    assert.equal(img.width, size, `${rel} is ${size}px`);
    // corner: transparent (rounded square — the true corner pixel (0,0) is
    // outside the corner arc at every size)
    const corner = px(img, 0, 0);
    assert.equal(corner[3], 0, `${rel} corner is transparent`);
    // top-center: DARK rounded-square background (the new minimal mark is a
    // dark tile, not the old blue tile)
    const top = px(img, Math.floor(size / 2), Math.floor(size * 0.05));
    assert.equal(top[3], 255, `${rel} top is opaque`);
    assert.ok(isDarkish(top), `${rel} top is dark (${top})`);
    // the bold blue "A" strokes are present mid-height: at y 0.3 the two
    // legs cross (accent #4cc2ff — the sidebar accent, blue-dominant)
    const midRow = Math.floor(size * 0.3);
    let blue = 0;
    for (let x = 0; x < size; x++) {
      if (isBlueish(px(img, x, midRow))) blue++;
    }
    assert.ok(blue >= Math.max(2, size / 10), `${rel} has blue "A" strokes on the mid row (${blue} px)`);
    // the A's counter (the hole between the legs below the crossbar) shows
    // the DARK background, not a blue blob — the glyph is a real "A"
    const hole = px(img, Math.floor(size * 0.5), Math.floor(size * 0.62));
    assert.ok(isDarkish(hole), `${rel} counter hole is dark (${hole})`);
  }
});

test('B6: build/icon.ico is a PNG-in-ICO container with all five sizes', () => {
  const ico = readFileSync(path.join(ROOT, 'build', 'icon.ico'));
  assert.equal(ico.readUInt16LE(0), 0, 'reserved');
  assert.equal(ico.readUInt16LE(2), 1, 'type = icon');
  const count = ico.readUInt16LE(4);
  assert.equal(count, 5, 'five sizes');
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    const e = i * 16 + 6;
    const w = ico.readUInt8(e);
    const h = ico.readUInt8(e + 1);
    const bytes = ico.readUInt32LE(e + 8);
    const off = ico.readUInt32LE(e + 12);
    const size = w === 0 ? 256 : w;
    assert.equal(h === 0 ? 256 : h, size, `entry ${i} square`);
    const png = ico.subarray(off, off + bytes);
    const img = parsePng(png);
    assert.equal(img.width, size, `entry ${i} PNG is ${size}px`);
    seen.add(size);
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [16, 32, 64, 128, 256]);
});

test('B6: build/icon.png matches the runtime 256px asset (single design source)', () => {
  const a = readFileSync(path.join(ROOT, 'build', 'icon.png'));
  const b = readFileSync(path.join(ROOT, 'src', 'assets', 'icon.png'));
  assert.ok(a.equals(b), 'identical bytes');
});

test('B6: the tray embeds the same 32px art (decodeTrayIcon stays valid)', async () => {
  const { decodeTrayIcon } = await import('../src/main/tray.js');
  const tray = decodeTrayIcon();
  assert.equal(tray.width, 32);
  assert.equal(tray.height, 32);
});
