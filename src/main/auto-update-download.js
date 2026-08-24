// Transport helpers for GitHub release asset downloads.

const MAX_REDIRECTS = 5;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

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
 * successful response must contain at least one byte.
 */
export function fetchUpdateResponse(url, requestFactory, redirectCount = 0) {
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
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = () => finish(null);
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
      const statusCode = Number(response?.statusCode ?? 0);
      const chunks = [];
      response.on('error', fail);
      response.on('data', (chunk) => {
        if (isSuccessfulStatus(statusCode)) chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => {
        if (!isSuccessfulStatus(statusCode)) {
          finish(null);
          return;
        }

        const body = Buffer.concat(chunks);
        if (body.length === 0) {
          finish(null);
          return;
        }
        finish(new Response(body, {
          status: statusCode,
          headers: responseHeaders(response.headers),
        }));
      });
    });
    request.on('error', fail);
    request.end();
  });
}
