// Arc Power — Tweaks page (M3-A): the registry-hacks CATALOG with live,
// read-only current states. Applying is M3-B (every entry needs
// administrator); here each card lists what the tweak is, the registry
// values that prove its state, and the current read (reg.exe query results
// via the registry-catalog IPC — never a write).
//
// The catalog is fetched at boot (app.ts) into the store; the page re-fetches
// only when the store slot is empty (early navigation before boot finished)
// or via the explicit Refresh button. onUpdate re-renders when the store
// slot changes — no polling.

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { api } from '../ipc.ts';
import type { RegistryCatalogResponse, RegistryEntry, RegistryEntryState, RegistryState } from '../types.ts';

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

/** Explicit refresh (read-only reg queries — safe, no elevation). */
async function refreshCatalog(ctx: PageContext): Promise<void> {
  try {
    const catalog = await api.registryCatalog();
    ctx.store.set({ catalog: catalog ?? { entries: [], states: [] } });
  } catch {
    ctx.store.set({ catalog: { entries: [], states: [] } });
  }
}

function tweakCard(entry: RegistryEntry, state: RegistryEntryState | undefined): HTMLElement {
  const level = state ? STATE_LEVEL[state.state] : 'unknown';
  const label = state ? STATE_LABEL[state.state] : 'Unknown';
  const detail = state?.detail ?? 'State not read yet';
  return el('section', { class: 'card tweak-card', 'data-tweak': entry.id }, [
    el('h2', { class: 'card-title tweak-title' }, [
      el('span', { class: `status-dot status-${level}`, title: `${label} — ${detail}` }),
      el('span', { text: entry.name }),
    ]),
    el('div', { class: 'card-body' }, [
      el('p', { class: 'tweak-desc', text: entry.description }),
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
    el('div', { class: 'card-footer' }, [
      el('button', {
        class: 'btn btn-sm tweak-apply',
        disabled: true,
        title: 'Applying registry tweaks requires administrator approval — arrives in M3-B.',
        text: entry.requiresElevation ? 'Requires administrator (M3-B)' : 'Not available',
      }),
    ]),
  ]);
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
        text: 'Well-known, reversible registry tweaks that affect GPU behavior. This build reads the current state only (no writes); applying requires administrator approval and arrives in M3-B.',
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
          ? el('p', { class: 'text-error', text: 'The registry catalog could not be read — no tweaks to show.' })
          : el('div', { class: 'card-stack' }, entries.map((entry) => tweakCard(entry, states.find((s) => s.id === entry.id)))),
    );
    void loadCatalog(ctx);
  },

  onUpdate(container: HTMLElement, ctx: PageContext) {
    const catalog = ctx.store.get().catalog;
    if (catalog !== lastCatalog) tweaksPage.render(container, ctx);
  },
};
