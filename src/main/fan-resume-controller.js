import { physicalTargetMatches, physicalTargetOf } from './gpu-inventory.js';

const FAN_KEYS = new Set(['fanMode', 'fanCurve', 'fixedFanPct']);

export function fanOnlySettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('fan-resume: invalid settings');
  if (Object.keys(settings).some((key) => !FAN_KEYS.has(key))) throw new Error('fan-resume: fan-only settings required');
  if (!['auto', 'curve', 'fixed'].includes(settings.fanMode)) throw new Error('fan-resume: invalid fan mode');
  const out = { fanMode: settings.fanMode };
  if (settings.fanMode === 'curve') {
    if (!Array.isArray(settings.fanCurve) || settings.fanCurve.length < 2 || settings.fanCurve.length > 32
      || !settings.fanCurve.every((p, index, points) => Number.isFinite(p?.t) && Number.isFinite(p?.speedPct)
        && p.t >= 0 && p.t <= 100 && p.speedPct >= 0 && p.speedPct <= 100 && (index === 0 || p.t > points[index - 1].t))) throw new Error('fan-resume: invalid curve');
    out.fanCurve = settings.fanCurve.map(({ t, speedPct }) => ({ t, speedPct }));
  }
  if (settings.fanMode === 'fixed') {
    if (!Number.isFinite(settings.fixedFanPct) || settings.fixedFanPct < 0 || settings.fixedFanPct > 100) throw new Error('fan-resume: invalid fixed speed');
    out.fixedFanPct = settings.fixedFanPct;
  }
  return out;
}

export function createFanResumeController({ backend, store, rawApplySettings, isElevated = () => false, applyRunner = null, onState = () => {}, onStatus = () => {}, delay = null, timers = [2000, 5000, 10000] } = {}) {
  const enabledKeys = new Set();
  const invalidKeys = new Set();
  const proofByKey = new Map();
  const targetRevisions = new Map();
  let stopped = false;
  let generation = 0;
  let queue = Promise.resolve();
  let resumePromise = null;
  let resumeGeneration = null;
  let timer = null;
  let cancelDelay = null;
  let waitingTargetKey = null;
  let maintenance = false;
  let initPromise = null;
  let initialized = false;
  let status = { state: 'off', error: null };
  const publish = (next) => { status = { ...status, ...next }; try { onStatus({ ...status }); } catch {} };
  const enqueue = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };
  const initialize = () => {
    if (initialized) return Promise.resolve();
    if (initPromise) return initPromise;
    initPromise = enqueue(async () => {
      const records = await store.list();
      enabledKeys.clear();
      proofByKey.clear();
      for (const row of records) { enabledKeys.add(row.deviceKey); proofByKey.set(row.deviceKey, row.physicalTarget); }
      initialized = true;
      publish({ state: enabledKeys.size ? 'armed' : 'off', error: null });
    }).catch((error) => {
      initPromise = null;
      publish({ state: 'unavailable', error: 'Fan resume settings could not be loaded.' });
      throw error;
    });
    return initPromise;
  };
  const findCurrentRecord = async (deviceId, deviceKey, records = null) => {
    const [target, inventory] = await Promise.all([backend.getDeviceTarget?.(deviceId), backend.listDevices?.()]);
    if (!target || target.synthetic === true || target.backendKind === 'os') return { target: null, record: null, ambiguous: false, candidateKeys: [] };
    const aliases = new Set([target.deviceKey, ...(Array.isArray(target.deviceKeys) ? target.deviceKeys : [])]);
    if (deviceKey && !aliases.has(deviceKey)) return { target, record: null, ambiguous: true, candidateKeys: enabledKeys.has(deviceKey) ? [deviceKey] : [] };
    let saved = records;
    if (!saved) { try { saved = await store.list(); } catch { saved = []; } }
    if (target.identityAmbiguous === true) {
      return { target, record: null, ambiguous: true,
        candidateKeys: [...enabledKeys].filter(key => aliases.has(key)) };
    }
    const rows = Array.isArray(inventory) ? inventory : [target];
    const proofFits = (proof) => {
      const targetProof = physicalTargetOf(target);
      if (proof?.pciVendorId && targetProof?.pciVendorId && proof.pciVendorId !== targetProof.pciVendorId) return false;
      if (proof?.pciDeviceId && targetProof?.pciDeviceId && proof.pciDeviceId !== targetProof.pciDeviceId) return false;
      return physicalTargetMatches(target, proof, rows);
    };
    const matches = [];
    for (const record of saved) {
      let matchesRecord = aliases.has(record.deviceKey) && proofFits(record.physicalTarget);
      if (!matchesRecord && !aliases.has(record.deviceKey) && proofFits(record.physicalTarget)) {
        try {
          const resolved = await backend.resolvePhysicalTarget?.(record.deviceKey, record.physicalTarget);
          matchesRecord = Number.isInteger(resolved?.id) && resolved.id === deviceId;
        } catch {}
      }
      if (matchesRecord) matches.push(record);
    }
    const proofMatches = [];
    for (const key of enabledKeys) {
      const proof = proofByKey.get(key);
      if (!proof) continue;
      let matchesEnabled = aliases.has(key) && proofFits(proof);
      if (!matchesEnabled && !aliases.has(key) && proofFits(proof)) {
        try {
          const resolved = await backend.resolvePhysicalTarget?.(key, proof);
          matchesEnabled = Number.isInteger(resolved?.id) && resolved.id === deviceId;
        } catch {}
      }
      if (matchesEnabled) proofMatches.push(key);
    }
    return { target, record: matches.length === 1 ? matches[0] : null, enabledKey: proofMatches.length === 1 ? proofMatches[0] : null,
      candidateKeys: [...new Set([...matches.map(record => record.deviceKey), ...proofMatches, ...[...enabledKeys].filter(key => aliases.has(key))])],
      ambiguous: matches.length > 1 || proofMatches.length > 1 || (saved.some((record) => aliases.has(record.deviceKey))
        && matches.length === 0) };
  };
  const invalidateRecord = async (key, message) => {
    if (!key) return;
    invalidKeys.add(key);
    try {
      await store.remove(key);
      publish({ state: enabledKeys.has(key) ? 'armed-no-target' : 'off', error: message });
    } catch (error) {
      publish({ state: 'failed', error: `Could not invalidate the old fan restore target: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  const setEnabled = async ({ enabled: value, deviceId, deviceKey } = {}) => {
    if (typeof value !== 'boolean' || typeof deviceKey !== 'string' || !deviceKey.trim()) throw new Error('fan-resume: invalid request');
    if (!value && enabledKeys.has(deviceKey)) cancelTarget(deviceKey);
    await initialize();
    if (value !== true) {
      await cancelForDevice(deviceId, deviceKey);
      return enqueue(async () => {
        try {
          const match = Number.isInteger(deviceId) ? await findCurrentRecord(deviceId, deviceKey) : { record: await store.get(deviceKey), ambiguous: false };
          // OFF never writes hardware. Allow it to clear all matching saved
          // aliases even when those records are too ambiguous to restore.
          const removeKeys = match.candidateKeys?.length ? match.candidateKeys
            : [match.record?.deviceKey ?? match.enabledKey ?? deviceKey];
          for (const key of removeKeys) { invalidKeys.add(key); cancelTarget(key); }
          for (const key of removeKeys) await store.remove(key);
          for (const key of removeKeys) {
            enabledKeys.delete(key);
            invalidKeys.delete(key);
            proofByKey.delete(key);
          }
          publish({ state: enabledKeys.size ? 'armed' : 'off', error: null });
          return { enabled: false, ...status };
        } catch (error) {
          publish({ state: 'failed', error: `Could not disable fan resume: ${error instanceof Error ? error.message : String(error)}` });
          throw error;
        }
      });
    }
    return enqueue(async () => {
      if (stopped || maintenance) throw new Error('fan-resume: unavailable during shutdown or maintenance');
      if (!Number.isInteger(deviceId)) throw new Error('fan-resume: selected GPU identity unavailable');
      const target = await backend.getDeviceTarget?.(deviceId);
      if (target?.deviceKey !== deviceKey && !target?.deviceKeys?.includes(deviceKey)) throw new Error('fan-resume: selected GPU identity changed');
      if (!target || target.identityAmbiguous === true || target.synthetic === true || target.backendKind === 'os') throw new Error('fan-resume: GPU identity is ambiguous or read-only');
      const proof = physicalTargetOf(target);
      if (!proof || typeof proof !== 'object') throw new Error('fan-resume: physical GPU proof is unavailable');
      const [caps, state] = await Promise.all([backend.getCapabilities(deviceId), backend.getCurrentSettings(deviceId)]);
      if (caps?.fan?.canControl !== true || !Array.isArray(caps.fan.modes) || !caps.fan.modes.includes(state?.fanMode)) throw new Error('fan-resume: fan control or current mode is unavailable');
      const fanMode = state.fanMode;
      const settings = fanOnlySettings(fanMode === 'curve' ? { fanMode, fanCurve: state.fanCurve } : fanMode === 'fixed' ? { fanMode, fixedFanPct: state.fixedFanPct } : { fanMode });
      if (fanMode === 'curve' && (!Number.isInteger(caps.fan.maxCurvePoints) || caps.fan.maxCurvePoints < 2 || settings.fanCurve.length > caps.fan.maxCurvePoints)) throw new Error('fan-resume: current curve exceeds the GPU point limit');
      await backend.assertDeviceTarget?.(deviceId, deviceKey, proof);
      const match = await findCurrentRecord(deviceId, deviceKey);
      if (match.ambiguous) throw new Error('fan-resume: saved GPU identity is ambiguous');
      const persistKey = match.record?.deviceKey ?? match.enabledKey ?? deviceKey;
      await store.set({ deviceKey: persistKey, physicalTarget: proof, settings });
      invalidKeys.delete(persistKey);
      proofByKey.set(persistKey, proof);
      enabledKeys.add(persistKey); cancelTarget(persistKey); publish({ state: 'armed', error: null });
      return { enabled: true, ...status };
    });
  };
  const noteApply = async (deviceId, settings, out) => {
    const fan = Object.fromEntries(Object.entries(settings ?? {}).filter(([key]) => FAN_KEYS.has(key)));
    if (!Object.keys(fan).length) return;
    const match = await findCurrentRecord(deviceId, null).catch(() => ({ target: null, record: null, ambiguous: false }));
    const target = match.target;
    if (!target) return;
    if (match.ambiguous) return;
    const aliases = new Set([target.deviceKey, ...(Array.isArray(target.deviceKeys) ? target.deviceKeys : [])]);
    const enabledKey = match.enabledKey;
    const oldKey = match.record?.deviceKey ?? enabledKey;
    if (!oldKey) return;
    const invalidate = (message) => invalidateRecord(oldKey, message);
    const perControl = out?.result?.perControl ?? {};
    const requestedNames = Object.keys(fan);
    if (requestedNames.some((name) => perControl[name]?.ok !== true)) {
      await invalidate('A fan apply failed; select and apply a valid fan mode again.');
      return;
    }
    try {
      let mode = fan.fanMode ?? (fan.fanCurve ? 'curve' : out?.state?.fanMode);
      if (!['auto', 'curve', 'fixed'].includes(mode)) throw new Error('confirmed fan mode unavailable');
      const captured = fanOnlySettings(mode === 'curve'
        ? { fanMode: mode, fanCurve: out?.state?.fanCurve ?? fan.fanCurve }
        : mode === 'fixed'
          ? { fanMode: mode, fixedFanPct: out?.state?.fixedFanPct ?? fan.fixedFanPct }
          : { fanMode: mode });
      if (!out?.state || out.state.fanMode !== mode) {
        throw new Error('fan apply readback does not confirm the selected mode');
      }
      const proof = physicalTargetOf(target);
      if (!proof) throw new Error('physical GPU proof unavailable');
      await backend.assertDeviceTarget?.(deviceId, target.deviceKey, proof);
      await store.set({ deviceKey: oldKey, physicalTarget: proof, settings: captured });
      invalidKeys.delete(oldKey);
      proofByKey.set(oldKey, proof);
      enabledKeys.add(oldKey);
      if (enabledKey || match.record) publish({ state: 'armed', error: null });
    } catch (error) {
      await invalidate(`The fan apply could not be safely recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const noteApplyFailure = async (deviceId) => {
    let match;
    try { match = await findCurrentRecord(deviceId, null); } catch { match = null; }
    const target = match?.target;
    if (match?.ambiguous) return;
    const keys = target ? [...enabledKeys].filter((key) => key === target.deviceKey || target.deviceKeys?.includes(key)) : [];
    if (match?.record) keys.push(match.record.deviceKey);
    for (const key of new Set(keys)) await invalidateRecord(key, 'A fan apply failed before completion; apply a valid fan mode again.');
  };
  const cancel = (nextStatus = null) => {
    generation += 1; clearTimeout(timer); timer = null;
    waitingTargetKey = null;
    cancelDelay?.();
    if (nextStatus) publish(nextStatus);
  };
  const cancelTarget = (key) => {
    if (!key) return;
    targetRevisions.set(key, (targetRevisions.get(key) ?? 0) + 1);
    if (waitingTargetKey === key) {
      waitingTargetKey = null;
      clearTimeout(timer); timer = null;
      cancelDelay?.();
    }
  };
  const cancelForDevice = async (deviceId, deviceKey = null) => {
    if (Number.isInteger(deviceId)) {
      try {
        const match = await findCurrentRecord(deviceId, deviceKey);
        if (match.ambiguous) { for (const key of match.candidateKeys ?? []) cancelTarget(key); return; }
        const key = match.record?.deviceKey ?? match.enabledKey;
        if (key) { cancelTarget(key); return; }
      } catch {}
    }
    if (deviceKey && enabledKeys.has(deviceKey)) cancelTarget(deviceKey);
  };
  const runResume = async () => {
    if (enabledKeys.size === 0 || stopped || maintenance) return;
    const ticket = generation;
    const targetTickets = new Map([...enabledKeys].map((key) => [key, targetRevisions.get(key) ?? 0]));
    let records;
    try { records = await store.list(); }
    catch (error) {
      publish({ state: 'failed', error: `Could not load saved fan settings: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    if (applyRunner?.needsWorker?.() === true && isElevated() !== true) {
      publish({ state: 'needs-elevation', error: 'Run Arc Power as administrator to restore fan settings after sleep.' }); return;
    }
    for (const saved of records.filter((row) => enabledKeys.has(row.deviceKey) && !invalidKeys.has(row.deviceKey))) {
      if (invalidKeys.has(saved.deviceKey)) continue;
      const targetTicket = targetTickets.get(saved.deviceKey) ?? 0;
      let completed = false;
      for (let i = 0; i < timers.length; i += 1) {
        waitingTargetKey = saved.deviceKey;
        await new Promise((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            timer = null;
            if (waitingTargetKey === saved.deviceKey) waitingTargetKey = null;
            if (cancelDelay === finish) cancelDelay = null;
            resolve();
          };
          cancelDelay = finish;
          if (typeof delay === 'function') void Promise.resolve(delay(timers[i])).then(finish, finish);
          else timer = setTimeout(finish, timers[i]);
        });
        if (enabledKeys.size === 0 || stopped || maintenance || generation !== ticket) return;
        if ((targetRevisions.get(saved.deviceKey) ?? 0) !== targetTicket) break;
        const shouldContinue = await enqueue(async () => {
          if (enabledKeys.size === 0 || stopped || maintenance || generation !== ticket
            || (targetRevisions.get(saved.deviceKey) ?? 0) !== targetTicket) return false;
          try {
          const target = await backend.resolvePhysicalTarget(saved.deviceKey, saved.physicalTarget);
          if (!target || !Number.isInteger(target.id)) throw new Error('selected GPU identity could not be resolved');
          const matchingRecords = [];
          for (const record of records.filter(row => enabledKeys.has(row.deviceKey) && !invalidKeys.has(row.deviceKey))) {
            try {
              const resolved = await backend.resolvePhysicalTarget(record.deviceKey, record.physicalTarget);
              if (resolved.id === target.id) matchingRecords.push(record);
            } catch { /* an unrelated invalid target cannot authorize this write */ }
          }
          if (matchingRecords.length > 1) {
            for (const record of matchingRecords) invalidKeys.add(record.deviceKey);
            throw new Error('Ambiguous saved fan settings: multiple records identify this GPU. Turn fan resume off and enable it again.');
          }
          await backend.assertDeviceTarget(target.id, saved.deviceKey, saved.physicalTarget);
          const caps = await backend.getCapabilities(target.id);
          if (caps?.fan?.canControl !== true || !Array.isArray(caps.fan.modes)
            || (saved.settings.fanMode === 'curve' && !Number.isInteger(caps.fan.maxCurvePoints))) {
            throw new Error('Fan control capabilities are not ready yet.');
          }
          if (!caps.fan.modes.includes(saved.settings.fanMode)
            || (saved.settings.fanMode === 'curve' && (caps.fan.maxCurvePoints < 2 || saved.settings.fanCurve.length > caps.fan.maxCurvePoints))) {
            publish({ state: 'failed', error: 'The saved fan mode or curve is no longer supported by this GPU.' });
            completed = true;
            return true;
          }
          if (!enabledKeys.has(saved.deviceKey) || generation !== ticket || (targetRevisions.get(saved.deviceKey) ?? 0) !== targetTicket) return false;
          await backend.assertDeviceTarget(target.id, saved.deviceKey, saved.physicalTarget);
          if (!enabledKeys.has(saved.deviceKey) || generation !== ticket || (targetRevisions.get(saved.deviceKey) ?? 0) !== targetTicket) return false;
          const out = await rawApplySettings(target.id, fanOnlySettings(saved.settings), {
            resumeRestore: true,
            expectedTarget: { deviceKey: saved.deviceKey, physicalTarget: saved.physicalTarget },
          });
          if (enabledKeys.size === 0 || stopped || maintenance || generation !== ticket
            || (targetRevisions.get(saved.deviceKey) ?? 0) !== targetTicket) return false;
          const per = out?.result?.perControl ?? {};
          const writes = Object.entries(per).filter(([name]) => FAN_KEYS.has(name));
          const requested = Object.keys(saved.settings);
          if (requested.length > 0 && requested.every((name) => per[name]?.ok === true)) {
            publish({ state: 'restored', error: null });
            if (out.state) try { onState({ deviceId: target.id, state: out.state }); } catch {}
            completed = true;
            return true;
          }
          const errors = writes.map(([, result]) => result?.errorCode);
          if (errors.some((code) => ['out-of-range', 'invalid-argument', 'unsupported', 'unavailable-symbol', 'waiver-not-set', 'permission-denied', 'driver-adjusted'].includes(code))) {
            publish({ state: 'failed', error: 'The saved fan settings are no longer accepted by the driver.' });
            completed = true;
            return true;
          }
          throw new Error('Fan settings could not be confirmed yet.');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/identity|physical proof|ambiguous|stale GPU|read-only|no worker GPU|invalid.*curve|curve.*invalid|out.of.range|waiver|permission|unsupported/i.test(message)) {
            publish({ state: 'failed', error: message });
            completed = true;
            return true;
          }
          if (i === timers.length - 1) publish({ state: 'failed', error: error instanceof Error ? error.message : String(error) });
          }
          return true;
        });
        if (!shouldContinue) {
          if (stopped || maintenance || generation !== ticket || enabledKeys.size === 0) return;
          if ((targetRevisions.get(saved.deviceKey) ?? 0) !== targetTicket) break;
          return;
        }
        if (completed) break;
      }
      if (!completed) continue;
    }
  };
  const onResume = () => {
    if (enabledKeys.size === 0 || stopped || maintenance) return Promise.resolve();
    if (resumePromise) {
      // A previous native apply can still settle after another suspend.
      // Preserve the new resume notification instead of consuming it as a
      // duplicate of the canceled cycle.
      return resumeGeneration !== generation
        ? resumePromise.then(() => onResume())
        : resumePromise;
    }
    publish({ state: 'waiting', error: null });
    resumeGeneration = generation;
    resumePromise = runResume().finally(() => { resumePromise = null; });
    return resumePromise;
  };
  return {
    initialize,
    setEnabled,
    getState: async (deviceId, deviceKey) => {
      await initialize();
      if (typeof deviceId !== 'number') { deviceKey = deviceId; deviceId = null; }
      const match = Number.isInteger(deviceId)
        ? await findCurrentRecord(deviceId, deviceKey)
        : { record: await store.get(deviceKey), enabledKey: enabledKeys.has(deviceKey) ? deviceKey : null, ambiguous: false };
      if (match.ambiguous) return { enabled: (match.candidateKeys ?? [deviceKey]).some(key => enabledKeys.has(key)), state: 'unavailable', error: 'Saved GPU identity is ambiguous. Turn fan resume off to clear its saved selection.', settings: null };
      const key = match.record?.deviceKey ?? match.enabledKey ?? deviceKey;
      const saved = match.record ?? await store.get(key);
      const invalid = invalidKeys.has(key);
      return { enabled: enabledKeys.has(key), state: invalid ? 'needs-confirmed-apply' : status.state,
        error: invalid ? (status.error ?? 'Apply a valid fan mode to capture a new restore target.') : status.error,
        settings: invalid ? null : (saved?.settings ?? null) };
    },
    noteApply,
    enqueue,
    runUserApply: (args) => {
      const hasFanSettings = Object.keys(args[1] ?? {}).some((key) => FAN_KEYS.has(key));
      const cancelFirst = hasFanSettings ? cancelForDevice(args[0]) : Promise.resolve();
      return cancelFirst.then(() => enqueue(async () => {
        if (stopped) throw new Error('fan-resume: shutting down');
        let out;
        try { out = await rawApplySettings(...args); }
        catch (error) {
          if (Object.keys(args[1] ?? {}).some((key) => FAN_KEYS.has(key))) await noteApplyFailure(args[0]);
          throw error;
        }
        await noteApply(args[0], args[1], out);
        return out;
      }));
    },
    onResume: async () => { try { await initialize(); return await onResume(); } catch {} },
    onSuspend: () => cancel({ state: enabledKeys.size ? 'armed' : 'off', error: null }),
    setMaintenance: (value) => {
      maintenance = value === true;
      if (maintenance) cancel({ state: 'maintenance', error: null });
      else publish({ state: enabledKeys.size ? 'armed' : 'off', error: null });
    },
    async quiesce() { cancel(); try { await Promise.all([resumePromise, queue]); } catch {} },
    async stop() { stopped = true; enabledKeys.clear(); cancel(); try { await Promise.all([resumePromise, queue]); } catch {} },
  };
}
