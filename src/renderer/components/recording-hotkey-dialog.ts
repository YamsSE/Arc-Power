import { el, clear } from '../dom.ts';
import { recordingAcceleratorFromKeyboardEvent } from '../pure/recording-hotkey.ts';

const ROOT_ID = 'modal-root';

function modalRoot(): HTMLElement {
  return document.getElementById(ROOT_ID) ?? (() => {
    const root = el('div', { id: ROOT_ID });
    document.body.append(root);
    return root;
  })();
}

/** Capture one supported keyboard accelerator without persisting it. */
export function showRecordingHotkeyDialog(label: string, current: string): Promise<string | null> {
  return new Promise((resolve) => {
    const root = modalRoot();
    clear(root);
    let closed = false;
    const finish = (value: string | null): void => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKeyDown, true);
      clear(root);
      resolve(value);
    };
    const value = el('div', { class: 'recording-hotkey-dialog-value', role: 'status', 'aria-live': 'polite', text: current || 'Waiting…' });
    const hint = el('p', { class: 'recording-hotkey-dialog-hint', text: 'Press a letter, number, or F1–F24. Ctrl, Alt, and Shift can be combined.' });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(null);
        return;
      }
      // Keep focus inside this small dialog. Cancel is currently the only
      // focusable control, so both Tab directions remain on that button.
      if (event.key === 'Tab') {
        event.preventDefault();
        cancel.focus();
        return;
      }
      // Leave activation of the focused Cancel button alone. The document
      // listener runs in capture phase, so preventing Enter/Space here would
      // make the only modal action unreachable from the keyboard.
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') return;
      if (MODIFIER_ONLY_KEYS.has(event.key)) return;
      const accelerator = recordingAcceleratorFromKeyboardEvent(event);
      if (!accelerator) {
        event.preventDefault();
        hint.textContent = 'That key is not supported. Use a letter, number, or F1–F24, with optional Ctrl, Alt, or Shift.';
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      value.textContent = accelerator;
      finish(accelerator);
    };
    const cancel = el('button', { class: 'btn btn-ghost', text: 'Cancel', type: 'button', onClick: () => finish(null) });
    const overlay = el('div', {
      class: 'modal-overlay recording-hotkey-dialog-overlay',
      onClick: (event: Event) => { if (event.target === overlay) finish(null); },
    }, [
      el('div', {
        class: 'modal recording-hotkey-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'recording-hotkey-dialog-title',
        'aria-describedby': 'recording-hotkey-dialog-description',
      }, [
        el('span', { class: 'recording-eyebrow', text: 'Shortcuts' }),
        el('h2', { class: 'modal-title', id: 'recording-hotkey-dialog-title', text: `Set ${label} hotkey` }),
        el('p', { class: 'modal-text', id: 'recording-hotkey-dialog-description', text: 'Press the exact key or key combination you want to use.' }),
        el('div', { class: 'recording-hotkey-dialog-capture' }, [
          el('span', { class: 'recording-hotkey-dialog-capture-label', text: 'Listening for input' }),
          value,
        ]),
        hint,
        el('div', { class: 'modal-actions' }, [cancel]),
      ]),
    ]);
    root.append(overlay);
    document.addEventListener('keydown', onKeyDown, true);
    cancel.focus();
  });
}

const MODIFIER_ONLY_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta']);
