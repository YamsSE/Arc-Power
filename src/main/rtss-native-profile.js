// Adapter for the native RTSS profile controller. In normal Tauri runs the
// host owns RTSSHooks profile/limiter access; Electron keeps the same public
// surface so Graphics and Arc Sleep do not branch on the host implementation.
const METHODS = Object.freeze({
  apply: 'rtss-profile-apply',
  getFrameLimit: 'rtss-frame-limit-get',
  getFrameLimitOwnership: 'rtss-frame-limit-ownership',
  applyFrameLimit: 'rtss-frame-limit-apply',
  restoreFrameLimit: 'rtss-frame-limit-restore',
  restoreFrameLimitState: 'rtss-frame-limit-restore-state',
  ensureScreenSharpeningCompatibility: 'rtss-sharpening-compatibility',
});

const initialState = () => ({
  available: false,
  configured: false,
  renderingMode: 'unknown',
  executablePath: null,
  error: null,
});

const unavailable = (method, message) => {
  if (method === METHODS.apply) return { ...initialState(), error: message };
  if (method === METHODS.getFrameLimit) {
    return { ok: false, available: false, source: 'igcl', error: message };
  }
  if (method === METHODS.getFrameLimitOwnership) {
    return { ok: false, errorCode: 'unavailable', error: message };
  }
  if (method === METHODS.applyFrameLimit || method === METHODS.restoreFrameLimit) {
    return { ok: false, used: false, available: false, errorCode: 'unavailable', source: 'rtss', error: message };
  }
  if (method === METHODS.restoreFrameLimitState) {
    return { ok: false, errorCode: 'unavailable', source: 'rtss', error: message };
  }
  if (method === METHODS.ensureScreenSharpeningCompatibility) {
    return { ok: false, available: false, configured: false, error: message };
  }
  return { ok: false, used: false, available: false, errorCode: 'unavailable', source: 'rtss', error: message };
};

export function createNativeRtssProfileProxy(request) {
  if (typeof request !== 'function') throw new TypeError('Native RTSS profile proxy requires a request function');
  const call = async (method, args) => {
    try {
      return await request(method, args);
    } catch (error) {
      return unavailable(method, error instanceof Error ? error.message : String(error));
    }
  };
  return {
    apply: (options = {}) => call(METHODS.apply, [options]),
    getFrameLimit: (options = {}) => call(METHODS.getFrameLimit, [options]),
    getFrameLimitOwnership: () => call(METHODS.getFrameLimitOwnership, []),
    applyFrameLimit: (options = {}) => call(METHODS.applyFrameLimit, [options]),
    restoreFrameLimit: (token = null) => call(METHODS.restoreFrameLimit, [token]),
    restoreFrameLimitState: (options = {}) => call(METHODS.restoreFrameLimitState, [options]),
    ensureScreenSharpeningCompatibility: () => call(METHODS.ensureScreenSharpeningCompatibility, []),
    close: () => {},
  };
}
