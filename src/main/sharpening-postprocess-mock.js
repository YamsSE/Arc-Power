// Source mock/UI verification only: never launches a capture helper or writes game files.
import { canonicalExePath } from './game-candidate.js';

export function createMockPostprocessSharpening() {
  let value = { enabled: false, percentage: 50 };
  let asrValue = { enabled: false };
  let runtimeStatus = { active: false, reason: null };
  const games = new Map();
  const statusListeners = new Set();
  const publishStatus = () => {
    for (const listener of statusListeners) listener({ ...runtimeStatus });
  };
  const global = () => ({ value: { ...value }, overrideCount: games.size,
    runtimeReady: true, provider: 'screen', requiresRestart: false, active: false,
    legacyIntegrations: [], legacyManifestStatus: 'clear' });
  const asr = () => ({ value: { ...asrValue }, runtimeReady: true, requiresRestart: false,
    active: runtimeStatus.active && runtimeStatus.mode === 'asr',
    ...(runtimeStatus.reason ? { reason: runtimeStatus.reason } : {}) });
  const game = (exePath) => {
    const key = canonicalExePath(exePath);
    const override = key ? games.get(key) ?? null : null;
    const source = override ?? value;
    const effective = { enabled: value.enabled && source.enabled && source.percentage > 0,
      percentage: value.enabled && source.enabled ? source.percentage : 0 };
    return { value: { ...effective }, globalValue: { ...value },
      override: override ? { ...override } : null, effective,
      legacyIntegration: null, legacyManifestStatus: 'clear' };
  };
  return {
    async start() { return global(); },
    async stop() { return global(); },
    async getGlobal() { return global(); },
    async getAsr() { return asr(); },
    subscribeStatus(listener) {
      statusListeners.add(listener);
      listener({ ...runtimeStatus });
      return () => statusListeners.delete(listener);
    },
    setRuntimeStatusForTest(status) {
      runtimeStatus = { active: status.active === true, reason: typeof status.reason === 'string' ? status.reason : null,
        ...(status.mode === 'asr' || status.mode === 'sharpening' ? { mode: status.mode } : {}) };
      publishStatus();
    },
    async setGlobal(next) { value = { ...next }; return global(); },
    async setAsr(next) { asrValue = { ...next }; return asr(); },
    async getGame(exePath) { return game(exePath); },
    async setGame(exePath, override) {
      const key = canonicalExePath(exePath);
      if (!key) throw new Error('Choose a valid game executable.');
      if (override === null) games.delete(key);
      else games.set(key, { ...override });
      return game(key);
    },
  };
}
