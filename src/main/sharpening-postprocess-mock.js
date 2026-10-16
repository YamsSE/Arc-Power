// Source mock/UI verification only: never downloads or writes game files.
export function createMockPostprocessSharpening() {
  let value = { enabled: false, percentage: 50 };
  let runtimeReady = true;
  const games = new Map();
  const game = (exePath) => {
    const row = games.get(exePath);
    return { installed: !!row, value: { ...(row?.override ?? value) }, globalValue: { ...value },
      override: row?.override ? { ...row.override } : null, mode: row ? 'direct' : null };
  };
  const global = () => ({ value: { ...value }, managedGameCount: games.size,
    runtimeReady, provider: 'reshade', requiresRestart: true });
  return {
    async getGlobal() { return global(); },
    async setGlobal(next) { value = { ...next }; return global(); },
    async getGame(exePath) { return game(exePath); },
    async install(exePath) {
      runtimeReady = true;
      if (!games.has(exePath)) games.set(exePath, { override: null });
      return game(exePath);
    },
    async setGame(exePath, override) {
      if (!games.has(exePath)) throw new Error('Set up sharpening for this game first.');
      games.set(exePath, { override: override ? { ...override } : null });
      return game(exePath);
    },
    async remove(exePath) { games.delete(exePath); return game(exePath); },
  };
}
