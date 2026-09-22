// Read-only metadata for Intel's fixed Arc driver download pages.
// This service never downloads or launches a driver package.

export const INTEL_DRIVER_PAGES = Object.freeze({
  arc: Object.freeze({
    officialPageUrl: 'https://www.intel.com/content/www/us/en/download/785597/intel-arc-graphics-windows.html',
  }),
  pro: Object.freeze({
    officialPageUrl: 'https://www.intel.com/content/www/us/en/download/741626/intel-arc-pro-graphics-windows.html',
  }),
});

const FETCH_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CACHE_TTL_MS = 15 * 60 * 1000;

function validOfficialUrl(value, expectedUrl) {
  try {
    const parsed = new URL(value);
    const expected = new URL(expectedUrl);
    return parsed.protocol === 'https:'
      && parsed.hostname === 'www.intel.com'
      && parsed.port === ''
      && parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === ''
      && parsed.pathname === expected.pathname;
  } catch {
    return false;
  }
}

function stripMarkup(value) {
  return String(value ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ');
}

function metaAttribute(source, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = String(source ?? '').match(new RegExp(`<meta\\b(?=[^>]*\\bname\\s*=\\s*["']${escapedName}["'])[^>]*>`, 'i'))?.[0];
  if (!tag) return null;
  return tag.match(/\bcontent\s*=\s*(["'])(.*?)\1/i)?.[2] ?? null;
}

function normalizeDate(value) {
  const candidate = String(value ?? '').trim();
  let year; let month; let day;
  let match = candidate.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i);
  if (match) [, year, month, day] = match;
  else {
    match = candidate.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/);
    if (match) [, month, day, year] = match;
    else {
      match = candidate.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
      if (!match) return null;
      const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
      month = months.indexOf(match[1].toLowerCase()) + 1;
      [, , day, year] = match;
      if (month === 0) return null;
    }
  }
  const y = Number(year); const m = Number(month); const d = Number(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** Parse the latest driver version and optional date from official page HTML/text. */
export function parseIntelDriverMetadata(source) {
  const text = stripMarkup(source);
  const versionPattern = /(\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5})(?!\d)(?!\.\d)/;
  const metaVersion = metaAttribute(source, 'DownloadVersion')?.trim().match(/^\s*(\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5})(?!\d)(?!\.\d)/)?.[1] ?? null;
  const bodyVersion = text.match(/Intel(?:®)?\s+Graphics\s+Driver\s+(\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5})(?!\d)(?!\.\d)/i)?.[1] ?? null;
  const version = metaVersion ?? bodyVersion;
  if (!version) return null;

  let releaseDate = null;
  const metaDate = metaAttribute(source, 'lastModifieddate');
  if (metaDate) releaseDate = normalizeDate(metaDate);
  if (!releaseDate) {
    const dateMatch = text.match(/(?:release\s*date|date\s*released|published)\s*[:\-]?\s*((?:\d{4}[-/]\d{1,2}[-/]\d{1,2})|(?:\d{1,2}[/-]\d{1,2}[/-]\d{4})|(?:[A-Za-z]+\s+\d{1,2},?\s+\d{4}))/i);
    if (dateMatch) releaseDate = normalizeDate(dateMatch[1]);
  }
  return { version, releaseDate };
}

async function readBoundedBody(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('Intel metadata response too large');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Intel metadata response too large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('Intel metadata response too large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

export function createIntelDriverUpdateService({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = FETCH_TIMEOUT_MS,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  cacheTtlMs = CACHE_TTL_MS,
} = {}) {
  const cache = new Map();
  return {
    async check() {
      const result = { arc: null, pro: null };
      await Promise.all(Object.entries(INTEL_DRIVER_PAGES).map(async ([kind, config]) => {
        const cached = cache.get(kind);
        if (cached && now() - cached.at < cacheTtlMs) {
          result[kind] = cached.value;
          return;
        }
        try {
          if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          let response;
          try {
            response = await fetchImpl(config.officialPageUrl, { signal: controller.signal, redirect: 'error' });
            if (!response.ok || !validOfficialUrl(response.url || config.officialPageUrl, config.officialPageUrl)) {
              throw new Error('Intel metadata request failed validation');
            }
            const parsed = parseIntelDriverMetadata(await readBoundedBody(response, maxResponseBytes));
            if (!parsed) throw new Error('Intel driver metadata was not found');
            const value = { ...parsed, officialPageUrl: config.officialPageUrl };
            cache.set(kind, { value, at: now() });
            result[kind] = value;
          } finally {
            clearTimeout(timer);
          }
        } catch {
          // A previous official result remains useful during a transient outage.
          result[kind] = cached?.value ?? null;
        }
      }));
      return result;
    },
  };
}
