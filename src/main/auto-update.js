// Arc Power - M25: auto-update backend (GitHub Releases).
//
// Checks the GitHub Releases API for a newer version, downloads the
// installer/portable exe, and triggers the install (NSIS silent or
// portable file swap). Portable builds download but prompt the user to
// manually replace; installed builds run the NSIS installer silently.

import { app, shell, BrowserWindow } from 'electron';
import { net } from 'electron';
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fetchUpdateResponse } from './auto-update-download.js';

const OWNER = 'YamsSE';
const REPO = 'Arc-Power';
const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

/** Compare two semver strings. Returns >0 if a > b, <0 if a < b, 0 if equal. */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/** Parse a GitHub release tag like "v1.0.3" or "1.0.3" into a bare semver. */
function parseTag(tag) {
  const m = /^v?(\d+\.\d+\.\d+)$/.exec(tag);
  return m ? m[1] : null;
}

/**
 * Check GitHub Releases for a newer version.
 * Returns { available, version, assetUrl, assetName } or { available: false }.
 */
export async function checkForUpdates() {
  const currentVersion = app.getVersion();

  const response = await fetchJson(API_URL);
  if (!response) return { available: false };

  const latestVersion = parseTag(response.tag_name);
  if (!latestVersion) return { available: false };
  if (compareVersions(latestVersion, currentVersion) <= 0) return { available: false };

  // Find the best asset: prefer NSIS installer, then portable exe
  const assets = response.assets ?? [];
  const nsisAsset = assets.find((a) => /_Installer\.exe$/i.test(a.name));
  const portableAsset = assets.find((a) => /_Portable\.exe$/i.test(a.name));
  const asset = nsisAsset ?? portableAsset ?? assets.find((a) => /\.exe$/i.test(a.name));

  if (!asset) return { available: false };

  return {
    available: true,
    version: latestVersion,
    assetUrl: asset.browser_download_url,
    assetName: asset.name,
  };
}

/**
 * Download an update asset to a temp file.
 * Returns the path to the downloaded file.
 */
export async function downloadUpdate(url, onProgress) {
  const tmpDir = join(tmpdir(), 'arc-power-updates');
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  const fileName = url.split('/').pop() ?? 'update.exe';
  const destPath = join(tmpDir, fileName);

  // Clean up any previous download
  if (existsSync(destPath)) unlinkSync(destPath);

  const response = await fetchUpdateResponse(url, (targetUrl) => {
    const request = net.request({ url: targetUrl, redirect: 'manual' });
    request.setHeader('User-Agent', `Arc-Power/${app.getVersion()}`);
    return request;
  });
  if (!response) throw new Error('Download failed: no response');

  const totalBytes = Number(response.headers.get('content-length') ?? 0);
  let downloadedBytes = 0;

  const nodeStream = Readable.fromWeb(response.body);
  const writeStream = createWriteStream(destPath);

  nodeStream.on('data', (chunk) => {
    downloadedBytes += chunk.length;
    if (totalBytes > 0 && onProgress) {
      onProgress(Math.round((downloadedBytes / totalBytes) * 100));
    }
  });

  await pipeline(nodeStream, writeStream);
  return destPath;
}

/**
 * Install a downloaded update. NSIS installer runs silently; portable exe
 * prompts the user to replace.
 */
export async function installUpdate(filePath) {
  // Launch the installer/exe and quit the app
  shell.openExternal(`file://${filePath}`);
  // Give the installer a moment to start, then quit
  setTimeout(() => app.quit(), 500);
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
