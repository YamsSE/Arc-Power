// Arc Power — Fan curve editor (M4-D2 §8): the Tuning page's fan sub-view.
// Extracted from the removed Fan page (pages/fan.ts) so the editor lives in
// a shared module used by the Tuning page's "Fan Curve" view toggle.
//
// Read-only (probe-failed / read-only overlay): mode, current curve rendered
// in the SVG view, RPM marker. Full editor when canControl=true (real A770
// via the M3-D probe, and the mock): mode toggle, draggable points,
// add/remove with point-count clamp, ascending-temp enforcement, presets,
// Apply. All editor math lives in pure/curve.ts; this module is the DOM view.
//
// The page shell (title/subtitle) belongs to the Tuning page; this module
// renders ONLY the fan card content. The read-only note + the no-fan note
// live here (the honest states the Tuning page must show in the sub-view).

import { el, clear, svgEl } from '../dom.ts';
import type { PageContext } from '../router.ts';
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

// M4-H (A1): the ADAPTIVE preset chips. The chip NAMES are static; the
// POINTS are derived from the DRIVER's curve read LIVE at click time (N4 —
// a render-time base would go stale after an apply). The three presets:
// 'Driver Curve' = the base itself (the chip REPLACES the old
// "Reset to driver curve" button), 'Quiet' = speeds ×0.5 (clamp 0..100),
// 'Max' = speeds ×1.35 (clamp 0..100). The math lives in pure/curve.ts
// fanCurvePresets (unit-tested); this module only renders the chips.
const PRESET_DEFS: Array<{ id: string; name: string }> = [
  { id: 'driver', name: 'Driver Curve' },
  { id: 'quiet', name: 'Quiet' },
  { id: 'max', name: 'Max' },
];

// M4-B (user): the automatic waiver re-prompt + single retry counter — the
// driver can lose the waiver while settings.json still says accepted; the
// first fan apply then fails with waiver-not-set and re-prompts + retries
// once. Reset on every successful apply. (Module-level: only one fan
// sub-view renders at a time — same pattern as the pages it came from.)
let waiverRetryCount = 0;

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

/**
 * M4-D2: render the fan sub-view into `container` (a fresh element owned by
 * the Tuning page — cleared + re-created on every view switch). Handles the
 * honest states: no-fan device note, canControl=false read-only note, and
 * the full editor.
 */
export function renderFanEditor(container: HTMLElement, ctx: PageContext): void {
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

  // M4-A (user correction): the waiver STATUS lives ONLY in the dashboard
  // GPU Health card — this view keeps no waiver UI beyond the apply-time
  // dialog gate (ensureWaiver in applyFan).

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
}

/**
 * M4-D2: the Tuning page's onUpdate delegates here while the fan sub-view is
 * active — the RPM marker + readout track the telemetry ticks (the same
 * update the old Fan page ran in its onUpdate).
 */
export function updateFanReadout(container: HTMLElement, ctx: PageContext): void {
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
}

// ---------------------------------------------------------------------------
// Read-only view (probe-failed fan / read-only overlay)
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
      el('p', { class: 'card-note', text: 'Editing is disabled: this GPU reports fan control as read-only (canControl=false). The fan stays under driver/IGS management on this card.' }),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Editable editor (canControl=true — real A770 via the M3-D probe, or mock)
// ---------------------------------------------------------------------------

function renderEditor(container: HTMLElement, ctx: PageContext, editor: EditorState, maxPoints: number) {
  const s = ctx.store.get();
  const caps = s.caps as NonNullable<typeof s.caps>;
  const modes = caps.fan.modes.length > 0 ? caps.fan.modes : ['auto', 'curve', 'fixed'];
  // M4-C: the Fixed tab ALWAYS renders — even when the probe never learned
  // 'fixed' (the real A770's learned modes are ['auto','curve']). A mode
  // outside caps.fan.modes renders DISABLED with the honest note; the mode
  // gate refuses its applies anyway.
  const fixedSupported = modes.includes('fixed');
  const toggleModes = fixedSupported ? modes : [...modes, 'fixed'];

  const card = el('section', { class: 'card fan-card' });
  const body = el('div', { class: 'fan-body' });
  card.append(body);
  container.append(card);

  // M4-C: point hover/drag readout state — lives at renderEditor scope so it
  // SURVIVES redraw() (each redraw re-runs the curve branch; any state
  // declared there would reset on every drag move). `domainRef` is the
  // current curve branch's static domain (set at branch start).
  let hoverReadout: HTMLElement | null = null;
  let readoutVisible = false;
  let dragActive = false;
  // M4-H (S2 — the vanish guard): whether the pointer is currently INSIDE
  // the readout popup (pointerenter/pointerleave on the popup). The dot's
  // pointerout must NOT hide while this is true (the popup is a SIBLING of
  // the dots, so moving from a dot into the popup fires the dot's
  // pointerout with relatedTarget inside the popup — the guard below).
  let pointerInsideReadout = false;
  let domainRef = curveDomain([]);
  const readoutContains = (node: EventTarget | null): boolean => {
    if (!hoverReadout || !node || !(node instanceof Node)) return false;
    return node === hoverReadout || hoverReadout.contains(node);
  };
  const showReadout = (idx: number) => {
    const p = editor.points[idx];
    if (!hoverReadout || !p) return;
    // M4-H: showReadout updates a LABEL node + the two input values (never
    // textContent — the popup carries the editable inputs now).
    const label = hoverReadout.querySelector<HTMLElement>('.fan-dot-readout-label');
    const tempInput = hoverReadout.querySelector<HTMLInputElement>('input[data-readout-field="t"]');
    const speedInput = hoverReadout.querySelector<HTMLInputElement>('input[data-readout-field="speed"]');
    if (label) label.textContent = `${p.speedPct}% @ ${p.t} °C · #${idx}`;
    if (tempInput) tempInput.value = String(p.t);
    if (speedInput) speedInput.value = String(p.speedPct);
    hoverReadout.dataset['idx'] = String(idx);
    const xPct = tempToX(p.t, domainRef);
    const yPct = 100 - p.speedPct;
    // M4-C (round-1 fix): the readout must stay FULLY inside the stage —
    // the old above-dot parking (translate(-50%,-100%) + margin-top:-8px)
    // clipped under .fan-stage overflow:hidden for top-edge dots (speed
    // >= ~91%: the default curve's 100% points, the 'Max' preset)
    // and the side edges cut half of it at temp 0/100. Position the box in
    // px against the measured dots layer: flip BELOW the dot when there is
    // no room above (the .fan-dot-readout-below class), and clamp
    // horizontally so the box never leaves the plot. The %-positioned
    // default stays as the fallback when the layer cannot be measured.
    hoverReadout.hidden = false;
    const layer = hoverReadout.parentElement;
    const lr = layer ? layer.getBoundingClientRect() : null;
    if (lr && lr.width > 0 && lr.height > 0) {
      const box = hoverReadout.getBoundingClientRect();
      const dotX = (lr.width * xPct) / 100;
      const dotY = (lr.height * yPct) / 100;
      const flipBelow = dotY - 8 - box.height < 0 && dotY + 10 + box.height <= lr.height;
      hoverReadout.classList.toggle('fan-dot-readout-below', flipBelow);
      hoverReadout.style.left = `${Math.min(Math.max(box.width / 2, dotX), lr.width - box.width / 2)}px`;
      hoverReadout.style.top = `${dotY}px`;
      readoutVisible = true;
      return;
    }
    hoverReadout.classList.remove('fan-dot-readout-below');
    hoverReadout.style.left = `${xPct}%`;
    hoverReadout.style.top = `${yPct}%`;
    readoutVisible = true;
  };
  const hideReadout = () => {
    if (hoverReadout) hoverReadout.hidden = true;
    readoutVisible = false;
    pointerInsideReadout = false;
  };
  // M4-C (round-1 fix): drop ALL hover/drag state + hide the box — used by
  // the non-drag redraw triggers (mode toggle, presets, reset, add/remove)
  // where a carried-over readout used to pop up with no pointer near a dot.
  const resetReadout = () => {
    if (hoverReadout) hoverReadout.hidden = true;
    readoutVisible = false;
    dragActive = false;
    pointerInsideReadout = false;
  };

  const redraw = () => {
    clear(body);
    body.append(
      el('div', { class: 'chips fan-mode-toggle' }, toggleModes.map((m) => {
        const supported = modes.includes(m);
        return el('button', {
          class: `chip chip-btn${editor.mode === m ? ' chip-active' : ''}${supported ? '' : ' chip-disabled'}`,
          text: MODE_NAMES[m] ?? m,
          disabled: !supported,
          title: supported ? undefined : 'Fixed speed is not supported on this GPU',
          onClick: () => {
            // M4-C (round-1 fix): a stale hover/drag readout must never
            // survive a mode switch — only the curve branch may re-show it
            // (the old state popped the readout up on returning to Curve
            // with no pointer anywhere near a dot).
            resetReadout();
            editor.mode = m as FanMode;
            redraw();
          },
        });
      })),
      // M4-C: the honest note whenever the Fixed tab is disabled — the chip
      // is visible, but this GPU refuses fixed writes.
      ...(fixedSupported ? [] : [el('p', { class: 'card-note fan-fixed-note', text: 'Fixed speed is not supported on this GPU.' })]),
    );

    if (editor.mode === 'auto') {
      // M4-C (round-1 fix, defensive): only the curve branch may re-show
      // the readout — the non-curve branches always start with it cleared.
      resetReadout();
      body.append(
        el('div', { class: 'fan-auto-note', text: 'Auto mode: the driver controls the fan automatically. Apply to switch modes.' }),
      );
    } else if (editor.mode === 'fixed') {
      resetReadout();
      if (!fixedSupported) {
        // M4-C (defensive): the disabled chip cannot be selected, but a
        // modeFromCaps fallback could land here — never offer the slider on
        // a card that cannot write it.
        body.append(
          el('div', { class: 'fan-auto-note', text: 'Fixed speed is not supported on this GPU. The mode toggle cannot enable it.' }),
        );
      } else {
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
      }
    } else {
      // --- curve mode: SVG + overlay dots ---
      const domain = curveDomain(editor.points);
      domainRef = domain;
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
          // M4-C: hovering a dot shows the readout; the drag keeps it live.
          dot.addEventListener('pointerover', () => showReadout(idx));
          // M4-H (S2 — the vanish guard): the popup is a SIBLING of the
          // dots, so moving from a dot into the popup fires this pointerout
          // with relatedTarget INSIDE the popup — hiding then would kill
          // the popup before a click can land. Hide only when the pointer
          // left for somewhere OUTSIDE the popup (and never mid-drag).
          dot.addEventListener('pointerout', (ev: PointerEvent) => {
            if (dragActive) return;
            if (readoutContains(ev.relatedTarget) || pointerInsideReadout) return;
            hideReadout();
          });
          dot.addEventListener('pointerdown', (ev) => {
            ev.preventDefault();
            // Synthetic events (ui-verify) have no active pointer — the
            // capture is best-effort there.
            try { dot.setPointerCapture(ev.pointerId); } catch { /* no active pointer */ }
            editor.selectedIdx = idx;
            dragActive = true;
            // M4-C: a drag shows the readout even without a prior hover
            // (renderDots restores it via readoutVisible).
            readoutVisible = true;
            renderDots();
            const rect = stage.getBoundingClientRect();
            const onMove = (me: PointerEvent) => {
              const x = ((me.clientX - rect.left) / rect.width) * 100;
              const y = ((me.clientY - rect.top) / rect.height) * 100;
              const t = xToTemp(x, domain);
              const speed = 100 - Math.min(100, Math.max(0, y));
              editor.points = movePoint(editor.points, idx, t, speed);
              redraw(); // renderDots restores the readout via readoutVisible
            };
            const onUp = () => {
              window.removeEventListener('pointermove', onMove);
              window.removeEventListener('pointerup', onUp);
              dragActive = false;
              hideReadout();
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
          });
          dotsLayer.append(dot);
        });
        // M4-C: the readout sits on top of the dots and is restored on
        // every layer rebuild — during a drag each redraw re-positions it
        // at the moved point.
        // M4-H: the popup is now EDITABLE — a label node + two inputs
        // (Fan % + Temp) with the old box clamps (empty keeps the value;
        // temp clamped to the domain AND between neighbors; speed clamped
        // 0..100; the clamped value reflected back; the dot + readout sync
        // IN PLACE so typing keeps focus). The inputs need
        // pointer-events: auto (CSS) and the vanish guard above keeps the
        // popup alive while the pointer is inside it.
        hoverReadout = el('div', { class: 'fan-dot-readout', hidden: true, dataset: { idx: String(editor.selectedIdx) } }, [
          el('span', { class: 'fan-dot-readout-label' }),
          el('div', { class: 'fan-dot-readout-fields' }, [
            el('label', { class: 'fan-dot-readout-field' }, [
              el('span', { class: 'fan-dot-readout-field-label', text: 'Fan %' }),
              el('input', {
                type: 'number',
                class: 'fan-readout-input',
                dataset: { readoutField: 'speed' },
                min: 0,
                max: 100,
                step: 1,
                oninput: (e: Event) => onEditPoint(Number(hoverReadout?.dataset['idx'] ?? 0), Number((e.target as HTMLInputElement).value), e.target as HTMLInputElement, 'speed'),
              }),
            ]),
            el('label', { class: 'fan-dot-readout-field' }, [
              el('span', { class: 'fan-dot-readout-field-label', text: 'Temp' }),
              el('input', {
                type: 'number',
                class: 'fan-readout-input',
                dataset: { readoutField: 't' },
                min: domain.minT,
                max: domain.maxT,
                step: 1,
                oninput: (e: Event) => onEditPoint(Number(hoverReadout?.dataset['idx'] ?? 0), Number((e.target as HTMLInputElement).value), e.target as HTMLInputElement, 't'),
              }),
            ]),
          ]),
        ]);
        // M4-H (S2): the popup's own pointer state feeds the vanish guard —
        // the dot's pointerout keeps the popup alive while the pointer is
        // over it; the blur rule below only hides when focus leaves BOTH
        // inputs while the pointer is NOT over the popup.
        hoverReadout.addEventListener('pointerenter', () => { pointerInsideReadout = true; });
        hoverReadout.addEventListener('pointerleave', () => {
          pointerInsideReadout = false;
          // M4-H review nit 1: the pointer left the popup to empty stage
          // space with nothing focused — hide (an edit keeps the box via
          // the focus rule below; a move onto a dot re-shows it).
          if (dragActive) return;
          if (!hoverReadout || !hoverReadout.contains(document.activeElement)) hideReadout();
        });
        hoverReadout.addEventListener('focusout', (ev: FocusEvent) => {
          if (readoutContains(ev.relatedTarget)) return; // focus moved between the inputs
          if (pointerInsideReadout) return; // the pointer is over the popup — keep it
          if (dragActive) return; // M4-H review nit 2: a dot drag hides the box via blur — keep it live for the drag
          hideReadout();
        });
        dotsLayer.append(hoverReadout);
        if (readoutVisible) showReadout(editor.selectedIdx);
      };

      // M4-H (A2): the popup-edit path — the SAME clamp semantics the old
      // per-point boxes had, applied to the popup's two inputs. All math
      // stays in pure/curve.ts (movePoint for the temp clamp-between +
      // speed 0..100 clamp, clampPointCount for the count clamp). The dot +
      // readout sync IN PLACE so typing keeps focus (a full redraw would
      // drop the caret).

      const onEditPoint = (idx: number, raw: number, input: HTMLInputElement, field: 't' | 'speed') => {
        // M4-C (round-2 fix): an EMPTIED box is not a typed value —
        // Number('') === 0 is finite, so the old code instantly moved the
        // point to 0 °C / 0 % (or the between-neighbor clamp), rewrote the
        // box to '0', and a blur without retyping left the point at 0 — a
        // curve mutation the user never intended. Same empty-input policy
        // as the gpuLock editor (parseGpuLockInput rejects '' for exactly
        // this reason): keep the previous value and leave the box as the
        // user left it.
        if (input.value.trim() === '') return;
        if (!Number.isFinite(raw)) return;
        const cur = editor.points[idx];
        // M4-C (round-1 fix): the EDIT path must clamp to the static
        // 0..100 domain exactly like the drag path does (xToTemp clamps).
        // clampTempBetween only clamps BETWEEN neighbors, so typing 150 / -5
        // into the OUTER points (no neighbor on that side) used to reach the
        // driver table unclamped — the min/max attributes are advisory.
        const t = field === 't' ? Math.min(domain.maxT, Math.max(domain.minT, raw)) : cur.t;
        editor.points = clampPointCount(
          field === 't' ? movePoint(editor.points, idx, t, cur.speedPct) : movePoint(editor.points, idx, cur.t, raw),
          maxPoints,
        );
        editor.selectedIdx = idx;
        const moved = editor.points[idx];
        // The clamped value is the honest one — reflect it back into the box.
        if (field === 't' && String(input.value) !== String(moved.t)) input.value = String(moved.t);
        if (field === 'speed' && String(input.value) !== String(moved.speedPct)) input.value = String(moved.speedPct);
        const dot = dotsLayer.querySelector<HTMLElement>(`.fan-dot[data-idx="${idx}"]`);
        if (dot) {
          dot.dataset.t = String(moved.t);
          dot.dataset.speed = String(moved.speedPct);
          dot.style.left = `${tempToX(moved.t, domain)}%`;
          dot.style.top = `${100 - moved.speedPct}%`;
        }
        dotsLayer.querySelectorAll('.fan-dot').forEach((d) => {
          d.classList.toggle('fan-dot-selected', Number((d as HTMLElement).dataset.idx) === idx);
        });
        if (readoutVisible) showReadout(idx);
      };

      const maxReached = editor.points.length >= maxPoints;

      body.append(
        stage,
        el('div', { class: 'fan-axis' }, [
          el('span', { text: `${domain.minT} °C` }),
          el('span', { class: 'fan-axis-mid', text: `${Math.round((domain.minT + domain.maxT) / 2)} °C` }),
          el('span', { text: `${domain.maxT} °C` }),
        ]),
        // M4-H (A2): the per-point boxes row (.fan-points-editor) is
        // DELETED — the popup's two inputs replace it. The Add/Remove
        // point action row stays.
        el('div', { class: 'fan-actions' }, [
          el('button', {
            class: 'btn btn-ghost btn-sm',
            text: 'Add point',
            disabled: maxReached,
            title: maxReached ? `Point limit reached (${maxPoints})` : 'Insert a point at the widest gap',
            onClick: () => {
              resetReadout();
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
              resetReadout();
              editor.points = removePoint(editor.points, editor.selectedIdx);
              editor.selectedIdx = Math.max(0, editor.selectedIdx - 1);
              redraw();
            },
          }),
        ]),
        // M4-H (A1): the ADAPTIVE preset chips — the base (the driver's
        // curve) is read LIVE at click time (seedCurvePoints, the same seed
        // the editor starts from — N4: a render-time base would go stale
        // after an apply). 'Driver Curve' = the base itself; the chip
        // REPLACES the removed "Reset to driver curve" button.
        el('div', { class: 'chips fan-presets' }, PRESET_DEFS.map((def) =>
          el('button', {
            class: 'chip chip-btn',
            text: def.name,
            onClick: () => {
              resetReadout();
              const cur = ctx.store.get().state?.fanCurve ?? [];
              const presets = fanCurvePresets(seedCurvePoints(cur, maxPoints), domain, maxPoints);
              const preset = presets.find((p) => p.id === def.id);
              if (!preset) return;
              editor.points = clampPointCount(preset.points, maxPoints);
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
    // M4-A: an in-page acceptance patches the store caps IMMEDIATELY (not
    // only post-apply) — the dashboard's waiver health row flips green on
    // the next caps-change re-render, and stays green even if the apply
    // below then fails/throws.
    {
      const cur = ctx.store.get();
      if (cur.caps && cur.caps.waiverAccepted !== true) {
        ctx.store.set({ caps: { ...cur.caps, waiverAccepted: true } });
      }
    }
    try {
      const { result, state: fresh } = await api.applySettings(deviceId, settings);
      // M3-C review F2: only store a NON-NULL fresh state — a refusal
      // envelope's null state must never null out the store's device state.
      if (fresh) ctx.store.set({ state: fresh });
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
      // M4-A G2 mirror (the OC page's !result.ok branch): a failed apply can
      // mean the DRIVER lost the waiver (waiver-not-set) — re-fetch the caps
      // so the store flag flips back to unaccepted and the NEXT apply
      // re-shows the waiver dialog (previously the stale accepted flag made
      // every subsequent apply fail WITHOUT a prompt). Never force-accept
      // the store flag on a failed apply.
      if (result.ok) {
        waiverRetryCount = 0;
        ctx.store.set({ caps: { ...caps, waiverAccepted: true } });
      } else {
        const freshCaps = await api.getCapabilities(deviceId);
        ctx.store.set({ caps: freshCaps });
        // M4-B (user): a waiver-not-set failure must not dead-end the first
        // apply with a confusing error — re-prompt the waiver dialog
        // AUTOMATICALLY (the store flag was just refreshed, so the dialog
        // shows) and retry ONCE. Never a loop; the counter resets on the
        // next success.
        if (waiverRetryCount === 0
          && Object.values(result.perControl).some((p) => p?.errorCode === 'waiver-not-set')) {
          waiverRetryCount += 1;
          const live2 = ctx.store.get();
          const decision = await ensureWaiver(deviceId, live2.caps?.waiverAccepted === true, live2.caps?.deviceName || 'this GPU');
          if (decision === 'accepted') {
            // Patch the store caps BEFORE the retry — the retry re-enters
            // the pre-apply waiver gate, which reads the store flag; without
            // the patch it would re-show the dialog (just accepted — no
            // second prompt).
            const cur3 = ctx.store.get();
            if (cur3.caps && cur3.caps.waiverAccepted !== true) {
              ctx.store.set({ caps: { ...cur3.caps, waiverAccepted: true } });
            }
            return applyFan();
          }
        }
      }
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
