// Arc Power — placeholder pages for milestones not yet delivered (M2b-B:
// only Tweaks remains a placeholder — Monitoring and Profiles are real).

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

export const tweaksPage = makePlaceholder('Tweaks', 'Registry hacks (MPO disable and friends) arrive in M3.');
