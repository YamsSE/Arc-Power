// Sidebar tab visibility preference. Dashboard, Tuning and Settings are always
// present; the remaining pages can be hidden from the sidebar without removing
// their routes or data. This is a local UI preference (like the sidebar width),
// so it stays out of the native settings envelope and its parity fixtures.
export interface HideableTab {
  id: string;
  label: string;
  description: string;
}

export const ALWAYS_VISIBLE_TAB_IDS = ['dashboard', 'tuning', 'settings'] as const;

export const HIDEABLE_TABS: readonly HideableTab[] = [
  { id: 'graphics', label: 'Graphics', description: 'Sharpening, frame generation and display controls.' },
  { id: 'arc-sleep', label: 'Arc Sleep', description: 'Idle and foreground frame-limit policy.' },
  { id: 'monitoring', label: 'Monitoring', description: 'Live telemetry charts, metrics and the overlay entry.' },
  { id: 'recording', label: 'Recording', description: 'Capture settings, Instant Replay and the clip library.' },
  { id: 'profiles', label: 'Profiles', description: 'Saved tuning presets and game profiles.' },
  { id: 'tweaks', label: 'Tweaks', description: 'Registry and system preference tweaks.' },
];

const STORAGE_KEY = 'arcpower.hiddenTabs.v1';
export const HIDDEN_TABS_EVENT = 'arcpower:hidden-tabs-changed';
const hideable = new Set(HIDEABLE_TABS.map((tab) => tab.id));

type Reader = Pick<Storage, 'getItem'>;
type Writer = Pick<Storage, 'setItem'>;

export function readHiddenTabs(storage: Reader = localStorage): Set<string> {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string =>
      typeof value === 'string' && hideable.has(value)));
  } catch {
    return new Set();
  }
}

export function writeHiddenTabs(hidden: Iterable<string>, storage: Writer = localStorage): void {
  const values = [...new Set([...hidden].filter((value) => hideable.has(value)))];
  try { storage.setItem(STORAGE_KEY, JSON.stringify(values)); } catch { /* storage unavailable */ }
}

export function isTabHidden(id: string, storage: Reader = localStorage): boolean {
  return hideable.has(id) && readHiddenTabs(storage).has(id);
}
