import { el, clear } from '../dom.ts';
import { api } from '../ipc.ts';
import type { Page } from '../router.ts';
import type { ArcSleepSettings, ArcSleepSnapshot } from '../types.ts';

const defaults: ArcSleepSettings = { idleEnabled: false, idleAfterSeconds: 300, idleFps: 30, adaptiveEnabled: false, adaptiveMinFps: 60, adaptiveMaxFps: 144, adaptiveTargetLoadPct: 85 };
// Serialize saves across visits. A visit may stop waiting, but never cancels an accepted save.
let saveQueue: Promise<void> = Promise.resolve();
let latestAcceptedSettings: ArcSleepSettings | null = null;
let generation = 0;
let timer: number | undefined;
const IPC_TIMEOUT_MS = 5000;
const withTimeout = <T>(request: Promise<T>, label: string): Promise<T> => {
  let timeout: number | undefined;
  return Promise.race([
    request,
    new Promise<T>((_, reject) => { timeout = window.setTimeout(() => reject(new Error(`${label} timed out`)), IPC_TIMEOUT_MS); }),
  ]).finally(() => { if (timeout !== undefined) window.clearTimeout(timeout); });
};
const bounded = (value: unknown, min: number, max: number, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;

export const arcSleepPage: Page = {
  id: 'arc-sleep',
  render(container, ctx): void {
    clear(container);
    const visit = ++generation;
    const alive = (): boolean => visit === generation && container.isConnected;
    let settings = { ...defaults };
    let revision = 0;
    let snapshotRevision = 0;
    const saveState = el('span', { class: 'chip', text: 'Loading…', dataset: { arcSleepSaveState: '' }, role: 'status' });
    const status = el('p', { class: 'arc-sleep-status', text: 'Loading runtime status…', dataset: { arcSleepStatus: '' }, role: 'status' });
    const rtss = el('strong', { text: 'Checking…' });
    const base = el('strong', { text: '—' });
    const effective = el('strong', { text: '—' });
    const diagnostics = el('p', { class: 'arc-sleep-diagnostics', text: 'Waiting for live GPU and RTSS readings…', dataset: { arcSleepDiagnostics: '' }, role: 'status' });
    const toggle = (label: string): HTMLInputElement => el('input', { type: 'checkbox', class: 'arc-sleep-toggle', role: 'switch', 'aria-label': label });
    const number = (label: string, min: number, max: number, value: number): HTMLInputElement => el('input', { type: 'number', class: 'arc-sleep-number', min, max, step: 1, value, 'aria-label': label });
    const idle = toggle('Enable Idle Cap');
    const adaptive = toggle('Enable Load Adaptive');
    const delay = number('Idle after seconds', 60, 3600, 300);
    const idleFps = number('Idle frame cap', 15, 120, 30);
    const min = number('Adaptive minimum FPS', 30, 240, 60);
    const max = number('Adaptive maximum FPS', 31, 500, 144);
    const target = number('Target GPU load percent', 50, 99, 85);
    const selected = ctx.store.get().devices.find(device => device.id === ctx.store.get().deviceId);
    const controls = [idle, adaptive, delay, idleFps, min, max, target];
    const field = (label: string, input: HTMLInputElement, unit: string): HTMLElement => el('label', { class: 'arc-sleep-field' }, [el('span', { text: label }), el('span', { class: 'arc-sleep-input-wrap' }, [input, el('span', { text: unit, 'aria-hidden': 'true' })])]);
    const panel = (title: string, subtitle: string, input: HTMLInputElement, fields: HTMLElement[], note: string): HTMLElement => el('section', { class: 'card arc-sleep-panel' }, [
      el('div', { class: 'arc-sleep-panel-heading' }, [el('div', {}, [el('h2', { class: 'card-title', text: title }), el('p', { class: 'card-note', text: subtitle })]), input]),
      el('div', { class: 'arc-sleep-fields' }, fields), el('p', { class: 'arc-sleep-panel-note', text: note }),
    ]);
    container.append(el('div', { class: 'arc-sleep-page', dataset: { control: 'arcSleep' } }, [
      el('section', { class: 'arc-sleep-hero' }, [el('div', {}, [el('span', { class: 'arc-sleep-eyebrow', text: 'SMART FRAME CONTROL' }), el('h1', { class: 'page-title', text: 'Arc Sleep' }), el('p', { class: 'page-subtitle', text: 'Ease the frame cap when you step away. Balance GPU load while you play.' })]), saveState]),
      el('section', { class: 'card arc-sleep-runtime' }, [el('div', { class: 'arc-sleep-summary', dataset: { arcSleepCaps: '' } }, [el('div', {}, [el('span', { text: 'RTSS connection' }), rtss]), el('div', {}, [el('span', { text: 'Base cap' }), base]), el('div', {}, [el('span', { text: 'Effective cap' }), effective])]), status, diagnostics]),
      el('div', { class: 'arc-sleep-panels' }, [
        panel('Idle Cap', 'Save power during input inactivity.', idle, [field('Inactive for', delay, 'sec'), field('Cap at', idleFps, 'FPS')], 'Uses Windows keyboard and mouse input inactivity across your session. It does not detect character or camera movement. Input resumes your normal cap. Idle Cap takes priority over Load Adaptive.'),
        panel('Load Adaptive', 'Adjust the frame cap to your GPU workload.', adaptive, [field('Minimum', min, 'FPS'), field('Maximum', max, 'FPS'), field('Target GPU load', target, '%')], 'Uses fresh utilization from the selected GPU only. The cap stays within this range while seeking your target load. If GPU telemetry is unavailable for five seconds, the adaptive cap is released.'),
      ]),
      el('div', { class: 'arc-sleep-footer' }, !selected || selected.synthetic || selected.backendKind === 'os'
        ? [el('p', { class: 'card-note', text: !selected
          ? 'RTSS frame control is app-wide and follows RTSS profile scope. Arc Sleep settings are available without a selected GPU; the Graphics base cap requires one.'
          : 'RTSS frame control is app-wide and follows RTSS profile scope. The Graphics base cap is unavailable for this GPU.' })]
        : [el('p', { class: 'card-note', text: 'RTSS frame control is app-wide and follows RTSS profile scope. Set the normal base cap in Graphics.' }), el('a', { class: 'arc-sleep-base-link', href: '#/graphics', text: 'Open Graphics →' })]),
    ]));
    const paintSettings = (): void => { idle.checked = settings.idleEnabled; adaptive.checked = settings.adaptiveEnabled; delay.value = String(settings.idleAfterSeconds); idleFps.value = String(settings.idleFps); min.value = String(settings.adaptiveMinFps); max.value = String(settings.adaptiveMaxFps); target.value = String(settings.adaptiveTargetLoadPct); };
    const refresh = async (): Promise<void> => {
      const request = ++snapshotRevision;
      let state: ArcSleepSnapshot | null = null;
      let failure: string | null = null;
      try { state = await withTimeout(api.arcSleepStateGet(), 'Runtime status check'); }
      catch (error) { failure = error instanceof Error ? error.message : String(error); }
      if (!alive() || request !== snapshotRevision) return;
      rtss.textContent = state ? state.rtssAvailable ? 'Connected' : 'Unavailable' : 'Unavailable';
      const cap = (value: number | null): string => value == null ? 'Off' : `${value} FPS`;
      base.textContent = !state || (!state.rtssAvailable && state.baseFrameLimit == null) ? 'Unavailable' : cap(state.baseCapFps);
      effective.textContent = !state || !state.rtssAvailable ? 'Unavailable' : cap(state.effectiveCapFps);
      const labels: Record<ArcSleepSnapshot['status'], string> = { disabled: 'Arc Sleep is disabled.', ready: 'Ready for input inactivity or GPU load changes.', idle: 'Idle Cap is active.', adaptive: 'Load Adaptive is active.', 'rtss-unavailable': 'Start RTSS to let Arc Sleep control the frame cap.', 'external-change': 'The RTSS cap changed externally. Arc Sleep released control.', 'recovery-pending': 'Restoring the previous RTSS cap…', error: 'Arc Sleep encountered an error.' };
      status.textContent = state?.status === 'adaptive' && state.effectiveCapFps == null ? 'Load Adaptive is waiting for fresh telemetry from the selected GPU.' : state?.message || (state ? labels[state.status] : failure ? `${failure}. Check RTSS and reopen Arc Sleep to retry.` : 'Runtime status is temporarily unavailable.');
      const live = state?.diagnostics;
      if (!live) {
        diagnostics.textContent = state ? 'Live FPS adjustment diagnostics are unavailable in this runtime.' : 'Live GPU and RTSS readings are temporarily unavailable.';
      } else {
        const readings = [live.gpuUtilPct == null ? 'GPU utilization unavailable' : `GPU ${Math.round(live.gpuUtilPct)}%`];
        if (live.reportedFps != null) readings.push(`RTSS ${Math.round(live.reportedFps)} FPS`);
        const guidance: Record<NonNullable<ArcSleepSnapshot['diagnostics']>['fpsStatus'], string> = {
          disabled: 'Enable Load Adaptive to read live FPS.',
          'gpu-unavailable': 'Load Adaptive cannot currently read selected-GPU utilization.',
          'idle-priority': 'Idle Cap has priority; live-FPS adjustment is paused.',
          'below-trigger': `Fast FPS adjustment waits for GPU load above ${settings.adaptiveTargetLoadPct + 5}%.`,
          'rtss-unavailable': 'No fresh foreground game FPS from RTSS; using gradual 5 FPS steps.',
          'gpu-unconfirmed': 'RTSS reports FPS, but the game could not be confirmed on the selected GPU; using gradual 5 FPS steps.',
          ready: live.fastAdjustmentApplied ? 'Fast adjustment applied using the confirmed live game FPS.' : 'Foreground game FPS is confirmed on the selected GPU; fast adjustment is available.',
        };
        diagnostics.textContent = `${readings.join(' · ')} — ${guidance[live.fpsStatus]}`;
      }
    };
    const save = (): void => {
      if (!alive()) return;
      const next: ArcSleepSettings = { idleEnabled: idle.checked, adaptiveEnabled: adaptive.checked, idleAfterSeconds: bounded(delay.valueAsNumber, 60, 3600, settings.idleAfterSeconds), idleFps: bounded(idleFps.valueAsNumber, 15, 120, settings.idleFps), adaptiveMinFps: bounded(min.valueAsNumber, 30, 240, settings.adaptiveMinFps), adaptiveMaxFps: bounded(max.valueAsNumber, 31, 500, settings.adaptiveMaxFps), adaptiveTargetLoadPct: bounded(target.valueAsNumber, 50, 99, settings.adaptiveTargetLoadPct) };
      if (next.adaptiveMinFps >= next.adaptiveMaxFps) { saveState.textContent = 'Minimum must be below maximum'; return; }
      settings = next;
      latestAcceptedSettings = { ...next };
      paintSettings();
      const edit = ++revision;
      saveState.textContent = 'Saving…';
      // Keep the actual request in the serialized queue even if this visit's UI wait expires.
      const request = saveQueue.then(() => api.profilesSettingsSave({ arcSleep: next }));
      const settled = request.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }),
      );
      saveQueue = settled.then(() => undefined);
      let didSettle = false;
      void settled.then(outcome => {
        didSettle = true;
        if (!alive() || edit !== revision) return;
        if (!outcome.ok) {
          saveState.textContent = `Save failed: ${outcome.message}`;
          return;
        }
        saveState.textContent = 'Saved';
        void refresh();
      });
      void withTimeout(settled, 'Settings save').catch((error: unknown) => {
        if (didSettle || !alive() || edit !== revision) return;
        const detail = error instanceof Error ? error.message : String(error);
        saveState.textContent = `${detail}; it may still apply.`;
      });
    };
    controls.forEach(input => { input.disabled = true; input.addEventListener('change', save); });
    void (async () => {
      const savesAtVisit = saveQueue;
      let previousSavePending = false;
      try { await withTimeout(savesAtVisit, 'Previous settings save'); }
      catch { previousSavePending = true; }
      if (!alive()) return;

      const loadSettings = async (): Promise<boolean> => {
        try {
          const result = await withTimeout(api.profilesList(), 'Settings check');
          if (!alive() || revision !== 0) return false;
          settings = { ...defaults, ...result.settings.arcSleep };
          latestAcceptedSettings = { ...settings };
          paintSettings();
          return true;
        } catch (error) {
          if (!alive() || revision !== 0) return false;
          const detail = error instanceof Error ? error.message : String(error);
          saveState.textContent = `${detail}. Reopen Arc Sleep to retry.`;
          status.textContent = `${detail}. Settings could not be loaded; check the app and reopen Arc Sleep to retry.`;
          return false;
        }
      };

      if (previousSavePending && latestAcceptedSettings) {
        settings = { ...latestAcceptedSettings };
        paintSettings();
        saveState.textContent = 'Previous save pending; it may still apply.';
        controls.forEach(input => { input.disabled = false; });
        // Once the serialized queue settles, reload persisted state unless this visit has edits.
        void savesAtVisit.then(async () => {
          if (!alive() || revision !== 0) return;
          if (await loadSettings() && alive() && revision === 0) saveState.textContent = 'Settings refreshed after pending save.';
        });
      } else {
        if (previousSavePending) saveState.textContent = 'Previous save pending; loading saved settings…';
        if (!await loadSettings()) return;
        saveState.textContent = previousSavePending ? 'Previous save pending; it may still apply.' : 'Saved';
        controls.forEach(input => { input.disabled = false; });
        if (previousSavePending) void savesAtVisit.then(async () => {
          if (!alive() || revision !== 0) return;
          if (await loadSettings() && alive() && revision === 0) saveState.textContent = 'Settings refreshed after pending save.';
        });
      }
      const poll = async (): Promise<void> => { if (!alive()) return; await refresh(); if (alive()) timer = window.setTimeout(() => void poll(), 2500); };
      await poll();
    })();
  },
  leave(): void { ++generation; if (timer !== undefined) window.clearTimeout(timer); timer = undefined; },
};
