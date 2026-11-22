//! Fail-closed IGCL runtime selection for the staged native Display read.
//!
//! Electron first prefers a DriverStore package whose version matches the
//! active display-class driver, then falls back to the newest package and
//! finally `IGCL_DLL_PATH`. Native Display requires stronger proof: it loads
//! only the active Intel package whose version and `MatchingDeviceId` match
//! a present class-key block selected with Electron's Arc-first ordering. An
//! override or newest-folder fallback cannot establish that identity, so a
//! missing or ambiguous match returns no DLL.
use super::driver_package::{DiscoveryStatus, DriverPackage};
use std::path::{Path, PathBuf};

const DISPLAY_CLASS_KEY: &str = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
const MAX_DISPLAY_CLASS_BLOCKS: usize = 512;

#[derive(Clone, Debug, PartialEq, Eq)]
struct DisplayClassDriver {
    registry_index: u16,
    description: String,
    version: Option<String>,
    matching_device_id: Option<String>,
}

/// Locate the active Intel runtime for native Display. No stale DriverStore,
/// packaged 2023 runtime, or environment override is used if identity proof
/// fails. `IGCL_DLL_PATH` is Electron's last-resort fallback; it is accepted
/// here only as a fixture input to pin that it cannot supersede active-package
/// proof.
#[allow(dead_code)] // Staged until the native Display read switches to this selector.
pub(crate) fn locate_dll() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let blocks = active_display_class_drivers()?;
        let discovery = super::driver_package::discover_active_intel_display_packages().ok()?;
        // A failed present-device inspection could hide another matching
        // package, so uniqueness is not proven by a partial discovery.
        if !discovery_is_complete(discovery.status) { return None; }
        let electron_fallback = std::env::var_os("IGCL_DLL_PATH").map(PathBuf::from)
            .or_else(|| std::env::var_os("ARC_POWER_IGCL_DLL").map(PathBuf::from));
        select_display_dll(&blocks, &discovery.packages, electron_fallback.as_deref())
    }
    #[cfg(not(windows))]
    {
        None
    }
}

fn discovery_is_complete(status: DiscoveryStatus) -> bool {
    status == DiscoveryStatus::Available
}

/// Apply Electron's display-class preference to the eligible present blocks:
/// the last Intel Arc block wins;
/// otherwise the last Intel block wins; otherwise the last class block is
/// selected. The caller requires an Intel hardware match and a unique package,
/// so non-Intel entries cannot select a runtime.
fn selected_electron_block(blocks: &[DisplayClassDriver]) -> Option<&DisplayClassDriver> {
    let is_intel = |block: &&DisplayClassDriver| {
        block.version.as_deref().is_some_and(|version| !version.trim().is_empty())
            && block.description.to_ascii_lowercase().contains("intel")
    };
    let is_discrete_arc = |block: &&DisplayClassDriver| {
        let description = block.description.to_ascii_lowercase();
        description.contains("arc")
            && !["uhd", "iris", "hd graphics"].iter().any(|token| description.contains(token))
    };

    blocks.iter().filter(is_intel).filter(is_discrete_arc)
        .max_by_key(|block| block.registry_index)
        .or_else(|| blocks.iter().filter(is_intel).max_by_key(|block| block.registry_index))
        .or_else(|| blocks.iter().max_by_key(|block| block.registry_index))
}

fn select_active_package<'a>(
    blocks: &[DisplayClassDriver],
    packages: &'a [DriverPackage],
) -> Option<&'a DriverPackage> {
    // Class keys may outlive the device. Apply Arc-first ordering only among
    // blocks that correspond to at least one present, discovered package;
    // a newer stale class key must not hide the present adapter.
    let eligible: Vec<DisplayClassDriver> = blocks.iter().filter(|block| {
        let Some(version) = block.version.as_deref().map(str::trim).filter(|v| !v.is_empty()) else { return false };
        let Some(id) = block.matching_device_id.as_deref().filter(|id| is_intel_pci_hardware_id(id)) else { return false };
        packages.iter().any(|package| package.version.trim().eq_ignore_ascii_case(version)
            && matching_device_id_matches_instance(id, &package.instance_id))
    }).cloned().collect();
    let block = selected_electron_block(&eligible)?;
    let description = block.description.to_ascii_lowercase();
    if !description.contains("intel") { return None; }
    let version = block.version.as_deref()?.trim();
    if version.is_empty() { return None; }
    let matching_id = block.matching_device_id.as_deref()?;
    if !is_intel_pci_hardware_id(matching_id) { return None; }

    let mut matches = packages.iter().filter(|package| {
        package.version.trim().eq_ignore_ascii_case(version)
            && matching_device_id_matches_instance(matching_id, &package.instance_id)
    });
    let selected = matches.next()?;
    let selected_path = normalized_path(&selected.dll_path);
    // Equal-version packages are only interchangeable when SetupAPI resolved
    // them to the same validated package DLL. Distinct paths remain ambiguous.
    matches.all(|package| normalized_path(&package.dll_path) == selected_path).then_some(selected)
}

fn select_display_dll(
    blocks: &[DisplayClassDriver],
    packages: &[DriverPackage],
    _electron_override_fallback: Option<&Path>,
) -> Option<PathBuf> {
    // Deliberately do not use Electron's `IGCL_DLL_PATH` fallback when there
    // is no exact active package. A user-provided file is not active-driver
    // identity proof and native Display must stay read-only and fail closed.
    select_active_package(blocks, packages).map(|package| package.dll_path.clone())
}

fn normalized_path(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").to_ascii_lowercase()
}

fn is_intel_pci_hardware_id(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.contains('\0') || normalized.matches('\\').count() != 1 { return false; }
    let Some(rest) = normalized.strip_prefix("pci\\ven_8086&dev_") else { return false; };
    let bytes = rest.as_bytes();
    bytes.len() >= 4
        && bytes[..4].iter().all(u8::is_ascii_hexdigit)
        && (bytes.len() == 4 || bytes[4] == b'&')
}

fn matching_device_id_matches_instance(matching_id: &str, instance_id: &str) -> bool {
    if !is_intel_pci_hardware_id(matching_id) { return false; }
    let Some((hardware_id, instance)) = instance_id.rsplit_once('\\') else { return false; };
    if instance.is_empty() || !hardware_id.to_ascii_lowercase().starts_with("pci\\ven_8086&dev_") { return false; }
    let matching = matching_id.trim().to_ascii_lowercase();
    let hardware = hardware_id.to_ascii_lowercase();
    hardware == matching || hardware.strip_prefix(&matching).is_some_and(|tail| tail.starts_with('&'))
}

#[cfg(windows)]
fn active_display_class_drivers() -> Option<Vec<DisplayClassDriver>> {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};

    let root = RegKey::predef(HKEY_LOCAL_MACHINE);
    let class = root.open_subkey(DISPLAY_CLASS_KEY).ok()?;
    let mut names = class.enum_keys().collect::<Result<Vec<_>, _>>().ok()?;
    names.retain(|name| name.len() == 4 && name.bytes().all(|byte| byte.is_ascii_digit()));
    names.sort_unstable();
    if names.is_empty() || names.len() > MAX_DISPLAY_CLASS_BLOCKS { return None; }

    names.into_iter().map(|name| {
        let registry_index = name.parse::<u16>().ok()?;
        let key = class.open_subkey(name).ok()?;
        let description = key.get_value::<String, _>("DriverDesc").unwrap_or_default();
        let version = key.get_value::<String, _>("DriverVersion").ok()
            .filter(|value| !value.trim().is_empty());
        let matching_device_id = key.get_value::<String, _>("MatchingDeviceId").ok()
            .filter(|value| !value.trim().is_empty());
        Some(DisplayClassDriver { registry_index, description, version, matching_device_id })
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(index: u16, description: &str, version: &str, matching_id: &str) -> DisplayClassDriver {
        DisplayClassDriver {
            registry_index: index,
            description: description.into(),
            version: (!version.is_empty()).then(|| version.into()),
            matching_device_id: (!matching_id.is_empty()).then(|| matching_id.into()),
        }
    }

    fn package(instance_id: &str, version: &str, dll: &str) -> DriverPackage {
        DriverPackage {
            instance_id: instance_id.into(),
            version: version.into(),
            published_inf: PathBuf::from(r"C:\Windows\INF\oem1.inf"),
            store_inf: PathBuf::from(r"C:\Windows\System32\DriverStore\FileRepository\active\iigd_dch_d.inf"),
            dll_path: PathBuf::from(dll),
        }
    }

    fn arc_block(index: u16, version: &str, matching_id: &str) -> DisplayClassDriver {
        block(index, "Intel(R) Arc(TM) B580 Graphics", version, matching_id)
    }

    #[test]
    fn only_complete_package_discovery_can_prove_uniqueness() {
        assert!(discovery_is_complete(DiscoveryStatus::Available));
        assert!(!discovery_is_complete(DiscoveryStatus::Partial));
        assert!(!discovery_is_complete(DiscoveryStatus::Unavailable));
        assert!(!discovery_is_complete(DiscoveryStatus::NoIntelDisplay));
    }

    #[test]
    fn matches_electron_arc_first_then_last_intel_order() {
        let blocks = vec![
            block(0, "Intel(R) UHD Graphics", "31.0.101.1", r"PCI\VEN_8086&DEV_1234"),
            arc_block(2, "32.0.101.2", r"PCI\VEN_8086&DEV_56A0"),
            arc_block(3, "33.0.101.3", r"PCI\VEN_8086&DEV_E20B"),
        ];
        let packages = vec![
            package(r"PCI\VEN_8086&DEV_56A0&SUBSYS_00000000&REV_08\GPU0", "32.0.101.2", r"C:\Drivers\old\IntelControlLib.dll"),
            package(r"PCI\VEN_8086&DEV_E20B&SUBSYS_00000000&REV_08\GPU1", "33.0.101.3", r"C:\Drivers\active\IntelControlLib.dll"),
        ];
        let selected = select_active_package(&blocks, &packages).unwrap();
        assert_eq!(selected.dll_path, PathBuf::from(r"C:\Drivers\active\IntelControlLib.dll"));
    }

    #[test]
    fn stale_higher_index_arc_does_not_hide_present_package() {
        let blocks = [arc_block(1, "32.0.101.2", r"PCI\VEN_8086&DEV_E20B"),
            arc_block(9, "33.0.101.9", r"PCI\VEN_8086&DEV_56A0")];
        let packages = [package(r"PCI\VEN_8086&DEV_E20B&SUBSYS_00000000&REV_08\GPU0",
            "32.0.101.2", r"C:\Drivers\active\IntelControlLib.dll")];
        assert_eq!(select_active_package(&blocks, &packages).unwrap().dll_path, packages[0].dll_path);
    }

    #[test]
    fn ambiguous_preferred_arc_does_not_fall_back_to_another_device() {
        let blocks = [arc_block(1, "32.0.101.2", r"PCI\VEN_8086&DEV_E20B"),
            arc_block(9, "33.0.101.9", r"PCI\VEN_8086&DEV_56A0")];
        let packages = [
            package(r"PCI\VEN_8086&DEV_E20B&REV_01\GPU0", "32.0.101.2", r"C:\Drivers\other\IntelControlLib.dll"),
            package(r"PCI\VEN_8086&DEV_56A0&REV_01\GPU1", "33.0.101.9", r"C:\Drivers\first\IntelControlLib.dll"),
            package(r"PCI\VEN_8086&DEV_56A0&REV_02\GPU2", "33.0.101.9", r"C:\Drivers\second\IntelControlLib.dll"),
        ];
        assert!(select_active_package(&blocks, &packages).is_none());
    }

    #[test]
    fn uses_last_intel_block_when_no_discrete_arc_block_exists() {
        let blocks = vec![
            block(1, "Intel(R) UHD Graphics", "31.0.101.1", r"PCI\VEN_8086&DEV_1234"),
            block(5, "Intel(R) Iris Xe Graphics", "32.0.101.5", r"PCI\VEN_8086&DEV_9A49"),
        ];
        let packages = vec![package(
            r"PCI\VEN_8086&DEV_9A49&SUBSYS_00000000&REV_01\GPU0",
            "32.0.101.5",
            r"C:\Drivers\iris\IntelControlLib.dll",
        )];
        assert_eq!(select_active_package(&blocks, &packages).unwrap().dll_path,
            PathBuf::from(r"C:\Drivers\iris\IntelControlLib.dll"));
    }

    #[test]
    fn exact_version_and_matching_device_identity_are_both_required() {
        let blocks = [arc_block(2, "32.0.101.2", r"PCI\VEN_8086&DEV_E20B&SUBSYS_11112222")];
        let wrong_device = package(r"PCI\VEN_8086&DEV_56A0&SUBSYS_11112222&REV_08\GPU0", "32.0.101.2", r"C:\Drivers\wrong-device\IntelControlLib.dll");
        let wrong_version = package(r"PCI\VEN_8086&DEV_E20B&SUBSYS_11112222&REV_08\GPU0", "32.0.101.1", r"C:\Drivers\wrong-version\IntelControlLib.dll");
        assert!(select_active_package(&blocks, &[wrong_device, wrong_version]).is_none());
    }

    #[test]
    fn ambiguous_same_version_active_packages_fail_closed() {
        let blocks = [arc_block(2, "32.0.101.2", r"PCI\VEN_8086&DEV_E20B")];
        let packages = [
            package(r"PCI\VEN_8086&DEV_E20B&SUBSYS_11112222&REV_08\GPU0", "32.0.101.2", r"C:\Drivers\one\IntelControlLib.dll"),
            package(r"PCI\VEN_8086&DEV_E20B&SUBSYS_33334444&REV_08\GPU1", "32.0.101.2", r"C:\Drivers\two\IntelControlLib.dll"),
        ];
        assert!(select_active_package(&blocks, &packages).is_none());
    }

    #[test]
    fn electron_override_is_only_a_fallback_and_cannot_bypass_active_identity() {
        let override_path = Path::new(r"C:\Override\IntelControlLib.dll");
        let packages = [package(
            r"PCI\VEN_8086&DEV_E20B&SUBSYS_00000000&REV_08\GPU0",
            "32.0.101.2",
            r"C:\Drivers\active\IntelControlLib.dll",
        )];
        let active = [arc_block(2, "32.0.101.2", r"PCI\VEN_8086&DEV_E20B")];
        assert_eq!(select_display_dll(&active, &packages, Some(override_path)), Some(packages[0].dll_path.clone()));

        let mismatched = [arc_block(2, "32.0.101.3", r"PCI\VEN_8086&DEV_E20B")];
        assert!(select_display_dll(&mismatched, &packages, Some(override_path)).is_none());
    }

    #[test]
    fn non_intel_last_class_block_never_selects_a_stale_intel_package() {
        let blocks = [block(9, "NVIDIA GeForce RTX", "99.0.0.1", r"PCI\VEN_10DE&DEV_1234")];
        let packages = [package(
            r"PCI\VEN_8086&DEV_E20B&SUBSYS_00000000&REV_08\GPU0",
            "32.0.101.2",
            r"C:\Drivers\stale\IntelControlLib.dll",
        )];
        assert!(select_active_package(&blocks, &packages).is_none());
    }

    #[test]
    fn hardware_id_prefix_must_end_at_an_id_component_boundary() {
        assert!(matching_device_id_matches_instance(
            r"PCI\VEN_8086&DEV_E20B&SUBSYS_11112222",
            r"PCI\VEN_8086&DEV_E20B&SUBSYS_11112222&REV_08\GPU0",
        ));
        assert!(!matching_device_id_matches_instance(
            r"PCI\VEN_8086&DEV_E20B&SUBSYS_11112222",
            r"PCI\VEN_8086&DEV_E20B&SUBSYS_111122220&REV_08\GPU0",
        ));
        assert!(!is_intel_pci_hardware_id(r"PCI\VEN_8086&DEV_E20B\GPU0"));
        assert!(is_intel_pci_hardware_id(r"pci\ven_8086&dev_e20B&subsys_11112222"));
    }
}
