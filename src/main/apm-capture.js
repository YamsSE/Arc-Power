import koffi from 'koffi';

// APM is deliberately reduced to counts and timestamps.  We never retain the
// key/button identity or its value, so the capture can answer "how active was
// the session?" without becoming an input logger.
const DEFAULT_POLL_MS = 100;
const SAMPLE_MS = 1000;
const MAX_EVENTS = 120_000;
const MAX_SAMPLES = 86_400;
const VK_CODES = Object.freeze([
  1, 2, 4, 5, 6, // mouse buttons
  ...Array.from({ length: 248 }, (_, index) => index + 8),
]);

function finiteMs(value, fallback = 0) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback;
}

function apmFromEvents(events, nowMs, windowMs = 60_000) {
  const cutoff = Math.max(0, nowMs - windowMs);
  let first = nowMs;
  let count = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const atMs = events[index];
    if (atMs < cutoff) break;
    count += 1;
    first = atMs;
  }
  const span = Math.max(1000, Math.min(windowMs, nowMs - first));
  return Math.max(0, Math.min(6000, Math.round((count * 60_000) / span)));
}

function safeReadPressed(readKey, vk) {
  try { return (Number(readKey(vk)) & 0x8000) !== 0; } catch { return false; }
}

/**
 * Capture session-local action-rate samples.  The native default uses
 * GetAsyncKeyState only to detect transitions; tests can inject readKey and a
 * clock, and non-Windows environments degrade to an honest unavailable source.
 */
export function createApmCapture({
  enabled = process.platform === 'win32',
  load = (name) => koffi.load(name),
  readKey = null,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  clock = () => Date.now(),
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  let read = readKey;
  let timer = null;
  const sessions = new Map();

  const ensureReader = () => {
    if (read || !enabled) return read;
    try {
      const user32 = load('user32.dll');
      read = user32.func('GetAsyncKeyState', 'int16', ['int32']);
    } catch {
      read = null;
    }
    return read;
  };

  const prune = (session, nowMs) => {
    if (!session) return;
    const cutoff = Math.max(0, nowMs - 60_000);
    while (session.events.length > 0 && (session.events.length > MAX_EVENTS || session.events[0] < cutoff)) session.events.shift();
    if (session.samples.length > MAX_SAMPLES) session.samples.splice(0, session.samples.length - MAX_SAMPLES);
  };

  const sample = (session, now = clock()) => {
    if (!session || session.sourceReady !== true) return null;
    const elapsed = finiteMs(now - session.startedAt);
    const apm = apmFromEvents(session.events, elapsed);
    const last = session.samples[session.samples.length - 1];
    if (!last || elapsed - last.atMs >= SAMPLE_MS) session.samples.push({ atMs: elapsed, apm });
    prune(session, elapsed);
    return { atMs: elapsed, apm };
  };

  const poll = () => {
    const now = clock();
    const reader = ensureReader();
    for (const session of sessions.values()) {
      session.sourceReady = Boolean(reader);
      const elapsed = finiteMs(now - session.startedAt);
      if (reader) {
        for (const vk of VK_CODES) {
          const pressed = safeReadPressed(reader, vk);
          if (pressed && !session.pressed.has(vk)) session.events.push(elapsed);
          if (pressed) session.pressed.add(vk);
          else session.pressed.delete(vk);
        }
      }
      sample(session, now);
    }
  };

  const stopTimer = () => {
    if (timer === null) return;
    clearIntervalFn(timer);
    timer = null;
  };

  return {
    start(sessionId, startedAt = clock()) {
      stopTimer();
      const next = {
        sessionId: typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null,
        startedAt: Number.isFinite(startedAt) ? startedAt : clock(),
        events: [],
        samples: [],
        pressed: new Set(),
        sourceReady: Boolean(read || (enabled && ensureReader())),
      };
      sessions.set(next.sessionId ?? `session:${startedAt}`, next);
      if (enabled) {
        timer = setIntervalFn(poll, Math.max(25, Math.round(pollMs)));
        timer?.unref?.();
      }
      return next.sessionId;
    },
    stop(sessionId = null) {
      const session = sessionId ? sessions.get(sessionId) : [...sessions.values()][0];
      if (!session) return null;
      sample(session, clock());
      const result = session;
      sessions.delete(session.sessionId ?? [...sessions.keys()].find((key) => sessions.get(key) === session));
      if (sessions.size === 0) stopTimer();
      return result;
    },
    snapshot(sessionId = null) {
      const session = sessionId ? sessions.get(sessionId) : [...sessions.values()][0];
      if (!session) return null;
      sample(session, clock());
      return session;
    },
    getInterval(sessionId, sourceStartMs = 0, sourceEndMs = Number.MAX_SAFE_INTEGER) {
      const session = sessionId ? sessions.get(sessionId) : [...sessions.values()][0];
      if (!session) return null;
      sample(session, clock());
      const start = finiteMs(sourceStartMs);
      const end = Math.max(start, finiteMs(sourceEndMs, Number.MAX_SAFE_INTEGER));
      const samples = session.samples
        .filter((item) => item.atMs >= start && item.atMs <= end)
        .map((item) => ({ atMs: item.atMs - start, apm: item.apm }));
      if (!samples.length) return { sessionId: session.sessionId, samples: [], averageApm: null, peakApm: null };
      const values = samples.map((item) => item.apm);
      return {
        sessionId: session.sessionId,
        samples,
        averageApm: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
        peakApm: Math.max(...values),
      };
    },
    dispose() { stopTimer(); sessions.clear(); },
  };
}

export { apmFromEvents };
