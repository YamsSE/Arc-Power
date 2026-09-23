import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('Dashboard utilization gauge draws exact clockwise SVG arcs for 0%, 50%, 59%, and 100%', () => {
  const dashboard = readFileSync(new URL('../src/renderer/pages/dashboard.ts', import.meta.url), 'utf8');
  const radius = dashboard.match(/const DASHBOARD_GAUGE_RADIUS = \d+;/)?.[0];
  const functions = dashboard.match(/function dashboardUtilizationPercent[\s\S]*?(?=\ntype DashboardPulseLane)/)?.[0];
  const helpers = radius && functions ? `${radius}\n${functions}` : undefined;
  assert.ok(helpers, 'gauge helpers are present in the Dashboard renderer');
  const javascript = ts.transpile(helpers, { target: ts.ScriptTarget.ES2020 });
  const gauge = new Function(`${javascript}; return { percent: dashboardUtilizationPercent, path: dashboardUtilizationArcPath };`)();

  assert.equal(gauge.percent(-0.2), 0);
  assert.equal(gauge.percent(50.4), 50, 'display and path share the rounded integer');
  assert.equal(gauge.percent(58.6), 59, 'display and path share the rounded integer');
  assert.equal(gauge.percent(100.4), 100);
  assert.equal(gauge.path(0), 'M 52 10', '0% has no stroked segment');
  assert.equal(gauge.path(50), 'M 52 10 A 42 42 0 0 1 52.000 94.000', '50% ends exactly opposite the fixed top start');
  assert.equal(gauge.path(59), 'M 52 10 A 42 42 0 1 1 29.495 87.462', '59% sweeps 212.4 degrees, visibly beyond half');
  assert.equal(gauge.path(100), 'M 52 10 A 42 42 0 0 1 52 94 A 42 42 0 0 1 52 10', '100% uses two arcs to close the full circle');
});
