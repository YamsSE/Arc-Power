// Verify the vendored files inside the packaged asar byte-for-byte.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const fs = require('node:fs');

const archive = 'dist/win-unpacked/resources/app.asar';
const list = asar.listPackage(archive);
const find = (re) => list.find((f) => re.test(f));

for (const [name, re, local] of [
  ['IntelMSR.bin', /IntelMSR\.bin$/, 'src/main/backend/IntelMSR.bin'],
  ['PawnIO_setup.exe', /PawnIO_setup\.exe$/, 'src/main/backend/PawnIO_setup.exe'],
  ['COPYING', /COPYING$/, 'src/main/backend/COPYING'],
]) {
  const p = find(re);
  if (!p) { console.log(`${name}: NOT FOUND in asar`); continue; }
  // The listed path starts with the archive's leading separator - strip ONLY
  // that (the inner backslashes are the archive's own separators and the
  // Windows lookup splits on them).
  const packed = asar.extractFile(archive, p.replace(/^[\\/]/, ''));
  const vendored = fs.readFileSync(local);
  console.log(`${name}: asar path '${p}' | ${packed.length} bytes | vendored ${vendored.length} | identical: ${packed.equals(vendored)}`);
}
// The asar-unpacked setup (the spawnable copy).
const unpacked = 'dist/win-unpacked/resources/app.asar.unpacked/src/main/backend/PawnIO_setup.exe';
const u = fs.readFileSync(unpacked);
const vendored = fs.readFileSync('src/main/backend/PawnIO_setup.exe');
console.log(`PawnIO_setup.exe (asar.unpacked): ${u.length} bytes | identical to vendored: ${u.equals(vendored)}`);
