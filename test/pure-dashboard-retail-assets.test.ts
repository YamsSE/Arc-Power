import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashboardRetailAssetPath } from '../src/renderer/pure/dashboard-retail-assets.ts';
import { aibOf } from '../src/renderer/pure/aib.ts';

const path = (name: string) => `../assets/dashboard/gpu/${name}.png`;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('dashboard retail assets route distinct Intel Arc families and compact/pro portraits', () => {
  assert.equal(dashboardRetailAssetPath({ name: 'Intel Arc A750', gpuVendor: 'intel' }), path('intel-arc-a750'));
  assert.equal(dashboardRetailAssetPath({ name: 'Intel Arc A770', gpuVendor: 'intel' }), path('intel-arc-a770'));
  assert.equal(dashboardRetailAssetPath({ name: 'Intel Arc A310', gpuVendor: 'intel' }), path('intel-arc-a310-a380-reference'));
  assert.equal(dashboardRetailAssetPath({ name: 'Intel Arc A380', gpuVendor: 'intel' }), path('intel-arc-a310-a380-reference'));
  assert.equal(dashboardRetailAssetPath({ name: 'Intel Arc Pro A60', gpuVendor: 'intel' }), path('intel-arc-pro-reference'));
  assert.equal(dashboardRetailAssetPath({ name: 'Intel(R) Arc(TM) Pro B50 Graphics', gpuVendor: 'intel' }), path('intel-arc-pro-reference'));
});

test('dashboard retail assets keep Intel Arc iGPUs on the Intel chip portrait', () => {
  assert.equal(dashboardRetailAssetPath({ name: 'Intel Arc Graphics', gpuVendor: 'intel', integrated: true }), path('intel-igpu-chip'));
  assert.equal(dashboardRetailAssetPath({ name: 'Intel UHD Graphics', gpuVendor: 'intel' }), path('intel-igpu-chip'));
  assert.equal(dashboardRetailAssetPath({ name: 'Intel(R) Arc(TM) Graphics', gpuVendor: 'intel' }), path('intel-igpu-chip'));
  assert.equal(dashboardRetailAssetPath({ name: 'Intel Arc B370 Graphics', gpuVendor: 'intel' }), path('intel-igpu-chip'));
});

test('dashboard retail assets route B570 by known AIB vendor without inventing an unknown portrait', () => {
  const base = { name: 'Intel Arc B570', gpuVendor: 'intel' };
  assert.equal(dashboardRetailAssetPath(base), null);
  assert.equal(dashboardRetailAssetPath({ ...base, aibVendor: 'Acer' }), path('intel-arc-b570-acer'));
  assert.equal(dashboardRetailAssetPath({ ...base, aibVendor: 'ASRock' }), path('intel-arc-b570-asrock'));
  assert.equal(dashboardRetailAssetPath({ ...base, aibVendor: 'Sparkle' }), path('intel-arc-b570-sparkle'));
  assert.equal(dashboardRetailAssetPath({ ...base, aibVendor: 'Acer', aibModel: 'ASRock Phantom Gaming' }), path('intel-arc-b570-acer'));
  assert.equal(dashboardRetailAssetPath({ name: 'Intel Arc B580', gpuVendor: 'intel' }), path('intel-arc-b580'));
});

test('Sparkle subsystem vendor identity feeds only the dashboard portrait route', () => {
  assert.equal(aibOf(0x172f, 0), null);
  assert.equal(dashboardRetailAssetPath({ name: 'Intel Arc B570', gpuVendor: 'intel', aibVendorId: 0x172f }), path('intel-arc-b570-sparkle'));
});

test('dashboard retail assets route RTX tiers and preserve generic NVIDIA fallback', () => {
  for (const [model, asset] of [
    ['NVIDIA GeForce RTX 2080 Ti', 'nvidia-rtx-2080-reference'],
    ['NVIDIA GeForce RTX 2070 Super', 'nvidia-rtx-2070-reference'],
    ['NVIDIA GeForce RTX 3080', 'nvidia-rtx-3080-reference'],
    ['NVIDIA GeForce RTX 3070', 'nvidia-rtx-3070-reference'],
    ['NVIDIA GeForce RTX 4080', 'nvidia-rtx-4080-reference'],
    ['NVIDIA GeForce RTX 4070', 'nvidia-rtx-4070-reference'],
    ['NVIDIA GeForce RTX 5080', 'nvidia-rtx-5080-reference'],
    ['NVIDIA GeForce RTX 5070', 'nvidia-rtx-5070-reference'],
  ] as const) {
    assert.equal(dashboardRetailAssetPath({ name: model, gpuVendor: 'nvidia' }), path(asset));
  }
  assert.equal(dashboardRetailAssetPath({ name: 'NVIDIA GeForce RTX 5090', gpuVendor: 'nvidia' }), path('nvidia-rtx-reference'));
  assert.equal(dashboardRetailAssetPath({ name: 'NVIDIA GeForce GTX 1080', gpuVendor: 'nvidia' }), path('nvidia-gtx-reference'));
});

test('dashboard retail assets keep AMD integrated/mobile portraits separate', () => {
  assert.equal(dashboardRetailAssetPath({ name: 'AMD Radeon(TM) Graphics', gpuVendor: 'amd', integrated: true }), path('amd-radeon-igpu-chip'));
  assert.equal(dashboardRetailAssetPath({ name: 'AMD Radeon 780M', gpuVendor: 'amd', mobile: true }), path('amd-radeon-mobile-module'));
  assert.equal(dashboardRetailAssetPath({ name: 'AMD Radeon RX 7800 XT', gpuVendor: 'amd' }), path('amd-radeon-rx-7000-9000-reference'));
  assert.equal(dashboardRetailAssetPath({ name: 'Unknown Graphics', gpuVendor: 'amd' }), null);
});

test('dashboard retail assets preserve unknown and generic fallbacks', () => {
  assert.equal(dashboardRetailAssetPath({ name: 'Intel Arc Unknown', gpuVendor: 'intel', integrated: false }), path('intel-arc-a770'));
  assert.equal(dashboardRetailAssetPath({ name: 'Mystery GPU', gpuVendor: 'unknown' }), null);
  assert.equal(dashboardRetailAssetPath({ name: 'AMD Radeon Vega 8', gpuVendor: 'amd' }), path('amd-radeon-vega-reference'));
});

test('dashboard retail portraits share the B580/A770 display box', () => {
  const css = readFileSync(join(repoRoot, 'src/renderer/styles.css'), 'utf8');
  assert.match(css, /\.dashboard-retail-art-asset\s*\{[^}]*width:\s*min\(100%,\s*300px\);[^}]*height:\s*180px;[^}]*object-fit:\s*contain;/s);
  for (const asset of [
    'intel-arc-a750',
    'intel-arc-a770',
    'intel-arc-b580',
    'intel-arc-pro-reference',
    'intel-arc-b570-acer',
    'intel-arc-b570-asrock',
    'intel-arc-b570-sparkle',
    'intel-igpu-chip',
    'amd-radeon-igpu-chip',
    'amd-radeon-mobile-module',
    'nvidia-rtx-2070-reference',
    'nvidia-rtx-5080-reference',
  ]) {
    assert.equal(existsSync(join(repoRoot, 'src/assets/dashboard/gpu', `${asset}.png`)), true, asset);
  }
});
