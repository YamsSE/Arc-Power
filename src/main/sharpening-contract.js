import fs from 'node:fs';
import path from 'node:path';

const ACTIONS = new Set(['read', 'capabilities', 'set']);
const COMMON_KEYS = new Set(['action', 'luid', 'applicationName', 'deadlineAt']);
const GUARD_KEYS = new Set(['requestId', 'cancelPath', 'tokenPath']);

/** Validate the complete parent/helper IPC request before any native work. */
export function validateSharpeningRequest(request, now = Date.now()) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || !ACTIONS.has(request.action)) return false;
  const allowed = new Set(COMMON_KEYS);
  if (request.action === 'set') {
    allowed.add('enabled');
    allowed.add('percentage');
    if (request.guard !== undefined) allowed.add('guard');
  }
  if (Object.keys(request).some((key) => !allowed.has(key))) return false;
  if (typeof request.luid !== 'string' || !/^(?!0{16}$)[0-9a-f]{16}$/i.test(request.luid)) return false;
  if (!Number.isSafeInteger(request.deadlineAt) || request.deadlineAt <= now) return false;
  if (request.applicationName !== undefined) {
    if (typeof request.applicationName !== 'string'
      || (request.applicationName !== '' && (request.applicationName !== request.applicationName.split(/[\\/]/).at(-1)
        || /[\0:*?"<>|]/.test(request.applicationName)))
      || Buffer.byteLength(request.applicationName, 'utf8') > 127) return false;
  }
  if (request.action === 'set') {
    if (typeof request.enabled !== 'boolean' || !Number.isInteger(request.percentage)
      || request.percentage < 0 || request.percentage > 100) return false;
    if (request.guard !== undefined) {
      const guard = request.guard;
      if (!guard || typeof guard !== 'object' || Array.isArray(guard)
        || Object.keys(guard).some((key) => !GUARD_KEYS.has(key))
        || typeof guard.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(guard.requestId)
        || typeof guard.cancelPath !== 'string' || typeof guard.tokenPath !== 'string') return false;
      const parent = path.win32.dirname(guard.cancelPath).toLowerCase();
      if (!path.win32.isAbsolute(guard.cancelPath) || !path.win32.isAbsolute(guard.tokenPath)
        || parent !== path.win32.dirname(guard.tokenPath).toLowerCase()
        || path.win32.basename(guard.cancelPath).toLowerCase() !== `arcpower-cancel-${guard.requestId}.json`.toLowerCase()
        || path.win32.basename(guard.tokenPath).toLowerCase() !== `arcpower-tok-${guard.requestId}.json`.toLowerCase()) return false;
    }
  } else if (Object.hasOwn(request, 'enabled') || Object.hasOwn(request, 'percentage') || Object.hasOwn(request, 'guard')) return false;
  return true;
}

/** Fail closed when an elevated apply worker has been cancelled or expired. */
export function sharpeningGuardIsLive(guard, now = Date.now(), fsImpl = fs) {
  if (!guard || typeof guard !== 'object') return false;
  try {
    if (fsImpl.existsSync(guard.cancelPath)) return false;
    const token = JSON.parse(fsImpl.readFileSync(guard.tokenPath, 'utf8'));
    return token?.requestId === guard.requestId
      && Number.isSafeInteger(token.expiresAt)
      && token.expiresAt > now;
  } catch {
    return false;
  }
}
