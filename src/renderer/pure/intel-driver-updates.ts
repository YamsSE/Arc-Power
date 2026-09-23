export type IntelDriverKind = 'arc' | 'pro';

export interface IntelDriverRelease {
  version: string;
  releaseDate: string | null;
  officialPageUrl: string;
  changelog: string[];
}

export interface IntelDriverUpdateCheck {
  arc: IntelDriverRelease | null;
  pro: IntelDriverRelease | null;
}

const DRIVER_CHECK_CACHE_MS = 15 * 60 * 1000;
const DRIVER_CHECK_RETRY_MS = 60 * 1000;

/** Cache complete checks briefly, but retry incomplete/offline checks after a short backoff. */
export function createIntelDriverCheckLoader(
  check: () => Promise<IntelDriverUpdateCheck>,
  { now = Date.now, cacheMs = DRIVER_CHECK_CACHE_MS, retryMs = DRIVER_CHECK_RETRY_MS } = {},
): () => Promise<IntelDriverUpdateCheck | null> {
  let request: Promise<IntelDriverUpdateCheck | null> | null = null;
  let expiresAt = 0;
  return () => {
    const currentTime = now();
    if (request && currentTime < expiresAt) return request;
    const next = Promise.resolve().then(check).catch(() => null);
    request = next;
    expiresAt = currentTime + retryMs;
    void next.then((result) => {
      if (request !== next) return;
      const complete = result?.arc !== null && result?.arc !== undefined
        && result?.pro !== null && result?.pro !== undefined;
      expiresAt = now() + (complete ? cacheMs : retryMs);
    });
    return next;
  };
}

/** Numeric-only versions can be ordered safely; suffixes are deliberately ambiguous. */
export function compareDriverVersions(latest: string, installed: string): number | null {
  const parse = (value: string): number[] | null => {
    const trimmed = value.trim();
    if (!/^\d+(?:\.\d+){0,3}$/.test(trimmed)) return null;
    const parts = trimmed.split('.').map(Number);
    if (parts.some((part) => !Number.isSafeInteger(part))) return null;
    while (parts.length < 4) parts.push(0);
    return parts;
  };
  const a = parse(latest);
  const b = parse(installed);
  if (!a || !b) return null;
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export function intelDriverKind(gpuVendor: string | null | undefined, name: string): IntelDriverKind | null {
  if (gpuVendor?.toLowerCase() !== 'intel') return null;
  if (/\barc\s+pro\b/i.test(name)) return 'pro';
  if (/\barc\b/i.test(name)) return 'arc';
  return null;
}

export function newerIntelRelease(kind: IntelDriverKind, installed: string, check: IntelDriverUpdateCheck): IntelDriverRelease | null {
  const release = check[kind];
  return release && compareDriverVersions(release.version, installed) === 1 ? release : null;
}
