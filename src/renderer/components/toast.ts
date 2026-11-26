// Arc Power - toast notifications (bottom-right stack, auto-dismiss).

import { el } from '../dom.ts';

export type ToastKind = 'success' | 'error' | 'warn' | 'info';
export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}
export interface ToastDiagnosticsContext {
  kind: ToastKind;
  title: string;
  message: string;
}

const STACK_ID = 'toast-stack';
const DIAGNOSTICS_LABEL = 'Copy diagnostics';

type DiagnosticsHandler = (context: ToastDiagnosticsContext) => void | Promise<void>;

let diagnosticsHandler: DiagnosticsHandler | null = null;

/** Registered once by the app shell; every error toast then offers the copy. */
export function setErrorDiagnosticsHandler(handler: DiagnosticsHandler | null): void {
  diagnosticsHandler = handler;
}

function stack(): HTMLElement {
  let node = document.getElementById(STACK_ID);
  if (!node) {
    node = el('div', { id: STACK_ID, class: 'toast-stack' });
    document.body.append(node);
  }
  return node;
}

const DISMISS_MS: Record<ToastKind, number> = { success: 3500, error: 8000, warn: 6000, info: 4000 };

export function toast(kind: ToastKind, title: string, message = '', action?: ToastAction): void {
  const nodes: Node[] = [el('div', { class: 'toast-title' }, [title])];
  if (message) nodes.push(el('div', { class: 'toast-message', text: message }));
  const actions: HTMLElement[] = [];
  const addAction = (label: string, run: () => void | Promise<void>, doneLabel?: string): void => {
    const button = el('button', { class: 'toast-action', type: 'button', text: label }) as HTMLButtonElement;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      void (async () => {
        try { await run(); } catch { /* the action owns its own error surface */ }
        if (doneLabel) { button.textContent = doneLabel; button.disabled = true; }
      })();
    });
    actions.push(button);
  };
  if (action) addAction(action.label, action.run);
  if (kind === 'error' && diagnosticsHandler) {
    addAction(DIAGNOSTICS_LABEL, () => diagnosticsHandler?.({ kind, title, message }), 'Copied');
  }
  if (actions.length > 0) nodes.push(el('div', { class: 'toast-actions' }, actions));
  const item = el('div', { class: `toast toast-${kind}`, dataset: { kind } }, nodes);
  item.addEventListener('click', () => item.remove());
  stack().append(item);
  window.setTimeout(() => item.remove(), DISMISS_MS[kind]);
}
