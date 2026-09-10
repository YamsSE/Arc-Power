// Renderer-only keyboard capture helpers for the Recording hotkey picker.
// Keep this grammar aligned with the recording backend's Electron accelerator
// normalization: optional Control/Alt/Shift modifiers and a final letter,
// number, or F1-F24 key.

export type RecordingHotkeyKeyboardEvent = Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

const FUNCTION_KEY_PATTERN = /^F(?:[1-9]|1[0-9]|2[0-4])$/;
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta']);

function keyFromEvent(event: RecordingHotkeyKeyboardEvent): string | null {
  // KeyboardEvent.key is layout-aware (for example, a German QWERTZ Z key
  // reports "z"). Prefer that logical key so the displayed accelerator is the
  // key the user actually pressed, then use code only for synthetic or
  // incomplete events that do not expose a usable key value.
  const key = typeof event.key === 'string' ? event.key.toUpperCase() : '';
  if (/^[A-Z0-9]$/.test(key) || FUNCTION_KEY_PATTERN.test(key)) return key;

  const code = typeof event.code === 'string' ? event.code : '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^(?:Digit|Numpad)[0-9]$/.test(code)) return code.replace(/^(?:Digit|Numpad)/, '');
  if (FUNCTION_KEY_PATTERN.test(code)) return code;

  return null;
}

/** Convert a browser keydown event into the Electron accelerator grammar. */
export function recordingAcceleratorFromKeyboardEvent(event: RecordingHotkeyKeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key) || event.metaKey) return null;
  const key = keyFromEvent(event);
  if (!key) return null;
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('Control');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  return [...modifiers, key].join('+');
}
