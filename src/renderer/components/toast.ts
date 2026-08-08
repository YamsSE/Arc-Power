// Arc Power - toast notifications (bottom-right stack, auto-dismiss).

import { el } from '../dom.ts';

export type ToastKind = 'success' | 'error' | 'warn' | 'info';

const STACK_ID = 'toast-stack';

function stack(): HTMLElement {
  let node = document.getElementById(STACK_ID);
  if (!node) {
    node = el('div', { id: STACK_ID, class: 'toast-stack' });
    document.body.append(node);
  }
  return node;
}

const DISMISS_MS: Record<ToastKind, number> = { success: 3500, error: 8000, warn: 6000, info: 4000 };

export function toast(kind: ToastKind, title: string, message = ''): void {
  const item = el('div', { class: `toast toast-${kind}`, dataset: { kind } }, [
    el('div', { class: 'toast-title' }, [title]),
    message ? el('div', { class: 'toast-message', text: message }) : null,
  ]);
  item.addEventListener('click', () => item.remove());
  stack().append(item);
  window.setTimeout(() => item.remove(), DISMISS_MS[kind]);
}
