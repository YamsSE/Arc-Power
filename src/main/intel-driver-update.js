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
const MAX_CHANGELOG_ITEMS = 20;
const MAX_CHANGELOG_ITEM_LENGTH = 1200;
const MAX_CHANGELOG_LENGTH = 4000;
const MAX_CATALOG_RELEASES = 100;
const CATALOG_CACHE_TTL_MS = 15 * 60 * 1000;
const PARTIAL_CATALOG_CACHE_TTL_MS = 60 * 1000;

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

function validReleaseUrl(value, kind) {
  try {
    const url = new URL(value, INTEL_DRIVER_PAGES[kind].officialPageUrl);
    const familyPath = new URL(INTEL_DRIVER_PAGES[kind].officialPageUrl).pathname;
    const familyId = familyPath.match(/\/download\/(\d+)\//i)?.[1];
    const familySlug = familyPath.match(/\/download\/\d+\/([^/]+\.html)$/i)?.[1];
    if (url.pathname === familyPath) {
      return url.protocol === 'https:' && url.hostname === 'www.intel.com' && !url.port
        && !url.username && !url.password && !url.search && !url.hash;
    }
    const match = url.pathname.match(/^\/content\/www\/us\/en\/download\/(\d+)\/(\d+)\/([^/]+\.html)$/i);
    return url.protocol === 'https:' && url.hostname === 'www.intel.com' && !url.port
      && !url.username && !url.password && !url.search && !url.hash
      && match?.[1] === familyId && Boolean(match?.[2])
      && match?.[3].toLowerCase() === familySlug?.toLowerCase();
  } catch { return false; }
}

function releaseSelectorHtml(source) {
  return String(source ?? '').match(/<select\b(?=[^>]*\bid\s*=\s*(["'])version-driver-select\1)[^>]*>([\s\S]*?)<\/select\s*>/i)?.[2] ?? null;
}

function extractReleaseOptions(source, kind) {
  const select = releaseSelectorHtml(source);
  if (!select) return [];
  const options = [];
  for (const match of select.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option\s*>/gi)) {
    const value = match[1].match(/\bvalue\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!value) continue;
    const version = decodeHtmlText(match[2]).match(/\b(\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5})\b/)?.[1];
    if (!version) continue;
    try {
      const url = new URL(value, INTEL_DRIVER_PAGES[kind].officialPageUrl).href;
      if (validReleaseUrl(url, kind)) options.push({ url, version });
    } catch { /* Ignore malformed Intel option values. */ }
  }
  return [...new Map(options.map((option) => [option.version, option])).values()];
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

function decodeHtmlText(value) {
  const namedEntities = {
    amp: '&', apos: "'", bull: '•', copy: '©', deg: '°', divide: '÷',
    gt: '>', hellip: '…', laquo: '«', ldquo: '“', lsaquo: '‹', lt: '<',
    mdash: '—', middot: '·', nbsp: ' ', ndash: '–', plusmn: '±', quot: '"',
    raquo: '»', rdquo: '”', reg: '®', rsaquo: '›', trade: '™', times: '×',
  };
  return String(value ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[\da-f]+;?|#\d+;?|[a-z][a-z\d]+;)/gi, (entity, reference) => {
      if (reference[0] !== '#') return namedEntities[reference.slice(0, -1).toLowerCase()] ?? entity;
      const hexadecimal = /^#x/i.test(reference);
      const digits = reference.slice(hexadecimal ? 2 : 1).replace(/;$/, '');
      const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
      if (!Number.isInteger(codePoint) || codePoint === 0 || codePoint > 0x10ffff
        || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return '\uFFFD';
      return String.fromCodePoint(codePoint);
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function extractChangelog(source) {
  const html = String(source ?? '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?(?:<\/style\s*>|$)/gi, ' ');
  const detailBlocks = [...html.matchAll(/<(h([1-6])|p)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)];
  const detail = detailBlocks.find((block) => /^Detailed\s+Description\s*:?$/i.test(decodeHtmlText(block[3])));
  if (!detail) return [];

  const detailLevel = Number(detail[2] ?? 0);
  const detailStart = detail.index + detail[0].length;
  const nextSection = detailBlocks.find((block) => {
    if (block.index < detailStart || !block[2]) return false;
    const level = Number(block[2]);
    if (level > detailLevel) return false;
    const title = decodeHtmlText(block[3]).replace(/:$/, '').trim();
    return !/^Highlights(?:\s+of\s+this\s+Workstation\s+Driver)?$/i.test(title);
  });
  const detailSection = html.slice(detailStart, nextSection?.index ?? html.length);
  const label = /Highlights(?:\s+of\s+this\s+Workstation\s+Driver)?\s*:?/i.exec(detailSection);
  if (!label) return [];

  const section = detailSection.slice(label.index + label[0].length);
  const tokens = [...section.matchAll(/<[^>]*>|[^<]+/gi)];
  const liStack = [];
  const listStack = [];
  const blockStack = [];
  const events = [];
  let looseText = '';
  let malformed = false;
  let stopped = false;
  const stopLabel = /^(?:OS\s+Support|OS\s+Reference|Platform\s+Support|Platform\s*\(\s*OS\s+Support\s*\)|Notes?|Products?|Supported\s+Products|Products?\s+Supported)\s*(?::|$)/i;
  const flushLooseText = () => {
    const text = decodeHtmlText(looseText);
    if (text) events.push({ order: events.length, text });
    looseText = '';
  };

  for (const token of tokens) {
    const value = token[0];
    if (!value.startsWith('<')) {
      const decoded = decodeHtmlText(value);
      if (liStack.length) liStack[liStack.length - 1].text += `${value} `;
      else if (blockStack.length) blockStack[blockStack.length - 1].text += `${value} `;
      else {
        if (stopLabel.test(decoded)) { stopped = true; break; }
        looseText += `${value} `;
      }
      continue;
    }

    const tag = value.match(/^<\s*(\/?)\s*([a-z0-9]+)/i);
    if (!tag) continue;
    const closing = tag[1] === '/';
    const name = tag[2].toLowerCase();
    if (!closing && (name === 'ul' || name === 'ol')) {
      flushLooseText();
      listStack.push(name);
    } else if (closing && (name === 'ul' || name === 'ol')) {
      if (listStack.pop() !== name) { malformed = true; break; }
    } else if (!closing && name === 'li') {
      flushLooseText();
      const item = { text: '', order: events.length };
      events.push(item);
      liStack.push(item);
    } else if (/^<\/li\s*>/i.test(value)) {
      if (!liStack.length) { malformed = true; break; }
      const item = liStack.pop();
      item.text = decodeHtmlText(item.text);
    } else if (!closing && /^h[1-6]$/.test(name)) {
      flushLooseText();
      blockStack.push({ name, text: '' });
    } else if (closing && /^h[1-6]$/.test(name)) {
      const block = blockStack.pop();
      if (!block) continue;
      if (block.name !== name) { malformed = true; break; }
      stopped = true;
      break;
    } else if (!closing && name === 'p') {
      flushLooseText();
      blockStack.push({ name, text: '' });
    } else if (closing && name === 'p') {
      const block = blockStack.pop();
      if (!block) continue;
      if (block.name !== name) { malformed = true; break; }
      if (stopLabel.test(decodeHtmlText(block.text))) { stopped = true; break; }
      if (block.text.trim()) events.push({ order: events.length, text: decodeHtmlText(block.text) });
    } else if (name === 'br' && !closing) {
      if (liStack.length) liStack[liStack.length - 1].text += ' ';
      else if (blockStack.length) blockStack[blockStack.length - 1].text += ' ';
      else flushLooseText();
    }
  }
  flushLooseText();
  if (malformed || liStack.length || listStack.length || blockStack.length) return [];

  const result = [];
  let totalLength = 0;
  for (const { text: item } of events.sort((a, b) => a.order - b.order)) {
    if (!item) continue;
    if (result.length >= MAX_CHANGELOG_ITEMS) return [];
    if (item.length > MAX_CHANGELOG_ITEM_LENGTH || totalLength + item.length > MAX_CHANGELOG_LENGTH) return [];
    result.push(item);
    totalLength += item.length;
  }
  return result;
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
  return { version, releaseDate, changelog: extractChangelog(source) };
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
  const catalogCache = new Map();
  const catalogRequests = new Map();
  async function fetchHtml(url, expectedUrl = url, signal = null) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const response = await fetchImpl(url, { signal: requestSignal, redirect: 'error' });
      if (!response.ok || !validOfficialUrl(response.url || expectedUrl, expectedUrl)) throw new Error('Intel metadata request failed validation');
      return await readBoundedBody(response, maxResponseBytes);
    } finally { clearTimeout(timer); }
  }
  async function fetchRelease(kind, url, signal = null) {
    if (!validReleaseUrl(url, kind)) throw new Error('Intel release URL is not allowed');
    const source = await fetchHtml(url, url, signal);
    const metadata = parseIntelDriverMetadata(source);
    if (!metadata) throw new Error('Intel driver metadata was not found');
    const sizeMatch = source.match(/\bSize\b\s*:?\s*(?:<[^>]*>\s*)*(\d+(?:\.\d+)?)\s*(GB|MB|KB|bytes?)\b/i);
    let sizeBytes = null;
    if (sizeMatch) {
      const unit = sizeMatch[2].toLowerCase();
      const multiplier = unit.startsWith('g') ? 1024 ** 3 : unit.startsWith('m') ? 1024 ** 2 : unit.startsWith('k') ? 1024 : 1;
      const parsedSize = Math.round(Number(sizeMatch[1]) * multiplier);
      if (Number.isSafeInteger(parsedSize) && parsedSize > 0) sizeBytes = parsedSize;
    }
    return { ...metadata, sizeBytes, officialPageUrl: url };
  }
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
          const parsed = parseIntelDriverMetadata(await fetchHtml(config.officialPageUrl));
          if (!parsed) throw new Error('Intel driver metadata was not found');
          const value = { ...parsed, officialPageUrl: config.officialPageUrl };
          cache.set(kind, { value, at: now() });
          result[kind] = value;
        } catch {
          // A previous official result remains useful during a transient outage.
          result[kind] = cached?.value ?? null;
        }
      }));
      return result;
    },
    async library(kind) {
      if (!INTEL_DRIVER_PAGES[kind]) throw new Error('invalid Intel driver catalog kind');
      const currentTime = now();
      const cached = catalogCache.get(kind);
      if (cached && currentTime < cached.expiresAt) return cached.value;
      const pending = catalogRequests.get(kind);
      if (pending) return pending;
      const request = (async () => {
        const latestUrl = INTEL_DRIVER_PAGES[kind].officialPageUrl;
        const html = await fetchHtml(latestUrl);
        const selector = releaseSelectorHtml(html);
        const options = extractReleaseOptions(html, kind);
        const selectorOptionCount = selector?.match(/<option\b/gi)?.length ?? 0;
        const readableOptionCount = options.length;
        const latest = parseIntelDriverMetadata(html);
        if (latest && !options.some((option) => option.version === latest.version)) {
          options.unshift({ url: latestUrl, version: latest.version });
        }
        const partial = !selector || selectorOptionCount === 0
          || readableOptionCount < selectorOptionCount || options.length > MAX_CATALOG_RELEASES;
        const versions = options.slice(0, MAX_CATALOG_RELEASES).map((option) => option.version);
        if (!versions.length) throw new Error('Intel driver catalog contains no readable versions');
        const value = { versions, partial };
        catalogCache.set(kind, {
          value,
          expiresAt: now() + (value.partial ? PARTIAL_CATALOG_CACHE_TTL_MS : CATALOG_CACHE_TTL_MS),
        });
        return value;
      })();
      catalogRequests.set(kind, request);
      try { return await request; }
      finally { if (catalogRequests.get(kind) === request) catalogRequests.delete(kind); }
    },
    async resolveRelease(kind, version, signal = null) {
      if (!INTEL_DRIVER_PAGES[kind] || typeof version !== 'string' || !/^\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version)) throw new Error('invalid Intel driver release identity');
      const selectorUrl = INTEL_DRIVER_PAGES[kind].officialPageUrl;
      const selectorHtml = await fetchHtml(selectorUrl, selectorUrl, signal);
      const availableReleases = extractReleaseOptions(selectorHtml, kind);
      const latest = parseIntelDriverMetadata(selectorHtml);
      const selected = availableReleases.find((release) => release.version === version)
        ?? (latest?.version === version ? { url: selectorUrl, version } : null);
      if (!selected || !validReleaseUrl(selected.url, kind)) throw new Error('Intel driver version is not available in the official catalog');
      // Re-fetch only the selected, currently listed official detail page.
      const release = await fetchRelease(kind, selected.url, signal);
      if (release.version !== version) throw new Error('Intel release page version does not match the selected version');
      return release;
    },
  };
}
