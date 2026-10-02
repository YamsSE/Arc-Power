import test from 'node:test';
import assert from 'node:assert/strict';
import { moveVfPoint, rebaseVfCurveToReference, matchesVfCurveReference, prepareVfCurveForDriver } from '../src/renderer/pure/vf-curve.ts';
const range = {voltageMinV: .4, voltageMaxV: 1.5, freqMinMhz: 0, freqMaxMhz: 4300, voltageStepV: .001, maxPoints: 32};
const saved = Array.from({length:10}, (_,i)=>({voltageV: .6+i*.05, freqMhz: 500+i*300}));
test('every integer MHz preserves requested propagated frequencies through positive and negative 100mV drift',()=>{
 for(let i=0;i<10;i++) for(let f=0;f<=4300;f++) for(const shift of [-.1,.1]) {
  const draft=moveVfPoint(saved,i,saved[i].voltageV,f,range);
  const fresh=saved.map(p=>({...p,voltageV:p.voltageV+shift}));
  const rebased=rebaseVfCurveToReference(draft,saved,fresh,range);
  assert.ok(rebased); assert.deepEqual(rebased.map(p=>p.freqMhz),draft.map(p=>p.freqMhz));
  rebased.forEach((p,j)=>assert.ok(Math.abs(p.voltageV-draft[j].voltageV-shift)<1e-8));
 }
});
test('every integer mV preserves explicit voltage edits or refuses range overflow',()=>{
 for(let i=0;i<10;i++) for(let mv=400;mv<=1500;mv++) for(const shift of [-.1,.1]) {
  const draft=moveVfPoint(saved,i,mv/1000,saved[i].freqMhz,range);
  const fresh=saved.map(p=>({...p,voltageV:p.voltageV+shift}));
  const rebased=rebaseVfCurveToReference(draft,saved,fresh,range);
  const expected=prepareVfCurveForDriver(draft.map(p=>({...p,voltageV:Number((p.voltageV+shift).toFixed(9))})),range);
  assert.deepEqual(rebased,expected);
 }
});
test('reference permits only translation and preserves exact frequency identities',()=>{
 const changed=saved.map(p=>({...p})); changed[5].freqMhz+=1;
 assert.equal(matchesVfCurveReference(saved,changed),false); changed[5].freqMhz-=1; changed[5].voltageV+=.001;
 assert.equal(matchesVfCurveReference(saved,changed),false);
 assert.equal(matchesVfCurveReference([],[]),false);
});
