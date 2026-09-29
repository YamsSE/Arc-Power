// Arc Power - tiny DOM helper (vanilla TS; no framework).

export type Attrs = {
  class?: string;
  text?: string;
  title?: string;
  href?: string;
  dataset?: Record<string, string>;
  [key: string]: unknown;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Array<Node | string | null | undefined> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  // The `value` attribute on a select does not reliably establish its live
  // selection, especially when options are appended after the attribute is
  // set. Defer it until after children are present and assign the property.
  let selectValue: string | undefined;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value as Record<string, string>);
    else if (key === 'value' && tag === 'select' && typeof value === 'string') selectValue = value;
    else if (key.startsWith('on')) {
      // onClick -> click, oninput -> input, ... (standard DOM event names)
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    }
    else if (typeof value === 'boolean') node.setAttribute(key, '');
    else if (typeof value === 'number') node.setAttribute(key, String(value));
    else if (typeof value === 'string') node.setAttribute(key, value);
  }
  for (const c of children) {
    if (c !== null && c !== undefined) node.append(c);
  }
  if (selectValue !== undefined) (node as HTMLSelectElement).value = selectValue;
  return node;
}

/** Remove all children of a node. */
export function clear(node: HTMLElement): void {
  const scrollPositions = captureScrollPositions(node);
  node.replaceChildren();
  scheduleScrollRestore(scrollPositions);
}

/** Keep scrollable panes at their current offsets while a render replaces content. */
export function preserveScrollPositions<T>(node: HTMLElement, render: () => T): T {
  const scrollPositions = captureScrollPositions(node);
  const result = render();
  scheduleScrollRestore(scrollPositions);
  return result;
}

type ScrollPosition = {
  element: HTMLElement;
  selector: string | null;
  scrollTop: number;
  scrollLeft: number;
};

const pendingScrollPositions = new Map<HTMLElement | string, ScrollPosition>();
let scrollRestoreFrame: number | null = null;
let scrollRestoreStartedAt = 0;
let scrollRestoreInputListeners = false;

function selectorForScrollElement(element: HTMLElement): string | null {
  if (element.id) {
    const idSelector = `#${CSS.escape(element.id)}`;
    if (document.querySelectorAll(idSelector).length === 1) return idSelector;
  }

  const parts: string[] = [];
  let current: HTMLElement | null = element;
  while (current && current !== document.documentElement) {
    const classes = [...current.classList].map((name) => `.${CSS.escape(name)}`).join('');
    let part = `${current.tagName.toLowerCase()}${classes}`;
    const parent: HTMLElement | null = current.parentElement;
    if (parent) {
      const sameTag = [...parent.children].filter((child) => child.tagName === current?.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    const selector = parts.join(' > ');
    try {
      if (document.querySelectorAll(selector).length === 1) return selector;
    } catch {
      return null;
    }
    current = parent;
  }
  return null;
}

function captureScrollPositions(node: HTMLElement): ScrollPosition[] {
  const candidates = new Set<HTMLElement>();
  for (let current: HTMLElement | null = node; current; current = current.parentElement) candidates.add(current);
  for (const child of node.querySelectorAll<HTMLElement>('*')) candidates.add(child);

  const positions: ScrollPosition[] = [];
  for (const element of candidates) {
    if (element.scrollTop <= 0 && element.scrollLeft <= 0) continue;
    positions.push({
      element,
      selector: selectorForScrollElement(element),
      scrollTop: element.scrollTop,
      scrollLeft: element.scrollLeft,
    });
  }
  return positions;
}

function resolveScrollElement(position: ScrollPosition): HTMLElement | null {
  if (position.element.isConnected) return position.element;
  if (!position.selector) return null;
  try {
    return document.querySelector<HTMLElement>(position.selector);
  } catch {
    return null;
  }
}

function restoreScrollPositions(): void {
  for (const position of pendingScrollPositions.values()) {
    const element = resolveScrollElement(position);
    if (!element) continue;
    element.scrollTop = position.scrollTop;
    element.scrollLeft = position.scrollLeft;
  }
}

function stopScrollRestoration(): void {
  if (scrollRestoreFrame !== null) cancelAnimationFrame(scrollRestoreFrame);
  scrollRestoreFrame = null;
  pendingScrollPositions.clear();
  if (!scrollRestoreInputListeners) return;
  window.removeEventListener('wheel', cancelScrollRestorationFromInput, true);
  window.removeEventListener('touchmove', cancelScrollRestorationFromInput, true);
  window.removeEventListener('keydown', cancelScrollRestorationFromInput, true);
  scrollRestoreInputListeners = false;
}

function cancelScrollRestorationFromInput(event: Event): void {
  if (event.type === 'keydown') {
    const key = (event as KeyboardEvent).key;
    if (!['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(key)) return;
  }
  stopScrollRestoration();
}

function scheduleScrollRestore(positions: ScrollPosition[]): void {
  if (!positions.length) return;
  queueMicrotask(() => {
    for (const position of positions) {
      const target = resolveScrollElement(position);
      if (!target) continue;
      // Reading scrollHeight forces layout so the browser has applied any
      // scroll clamp caused by the just-finished render. No-op store updates
      // then exit without starting a background animation-frame loop.
      void target.scrollHeight;
      if (target === position.element
        && target.scrollTop === position.scrollTop
        && target.scrollLeft === position.scrollLeft) continue;
      const key = position.selector ?? position.element;
      // A pane can be cleared several times during one render. Keep the first
      // offset so a second clear cannot replace it with the browser-clamped top.
      if (!pendingScrollPositions.has(key)) pendingScrollPositions.set(key, position);
    }
    if (!pendingScrollPositions.size || scrollRestoreFrame !== null) return;

    scrollRestoreStartedAt = performance.now();
    if (!scrollRestoreInputListeners) {
      window.addEventListener('wheel', cancelScrollRestorationFromInput, { capture: true, passive: true });
      window.addEventListener('touchmove', cancelScrollRestorationFromInput, { capture: true, passive: true });
      window.addEventListener('keydown', cancelScrollRestorationFromInput, true);
      scrollRestoreInputListeners = true;
    }

    const restoreUntilStable = () => {
      restoreScrollPositions();
      if (performance.now() - scrollRestoreStartedAt >= 1200) {
        stopScrollRestoration();
        return;
      }
      scrollRestoreFrame = requestAnimationFrame(restoreUntilStable);
    };
    scrollRestoreFrame = requestAnimationFrame(restoreUntilStable);
  });
}

/** Reset scroll positions before a page navigation and discard pending restores for that page. */
export function resetScrollPositions(node: HTMLElement): void {
  const reset = (element: HTMLElement) => {
    element.scrollTop = 0;
    element.scrollLeft = 0;
  };
  reset(node);
  for (const child of node.querySelectorAll<HTMLElement>('*')) reset(child);

  for (const [key, position] of pendingScrollPositions) {
    const liveTarget = resolveScrollElement(position);
    if (node === position.element || node.contains(position.element)
      || liveTarget === node || (liveTarget && node.contains(liveTarget))) {
      pendingScrollPositions.delete(key);
    }
  }
  if (!pendingScrollPositions.size && scrollRestoreFrame !== null) stopScrollRestoration();
}

/** Create an SVG element with attributes (CSP-safe: presentation attrs, no inline style). */
export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag) as SVGElementTagNameMap[K];
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'textContent') node.textContent = String(value);
    else node.setAttribute(key, String(value));
  }
  return node;
}
