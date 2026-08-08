// Arc Power - M4-D (user): the integrated title bar wiring (frameless
// window). The markup lives in index.html: the brand CENTERED (assets/
// icon.png on top, "Arc Power" below with "Power" in the website's blue
// gradient + glow), the window controls (minimize / maximize-restore /
// close) in the right cluster. This module wires the buttons to the
// window-op IPC and keeps the max button's icon in sync with the pushed
// window:maximized-changed state.
//
// The drag regions + double-click-to-maximize are handled by Electron
// itself (-webkit-app-region: drag on .titlebar-drag / .titlebar-brand);
// only the no-drag cluster's buttons need JS here.

import { api } from '../ipc.ts';

const MAX_BTN_SEL = '.window-btn[data-op="maximize-toggle"]';

export function initTitlebar(): void {
  document.querySelector('.window-btn[data-op="minimize"]')
    ?.addEventListener('click', () => { void api.windowMinimize(); });
  document.querySelector(MAX_BTN_SEL)
    ?.addEventListener('click', () => { void api.windowMaximizeToggle(); });
  document.querySelector('.window-btn[data-op="close"]')
    ?.addEventListener('click', () => { void api.windowClose(); });

  // M4-D: the max button icon follows the live maximize state (main pushes
  // window:maximized-changed on maximize/unmaximize). M4J (F): ONE svg -
  // the two inner groups are class-toggled (the pre-M4J markup hid one of
  // TWO svg elements; the user's repeat request). Maximized -> the
  // icon-state-restore class shows the restore group (overlapping squares);
  // else the maximize group (the single hollow square).
  api.onWindowMaximizedChanged(({ maximized }) => {
    const btn = document.querySelector<HTMLButtonElement>(MAX_BTN_SEL);
    if (!btn) return;
    btn.title = maximized ? 'Restore' : 'Maximize';
    btn.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
    const svg = btn.querySelector<SVGElement>('.icon-maximize-restore');
    svg?.classList.toggle('icon-state-restore', maximized);
  });
}
