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
    this.parentNode = null;
    this.mutationObservers = new Set();
    this.hidden = false;
    this.classList = {
      toggle: (name, force) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        if (force) classes.add(name);
        else classes.delete(name);
        this.className = [...classes].join(' ');
      },
    };
  }
  set textContent(value) {
    this._textContent = String(value);
    const removed = this.children;
    this.children = [];
    for (const child of removed) child.parentNode = null;
    this.notifyMutation(removed);
  }
  get textContent() { return this._textContent + this.children.map((child) => child.textContent ?? String(child)).join(''); }
  setAttribute(name, value) {
    this.attributes[name] = value;
    if (name === 'disabled') this.disabled = true;
    if (name === 'hidden') this.hidden = true;
  }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  append(...children) {
    this.children.push(...children);
    for (const child of children) if (typeof child === 'object') child.parentNode = this;
  }
  replaceChildren(...children) {
    const removed = this.children;
    this.children = children;
    for (const child of removed) child.parentNode = null;
    for (const child of children) if (typeof child === 'object') child.parentNode = this;
    this.notifyMutation(removed);
  }
  contains(node) {
    return this === node || this.children.some((child) => child === node || child?.contains?.(node));
  }
  notifyMutation(removedNodes) {
    if (!removedNodes.length) return;
    for (const observer of this.mutationObservers) observer.notify(removedNodes);
  }
  focus() { this.focusCount = (this.focusCount ?? 0) + 1; }
  async click() {
    if (this.disabled) return;
    for (const listener of this.listeners.get('click') ?? []) {
      await listener({ target: this, currentTarget: this, preventDefault() {} });
    }
  }
  dispatch(name, properties = {}) {
    const event = {
      target: this,
      currentTarget: this,
      ...properties,
      preventDefault() { this.defaultPrevented = true; },
    };
    for (const listener of this.listeners.get(name) ?? []) listener(event);
    return event;
  }
}

class FakeMutationObserver {
  constructor(callback) { this.callback = callback; this.target = null; }
  observe(target) { this.target = target; target.mutationObservers.add(this); }
  disconnect() {
    this.target?.mutationObservers.delete(this);
    this.target = null;
  }
  notify(removedNodes) {
    queueMicrotask(() => {
      if (this.target) this.callback([{ removedNodes }], this);
    });
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

function button(root, label) { return find(root, (node) => node.tagName === 'BUTTON' && node.attributes.role !== 'tab' && node.textContent === label); }
function tab(root, label) { return find(root, (node) => node.tagName === 'BUTTON' && node.attributes.role === 'tab' && node.textContent === label); }

test('Intel driver popup gates downloads, tracks matching progress, cancels, and offers install choices', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalMutationObserver = globalThis.MutationObserver;
  const body = new FakeElement('body');
  const documentListeners = new Map();
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
    value: {
      body,
      createElement: (tagName) => new FakeElement(tagName),
      getElementById: (id) => body.children.find((child) => child.attributes.id === id) ?? null,
      addEventListener: (name, listener) => documentListeners.set(name, [...(documentListeners.get(name) ?? []), listener]),
      dispatch: (name, event) => { for (const listener of documentListeners.get(name) ?? []) listener(event); },
    },
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { arcPower: api } });
  globalThis.MutationObserver = FakeMutationObserver;

  try {
    const { confirmIntelDriverInstall, showIntelDriverUpdateDialog } = await import('../src/renderer/components/intel-driver-update-dialog.ts');
    const release = { version: '32.0.101.8805', releaseDate: null, officialPageUrl: 'https://www.intel.com/unused-in-renderer', changelog: ['Improved graphics stability', '<script>remains text</script>'] };
    const root = (() => {
      const created = new FakeElement('div');
      created.setAttribute('id', 'modal-root');
      body.append(created);
      return created;
    })();
    let confirmationResult;
    const cancelledConfirmation = confirmIntelDriverInstall().then((result) => { confirmationResult = result; });
    assert.match(root.textContent, /interactive installer will open/);
    assert.match(root.textContent, /Arc Power will close after it launches/);
    const confirmationOverlay = find(root, (node) => node.className === 'modal-overlay');
    await confirmationOverlay.click();
    globalThis.document.dispatch('keydown', { key: 'Escape' });
    assert.equal(confirmationResult, undefined, 'backdrop and Escape do not dismiss confirmation');
    await button(root, 'Cancel').click();
    await cancelledConfirmation;
    assert.equal(confirmationResult, false, 'Cancel resolves confirmation as false');
    assert.deepEqual(calls.install, [], 'Cancel does not launch the installer');
    const acceptedConfirmation = confirmIntelDriverInstall();
    await button(root, 'Install Driver').click();
    assert.equal(await acceptedConfirmation, true, 'affirmative action resolves confirmation as true');
    assert.deepEqual(calls.install, [], 'confirmation modal does not launch the installer before its caller proceeds');

    showIntelDriverUpdateDialog('arc', '32.0.101.7000', release);
    let download = button(root, 'Download');
    const overlay = find(root, (node) => node.className === 'modal-overlay');
    await overlay.click();
    assert.ok(button(root, 'Download'), 'backdrop click leaves the popup open');
    assert.deepEqual(calls.cancel, [], 'backdrop click does not cancel a transfer');
    globalThis.document.dispatch('keydown', { key: 'Escape' });
    assert.ok(button(root, 'Download'), 'Escape leaves the popup open');
    assert.deepEqual(calls.cancel, [], 'Escape does not cancel a transfer');
    await button(root, 'Cancel').click();
    assert.deepEqual(root.children, [], 'explicit Cancel closes the popup');

    showIntelDriverUpdateDialog('arc', '32.0.101.7000', release);
    download = button(root, 'Download');
    const downloadTab = tab(root, 'Download');
    const changelogTab = tab(root, 'Changelog');
    const downloadPanel = find(root, (node) => node.attributes.id === 'intel-driver-download-panel');
    const changelogPanel = find(root, (node) => node.attributes.id === 'intel-driver-changelog-panel');
    assert.equal(downloadTab.attributes.role, 'tab');
    assert.equal(changelogTab.attributes.role, 'tab');
    assert.equal(downloadTab.attributes['aria-selected'], 'true');
    assert.equal(downloadPanel.hidden, false);
    assert.equal(changelogPanel.hidden, true);
    let keyEvent = downloadTab.dispatch('keydown', { key: 'ArrowRight' });
    assert.equal(keyEvent.defaultPrevented, true);
    assert.equal(changelogTab.attributes['aria-selected'], 'true');
    assert.equal(changelogTab.attributes.tabindex, '0');
    assert.equal(changelogTab.focusCount, 1, 'ArrowRight moves focus to the next tab');
    assert.equal(changelogPanel.hidden, false);
    keyEvent = changelogTab.dispatch('keydown', { key: 'ArrowLeft' });
    assert.equal(keyEvent.defaultPrevented, true);
    assert.equal(downloadTab.attributes['aria-selected'], 'true');
    assert.equal(downloadTab.focusCount, 1, 'ArrowLeft moves focus to the previous tab');
    keyEvent = downloadTab.dispatch('keydown', { key: 'ArrowRight' });
    assert.equal(changelogTab.attributes['aria-selected'], 'true');
    keyEvent = changelogTab.dispatch('keydown', { key: 'ArrowRight' });
    assert.equal(keyEvent.defaultPrevented, true);
    assert.equal(downloadTab.attributes['aria-selected'], 'true', 'ArrowRight wraps to the first tab');
    assert.equal(downloadPanel.hidden, false);
    keyEvent = downloadTab.dispatch('keydown', { key: 'End' });
    assert.equal(keyEvent.defaultPrevented, true);
    assert.equal(changelogTab.attributes['aria-selected'], 'true', 'End selects the last tab');
    assert.equal(changelogTab.focusCount, 3);
    keyEvent = changelogTab.dispatch('keydown', { key: 'Home' });
    assert.equal(keyEvent.defaultPrevented, true);
    assert.equal(downloadTab.attributes['aria-selected'], 'true', 'Home selects the first tab');
    assert.equal(downloadTab.focusCount, 3);
    assert.match(changelogPanel.textContent, /Improved graphics stability/);
    assert.match(changelogPanel.textContent, /<script>remains text<\/script>/, 'release highlights render as safe text');
    await changelogTab.click();
    assert.equal(changelogTab.attributes['aria-selected'], 'true');
    assert.equal(changelogPanel.hidden, false);
    assert.equal(downloadPanel.hidden, true);
    await downloadTab.click();
    assert.equal(downloadTab.attributes['aria-selected'], 'true');
    assert.equal(downloadPanel.hidden, false);
    assert.equal(changelogPanel.hidden, true);
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
    await changelogTab.click();
    for (const listener of listeners) listener({ kind: 'arc', version: release.version, percent: 42 });
    assert.equal(find(root, (node) => node.tagName === 'PROGRESS').value, 42, 'progress continues while the changelog tab is shown');
    await downloadTab.click();
    const progress = find(root, (node) => node.tagName === 'PROGRESS');
    assert.equal(license.checked, true, 'switching tabs preserves license acceptance');
    assert.equal(progress.value, 42, 'switching tabs preserves the displayed progress');
    for (const listener of listeners) listener({ kind: 'pro', version: release.version, percent: 90 });
    assert.equal(progress.value, 42, 'other driver kind progress is ignored');
    for (const listener of listeners) listener({ kind: 'arc', version: '32.0.101.9999', percent: 70 });
    assert.equal(progress.value, 42, 'other versions are ignored');
    for (const listener of listeners) listener({ kind: 'arc', version: release.version, percent: 42 });
    assert.equal(progress.value, 42);
    assert.match(root.textContent, /42%/);
    resolveStart({ downloaded: true, sizeBytes: 1234 });
    await downloadRequest;
    assert.equal(listeners.size, 0, 'progress listener is removed when download completes');
    assert.ok(button(root, 'Install Now'));
    assert.ok(button(root, 'Install Later'));
    await changelogTab.click();
    await downloadTab.click();
    assert.ok(button(root, 'Install Now'), 'switching tabs preserves ready actions');
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
    const cancelDownload = button(root, 'Download');
    const proLicense = find(root, (node) => node.tagName === 'INPUT');
    proLicense.checked = true;
    proLicense.dispatch('change');
    const pendingStart = cancelDownload.listeners.get('click')[0]({ target: cancelDownload, currentTarget: cancelDownload });
    assert.equal(listeners.size, 1);
    const activeOverlay = find(root, (node) => node.className === 'modal-overlay');
    await activeOverlay.click();
    assert.ok(button(root, 'Cancel download'), 'backdrop click leaves the active download dialog open');
    assert.deepEqual(calls.cancel, [], 'backdrop click does not cancel the active transfer');
    globalThis.document.dispatch('keydown', { key: 'Escape' });
    assert.ok(button(root, 'Cancel download'), 'Escape leaves the active download dialog open');
    assert.deepEqual(calls.cancel, [], 'Escape does not cancel the active transfer');
    await button(root, 'Cancel download').click();
    assert.deepEqual(calls.cancel, ['pro'], 'dismissing during download cancels the backend operation');
    assert.equal(listeners.size, 0, 'dismissing unsubscribes progress events');
    resolveStart({ downloaded: true, sizeBytes: 1 });
    await pendingStart;

    showIntelDriverUpdateDialog('arc', '32.0.101.7000', { ...release, changelog: [] });
    await tab(root, 'Changelog').click();
    assert.match(root.textContent, /No release highlights are available\./, 'empty highlights have a clear fallback');

    const { confirmIntelDriverInstallTransition, intelDriverNoticeAction } = await import('../src/renderer/pages/dashboard.ts');
    assert.equal(intelDriverNoticeAction(false), 'New Driver Version Available');
    assert.equal(intelDriverNoticeAction(true), 'Install new Driver now');

    const cancelledEntry = { downloaded: true, confirming: false, installing: false };
    let resolveConfirmation;
    let confirmationCalls = 0;
    let cancelledInstallCalls = 0;
    const confirmation = () => {
      confirmationCalls += 1;
      return new Promise((resolve) => { resolveConfirmation = resolve; });
    };
    const cancelledTransition = confirmIntelDriverInstallTransition(
      cancelledEntry, () => true, confirmation, () => { cancelledInstallCalls += 1; }, () => {},
    );
    assert.equal(cancelledEntry.confirming, true, 'pending confirmation marks the notice as confirming');
    assert.equal(await confirmIntelDriverInstallTransition(
      cancelledEntry, () => true, confirmation, () => { cancelledInstallCalls += 1; }, () => {},
    ), false, 'duplicate invocation is ignored while confirmation is pending');
    assert.equal(confirmationCalls, 1, 'duplicate invocation does not open another confirmation');
    resolveConfirmation(false);
    assert.equal(await cancelledTransition, false, 'Cancel returns false');
    assert.equal(cancelledInstallCalls, 0, 'Cancel does not invoke the installer');
    assert.deepEqual(cancelledEntry, { downloaded: true, confirming: false, installing: false }, 'Cancel resets transient state and preserves the downloaded driver');

    const staleEntry = { downloaded: true, confirming: false, installing: false };
    let staleInstallCalls = 0;
    assert.equal(await confirmIntelDriverInstallTransition(
      staleEntry, () => false, async () => true, () => { staleInstallCalls += 1; }, () => {},
    ), false, 'affirmative confirmation is rejected when the notice is no longer current');
    assert.equal(staleInstallCalls, 0, 'stale notice does not invoke the installer');
    assert.deepEqual(staleEntry, { downloaded: true, confirming: false, installing: false }, 'stale confirmation resets transient state and preserves the downloaded driver');

    const confirmedEntry = { downloaded: true, confirming: false, installing: false };
    let resolveAcceptedConfirmation;
    let confirmationResolved = false;
    let installCalls = 0;
    const acceptedTransition = confirmIntelDriverInstallTransition(
      confirmedEntry,
      () => true,
      () => new Promise((resolve) => { resolveAcceptedConfirmation = (value) => { confirmationResolved = true; resolve(value); }; }),
      () => {
        assert.equal(confirmationResolved, true, 'installer starts only after explicit confirmation');
        assert.equal(confirmedEntry.installing, true, 'confirmed transition enters installing state before installer invocation');
        installCalls += 1;
      },
      () => {},
    );
    assert.equal(installCalls, 0, 'installer has not started while confirmation is pending');
    resolveAcceptedConfirmation(true);
    assert.equal(await acceptedTransition, true);
    assert.equal(installCalls, 1, 'explicit confirmation invokes the installer exactly once');

    const replacementEntry = { downloaded: true, confirming: false, installing: false };
    let replacementInstallCalls = 0;
    const apiInstallCallsBeforeReplacement = [...calls.install];
    const replacingTransition = confirmIntelDriverInstallTransition(
      replacementEntry,
      () => true,
      confirmIntelDriverInstall,
      () => { replacementInstallCalls += 1; },
      () => {},
    );
    assert.equal(replacementEntry.confirming, true, 'replacement scenario begins with confirmation pending');
    showIntelDriverUpdateDialog('arc', '32.0.101.7000', release);
    let replacementTimeout;
    const replacementResult = await Promise.race([
      replacingTransition.then((value) => ({ settled: true, value })),
      new Promise((resolve) => { replacementTimeout = setTimeout(() => resolve({ settled: false }), 100); }),
    ]);
    clearTimeout(replacementTimeout);
    assert.deepEqual(replacementResult, { settled: true, value: false }, 'replacing the confirmation promptly resolves the transition as false');
    assert.equal(replacementInstallCalls, 0, 'replacing the confirmation does not invoke its install callback');
    assert.deepEqual(calls.install, apiInstallCallsBeforeReplacement, 'replacing the confirmation does not launch the installer');
    assert.deepEqual(replacementEntry, { downloaded: true, confirming: false, installing: false }, 'replacement resolves the row out of confirming state');
    const replacementOverlay = find(root, (node) => node.className === 'modal-overlay');
    assert.ok(replacementOverlay, 'replacement driver modal remains open');
    assert.ok(button(root, 'Download'), 'replacement driver modal remains interactive');
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    if (originalWindow === undefined) delete globalThis.window;
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    if (originalMutationObserver === undefined) delete globalThis.MutationObserver;
    else Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: originalMutationObserver });
  }
});
