// Electron-free update download and handoff runtime. The product adapter in
// auto-update.js supplies Electron's app/net objects; tests inject fakes here.

import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  createPortableHandoffScript,
  expectedAssetName,
  validateDownloadedUpdatePath,
  validatePortableTargetPath,
  validateReleaseAssetUrl,
  installedUpdateArguments,
} from './auto-update-pure.js';
import { resolvePortableWrapperPath } from './build-kind.js';

export function createUpdateOperations({
  appApi,
  netApi,
  processApi = process,
  spawnProcess = spawn,
  fetchResponse = async () => null,
  exists = existsSync,
  mkdir = mkdirSync,
  unlink = unlinkSync,
  rename = renameSync,
  write = writeFileSync,
  createStream = createWriteStream,
  readableFromWeb = Readable.fromWeb,
  pipelineFn = pipeline,
  tempDirPath = null,
} = {}) {
  if (!appApi || typeof appApi.getVersion !== 'function' || typeof appApi.quit !== 'function') {
    throw new TypeError('update app adapter is required');
  }

  const updateTempDir = () => tempDirPath ?? join(tmpdir(), 'arc-power-updates');

  async function downloadUpdate(url, onProgress, buildKind = 'portable', releaseMetadata = {}) {
    const expectedName = expectedAssetName(buildKind);
    if (!expectedName) throw new Error('Update target is unavailable for this build');
    const safeUrl = validateReleaseAssetUrl(url, expectedName);
    if (!safeUrl) throw new Error('Invalid GitHub update asset URL');

    const tmpDir = updateTempDir();
    if (!exists(tmpDir)) mkdir(tmpDir, { recursive: true });
    const downloadDir = join(tmpDir, randomUUID());
    mkdir(downloadDir, { recursive: true });
    const destPath = join(downloadDir, expectedName);
    const partialPath = `${destPath}.part`;

    const response = await fetchResponse(safeUrl, (targetUrl) => {
      if (!netApi || typeof netApi.request !== 'function') throw new TypeError('update network adapter is required');
      const request = netApi.request({ url: targetUrl, redirect: 'manual' });
      request.setHeader('User-Agent', `Arc-Power/${appApi.getVersion()}`);
      return request;
    });
    if (!response) throw new Error('Download failed: no response');

    const contentLength = Number(response.headers.get('content-length'));
    const releaseAssetSize = Number.isSafeInteger(releaseMetadata.assetSize) && releaseMetadata.assetSize > 0
      ? releaseMetadata.assetSize
      : null;
    const totalBytes = Number.isSafeInteger(contentLength) && contentLength > 0
      ? contentLength
      : releaseAssetSize;
    const expectedDigest = releaseMetadata.expectedSha256 ?? null;
    if (expectedDigest !== null && !/^[a-f0-9]{64}$/i.test(expectedDigest)) {
      throw new Error('Update release contains an invalid SHA-256 digest');
    }
    let downloadedBytes = 0;
    try {
      if (!response.body) throw new Error('Download failed: response body is unavailable');
      const nodeStream = readableFromWeb(response.body);
      const hash = createHash('sha256');
      const meter = new Transform({
        transform(chunk, encoding, callback) {
          downloadedBytes += chunk.length;
          hash.update(chunk);
          const percent = Number.isSafeInteger(totalBytes) && totalBytes > 0
            ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100))
            : null;
          onProgress?.({ downloadedBytes, totalBytes: Number.isSafeInteger(totalBytes) && totalBytes > 0 ? totalBytes : null, percent });
          callback(null, chunk);
        },
      });
      await pipelineFn(nodeStream, meter, createStream(partialPath, { flags: 'wx' }));
      if (downloadedBytes === 0) throw new Error('Download failed: update asset was empty');
      if (Number.isSafeInteger(totalBytes) && totalBytes > 0 && downloadedBytes !== totalBytes) {
        throw new Error(`Download failed: expected ${totalBytes} bytes but received ${downloadedBytes}`);
      }
      if (releaseAssetSize !== null && downloadedBytes !== releaseAssetSize) {
        throw new Error(`Download failed: GitHub release lists ${releaseAssetSize} bytes but received ${downloadedBytes}`);
      }
      const sha256 = hash.digest('hex');
      if (expectedDigest && sha256 !== expectedDigest.toLowerCase()) {
        throw new Error('Downloaded update SHA-256 does not match the GitHub release digest');
      }
      rename(partialPath, destPath);
      onProgress?.({ downloadedBytes, totalBytes: downloadedBytes, percent: 100 });
      return { path: destPath, sha256 };
    } catch (error) {
      try { if (exists(partialPath)) unlink(partialPath); } catch { /* best-effort removal of an incomplete asset */ }
      try { if (exists(destPath)) unlink(destPath); } catch { /* best-effort removal of a failed asset */ }
      throw error;
    }
  }

  async function installUpdate(receipt, {
    buildKind = 'portable',
    portableWrapperPath = null,
    portableTargetPath = null,
    onHandoffStarted = null,
    expectedSha256 = null,
  } = {}) {
    if (buildKind !== 'installed' && buildKind !== 'portable') {
      throw new Error('Update target is unavailable for this build');
    }
    const tmpDir = updateTempDir();
    const filePath = typeof receipt === 'string' ? receipt : receipt?.path;
    const receiptDigest = typeof receipt === 'object' && receipt ? receipt.sha256 : expectedSha256;
    const validatedFilePath = validateDownloadedUpdatePath(filePath, { buildKind, tempDir: tmpDir });
    if (!validatedFilePath || !exists(validatedFilePath)) throw new Error('Invalid downloaded update path');
    if (typeof receiptDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(receiptDigest)) throw new Error('Downloaded update has no valid main-process SHA-256 receipt');
    const actualDigest = await hashFile(validatedFilePath);
    if (actualDigest !== receiptDigest.toLowerCase()) throw new Error('Downloaded update changed after verification; download it again');

    if (buildKind === 'installed') {
      const installDir = dirname(processApi.execPath);
      const args = installedUpdateArguments({ parentPid: processApi.pid, installDir });
      const diagnosticPath = join(tmpDir, `arc-power-update-${processApi.pid}.log`);
      try {
        const installer = spawnProcess(validatedFilePath, args, {
          cwd: tmpDir,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...processApi.env },
        });
        await waitForSpawn(installer);
        onHandoffStarted?.();
        installer.unref();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        try { write(diagnosticPath, `${new Date().toISOString()} installer spawn failed: ${message}\n`, { encoding: 'utf8', mode: 0o600 }); } catch { /* best effort */ }
        throw new Error(`Could not launch installer: ${message}. Diagnostics: ${diagnosticPath}`);
      }
      appApi.quit();
      return {
        restarting: true,
        restartConfirmed: false,
        kind: 'installed',
        handoff: 'Arc-Power_Installer.exe',
        args,
        diagnosticPath,
      };
    }

    const portableFile = resolvePortableWrapperPath({
      portableExecutableFile: portableWrapperPath ?? portableTargetPath ?? processApi.env.PORTABLE_EXECUTABLE_FILE ?? null,
      portableExecutableDir: processApi.env.PORTABLE_EXECUTABLE_DIR ?? null,
    });
    const targetPath = validatePortableTargetPath(portableFile, validatedFilePath);
    if (!targetPath || !exists(targetPath)) throw new Error('Portable executable path is unavailable');

    const handoffPath = join(tmpDir, `arc-power-portable-handoff-${processApi.pid}.ps1`);
    const diagnosticPath = join(tmpDir, `arc-power-update-${processApi.pid}.log`);
    const resultPath = join(tmpDir, `arc-power-update-${processApi.pid}.result.json`);
    write(handoffPath, createPortableHandoffScript(), { encoding: 'utf8', mode: 0o600 });
    const powershell = processApi.env.SystemRoot
      ? join(processApi.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    const handoff = spawnProcess(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', handoffPath,
      '-ParentPid', String(processApi.pid),
      '-DownloadedPath', validatedFilePath,
      '-ExpectedSha256', receiptDigest.toLowerCase(),
      '-TargetPath', targetPath,
      '-DiagnosticPath', diagnosticPath,
      '-ResultPath', resultPath,
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    try {
      await waitForSpawn(handoff);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      try { write(diagnosticPath, `${new Date().toISOString()} portable handoff spawn failed: ${message}\n`, { encoding: 'utf8', mode: 0o600 }); } catch { /* best effort */ }
      throw new Error(`Could not start portable update handoff: ${message}. Diagnostics: ${diagnosticPath}`);
    }
    onHandoffStarted?.();
    handoff.unref();
    appApi.quit();
    return {
      restarting: true,
      restartConfirmed: false,
      kind: 'portable',
      handoff: 'PowerShell',
      diagnosticPath,
      resultPath,
      targetPath,
    };
  }

  return { downloadUpdate, installUpdate };
}

async function hashFile(filePath) {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    if (!child || typeof child.once !== 'function') {
      reject(new Error('update handoff did not return a child process'));
      return;
    }
    child.once('error', reject);
    child.once('spawn', resolve);
  });
}
