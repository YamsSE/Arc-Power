// M2b — tray tests: the embedded icon decodes to a valid 32x32 PNG (no
// electron needed) and the menu template contains the expected items.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRAY_ICON_DATA_URL, decodeTrayIcon, buildTrayMenuTemplate,
  TRAY_LABEL_TOGGLE, TRAY_LABEL_APPLY_PROFILE, TRAY_LABEL_QUIT,
  trayBalloonProfileFailed, trayBalloonProfileRefused, trayBalloonForOutcome,
  trayToggleAction,
} from '../src/main/tray.js';

test('tray icon: data URL is a valid 32x32 PNG with real bytes', () => {
  assert.ok(TRAY_ICON_DATA_URL.startsWith('data:image/png;base64,'));
  const icon = decodeTrayIcon();
  assert.equal(icon.width, 32);
  assert.equal(icon.height, 32);
  assert.ok(icon.bytes > 100, `icon is suspiciously small (${icon.bytes} bytes)`);
});

test('tray menu: Show/Hide + Quit always present; Apply active profile only when one exists', () => {
  const withProfile = buildTrayMenuTemplate({
    hasActiveProfile: true,
    onToggle: () => {}, onApplyProfile: () => {}, onQuit: () => {},
  });
  assert.deepEqual(withProfile.map((i) => i.label), [TRAY_LABEL_TOGGLE, TRAY_LABEL_APPLY_PROFILE, TRAY_LABEL_QUIT]);
  assert.ok(withProfile.every((i) => i.enabled === true));
  assert.ok(withProfile.every((i) => typeof i.click === 'function'));

  const withoutProfile = buildTrayMenuTemplate({
    hasActiveProfile: false,
    onToggle: () => {}, onApplyProfile: () => {}, onQuit: () => {},
  });
  assert.deepEqual(withoutProfile.map((i) => i.label), [TRAY_LABEL_TOGGLE, TRAY_LABEL_QUIT]);
});

test('tray menu: clicks are wired to the callbacks', () => {
  const clicks = [];
  const template = buildTrayMenuTemplate({
    hasActiveProfile: true,
    onToggle: () => clicks.push('toggle'),
    onApplyProfile: () => clicks.push('apply'),
    onQuit: () => clicks.push('quit'),
  });
  for (const item of template) item.click();
  assert.deepEqual(clicks, ['toggle', 'apply', 'quit']);
});

test('tray balloon: exact failure text carries the profile name', () => {
  assert.equal(
    trayBalloonProfileFailed('Game Boost'),
    "Arc Power: profile 'Game Boost' failed to apply — defaults restored",
  );
});

// M2b review F1 — the balloon outcome map: "defaults restored" ONLY when a
// restore actually ran; refusals get a reason-specific message; success
// balloons nothing.
test('tray balloon: an applied outcome balloons nothing (no false claims)', () => {
  assert.equal(trayBalloonForOutcome({ applied: true, reason: '' }, 'Game Boost'), null);
});

test('tray balloon: claims "defaults restored" only when a restore actually ran', () => {
  const out = { applied: false, reason: 'apply failed; defaults restored', fallbackApplied: true };
  assert.equal(trayBalloonForOutcome(out, 'Game Boost'), trayBalloonProfileFailed('Game Boost'));
});

test('tray balloon: a gate refusal shows the reason, never "defaults restored"', () => {
  for (const reason of ['Start-at-boot is disabled', 'Waiver not accepted', 'waiver not accepted on the device']) {
    const content = trayBalloonForOutcome({ applied: false, reason }, 'Game Boost');
    assert.equal(content, trayBalloonProfileRefused(reason));
    assert.ok(!content.includes('defaults restored'), content);
  }
});

// M4-D Round-1 F5 — the tray toggle branch fix: a MINIMIZED window reports
// isVisible() === true, so the old visibility-only toggle would hide a
// minimized window instead of restoring it (a start-minimized session could
// never be restored from the tray). The minimize case must win.
test('M4-D (F5): the tray toggle RESTORES a minimized window before any visibility toggle', () => {
  assert.equal(trayToggleAction({ isMinimized: true, isVisible: true }), 'restore');
  assert.equal(trayToggleAction({ isMinimized: true, isVisible: false }), 'restore');
});

test('M4-D (F5): a visible non-minimized window toggles to hidden; a hidden one shows', () => {
  assert.equal(trayToggleAction({ isMinimized: false, isVisible: true }), 'hide');
  assert.equal(trayToggleAction({ isMinimized: false, isVisible: false }), 'show');
});
