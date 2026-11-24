// Stage the native host and the remaining compatibility service without
// rewriting PE resources or using Electron Builder for the distribution.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

export function assertAdministratorExecutable(file) {
  const image = readFileSync(file);
  const invalid = () => { throw new Error(`Executable must contain a valid PE RT_MANIFEST ID 1 requireAdministrator resource: ${file}`); };
  const bounds = (offset, size) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > image.length) invalid();
    return offset;
  };
  const u16 = (offset) => image.readUInt16LE(bounds(offset, 2));
  const u32 = (offset) => image.readUInt32LE(bounds(offset, 4));
  if (u16(0) !== 0x5a4d) invalid();
  const pe = u32(0x3c);
  if (u32(pe) !== 0x4550) invalid();
  const sectionCount = u16(pe + 6);
  const optionalSize = u16(pe + 20);
  const optional = pe + 24;
  bounds(optional, optionalSize);
  const magic = u16(optional);
  const directoryOffset = magic === 0x10b ? 96 : magic === 0x20b ? 112 : invalid();
  if (optionalSize < directoryOffset + 24 || u32(optional + directoryOffset - 4) < 3) invalid();
  const resourceRva = u32(optional + directoryOffset + 16);
  const resourceSize = u32(optional + directoryOffset + 20);
  if (!resourceRva || resourceSize < 16 || !sectionCount) invalid();
  const sections = optional + optionalSize;
  bounds(sections, sectionCount * 40);
  const rvaOffset = (rva, size) => {
    for (let i = 0; i < sectionCount; i++) {
      const section = sections + i * 40;
      const start = u32(section + 12), rawSize = u32(section + 16), raw = u32(section + 20);
      const delta = rva - start;
      if (delta >= 0 && delta < rawSize && size <= rawSize - delta) return bounds(raw + delta, size);
    }
    invalid();
  };
  const resourceBase = rvaOffset(resourceRva, resourceSize);
  const resourceOffset = (offset, size) => {
    if (offset < 0 || size < 0 || offset + size > resourceSize) invalid();
    return bounds(resourceBase + offset, size);
  };
  const entries = (directory) => {
    const header = resourceOffset(directory, 16);
    const count = u16(header + 12) + u16(header + 14);
    resourceOffset(directory + 16, count * 8);
    return Array.from({ length: count }, (_, i) => {
      const entry = header + 16 + i * 8;
      return { id: u32(entry), target: u32(entry + 4) };
    });
  };
  const childDirectory = (directory, id) => {
    const matches = entries(directory).filter((entry) => entry.id === id);
    if (matches.length !== 1 || !(matches[0].target & 0x80000000)) invalid();
    return matches[0].target & 0x7fffffff;
  };
  const languages = entries(childDirectory(childDirectory(0, 24), 1));
  if (!languages.length) invalid();
  // Windows selects a language fallback at runtime. Require every language of
  // the process manifest to request elevation, rather than guessing its choice.
  const manifests = languages.map(({ id, target }) => {
    if (id & 0x80000000 || target & 0x80000000) invalid();
    const data = resourceOffset(target, 16);
    const size = u32(data + 4);
    if (!size || size > 1024 * 1024) invalid();
    const bytes = image.subarray(rvaOffset(u32(data), size), rvaOffset(u32(data), size) + size);
    const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0);
    const xml = bytes.toString(utf16 ? 'utf16le' : 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const declarations = [...xml.matchAll(/<requestedExecutionLevel\b[^>]*\blevel\s*=\s*(["'])([^"']+)\1[^>]*>/g)];
    if (declarations.length !== 1 || declarations[0][2] !== 'requireAdministrator') invalid();
    return { languageId: id, level: declarations[0][2], sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  return { type: 24, id: 1, manifests };
}

export function stageNativeDistribution({ nativeExecutable, compatibilityDirectory, outputDirectory, testMockFixturesDirectory, nativeOnly = !compatibilityDirectory, projectRoot: projectRootOverride }) {
  nativeExecutable = path.resolve(nativeExecutable);
  compatibilityDirectory = compatibilityDirectory ? path.resolve(compatibilityDirectory) : null;
  outputDirectory = path.resolve(outputDirectory);
  const runtimeRoot = projectRootOverride ? path.resolve(projectRootOverride) : projectRoot;
  if (existsSync(outputDirectory)) throw new Error(`Output must be a new directory: ${outputDirectory}`);
  if (!nativeOnly && !compatibilityDirectory) throw new Error('Compatibility packaging requires a compatibility input directory');
  const resourceSource = compatibilityDirectory ? path.join(compatibilityDirectory, 'resources') : null;
  if (compatibilityDirectory) {
  const relative = path.relative(compatibilityDirectory, outputDirectory);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Output must not be inside the compatibility payload');
  }
  }
  const nativeManifest = assertAdministratorExecutable(nativeExecutable);
  let compatibilityManifest = null;
  const rootIcons = ['app-icon.ico', 'ArcPowerTaskbar-blue-gradient.ico'];
  for (const icon of rootIcons) {
    if (resourceSource && !existsSync(path.join(resourceSource, icon))) throw new Error(`Missing required native root icon: ${icon}`);
  }
  let backendExecutable = null;
  let archive = null;
  if (!nativeOnly) {
    backendExecutable = path.join(compatibilityDirectory, 'Arc Power.exe');
    archive = path.join(resourceSource, 'app.asar');
    if (!existsSync(archive)) throw new Error(`Missing compatibility archive: ${archive}`);
    if (existsSync(path.join(compatibilityDirectory, 'ArcPower.Backend.exe'))) throw new Error('Input payload already contains the reserved backend executable');
    compatibilityManifest = assertAdministratorExecutable(backendExecutable);
    const pawnioSetup = path.join(compatibilityDirectory, 'resources', 'app.asar.unpacked', 'src', 'main', 'backend', 'PawnIO_setup.exe');
    if (!existsSync(pawnioSetup)) throw new Error(`Missing bundled PawnIO installer: ${pawnioSetup}`);
  }
  if (testMockFixturesDirectory && !existsSync(path.join(testMockFixturesDirectory, 'b580.json'))) {
    throw new Error('Mock fixture directory must include b580.json; launch tests with RID_MOCK_FEATURESET=b580');
  }
  mkdirSync(outputDirectory, { recursive: true });
  const unpacked = path.join(outputDirectory, 'win-unpacked');
  const backend = path.join(unpacked, 'compatibility-backend');
  // The portable wrapper places its own elevation helper here independently
  // of the nested service resources.
  mkdirSync(path.join(unpacked, 'resources'), { recursive: true });
  for (const icon of rootIcons) {
    cpSync(resourceSource ? path.join(resourceSource, icon) : path.join(runtimeRoot, 'src/assets/app-icon.ico'),
      path.join(unpacked, 'resources', icon));
  }
  // The native host uses the same positive-only D3D12 evidence helper as the
  // Electron service. Keep a stable top-level resource path for native-only
  // packages and for installation/update payload validation.
  const d3d12HelperName = 'ArcPower.D3D12UploadHeapQuery.exe';
  const d3d12HelperCandidates = [
    ...(resourceSource ? [path.join(resourceSource, 'app.asar.unpacked', 'src', 'main', 'native', d3d12HelperName)] : []),
    path.join(runtimeRoot, 'src', 'main', 'native', d3d12HelperName),
  ];
  const d3d12HelperSource = d3d12HelperCandidates.find((candidate) => existsSync(candidate));
  if (!d3d12HelperSource) throw new Error(`Missing bundled D3D12 ReBAR helper: ${d3d12HelperName}`);
  cpSync(d3d12HelperSource, path.join(unpacked, 'resources', d3d12HelperName));
  if (!nativeOnly) {
    cpSync(compatibilityDirectory, backend, { recursive: true, errorOnExist: true, force: false });
    renameSync(path.join(backend, 'Arc Power.exe'), path.join(backend, 'ArcPower.Backend.exe'));
  } else {
    const runtimeFiles = [
      ['src/main/telemetry/lhm-runtime', 'lhm'],
      ['recording-runtime', 'recording-runtime'],
      ['src/main/backend/igcl2023/IntelControlLib.dll', 'app.asar.unpacked/src/main/backend/igcl2023/IntelControlLib.dll'],
      ['src/main/sharpening-runtime/ArcPower.ScreenSharpen.exe', 'app.asar.unpacked/src/main/sharpening-runtime/ArcPower.ScreenSharpen.exe'],
      ['src/main/sharpening-runtime/fsr1', 'app.asar.unpacked/src/main/sharpening-runtime/fsr1'],
      ['src/main/backend/PawnIO_setup.exe', 'PawnIO_setup.exe'],
    ];
    for (const [source, destination] of runtimeFiles) {
      const target = path.join(unpacked, 'resources', destination);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(path.join(runtimeRoot, source), target, { recursive: true, errorOnExist: true, force: false });
    }
    // Fail the build rather than silently shipping another telemetry-less
    // package. Every native runtime probe below must resolve in the payload.
    const required = [
      'resources/lhm/ArcPower.LhmBridge.exe',
      'resources/recording-runtime/bin/64bit/ffmpeg.exe',
      'resources/recording-runtime/bin/64bit/ffprobe.exe',
      'resources/recording-runtime/bin/64bit/ascent-obs.exe',
      'resources/app.asar.unpacked/src/main/backend/igcl2023/IntelControlLib.dll',
      'resources/app.asar.unpacked/src/main/sharpening-runtime/ArcPower.ScreenSharpen.exe',
      'resources/app.asar.unpacked/src/main/sharpening-runtime/fsr1/ArcPower.Fsr1.hlsl',
      'resources/app.asar.unpacked/src/main/sharpening-runtime/fsr1/ffx_a.h',
      'resources/app.asar.unpacked/src/main/sharpening-runtime/fsr1/ffx_fsr1.h',
      'resources/app.asar.unpacked/src/main/sharpening-runtime/fsr1/LICENSE.txt',
      'resources/ArcPower.D3D12UploadHeapQuery.exe',
      'resources/PawnIO_setup.exe',
    ];
    for (const relative of required) {
      if (!existsSync(path.join(unpacked, relative))) throw new Error(`Missing native runtime in payload: ${relative}`);
    }
  }
  cpSync(nativeExecutable, path.join(unpacked, 'Arc Power.exe'));
  if (testMockFixturesDirectory) {
    const fixturesTarget = nativeOnly
      ? path.join(unpacked, 'resources/mock/featuresets')
      : path.join(backend, 'resources/mock/featuresets');
    cpSync(path.resolve(testMockFixturesDirectory), fixturesTarget,
      { recursive: true, errorOnExist: true, force: false });
  }
  const provenance = {
    frontend: 'Rust/Tauri/WebView2',
    compatibilityBackend: nativeOnly ? 'none (native-only package)' : 'Electron compatibility service (remaining channels)',
    nativeExecutableSha256: sha256(nativeExecutable),
    ...(nativeOnly ? {} : {
      compatibilityExecutableSha256: sha256(backendExecutable),
      compatibilityArchiveSha256: sha256(archive),
    }),
    nativeManifest,
    ...(compatibilityManifest ? { compatibilityManifest } : {}),
    packaging: 'standalone native Tauri host folder and ZIP archive; no Electron Builder wrapper',
    installer: 'native Rust setup entry point (Arc-Power_Installer.exe)',
    portable: 'native Tauri application entry point (Arc-Power_Portable.exe)',
    testMockFixturesIncluded: Boolean(testMockFixturesDirectory),
  };
  writeFileSync(path.join(outputDirectory, 'native-distribution.json'), JSON.stringify(provenance, null, 2) + '\n');
  return { unpacked, provenance };
}

export function buildNativePortable(options, { runBuilder = spawnSync } = {}) {
  if (process.platform !== 'win32') throw new Error('Windows is required to build the native distribution wrappers');
  const { unpacked, provenance } = stageNativeDistribution(options);
  const output = path.resolve(options.outputDirectory);
  const changelog = path.join(projectRoot, 'CHANGELOG.md');
  if (existsSync(changelog)) {
    cpSync(changelog, path.join(output, 'CHANGELOG.md'));
    cpSync(changelog, path.join(unpacked, 'CHANGELOG.md'));
  }
  const makensis = locateNsisCompiler();
  const withInstaller = options.withInstaller === true;
  const installer = path.join(output, 'Arc-Power_Installer.exe');
  const portable = path.join(output, 'Arc-Power_Portable.exe');
  if (withInstaller) buildNativeWrapper({ makensis, payload: unpacked, output: installer, kind: 'installer', runBuilder });
  buildNativeWrapper({ makensis, payload: unpacked, output: portable, kind: 'portable', runBuilder });
  provenance.portableManifest = assertAdministratorExecutable(portable);
  provenance.portableSha256 = sha256(portable);
  if (withInstaller) {
    provenance.installerManifest = assertAdministratorExecutable(installer);
    provenance.installerSha256 = sha256(installer);
  }
  provenance.wrapperTechnology = 'NSIS native self-extracting wrappers; no Electron runtime';
  writeFileSync(path.join(output, 'native-distribution.json'), JSON.stringify(provenance, null, 2) + '\n');
  const archive = path.join(output, 'Arc-Power_Tauri.zip');
  const archiveFiles = ['Arc-Power_Portable.exe', 'native-distribution.json'];
  if (withInstaller) archiveFiles.unshift('Arc-Power_Installer.exe');
  if (existsSync(changelog)) archiveFiles.push('CHANGELOG.md');
  const result = runBuilder('tar.exe', ['-a', '-c', '-f', archive, '-C', output, ...archiveFiles],
    { cwd: projectRoot, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Tauri wrapper archive failed with exit ${result.status}`);
  return portable;
}

function locateNsisCompiler() {
  const explicit = process.env.MAKENSIS_PATH;
  if (explicit && existsSync(explicit)) return path.resolve(explicit);
  const cache = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache');
  if (cache && existsSync(cache)) {
    for (const entry of readdirSync(cache).filter((name) => /^nsis-\d/i.test(name)).sort().reverse()) {
      const root = path.join(cache, entry);
      for (const suffix of [path.join('Bin', 'makensis.exe'), path.join(entry, 'Bin', 'makensis.exe')]) {
        const candidate = path.join(root, suffix);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return 'makensis.exe';
}

function nsisLiteral(value) {
  return `"${path.resolve(value).replaceAll('$', '$$').replaceAll('"', '$\\"')}"`;
}

function buildNativeWrapper({ makensis, payload, output, kind, runBuilder }) {
  const source = path.join(path.dirname(output), `native-${kind}.nsi`);
  // The staged payload carries the real application icon. Without an explicit
  // Icon directive NSIS brands both wrappers with its own default icon.
  const icon = path.join(payload, 'resources', 'app-icon.ico');
  if (!existsSync(icon)) throw new Error(`Missing wrapper icon: ${icon}`);
  const packageVersion = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
  const fileVersion = packageVersion.split('.').map((part) => Number.parseInt(part, 10) || 0)
    .concat([0, 0, 0, 0]).slice(0, 4).join('.');
  const setPortableMarker = kind === 'portable';
  const sourceText = [
    'Unicode true',
    'Name "Arc Power"',
    `Icon ${nsisLiteral(icon)}`,
    'SetCompressor /SOLID lzma',
    '!include "FileFunc.nsh"',
    'RequestExecutionLevel admin',
    'SilentInstall silent',
    `OutFile ${nsisLiteral(output)}`,
    `VIProductVersion "${fileVersion}"`,
    'VIAddVersionKey "ProductName" "Arc Power"',
    `VIAddVersionKey "FileVersion" "${packageVersion}"`,
    `VIAddVersionKey "ProductVersion" "${packageVersion}"`,
    `VIAddVersionKey "FileDescription" "Arc Power ${kind === 'installer' ? 'Setup' : 'Portable'}"`,
    'VIAddVersionKey "LegalCopyright" "R.ID"',
    'Var payloadRoot',
    'Var childExit',
    'Var cmdArgs',
    'Var wrapperPid',
    'Section',
    '  ${GetParameters} $cmdArgs',
    '  GetTempFileName $payloadRoot',
    '  Delete "$payloadRoot"',
    '  CreateDirectory "$payloadRoot"',
    '  SetOutPath "$payloadRoot"',
    `  File /r ${nsisLiteral(path.join(payload, '*'))}`,
    ...(setPortableMarker ? [
      '  System::Call \'kernel32::SetEnvironmentVariableW(w "PORTABLE_EXECUTABLE_FILE", w "$EXEPATH") i .r0\'',
      '  System::Call \'kernel32::SetEnvironmentVariableW(w "PORTABLE_EXECUTABLE_DIR", w "$EXEDIR") i .r0\'',
      '  System::Call \'kernel32::GetCurrentProcessId() i .r0\'',
      '  IntFmt $wrapperPid "%u" $0',
      '  System::Call \'kernel32::SetEnvironmentVariableW(w "ARC_POWER_PORTABLE_WRAPPER_PID", w "$wrapperPid") i .r1\'',
    ] : []),
    ...(kind === 'installer' ? [
      '  StrCmp $cmdArgs "" setup_launch',
      '  ExecWait \'"$payloadRoot\\Arc Power.exe" $cmdArgs\' $childExit',
      '  Goto cleanup',
      'setup_launch:',
      '  ExecWait \'"$payloadRoot\\Arc Power.exe" --install\' $childExit',
    ] : [
      '  ExecWait \'"$payloadRoot\\Arc Power.exe" $cmdArgs\' $childExit',
    ]),
    'cleanup:',
    '  SetOutPath "$TEMP"',
    '  RMDir /r "$payloadRoot"',
    '  SetErrorLevel $childExit',
    'SectionEnd',
    '',
  ].join('\n');
  writeFileSync(source, sourceText);
  const result = runBuilder(makensis, ['/V2', source], { cwd: path.dirname(source), stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${kind} NSIS packaging failed with exit ${result.status}; set MAKENSIS_PATH if NSIS is not on the build host`);
}

export function parseNativeDistributionArgs(args) {
  if (args.length >= 2 && args.slice(2).every((flag) => ['--with-installer', '--native-only'].includes(flag))) {
    const [nativeExecutable, outputDirectory, ...flags] = args;
    return { nativeExecutable, outputDirectory, nativeOnly: true, withInstaller: flags.includes('--with-installer') };
  }
  const [nativeExecutable, compatibilityDirectory, outputDirectory, ...flags] = args;
  if (!nativeExecutable || !compatibilityDirectory || !outputDirectory ||
      flags.some((flag) => !['--test-mock-fixtures', '--with-installer', '--native-only'].includes(flag)) || new Set(flags).size !== flags.length) {
    throw new Error('Usage: node scripts/build-tauri-dist.mjs <release-host.exe> <compatibility-win-unpacked> <new-output-directory> [--test-mock-fixtures] [--with-installer] [--native-only]');
  }
  return { nativeExecutable, compatibilityDirectory, outputDirectory, withInstaller: flags.includes('--with-installer'),
    nativeOnly: flags.includes('--native-only'),
    testMockFixturesDirectory: flags.includes('--test-mock-fixtures') ? path.join(projectRoot, 'mock/featuresets') : undefined };
}

function newestMtimeMs(root) {
  let newest = 0;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  visit(root);
  return newest;
}

/// Refuse to package a renderer bundle that predates the current frontend
/// sources. The 1.3.4 settings fix was once absent from the staged bundle
/// even though the version string was correct; this gate makes that loud.
export function assertFrontendFresh() {
  const bundle = path.join(projectRoot, 'tauri-dist/renderer/out/tauri-main.js');
  if (!existsSync(bundle)) throw new Error('Renderer bundle is missing; run node scripts/build-tauri-frontend.mjs');
  const source = Math.max(
    newestMtimeMs(path.join(projectRoot, 'src/renderer')),
    statSync(path.join(projectRoot, 'src/preload.cjs')).mtimeMs,
  );
  if (source > statSync(bundle).mtimeMs) {
    throw new Error('Renderer bundle is stale; run node scripts/build-tauri-frontend.mjs before packaging');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertFrontendFresh();
  const options = parseNativeDistributionArgs(process.argv.slice(2));
  buildNativePortable(options);
  console.log(`Created native setup entry: ${path.resolve(options.outputDirectory, 'Arc-Power_Installer.exe')}`);
  console.log(`Created native portable entry: ${path.resolve(options.outputDirectory, 'Arc-Power_Portable.exe')}`);
  console.log(`Created Tauri distribution archive: ${path.resolve(options.outputDirectory, 'Arc-Power_Tauri.zip')}`);
}
