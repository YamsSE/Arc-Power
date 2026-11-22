//! Per-device tuning limits (port of src/renderer/pure/device-limits.ts).
//! The table caps documented stock/advanced ceilings; driver ranges remain
//! the runtime authority and the apply gates consume these values pre-clamp.
use serde_json::Value;

pub const A770_PCI_DEVICE_ID: &str = "0x000056a0";
pub const A750_PCI_DEVICE_ID: &str = "0x000056a1";
pub const A380_PCI_DEVICE_ID: &str = "0x000056a5";
pub const A310_PCI_DEVICE_ID: &str = "0x000056a6";
pub const A580_PCI_DEVICE_ID: &str = "0x000056a2";
pub const STD_PL_MAX_W: f64 = 252.0;
pub const STD_TL_MAX_C: f64 = 90.0;
pub const EXTENDED_PL_MAX_W: f64 = 315.0;
pub const EXTENDED_TL_MAX_C: f64 = 115.0;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ControlLimit {
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub step: Option<f64>,
    /// Documentation marker; the finalize layer ignores it.
    pub unclamp: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DeviceLimits {
    pub listed: bool,
    pub power_limit_w: Option<ControlLimit>,
    pub temp_limit_c: Option<ControlLimit>,
    pub gpu_volt_offset_v: Option<ControlLimit>,
}

fn limit(max: Option<f64>) -> ControlLimit { ControlLimit { max, ..ControlLimit::default() } }

#[cfg(test)]
fn volt(min: f64, max: Option<f64>, step: f64, unclamp: bool) -> ControlLimit {
    ControlLimit { min: Some(min), max, step: Some(step), unclamp }
}

const A770_STOCK: DeviceLimits = DeviceLimits {
    listed: true,
    power_limit_w: None,
    temp_limit_c: Some(ControlLimit { min: None, max: Some(90.0), step: None, unclamp: false }),
    gpu_volt_offset_v: Some(ControlLimit { min: Some(-0.500), max: Some(0.234), step: Some(0.001), unclamp: false }),
};

const A770_ADVANCED: DeviceLimits = DeviceLimits {
    listed: true,
    power_limit_w: Some(ControlLimit { min: None, max: Some(375.0), step: None, unclamp: false }),
    temp_limit_c: Some(ControlLimit { min: None, max: Some(115.0), step: None, unclamp: false }),
    gpu_volt_offset_v: Some(ControlLimit { min: Some(-0.800), max: Some(0.234), step: Some(0.001), unclamp: false }),
};

const A750_STOCK: DeviceLimits = DeviceLimits {
    listed: true,
    power_limit_w: None,
    temp_limit_c: Some(ControlLimit { min: None, max: Some(90.0), step: None, unclamp: false }),
    gpu_volt_offset_v: Some(ControlLimit { min: Some(-0.500), max: None, step: Some(0.001), unclamp: true }),
};

const A750_ADVANCED: DeviceLimits = DeviceLimits {
    listed: true,
    power_limit_w: Some(ControlLimit { min: None, max: Some(270.0), step: None, unclamp: false }),
    temp_limit_c: Some(ControlLimit { min: None, max: Some(115.0), step: None, unclamp: false }),
    gpu_volt_offset_v: Some(ControlLimit { min: Some(-0.800), max: None, step: Some(0.001), unclamp: true }),
};

const A380_STOCK: DeviceLimits = DeviceLimits {
    listed: true,
    power_limit_w: Some(ControlLimit { min: None, max: Some(66.0), step: None, unclamp: false }),
    temp_limit_c: Some(ControlLimit { min: None, max: Some(90.0), step: None, unclamp: false }),
    gpu_volt_offset_v: Some(ControlLimit { min: Some(-0.500), max: None, step: Some(0.001), unclamp: false }),
};

const A380_ADVANCED: DeviceLimits = DeviceLimits {
    listed: true,
    power_limit_w: Some(ControlLimit { min: None, max: Some(225.0), step: None, unclamp: false }),
    temp_limit_c: Some(ControlLimit { min: None, max: Some(90.0), step: None, unclamp: false }),
    gpu_volt_offset_v: Some(ControlLimit { min: Some(-0.800), max: None, step: Some(0.001), unclamp: false }),
};

const A310_ROW: DeviceLimits = DeviceLimits {
    listed: true,
    power_limit_w: Some(ControlLimit { min: None, max: Some(75.0), step: None, unclamp: false }),
    temp_limit_c: Some(ControlLimit { min: None, max: Some(90.0), step: None, unclamp: false }),
    gpu_volt_offset_v: Some(ControlLimit { min: Some(-0.500), max: None, step: Some(0.001), unclamp: false }),
};

const A580_STOCK: DeviceLimits = DeviceLimits {
    listed: true,
    power_limit_w: Some(ControlLimit { min: None, max: Some(180.0), step: None, unclamp: false }),
    temp_limit_c: Some(ControlLimit { min: None, max: Some(90.0), step: None, unclamp: false }),
    gpu_volt_offset_v: Some(ControlLimit { min: Some(-0.500), max: None, step: Some(0.001), unclamp: false }),
};

const A580_ADVANCED: DeviceLimits = DeviceLimits {
    listed: true,
    power_limit_w: Some(ControlLimit { min: None, max: Some(300.0), step: None, unclamp: false }),
    temp_limit_c: Some(ControlLimit { min: None, max: Some(90.0), step: None, unclamp: false }),
    gpu_volt_offset_v: Some(ControlLimit { min: Some(-0.500), max: None, step: Some(0.001), unclamp: false }),
};

fn a770_pl_max(vendor: Option<&str>) -> Option<f64> {
    (vendor == Some("Intel (Limited Edition)")).then_some(228.0)
}

fn a750_pl_max(vendor: Option<&str>) -> Option<f64> {
    match vendor {
        Some("Intel (Limited Edition)") => Some(228.0),
        Some("ASRock" | "Acer") => Some(216.0),
        _ => None,
    }
}

/// Per-device row; an unlisted/missing PCI id keeps the default stock or
/// advanced shape. The JS null-input defensive path is not representable
/// because every native caller has a device identity.
pub fn device_limits_of(pci_device_id: Option<&str>, aib_vendor: Option<&str>, advanced: bool) -> DeviceLimits {
    let pci = pci_device_id.map(str::to_ascii_lowercase).unwrap_or_default();
    match pci.as_str() {
        A770_PCI_DEVICE_ID if advanced => A770_ADVANCED,
        A770_PCI_DEVICE_ID => DeviceLimits {
            power_limit_w: a770_pl_max(aib_vendor).map(|max| limit(Some(max))),
            ..A770_STOCK
        },
        A750_PCI_DEVICE_ID if advanced => A750_ADVANCED,
        A750_PCI_DEVICE_ID => DeviceLimits {
            power_limit_w: a750_pl_max(aib_vendor).map(|max| limit(Some(max))),
            ..A750_STOCK
        },
        A380_PCI_DEVICE_ID if advanced => A380_ADVANCED,
        A380_PCI_DEVICE_ID => A380_STOCK,
        A310_PCI_DEVICE_ID => A310_ROW,
        A580_PCI_DEVICE_ID if advanced => A580_ADVANCED,
        A580_PCI_DEVICE_ID => A580_STOCK,
        _ => default_limits_of(advanced),
    }
}

pub fn default_limits_of(advanced: bool) -> DeviceLimits {
    DeviceLimits {
        listed: false,
        power_limit_w: Some(limit(Some(if advanced { EXTENDED_PL_MAX_W } else { STD_PL_MAX_W }))),
        temp_limit_c: Some(limit(Some(if advanced { EXTENDED_TL_MAX_C } else { STD_TL_MAX_C }))),
        gpu_volt_offset_v: Some(if advanced {
            ControlLimit { min: Some(-0.800), max: None, step: Some(0.001), unclamp: false }
        } else {
            ControlLimit { min: Some(-0.500), max: None, step: Some(0.001), unclamp: false }
        }),
    }
}

/// Identity fields from a caps/device JSON object, mirroring the JS keys.
pub fn identity_of(device: &Value) -> (Option<String>, Option<String>) {
    let text = |key: &str| device.get(key).and_then(Value::as_str).map(str::to_owned);
    (text("pciDeviceId"), text("aibVendor"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pl(limits: &DeviceLimits) -> Option<f64> { limits.power_limit_w.and_then(|value| value.max) }
    fn tl(limits: &DeviceLimits) -> Option<f64> { limits.temp_limit_c.and_then(|value| value.max) }

    #[test]
    fn a770_rows_match_electron() {
        let stock = device_limits_of(Some(A770_PCI_DEVICE_ID), None, false);
        assert!(stock.listed); assert_eq!(pl(&stock), None); assert_eq!(tl(&stock), Some(90.0));
        assert_eq!(stock.gpu_volt_offset_v, Some(volt(-0.5, Some(0.234), 0.001, false)));
        assert_eq!(pl(&device_limits_of(Some(A770_PCI_DEVICE_ID), Some("Intel (Limited Edition)"), false)), Some(228.0));
        assert_eq!(pl(&device_limits_of(Some(A770_PCI_DEVICE_ID), Some("ASRock"), false)), None);
        let advanced = device_limits_of(Some(A770_PCI_DEVICE_ID), None, true);
        assert_eq!((pl(&advanced), tl(&advanced)), (Some(375.0), Some(115.0)));
        assert_eq!(advanced.gpu_volt_offset_v, Some(volt(-0.8, Some(0.234), 0.001, false)));
    }

    #[test]
    fn a750_rows_are_per_aib_and_keep_the_volt_unclamp() {
        let stock = device_limits_of(Some(A750_PCI_DEVICE_ID), Some("ASRock"), false);
        assert_eq!(pl(&stock), Some(216.0)); assert_eq!(tl(&stock), Some(90.0));
        assert_eq!(stock.gpu_volt_offset_v, Some(volt(-0.5, None, 0.001, true)));
        assert_eq!(pl(&device_limits_of(Some(A750_PCI_DEVICE_ID), Some("Acer"), false)), Some(216.0));
        assert_eq!(pl(&device_limits_of(Some(A750_PCI_DEVICE_ID), Some("Intel (Limited Edition)"), false)), Some(228.0));
        assert_eq!(pl(&device_limits_of(Some(A750_PCI_DEVICE_ID), Some("Unknown"), false)), None);
        let advanced = device_limits_of(Some(A750_PCI_DEVICE_ID), Some("ASRock"), true);
        assert_eq!((pl(&advanced), tl(&advanced)), (Some(270.0), Some(115.0)));
        assert_eq!(advanced.gpu_volt_offset_v, Some(volt(-0.8, None, 0.001, true)));
    }

    #[test]
    fn a380_a310_and_a580_rows_match_electron() {
        let a380 = device_limits_of(Some(A380_PCI_DEVICE_ID), None, false);
        assert_eq!((pl(&a380), tl(&a380)), (Some(66.0), Some(90.0)));
        assert_eq!(a380.gpu_volt_offset_v, Some(volt(-0.5, None, 0.001, false)));
        let a380a = device_limits_of(Some(A380_PCI_DEVICE_ID), None, true);
        assert_eq!((pl(&a380a), tl(&a380a)), (Some(225.0), Some(90.0)));
        assert_eq!(a380a.gpu_volt_offset_v, Some(volt(-0.8, None, 0.001, false)));
        for advanced in [false, true] {
            let a310 = device_limits_of(Some(A310_PCI_DEVICE_ID), None, advanced);
            assert_eq!((pl(&a310), tl(&a310)), (Some(75.0), Some(90.0)));
            assert_eq!(a310.gpu_volt_offset_v, Some(volt(-0.5, None, 0.001, false)));
        }
        assert_eq!(pl(&device_limits_of(Some(A580_PCI_DEVICE_ID), None, false)), Some(180.0));
        assert_eq!(pl(&device_limits_of(Some(A580_PCI_DEVICE_ID), None, true)), Some(300.0));
    }

    #[test]
    fn unlisted_cards_keep_the_default_rows() {
        let stock = device_limits_of(Some("0x0000e20b"), Some("ASRock"), false);
        assert!(!stock.listed);
        assert_eq!((pl(&stock), tl(&stock)), (Some(252.0), Some(90.0)));
        assert_eq!(stock.gpu_volt_offset_v, Some(volt(-0.5, None, 0.001, false)));
        let advanced = default_limits_of(true);
        assert_eq!((pl(&advanced), tl(&advanced)), (Some(315.0), Some(115.0)));
        assert_eq!(advanced.gpu_volt_offset_v, Some(volt(-0.8, None, 0.001, false)));
    }
}
