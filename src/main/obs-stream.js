import crypto from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 8_000;

function id() { return crypto.randomUUID(); }
function authResponse(password, salt, challenge) {
  const secret = crypto.createHash('sha256').update(`${password}${salt}`).digest('base64');
  return crypto.createHash('sha256').update(`${secret}${challenge}`).digest('base64');
}

export function createObsStreamService({ WebSocketImpl = globalThis.WebSocket, passwordProvider = async () => null, passwordSink = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS, now = () => Date.now() } = {}) {
  let socket = null;
  let state = 'disconnected';
  let requestSeq = 0;
  const pending = new Map();
  let settings = { host: '127.0.0.1', port: 4455, protocol: 'ws', sceneId: null, sceneName: null, microphoneInputId: null, ducking: { enabled: false, targetInputId: null, attenuationDb: 12, attackMs: 100, releaseMs: 300, originalVolume: null, appliedVolume: null } };
  let duckingVolume = null;
  let sessionPassword = null;
  const publish = () => ({ state, connected: state === 'connected' || state === 'streaming', sceneName: settings.sceneName, sceneId: settings.sceneId, microphoneMuted: null, error: null });
  const failPending = (error) => { for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); } pending.clear(); };
  const closeSocket = () => { try { socket?.close?.(); } catch {} socket = null; failPending(new Error('OBS disconnected')); state = 'disconnected'; };
  const request = (requestType, requestData = {}) => new Promise((resolve, reject) => {
    if (!socket || (state !== 'connected' && state !== 'streaming')) return reject(new Error('OBS is not connected'));
    const requestId = `${++requestSeq}-${id()}`;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`OBS request timed out: ${requestType}`)); }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
  });
  const handle = async (message) => {
    let payload; try { payload = JSON.parse(typeof message === 'string' ? message : String(message?.data ?? message)); } catch { return; }
    if (payload.op === 0) {
      const hello = payload.d ?? {};
      const password = sessionPassword ?? await passwordProvider();
      const identify = { rpcVersion: 1 };
      if (hello.authentication) identify.authentication = authResponse(password ?? '', hello.authentication.salt, hello.authentication.challenge);
      socket?.send(JSON.stringify({ op: 1, d: identify }));
    } else if (payload.op === 2) { state = 'connected'; }
    else if (payload.op === 7) {
      const item = pending.get(payload.d?.requestId); if (!item) return;
      pending.delete(payload.d.requestId); clearTimeout(item.timer);
      if (payload.d?.requestStatus?.result === false) item.reject(new Error(payload.d.requestStatus.comment || 'OBS request failed'));
      else item.resolve(payload.d.responseData ?? {});
    }
  };

  return {
    configure(next = {}) { settings = { ...settings, ...next, ducking: { ...settings.ducking, ...(next.ducking ?? {}) } }; return { ...settings, password: undefined }; },
    status() { return publish(); },
    async connect(next = {}) {
      if (typeof next.password === 'string' && next.password.length <= 512) { sessionPassword = next.password; passwordSink(sessionPassword); }
      this.configure(next);
      if (!WebSocketImpl) { state = 'error'; throw new Error('OBS WebSocket is unavailable in this runtime'); }
      closeSocket(); state = 'connecting';
      await new Promise((resolve, reject) => {
        const url = `${settings.protocol || 'ws'}://${settings.host || '127.0.0.1'}:${Number(settings.port) || 4455}`;
        try { socket = new WebSocketImpl(url); } catch (error) { state = 'error'; reject(error); return; }
        const timer = setTimeout(() => { closeSocket(); state = 'error'; reject(new Error('OBS connection timed out')); }, timeoutMs);
        socket.onopen = () => { clearTimeout(timer); resolve(); };
        socket.onmessage = (event) => { void handle(event); };
        socket.onerror = () => { clearTimeout(timer); state = 'error'; reject(new Error('OBS connection failed')); };
        socket.onclose = () => { clearTimeout(timer); if (state !== 'error') state = 'disconnected'; failPending(new Error('OBS disconnected')); };
      });
      await request('GetCurrentProgramScene').then((data) => { settings.sceneId = data.sceneUuid ?? null; settings.sceneName = data.sceneName ?? null; }).catch(() => {});
      state = 'connected'; return publish();
    },
    async disconnect() { await this.restoreDucking().catch(() => {}); closeSocket(); return publish(); },
    async scenes() { const data = await request('GetSceneList'); return Array.isArray(data.scenes) ? data.scenes.map((scene) => ({ id: scene.sceneUuid, name: scene.sceneName })) : []; },
    async setScene(sceneId, sceneName = null) { const data = {}; if (sceneId) data.sceneUuid = sceneId; else if (sceneName) data.sceneName = sceneName; await request('SetCurrentProgramScene', data); settings.sceneId = sceneId ?? null; settings.sceneName = sceneName ?? null; return publish(); },
    async startStream() { await request('StartStream'); state = 'streaming'; return publish(); },
    async stopStream() { await this.restoreDucking(); await request('StopStream'); state = 'connected'; return publish(); },
    async setMicrophoneMute(inputId, muted) { const idValue = inputId ?? settings.microphoneInputId; if (!idValue) throw new Error('Choose an OBS microphone input first'); await request('SetInputMute', { inputUuid: idValue, inputMuted: muted === true }); return { muted: muted === true }; },
    async duck() {
      const d = settings.ducking ?? {}; if (!d.enabled || !d.targetInputId) return { applied: false };
      const volume = await request('GetInputVolume', { inputUuid: d.targetInputId });
      duckingVolume = Number(volume.inputVolumeDb); if (!Number.isFinite(duckingVolume)) throw new Error('OBS did not return a valid input volume');
      const appliedVolume = Math.max(-100, Math.min(26, duckingVolume - Math.max(0, Math.min(60, Number(d.attenuationDb) || 0))));
      await request('SetInputVolume', { inputUuid: d.targetInputId, inputVolumeDb: appliedVolume, inputVolumeMul: 1 });
      d.originalVolume = duckingVolume; d.appliedVolume = appliedVolume; return { applied: true, originalVolume: duckingVolume, appliedVolume };
    },
    async restoreDucking() {
      const d = settings.ducking ?? {}; if (!d.targetInputId || !Number.isFinite(duckingVolume)) return { restored: false };
      try { await request('SetInputVolume', { inputUuid: d.targetInputId, inputVolumeDb: duckingVolume, inputVolumeMul: 1 }); d.appliedVolume = null; const original = duckingVolume; duckingVolume = null; return { restored: true, originalVolume: original }; }
      catch (error) { return { restored: false, error: error.message }; }
    },
  };
}

export { authResponse };
