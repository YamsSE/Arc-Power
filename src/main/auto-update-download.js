// Transport helpers for GitHub release asset downloads.

import { Readable, Transform } from 'node:stream';

const MAX_REDIRECTS = 5;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_HEADER_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 45_000;

function isAllowedDownloadUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  const githubHost = hostname === 'github.com'
    || hostname.endsWith('.github.com')
    || hostname.endsWith('.githubusercontent.com');
  if (parsed.protocol !== 'https:' || !githubHost) return null;
  return parsed.toString();
}

function responseHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (typeof value === 'string') result[key] = value;
    else if (Array.isArray(value) && typeof value[0] === 'string') result[key] = value[0];
  }
  return result;
}

function isSuccessfulStatus(statusCode) {
  return statusCode >= 200 && statusCode < 300;
}

function redirectedUrl(location, baseUrl) {
  if (!location) return null;
  try {
    return isAllowedDownloadUrl(new URL(location, baseUrl).toString());
  } catch {
    return null;
  }
}

/**
 * Read a GitHub asset response through an injected request factory. The
 * factory keeps this transport seam testable without importing Electron.
 * Only HTTPS GitHub-hosted URLs are accepted, redirects are bounded, and a
 * successful response is exposed as a streaming body so the caller can report
 * progress while the asset is actually arriving. Header and idle timeouts
 * bound stalled requests without buffering the executable in memory.
 */
export function fetchUpdateResponse(url, requestFactory, redirectCount = 0, {
  headerTimeoutMs = DEFAULT_HEADER_TIMEOUT_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
} = {}) {
  const targetUrl = isAllowedDownloadUrl(url);
  if (!targetUrl || typeof requestFactory !== 'function' || redirectCount > MAX_REDIRECTS) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let request;
    try {
      request = requestFactory(targetUrl);
    } catch {
      resolve(null);
      return;
    }

    let settled = false;
    let responseStarted = false;
    let bodyStream = null;
    let idleTimeout = null;
    const headerTimeout = setTimeout(() => {
      try { request.abort?.(); } catch { /* best effort */ }
      finish(null);
    }, headerTimeoutMs);
    headerTimeout.unref?.();
    const finish = (value, { keepBodyTimer = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(headerTimeout);
      if (!keepBodyTimer) clearTimeout(idleTimeout);
      resolve(value);
    };
    const fail = () => {
      if (bodyStream) bodyStream.destroy(new Error('Update download failed while streaming'));
      finish(null);
    };
    let redirectsFollowed = redirectCount;
    request.on('redirect', (statusCode, method, redirectUrl) => {
      const code = Number(statusCode);
      if (!REDIRECT_STATUS_CODES.has(code)) {
        finish(null);
        return;
      }
      // Electron's manual redirect mode cancels the request unless this is
      // called synchronously from the redirect event. Validate the target
      // before continuing the same request; never hand an untrusted Location
      // to Electron's transport.
      const nextUrl = redirectedUrl(redirectUrl, targetUrl);
      if (!nextUrl || redirectsFollowed >= MAX_REDIRECTS || typeof request.followRedirect !== 'function') {
        finish(null);
        return;
      }
      redirectsFollowed += 1;
      request.followRedirect();
    });
    request.on('response', (response) => {
      if (responseStarted) return;
      responseStarted = true;
      clearTimeout(headerTimeout);
      response.on('error', (error) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (bodyStream) bodyStream.destroy(failure);
        else finish(null);
      });
      response.on('aborted', () => {
        const failure = new Error('Update download response was interrupted');
        if (bodyStream) bodyStream.destroy(failure);
        else finish(null);
      });
      const statusCode = Number(response?.statusCode ?? 0);
      if (!isSuccessfulStatus(statusCode)) {
        response.destroy?.();
        finish(null);
        return;
      }

      let receivedBytes = false;
      const resetIdleTimeout = () => {
        clearTimeout(idleTimeout);
        idleTimeout = setTimeout(() => {
          const error = new Error(`Update download stalled with no data for ${idleTimeoutMs} ms`);
          try { request.abort?.(); } catch { /* best effort */ }
          bodyStream?.destroy(error);
        }, idleTimeoutMs);
        idleTimeout.unref?.();
      };
      bodyStream = new Transform({
        transform(chunk, encoding, callback) {
          receivedBytes = true;
          resetIdleTimeout();
          callback(null, chunk);
        },
        flush(callback) {
          clearTimeout(idleTimeout);
          if (!receivedBytes) callback(new Error('Update download returned an empty response'));
          else callback();
        },
      });
      bodyStream.on('error', () => clearTimeout(idleTimeout));
      resetIdleTimeout();
      response.pipe(bodyStream);
      finish(new Response(Readable.toWeb(bodyStream), {
        status: statusCode,
        headers: responseHeaders(response.headers),
      }), { keepBodyTimer: true });
    });
    request.on('error', (error) => {
      if (bodyStream) bodyStream.destroy(error instanceof Error ? error : new Error(String(error)));
      else fail();
    });
    request.end();
  });
}
