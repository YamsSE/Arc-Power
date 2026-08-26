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
  node.replaceChildren();
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
