// M2a — renderer pure logic: OcErrorCode -> user-facing message mapping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage, CONTROL_LABELS } from '../src/renderer/pure/errors.ts';
import type { OcErrorCode } from '../src/renderer/types.ts';

test('errorMessage: every OcErrorCode has a clear, non-empty message', () => {
  const codes: OcErrorCode[] = [
    'waiver-not-set', 'out-of-range', 'locked-mode', 'reset-required',
    'unsupported', 'unavailable-symbol', 'io-failed',
  ];
  for (const code of codes) {
    const msg = errorMessage(code);
    assert.ok(msg.length > 20, `${code} message must be informative`);
  }
});

test('errorMessage: each message is distinct and mentions the actionable cause', () => {
  assert.match(errorMessage('waiver-not-set'), /waiver/i);
  assert.match(errorMessage('out-of-range'), /range/i);
  assert.match(errorMessage('locked-mode'), /lock/i);
  assert.match(errorMessage('reset-required'), /reset/i);
  assert.match(errorMessage('unsupported'), /not supported/i);
  assert.match(errorMessage('io-failed'), /read-back|driver|busy/i);
});

test('errorMessage: prefixed with the control label when a control is given', () => {
  const msg = errorMessage('out-of-range', 'powerLimitW');
  assert.ok(msg.startsWith('Power limit:'));
  assert.equal(CONTROL_LABELS.powerLimitW, 'Power limit');
  assert.equal(CONTROL_LABELS.tempLimitC, 'Temperature limit');
});

test('errorMessage: unknown control keys fall back to the raw key', () => {
  assert.ok(errorMessage('unsupported', 'mysteryControl').startsWith('mysteryControl:'));
});

test('errorMessage: no error code yields an empty string (success is not an error)', () => {
  assert.equal(errorMessage(undefined), '');
});
