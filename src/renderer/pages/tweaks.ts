// Arc Power - Tweaks page (M3-A catalog + M3-B APPLY). Each card lists what
// the tweak is, the registry values that prove its state, the current read
// (reg.exe query results via the registry-catalog IPC - never a write), and
// - for applyable entries - working Enable/Disable/Revert buttons.
//
// APPLYING (M3-B): the button click calls the registry-apply IPC, which
// resolves the entry's apply descriptor (the exact elevated reg.exe
// commands) in MAIN and runs them in an elevated PowerShell - one UAC
// prompt per action. The result is reported per step (perStep) with honest
// wording: full success, partial failure (which steps landed, no auto-
// rollback - the user reverts via the button), or the UAC-decline message.
// After every apply the catalog is re-read so the card state refreshes.
//
// The catalog is fetched at boot (app.ts) into the store; the page re-fetches
// only when the store slot is empty (early navigation before boot finished)
// or via the explicit Refresh button. onUpdate re-renders when the store
// slot changes - no polling.

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { api } from '../ipc.ts';
import { toast } from '../components/toast.ts';
import type { RegistryApplyStep, RegistryCatalogResponse, RegistryEntry, RegistryEntryState, RegistryState } from '../types.ts';

const STATE_LABEL: Record<RegistryState, string> = {
  enabled: 'Active',
  disabled: 'Off',
  default: 'Default',
  unknown: 'Unknown',
};

/** Dot level per state: active=green, off=amber, default=gray, unexpected=red. */
const STATE_LEVEL: Record<RegistryState, string> = {
  enabled: 'ok',
  disabled: 'warn',
  default: 'unknown',
  unknown: 'error',
};

const ACTION_LABEL = { enable: 'Enable', disable: 'Disable', revert: 'Revert' } as const;
type ApplyAction = keyof typeof ACTION_LABEL;

const TWEAK_META: Record<string, { category: string; risk: string }> = {
  mpo: { category: 'Display', risk: 'Test carefully' },
  hags: { category: 'Scheduling', risk: 'Restart required' },
  'game-dvr': { category: 'Recording', risk: 'System-wide' },
  'fullscreen-optimizations': { category: 'Compatibility', risk: 'Read-only' },
};

/** One elevated apply is in flight - all apply buttons disable until it returns. */
let applyInFlight = false;

/** Human label for one command step (mirrors main's stepLabel - honest tooltips). */
function stepLabel(step: RegistryApplyStep): string {
  return step.kind === 'add'
    ? `${step.value}=${step.data} written to ${step.path}`
    : `${step.value} deleted from ${step.path}`;
}

/** Fetch the catalog once (boot may not have finished on early navigation). */
async function loadCatalog(ctx: PageContext): Promise<void> {
  if (ctx.store.get().catalog !== null) return;
  try {
    const catalog = await api.registryCatalog();
    ctx.store.set({ catalog: catalog ?? { entries: [], states: [] } });
  } catch {
    ctx.store.set({ catalog: { entries: [], states: [] } });
  }
}

/** Explicit refresh (read-only reg queries - safe, no elevation). */
async function refreshCatalog(ctx: PageContext): Promise<void> {
  try {
    const catalog = await api.registryCatalog();
    ctx.store.set({ catalog: catalog ?? { entries: [], states: [] } });
  } catch {
    ctx.store.set({ catalog: { entries: [], states: [] } });
  }
}

/**
 * Toggle every apply button's disabled state. Called at flight START (before
 * the await) so the buttons visually disable for the whole elevation window
 * - the re-render only happens after the apply resolves, so without this the
 * `disabled: applyInFlight` attribute would always render false.
 */
function setApplyButtonsDisabled(disabled: boolean): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.tweak-action')) {
    btn.disabled = disabled;
  }
}

/**
 * Run one elevated apply action. Reports the outcome honestly in a toast:
 * success / partial failure (per-step, no auto-rollback) / UAC decline /
 * timeout / hard error. Always re-reads the catalog afterwards so the card
 * state reflects the registry truth (the elevated side may have landed
 * steps even on a partial failure).
 */
async function runApply(ctx: PageContext, entry: RegistryEntry, action: ApplyAction): Promise<void> {
  if (applyInFlight) return;
  applyInFlight = true;
  setApplyButtonsDisabled(true);
  try {
    if (ctx.store.get().workerApply) {
      toast('info', 'Administrator approval needed', `Applying this tweak requires administrator approval - approve the Windows prompt.`);
    }
    const out = await api.registryApply(entry.id, action);
    if (out.canceled) {
      toast('error', 'Administrator approval required', out.message);
    } else if (out.ok) {
      toast('success', `${ACTION_LABEL[action]} applied`, out.message);
    } else {
      toast('error', `${ACTION_LABEL[action]} partially failed`, out.message);
    }
  } catch (err) {
    toast('error', 'Apply failed', err instanceof Error ? err.message : String(err));
  } finally {
    applyInFlight = false;
    setApplyButtonsDisabled(false);
    await refreshCatalog(ctx);
  }
}

function actionButtons(entry: RegistryEntry, onApply: (action: ApplyAction) => void): HTMLElement {
  const descriptor = entry.apply;
  if (!descriptor?.applyable) {
    return el('p', { class: 'tweak-readonly-note', text: descriptor?.revertNote ?? 'Read-only info - no system-wide setting to apply.' });
  }
  const tooltip = (action: ApplyAction): string => {
    const steps = descriptor.actions?.[action] ?? [];
    return `${ACTION_LABEL[action]} the tweak: ${steps.map(stepLabel).join('; ')}`;
  };
  return el('div', { class: 'tweak-actions' }, [
    ...(['enable', 'disable'] as const).map((action) =>
      el('button', {
        class: `btn btn-sm tweak-action tweak-${action}${action === 'enable' ? ' btn-primary' : ' btn-ghost'}`,
        dataset: { action },
        disabled: applyInFlight,
        title: tooltip(action),
        text: ACTION_LABEL[action],
        onClick: () => onApply(action),
      }),
    ),
    el('button', {
      class: 'btn btn-sm btn-ghost btn-danger-text tweak-action tweak-revert',
      dataset: { action: 'revert' },
      disabled: applyInFlight,
      title: tooltip('revert'),
      text: 'Revert',
      onClick: () => onApply('revert'),
    }),
    el('p', { class: 'tweak-revert-note', text: descriptor.revertNote }),
  ]);
}

function tweakDescription(entry: RegistryEntry, state: RegistryEntryState | undefined): string {
  if (entry.id === 'mpo') {
    if (state?.state === 'enabled') return 'MPO suppression is enabled with MPOHack and DWM OverlayTestMode=5. Disable or Revert to restore the normal path.';
    if (state?.state === 'disabled') return 'MPO is active. Enable writes both the legacy MPOHack value and DWM OverlayTestMode=5 for compatibility testing.';
    return 'MPO follows the Windows default. Enable writes MPOHack plus DWM OverlayTestMode=5; validate behavior with PresentMon or GPUView.';
  }
  if (entry.id === 'game-dvr') {
    if (state?.state === 'enabled') return 'Background recording is disabled by this tweak. Disable the tweak to restore it.';
    if (state?.state === 'disabled') return 'Background recording is active. Enable the tweak to disable it.';
    return 'Background recording follows the Windows default. Enable the tweak to disable it.';
  }
  if (entry.id === 'fullscreen-optimizations') {
    return 'Windows fullscreen optimizations are controlled per app. Enable this tweak to disable them for the listed apps.';
  }
  return entry.description;
}

function tweakCard(entry: RegistryEntry, state: RegistryEntryState | undefined, onApply: (action: ApplyAction) => void): HTMLElement {
  const level = state ? STATE_LEVEL[state.state] : 'unknown';
  const label = state ? STATE_LABEL[state.state] : 'Unknown';
  const detail = state?.detail ?? 'State not read yet';
  const meta = TWEAK_META[entry.id] ?? { category: 'System', risk: entry.apply?.applyable ? 'Reversible' : 'Read-only' };
  const content = el('div', { class: 'tweak-collapse-body is-collapsed', 'aria-hidden': 'true' }, [
    el('div', { class: 'tweak-collapse-inner' }, [
      el('div', { class: 'card-body' }, [
        el('p', { class: 'tweak-desc', text: tweakDescription(entry, state) }),
        el('div', { class: 'tweak-state' }, [
          el('span', { class: `tweak-state-label text-${level}`, text: label }),
          el('span', { class: 'tweak-state-detail', text: detail }),
        ]),
        state && state.reads.length > 0
          ? el('div', { class: 'tweak-reads' }, state.reads.map((r) =>
              el('div', { class: 'tweak-read' }, [
                el('span', { class: 'tweak-read-path', text: r.read.value ? `${r.read.path}\\${r.read.value}` : r.read.path }),
                el('span', { class: 'tweak-read-data', text: r.found ? (r.value ?? r.detail) : 'not present' }),
              ]),
            ))
          : null,
      ]),
      el('div', { class: 'card-footer' }, [actionButtons(entry, onApply)]),
    ]),
  ]);
  const title = el('button', { class: 'card-title tweak-title', type: 'button', 'aria-expanded': 'false' }, [
      el('span', { class: `status-dot status-${level}`, title: `${label} - ${detail}` }),
      el('span', { text: entry.name }),
      el('span', { class: 'tweak-meta-badges' }, [
        el('span', { class: 'tweak-meta-badge', text: meta.category }),
        el('span', { class: 'tweak-meta-badge tweak-meta-risk', text: meta.risk }),
      ]),
      el('span', { class: 'tweak-chevron', text: '▸', 'aria-hidden': 'true' }),
  ]);
  title.addEventListener('click', () => {
    const open = !content.classList.contains('is-collapsed');
    content.classList.toggle('is-collapsed', open);
    content.setAttribute('aria-hidden', String(open));
    title.setAttribute('aria-expanded', String(!open));
    const chevron = title.querySelector<HTMLElement>('.tweak-chevron');
    if (chevron) chevron.textContent = open ? '▸' : '▾';
  });
  return el('section', { class: 'card tweak-card', 'data-tweak': entry.id }, [title, content]);
}

let lastCatalog: RegistryCatalogResponse | null = null;

export const tweaksPage: Page = {
  id: 'tweaks',

  render(container: HTMLElement, ctx: PageContext) {
    const catalog = ctx.store.get().catalog;
    lastCatalog = catalog;
    const entries = catalog?.entries ?? [];
    const states = catalog?.states ?? [];

    clear(container);
    container.append(
      el('h1', { class: 'page-title', text: 'Tweaks' }),
      el('p', {
        class: 'page-subtitle',
        text: 'Reversible GPU registry tweaks. Enable/Disable/Revert run elevated (one prompt per action).',
      }),
      el('div', { class: 'page-actions' }, [
        el('button', {
          class: 'btn btn-sm tweak-refresh',
          text: 'Refresh state',
          onClick: () => { void refreshCatalog(ctx); },
        }),
      ]),
      catalog === null
        ? el('p', { class: 'text-unknown', text: 'Loading registry state…' })
        : entries.length === 0
          ? el('p', { class: 'text-error', text: 'The registry catalog could not be read - no tweaks to show.' })
          : el('div', { class: 'card-stack' }, entries.map((entry) =>
              tweakCard(entry, states.find((s) => s.id === entry.id), (action) => {
                void runApply(ctx, entry, action);
              }),
            )),
    );
    void loadCatalog(ctx);
  },

  onUpdate(container: HTMLElement, ctx: PageContext) {
    const catalog = ctx.store.get().catalog;
    if (catalog !== lastCatalog) tweaksPage.render(container, ctx);
  },
};
