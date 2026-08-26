import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const website = fs.readFileSync(new URL('../website/index.html', import.meta.url), 'utf8');

test('support status documentation uses the verified GPU wording', () => {
  assert.match(readme, /\| Arc A3 \/ A5 \/ A7 series \(incl\. A770\) \| Alchemist \| \*\*Verified - Working\*\* \|/);
  assert.match(readme, /\| Arc B580 \/ B570 \| Battlemage \| \*\*Verified - Working\*\* \|/);
  assert.match(readme, /\| Arc Pro B50 \| Battlemage \(pro\) \| \*\*Verified - Tweaks & Telemetry only\*\* \|/);
  assert.match(readme, /\| Arc iGPU \| Alchemist & Battlemage \| \*\*Verified - Tweaks & Telemetry only\*\* \|/);
  assert.match(readme, /- \[x\] Battlemage enablement \(live verification on B580 \/ B570\)/);
  assert.doesNotMatch(readme, /Code paths complete, unverified on hardware/);

  assert.match(website, /<span class="chip chip-ok">Verified<span class="chip-sub">Working<\/span><\/span>/g);
  assert.match(website, /<span class="chip chip-ok">Verified<span class="chip-sub">Tweaks &amp; Telemetry only<\/span><\/span>/g);
  assert.doesNotMatch(website, /Code paths complete|unverified on hardware/);
});
