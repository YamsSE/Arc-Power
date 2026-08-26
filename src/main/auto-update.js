// Arc Power - M25: auto-update backend (GitHub Releases).
//
// Checks the GitHub Releases API for a newer version, downloads the matching
// installer/portable exe, and performs a safe handoff for installation.

import { app, shell } from 'electron';
import { net } from 'electron';
import { createWriteStream, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fetchUpdateResponse } from './auto-update-download.js';
import {
  compareVersions,
  createPortableHandoffScript,
  expectedAssetName,
  parseReleaseTag,
  selectReleaseAsset,
  validateDownloadedUpdatePath,
  validatePortableTargetPath,
  validateReleaseAssetUrl,
} from './auto-update-pure.js';

const OWNER = 'YamsSE';
const REPO = 'Arc-Power';
const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

/**
 * Check GitHub Releases for a newer version.
 * Returns { available, version, assetUrl, assetName } or { available: false }.
 */
export async function checkForUpdates({ buildKind = 'portable' } = {}) {
  const currentVersion = app.getVersion();

  const response = await fetchJson(API_URL);
  if (!response) return { available: false };

  const latestVersion = parseReleaseTag(response.tag_name);
  if (!latestVersion) return { available: false };
  if (compareVersions(latestVersion, currentVersion) <= 0) return { available: false };

  const asset = selectReleaseAsset(response, buildKind);
  if (!asset) return { available: false };

  return {
    available: true,
    version: latestVersion,
    assetUrl: asset.assetUrl,
    assetName: asset.assetName,
  };
}

/**
 * Download an update asset to a temp file.
 * Returns the path to the downloaded file.
 */
export async function downloadUpdate(url, onProgress, buildKind = 'portable') {
  const expectedName = expectedAssetName(buildKind);
  const safeUrl = validateReleaseAssetUrl(url, expectedName);
  if (!safeUrl) throw new Error('Invalid GitHub update asset URL');

  const tmpDir = join(tmpdir(), 'arc-power-updates');
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  const fileName = expectedName;
  const destPath = join(tmpDir, fileName);

  // Clean up any previous download
  if (existsSync(destPath)) unlinkSync(destPath);

  const response = await fetchUpdateResponse(safeUrl, (targetUrl) => {
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

/** Install an update using the build's matching safe handoff. */
export async function installUpdate(filePath, { buildKind = 'portable' } = {}) {
  const tmpDir = join(tmpdir(), 'arc-power-updates');
  const validatedFilePath = validateDownloadedUpdatePath(filePath, { buildKind, tempDir: tmpDir });
  if (!validatedFilePath || !existsSync(validatedFilePath)) {
    throw new Error('Invalid downloaded update path');
  }

  if (buildKind === 'installed') {
    const openError = await shell.openPath(validatedFilePath);
    if (openError) throw new Error(`Could not launch installer: ${openError}`);
    app.quit();
    return { restarting: true, kind: 'installed' };
  }

  const portableFile = process.env.PORTABLE_EXECUTABLE_FILE;
  const targetPath = validatePortableTargetPath(portableFile, validatedFilePath);
  if (!targetPath || !existsSync(targetPath)) {
    throw new Error('Portable executable path is unavailable');
  }

  const handoffPath = join(tmpDir, `arc-power-portable-handoff-${process.pid}.ps1`);
  writeFileSync(handoffPath, createPortableHandoffScript(), { encoding: 'utf8', mode: 0o600 });
  const powershell = process.env.SystemRoot
    ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const handoff = spawn(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', handoffPath,
    '-ParentPid', String(process.pid),
    '-DownloadedPath', validatedFilePath,
    '-TargetPath', targetPath,
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  if (!handoff.pid) throw new Error('Could not start portable update handoff');
  handoff.unref();
  app.quit();
  return { restarting: true, kind: 'portable' };
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
