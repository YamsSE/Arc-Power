//! Windows PDH CPU-frequency estimate for the native telemetry lane. Ports the
//! `cpuFreqMhz` fallback of src/main/sys-stats.js:320-323.
//!
//! This is an ESTIMATE, not a per-core MSR reading: the formatted
//! `% Processor Performance` counter is the aggregate performance of the
//! processors relative to the OS base clock, so `round(base × percent / 100)`
//! approximates the current average core clock and rises above 100% while the
//! CPU boosts. It exists so a machine without the PawnIO kernel driver (where
//! LibreHardwareMonitor cannot read MSRs and reports no CPU clock) still shows
//! a CPU frequency instead of null.

#[cfg(windows)]
use windows_sys::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterValue,
    PdhOpenQueryW, PDH_FMT_COUNTERVALUE, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
};

/// `_Total` keeps the estimate one counter read instead of one per processor.
#[cfg(windows)]
const COUNTER_PATH: &str = r"\Processor Information(_Total)\% Processor Performance";

/// The live input of the estimator: the formatted `% Processor Performance`.
pub trait PerformancePercent: Send {
    fn read_percent(&mut self) -> Option<f64>;
}

/// The `cpuFreqMhz` estimate for one telemetry lane. The base clock is read
/// once (it does not change), so a tick costs one counter read.
pub struct CpuFrequency {
    max_clock_mhz: Option<u32>,
    percent: Option<Box<dyn PerformancePercent>>,
}

impl CpuFrequency {
    pub fn new() -> Self {
        #[cfg(windows)]
        {
            Self::with_percent(
                max_clock_mhz(),
                PdhProcessorPerformance::open().map(|counter| Box::new(counter) as Box<dyn PerformancePercent>),
            )
        }
        #[cfg(not(windows))]
        { Self::with_percent(None, None) }
    }

    /// Construction seam: an explicit base clock and performance-counter
    /// source. The telemetry lane uses [`CpuFrequency::new`]; tests inject a
    /// fixed counter instead of touching the live PDH query.
    pub fn with_percent(max_clock_mhz: Option<u32>, percent: Option<Box<dyn PerformancePercent>>) -> Self {
        Self { max_clock_mhz, percent }
    }

    /// Estimated current CPU clock in MHz. `None` when the counter or the base
    /// clock is unavailable - never a fabricated zero.
    pub fn sample(&mut self) -> Option<f64> {
        let percent = self.percent.as_mut().and_then(|percent| percent.read_percent());
        estimate_mhz(percent, self.max_clock_mhz)
    }
}

/// `round(MaxClockSpeed × "% Processor Performance" / 100)`. Null unless both
/// inputs are positive and finite, so an unavailable counter or base clock
/// degrades to no value instead of 0 MHz.
pub fn estimate_mhz(perf_pct: Option<f64>, max_clock_mhz: Option<u32>) -> Option<f64> {
    let percent = perf_pct.filter(|percent| percent.is_finite() && *percent > 0.0)?;
    let base = max_clock_mhz.filter(|mhz| *mhz > 0)?;
    let mhz = (percent * f64::from(base) / 100.0).round();
    (mhz > 0.0).then_some(mhz)
}

/// The static base clock the perf counter is scaled against. This is the value
/// WMI publishes as `Win32_Processor.MaxClockSpeed`; Windows records it in the
/// processor description key, so reading it there avoids a WMI/PowerShell
/// round trip and any new dependency. Read once by [`CpuFrequency::new`].
#[cfg(windows)]
fn max_clock_mhz() -> Option<u32> {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
    let cpu = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0").ok()?;
    let mhz: u32 = cpu.get_value("~MHz").ok()?;
    (mhz > 0).then_some(mhz)
}

#[cfg(windows)]
struct PdhProcessorPerformance {
    query: PDH_HQUERY,
    counter: PDH_HCOUNTER,
}

#[cfg(windows)]
impl PdhProcessorPerformance {
    /// Opens and primes the counter. `% Processor Performance` is
    /// PERF_AVERAGE_BULK (a delta between two collects), so the first
    /// formatted read needs an earlier collect to compare against.
    fn open() -> Option<Self> {
        let path: Vec<u16> = COUNTER_PATH.encode_utf16().chain(std::iter::once(0)).collect();
        let mut query = std::ptr::null_mut();
        if unsafe { PdhOpenQueryW(std::ptr::null(), 0, &mut query) } != 0 { return None; }
        let mut counter = std::ptr::null_mut();
        if unsafe { PdhAddEnglishCounterW(query, path.as_ptr(), 0, &mut counter) } != 0 {
            unsafe { PdhCloseQuery(query); }
            return None;
        }
        let _ = unsafe { PdhCollectQueryData(query) };
        Some(Self { query, counter })
    }
}

#[cfg(windows)]
impl PerformancePercent for PdhProcessorPerformance {
    fn read_percent(&mut self) -> Option<f64> {
        if unsafe { PdhCollectQueryData(self.query) } != 0 { return None; }
        let mut value: PDH_FMT_COUNTERVALUE = unsafe { std::mem::zeroed() };
        let mut counter_type = 0u32;
        let status = unsafe { PdhGetFormattedCounterValue(self.counter, PDH_FMT_DOUBLE, &mut counter_type, &mut value) };
        if status != 0 || value.CStatus != 0 { return None; }
        let percent = unsafe { value.Anonymous.doubleValue };
        (percent.is_finite() && percent > 0.0).then_some(percent)
    }
}

#[cfg(windows)]
impl Drop for PdhProcessorPerformance {
    fn drop(&mut self) { unsafe { PdhCloseQuery(self.query); } }
}
// PDH query handles are only touched through the owning lane thread.
#[cfg(windows)]
unsafe impl Send for PdhProcessorPerformance {}

#[cfg(test)]
mod tests {
    use super::*;

    struct FixedPercent(Option<f64>);
    impl PerformancePercent for FixedPercent {
        fn read_percent(&mut self) -> Option<f64> { self.0 }
    }

    #[test]
    fn estimate_scales_the_base_clock_by_the_performance_percentage() {
        // Electron's pinned example: round(3301 × 130 / 100) = 4291 MHz.
        assert_eq!(estimate_mhz(Some(130.0), Some(3301)), Some(4291.0));
        assert_eq!(estimate_mhz(Some(100.0), Some(3000)), Some(3000.0));
        // Half-up rounding: 101.85% of 3000 is 3055.5 MHz.
        assert_eq!(estimate_mhz(Some(101.85), Some(3000)), Some(3056.0));
    }

    #[test]
    fn estimate_degrades_to_none_instead_of_zero() {
        assert_eq!(estimate_mhz(None, Some(3301)), None, "missing counter");
        assert_eq!(estimate_mhz(Some(130.0), None), None, "missing MaxClockSpeed");
        assert_eq!(estimate_mhz(Some(130.0), Some(0)), None, "zero MaxClockSpeed");
        assert_eq!(estimate_mhz(Some(0.0), Some(3301)), None, "an MSR-less zero reading is not a clock");
        assert_eq!(estimate_mhz(Some(-5.0), Some(3301)), None);
        assert_eq!(estimate_mhz(Some(f64::NAN), Some(3301)), None);
        assert_eq!(estimate_mhz(Some(f64::INFINITY), Some(3301)), None);
    }

    #[test]
    fn lane_estimate_uses_the_counter_and_never_publishes_zero() {
        let counter = || Some(Box::new(FixedPercent(Some(130.0))) as Box<dyn PerformancePercent>);
        assert_eq!(CpuFrequency::with_percent(Some(3301), counter()).sample(), Some(4291.0));
        assert_eq!(CpuFrequency::with_percent(Some(3301), Some(Box::new(FixedPercent(None)))).sample(), None);
        assert_eq!(CpuFrequency::with_percent(None, counter()).sample(), None);
        assert_eq!(CpuFrequency::with_percent(Some(3301), None).sample(), None);
    }

    /// Live, read-only proof that the counter path and the base clock resolve
    /// on this host (no MSR, no driver, no GPU access). Ignored by default like
    /// the other live checks: `cargo test --lib cpu_frequency -- --ignored`.
    #[test]
    #[ignore]
    fn live_host_reports_a_clock_estimate() {
        let base = max_clock_mhz().expect("HKLM processor description publishes ~MHz");
        assert!(base >= 100, "implausible base clock {base}");
        let mut frequency = CpuFrequency::new();
        std::thread::sleep(std::time::Duration::from_millis(250));
        let mhz = frequency.sample().expect("the _Total processor-performance counter is readable");
        assert!((500.0..=15_000.0).contains(&mhz), "implausible estimate {mhz} from base {base}");
    }
}
