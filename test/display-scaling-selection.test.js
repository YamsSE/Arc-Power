import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rawScalingForView,
  customScalingPreferenceOf,
  scalingMethodOptionsForView,
  scalingMethodViewOf,
  scalingModeViewOptionsForDisplay,
  scalingViewOf,
} from '../src/renderer/pure/display.ts';

function display(overrides = {}) {
  return {
    scalingMode: 'identity',
    preferredScalingMode: 'aspect-ratio-centered-max',
    scalingPreference: 'gpu-scaling',
    scalingMethod: { value: { enabled: false, method: 'integer' }, controllable: true },
    supportedOptions: {
      scalingModes: ['identity', 'centered', 'stretched', 'aspect-ratio-centered-max', 'custom'],
      scalingMethods: [],
    },
    ...overrides,
  };
}

test('GPU preference and supported method survive Identity readback and reload', () => {
  const current = display();
  assert.equal(scalingViewOf(current), 'gpu-scaling');
  assert.equal(scalingMethodViewOf(current), 'aspect-ratio-centered-max');
  assert.deepEqual(scalingModeViewOptionsForDisplay(current), ['gpu-scaling', 'display-scaling']);
});

test('explicit Display preference overrides a stale preferred GPU mode', () => {
  const current = display({ scalingPreference: 'display-scaling', scalingPreferenceSource: 'arc-selection' });
  assert.equal(scalingViewOf(current), 'display-scaling');
  assert.equal(scalingMethodViewOf(current), 'maintain-display-scaling');
});

test('active Custom overrides stale preferred GPU mode while native GPU preference survives Display Identity', () => {
  const activeCustom = display({
    scalingMode: 'custom',
    scalingPreferenceSource: 'igcl-preferred',
    scalingDetails: { customX: 16, customY: 95, hardwareModeSet: true, preferredScalingType: 'aspect-ratio-centered-max' },
  });
  assert.equal(scalingViewOf(activeCustom), 'display-scaling');
  assert.equal(scalingMethodViewOf(activeCustom), 'custom');
  assert.deepEqual(customScalingPreferenceOf(activeCustom), { x: 16, y: 95 });

  const nativePreferred = display({
    scalingMode: 'identity',
    preferredScalingMode: 'aspect-ratio-centered-max',
    scalingPreference: 'gpu-scaling',
    scalingPreferenceSource: 'igcl-preferred',
  });
  assert.equal(scalingViewOf(nativePreferred), 'gpu-scaling');
  assert.equal(scalingMethodViewOf(nativePreferred), 'aspect-ratio-centered-max');
});

test('GPU method resolution preserves a current supported choice', () => {
  const current = display({ scalingMode: 'centered', preferredScalingMode: 'centered' });
  assert.equal(scalingMethodViewOf(current), 'centered');
  assert.equal(rawScalingForView(current, 'gpu-scaling'), 'centered');
});

test('unknown GPU method falls back only to a supported capability', () => {
  const current = display({
    preferredScalingMode: 'aspect-ratio-centered-max',
    supportedOptions: { scalingModes: ['identity', 'centered'], scalingMethods: ['integer'] },
  });
  assert.deepEqual(scalingMethodOptionsForView(current, 'gpu-scaling'), ['centered']);
  assert.equal(scalingMethodViewOf(current), 'centered');
  assert.equal(rawScalingForView(current, 'gpu-scaling'), 'centered');
});

test('Custom and enabled Retro selections retain their existing priority', () => {
  const custom = display({ scalingPreference: null, preferredScalingMode: 'custom' });
  assert.equal(scalingViewOf(custom), 'display-scaling');
  assert.equal(scalingMethodViewOf(custom), 'custom');

  const retro = display({
    scalingMethod: { value: { enabled: true, method: 'nearest-neighbour' }, controllable: true },
    supportedOptions: {
      scalingModes: ['identity', 'centered', 'stretched', 'aspect-ratio-centered-max', 'custom'],
      scalingMethods: ['integer', 'nearest-neighbour'],
    },
  });
  assert.equal(scalingViewOf(retro), 'retro-scaling');
  assert.equal(scalingMethodViewOf(retro), 'nearest-neighbour');
  assert.equal(rawScalingForView(retro, 'retro-scaling'), 'identity');
});

test('disabled Retro with null current method offers only supported methods', () => {
  const current = display({
    scalingMethod: { value: { enabled: false, method: null }, controllable: true },
    supportedOptions: {
      scalingModes: ['identity', 'centered'],
      scalingMethods: ['nearest-neighbour'],
    },
  });
  assert.deepEqual(scalingMethodOptionsForView(current, 'retro-scaling'), ['nearest-neighbour']);
  assert.ok(scalingModeViewOptionsForDisplay(current).includes('retro-scaling'));
  assert.equal(scalingMethodViewOf({ ...current, scalingPreference: 'display-scaling', scalingPreferenceSource: 'arc-selection' }), 'maintain-display-scaling');
});

test('enabled Retro with unknown null method remains read-only', () => {
  const current = display({
    scalingMethod: { value: { enabled: true, method: null }, controllable: true },
    supportedOptions: {
      scalingModes: ['identity', 'centered'],
      scalingMethods: ['integer', 'nearest-neighbour'],
    },
  });
  assert.equal(scalingViewOf(current), 'retro-scaling');
  assert.deepEqual(scalingMethodOptionsForView(current, 'retro-scaling'), []);
  assert.equal(scalingMethodViewOf(current), '');
  assert.ok(!scalingModeViewOptionsForDisplay(current).includes('retro-scaling'));
});

test('Custom editor uses 100/100 by default, then saved preference when native Custom is inactive', () => {
  const fresh = display({ scalingDetails: { customX: 0, customY: 0, hardwareModeSet: false, preferredScalingType: null } });
  assert.deepEqual(customScalingPreferenceOf(fresh), { x: 100, y: 100 });
  assert.deepEqual(customScalingPreferenceOf({
    ...fresh,
    customScalingPreference: { x: 95, y: 80 },
  }), { x: 95, y: 80 });
});
