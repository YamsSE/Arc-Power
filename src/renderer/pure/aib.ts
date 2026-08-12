// Arc Power - M17c AIB (board-partner) detection (pure, DOM-free; unit-tested
// in test/pure-aib.test.ts - the cheap-oracle seam of the milestone).
//
// The AIB decode source = the IGCL enumeration fields
// ctl_device_adapter_properties_t.pci_subsys_vendor_id / pci_subsys_id
// (igcl-bindings.js:217-218 - a 1:1 mapping to the PNP SUBSYS_60011849
// fields, exact per device; NO CIM/name-match dependency). The decode table
// carries DOCUMENTED entries only:
//
//   - 0x1849 -> 'ASRock'            (pci-ids.ucw.cz/read/PC/1849: ASRock
//                                    Incorporation - the documented vendor);
//   - 0x6001 -> 'Phantom Gaming 8GB' (the subsys-id variant of THIS dev box's
//                                    A770 - SUBSYS_60011849 live probe;
//                                    user-observed, NOT in any public DB -
//                                    recorded as an observation; the model
//                                    entry fires only under the observed
//                                    ASRock pairing);
//   - 0x8086 -> 'Intel (Limited Edition)' (the LE decode - makes the 228 W
//                                    LE power-limit entry reachable).
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

/** The documented subsystem-vendor decode: pciSubsysVendorId -> vendor. */
const SUBSYS_VENDOR: Record<number, string> = {
  0x1849: 'ASRock', // pci-ids.ucw.cz/read/PC/1849
  0x8086: 'Intel (Limited Edition)', // the LE decode (the 228 W PL row key)
};

/** The documented subsystem-id (variant) decode - keyed on the OBSERVED
 *  vendor pairing (the model claim is only valid under its vendor). */
const SUBSYS_MODEL: Record<number, { vendorId: number; model: string }> = {
  // User-observed on the dev box: PCI\VEN_8086&DEV_56A0&SUBSYS_60011849 -
  // the 'Phantom Gaming 8GB' A770. NOT in public DBs (DeviceHunt: 0x6001
  // unlisted) - recorded as an observation, never a public-DB citation.
  0x6001: { vendorId: 0x1849, model: 'Phantom Gaming 8GB' },
};

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
 * M17c: decode the AIB from the IGCL subsystem fields. The subsystem
 * vendor table (documented entries only: ASRock 0x1849, Intel LE 0x8086);
 * the subsys-id variant (0x6001 -> 'Phantom Gaming 8GB') fires ONLY under
 * its observed vendor pairing. Unknown vendor / garbage input -> null (the
 * honest '-' - never an invented partner).
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
  const model = variant && variant.vendorId === vendorId ? variant.model : null;
  return { vendor, model };
}

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
