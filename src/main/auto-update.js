// Arc Power - M25: auto-update backend (GitHub Releases).
//
// Checks the GitHub Releases API for a newer version, downloads the matching
// installer/portable exe, and performs a safe handoff for installation.

import { app } from 'electron';
import { net } from 'electron';
import { randomUUID } from 'node:crypto';
import { fetchUpdateResponse } from './auto-update-download.js';
import {
  compareVersions,
  createUpdateReceiptRegistry,
  parseSha256Digest,
  parseReleaseTag,
  selectReleaseAsset,
} from './auto-update-pure.js';
import { createUpdateOperations } from './auto-update-runtime.js';

const OWNER = 'YamsSE';
const REPO = 'Arc-Power';
const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const checkedAssets = new Map();
const downloadReceipts = createUpdateReceiptRegistry({ createToken: randomUUID });

/**
 * Check GitHub Releases for a newer version.
 * Returns { available, version, assetUrl, assetName } or { available: false }.
 */
export async function checkForUpdates({ buildKind = 'portable' } = {}) {
  if (buildKind !== 'installed' && buildKind !== 'portable') return { available: false, reason: 'unknown-build-kind' };
  checkedAssets.delete(buildKind);
  const currentVersion = app.getVersion();

  const response = await fetchJson(API_URL);
  if (!response) return { available: false };

  const latestVersion = parseReleaseTag(response.tag_name);
  if (!latestVersion) return { available: false };
  if (compareVersions(latestVersion, currentVersion) <= 0) return { available: false };

  const asset = selectReleaseAsset(response, buildKind);
  if (!asset) return { available: false };

  const expectedSha256 = parseSha256Digest(asset.assetDigest);
  if (!expectedSha256) throw new Error('GitHub release asset is missing a valid SHA-256 digest');
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

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = net.request(url);
    request.setHeader('Accept', 'application/vnd.github.v3+json');
    request.setHeader('User-Agent', `Arc-Power/${app.getVersion()}`);

    let body = '';
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
      response.on('data', (chunk) => { body += chunk.toString(); });
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
