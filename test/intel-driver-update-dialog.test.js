import test from 'node:test';
import assert from 'node:assert/strict';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.attributes = {};
    this.children = [];
    this.listeners = new Map();
    this._textContent = '';
    this.disabled = false;
    this.checked = false;
    this.value = 0;
    this.className = '';
  }
  set textContent(value) { this._textContent = String(value); this.children = []; }
  get textContent() { return this._textContent + this.children.map((child) => child.textContent ?? String(child)).join(''); }
  setAttribute(name, value) {
    this.attributes[name] = value;
    if (name === 'disabled') this.disabled = true;
  }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  focus() {}
  async click() {
    if (this.disabled) return;
    for (const listener of this.listeners.get('click') ?? []) {
      await listener({ target: this, currentTarget: this, preventDefault() {} });
    }
  }
  dispatch(name) {
    for (const listener of this.listeners.get(name) ?? []) listener({ target: this, currentTarget: this });
  }
}

function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of node.children) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}

function button(root, label) { return find(root, (node) => node.tagName === 'BUTTON' && node.textContent === label); }

test('Intel driver popup gates downloads, tracks matching progress, cancels, and offers install choices', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const body = new FakeElement('body');
  const listeners = new Set();
  const calls = { start: [], cancel: [], install: [], opened: [] };
  let resolveStart;
  let failInstall = false;
  const api = {
    intelDriverDownloadStart: (...args) => {
      calls.start.push(args);
      return new Promise((resolve) => { resolveStart = resolve; });
    },
    intelDriverDownloadCancel: async (kind) => { calls.cancel.push(kind); return { cancelled: true }; },
    intelDriverInstall: async (...args) => {
      calls.install.push(args);
      if (failInstall) throw new Error('launch failed');
      return { launched: true };
    },
    onIntelDriverDownloadProgress: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    openIntelDriverDownloadPage: async (kind) => { calls.opened.push(kind); },
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { body, createElement: (tagName) => new FakeElement(tagName), getElementById: (id) => body.children.find((child) => child.attributes.id === id) ?? null },
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { arcPower: api } });

  try {
    const { showIntelDriverUpdateDialog } = await import('../src/renderer/components/intel-driver-update-dialog.ts');
    const release = { version: '32.0.101.8805', releaseDate: null, officialPageUrl: 'https://www.intel.com/unused-in-renderer' };
    showIntelDriverUpdateDialog('arc', '32.0.101.7000', release);
    const root = body.children.find((child) => child.attributes.id === 'modal-root');
    let download = button(root, 'Download');
    const license = find(root, (node) => node.tagName === 'INPUT' && node.attributes.type === 'checkbox');
    assert.ok(download.disabled, 'unchecked license disables Download');
    await download.click();
    assert.equal(calls.start.length, 0, 'download does not start before license acceptance');
    license.checked = true;
    license.dispatch('change');
    assert.equal(download.disabled, false);

    const downloadRequest = download.listeners.get('click')[0]({ target: download, currentTarget: download });
    assert.deepEqual(calls.start, [['arc', release.version, true]], 'only the explicit button starts download and passes acceptance');
    assert.equal(listeners.size, 1);
    const progress = find(root, (node) => node.tagName === 'PROGRESS');
    for (const listener of listeners) listener({ kind: 'pro', version: release.version, percent: 90 });
    assert.equal(progress.value, 0, 'other driver kind progress is ignored');
    for (const listener of listeners) listener({ kind: 'arc', version: '32.0.101.9999', percent: 70 });
    assert.equal(progress.value, 0, 'other versions are ignored');
    for (const listener of listeners) listener({ kind: 'arc', version: release.version, percent: 42 });
    assert.equal(progress.value, 42);
    assert.match(root.textContent, /42%/);
    resolveStart({ downloaded: true, sizeBytes: 1234 });
    await downloadRequest;
    assert.equal(listeners.size, 0, 'progress listener is removed when download completes');
    assert.ok(button(root, 'Install Now'));
    assert.ok(button(root, 'Install Later'));
    await button(root, 'Install Later').click();
    assert.deepEqual(root.children, []);

    showIntelDriverUpdateDialog('arc', '32.0.101.7000', release, true);
    failInstall = true;
    await button(root, 'Install Now').click();
    assert.match(root.textContent, /Could not launch the Intel driver installer/);
    assert.ok(button(root, 'Install Now'), 'install failure leaves the dialog available for retry');
    failInstall = false;
    await button(root, 'Install Now').click();
    assert.deepEqual(calls.install, [['arc', release.version], ['arc', release.version]]);
    assert.deepEqual(root.children, [], 'successful Install Now closes the popup');

    showIntelDriverUpdateDialog('pro', '32.0.101.7000', release);
    const cancelDownload = find(root, (node) => node.tagName === 'BUTTON' && node.textContent === 'Download');
    const proLicense = find(root, (node) => node.tagName === 'INPUT');
    proLicense.checked = true;
    proLicense.dispatch('change');
    const pendingStart = cancelDownload.listeners.get('click')[0]({ target: cancelDownload, currentTarget: cancelDownload });
    assert.equal(listeners.size, 1);
    await button(root, 'Cancel download').click();
    assert.deepEqual(calls.cancel, ['pro'], 'dismissing during download cancels the backend operation');
    assert.equal(listeners.size, 0, 'dismissing unsubscribes progress events');
    resolveStart({ downloaded: true, sizeBytes: 1 });
    await pendingStart;

    const { intelDriverNoticeAction } = await import('../src/renderer/pages/dashboard.ts');
    assert.equal(intelDriverNoticeAction(false), 'New Driver Version Available');
    assert.equal(intelDriverNoticeAction(true), 'Install new Driver now');
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    if (originalWindow === undefined) delete globalThis.window;
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  }
});
