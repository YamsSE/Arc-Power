// Arc Power - M25: auto-update backend (GitHub Releases).
//
// Checks the GitHub Releases API for a newer version, downloads the matching
// installer/portable exe, and performs a safe handoff for installation.

import { app } from 'electron';
import { net } from 'electron';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { fetchUpdateResponse } from './auto-update-download.js';
import {
  compareVersions,
  createUpdateReceiptRegistry,
  expectedAssetName,
  parseSha256Digest,
  parseReleaseTag,
  selectReleaseAsset,
} from './auto-update-pure.js';
import { createUpdateOperations } from './auto-update-runtime.js';

const OWNER = 'YamsSE';
const REPO = 'Arc-Power';
const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const MAX_NATIVE_RELEASE_BYTES = 1024 * 1024;
const MAX_NATIVE_RELEASE_DEPTH = 32;
const MAX_NATIVE_RELEASE_ASSETS = 256;
const MAX_NATIVE_RELEASE_NODES = 50_000;
const checkedAssets = new Map();
const downloadReceipts = createUpdateReceiptRegistry({ createToken: randomUUID });

/**
 * Check GitHub Releases for a newer version.
 * Returns { available, version, assetUrl, assetName } or { available: false }.
 */
export async function checkForUpdates({ buildKind = 'portable', selectReleaseNative = null } = {}) {
  if (buildKind !== 'installed' && buildKind !== 'portable') return { available: false, reason: 'unknown-build-kind' };
  checkedAssets.delete(buildKind);
  const currentVersion = app.getVersion();

  const response = await fetchJson(API_URL, typeof selectReleaseNative === 'function' ? MAX_NATIVE_RELEASE_BYTES : null);
  if (!response) return { available: false };

  let latestVersion;
  let asset;
  let expectedSha256;
  if (typeof selectReleaseNative === 'function') {
    assertBoundedReleaseMetadata(response);
    const selection = await selectReleaseNative(response, buildKind, currentVersion);
    if (!selection || typeof selection !== 'object' || Array.isArray(selection) || typeof selection.available !== 'boolean') {
      throw new Error('Native updater returned an invalid release selection');
    }
    if (!selection.available) return { available: false };
    const expectedName = expectedAssetName(buildKind);
    if (selection.assetName !== expectedName || typeof selection.version !== 'string'
      || typeof selection.assetUrl !== 'string' || typeof selection.assetDigest !== 'string'
      || typeof selection.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(selection.expectedSha256)
      || !(selection.assetSize === null || (Number.isSafeInteger(selection.assetSize) && selection.assetSize > 0))) {
      throw new Error('Native updater returned invalid trusted release metadata');
    }
    latestVersion = selection.version;
    expectedSha256 = selection.expectedSha256;
    asset = {
      assetName: selection.assetName,
      assetUrl: selection.assetUrl,
      assetSize: selection.assetSize,
      assetDigest: selection.assetDigest,
    };
  } else {
    latestVersion = parseReleaseTag(response.tag_name);
    if (!latestVersion) return { available: false };
    if (compareVersions(latestVersion, currentVersion) <= 0) return { available: false };
    asset = selectReleaseAsset(response, buildKind);
    if (!asset) return { available: false };
    expectedSha256 = parseSha256Digest(asset.assetDigest);
    if (!expectedSha256) throw new Error('GitHub release asset is missing a valid SHA-256 digest');
  }
  const trustedAsset = { ...asset, version: latestVersion, expectedSha256 };
  checkedAssets.set(buildKind, trustedAsset);

  return {
    available: true,
    version: latestVersion,
    assetUrl: asset.assetUrl,
    assetName: asset.assetName,
    assetSize: asset.assetSize,
  };
}

function assertBoundedReleaseMetadata(release) {
  const pending = [[release, 0]];
  let visited = 0;
  while (pending.length) {
    const [value, depth] = pending.pop();
    visited += 1;
    if (depth > MAX_NATIVE_RELEASE_DEPTH || visited > MAX_NATIVE_RELEASE_NODES) {
      throw new Error('GitHub release metadata exceeds the native selection structure limit');
    }
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        if (value === release?.assets && value.length > MAX_NATIVE_RELEASE_ASSETS) {
          throw new Error('GitHub release metadata exceeds the native asset count limit');
        }
        if (visited + pending.length + value.length > MAX_NATIVE_RELEASE_NODES) {
          throw new Error('GitHub release metadata exceeds the native selection structure limit');
        }
        for (const child of value) pending.push([child, depth + 1]);
      } else {
        let childCount = 0;
        for (const key in value) if (Object.hasOwn(value, key)) childCount += 1;
        if (visited + pending.length + childCount > MAX_NATIVE_RELEASE_NODES) {
          throw new Error('GitHub release metadata exceeds the native selection structure limit');
        }
        for (const key of Object.keys(value)) pending.push([value[key], depth + 1]);
      }
    }
  }
  const serialized = JSON.stringify(release);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_NATIVE_RELEASE_BYTES) {
    throw new Error('GitHub release metadata exceeds the native selection size limit');
  }
}

const defaultUpdateOperations = createUpdateOperations({ appApi: app, netApi: net, fetchResponse: fetchUpdateResponse });
export async function downloadUpdate(assetUrl, onProgress, buildKind = 'portable') {
  const asset = checkedAssets.get(buildKind);
  if (!asset || asset.assetUrl !== assetUrl) throw new Error('Update asset is not authorized by the latest main-process release check');
  const downloaded = await defaultUpdateOperations.downloadUpdate(asset.assetUrl, onProgress, buildKind, asset);
  const token = downloadReceipts.issue({ ...downloaded, buildKind, assetUrl: asset.assetUrl, version: asset.version });
  return { token };
}

export async function installUpdate(token, options = {}) {
  return downloadReceipts.install(token, options.buildKind, (receipt) => defaultUpdateOperations.installUpdate(receipt, options));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fetchJson(url, maxResponseBytes = null) {
  return new Promise((resolve, reject) => {
    const request = net.request(url);
    request.setHeader('Accept', 'application/vnd.github.v3+json');
    request.setHeader('User-Agent', `Arc-Power/${app.getVersion()}`);

    let body = '';
    let bodyBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.abort();
      reject(new Error('GitHub release check timed out'));
    }, 15000);
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    };
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        fail(new Error(`GitHub release check returned HTTP ${response.statusCode ?? 'unknown'}`));
        return;
      }
      response.on('data', (chunk) => {
        if (settled) return;
        if (maxResponseBytes !== null) {
          bodyBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
          if (bodyBytes > maxResponseBytes) {
            fail(new Error('GitHub release check response exceeded the native selection size limit'));
            request.abort();
            return;
          }
        }
        body += chunk.toString();
      });
      response.on('end', () => {
        if (settled) return;
        try {
          const parsed = JSON.parse(body);
          settled = true;
          clearTimeout(timeout);
          resolve(parsed);
        } catch {
          fail(new Error('GitHub release check returned invalid JSON'));
        }
      });
      response.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
    });
    request.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
    request.end();
  });
}
