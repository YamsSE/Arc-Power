import test from 'node:test';
import assert from 'node:assert/strict';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.attributes = {};
    this.children = [];
    this.listeners = new Map();
    this._textContent = '';
  }

  set textContent(value) { this._textContent = String(value); this.children = []; }
  get textContent() { return this._textContent + this.children.map((child) => child.textContent ?? String(child)).join(''); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  focus() {}
  async click() {
    for (const listener of this.listeners.get('click') ?? []) {
      await listener({ target: this, currentTarget: this });
    }
  }
}

function findByText(node, tagName, text) {
  if (node.tagName === tagName.toUpperCase() && node.textContent === text) return node;
  for (const child of node.children) {
    const match = findByText(child, tagName, text);
    if (match) return match;
  }
  return null;
}

test('Intel driver page opens only after confirmation, and Cancel never opens it', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const root = new FakeElement('div');
  const opened = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: (tagName) => new FakeElement(tagName), getElementById: (id) => id === 'modal-root' ? root : null },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { arcPower: { openIntelDriverDownloadPage: async (kind) => { opened.push(kind); } } },
  });

  try {
    const { showIntelDriverUpdateDialog } = await import('../src/renderer/components/intel-driver-update-dialog.ts');
    const release = { version: '32.0.101.8805', releaseDate: null, officialPageUrl: 'https://www.intel.com/unused-in-renderer' };
    showIntelDriverUpdateDialog('arc', '32.0.101.7000', release);
    assert.deepEqual(opened, [], 'showing the dialog alone does not open Intel');
    await findByText(root, 'button', 'Cancel').click();
    assert.deepEqual(opened, [], 'Cancel does not open Intel');
    assert.deepEqual(root.children, []);

    showIntelDriverUpdateDialog('pro', '32.0.101.7000', release);
    assert.deepEqual(opened, [], 'opening a second dialog still waits for confirmation');
    await findByText(root, 'button', 'Continue to Intel').click();
    assert.deepEqual(opened, ['pro'], 'confirmation opens only the fixed Intel page channel selected for the GPU');
    assert.deepEqual(root.children, []);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    if (originalWindow === undefined) delete globalThis.window;
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  }
});
