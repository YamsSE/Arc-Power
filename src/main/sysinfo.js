// Arc Power - M4-D system-info module (electron-free).
//
// One PowerShell CIM query per session, cached at boot (the dashboard CPU
// card + the VRAM enrichment both read this). Shape:
//   {
//     cpu: { name, cores, threads, maxClockMhz, manufacturer }, // Win32_Processor
//     ram: { totalBytes, speedMhz|null },                  // Win32_ComputerSystem
//                                                          // + Win32_PhysicalMemory
//     videoControllers: [{ name, vramBytes|null, pnpDeviceId|null }],  // Win32_VideoController
//   }
// Fallback: when PowerShell fails/absents (non-Windows CI, sandbox, spawn
// error) the query degrades to os.cpus() + os.totalmem() - CPU name/threads/
// clock stay populated, RAM speed + video controllers degrade honestly to
// null/empty. os.cpus() cannot distinguish physical from logical cores, so
// `cores` degrades to null (never an estimate).
//
// VRAM: AdapterRAM is a 32-bit field - a >4 GB card saturates it to
// 0xFFFFFFFF / the ~2 GiB plateau (0x7FFFFFF0 - live-verified on the A770),
// so suspicious values degrade to null. The RELIABLE source is the display
// class registry subkey's `HardwareInformation.qwMemorySize` (UInt64 bytes,
// matched to the controller by PNPDeviceID prefix) - it wins over AdapterRAM
// whenever present, so the real A770 reports its TRUE 16 GiB and the device
// name gains the honest "16 GB" suffix (M4-D user addition, live-verified).
// The honest value flows into formatDeviceName via the backend's vramBytesOf
// provider (igcl-backend.js).
//
// Mock mode: createMockSysinfo() is the default IPC adapter (tests and
// --ui-verify never spawn PowerShell); the product path injects the real
// query result in main.js.

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const execFile = promisify(nodeExecFile);

export const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

// The module-level session cache: "cached at boot (one query per session)".
let cached = null;

/**
 * The PowerShell CIM query: Win32_Processor (Name/NumberOfCores/
 * NumberOfLogicalProcessors/MaxClockSpeed + M4-H L1CacheSize/L2CacheSize/
 * L3CacheSize - KB, the Caches row source), Win32_ComputerSystem
 * (TotalPhysicalMemory), Win32_PhysicalMemory (Manufacturer/
 * ConfiguredClockSpeed/SMBIOSMemoryType - the RAM brand for the bundled
 * memory row; the Manufacturer is the raw SPD JEDEC hex code, decoded by
 * jedecBrand in the parse; SMBIOSMemoryType is the Type-17 code the
 * dashboard's DDR5-style label derives from), Win32_VideoController
 * (Name/AdapterRAM/PNPDeviceID), the display
 * class registry subkeys' HardwareInformation.qwMemorySize (UInt64 bytes,
 * keyed by MatchingDeviceId), and per video controller - the pnputil
 * resource ranges (the ReBAR check: a functioning Resizable BAR shows a
 * multi-GiB memory BAR) PLUS the Win32_AllocatedResource cross-check
 * (Win32_DeviceMemoryAddress ranges joined to the controller by its
 * Win32_VideoController DeviceID - the second ReBAR source; M4-D2 §3).
 * M4-D2: the PCIe-link property queries are REMOVED (the row was removed -
 * the unpopulated 1/1 pattern made it a permanent '-' on this machine).
 * Serialized to JSON by PowerShell itself (the parse side stays dumb). A
 * missing class on a stripped-down system serializes as null/[] - the
 * parser degrades those honestly.
 * @returns {string}
 */
export function buildSysinfoScript() {
  return [
    '$ErrorActionPreference = \'SilentlyContinue\'',
    '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,Manufacturer',
    '$cs = Get-CimInstance Win32_ComputerSystem | Select-Object -First 1 TotalPhysicalMemory',
    // M4-H: the memory row also reads SMBIOSMemoryType (the Type-17 code -
    // 24 = DDR3, 34 = DDR5 on the mock; the parse maps it, anything unknown
    // is omitted).
    '$mem = Get-CimInstance Win32_PhysicalMemory | Select-Object -First 1 Manufacturer,ConfiguredClockSpeed,SMBIOSMemoryType',
    // M4J (B): the Mainboard row source - Win32_BaseBoard Manufacturer +
    // Product (the M4-I Win32_CacheMemory query is REMOVED with the Cache
    // row; the baseboard replaces it).
    '$bb = Get-CimInstance Win32_BaseBoard | Select-Object -First 1 Manufacturer,Product',
    // M4-I: the video controllers also carry DriverVersion (the no-Intel
    // device card's Driver version row - works on ANY GPU).
    '$vga = @(Get-CimInstance Win32_VideoController | Select-Object DeviceID,Name,AdapterRAM,PNPDeviceID,DriverVersion)',
    '$regMem = @(Get-ChildItem \'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\' | ForEach-Object { $p = Get-ItemProperty $_.PSPath; if ($p.\'HardwareInformation.qwMemorySize\' -and $p.MatchingDeviceId) { [pscustomobject]@{ PNPDeviceID = $p.MatchingDeviceId; MemoryBytes = $p.\'HardwareInformation.qwMemorySize\' } } })',
    // M4-D2: per-controller ReBAR sources. (a) pnputil memory resources -
    // the ONE-LINE layout ("Memory Resources: 0x... - 0x...",
    // live-verified on the A770). The indented two-line layout (the label
    // on its own line, the range indented on the NEXT line) is NOT matched
    // by this per-line -match - machines with that layout are covered by
    // the (b) allocated-resource cross-check (the plan's second source).
    // (b) the allocated-resource
    // cross-check: Win32_AllocatedResource links each Win32_VideoController
    // (by its DeviceID "VideoControllerN") to Win32_DeviceMemoryAddress
    // ranges (by StartingAddress) - 64-bit ranges handled with
    // [Convert]::ToInt64. rebarActive = any range >= 1 GiB from EITHER
    // source (the A770's only range is 16-20 MB below 4 GB -> ReBAR off,
    // live-verified; no >= 1 GiB window exists anywhere on this machine).
    '$vga = @($vga | ForEach-Object { $id = $_.PNPDeviceID; $res = & pnputil /enum-devices /instanceid $id /resources /format txt 2>$null; $barMax = 0; if ($res) { $res | ForEach-Object { if ($_ -match \'^Memory Resources:\\s*0x([0-9A-Fa-f]+)\\s*-\\s*0x([0-9A-Fa-f]+)\') { $sz = [Convert]::ToInt64($matches[2],16) - [Convert]::ToInt64($matches[1],16) + 1; if ($sz -gt $barMax) { $barMax = $sz } } } }; [pscustomobject]@{ DeviceID = $_.DeviceID; Name = $_.Name; AdapterRAM = $_.AdapterRAM; PNPDeviceID = $id; DriverVersion = $_.DriverVersion; MaxBarBytes = $barMax } })',
    '$dma = @(Get-CimInstance Win32_DeviceMemoryAddress | Select-Object StartingAddress,EndingAddress)',
    '$alloc = @(Get-CimInstance Win32_AllocatedResource)',
    '$barRes = @(foreach ($v in $vga) { $max = 0; foreach ($r in $alloc) { if ("$($r.Dependent)" -match "Win32_VideoController \\(DeviceID = ""$($v.DeviceID)""\\)" -and "$($r.Antecedent)" -match \'StartingAddress = (\\d+)\') { $start = [Convert]::ToInt64($Matches[1]); $e = @($dma | Where-Object { [Convert]::ToInt64($_.StartingAddress) -eq $start })[0]; if ($e) { $sz = [Convert]::ToInt64($e.EndingAddress) - $start + 1; if ($sz -gt $max) { $max = $sz } } } }; [pscustomobject]@{ PNPDeviceID = $v.PNPDeviceID; MaxBarBytes = $max } })',
    '[pscustomobject]@{ cpu = $cpu; computerSystem = $cs; physicalMemory = $mem; baseboard = $bb; videoControllers = $vga; registryMemory = $regMem; allocatedBar = $barRes } | ConvertTo-Json -Depth 4 -Compress',
  ].join('; ');
}

/**
 * M7b (fix 1): the REAL-GPU vendor predicate - keeps a controller only when
 * it is an AMD / Intel / NVIDIA part. Win32_VideoController can list
 * non-GPU devices ("Microsoft Basic Display Adapter", DisplayLink docks,
 * virtual/remote adapters); a non-GPU at index 0 would win the dashboard /
 * health fallbacks (videoControllers[0]) and show as the GPU. The predicate:
 *   - pnpDeviceId matches /VEN_(8086|1002|10DE)/i (Intel / AMD / NVIDIA PCI
 *     vendor ids), OR
 *   - the name matches /intel|nvidia|radeon|geforce|arc|ati/i
 *     (case-insensitive - "Intel(R) Arc(TM) A770 Graphics" etc.),
 * AND the name is NEVER basic|microsoft (the belt-and-braces exclusion - a
 * "Microsoft Remote Display Adapter" must not pass on its VEN_8086 pnp id).
 * NO CIM Manufacturer change: the predicate keys on pnpDeviceId + name, and
 * a generically-named controller with a null pnpDeviceId is never a real
 * GPU. Applied at the SOURCE (the parse + the mock fixture - the fixture
 * path bypasses the parse) so the payload only ever carries real GPUs.
 * @param {object | null | undefined} c
 * @returns {boolean}
 */
export function isRealGpuController(c) {
  if (!c || typeof c !== 'object') return false;
  const name = typeof c.name === 'string' ? c.name : '';
  // NEVER basic|microsoft by name - the belt-and-braces exclusion (a
  // vendor-matching pnpDeviceId on a Microsoft fallback adapter must not
  // slip a non-GPU through).
  if (/basic|microsoft/i.test(name)) return false;
  const pnp = typeof c.pnpDeviceId === 'string' ? c.pnpDeviceId : '';
  return /VEN_(8086|1002|10DE)/i.test(pnp) || /intel|nvidia|radeon|geforce|arc|ati/i.test(name);
}

/**
 * M4-D: AdapterRAM -> vramBytes (the FALLBACK source). AdapterRAM is a
 * 32-bit field whose saturation sentinels carry no byte count: 0xFFFFFFFF
 * (>4 GB cards saturate to it), 0x7FFFFFFF and 0x80000000 (common
 * "unknown" values), the ~2 GiB plateau (0x7FFFFFF0 family - live-verified
 * on the A770, which is really 16 GiB), and 0 / negative / non-finite.
 * Those degrade to null so the UI never prints a wrong VRAM figure. Any
 * other positive value is a trustworthy byte count for a genuinely small
 * adapter (the real CIM field is a UInt32, so values above 0xFFFFFFFF can
 * only come from fixtures - still honest).
 * @param {unknown} value
 * @returns {number | null}
 */
export function vramBytesFromAdapterRam(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const v = Math.floor(value);
  if (v === 0xFFFFFFFF || v === 0x7FFFFFFF || v === 0x80000000 || v >= 0x7FF00000) return null;
  return v;
}

/**
 * The reliable VRAM source: the display-class registry subkeys'
 * HardwareInformation.qwMemorySize (UInt64 bytes) keyed by MatchingDeviceId
 * ("PCI\VEN_8086&DEV_56A0&SUBSYS_...") - matched to a controller by
 * PNPDeviceID PREFIX (the controller's full ID carries the instance
 * suffix). Prefer the registry value over AdapterRAM whenever it exists.
 * @param {Array<{ pnpDeviceId: string|null }>} controllers the parsed
 *   video controllers (each gains vramBytes)
 * @param {Array<{ PNPDeviceID?: unknown, MemoryBytes?: unknown }>} registryMemory
 *   the raw parsed registry rows
 */
export function applyRegistryMemory(controllers, registryMemory) {
  const rows = Array.isArray(registryMemory) ? registryMemory : [];
  return controllers.map((c) => {
    if (!c.pnpDeviceId) return c;
    const row = rows.find((r) => {
      const devId = typeof r?.PNPDeviceID === 'string' ? r.PNPDeviceID : '';
      const mem = r?.MemoryBytes;
      return devId.length > 0
        && typeof mem === 'number' && Number.isFinite(mem) && mem > 0
        && (devId === c.pnpDeviceId || c.pnpDeviceId.startsWith(devId));
    });
    // The registry UInt64 is the RELIABLE source - it wins over the
    // 32-bit AdapterRAM whenever it exists.
    return row ? { ...c, vramBytes: Math.floor(row.MemoryBytes) } : c;
  });
}

// ---------------------------------------------------------------------------
// M4-D2 §4: the JEDEC SPD manufacturer-ID -> brand map.
//
// Win32_PhysicalMemory.Manufacturer is the RAW SPD JEDEC code rendered as
// hex (live on this machine: "0420" with PartNumber F3-2400C11-8GXM -
// definitively G.Skill). The codes come from the JEDEC JEP106 table.
//
// M15: the map is rebuilt from the memtest86plus system/jedec_id.h mirror
// of the JEP106-BA (January 2022) manufacturer list - every ENABLED
// ENTRY(0xNNNN, "Name") line (the memory-relevant subset; comment-out
// noise ignored), PLUS six entries beyond memtest's enabled set (Dell
// '0CFD', Espressif '0C92', LDLC '0C97', Star Memory '0CE3', Dahua '0BF7',
// Xllbyte '0FB3') - all verified REAL in the current JEP106BO list (openocd
// mirror, May 2026), added for exhaustive coverage per the plan's spirit.
// ENTRY value = [bank][code]: bank = continuation count,
// code = the RAW 7-bit JEP106 code (parity is applied at decode time by
// the tools, NOT stored). The table keys keep the app's existing
// parity-carrying convention (e.g. Samsung 0x4E -> 'CE00': bit 7 set when
// the popcount of the raw code byte is EVEN - odd parity; verified
// consistent with all 10 original keys). Per entry:
//   code8 = popcount(code) % 2 === 0 ? code | 0x80 : code
// keyed BOTH as [count][code8] and [code8][count].
//
// Juhor IS a registered JEDEC manufacturer - JEP106 bank 8, code 0x75
// (popcount 5 odd, so the parity bit stays 0), which Windows renders as
// "0875". Three independent mirrors agree: openocd src/helper/jep106.inc
// [8][0x75-1] = "JUHOR", memtest86plus system/jedec_id.h ENTRY(0x0875,
// "JUHOR"), tianocore edk2 JedecJep106Lib.c { 0x75, "JUHOR" }. The 0x0A7D
// entry ("ShenZhen Juhor Precision Tech Co Ltd") is a DIFFERENT company -
// mapped under its full legal name, never 'Juhor'. SOURCE-VERSION DRIFT
// NOTE: the declared memtest86plus jedec_id.h (JEP106-BA, Jan 2022) shows
// plain "Juhor" for the 0x0A7D entry, while the current JEP106BO list
// (openocd, May 2026) carries the full legal name 'ShenZhen Juhor Precision
// Tech Co Ltd'; the mapping uses the CURRENT legal name and must NOT be
// "corrected" back to the older list's short form.
//
// The live-anchored '0420' (count 4, code 0x20) is what the F3-2400C11
// module family actually programs; the map decodes BOTH the live code and
// the official JEP106 code ('04CD', bank 4 code 0x4D + the odd-parity bit)
// to G.Skill. Unknown codes pass through honestly (never a wrong brand).
// ---------------------------------------------------------------------------

export const JEDEC_BRAND = Object.freeze({
  // Live-verified: F3-2400C11-8GXM (the module programs 0x20 under the
  // count-first packing - the firmware renders [count][code]); the twin
  // '2004' is the code-first rendering of the same live code.
  '0420': 'G.Skill',
  '2004': 'G.Skill',
  // JEP106 bank 0 (continuation count 00):
  '0001': 'AMD', '0100': 'AMD',
  '0004': 'Fujitsu', '0400': 'Fujitsu',
  '0085': 'GTE', '8500': 'GTE',
  '0089': 'Intel', '8900': 'Intel',
  '000E': 'Freescale', '0E00': 'Freescale',
  '0010': 'NEC', '1000': 'NEC',
  '0097': 'Texas Instruments', '9700': 'Texas Instruments',
  '0098': 'Kioxia (Toshiba)', '9800': 'Kioxia (Toshiba)',
  '0020': 'STMicro.', '2000': 'STMicro.',
  '00A4': 'IBM', 'A400': 'IBM',
  '0029': 'Microchip', '2900': 'Microchip',
  '002C': 'Micron', '2C00': 'Micron',
  '00AD': 'SK Hynix', 'AD00': 'SK Hynix',
  '0040': 'MOSEL', '4000': 'MOSEL',
  '00C1': 'Infineon', 'C100': 'Infineon',
  '00C2': 'Macronix', 'C200': 'Macronix',
  '00C8': 'Apple', 'C800': 'Apple',
  '00CE': 'Samsung', 'CE00': 'Samsung',
  '00DA': 'Winbond', 'DA00': 'Winbond',
  '00E0': 'LG', 'E000': 'LG',
  '0062': 'Sanyo', '6200': 'Sanyo',
  // JEP106 bank 1 (continuation count 01):
  '0194': 'Smart Modular', '9401': 'Smart Modular',
  '0198': 'Kingston', '9801': 'Kingston',
  '0132': 'Mushkin', '3201': 'Mushkin',
  '01BA': 'PNY', 'BA01': 'PNY',
  '0140': 'Viking', '4001': 'Viking',
  '01C2': 'Flextronics', 'C201': 'Flextronics',
  '0145': 'Micron CMS', '4501': 'Micron CMS',
  '014F': 'Transcend', '4F01': 'Transcend',
  '01DA': 'Dane-Elec', 'DA01': 'Dane-Elec',
  '0161': 'Wintec', '6101': 'Wintec',
  '0179': 'Acbel', '7901': 'Acbel',
  '017A': 'Apacer', '7A01': 'Apacer',
  '017C': 'FOXCONN', '7C01': 'FOXCONN',
  // JEP106 bank 2 (continuation count 02):
  '029E': 'Corsair', '9E02': 'Corsair',
  '022A': 'Kentron', '2A02': 'Kentron',
  '022F': 'Siemens AG', '2F02': 'Siemens AG',
  '02B5': 'SpecTek', 'B502': 'SpecTek',
  '02FE': 'Elpida', 'FE02': 'Elpida',
  // JEP106 bank 3 (continuation count 03):
  '030B': 'Nanya', '0B03': 'Nanya',
  '038F': 'ATI', '8F03': 'ATI',
  '0313': 'GEIL', '1303': 'GEIL',
  '0394': 'Mushkin', '9403': 'Mushkin',
  '0316': 'Netlist', '1603': 'Netlist',
  '0325': 'Kingmax', '2503': 'Kingmax',
  '0334': 'Tekmos', '3403': 'Tekmos',
  '03D6': 'Jade Star', 'D603': 'Jade Star',
  '0358': 'takeMS', '5803': 'takeMS',
  '03DA': 'Swissbit', 'DA03': 'Swissbit',
  '036B': 'NVIDIA', '6B03': 'NVIDIA',
  '0379': 'Utron', '7903': 'Utron',
  // JEP106 bank 4 (continuation count 04):
  '0416': 'Positivo', '1604': 'Positivo',
  '0426': 'MediaTek', '2604': 'MediaTek',
  '04B0': 'OCZ', 'B004': 'OCZ',
  '0443': 'Ramaxel', '4304': 'Ramaxel',
  '044A': 'Excel', '4A04': 'Excel',
  // 'ADATA' keeps the app's established display rendering (the JEP106
  // registration name is "A-DATA").
  '04CB': 'ADATA', 'CB04': 'ADATA',
  // G.Skill's official JEP106 assignment: bank 4, code 0x4D + the
  // odd-parity bit = 0xCD (verified against the i2c-tools decode-dimms
  // JEDEC-derived table - "G Skill Intl"; the live F3-2400C11 modules
  // program 0x20 instead, hence both code pairs map to G.Skill).
  '04CD': 'G.Skill', 'CD04': 'G.Skill',
  '04CE': 'Quanta', 'CE04': 'Quanta',
  '04D5': 'Microsoft', 'D504': 'Microsoft',
  '04D6': 'Open-Silicon', 'D604': 'Open-Silicon',
  '0467': 'Gigaram', '6704': 'Gigaram',
  '04EF': 'Team Group', 'EF04': 'Team Group',
  '04F1': 'Toshiba', 'F104': 'Toshiba',
  '0476': 'Thomson SC', '7604': 'Thomson SC',
  // JEP106 bank 5 (continuation count 05):
  '0502': 'Patriot', '0205': 'Patriot',
  '0586': 'CompuRAM', '8605': 'CompuRAM',
  '0510': 'Gigaram', '1005': 'Gigaram',
  '0597': 'COS Memory', '9705': 'COS Memory',
  '059B': 'Crucial', '9B05': 'Crucial',
  '05AB': 'Acbel', 'AB05': 'Acbel',
  '053E': 'PQI', '3E05': 'PQI',
  '0546': 'MSI', '4605': 'MSI',
  '0551': 'Qimonda', '5105': 'Qimonda',
  '05D6': 'Chaintech', 'D605': 'Chaintech',
  '0557': 'AENEON', '5705': 'AENEON',
  '05DC': 'Hexon', 'DC05': 'Hexon',
  '0562': 'Goldenmars', '6205': 'Goldenmars',
  '05E3': 'Kreton', 'E305': 'Kreton',
  '0567': 'Spansion', '6705': 'Spansion',
  '05F7': 'Avant', 'F705': 'Avant',
  '05F8': 'Asrock', 'F805': 'Asrock',
  // JEP106 bank 6 (continuation count 06):
  '0616': 'Avexir', '1606': 'Avexir',
  '069D': 'Rambus', '9D06': 'Rambus',
  '0634': 'Super Talent', '3406': 'Super Talent',
  '06C1': 'ASint', 'C106': 'ASint',
  '06C2': 'Ramtron', 'C206': 'Ramtron',
  '06C8': 'GigaDevice', 'C806': 'GigaDevice',
  '06CB': 'Northrop Grumman', 'CB06': 'Northrop Grumman',
  '0651': 'Kinglife', '5106': 'Kinglife',
  '06D3': 'Silicon Power', 'D306': 'Silicon Power',
  '065D': 'SandForce', '5D06': 'SandForce',
  '065E': 'Lexar Media', '5E06': 'Lexar Media',
  '0661': 'Smartek', '6106': 'Smartek',
  '06E9': 'SanMax', 'E906': 'SanMax',
  '066B': 'TwinMOS', '6B06': 'TwinMOS',
  '06F1': 'InnoDisk', 'F106': 'InnoDisk',
  // JEP106 bank 7 (continuation count 07):
  '0783': 'Strontium', '8307': 'Strontium',
  '0710': 'King Tiger', '1007': 'King Tiger',
  '0725': 'Ramos', '2507': 'Ramos',
  '07AE': 'Topower', 'AE07': 'Topower',
  '0732': 'Ritek', '3207': 'Ritek',
  '075D': 'Wilk Elektronik', '5D07': 'Wilk Elektronik',
  '07E3': 'OCMEMORY', 'E307': 'OCMEMORY',
  '0768': 'KingboMars', '6807': 'KingboMars',
  '07EA': 'Transcend', 'EA07': 'Transcend',
  '07EF': 'Zentel', 'EF07': 'Zentel',
  '07F2': 'LITE-ON', 'F207': 'LITE-ON',
  // JEP106 bank 8 (continuation count 08):
  '0892': 'Galaxy', '9208': 'Galaxy',
  '0813': 'Gloway', '1308': 'Gloway',
  '0898': 'KLEVV', '9808': 'KLEVV',
  '0826': 'Google', '2608': 'Google',
  '082A': 'Keysight', '2A08': 'Keysight',
  '08B3': 'Memorysolution', 'B308': 'Memorysolution',
  '08BC': 'Cuso', 'BC08': 'Cuso',
  '083D': 'Kuso', '3D08': 'Kuso',
  '08C8': 'Lenovo', 'C808': 'Lenovo',
  '08D0': 'Heoriady', 'D008': 'Heoriady',
  '0858': 'HGST', '5808': 'HGST',
  '08D9': 'EVGA', 'D908': 'EVGA',
  '085D': 'Foxtronn', '5D08': 'Foxtronn',
  '08F1': 'Asgard', 'F108': 'Asgard',
  // Juhor: JEP106 bank 8, code 0x75 (the memtest86plus JUHOR entry; the
  // Windows [count][code] rendering is "0875" - see the section comment
  // for the three-mirror verification).
  '0875': 'Juhor', '7508': 'Juhor',
  '0879': 'Realtek', '7908': 'Realtek',
  // JEP106 bank 9 (continuation count 09):
  '0902': 'VMware', '0209': 'VMware',
  '0983': 'HPE', '8309': 'HPE',
  '099B': 'YMTC', '9B09': 'YMTC',
  '099E': 'Allwinner', '9E09': 'Allwinner',
  '09A2': 'Maxsun', 'A209': 'Maxsun',
  '09A4': 'RamCENTER', 'A409': 'RamCENTER',
  '09C2': 'Kllisre', 'C209': 'Kllisre',
  '09EC': 'Colorful', 'EC09': 'Colorful',
  '09F2': 'GIGABYTE', 'F209': 'GIGABYTE',
  '09F7': 'Netac', 'F709': 'Netac',
  '09F8': 'PCCOOLER', 'F809': 'PCCOOLER',
  // JEP106 bank 10 (continuation count 0A):
  '0A02': 'KingSpec', '020A': 'KingSpec',
  '0A91': 'CXMT', '910A': 'CXMT',
  '0AAD': 'PUSKILL', 'AD0A': 'PUSKILL',
  '0A31': 'Biwin', '310A': 'Biwin',
  '0AC2': 'Thermaltake', 'C20A': 'Thermaltake',
  '0A45': 'Chun Well', '450A': 'Chun Well',
  '0AD5': 'Facebook', 'D50A': 'Facebook',
  '0A5D': 'SKIHOTAR', '5D0A': 'SKIHOTAR',
  '0AE9': 'Fraunhofer IIS', 'E90A': 'Fraunhofer IIS',
  '0A6B': 'Acer', '6B0A': 'Acer',
  '0A76': 'Lexar', '760A': 'Lexar',
  // The OTHER Juhor: bank 10 code 0x7D is "ShenZhen Juhor Precision Tech
  // Co Ltd" - a different company from the bank-8 RAM brand; mapped under
  // its full legal name, never 'Juhor'.
  '0AFD': 'ShenZhen Juhor Precision Tech Co Ltd', 'FD0A': 'ShenZhen Juhor Precision Tech Co Ltd',
  // JEP106 bank 11 (continuation count 0B):
  '0B92': 'Kingbank', '920B': 'Kingbank',
  '0B19': 'Allegro', '190B': 'Allegro',
  '0B2C': 'Hikstorage', '2C0B': 'Hikstorage',
  '0B58': 'SOYO', '580B': 'SOYO',
  '0BDC': 'ASUS', 'DC0B': 'ASUS',
  '0BF7': 'Dahua', 'F70B': 'Dahua',
  // JEP106 bank 12 (continuation count 0C):
  '0C10': 'Reliance Memory', '100C': 'Reliance Memory',
  '0C92': 'Espressif', '920C': 'Espressif',
  '0C97': 'LDLC', '970C': 'LDLC',
  '0C26': 'Timetec', '260C': 'Timetec',
  '0C34': 'Amazon', '340C': 'Amazon',
  '0C57': 'ROG', '570C': 'ROG',
  '0C5D': 'OLOy', '5D0C': 'OLOy',
  '0C61': 'Rochester', '610C': 'Rochester',
  '0CE3': 'Star Memory', 'E30C': 'Star Memory',
  '0C64': 'Agile Memory', '640C': 'Agile Memory',
  '0C7A': 'Zhaoxin', '7A0C': 'Zhaoxin',
  '0C7C': 'Hikstorage', '7C0C': 'Hikstorage',
  '0CFD': 'Dell', 'FD0C': 'Dell',
  // JEP106 bank 13 (continuation count 0D):
  '0D61': 'Lyczar', '610D': 'Lyczar',
  // JEP106 bank 14 (continuation count 0E):
  '0E51': 'Xiaoli AI', '510E': 'Xiaoli AI',
  '0E58': 'Trium Elek.', '580E': 'Trium Elek.',
  // JEP106 bank 15 (continuation count 0F):
  '0FB3': 'Xllbyte', 'B30F': 'Xllbyte',
  '0F37': 'SSTC', '370F': 'SSTC',
});

/**
 * The JEP106 parity-carrying code byte: bit 7 is set when the popcount of
 * the raw 7-bit code is even (odd parity), cleared otherwise. This is the
 * exact convention the JEDEC_BRAND keys are built with.
 * @param {number} raw the raw code byte (bit 7 ignored)
 * @returns {number} the parity-carrying byte
 */
function jedecCode8(raw) {
  const code = raw & 0x7f;
  let bits = code;
  let popcount = 0;
  while (bits > 0) {
    popcount += bits & 1;
    bits >>= 1;
  }
  return popcount % 2 === 0 ? code | 0x80 : code;
}

/**
 * Decode a CIM manufacturer value: a JEDEC code maps to the brand;
 * anything else (a real brand name, an empty value, a longer string)
 * passes through unchanged - never a wrong claim.
 *
 * M15: accepts an optional case-insensitive '0x' prefix and 4-8 hex
 * digits (uppercase lookup). A 4-hex code [X][Y] is tried in order 'XY',
 * 'YX', 'X(Y')', '(Y')X' - where Y' is the parity-normalized code byte
 * (jedecCode8) - so the DDR3 parity-carrying rendering and the
 * DDR4/DDR5 raw rendering both resolve (e.g. '004E' resolves via '00CE'
 * to Samsung). 5-8 hex digits are exact-match only; everything unknown
 * passes through unchanged.
 * @param {unknown} manufacturer
 * @returns {string | null}
 */
export function jedecBrand(manufacturer) {
  if (typeof manufacturer !== 'string' || manufacturer.length === 0) return null;
  const trimmed = manufacturer.trim();
  const stripped = trimmed.replace(/^0x/i, '');
  if (/^[0-9A-Fa-f]{4}$/.test(stripped)) {
    const upper = stripped.toUpperCase();
    const x = upper.slice(0, 2);
    const y = upper.slice(2, 4);
    // The two direct packings first (both carry the stored code byte).
    const direct = JEDEC_BRAND[x + y] ?? JEDEC_BRAND[y + x];
    if (direct !== undefined) return direct;
    // Then the parity-normalized code byte (covers the raw DDR4/DDR5
    // rendering where the tools stored no parity bit).
    const yPrime = jedecCode8(parseInt(y, 16)).toString(16).toUpperCase().padStart(2, '0');
    const normalized = JEDEC_BRAND[x + yPrime] ?? JEDEC_BRAND[yPrime + x];
    if (normalized !== undefined) return normalized;
    return trimmed;
  }
  if (/^[0-9A-Fa-f]{5,8}$/.test(stripped)) {
    return JEDEC_BRAND[stripped.toUpperCase()] ?? trimmed;
  }
  return trimmed;
}

/**
 * M4-D2 ("read the driver's BAR state"): the DRIVER's Resizable BAR
 * verdict (ctlPciGetProperties.resizable_bar_enabled - the same state IGS +
 * GPU-Z show) is the PRIMARY ReBAR source. Live-verified on this machine:
 * the driver reports enabled=1 while the OS resource map has no large BAR
 * window (Z97 platform) - the tools and the driver agree, the OS window
 * never engaged. The verdict is applied to the FIRST video controller (the
 * primary GPU); a definitive driver verdict (true/false) WINS over the OS
 * resource check; a null driver verdict (unbound symbol / ctl error /
 * no device) keeps the OS verdict unchanged. Pure.
 * @param {object} sysinfo the cached sysinfo shape
 * @param {boolean|null} driverEnabled the driver's resizable_bar_enabled
 * @returns {object} a NEW sysinfo object with the driver verdict merged
 */
export function applyDriverReBar(sysinfo, driverEnabled) {
  if (driverEnabled === null || driverEnabled === undefined || typeof sysinfo !== 'object' || sysinfo === null) {
    return sysinfo;
  }
  if (!Array.isArray(sysinfo.videoControllers) || sysinfo.videoControllers.length === 0) {
    return sysinfo;
  }
  const controllers = sysinfo.videoControllers.map((c, i) => (
    i === 0 ? { ...c, rebarActive: driverEnabled } : c
  ));
  return { ...sysinfo, videoControllers: controllers };
}

/**
 * M4-D: the ReBAR verdict - a functioning Resizable BAR shows a
 * multi-GiB memory BAR in the device resources (the A770's non-ReBAR
 * aperture is 16 MB; with ReBAR the BAR spans the full VRAM). True when
 * the largest memory range is >= 1 GiB; false otherwise (unknown when no
 * resource info). Live-verified on this machine: 16 MB -> false (ReBAR off).
 * @param {unknown} maxBarBytes
 * @returns {boolean|null}
 */
export function rebarFromMaxBarBytes(maxBarBytes) {
  if (typeof maxBarBytes !== 'number' || !Number.isFinite(maxBarBytes) || maxBarBytes <= 0) return null;
  return maxBarBytes >= 1024 * 1024 * 1024;
}

/**
 * M4-D2 (§3): merge the allocated-resource cross-check rows into the
 * controller list - per controller, the ReBAR verdict comes from the LARGER
 * of the two sources (pnputil per-device resources and the
 * Win32_AllocatedResource -> Win32_DeviceMemoryAddress join), matched by
 * PNPDeviceID. rebarActive = any range >= 1 GiB from either source.
 * @param {Array<{ pnpDeviceId: string|null, rebarActive: boolean|null }>} controllers
 * @param {Array<{ PNPDeviceID?: unknown, MaxBarBytes?: unknown }>} allocatedBar
 *   the raw parsed cross-check rows
 */
export function applyAllocatedBar(controllers, allocatedBar) {
  const rows = Array.isArray(allocatedBar) ? allocatedBar : [];
  return controllers.map((c) => {
    if (!c.pnpDeviceId) return c;
    const row = rows.find((r) => typeof r?.PNPDeviceID === 'string' && r.PNPDeviceID === c.pnpDeviceId);
    const crossBytes = typeof row?.MaxBarBytes === 'number' && Number.isFinite(row.MaxBarBytes) ? row.MaxBarBytes : 0;
    const pnputilBytes = typeof c._pnputilBarBytes === 'number' && Number.isFinite(c._pnputilBarBytes) ? c._pnputilBarBytes : 0;
    return {
      ...c,
      rebarActive: rebarFromMaxBarBytes(Math.max(pnputilBytes, crossBytes)),
    };
  });
}

/**
 * Parse the PowerShell JSON output into the canonical sysinfo shape. Any
 * missing/unparseable piece degrades per-field (null / empty array) - the
 * query result is a best-effort read, never a boot blocker.
 * @param {string} stdout
 * @returns {{ cpu: object, ram: object, videoControllers: object[] }}
 */
export function parseCimOutput(stdout) {
  let raw = null;
  try {
    raw = JSON.parse(String(stdout ?? ''));
  } catch {
    // Garbage output (UAC prompt interleaved, PS 2 vs 5 quirks) degrades to
    // the fallback shape's empties - the caller decides whether to fall back.
    return { cpu: {}, ram: {}, baseboard: {}, videoControllers: [] };
  }
  const cpuRaw = raw && typeof raw === 'object' ? raw.cpu : null;
  const csRaw = raw && typeof raw === 'object' ? raw.computerSystem : null;
  const memRaw = raw && typeof raw === 'object' ? raw.physicalMemory : null;
  const bbRaw = raw && typeof raw === 'object' ? raw.baseboard : null;
  const vgaRaw = Array.isArray(raw?.videoControllers) ? raw.videoControllers : [];

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const cpu = {
    name: typeof cpuRaw?.Name === 'string' && cpuRaw.Name ? cpuRaw.Name : null,
    cores: num(cpuRaw?.NumberOfCores),
    threads: num(cpuRaw?.NumberOfLogicalProcessors),
    maxClockMhz: num(cpuRaw?.MaxClockSpeed),
    // M15 (F2): Win32_Processor.Manufacturer - the AMD-vs-not gate for the
    // MSR reader's module selection (isAmdVendor in msr-reader.js: a
    // case-insensitive match on /amd/ or the SMBIOS phrase 'advanced micro
    // devices' - 'AuthenticAMD', 'Advanced Micro Devices, Inc.', ...). The
    // gate is the MANUFACTURER string, NOT Win32_Processor.Family - the
    // DMTF SMBIOS family table defines no AMD Zen values for real machines
    // (see the S1 deviation record in the M15 report), so a family-range
    // gate provably never activated on Zen and misloaded the AMD module on
    // Intel machines reporting its boundary values. The AMDFamily17.bin
    // module ITSELF re-checks the CPUID vendor + Zen family range (a
    // non-Zen AMD part self-refuses with STATUS_NOT_SUPPORTED -> the
    // honest null degrade).
    manufacturer: typeof cpuRaw?.Manufacturer === 'string' && cpuRaw.Manufacturer ? cpuRaw.Manufacturer : null,
  };
  // M4J (B): the baseboard row (Mainboard) - the RAW Manufacturer/Product
  // strings; the renderer's mainboardRow applies the manufacturer short-map
  // (display concern, renderer-side).
  const baseboard = {
    manufacturer: typeof bbRaw?.Manufacturer === 'string' && bbRaw.Manufacturer ? bbRaw.Manufacturer : null,
    product: typeof bbRaw?.Product === 'string' && bbRaw.Product ? bbRaw.Product : null,
  };
  const ram = {
    totalBytes: num(csRaw?.TotalPhysicalMemory) ?? 0,
    speedMhz: num(memRaw?.ConfiguredClockSpeed),
    // M4-D2: the raw SPD JEDEC code ("0420") decodes to the brand
    // (G.Skill); a real name / unknown code passes through honestly.
    manufacturer: jedecBrand(memRaw?.Manufacturer),
    // M4-H: the SMBIOS Type-17 memory-type code (24=DDR3, 34=DDR5, ... -
    // the pure ramMemoryType mapping in the renderer derives the label).
    memoryType: num(memRaw?.SMBIOSMemoryType),
  };
  const controllers = applyAllocatedBar(
    applyRegistryMemory(
      vgaRaw
        .map((c) => ({
          name: typeof c?.Name === 'string' ? c.Name : null,
          vramBytes: vramBytesFromAdapterRam(c?.AdapterRAM),
          pnpDeviceId: typeof c?.PNPDeviceID === 'string' && c.PNPDeviceID ? c.PNPDeviceID : null,
          // M4-I: the controller's display-driver version (works on ANY
          // GPU - the no-Intel device card's Driver version row source).
          driverVersion: typeof c?.DriverVersion === 'string' && c.DriverVersion ? c.DriverVersion : null,
          rebarActive: null,
          // M4-D2: the pnputil source rides along (merged with the
          // allocated-resource cross-check by applyAllocatedBar).
          _pnputilBarBytes: typeof c?.MaxBarBytes === 'number' && Number.isFinite(c.MaxBarBytes) ? c.MaxBarBytes : 0,
        }))
        .filter((c) => c.name !== null),
      raw?.registryMemory,
    ),
    raw?.allocatedBar,
  );
  // M4-D2: the internal pnputil byte count never surfaces (only the merged
  // verdict does). M7b (fix 1): the payload then filters through
  // isRealGpuController - only AMD/Intel/NVIDIA parts survive (a
  // "Microsoft Basic Display Adapter" / DisplayLink controller must never
  // win the dashboard/health videoControllers[0] fallbacks).
  const videoControllers = controllers
    .map(({ _pnputilBarBytes, ...rest }) => rest)
    .filter(isRealGpuController);
  return { cpu, ram, baseboard, videoControllers };
}

/**
 * M4-D: the honest os.cpus()/os.totalmem() fallback shape - RAM
 * speed + video controllers degrade to null/empty (there is no OS-level
 * source for them), and `cores` degrades to null because os.cpus() cannot
 * distinguish physical from logical cores (never an estimate).
 * @returns {{ cpu: object, ram: object, videoControllers: [] }}
 */
export function fallbackSysinfo() {
  const cpus = os.cpus();
  const cpu = cpus.length > 0
    ? { name: cpus[0].model, cores: null, threads: cpus.length, maxClockMhz: cpus[0].speed, manufacturer: null }
    : { name: null, cores: null, threads: null, maxClockMhz: null, manufacturer: null };
  return {
    cpu,
    ram: { totalBytes: os.totalmem(), speedMhz: null, manufacturer: null, memoryType: null },
    baseboard: { manufacturer: null, product: null },
    videoControllers: [],
  };
}

/**
 * Run the CIM query ONCE per session (module-level cache) with the
 * injectable execFile (tests pass a fake; the product path never runs
 * PowerShell in mock mode - main.js injects createMockSysinfo() there).
 * Any query failure (PowerShell absent, spawn error, timeout, garbage
 * output) falls back to os.cpus()/os.totalmem() - never throws. The query
 * timeout is SHORT (10 s - M4-D review F3): a hung PowerShell must not
 * block the first window for a minute (the real CIM query completes in
 * 1-5 s); the timeout rejection lands in the same os.cpus() fallback.
 * @param {{ execFile?: typeof execFile, powershellExe?: string, timeoutMs?: number }} [deps]
 * @returns {Promise<{ cpu: object, ram: object, videoControllers: object[] }>}
 */
export async function collectSysinfo(deps = {}) {
  if (cached) return cached;
  const exec = deps.execFile ?? execFile;
  try {
    const { stdout } = await exec(
      deps.powershellExe ?? POWERSHELL_EXE,
      ['-NoProfile', '-NonInteractive', '-Command', buildSysinfoScript()],
      { windowsHide: true, timeout: deps.timeoutMs ?? 10000 },
    );
    const parsed = parseCimOutput(stdout);
    if (typeof parsed.cpu?.name !== 'string' || parsed.cpu.name.length === 0) {
      // No usable CPU row (garbage output, PS 2 quirks, empty classes) -
      // the honest os.cpus() fallback, same as a PowerShell failure.
      cached = fallbackSysinfo();
    } else {
      cached = {
        cpu: {
          name: parsed.cpu.name,
          cores: parsed.cpu.cores,
          threads: parsed.cpu.threads,
          maxClockMhz: parsed.cpu.maxClockMhz,
          // M15 (F2): the manufacturer MUST ride the cached shape too (the
          // collectSysinfo rebuild dropped it in the first plan draft - the
          // reader's cached?.cpu?.manufacturer would then be undefined
          // forever, exactly like the pre-correction family).
          manufacturer: parsed.cpu.manufacturer,
        },
        ram: {
          totalBytes: parsed.ram?.totalBytes || os.totalmem(),
          speedMhz: parsed.ram?.speedMhz ?? null,
          manufacturer: parsed.ram?.manufacturer ?? null,
          memoryType: parsed.ram?.memoryType ?? null,
        },
        // M4J (B): the baseboard (Mainboard row) rides the payload.
        baseboard: {
          manufacturer: parsed.baseboard?.manufacturer ?? null,
          product: parsed.baseboard?.product ?? null,
        },
        videoControllers: parsed.videoControllers ?? [],
      };
    }
  } catch {
    // PowerShell failed/absent -> the honest os.cpus() fallback.
    cached = fallbackSysinfo();
  }
  return cached;
}

/**
 * Reset the session cache (tests only - each test pins its own fallback).
 */
export function resetSysinfoCache() {
  cached = null;
}

// ---------------------------------------------------------------------------
// VRAM enrichment (M4-D user addition) - matching the IGCL device name
// against the CIM video-controller list, with the honest fallback chain.
// ---------------------------------------------------------------------------

// Family tokens that identify a GPU product line in a controller name.
const GPU_FAMILY_TOKENS = new Set(['arc', 'iris', 'uhd', 'hd', 'hdg']);
// Tokens that carry no model information (trademark/legal/generic words).
const GENERIC_TOKENS = new Set(['r', 'tm', 'intel', 'graphics', 'gpu', 'controller', 'display', 'family', 'adapters']);

function tokensOf(name) {
  return new Set(String(name ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

/**
 * Match the IGCL device name against the CIM video-controller list:
 *   1. exact normalized name equality (the common case - both sources name
 *      the card the same way);
 *   2. GPU-family token match - a shared family token (e.g. 'arc') PLUS at
 *      least one shared non-family model token (e.g. 'a770'). A bare family
 *      token never satisfies this path: 'Intel(R) Arc(TM) Graphics' (no
 *      model token) and 'Intel Arc A750' against an A770 row must NOT claim
 *      the A770's VRAM - a wrong cross-card match prints a WRONG number,
 *      worse than an honest null (M4-D review F1);
 *   3. the primary non-basic adapter - ONLY for model-less device names
 *      (every token is generic/family, e.g. 'Intel(R) Arc(TM) Graphics'):
 *      the first controller that is not a basic-display/Microsoft fallback
 *      adapter (the dGPU is normally listed first). A name that names a
 *      SPECIFIC model (e.g. 'A750') which matched no controller degrades
 *      honestly to null - the fallback must never attach a different
 *      card's VRAM to a different-model name;
 *   4. null when nothing matches (honest: no VRAM claim without a match).
 * @param {string} deviceName the IGCL device name (pre-suffix)
 * @param {Array<{ name: string|null, vramBytes: number|null, pnpDeviceId: string|null }>} videoControllers
 * @returns {object | null}
 */
export function matchVideoController(deviceName, videoControllers) {
  const list = Array.isArray(videoControllers) ? videoControllers : [];
  if (!deviceName || list.length === 0) return null;
  const normalize = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const target = normalize(deviceName);
  if (!target) return null;

  // 1. exact normalized equality.
  const exact = list.find((c) => c.name && normalize(c.name) === target);
  if (exact) return exact;

  // 2. GPU-family token match: the family token is NOT enough - a shared
  // NON-family token (a real model token like 'a770') is required too.
  const targetTokens = tokensOf(deviceName);
  for (const c of list) {
    if (!c.name) continue;
    const cTokens = tokensOf(c.name);
    const shared = [...targetTokens].filter((t) => cTokens.has(t) && !GENERIC_TOKENS.has(t));
    const familyShared = [...targetTokens].filter((t) => cTokens.has(t) && GPU_FAMILY_TOKENS.has(t));
    const modelShared = shared.filter((t) => !GPU_FAMILY_TOKENS.has(t));
    if (familyShared.length > 0 && modelShared.length >= 1) return c;
  }

  // 3. primary non-basic adapter - only for a MODEL-LESS device name (all
  // tokens generic/family). A name carrying a model token that matched no
  // controller is an unmatched specific card -> honest null, never a wrong
  // cross-model VRAM claim.
  const hasModelToken = [...targetTokens]
    .some((t) => !GENERIC_TOKENS.has(t) && !GPU_FAMILY_TOKENS.has(t));
  if (!hasModelToken) {
    const primary = list.find((c) => c.name && !/basic|microsoft/i.test(c.name));
    if (primary) return primary;
  }
  return null;
}

/**
 * The vramBytesOf provider wired into IgclBackend (main.js real path):
 * match the device against the cached sysinfo and return its vramBytes
 * (null when unmatched/degraded - formatDeviceName then keeps the plain
 * name).
 * @param {{ name?: string }} device
 * @param {{ videoControllers?: Array<{ name: string|null, vramBytes: number|null, pnpDeviceId: string|null }> } | null} sysinfo
 * @returns {number | null}
 */
export function vramBytesOfDevice(device, sysinfo) {
  const controllers = Array.isArray(sysinfo?.videoControllers) ? sysinfo.videoControllers : [];
  if (controllers.length === 0) return null;
  const match = matchVideoController(device?.name ?? '', controllers);
  return match && Number.isInteger(match.vramBytes) && match.vramBytes > 0 ? match.vramBytes : null;
}

/**
 * In-memory fixture - the default sysinfo adapter for tests and --ui-verify
 * (never spawns PowerShell). Fixed values so the dashboard CPU card and the
 * sysinfo IPC payload are deterministic in mock mode.
 * 1.0.1 no-Intel round: RID_MOCK_NO_INTEL=1 switches the fixture's video
 * controller to an AMD part ('AMD Radeon RX 7600'-style with vramBytes + a
 * pnpDeviceId + rebarActive false) - the no-Intel machine shape the
 * renderer's osGpu / header / GPU card read.
 * M7b (fix 1): the no-Intel fixture ALSO carries a 'Microsoft Basic Display
 * Adapter' FIRST + a DisplayLink dock (the non-GPU devices that leak into
 * Win32_VideoController) - the fixture path bypasses the parse, so the
 * controller list is filtered through isRealGpuController HERE; only the
 * AMD part survives, proving a non-GPU first controller never wins the GPU
 * card / health row / header name.
 * M4-H: the fixture gains SMBIOSMemoryType 34 (DDR5 - the Memory-row type
 * label). M4J (B): the fixture drops the l1-l4 cache fields (the Cache row
 * is REMOVED) and gains the baseboard (the Mainboard row - the ASUSTeK-style
 * value the pins assert).
 * @param {{ cpu?: object, ram?: object, videoControllers?: object[] }} [overrides]
 */
export function createMockSysinfo(overrides = {}) {
  const noIntel = process.env.RID_MOCK_NO_INTEL === '1';
  // M7b (fix 1): the fixture's controller list is filtered through
  // isRealGpuController like the parse filters the CIM payload - the mock
  // path bypasses the parse, so the filter must run HERE (the default +
  // no-Intel fixtures stay green; a Basic Display Adapter first controller
  // is genuinely filtered).
  const fixtureControllers = noIntel ? [
    {
      // M7b: the FIRST controller is a non-GPU (the "Microsoft Basic
      // Display Adapter" every Windows box can list) - the predicate must
      // filter it so it never wins the dashboard/health fallbacks.
      name: 'Microsoft Basic Display Adapter',
      vramBytes: null,
      pnpDeviceId: 'ROOT\\BASIC_DISPLAY\\0000',
      driverVersion: '10.0.19041.1',
      rebarActive: null,
    },
    {
      // M7b: a DisplayLink dock - a non-GPU device (VID_17E9) that must
      // never win either.
      name: 'DisplayLink USB Graphics',
      vramBytes: null,
      pnpDeviceId: 'USB\\VID_17E9&PID_0236\\MOCK0001',
      driverVersion: '10.0.19041.1',
      rebarActive: null,
    },
    {
      name: 'AMD Radeon RX 7600',
      vramBytes: 8589934592, // 8 GiB
      pnpDeviceId: 'PCI\\VEN_1002&DEV_7480&SUBSYS_24011462&REV_C7',
      // M4-I: the controller's display-driver version (the no-Intel
      // device card's Driver version row - works on ANY GPU).
      driverVersion: '31.0.12027.9001',
      rebarActive: false,
    },
    ...(overrides.videoControllers ?? []),
  ] : [
    {
      name: 'Intel(R) Arc(TM) A770 Graphics',
      vramBytes: 17179869184, // 16 GiB (the 16 GB config)
      pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_00000000&REV_08',
      driverVersion: '32.0.101.8861',
      rebarActive: true,
    },
    ...(overrides.videoControllers ?? []),
  ];
  return {
    get: async () => ({
      cpu: {
        name: 'Intel(R) Core(TM) i7-14700K',
        cores: 20,
        threads: 28,
        maxClockMhz: 5600,
        // M15 (F2): the mock fixture keeps `manufacturer: null` (the Intel
        // box - the reader's isAmdVendor(null) = false -> the IntelMSR.bin
        // path).
        manufacturer: null,
        ...(overrides.cpu ?? {}),
      },
      ram: {
        totalBytes: 34359738368, // 32 GiB
        speedMhz: 6000,
        manufacturer: 'G.Skill',
        memoryType: 34, // DDR5 (SMBIOS Type-17)
        ...(overrides.ram ?? {}),
      },
      // M4J (B): the baseboard fixture - the ASUSTeK-style value the
      // Mainboard row pins ("ASUSTeK MAXIMUS VII RANGER" via the short-map).
      baseboard: {
        manufacturer: 'ASUSTeK COMPUTER INC.',
        product: 'MAXIMUS VII RANGER',
        ...(overrides.baseboard ?? {}),
      },
      videoControllers: fixtureControllers.filter(isRealGpuController),
    }),
  };
}
