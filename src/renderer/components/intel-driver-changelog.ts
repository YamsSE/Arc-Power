import { el } from '../dom.ts';
import type { IntelDriverChangelogEntry } from '../pure/intel-driver-updates.ts';

type IntelDriverChangelogSource = {
  changelog: string[];
  changelogSections?: IntelDriverChangelogEntry[];
};

function renderEntries(entries: IntelDriverChangelogEntry[], depth: number): HTMLElement {
  const root = el('div', { class: `intel-driver-changelog-sections${depth ? ' is-nested' : ''}` });
  let list: HTMLUListElement | null = null;
  for (const entry of entries) {
    if (entry.kind === 'heading') {
      list = null;
      root.append(el(depth ? 'h5' : 'h4', { class: 'intel-driver-changelog-section-heading', text: entry.text }));
      if (entry.children?.length) root.append(renderEntries(entry.children, depth + 1));
      continue;
    }
    if (!list) {
      list = el('ul', { class: 'intel-driver-changelog-list' });
      root.append(list);
    }
    const item = el('li', { class: entry.children?.length ? 'intel-driver-changelog-group' : undefined }, [
      el(entry.children?.length ? 'strong' : 'span', { text: entry.text }),
    ]);
    if (entry.children?.length) item.append(renderEntries(entry.children, depth + 1));
    list.append(item);
  }
  return root;
}

/** Render structured Intel release notes, with the legacy flat list as fallback. */
export function renderIntelDriverChangelog(release: IntelDriverChangelogSource): HTMLElement {
  const sections = release.changelogSections;
  if (sections?.length) return renderEntries(sections, 0);
  return el('ul', { class: 'intel-driver-changelog-list' }, (release.changelog ?? []).map((line) => el('li', { text: line })));
}
