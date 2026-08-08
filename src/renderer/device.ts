// Arc Power — M4-F device switch core (renderer). The selectDevice flow is
// a factory (createDeviceSwitcher) so the guard + the best-effort
// telemetry handover + the state resets are unit-testable under plain
// `node --test` (no DOM). app.ts wires the production instance:
//
//   selectDevice(id):
//     guard: one switch in flight (N10) + same-id/unknown-id no-ops;
//     api.telemetryStop(oldId) best-effort (catch -> warn toast);
//     api.telemetryStart(newId) best-effort (catch -> warn toast — the
//       switch MUST always complete);
//     api.getCapabilities(newId) + api.getCurrentSettings(newId) — a read
//       failure keeps the OLD device (the session never renders a
//       half-switched caps/state pair);
//     store.set({ deviceId, caps, state, latestSample: null, lastApply:
//       null }) — the header re-renders via the store subscriber, the
//       monitoring series resets via latestSample null ('—' until the
//       first tick);
//     api.deviceSet(id) (persist) — failure -> warn toast, the SESSION
//       switch stays (N9);
//     onSwitched() — the app re-renders the current page (renderPage).
//
// The waiver is NOT re-prompted on switch (the waiver is per-session
// global; the boot-apply/waiver prompt decision is boot-only).

import type { Capabilities, DeviceState, DeviceInfo } from './types.ts';
import type { ArcPowerApi } from './arcpower.d.ts';
import type { Store } from './router.ts';

export interface DeviceSwitchDeps {
  api: Pick<ArcPowerApi, 'telemetryStop' | 'telemetryStart' | 'getCapabilities' | 'getCurrentSettings' | 'deviceSet'>;
  store: Store;
  /** Re-render the current page after the switch lands (app-level). */
  onSwitched: (id: number) => void;
  /** warn toast sink (never throws). */
  warn: (title: string, message: string) => void;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// N10: ONE switch at a time — a second selectDevice while a switch is in
// flight is a no-op (the in-flight switch's re-render settles the UI).
let inFlight = false;

export function createDeviceSwitcher(deps: DeviceSwitchDeps): (id: number) => Promise<void> {
  return async (id: number): Promise<void> => {
    if (inFlight) return;
    if (!Number.isInteger(id) || id < 0) return;
    const live = deps.store.get();
    if (id === live.deviceId) return;
    if (!live.devices.some((d: DeviceInfo) => d.id === id)) return;
    const oldId = live.deviceId;
    inFlight = true;
    try {
      // Best-effort stop: a failure must never block the switch.
      if (oldId !== null) {
        try {
          await deps.api.telemetryStop(oldId);
        } catch (err) {
          deps.warn('Telemetry', `Stopping telemetry on device ${oldId} failed: ${errText(err)}`);
        }
      }
      // Best-effort start (M5): the switch always completes.
      try {
        await deps.api.telemetryStart(id);
      } catch (err) {
        deps.warn('Telemetry', `Starting telemetry on device ${id} failed: ${errText(err)}`);
      }
      // The caps/state pair is the session's rendering surface — a read
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
        return;
      }
      // latestSample + lastApply reset: the monitoring series and the
      // "OC working" row must never carry the OLD device's values onto the
      // new device ('—' until the first tick / the first apply).
      deps.store.set({ deviceId: id, caps, state, latestSample: null, lastApply: null });
      // Persist AFTER the session switch: a deviceSet failure (N9) keeps
      // the in-session selection — the next boot falls back to devices[0]
      // (or the main-side self-heal re-resolves).
      try {
        await deps.api.deviceSet(id);
      } catch (err) {
        deps.warn('GPU selection', `The selection could not be saved — the switch stays for this session (${errText(err)})`);
      }
      deps.onSwitched(id);
    } finally {
      inFlight = false;
    }
  };
}
