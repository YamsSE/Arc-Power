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
  // window:maximized-changed on maximize/unmaximize). The single square is
  // "maximize", the overlapping squares are "restore".
  api.onWindowMaximizedChanged(({ maximized }) => {
    const btn = document.querySelector<HTMLButtonElement>(MAX_BTN_SEL);
    if (!btn) return;
    btn.title = maximized ? 'Restore' : 'Maximize';
    btn.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
    const restore = btn.querySelector<SVGElement>('.icon-restore');
    const maximize = btn.querySelector<SVGElement>('.icon-maximize');
    // SVGElement has no `hidden` in the TS lib - the hidden attribute works
    // on SVG in Chromium; cast through HTMLElement.
    const setHidden = (node: SVGElement | null, hidden: boolean) => {
      if (node) (node as unknown as HTMLElement).hidden = hidden;
    };
    setHidden(restore, !maximized);
    setHidden(maximize, maximized);
  });
}
