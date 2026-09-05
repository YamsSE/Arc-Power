// Arc Power - renderer-owned dropdown. Keeping the menu in the owning
// BrowserWindow avoids native popup windows being clipped or placed below the
// always-on-top Advanced Overlay.

import { el } from '../dom.ts';
import { selectorSelectionIndices } from '../pure/device.ts';

export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
  group?: string;
}

export type DropdownElement = HTMLElement & {
  value: string;
  setValue: (value: string) => void;
  disabled: boolean;
  readonly options: HTMLElement[];
  readonly selectedIndex: number;
};

export interface DropdownConfig {
  className?: string;
  ariaLabel: string;
  title?: string;
  dataset?: Record<string, string>;
  disabled?: boolean;
  onChange?: (value: string) => void;
}

type OpenDropdown = {
  root: DropdownElement;
  menu: HTMLElement;
  close: (restoreFocus?: boolean) => void;
};

let openDropdown: OpenDropdown | null = null;
let dismissBound = false;

function bindDismiss(): void {
  if (dismissBound || typeof document === 'undefined') return;
  dismissBound = true;
  document.addEventListener('pointerdown', (event) => {
    const active = openDropdown;
    const target = event.target as Node | null;
    if (active && target && !active.root.contains(target) && !active.menu.contains(target)) {
      active.close(false);
    }
  });
}

export function closeDropdownMenus(restoreFocus = false): void {
  openDropdown?.close(restoreFocus);
}

function enabledIndex(options: readonly DropdownOption[], from: number, delta: number): number {
  if (options.length === 0) return 0;
  let index = from;
  for (let count = 0; count < options.length; count += 1) {
    index = (index + delta + options.length) % options.length;
    if (options[index]?.disabled !== true) return index;
  }
  return from;
}

function lastEnabledIndex(options: readonly DropdownOption[]): number {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (options[index]?.disabled !== true) return index;
  }
  return 0;
}

function dropdownOptionNodes(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>('[role="option"]')];
}

export function buildDropdown(
  value: string,
  options: readonly DropdownOption[],
  config: DropdownConfig,
): DropdownElement {
  bindDismiss();
  const sourceOptions = options.map((option) => ({ ...option }));
  const root = el('div', {
    class: `shared-dropdown${config.className ? ` ${config.className}` : ''}`,
    role: 'combobox',
    tabindex: '0',
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
    'aria-label': config.ariaLabel,
    ...(config.title ? { title: config.title } : {}),
    dataset: config.dataset,
  }) as unknown as DropdownElement;
  const valueNode = el('span', { class: 'shared-dropdown-value' });
  const menuId = `dropdown-menu-${Math.random().toString(36).slice(2)}`;
  const menu = el('div', {
    class: 'shared-dropdown-menu',
    id: menuId,
    role: 'listbox',
    hidden: true,
  });
  const selection = selectorSelectionIndices(sourceOptions, value);
  let selected = selection.selectedIndex;
  let active = selection.activeIndex;
  let typeahead = '';
  let typeaheadTimer: number | null = null;

  const optionNodes: HTMLElement[] = [];
  let rootDisabled = config.disabled === true;

  const updateValue = (): void => {
    const selectedOption = sourceOptions[selected];
    valueNode.textContent = selectedOption?.label ?? '';
    root.dataset.value = selectedOption?.value ?? '';
    if (openDropdown?.root === root) {
      root.setAttribute('aria-activedescendant', `${menuId}-option-${active}`);
    }
    optionNodes.forEach((option, index) => {
      option.setAttribute('aria-selected', index === selected ? 'true' : 'false');
      option.classList.toggle('is-active', index === active && openDropdown?.root === root);
    });
    optionNodes[active]?.scrollIntoView({ block: 'nearest' });
  };

  const close = (restoreFocus = false): void => {
    menu.hidden = true;
    if (menu.parentElement !== root) root.append(menu);
    root.setAttribute('aria-expanded', 'false');
    root.removeAttribute('aria-controls');
    root.removeAttribute('aria-activedescendant');
    optionNodes.forEach((option) => option.classList.remove('is-active'));
    if (openDropdown?.root === root) openDropdown = null;
    if (restoreFocus) root.focus();
  };

  const open = (): void => {
    if (rootDisabled || sourceOptions.length === 0) return;
    if (openDropdown && openDropdown.root !== root) openDropdown.close(false);
    const rect = root.getBoundingClientRect();
    const estimatedHeight = Math.min(320, sourceOptions.length * 30 + 8);
    const roomBelow = window.innerHeight - rect.bottom - 8;
    const top = roomBelow >= estimatedHeight
      ? rect.bottom + 4
      : Math.max(8, rect.top - estimatedHeight - 4);
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 160) - 8))}px`;
    menu.style.top = `${top}px`;
    menu.style.minWidth = `${Math.max(rect.width, 160)}px`;
    document.body.append(menu);
    menu.hidden = false;
    root.setAttribute('aria-expanded', 'true');
    root.setAttribute('aria-controls', menuId);
    active = sourceOptions[selected]?.disabled === true
      ? sourceOptions.findIndex((option) => option.disabled !== true)
      : selected;
    if (active < 0) active = selected;
    openDropdown = { root, menu, close };
    updateValue();
    root.focus();
  };

  const choose = (index: number): void => {
    const option = sourceOptions[index];
    if (!option || option.disabled) return;
    selected = index;
    active = index;
    close(true);
    updateValue();
    config.onChange?.(option.value);
    root.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const setValue = (next: string): void => {
    const index = sourceOptions.findIndex((option) => option.value === next);
    if (index < 0) return;
    selected = index;
    active = index;
    updateValue();
  };

  Object.defineProperties(root, {
    value: {
      configurable: true,
      get: () => sourceOptions[selected]?.value ?? '',
      set: (next: string) => setValue(String(next)),
    },
    setValue: { configurable: true, value: setValue },
    disabled: {
      configurable: true,
      get: () => rootDisabled,
      set: (next: boolean) => {
        rootDisabled = next === true;
        root.classList.toggle('is-disabled', rootDisabled);
        root.setAttribute('aria-disabled', rootDisabled ? 'true' : 'false');
        if (rootDisabled && openDropdown?.root === root) close(false);
      },
    },
    options: { configurable: true, get: () => optionNodes },
    selectedIndex: { configurable: true, get: () => selected },
  });

  root.append(valueNode);
  let currentGroup: string | undefined;
  sourceOptions.forEach((optionData, index) => {
    if (optionData.group && optionData.group !== currentGroup) {
      currentGroup = optionData.group;
      menu.append(el('div', {
        class: 'shared-dropdown-group',
        role: 'presentation',
        text: optionData.group,
      }));
    }
    const option = el('div', {
      class: `shared-dropdown-option${optionData.disabled ? ' is-disabled' : ''}`,
      id: `${menuId}-option-${index}`,
      role: 'option',
      tabindex: '-1',
      'aria-selected': index === selected ? 'true' : 'false',
      'aria-disabled': optionData.disabled ? 'true' : 'false',
      text: optionData.label,
      dataset: { value: optionData.value },
    });
    optionNodes.push(option);
    option.addEventListener('pointermove', () => {
      if (!optionData.disabled) {
        active = index;
        updateValue();
      }
    });
    option.addEventListener('click', (event) => {
      event.preventDefault();
      choose(index);
    });
    menu.append(option);
  });

  root.disabled = rootDisabled;
  updateValue();
  root.addEventListener('click', (event) => {
    if ((event.target as HTMLElement | null)?.closest('[role="option"]')) return;
    if (rootDisabled) return;
    if (openDropdown?.root === root) close(true);
    else open();
  });
  root.addEventListener('keydown', (event: KeyboardEvent) => {
    if (rootDisabled) return;
    if (event.key === 'Escape') {
      if (openDropdown?.root === root) close(true);
      event.preventDefault();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (openDropdown?.root !== root) open();
      active = enabledIndex(sourceOptions, active, event.key === 'ArrowDown' ? 1 : -1);
      updateValue();
      event.preventDefault();
      return;
    }
    if (event.key === 'Home' && openDropdown?.root === root) {
      active = sourceOptions.findIndex((option) => option.disabled !== true);
      if (active < 0) active = selected;
      updateValue();
      event.preventDefault();
      return;
    }
    if (event.key === 'End' && openDropdown?.root === root) {
      active = lastEnabledIndex(sourceOptions);
      updateValue();
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      if (openDropdown?.root === root) choose(active);
      else open();
      event.preventDefault();
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      typeahead += event.key.toLocaleLowerCase();
      if (typeaheadTimer !== null) window.clearTimeout(typeaheadTimer);
      typeaheadTimer = window.setTimeout(() => { typeahead = ''; }, 700);
      if (openDropdown?.root !== root) open();
      const match = sourceOptions.findIndex((option) => option.disabled !== true
        && `${option.label} ${option.value}`.toLocaleLowerCase().startsWith(typeahead));
      if (match >= 0) {
        active = match;
        updateValue();
      }
      event.preventDefault();
    }
  });
  root.addEventListener('focusout', (event: FocusEvent) => {
    const related = event.relatedTarget as Node | null;
    if (related && (root.contains(related) || menu.contains(related))) return;
    window.setTimeout(() => {
      if (openDropdown?.root === root && document.activeElement !== root) close(false);
    }, 0);
  });
  return root;
}
