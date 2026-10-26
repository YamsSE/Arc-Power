import test from 'node:test';
import assert from 'node:assert/strict';
import { getSplashPresentation } from '../src/main/splash-presentation.js';

function createFakeSplash() {
  const calls = [];
  const splash = {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    setSkipTaskbar(value) { calls.push(['setSkipTaskbar', value]); },
    show() { calls.push(['show']); },
    focus() { calls.push(['focus']); },
  };
  return { splash, calls };
}

test('an early available status is presented once after both window and content are ready', () => {
  const { splash, calls } = createFakeSplash();
  const presentation = getSplashPresentation(splash);
  presentation.setStatus({ state: 'available' });
  presentation.windowReady();
  assert.deepEqual(calls, []);
  presentation.contentReady();
  presentation.setStatus({ state: 'available' });
  assert.deepEqual(calls, [['setSkipTaskbar', false], ['show'], ['focus']]);
});

test('a late available status promotes the already ready passive splash', () => {
  const { splash, calls } = createFakeSplash();
  const presentation = getSplashPresentation(splash);
  presentation.windowReady();
  presentation.contentReady();
  presentation.setStatus({ state: 'checking' });
  presentation.setStatus({ state: 'error' });
  assert.deepEqual(calls, []);
  presentation.setStatus({ state: 'available' });
  assert.deepEqual(calls, [['setSkipTaskbar', false], ['show'], ['focus']]);
});

test('availability does not present after close or destruction', () => {
  const closed = createFakeSplash();
  const closedPresentation = getSplashPresentation(closed.splash);
  closedPresentation.close();
  closedPresentation.windowReady();
  closedPresentation.contentReady();
  closedPresentation.setStatus({ state: 'available' });
  assert.deepEqual(closed.calls, []);

  const destroyed = createFakeSplash();
  const destroyedPresentation = getSplashPresentation(destroyed.splash);
  destroyed.splash.destroyed = true;
  destroyedPresentation.windowReady();
  destroyedPresentation.contentReady();
  destroyedPresentation.setStatus({ state: 'available' });
  assert.deepEqual(destroyed.calls, []);
});
