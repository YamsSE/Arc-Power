// Arc Power - M17c/M17d AIB (board-partner) detection (pure, DOM-free;
// unit-tested in test/pure-aib.test.ts - the cheap-oracle seam of the
// milestone).
//
// The AIB decode source = the IGCL enumeration fields
// ctl_device_adapter_properties_t.pci_subsys_vendor_id / pci_subsys_id
// (igcl-bindings.js:217-218 - a 1:1 mapping to the PNP SUBSYS_60011849
// fields, exact per device; NO CIM/name-match dependency) - AND, on the
// no-Intel branch, the OS controller's PNPDeviceID SUBSYS decode through
// the SAME table (Run B - works for ANY GPU). The decode table carries
// DOCUMENTED entries only:
//
//   - 0x1849 -> 'ASRock'            (pci-ids.ucw.cz/read/PC/1849: ASRock
//                                    Incorporation - the documented vendor);
//   - 0x6001 -> 'Phantom Gaming'    (the subsys-id variant of THIS dev box's
//                                    A770 - SUBSYS_60011849 live probe;
//                                    user-observed, NOT in any public DB -
//                                    recorded as an observation; the model
//                                    entry fires only under the observed
//                                    ASRock pairing). M17d: the model's
//                                    trailing VRAM-amount token is STRIPPED
//                                    ('Phantom Gaming 8GB' -> 'Phantom
//                                    Gaming' - the user's exact request: the
//                                    Board-partner model must never carry
//                                    the VRAM amount);
//   - 0x8086 -> 'Intel (Limited Edition)' (the LE decode - makes the 228 W
//                                    LE power-limit entry reachable);
//   - 0x1025 -> 'Acer'              (pci-ids.ucw.cz/read/PC/1025: Acer
//                                    Incorporated - the Acer A750 board-
//                                    partner row; M17d: the BiFrost subsys-id
//                                    variant is PINNED by the 2026-08-12 live
//                                    probe - 0xB102 under 0x1025 = 'Predator
//                                    BiFrost', the Acer A750 the user probed,
//                                    pciSubsysId 45314);
//   - the NVIDIA/AMD AIB subsystem vendors (pci-ids verified - the M17d
//     context table): 0x1043 ASUS (pci-ids.ucw.cz/read/PC/1043), 0x1458
//     Gigabyte (pci-ids.ucw.cz/read/PC/1458), 0x1462 MSI
//     (pci-ids.ucw.cz/read/PC/1462), 0x3842 EVGA
//     (pci-ids.ucw.cz/read/PC/3842), 0x19DA ZOTAC
//     (pci-ids.ucw.cz/read/PC/19da), 0x1ACC Palit/POV
//     (pci-ids.ucw.cz/read/PC/1acc), 0x1DA2 Sapphire
//     (pci-ids.ucw.cz/read/PC/1da2), 0x1682 XFX (pci-ids.ucw.cz/read/PC/1682),
//     0x148C PowerColor (pci-ids.ucw.cz/read/PC/148c), 0x1849 ASRock,
//     0x8086 Intel.
//
// Unknown subsystem vendor -> null (the honest '-' - never an invented
// partner). The model (subsys id) is only claimed when its vendor pairing
// is observed/documented - a bare 0x6001 under a different vendor decodes
// to nothing.
//
// LAPTOP BRANCH (user request): when the system is a laptop, the AIB row
// shows the LAPTOP MANUFACTURER - mobile boards have no meaningful AIB
// partner, so the subsystem decode is overridden: aibVendor = the CLEANED
// manufacturer, aibModel = the system Model. The portable-form-factor rule
// is PINNED (round-3 N2 - the ambiguity is fixed, not just risk-flagged):
//   portable iff PCSystemType === 2 OR any chassis type in
//   {8, 9, 10, 14, 30, 31, 32}.
// The clean-name map matches by TOKEN (the raw CIM strings vary:
// 'Micro-Star International Co., Ltd.' / 'LENOVO' / 'ASUSTeK COMPUTER INC.' /
// 'Dell Inc.' / 'Hewlett-Packard Company' / 'HP' / 'Acer'); an unknown
// manufacturer passes through as the RAW string (never dropped).

export interface AibInfo {
  vendor: string;
  model: string | null;
}

/** The portable-form-factor chassis types (the PINNED rule - round-3 N2):
 *  8=Portable, 9=Laptop, 10=Notebook, 14=Sub Notebook, 30=Convertible,
 *  31=Detachable, 32=IoT Gateway (the SMBIOS System Enclosure types). */
export const PORTABLE_CHASSIS_TYPES = new Set([8, 9, 10, 14, 30, 31, 32]);

/** The documented subsystem-vendor decode: pciSubsysVendorId -> vendor.
 *  Sources: pci-ids.ucw.cz (the per-entry URLs in the comments) + the
 *  user-observed dev-box subsystem. */
const SUBSYS_VENDOR: Record<number, string> = {
  0x1849: 'ASRock', // pci-ids.ucw.cz/read/PC/1849
  0x8086: 'Intel (Limited Edition)', // the LE decode (the 228 W PL row key)
  0x1025: 'Acer', // pci-ids.ucw.cz/read/PC/1025 (the Acer A750 board-partner row)
  0x1043: 'ASUS', // pci-ids.ucw.cz/read/PC/1043 (NVIDIA/AMD AIB table)
  0x1458: 'Gigabyte', // pci-ids.ucw.cz/read/PC/1458
  0x1462: 'MSI', // pci-ids.ucw.cz/read/PC/1462
  0x3842: 'EVGA', // pci-ids.ucw.cz/read/PC/3842
  0x19da: 'ZOTAC', // pci-ids.ucw.cz/read/PC/19da
  0x1acc: 'Palit', // pci-ids.ucw.cz/read/PC/1acc (Palit/POV)
  0x1da2: 'Sapphire', // pci-ids.ucw.cz/read/PC/1da2
  0x1682: 'XFX', // pci-ids.ucw.cz/read/PC/1682
  0x148c: 'PowerColor', // pci-ids.ucw.cz/read/PC/148c
};

/** The documented subsystem-id (variant) decode - keyed on the OBSERVED
 *  vendor pairing (the model claim is only valid under its vendor). */
const SUBSYS_MODEL: Record<number, { vendorId: number; model: string }> = {
  // User-observed on the dev box: PCI\VEN_8086&DEV_56A0&SUBSYS_60011849 -
  // the 'Phantom Gaming 8GB' A770. NOT in public DBs (DeviceHunt: 0x6001
  // unlisted) - recorded as an observation, never a public-DB citation.
  // M17d: the model drops the trailing VRAM-amount token ('Phantom Gaming
  // 8GB' -> 'Phantom Gaming' - the user's exact request; the strip rule
  // lives in aibModelStripped so the decode table keeps the RAW observed
  // name as its source).
  0x6001: { vendorId: 0x1849, model: 'Phantom Gaming 8GB' },
  // M17d (2026-08-12 live probe, the user's Acer A750): pciSubsysVendorId
  // 0x1025 + pciSubsysId 0xB102 (45314) - the live-pinned Acer A750 pair.
  // NOT in any public DB (pci-ids has no Arc subsystem rows) - the probe is
  // the source of truth; the model 'Predator BiFrost' carries no VRAM-
  // amount token (the strip rule leaves it untouched).
  0xB102: { vendorId: 0x1025, model: 'Predator BiFrost' },
};

/**
 * M17d: strip the trailing VRAM-amount token(s) from a Board-partner model
 * ('Phantom Gaming 8GB' -> 'Phantom Gaming'). The rule: /[0-9]+\s*GB/i
 * tokens at the END of the model (the '8GB' suffix the IGS/device names
 * carry); a mid-name VRAM token or a trailing token that is not a VRAM
 * amount ('Phantom 8GB Gaming' / 'ZOTAC 4070') is never touched. Garbage ->
 * the input unchanged (never null, never an invented model).
 * @param {unknown} model the raw subsys-id model
 * @returns {string}
 */
export function aibModelStripped(model: unknown): string {
  const s = typeof model === 'string' ? model.trim() : '';
  if (s.length === 0) return s;
  return s.replace(/\s*[0-9]+\s*GB\s*$/i, '');
}

/**
 * M17c: decode the AIB from the IGCL subsystem fields. The subsystem
 * vendor table (documented entries only: ASRock 0x1849, Intel LE 0x8086,
 * Acer 0x1025 + the NVIDIA/AMD AIB vendors); the subsys-id variant
 * (0x6001 -> 'Phantom Gaming', 0xB102 -> 'Predator BiFrost') fires ONLY
 * under its observed vendor pairing (the 0xB102 entry is the 2026-08-12
 * live probe pin - the Acer A750 the user probed). M17d: the decoded
 * model runs through aibModelStripped (the trailing VRAM-amount token is
 * never part of the Board-partner model).
 * Unknown vendor / garbage input -> null (the honest '-' - never an
 * invented partner).
 * @param {unknown} pciSubsysVendorId the ctl_device_adapter_properties_t
 *   pci_subsys_vendor_id value (a number - the struct field)
 * @param {unknown} pciSubsysId the pci_subsys_id value
 * @returns {AibInfo | null}
 */
export function aibOf(pciSubsysVendorId: unknown, pciSubsysId: unknown): AibInfo | null {
  const vendorId = typeof pciSubsysVendorId === 'number' && Number.isFinite(pciSubsysVendorId)
    ? Math.floor(pciSubsysVendorId)
    : -1;
  const subId = typeof pciSubsysId === 'number' && Number.isFinite(pciSubsysId)
    ? Math.floor(pciSubsysId)
    : -1;
  const vendor = SUBSYS_VENDOR[vendorId];
  if (!vendor) return null;
  const variant = SUBSYS_MODEL[subId];
  const model = variant && variant.vendorId === vendorId ? aibModelStripped(variant.model) : null;
  return { vendor, model };
}

/**
 * M17d: decode the AIB from a PNPDeviceID's SUBSYS token - the no-Intel
 * branch's Board-partner source (works for ANY GPU: NVIDIA/AMD cards carry
 * the same SUBSYS_<subsysid><subsvendorid> fields the Intel caps do). The
 * token shape: 'SUBSYS_xxxxxxxx' - the LOW 4 hex digits = the SUBSYSTEM
 * VENDOR id (the aib.ts vendor table), the HIGH 4 hex digits = the
 * SUBSYS id (the model variant, only claimed under its observed vendor
 * pairing). e.g. 'SUBSYS_36811458' -> vendor 0x1458 (Gigabyte) + variant
 * 0x3681 - the aibOf decode. No SUBSYS token / garbage -> null (the honest
 * '-' - never an invented partner).
 * @param {unknown} pnpDeviceId the controller's PNPDeviceID
 *   ('PCI\VEN_10DE&DEV_13C2&SUBSYS_36811458&REV_A1')
 * @returns {AibInfo | null}
 */
export function aibOfPnpDeviceId(pnpDeviceId: unknown): AibInfo | null {
  if (typeof pnpDeviceId !== 'string') return null;
  const m = pnpDeviceId.match(/SUBSYS_([0-9A-Fa-f]{8})/);
  if (!m) return null;
  const hex = m[1];
  const subsysVendorId = parseInt(hex.slice(4), 16);  // the low 4 hex digits
  const subsysId = parseInt(hex.slice(0, 4), 16);     // the high 4 hex digits
  if (!Number.isFinite(subsysVendorId) || !Number.isFinite(subsysId)) return null;
  return aibOf(subsysVendorId, subsysId);
}

/** The laptop clean-name map: match by TOKEN (case-insensitive), the first
 *  matching key's value wins; unknown -> the raw string unchanged. */
const CLEAN_NAMES: Array<{ token: string; name: string }> = [
  { token: 'micro-star', name: 'MSI' }, // 'Micro-Star International Co., Ltd.'
  { token: 'lenovo', name: 'Lenovo' }, // 'LENOVO'
  { token: 'asustek', name: 'ASUS' }, // 'ASUSTeK COMPUTER INC.'
  { token: 'dell', name: 'Dell' }, // 'Dell Inc.'
  { token: 'hewlett-packard', name: 'HP' }, // 'Hewlett-Packard Company'
  { token: 'hp', name: 'HP' },
  { token: 'acer', name: 'Acer' },
];

/**
 * M17c: the pinned portable-form-factor rule (round-3 N2) - portable iff
 * PCSystemType === 2 OR any chassis type is in {8, 9, 10, 14, 30, 31, 32}.
 * Garbage / missing values -> NOT portable (the laptop branch never claims
 * a desktop).
 * @param {unknown} pcSystemType the Win32_ComputerSystem PCSystemType code
 * @param {unknown} chassisTypes the Win32_SystemEnclosure ChassisTypes array
 * @returns {boolean}
 */
export function isPortableFormFactor(pcSystemType: unknown, chassisTypes: unknown): boolean {
  if (pcSystemType === 2) return true;
  if (!Array.isArray(chassisTypes)) return false;
  return chassisTypes.some((t) => typeof t === 'number' && PORTABLE_CHASSIS_TYPES.has(Math.floor(t)));
}

/**
 * M17c: clean a raw system-manufacturer string through the token map
 * ('Micro-Star International Co., Ltd.' -> 'MSI', 'LENOVO' -> 'Lenovo', ...).
 * Match by token (case-insensitive); unknown -> the RAW string unchanged
 * (never dropped, never invented). Garbage -> null.
 * @param {unknown} manufacturer the raw Win32_ComputerSystem Manufacturer
 * @returns {string | null}
 */
export function cleanManufacturerName(manufacturer: unknown): string | null {
  const s = typeof manufacturer === 'string' ? manufacturer.trim() : '';
  if (s.length === 0) return null;
  const lower = s.toLowerCase();
  for (const { token, name } of CLEAN_NAMES) {
    if (lower.includes(token)) return name;
  }
  return s;
}

/**
 * M17c: the laptop branch - the AIB identity of a PORTABLE system. The
 * subsystem decode is overridden: aibVendor = the cleaned manufacturer,
 * aibModel = the system Model. Returns null when the system is NOT portable
 * (the caller then falls back to the subsystem decode) or when no usable
 * manufacturer/model exists (the honest '-').
 * @param {{ manufacturer?: unknown, model?: unknown, pcSystemType?: unknown,
 *   chassisTypes?: unknown }} system the laptop sysinfo (the parsed CIM
 *   laptop fields - Win32_ComputerSystem Manufacturer/Model/PCSystemType +
 *   Win32_SystemEnclosure ChassisTypes)
 * @returns {AibInfo | null}
 */
export function laptopAibOf(system: {
  manufacturer?: unknown;
  model?: unknown;
  pcSystemType?: unknown;
  chassisTypes?: unknown;
} | null | undefined): AibInfo | null {
  if (!system || typeof system !== 'object') return null;
  if (!isPortableFormFactor(system.pcSystemType, system.chassisTypes)) return null;
  const vendor = cleanManufacturerName(system.manufacturer);
  const model = typeof system.model === 'string' && system.model.trim().length > 0
    ? system.model.trim()
    : null;
  if (!vendor) return null;
  return { vendor, model };
}
