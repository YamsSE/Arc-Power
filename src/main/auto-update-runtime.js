// Electron-free update download and handoff runtime. The product adapter in
// auto-update.js supplies Electron's app/net objects; tests inject fakes here.

import { createWriteStream, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
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

  async function downloadUpdate(url, onProgress, buildKind = 'portable') {
    const expectedName = expectedAssetName(buildKind);
    if (!expectedName) throw new Error('Update target is unavailable for this build');
    const safeUrl = validateReleaseAssetUrl(url, expectedName);
    if (!safeUrl) throw new Error('Invalid GitHub update asset URL');

    const tmpDir = updateTempDir();
    if (!exists(tmpDir)) mkdir(tmpDir, { recursive: true });
    const destPath = join(tmpDir, expectedName);
    if (exists(destPath)) unlink(destPath);

    const response = await fetchResponse(safeUrl, (targetUrl) => {
      if (!netApi || typeof netApi.request !== 'function') throw new TypeError('update network adapter is required');
      const request = netApi.request({ url: targetUrl, redirect: 'manual' });
      request.setHeader('User-Agent', `Arc-Power/${appApi.getVersion()}`);
      return request;
    });
    if (!response) throw new Error('Download failed: no response');

    const totalBytes = Number(response.headers.get('content-length') ?? 0);
    let downloadedBytes = 0;
    const nodeStream = readableFromWeb(response.body);
    const writeStream = createStream(destPath);
    nodeStream.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      if (totalBytes > 0 && onProgress) onProgress(Math.round((downloadedBytes / totalBytes) * 100));
    });
    await pipelineFn(nodeStream, writeStream);
    return destPath;
  }

  async function installUpdate(filePath, {
    buildKind = 'portable',
    portableWrapperPath = null,
    portableTargetPath = null,
    onHandoffStarted = null,
  } = {}) {
    if (buildKind !== 'installed' && buildKind !== 'portable') {
      throw new Error('Update target is unavailable for this build');
    }
    const tmpDir = updateTempDir();
    const validatedFilePath = validateDownloadedUpdatePath(filePath, { buildKind, tempDir: tmpDir });
    if (!validatedFilePath || !exists(validatedFilePath)) throw new Error('Invalid downloaded update path');

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
    write(handoffPath, createPortableHandoffScript(), { encoding: 'utf8', mode: 0o600 });
    const powershell = processApi.env.SystemRoot
      ? join(processApi.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    const handoff = spawnProcess(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', handoffPath,
      '-ParentPid', String(processApi.pid),
      '-DownloadedPath', validatedFilePath,
      '-TargetPath', targetPath,
      '-DiagnosticPath', diagnosticPath,
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
      targetPath,
    };
  }

  return { downloadUpdate, installUpdate };
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
