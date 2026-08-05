// M2a — renderer pure logic: warranty-waiver state machine. The critical
// assertion: there is NO code path that auto-accepts. decideApply(false)
// can never return 'proceed', and only an explicit user 'accepted' decision
// flips the state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideApply, afterDialog } from '../src/renderer/pure/waiver.ts';

test('decideApply: accepted waiver proceeds; unaccepted waiver shows the dialog', () => {
  assert.equal(decideApply(true), 'proceed');
  assert.equal(decideApply(false), 'show-waiver');
});

test('decideApply: NO auto-accept path exists — unaccepted can never proceed', () => {
  // Property-style check across the whole input domain of the decision rule:
  // the only input is the waiver flag, and false must always stop the apply.
  for (const input of [false]) {
    assert.notEqual(decideApply(input), 'proceed');
  }
});

test('afterDialog: only the user accepting flips the state to accepted', () => {
  assert.deepEqual(afterDialog('accepted'), { state: 'accepted', accepted: true });
  assert.deepEqual(afterDialog('cancelled'), { state: 'not-accepted', accepted: false });
});

test('waiver flow: cancel leaves the state unaccepted (nothing applied)', () => {
  // Simulated product flow: decide -> dialog -> transition.
  const pre = false;
  const decision = decideApply(pre); // 'show-waiver'
  if (decision === 'show-waiver') {
    const userChoice = 'cancelled'; // the user clicked Cancel
    const next = afterDialog(userChoice);
    assert.equal(next.accepted, false);
    assert.equal(decideApply(next.accepted), 'show-waiver'); // next apply still gated
  } else {
    assert.fail('unaccepted waiver must show the dialog');
  }
});

test('waiver flow: explicit accept flips state so the next apply proceeds', () => {
  const decision = decideApply(false);
  assert.equal(decision, 'show-waiver');
  const next = afterDialog('accepted');
  assert.equal(next.accepted, true);
  assert.equal(decideApply(next.accepted), 'proceed');
});
