// Arc Power — placeholder pages for milestones not yet delivered.

import { el } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';

export function makePlaceholder(title: string, note: string): Page {
  return {
    id: title.toLowerCase() as Page['id'],
    render(container: HTMLElement, _ctx: PageContext) {
      container.replaceChildren(
        el('div', { class: 'placeholder' }, [
          el('h1', { class: 'page-title', text: title }),
          el('p', { class: 'page-subtitle', text: note }),
        ]),
      );
    },
  };
}

export const monitoringPage = makePlaceholder('Monitoring', 'Live readouts and rolling graphs arrive in M2b.');
export const profilesPage = makePlaceholder('Profiles', 'Save / load / rename profiles with apply-on-startup arrive in M2b.');
export const tweaksPage = makePlaceholder('Tweaks', 'Registry hacks (MPO disable and friends) arrive in M3.');
