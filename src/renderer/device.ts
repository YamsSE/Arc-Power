// Arc Power - M4-F device switch core (renderer). The selectDevice flow is
// a factory (createDeviceSwitcher) so the guard + the best-effort
// telemetry handover + the state resets are unit-testable under plain
// `node --test` (no DOM). app.ts wires the production instance:
//
//   selectDevice(id):
//     guard: one switch in flight (N10) + same-id/unknown-id no-ops;
//     api.telemetryStop(oldId) best-effort (catch -> warn toast);
//     api.telemetryStart(newId) best-effort (catch -> warn toast - the
//       switch MUST always complete);
//     api.getCapabilities(newId) + api.getCurrentSettings(newId) - a read
//       failure keeps the OLD device (the session never renders a
//       half-switched caps/state pair);
//     store.set({ deviceId, caps, state, latestSample: null, lastApply:
//       null }) - the header re-renders via the store subscriber, the
//       monitoring series resets via latestSample null ('-' until the
//       first tick);
//     api.deviceSet(id) (persist) - failure -> warn toast, the SESSION
//       switch stays (N9);
//     onSwitched() - the app re-renders the current page (renderPage).
//
// The waiver is NOT re-prompted on switch (the waiver is per-session
// global; the boot-apply/waiver prompt decision is boot-only).

import type { Capabilities, DeviceState, DeviceInfo } from './types.ts';
import type { ArcPowerApi } from './arcpower.d.ts';
import type { Store } from './router.ts';

export interface DeviceSwitchDeps {
  api: Pick<ArcPowerApi, 'telemetryStop' | 'telemetryStart' | 'getCapabilities' | 'getCurrentSettings' | 'deviceSet'> & Partial<Pick<ArcPowerApi, 'vendorInfo'>>;
  store: Store;
  /** Re-render the current page after the switch lands (app-level). */
  onSwitched: (id: number) => void;
  /** warn toast sink (never throws). */
  warn: (title: string, message: string) => void;
  /** Queue the latest request when a cross-window request races a switch. */
  queueWhileInFlight?: boolean;
}
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
type TelemetryApi = Pick<ArcPowerApi, 'telemetryStop' | 'telemetryStart'>;

export async function stopTelemetry(
  api: TelemetryApi,
  deviceId: number | null,
  warn: (title: string, message: string) => void,
): Promise<void> {
  if (deviceId === null) return;
  try {
    await api.telemetryStop(deviceId);
  } catch (err) {
    warn('Telemetry', `Stopping telemetry on device ${deviceId} failed: ${errText(err)}`);
  }
}

export async function startTelemetry(
  api: TelemetryApi,
  deviceId: number | null,
  warn: (title: string, message: string) => void,
): Promise<boolean> {
  try {
    await api.telemetryStart(deviceId);
    return true;
  } catch (err) {
    warn('Telemetry', `Starting telemetry on device ${deviceId ?? 'none'} failed: ${errText(err)}`);
    return false;
  }
}


// N10: ONE switch at a time - a second selectDevice while a switch is in
// flight is a no-op unless the caller explicitly opts into latest-request
// queueing (the cross-window panel path).
export function createDeviceSwitcher(deps: DeviceSwitchDeps): (id: number) => Promise<void> {
  let inFlight = false;
  let queuedId: number | null = null;

  const switchDevice = async (id: number): Promise<void> => {
    if (inFlight) {
      if (deps.queueWhileInFlight && Number.isInteger(id) && id >= 0) queuedId = id;
      return;
    }
    if (!Number.isInteger(id) || id < 0) return;
    const live = deps.store.get();
    if (id === live.deviceId) return;
    const selected = live.devices.find((d: DeviceInfo) => d.id === id);
    if (!selected) return;
    const hasUnsafeKey = typeof selected.deviceKey !== 'string' || selected.deviceKey.trim().length === 0;
    const duplicateKey = !hasUnsafeKey
      && live.devices.some((device) => device.id !== id && device.deviceKey === selected.deviceKey);
    if (hasUnsafeKey || duplicateKey) {
      deps.warn('GPU selection', 'This GPU has no unique stable identity and cannot be selected safely.');
      return;
    }
    const oldId = live.deviceId;
    inFlight = true;
    try {
      await stopTelemetry(deps.api, oldId, deps.warn);
      // Best-effort start (M5): the switch always completes.
      await startTelemetry(deps.api, id, deps.warn);
      // The caps/state pair is the session's rendering surface - a read
      // failure keeps the OLD device (never pair the new deviceId with a
      // stale or missing pair).
      let caps: Capabilities;
      let state: DeviceState;
      try {
        [caps, state] = await Promise.all([
          deps.api.getCapabilities(id),
          deps.api.getCurrentSettings(id),
        ]);
      } catch (err) {
        deps.warn('GPU switch', `Could not read device ${id} state: ${errText(err)}`);
        // The old owner was stopped before the speculative new-device read.
        // Roll the telemetry handoff back with the selection so the old
        // session does not keep filtering out samples from a stopped owner.
        await stopTelemetry(deps.api, id, deps.warn);
        await startTelemetry(deps.api, oldId, deps.warn);
        return;
      }
      let vendorInfo = null;
      try {
        vendorInfo = deps.api.vendorInfo ? await deps.api.vendorInfo(id) : null;
      } catch {
        vendorInfo = null;
      }
      // latestSample + lastApply reset: the monitoring series and the
      // "OC working" row must never carry the OLD device's values onto
      // the new device.
      deps.store.set({
        deviceId: id,
        caps,
        state,
        latestSample: null,
        lastApply: null,
        noIntel: false,
        osGpu: selected.osController ?? null,
        vendorInfo,
      });
      // Persist AFTER the session switch: a deviceSet failure keeps the
      // in-session selection; the next boot resolves the durable fallback.
      try {
        await deps.api.deviceSet({ deviceId: id, deviceKey: selected.deviceKey });
      } catch (err) {
        deps.warn('GPU selection', `The selection could not be saved - the switch stays for this session (${errText(err)})`);
      }
      deps.onSwitched(id);
    } finally {
      inFlight = false;
      const nextId = queuedId;
      queuedId = null;
      if (nextId !== null) void switchDevice(nextId);
    }
  };
  return switchDevice;
}
