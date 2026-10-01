import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const website = fs.readFileSync(new URL('../website/index.html', import.meta.url), 'utf8');

test('support status documentation uses the verified GPU wording', () => {
  assert.match(readme, /\| Arc A3 \/ A5 \/ A7 series \| Alchemist \| \*\*Verified - Working\*\* \|/);
  assert.match(readme, /\| Arc B580 \/ B570 \| Battlemage \| VF writes use driver-reported steps and require exact LIVE read-back \|/);
  assert.match(readme, /\| Arc Pro B50 \| Battlemage \(pro\) \| \*\*Verified - Tweaks & Telemetry only\*\* \|/);
  assert.match(readme, /\| Arc iGPU \| Alchemist & Battlemage \| \*\*Verified - Tweaks & Telemetry only\*\* \|/);
  assert.match(readme, /- \[x\] Battlemage controls and telemetry/);
  assert.match(readme, /- \[ \] B580 VF curve apply verified against IGS behavior/);
  assert.doesNotMatch(readme, /Code paths complete, unverified on hardware/);
  assert.match(readme, /B580 curve behavior still needs a successful hardware verification against IGS/);

  assert.match(website, /<span class="chip chip-ok">Verified<span class="chip-sub">- Working<\/span><\/span>/g);
  assert.match(website, /<span class="chip chip-warn">VF curves<span class="chip-sub">- LIVE read-back checked<\/span><\/span>/);
  assert.match(website, /B580 behavior still needs successful hardware verification against IGS/);
  assert.match(website, /<span class="chip chip-ok">Verified<span class="chip-sub">- Tweaks &amp; Telemetry only<\/span><\/span>/g);
  assert.doesNotMatch(website, /Code paths complete|unverified on hardware/);
  assert.doesNotMatch(`${readme}\n${website}`, /—/);
});
