import { recordingCaptureSelection } from './recording-capture.js';

/**
 * Coalesces ordinary inventory reads but gives an explicit refresh a newer
 * enumeration than any request already in flight. Window capture uses this
 * before handing a native HWND to the encoder because Windows may reuse an
 * old handle after a process exits.
 */
export function createRecordingCaptureTargetsReader({ listTargets, mergeTargets = (value) => value } = {}) {
  if (typeof listTargets !== 'function') throw new TypeError('listTargets must be a function');
  let cache = null;
  let pending = null;
  let refreshPending = null;

  const enumerate = () => {
    const request = Promise.resolve()
      .then(() => listTargets())
      .then((targets) => {
        cache = mergeTargets(targets);
        return cache;
      });
    let tracked;
    tracked = request.finally(() => {
      if (pending === tracked) pending = null;
    });
    pending = tracked;
    return tracked;
  };

  const read = (refresh = false) => {
    if (refresh && refreshPending) return refreshPending;
    if (!refresh && pending) return pending;
    if (!refresh && cache !== null) return Promise.resolve(cache);

    if (refresh && pending) {
      const earlier = pending;
      let tracked;
      tracked = earlier.catch(() => null).then(() => enumerate()).finally(() => {
        if (pending === tracked) pending = null;
        if (refreshPending === tracked) refreshPending = null;
      });
      pending = tracked;
      refreshPending = tracked;
      return tracked;
    }

    const result = enumerate();
    if (refresh) {
      let tracked;
      tracked = result.finally(() => {
        if (pending === tracked) pending = null;
        if (refreshPending === tracked) refreshPending = null;
      });
      pending = tracked;
      refreshPending = tracked;
      return tracked;
    }
    return result;
  };

  return { read, getCache: () => cache };
}

/** Force a fresh window inventory before choosing a saved capture target. */
export async function recordingCaptureSelectionForStart(target, readTargets, fallbackDisplay = null) {
  if (typeof readTargets !== 'function') throw new TypeError('readTargets must be a function');
  const targets = await readTargets(true);
  return recordingCaptureSelection(target, targets, fallbackDisplay);
}
