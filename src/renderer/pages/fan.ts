// Arc Power — Fan page. Read-only on the A770 (canControl=false): mode,
// current curve rendered in the SVG view, RPM marker. Full editor when
// canControl=true (mock): mode toggle, draggable points, add/remove with
// point-count clamp, ascending-temp enforcement, presets, Apply.
// All editor math lives in pure/curve.ts; this file is the DOM view.

import { el, clear, svgEl } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { api } from '../ipc.ts';
import type { CurvePoint } from '../pure/curve.ts';
import {
  curveDomain,
  tempToX,
  xToTemp,
  rpmMarkerY,
  movePoint,
  removePoint,
  addPointAtMidGap,
  clampPointCount,
  seedCurvePoints,
  fanCurvePresets,
  fanSpeedTicks,
  MIN_CURVE_POINTS,
} from '../pure/curve.ts';
import { buildFanSettings, validateSettingsPayload } from '../pure/settings.ts';
import { errorMessage } from '../pure/errors.ts';
import { ensureWaiver } from '../components/waiver-dialog.ts';
import { toast } from '../components/toast.ts';
import type { FanMode } from '../types.ts';

const MODE_NAMES: Record<string, string> = { auto: 'Auto', curve: 'Curve', fixed: 'Fixed' };

interface EditorState {
  mode: FanMode;
  points: CurvePoint[];
  selectedIdx: number;
  fixedPct: number;
}

function modeFromCaps(capsMode: FanMode | null, modes: string[]): FanMode {
  if (capsMode && modes.includes(capsMode)) return capsMode;
  if (modes.includes('curve')) return 'curve';
  if (modes.includes('auto')) return 'auto';
  return 'fixed';
}

export const fanPage: Page = {
  id: 'fan',

  render(container: HTMLElement, ctx: PageContext) {
    const s = ctx.store.get();
    const caps = s.caps;
    const state = s.state;
    clear(container);

    if (!caps || !state) {
      container.append(el('p', { class: 'page-subtitle', text: 'Loading fan state…' }));
      return;
    }
    if (s.deviceId === null) {
      container.append(el('p', { class: 'page-subtitle', text: 'No GPU available.' }));
      return;
    }

    const canControl = caps.fan.canControl === true;
    const maxPoints = caps.fan.maxCurvePoints > 0 ? caps.fan.maxCurvePoints : 10;
    const initial: CurvePoint[] = clampPointCount(state.fanCurve ?? [], maxPoints);

    container.append(
      el('h1', { class: 'page-title', text: 'Fan' }),
      el('p', {
        class: 'page-subtitle',
        text: canControl
          ? 'Edit the fan curve or switch the fan mode. Changes apply on demand.'
          : 'Fan control is read-only on this GPU — the curve below is what the driver currently reports.',
      }),
    );

    // M2D: a fan-less device (mock iGPU featureset) has no modes, no curve,
    // no RPM — render the honest note instead of an empty read-only view.
    if (caps.fan.modes.length === 0) {
      container.append(
        el('section', { class: 'card fan-card' }, [
          el('p', { class: 'card-note', text: 'This GPU does not expose a fan (telemetry-only device).' }),
        ]),
      );
      return;
    }

    if (!canControl) {
      renderReadOnly(container, ctx, initial, state.fanMode);
      return;
    }

    // Editable path: a device that reports < 2 curve points gets a seeded
    // 2-point ramp so Add/Remove never get stuck (F6).
    const editorPoints = seedCurvePoints(state.fanCurve ?? [], maxPoints);
    const editor: EditorState = {
      mode: modeFromCaps(state.fanMode, caps.fan.modes),
      points: editorPoints,
      selectedIdx: Math.max(0, editorPoints.length - 1),
      fixedPct: state.fixedFanPct ?? 50,
    };

    renderEditor(container, ctx, editor, maxPoints);
  },

  onUpdate(container: HTMLElement, ctx: PageContext) {
    const marker = container.querySelector<HTMLElement>('#fan-rpm-marker');
    const readout = container.querySelector<HTMLElement>('#fan-rpm-readout');
    if (!marker) return;
    const sample = ctx.store.get().latestSample;
    const rpm = sample?.fanRpm?.[0];
    const temp = sample?.tempC;
    const maxRpm = ctx.store.get().caps?.fan.maxRpm ?? -1;
    if (readout) readout.textContent = rpm !== undefined ? `${Math.round(rpm)} RPM` : '—';
    if (rpm !== undefined && temp !== undefined && maxRpm > 0) {
      const card = container.querySelector<HTMLElement>('.fan-card');
      const domain = card
        ? { minT: Number(card.dataset['fanDomainMin']), maxT: Number(card.dataset['fanDomainMax']) }
        : curveDomain([]);
      marker.style.left = `${tempToX(temp, domain)}%`;
      marker.style.top = `${rpmMarkerY(rpm, maxRpm)}%`;
      marker.hidden = false;
    } else if (marker) {
      marker.hidden = true;
    }
  },
};

// ---------------------------------------------------------------------------
// Read-only view (A770: canControl=false)
// ---------------------------------------------------------------------------

function renderReadOnly(container: HTMLElement, ctx: PageContext, points: CurvePoint[], mode: FanMode | null) {
  const s = ctx.store.get();
  const maxRpm = s.caps?.fan.maxRpm ?? -1;
  const domain = curveDomain(points);
  container.append(
    el('section', { class: 'card fan-card', dataset: { fanDomainMin: String(domain.minT), fanDomainMax: String(domain.maxT) } }, [
      el('div', { class: 'fan-head' }, [
        el('div', { class: 'chips' }, [
          el('span', { class: 'chip', text: `Mode: ${MODE_NAMES[mode ?? 'auto']}` }),
          el('span', { class: 'chip', text: `${points.length} points` }),
        ]),
        el('span', { class: 'fan-rpm', id: 'fan-rpm-readout', text: '—' }),
      ]),
      el('div', { class: 'fan-stage' }, [
        el('div', { class: 'fan-plot' }, [
          editorSvg(points, maxRpm, false),
          el('div', { class: 'fan-marker', id: 'fan-rpm-marker', hidden: true }),
        ]),
        fanAxis(),
      ]),
      el('p', { class: 'card-note', text: 'Editing is disabled: this GPU reports fan control as read-only (canControl=false). Intel Graphics Software manages the fan curve on Alchemist GPUs.' }),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Editable editor (mock: canControl=true)
// ---------------------------------------------------------------------------

function renderEditor(container: HTMLElement, ctx: PageContext, editor: EditorState, maxPoints: number) {
  const s = ctx.store.get();
  const caps = s.caps as NonNullable<typeof s.caps>;
  const modes = caps.fan.modes.length > 0 ? caps.fan.modes : ['auto', 'curve', 'fixed'];

  const card = el('section', { class: 'card fan-card' });
  const body = el('div', { class: 'fan-body' });
  card.append(body);
  container.append(card);

  const redraw = () => {
    clear(body);
    body.append(
      el('div', { class: 'chips fan-mode-toggle' }, modes.map((m) =>
        el('button', {
          class: `chip chip-btn${editor.mode === m ? ' chip-active' : ''}`,
          text: MODE_NAMES[m] ?? m,
          onClick: () => {
            editor.mode = m as FanMode;
            redraw();
          },
        }),
      )),
    );

    if (editor.mode === 'auto') {
      body.append(
        el('div', { class: 'fan-auto-note', text: 'Auto mode: the driver controls the fan automatically. Apply to switch modes.' }),
      );
    } else if (editor.mode === 'fixed') {
      const range = el('input', {
        type: 'range',
        min: 0,
        max: 100,
        step: 1,
        value: editor.fixedPct,
        oninput: (e: Event) => {
          editor.fixedPct = Number((e.target as HTMLInputElement).value);
          valueNode.textContent = `${editor.fixedPct} %`;
        },
      });
      const valueNode = el('span', { class: 'oc-value', text: `${editor.fixedPct} %` });
      body.append(
        el('div', { class: 'fan-fixed-row' }, [range, valueNode]),
        el('p', { class: 'card-note', text: 'Fixed mode: the fan spins at a constant speed. Apply to activate.' }),
      );
    } else {
      // --- curve mode: SVG + overlay dots ---
      const domain = curveDomain(editor.points);
      const maxRpm = caps.fan.maxRpm;
      card.dataset['fanDomainMin'] = String(domain.minT);
      card.dataset['fanDomainMax'] = String(domain.maxT);

      const stage = el('div', { class: 'fan-stage' }, [
        el('div', { class: 'fan-plot' }, [
          editorSvg(editor.points, maxRpm, true, domain),
          el('div', { class: 'fan-marker', id: 'fan-rpm-marker', hidden: true }),
          el('div', { class: 'fan-dots' }),
        ]),
        fanAxis(),
      ]);
      const dotsLayer = stage.querySelector<HTMLElement>('.fan-dots') as HTMLElement;

      const renderDots = () => {
        clear(dotsLayer);
        editor.points.forEach((p, idx) => {
          const dot = el('div', {
            class: `fan-dot${idx === editor.selectedIdx ? ' fan-dot-selected' : ''}`,
            dataset: { t: String(p.t), speed: String(p.speedPct), idx: String(idx) },
          });
          dot.style.left = `${tempToX(p.t, domain)}%`;
          dot.style.top = `${100 - p.speedPct}%`;
          dot.addEventListener('pointerdown', (ev) => {
            ev.preventDefault();
            dot.setPointerCapture(ev.pointerId);
            editor.selectedIdx = idx;
            renderDots();
            const rect = stage.getBoundingClientRect();
            const onMove = (me: PointerEvent) => {
              const x = ((me.clientX - rect.left) / rect.width) * 100;
              const y = ((me.clientY - rect.top) / rect.height) * 100;
              const t = xToTemp(x, domain);
              const speed = 100 - Math.min(100, Math.max(0, y));
              editor.points = movePoint(editor.points, idx, t, speed);
              redraw();
            };
            const onUp = () => {
              window.removeEventListener('pointermove', onMove);
              window.removeEventListener('pointerup', onUp);
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
          });
          dotsLayer.append(dot);
        });
      };

      const maxReached = editor.points.length >= maxPoints;

      body.append(
        stage,
        el('div', { class: 'fan-axis' }, [
          el('span', { text: `${domain.minT} °C` }),
          el('span', { class: 'fan-axis-mid', text: `${Math.round((domain.minT + domain.maxT) / 2)} °C` }),
          el('span', { text: `${domain.maxT} °C` }),
        ]),
        el('div', { class: 'fan-actions' }, [
          el('button', {
            class: 'btn btn-ghost btn-sm',
            text: 'Add point',
            disabled: maxReached,
            title: maxReached ? `Point limit reached (${maxPoints})` : 'Insert a point at the widest gap',
            onClick: () => {
              const next = addPointAtMidGap(editor.points, maxPoints);
              if (!next) {
                toast('warn', 'No room for another point', `The curve is at the ${maxPoints}-point limit for this GPU.`);
                return;
              }
              editor.points = next;
              editor.selectedIdx = editor.points.length - 1;
              redraw();
            },
          }),
          el('button', {
            class: 'btn btn-ghost btn-sm',
            text: 'Remove point',
            disabled: editor.points.length <= MIN_CURVE_POINTS,
            onClick: () => {
              editor.points = removePoint(editor.points, editor.selectedIdx);
              editor.selectedIdx = Math.max(0, editor.selectedIdx - 1);
              redraw();
            },
          }),
        ]),
        el('div', { class: 'chips fan-presets' }, fanCurvePresets(domain, maxPoints).map((p) =>
          el('button', {
            class: 'chip chip-btn',
            text: p.name,
            onClick: () => {
              editor.points = clampPointCount(p.points, maxPoints);
              editor.selectedIdx = editor.points.length - 1;
              redraw();
            },
          }),
        )),
      );
      renderDots();
    }

    body.append(
      el('div', { class: 'page-actions fan-apply-row' }, [
        el('button', {
          class: 'btn btn-primary',
          text: 'Apply fan settings',
          onClick: () => void applyFan(),
        }),
        el('button', {
          class: 'btn btn-ghost',
          text: 'Reset to driver curve',
          onClick: () => {
            const cur = ctx.store.get().state?.fanCurve ?? [];
            editor.points = seedCurvePoints(cur, maxPoints);
            editor.selectedIdx = Math.max(0, editor.points.length - 1);
            redraw();
          },
        }),
      ]),
    );
  };

  const applyFan = async () => {
    const live = ctx.store.get();
    const deviceId = live.deviceId;
    const caps = live.caps;
    if (deviceId === null || !caps) return;
    const settings = buildFanSettings(editor.mode, editor.points, editor.fixedPct);
    if (!validateSettingsPayload(settings)) {
      toast('error', 'Apply aborted', 'The settings payload failed validation — this is a bug.');
      return;
    }
    const decision = await ensureWaiver(deviceId, caps.waiverAccepted, caps.deviceName || 'this GPU');
    if (decision === 'cancelled') {
      toast('info', 'Apply cancelled', 'The warranty waiver must be accepted before changing fan settings.');
      return;
    }
    try {
      const { result, state: fresh } = await api.applySettings(deviceId, settings);
      ctx.store.set({ state: fresh });
      // M3-A: record the outcome for the dashboard "OC working" health row.
      const failedFan = Object.entries(result.perControl)
        .filter(([, per]) => !per.ok)
        .map(([k, per]) => `${k}: ${per.message ?? per.errorCode ?? 'failed'}`)
        .join('; ');
      ctx.store.set({ lastApply: { ok: result.ok, at: Date.now(), detail: result.ok ? 'Fan settings applied' : failedFan } });
      for (const [key, per] of Object.entries(result.perControl)) {
        if (per.ok) toast('success', `${key === 'fanMode' ? 'Fan mode' : 'Fan curve'} applied`, '');
        // F3 instant: refusals carry the composed actionable message; hard
        // errors keep the errorCode mapping (same as the OC page).
        else toast('error', 'Fan apply failed', per.message ?? errorMessage(per.errorCode, key));
      }
      ctx.store.set({ caps: { ...caps, waiverAccepted: true } });
    } catch (err) {
      ctx.store.set({ lastApply: { ok: false, at: Date.now(), detail: err instanceof Error ? err.message : String(err) } });
      toast('error', 'Apply failed', err instanceof Error ? err.message : String(err));
    }
  };

  redraw();
}

// ---------------------------------------------------------------------------
// Shared SVG curve view
// ---------------------------------------------------------------------------

/**
 * The right-side 0-100% axis (M2C-B B1): one label per horizontal grid
 * line, aligned to the same normalized y — the labels live OUTSIDE the
 * plot (they used to sit inside the SVG at x:99/x:1).
 */
function fanAxis(): HTMLElement {
  return el('div', { class: 'fan-yaxis' }, fanSpeedTicks().map((tick) => {
    const label = el('span', { class: 'fan-yaxis-tick', text: `${tick.pct}%` });
    label.style.top = `${tick.y}%`;
    // Edge labels keep their FULL height inside .fan-stage (overflow:hidden):
    // the top tick hangs below the 100% grid line, the bottom tick sits
    // above the 0% line — the interior ticks stay centered (translateY(-50%)).
    if (tick.y === 0) label.classList.add('fan-yaxis-tick-edge-top');
    if (tick.y === 100) label.classList.add('fan-yaxis-tick-edge-bottom');
    return label;
  }));
}

function editorSvg(points: CurvePoint[], maxRpm: number, interactive: boolean, domain = curveDomain(points)): HTMLElement {
  const svg = svgEl('svg', {
    viewBox: '0 0 100 100',
    preserveAspectRatio: 'none',
    class: 'fan-svg',
  });
  svg.append(
    svgEl('rect', { x: 0, y: 0, width: 100, height: 100, class: 'fan-grid-bg' }),
  );
  for (let i = 0; i <= 4; i++) {
    const y = i * 25;
    svg.append(svgEl('line', { x1: 0, y1: y, x2: 100, y2: y, class: 'fan-grid-h' }));
  }
  for (let i = 0; i <= 4; i++) {
    const x = i * 25;
    svg.append(svgEl('line', { x1: x, y1: 0, x2: x, y2: 100, class: 'fan-grid-v' }));
  }
  if (points.length >= 2) {
    const d = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${tempToX(p.t, domain).toFixed(2)},${(100 - p.speedPct).toFixed(2)}`)
      .join(' ');
    svg.append(svgEl('path', { d, class: 'fan-polyline' }));
  }
  if (maxRpm > 0) {
    const y = rpmMarkerY(100, maxRpm);
    svg.append(svgEl('line', { x1: 0, y1: y, x2: 100, y2: y, class: 'fan-maxline' }));
  }
  const elNode = svg as unknown as HTMLElement;
  if (interactive) elNode.dataset['interactive'] = '1';
  return elNode;
}
