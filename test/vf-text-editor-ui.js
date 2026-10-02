// Focused real Chromium keyboard regression, invoked by --ui-verify.
export async function verifyVfTextEditor(win, backend) {
  const js = (code) => win.webContents.executeJavaScript(code);
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 150));
  const originalApply = backend.applySettings;
  let manualPayload;
  backend.applySettings = async function(deviceId, settings, ...rest) {
    if (settings.vfCurve) manualPayload = structuredClone(settings);
    return originalApply.call(this, deviceId, settings, ...rest);
  };
  const points = Array.from({ length: 10 }, (_, index) => ({
    voltageV: Number((0.6 + index * 0.07).toFixed(3)),
    freqMhz: index < 7 ? 1800 + index * 180 : 3090,
  }));
  backend._state.vfCurve = points.map((point) => ({ ...point }));
  backend._state.vfCurveDefault = points.map((point) => ({ ...point }));
  await js(`window.arcPower.waiverAccept(0)`);
  await js(`location.hash = '#/dashboard'`);
  await pause();
  await js(`location.hash = '#/tuning'`);
  await pause();
  await js(`Array.from(document.querySelectorAll('.oc-vf-mode-btn')).find(b => b.textContent.trim() === 'Voltage-Frequency Curve')?.click()`);
  await pause();
  await js(`window.vfStableChart = document.querySelector('.vf-curve-stage').getBoundingClientRect().toJSON(); window.vfStableHelp = document.querySelector('.vf-curve-help').textContent`);
  const assertStableChart = async (phase) => {
    assert(await js(`(() => {
      const box = document.querySelector('.vf-curve-stage').getBoundingClientRect();
      return ['x', 'y', 'width', 'height'].every(key => box[key] === vfStableChart[key])
        && document.querySelector('.vf-curve-help').textContent === vfStableHelp;
    })()`), 'Chart bounds or normal help changed during ' + phase);
  };
  await js(`(() => {
    const dot = document.querySelector('.vf-curve-dot[data-idx="7"]');
    dot.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    window.dispatchEvent(new PointerEvent('pointerup'));
    window.vfInput = document.querySelector('[data-readout-field="frequency"]');
    vfInput.focus(); vfInput.select();
    window.vfBox = document.querySelector('.vf-curve-readout').getBoundingClientRect().toJSON();
    window.vfLabel = document.querySelector('.vf-curve-readout-label').textContent;
  })()`);
  win.webContents.debugger.attach('1.3');
  const key = async (key, code, windowsVirtualKeyCode) => {
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode });
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
  };
  try {
    for (const text of ['3', '2', '3', '0']) await win.webContents.debugger.sendCommand('Input.insertText', { text });
    assert(await js(`vfInput.value === '3230' && vfInput === document.activeElement`), 'Typing3230 lost text or focus');
    await key('Enter', 'Enter', 13);
    assert(await js(`(() => {
      const box = document.querySelector('.vf-curve-readout').getBoundingClientRect();
      return vfInput === document.querySelector('[data-readout-field="frequency"]') && vfInput === document.activeElement
        && box.x === vfBox.x && box.y === vfBox.y && document.querySelector('.vf-curve-readout-label').textContent === vfLabel
        && document.querySelector('.vf-curve-dot-selected').dataset.idx === '7'
        && [7,8,9].every(i => document.querySelector('.vf-curve-dot[data-idx="'+i+'"]').getAttribute('aria-label').includes('3230'));
    })()`), 'Enter moved editor or failed forward propagation');
    await assertStableChart('draft edit');
    await js(`vfInput.select()`);
    await win.webContents.debugger.sendCommand('Input.insertText', { text: '3231' });
    await key('Tab', 'Tab', 9);
    assert(await js(`vfInput.value === '3231' && vfInput.isConnected && document.querySelector('.vf-curve-dot-selected').dataset.idx === '7'`), 'Tab lost committed edit or selection');
    await js(`vfInput.focus(); vfInput.select()`);
    await win.webContents.debugger.sendCommand('Input.insertText', { text: '3230' });
    await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .oc-chip-apply').click()`);
    let applied;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await pause();
      applied = await js(`window.arcPower.getCurrentSettings(0)`);
      if (applied.vfCurve[7].freqMhz === 3230) break;
    }
    assert(applied.vfCurve[7].freqMhz === 3230 && applied.vfCurve[8].freqMhz === 3231 && applied.vfCurve[9].freqMhz === 3231, 'Apply failed to consume pending3230: ' + JSON.stringify({ applied, ui: await js(`({ note: document.querySelector('.vf-curve-editor .card-note')?.textContent, toasts: Array.from(document.querySelectorAll('.toast')).map(t => t.textContent), active: document.activeElement?.outerHTML })`) }));
    assert(JSON.stringify(manualPayload?.vfCurveBaseline) === JSON.stringify(points), 'Manual Apply baseline differs from untouched LIVE before-image');
    assert(await js(`document.querySelector('.vf-curve-dot-selected').dataset.idx === '7'`), 'Apply switched selected point');
    await assertStableChart('Apply');
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await js(`!document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .oc-chip-apply').disabled`)) break;
      await pause();
    }
    await js(`document.querySelector('.profile-save-btn').click()`);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await js(`!!document.querySelector('.modal-input')`)) break;
      await pause();
    }
    await win.webContents.debugger.sendCommand('Input.insertText', { text: 'VF reference regression' });
    await key('Enter', 'Enter', 13);
    let saved;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      saved = await js(`window.arcPower.profilesList().then(e => e.profiles.find(p => p.name === 'VF reference regression'))`);
      if (saved) break;
      await pause();
    }
    assert(saved && JSON.stringify(saved.settings.vfCurveStockReference) === JSON.stringify(points), 'Profile save lost STOCK voltage reference');
    assert(!('vfCurveBaseline' in saved.settings) && !!saved.deviceKey, 'Profile persisted transient baseline or lost adapter identity');
    const { createProfileTransferEnvelope, planProfileTransferImport } = await import('../src/main/profile-transfer.js');
    const envelope = createProfileTransferEnvelope({ profiles: [saved], devices: [{ deviceKey: saved.deviceKey }] });
    assert(JSON.stringify(envelope.profiles[0].settings.vfCurveStockReference) === JSON.stringify(points), 'Profile export lost STOCK reference');
    const plan = planProfileTransferImport({ incoming: envelope, devices: [{ deviceKey: saved.deviceKey }] });
    assert(JSON.stringify(plan.profiles[0].settings.vfCurveStockReference) === JSON.stringify(points) && plan.profiles[0].deviceKey === saved.deviceKey, 'Profile import lost reference or adapter identity');
    const originalGet = backend.getCurrentSettings;
    const saveThroughUi = async (name) => {
      await js(`document.querySelector('.profile-save-btn').click()`);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (await js(`!!document.querySelector('.modal-input')`)) break;
        await pause();
      }
      await win.webContents.debugger.sendCommand('Input.insertText', { text: name });
      await key('Enter', 'Enter', 13);
      await pause();
    };
    let captures = 0;
    try {
      backend.getCurrentSettings = async function(...args) {
        const state = await originalGet.apply(this, args);
        captures += 1;
        if (captures < 3) state.vfCurve = state.vfCurve.map(point => ({ ...point, voltageV: point.voltageV + 0.01 }));
        return state;
      };
      await saveThroughUi('VF paired retry');
      const retried = await js(`window.arcPower.profilesList().then(e => e.profiles.find(p => p.name === 'VF paired retry'))`);
      assert(captures === 3 && JSON.stringify(retried?.settings.vfCurveStockReference) === JSON.stringify(points), 'Profile capture failed to retry ambiguous origin pair');
      captures = 0;
      const beforeCustom = await originalGet.call(backend, 0);
      const custom = structuredClone(beforeCustom);
      custom.vfCurve[4].voltageV += 0.01;
      backend.getCurrentSettings = async function() {
        captures += 1;
        return structuredClone(custom);
      };
      await saveThroughUi('VF stable custom voltage');
      const customSaved = await js(`window.arcPower.profilesList().then(e => e.profiles.find(p => p.name === 'VF stable custom voltage'))`);
      assert(captures === 2 && customSaved, 'Stable per-point voltage edit did not save after two readings');
      assert(JSON.stringify(customSaved.settings.vfCurveStockReference) === JSON.stringify(points)
        && Math.abs(customSaved.settings.vfCurve[4].voltageV - points[4].voltageV - 0.01) < 1e-6,
      'Custom voltage save lost STOCK reference or explicit voltage delta');
      await originalApply.call(backend, 0, customSaved.settings);
      const customApplied = await originalGet.call(backend, 0);
      assert(Math.abs(customApplied.vfCurve[4].voltageV - points[4].voltageV - 0.01) < 1e-6, 'Mock profile Apply lost explicit voltage delta');
      await originalApply.call(backend, 0, { vfCurve: beforeCustom.vfCurve });
      captures = 0;
      backend.getCurrentSettings = async function() {
        captures += 1;
        const state = structuredClone(custom);
        for (const point of state.vfCurve) point.voltageV += captures * 0.001;
        for (const point of state.vfCurveDefault) point.voltageV += captures * 0.001;
        return state;
      };
      await saveThroughUi('VF unstable custom refuse');
      const unstable = await js(`window.arcPower.profilesList().then(e => e.profiles.find(p => p.name === 'VF unstable custom refuse'))`);
      assert(captures === 3 && !unstable, 'Moving custom LIVE/STOCK pair escaped bounded capture refusal');
      captures = 0;
      backend.getCurrentSettings = async function(...args) {
        const state = await originalGet.apply(this, args);
        captures += 1;
        state.vfCurve = state.vfCurve.map(point => ({ ...point, voltageV: point.voltageV + 0.01 }));
        return state;
      };
      await saveThroughUi('VF ambiguous refuse');
      const refused = await js(`window.arcPower.profilesList().then(e => e.profiles.find(p => p.name === 'VF ambiguous refuse'))`);
      assert(captures === 3 && !refused, 'Ambiguous profile capture saved an absolute fallback or exceeded bounded retries');
      assert(await js(`Array.from(document.querySelectorAll('.toast')).some(t => t.textContent.includes('LIVE and STOCK voltage grids'))`), 'Ambiguous capture failure did not explain refusal');
    } finally {
      backend.getCurrentSettings = originalGet;
    }
    await js(`vfInput.focus(); vfInput.select()`);
    await win.webContents.debugger.sendCommand('Input.insertText', { text: '3330' });
    const target = await js(`(() => { const box = document.querySelector('.vf-curve-dot[data-idx="4"]').getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`);
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...target });
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...target });
    assert(await js(`document.querySelector('.vf-curve-dot[data-idx="7"]').getAttribute('aria-label').includes('3330') && document.querySelector('.vf-curve-dot-selected').dataset.idx === '4' && vfInput.value === '2520'`), 'Clicking a different point applied pending text to the new point');
    await js(`(() => {
      const dot = document.querySelector('.vf-curve-dot[data-idx="9"]');
      dot.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      window.dispatchEvent(new PointerEvent('pointerup'));
      const input = document.querySelector('[data-readout-field="frequency"]');
      input.focus(); input.select();
    })()`);
    await win.webContents.debugger.sendCommand('Input.insertText', { text: '3240' });
    await key('Enter', 'Enter', 13);
    assert(await js(`[8,9].every(i => document.querySelector('.vf-curve-dot[data-idx="'+i+'"]').getAttribute('aria-label').includes('3240')) && document.querySelector('.vf-curve-dot-selected').dataset.idx === '9'`), 'Native terminal plateau edit lost partner or selection');
    const replaceFrequency = async (text) => {
      await js(`document.querySelector('[data-readout-field="frequency"]').focus(); document.querySelector('[data-readout-field="frequency"]').select()`);
      if (text) await win.webContents.debugger.sendCommand('Input.insertText', { text });
      else await key('Backspace', 'Backspace', 8);
      await key('Enter', 'Enter', 13);
    };
    await replaceFrequency('9999');
    assert(await js(`document.querySelector('[data-readout-field="frequency"]').value === '4300' && [8,9].every(i => document.querySelector('.vf-curve-dot[data-idx="'+i+'"]').getAttribute('aria-label').includes('4300'))`), 'Enter left unclamped frequency visible');
    await replaceFrequency('3240.4');
    assert(await js(`document.querySelector('[data-readout-field="frequency"]').value === '3240' && document.querySelector('[data-readout-field="frequency"]') === document.activeElement`), 'Fractional frequency did not display accepted integer');
    await replaceFrequency('');
    assert(await js(`document.querySelector('[data-readout-field="frequency"]').value === '3240'`), 'Empty frequency did not restore accepted value');
    await js(`document.querySelector('[data-readout-field="voltage"]').focus(); document.querySelector('[data-readout-field="voltage"]').select()`);
    await win.webContents.debugger.sendCommand('Input.insertText', { text: '1230.4' });
    await key('Enter', 'Enter', 13);
    assert(await js(`document.querySelector('[data-readout-field="voltage"]').value === '1230' && document.querySelector('[data-readout-field="voltage"]') === document.activeElement`), 'Fractional voltage did not display accepted grid value');
    await js(`document.querySelector('[data-readout-field="voltage"]').select()`);
    await win.webContents.debugger.sendCommand('Input.insertText', { text: '1240' });
    await key('Enter', 'Enter', 13);
    assert(await js(`document.querySelector('.vf-curve-dot[data-idx="9"]').getAttribute('aria-label').includes('1240 mV')`), 'Valid voltage edit was not preserved');
    for (const value of [1000, 1730, 2195, 2820, 3090, 3210, 3230, 3247]) {
      await js(`document.querySelector('[data-readout-field="frequency"]').focus(); document.querySelector('[data-readout-field="frequency"]').select(); window.vfBeforeTyping = document.querySelector('.vf-curve-dot[data-idx="9"]').getAttribute('aria-label')`);
      for (const text of String(value)) await win.webContents.debugger.sendCommand('Input.insertText', { text });
      assert(await js(`document.querySelector('[data-readout-field="frequency"]').value === '${value}' && document.querySelector('.vf-curve-dot[data-idx="9"]').getAttribute('aria-label') === vfBeforeTyping`), 'Intermediate keystrokes changed the curve for ' + value);
      await key('Enter', 'Enter', 13);
      assert(await js(`document.querySelector('[data-readout-field="frequency"]').value === '${value}' && [8,9].every(i => document.querySelector('.vf-curve-dot[data-idx="'+i+'"]').getAttribute('aria-label').includes('@ ${value} MHz'))`), 'Whole frequency was not accepted for ' + value);
      await key('Tab', 'Tab', 9);
      await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .oc-chip-apply').click()`);
      let exact = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await pause();
        exact = await js(`window.arcPower.getCurrentSettings(0).then(s => s.vfCurve[9].freqMhz === ${value})`);
        if (exact && await js(`!document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .oc-chip-apply').disabled`)) break;
      }
      assert(exact, 'Apply did not preserve exact matrix frequency ' + value);
    }
    await js(`document.querySelector('[data-readout-field="frequency"]').focus()`);
    await js(`document.querySelector('[data-readout-field="frequency"]').select()`);
    await win.webContents.debugger.sendCommand('Input.insertText', { text: '3250' });
    const observation = await backend.getCurrentSettings(0);
    observation.vfCurve[0].freqMhz += 10;
    win.webContents.send('device:state-updated', { deviceId: 0, state: observation });
    await pause();
    const observationEditor = await js(`({ value: document.querySelector('[data-readout-field="frequency"]').value, focused: document.querySelector('[data-readout-field="frequency"]') === document.activeElement, selected: document.querySelector('.vf-curve-dot-selected').dataset.idx })`);
    assert(observationEditor.value === '3250' && observationEditor.selected === '9', 'Latest LIVE observation overwrote unfinished typing: ' + JSON.stringify(observationEditor));
    await assertStableChart('stale observation');
    await js(`Array.from(document.querySelectorAll('.vf-curve-actions button')).find(b => b.textContent === 'Discard draft and refresh').click()`);
    await assertStableChart('refresh start');
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await js(`!Array.from(document.querySelectorAll('.vf-curve-actions button')).find(b => b.textContent === 'Reading…')`)) break;
      await pause();
    }
    await assertStableChart('refresh completion');
    const beforeOrigin = await js(`Array.from(document.querySelectorAll('.vf-curve-dot')).map(dot => dot.getBoundingClientRect().x)`);
    backend._state.vfCurve = backend._state.vfCurve.map(point => ({ ...point, voltageV: Number((point.voltageV + 0.1).toFixed(3)) }));
    backend._state.vfCurveDefault = backend._state.vfCurveDefault.map(point => ({ ...point, voltageV: Number((point.voltageV + 0.1).toFixed(3)) }));
    await js(`Array.from(document.querySelectorAll('.vf-curve-actions button')).find(b => b.textContent === 'Refresh from driver').click()`);
    await pause();
    const afterOrigin = await js(`({ positions: Array.from(document.querySelectorAll('.vf-curve-dot')).map(dot => dot.getBoundingClientRect().x), axis: Array.from(document.querySelectorAll('.vf-curve-axis span')).map(node => node.textContent), firstLabel: document.querySelector('.vf-curve-dot').getAttribute('aria-label') })`);
    assert(beforeOrigin.every((position, index) => Math.abs(position - afterOrigin.positions[index]) < 0.01), 'Common native origin shift moved plotted points');
    assert(afterOrigin.axis.join(',') === '500 mV,1600 mV' && afterOrigin.firstLabel.includes('700 mV'), 'Translated viewport concealed actual native voltages');
    await assertStableChart('common native origin shift');
    return 'Real Chromium typing3230, replacement, Enter, Tab, Apply and forward plateau propagation passed';
  } finally {
    backend.applySettings = originalApply;
    win.webContents.debugger.detach();
  }
}

