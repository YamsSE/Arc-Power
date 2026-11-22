//! Windows PDH GPU Engine utilization fallback. Ports the GPU Engine portions
//! of src/main/sys-stats.js: per-LUID engine rows, per-engine process sums, and
//! the busiest-engine percentage.
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Instant;

#[cfg(windows)]
use windows_sys::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
    PDH_MORE_DATA,
};

use super::d3dkmt_util::Luid;

const CACHE_TTL_MS: u128 = 200;

fn engine_key_of(instance_name: &str) -> String {
    static ENGINE: OnceLock<regex::Regex> = OnceLock::new();
    let engine = ENGINE.get_or_init(|| regex::Regex::new(r"(?i)_phys_(\d+)_eng_(\d+)_engtype_([A-Za-z0-9]*)").unwrap());
    match engine.captures(instance_name) {
        Some(captures) => format!("phys_{}|{}_{}", &captures[1], &captures[3], &captures[2]),
        None => instance_name.to_owned(),
    }
}

/// The canonical engine family of a PDH GPU-Engine instance name. The instance
/// carries the KMD's `DXGK_ENGINE_TYPE` as `engtype_<NAME>`, so this is the one
/// place that knows how a copy-bound workload differs from a 3-D one.
pub fn engine_family_of(instance_name: &str) -> &'static str {
    static ENGINE: OnceLock<regex::Regex> = OnceLock::new();
    let engine = ENGINE.get_or_init(|| regex::Regex::new(r"(?i)_engtype_([A-Za-z0-9]*)").unwrap());
    let Some(captures) = engine.captures(instance_name) else { return "other"; };
    match captures[1].to_ascii_lowercase().as_str() {
        "3d" => "3d",
        "copy" => "copy",
        "compute" => "compute",
        "videodecode" => "videoDecode",
        "videoencode" => "videoEncode",
        _ => "other",
    }
}

fn row_matches_luid(instance_name: &str, luid: Luid) -> bool {
    instance_name.to_ascii_lowercase().contains(&format!(
        "luid_0x{:08x}_0x{:08x}_phys_", luid.high, luid.low
    ))
}

/// Per-engine utilization for one adapter: every process row of an engine is
/// summed (that engine's total), and each family reports its busiest engine.
/// This is the "which engine is busy" view; the reported scalar is the max.
pub fn engine_utilization_pcts(rows: &[(String, f64)], luid: Luid) -> Vec<(&'static str, f64)> {
    // One entry per engine (an engine's process rows are summed) keyed by its
    // family, which must come from the raw instance name because the normalized
    // engine key no longer carries `engtype_`.
    let mut by_engine: HashMap<(String, &'static str), f64> = HashMap::new();
    for (name, value) in rows {
        if !row_matches_luid(name, luid) { continue; }
        if !value.is_finite() || *value < 0.0 { continue; }
        let entry = by_engine.entry((engine_key_of(name), engine_family_of(name))).or_insert(0.0);
        *entry = (*entry + value.min(100.0)).min(100.0);
    }
    let mut by_family: Vec<(&'static str, f64)> = Vec::new();
    // Stable family order so the diagnostic log is diffable between runs.
    for family in ["3d", "copy", "compute", "videoDecode", "videoEncode", "other"] {
        let mut busiest: Option<f64> = None;
        for ((_, key_family), value) in &by_engine {
            if *key_family != family { continue; }
            busiest = Some(busiest.map_or(*value, |current: f64| current.max(*value)));
        }
        if let Some(value) = busiest { by_family.push((family, value)); }
    }
    by_family
}

pub fn utilization_pct(rows: &[(String, f64)], luid: Luid) -> Option<f64> {
    engine_utilization_pcts(rows, luid).into_iter().map(|(_, value)| value).reduce(f64::max)
}


#[cfg(windows)]
pub struct PdhGpuEngine {
    query: PDH_HQUERY,
    counter: PDH_HCOUNTER,
    rows: Vec<(String, f64)>,
    rows_at: Option<Instant>,
}
#[cfg(not(windows))]
pub struct PdhGpuEngine;

impl PdhGpuEngine {
    pub fn new() -> Option<Self> {
        #[cfg(windows)]
        {
            let path: Vec<u16> = r"\GPU Engine(*)\Utilization Percentage".encode_utf16().chain(std::iter::once(0)).collect();
            let mut query = std::ptr::null_mut();
            if unsafe { PdhOpenQueryW(std::ptr::null(), 0, &mut query) } != 0 { return None; }
            let mut counter = std::ptr::null_mut();
            let status = unsafe { PdhAddEnglishCounterW(query, path.as_ptr(), 0, &mut counter) };
            if status != 0 {
                unsafe { PdhCloseQuery(query); }
                return None;
            }
            Some(Self { query, counter, rows: Vec::new(), rows_at: None })
        }
        #[cfg(not(windows))]
        { None }
    }

    pub fn sample(&mut self, luid: Luid) -> Option<f64> {
        self.sample_engines(luid).into_iter().map(|(_, value)| value).reduce(f64::max)
    }

    /// Per-engine readings for the same collect window, for diagnosis.
    pub fn sample_engines(&mut self, luid: Luid) -> Vec<(&'static str, f64)> {
        if let Some(at) = self.rows_at {
            if at.elapsed().as_millis() <= CACHE_TTL_MS { return engine_utilization_pcts(&self.rows, luid); }
        }
        self.refresh();
        engine_utilization_pcts(&self.rows, luid)
    }

    #[cfg(windows)]
    fn refresh(&mut self) {
        if unsafe { PdhCollectQueryData(self.query) } != 0 {
            self.rows.clear();
            self.rows_at = Some(Instant::now());
            return;
        }
        let mut size = 0u32;
        let mut count = 0u32;
        let status = unsafe { PdhGetFormattedCounterArrayW(self.counter, PDH_FMT_DOUBLE, &mut size, &mut count, std::ptr::null_mut()) };
        if status != PDH_MORE_DATA || size == 0 || count == 0 {
            self.rows.clear();
            self.rows_at = Some(Instant::now());
            return;
        }
        let words = (size as usize + 7) / 8;
        let mut buffer = vec![0u64; words];
        let items = buffer.as_mut_ptr().cast::<PDH_FMT_COUNTERVALUE_ITEM_W>();
        let mut received = count;
        let mut actual_size = size;
        let status = unsafe { PdhGetFormattedCounterArrayW(self.counter, PDH_FMT_DOUBLE, &mut actual_size, &mut received, items) };
        if status != 0 {
            self.rows.clear();
            self.rows_at = Some(Instant::now());
            return;
        }
        let item_size = std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>();
        if received as usize * item_size > actual_size as usize { return; }
        let mut rows = Vec::with_capacity(received as usize);
        for index in 0..received as usize {
            let item = unsafe { std::ptr::read_unaligned(items.add(index)) };
            if item.FmtValue.CStatus != 0 || item.szName.is_null() { continue; }
            let mut length = 0usize;
            while length < 4096 && unsafe { *item.szName.add(length) } != 0 { length += 1; }
            if length == 0 || length >= 4096 { continue; }
            let name = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(item.szName, length) });
            let value = unsafe { item.FmtValue.Anonymous.doubleValue };
            if value.is_finite() && value >= 0.0 { rows.push((name, value)); }
        }
        self.rows = rows;
        self.rows_at = Some(Instant::now());
    }
    #[cfg(not(windows))]
    fn refresh(&mut self) {}
}

#[cfg(windows)]
impl Drop for PdhGpuEngine {
    fn drop(&mut self) { unsafe { PdhCloseQuery(self.query); } }
}
// PDH query handles are only touched through the owning telemetry mutex.
unsafe impl Send for PdhGpuEngine {}

pub fn luid_from_target(target: &Value) -> Option<Luid> { super::d3dkmt_util::parse_luid(&target["luid"]) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_keys_and_luid_matching_follow_the_pdh_name_layout() {
        assert_eq!(engine_key_of("pid_123_luid_0x00000000_0x0000adfb_phys_0_eng_1_engtype_3D"), "phys_0|3D_1");
        assert_eq!(engine_key_of("pid_1_luid_0x0_0x0_phys_2_eng_10_engtype_"), "phys_2|_10");
        let luid = Luid { high: 0, low: 0xadfb };
        assert!(row_matches_luid("pid_1_LUID_0x00000000_0x0000ADFB_phys_0_eng_0_engtype_3D", luid));
        assert!(!row_matches_luid("pid_1_luid_0x00000001_0x0000adfb_phys_0", luid));
    }

    #[test]
    fn busiest_engine_sums_process_rows_and_caps_each_engine() {
        let luid = Luid { high: 0, low: 1 };
        let rows = vec![
            ("pid_1_luid_0x00000000_0x00000001_phys_0_eng_0_engtype_3D".into(), 40.0),
            ("pid_2_luid_0x00000000_0x00000001_phys_0_eng_0_engtype_3D".into(), 30.0),
            ("pid_3_luid_0x00000000_0x00000001_phys_0_eng_1_engtype_Copy".into(), 10.0),
            ("pid_4_luid_0x00000000_0x00000002_phys_0_eng_0_engtype_3D".into(), 99.0),
        ];
        assert_eq!(utilization_pct(&rows, luid), Some(70.0));
        let capped = vec![
            ("pid_1_luid_0x00000000_0x00000001_phys_0_eng_0_engtype_3D".into(), 90.0),
            ("pid_2_luid_0x00000000_0x00000001_phys_0_eng_0_engtype_3D".into(), 90.0),
        ];
        assert_eq!(utilization_pct(&capped, luid), Some(100.0));
        assert_eq!(utilization_pct(&[], luid), None);
    }

    #[test]
    fn engine_families_separate_a_copy_bound_workload_from_an_idle_3d_engine() {
        assert_eq!(engine_family_of("pid_1_luid_0x0_0x1_phys_0_eng_0_engtype_3D"), "3d");
        assert_eq!(engine_family_of("pid_1_luid_0x0_0x1_phys_0_eng_1_engtype_Copy"), "copy");
        assert_eq!(engine_family_of("pid_1_luid_0x0_0x1_phys_0_eng_2_engtype_Compute"), "compute");
        assert_eq!(engine_family_of("pid_1_luid_0x0_0x1_phys_0_eng_3_engtype_VideoDecode"), "videoDecode");
        assert_eq!(engine_family_of("pid_1_luid_0x0_0x1_phys_0_eng_4_engtype_VideoEncode"), "videoEncode");
        assert_eq!(engine_family_of("pid_1_luid_0x0_0x1_phys_0_eng_5_engtype_"), "other");

        let luid = Luid { high: 0, low: 1 };
        let copy_bound = vec![
            ("pid_1_luid_0x00000000_0x00000001_phys_0_eng_0_engtype_3D".into(), 0.0),
            ("pid_1_luid_0x00000000_0x00000001_phys_0_eng_1_engtype_Copy".into(), 97.0),
        ];
        assert_eq!(engine_utilization_pcts(&copy_bound, luid),
            vec![("3d", 0.0), ("copy", 97.0)],
            "families stay separate and the detail is kept for the run log");
        assert_eq!(utilization_pct(&copy_bound, luid), Some(97.0),
            "the reported number is the busiest engine, not the idle 3-D one");
    }

    #[test]
    fn a_copy_only_series_reports_the_copy_engine_value() {
        let luid = Luid { high: 2, low: 9 };
        let rows = vec![
            ("pid_7_luid_0x00000002_0x00000009_phys_0_eng_1_engtype_Copy".into(), 63.5),
        ];
        assert_eq!(engine_utilization_pcts(&rows, luid), vec![("copy", 63.5)]);
        assert_eq!(utilization_pct(&rows, luid), Some(63.5));
    }

    #[test]
    fn multiple_engines_of_one_family_report_the_busiest_and_ignore_other_adapters() {
        let luid = Luid { high: 0, low: 1 };
        let rows = vec![
            ("pid_1_luid_0x00000000_0x00000001_phys_0_eng_0_engtype_Copy".into(), 20.0),
            ("pid_1_luid_0x00000000_0x00000001_phys_0_eng_1_engtype_Copy".into(), 80.0),
            ("pid_1_luid_0x00000000_0x00000002_phys_0_eng_0_engtype_3D".into(), 99.0),
            ("pid_1_luid_0x00000000_0x00000001_phys_0_eng_2_engtype_VideoDecode".into(), 5.0),
        ];
        assert_eq!(engine_utilization_pcts(&rows, luid), vec![("copy", 80.0), ("videoDecode", 5.0)]);
        assert_eq!(utilization_pct(&rows, luid), Some(80.0));
    }
}
