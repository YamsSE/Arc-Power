//! Native Windows D3DKMT GPU-node utilization reader. Ports
//! src/main/d3dkmt-gpu-util.js: adapter/node running-time counters, per-LUID
//! baselines, and the busiest-node percentage used by Windows Task Manager.
use serde_json::Value;
use std::collections::HashMap;
use std::time::Instant;

pub const QUERY_STATISTICS_SIZE: usize = 0x328;
const QUERY_STATISTICS_ADAPTER: u32 = 0;
const QUERY_STATISTICS_NODE: u32 = 5;
const OFFSET_TYPE: usize = 0x00;
const OFFSET_LUID_LOW: usize = 0x04;
const OFFSET_LUID_HIGH: usize = 0x08;
const OFFSET_QUERY_RESULT: usize = 0x18;
const OFFSET_ADAPTER_NODE_COUNT: usize = 0x1c;
const OFFSET_QUERY_NODE: usize = 0x320;
const TICKS_PER_MILLISECOND: f64 = 10_000.0;
const MAX_NODE_COUNT: u32 = 256;
/// A lane polls faster than the counters meaningfully move; reuse a reading
/// this recent instead of re-querying every node.
const SAMPLE_CACHE_MS: u128 = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Luid { pub high: u32, pub low: u32 }

pub fn parse_luid(value: &Value) -> Option<Luid> {
    if let Some(text) = value.as_str() {
        let (high, low) = text.trim().split_once(':')?;
        return Some(Luid { high: parse_part(high)?, low: parse_part(low)? });
    }
    let object = value.as_object()?;
    Some(Luid {
        high: parse_value(object.get("high")?)?,
        low: parse_value(object.get("low")?)?,
    })
}

fn parse_value(value: &Value) -> Option<u32> {
    value.as_u64().and_then(|value| u32::try_from(value).ok()).or_else(|| parse_part(value.as_str()?))
}

fn parse_part(value: &str) -> Option<u32> {
    let value = value.trim();
    let parsed = if let Some(hex) = value.strip_prefix("0x") {
        u32::from_str_radix(hex, 16).ok()?
    } else if value.chars().all(|character| character.is_ascii_digit()) {
        value.parse::<u32>().ok()?
    } else {
        u32::from_str_radix(value, 16).ok()?
    };
    Some(parsed)
}

#[derive(Clone, Debug, PartialEq)]
struct NodeReading { id: u32, global_running_time: u64 }
#[derive(Clone, Debug)]
struct Baseline { node_count: u32, sampled_at: Instant, nodes: Vec<NodeReading> }

/// Per-node utilization over one sample interval, keyed by the adapter's node
/// ordinal. The caller labels the ordinals when it has node metadata; this
/// layer never guesses an engine type.
///
/// `pct` is a true interval average: the node's counter delta divided by the
/// wall time the sample was taken over. A delta larger than the wall interval
/// (the counter can advance while the query is in flight) is *clamped to 100*
/// and still reported — dropping it used to erase the busy node and make a
/// loaded card read ~0 %.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NodeUtil { pub node: u32, pub delta_ticks: u64, pub pct: f64 }

/// One read of every node: the wall interval and the per-node deltas that
/// produced the percentages, so a persisted sample can be audited later.
#[derive(Clone, Debug, PartialEq)]
pub struct NodeSample { pub wall_ms: f64, pub nodes: Vec<NodeUtil> }

pub fn node_utilization(previous: &[(u32, u64)], current: &[(u32, u64)], elapsed_ms: f64) -> Vec<NodeUtil> {
    if !elapsed_ms.is_finite() || elapsed_ms <= 0.0 { return Vec::new(); }
    let wall_ticks = (elapsed_ms * TICKS_PER_MILLISECOND).max(1.0);
    let previous: HashMap<u32, u64> = previous.iter().copied().collect();
    let mut readings = Vec::new();
    for (id, now) in current {
        let Some(before) = previous.get(id) else { continue; };
        // A counter that went backwards is a reset, not a measurement.
        if *now < *before { continue; }
        let delta_ticks = *now - *before;
        let pct = (delta_ticks as f64 / wall_ticks * 100.0).clamp(0.0, 100.0);
        readings.push(NodeUtil { node: *id, delta_ticks, pct });
    }
    readings
}

pub fn node_utilization_pcts(previous: &[(u32, u64)], current: &[(u32, u64)], elapsed_ms: f64) -> Vec<(u32, f64)> {
    node_utilization(previous, current, elapsed_ms).into_iter().map(|node| (node.node, node.pct)).collect()
}

/// The busiest node's utilization: Windows' "how much of the GPU is busy"
/// reading. A copy-bound workload must report the copy node, never the idle
/// 3-D node, so this is a max over every node rather than node 0.
pub fn utilization_pct(previous: &[(u32, u64)], current: &[(u32, u64)], elapsed_ms: f64) -> Option<f64> {
    node_utilization_pcts(previous, current, elapsed_ms).into_iter().map(|(_, value)| value).reduce(f64::max)
}

pub struct D3dkmtGpuUtil {
    baselines: HashMap<Luid, Baseline>,
    recent: HashMap<Luid, (Instant, Option<NodeSample>)>,
}

impl D3dkmtGpuUtil {
    pub fn new() -> Self { Self { baselines: HashMap::new(), recent: HashMap::new() } }
    pub fn reset(&mut self, luid: Option<Luid>) {
        if let Some(luid) = luid {
            self.baselines.remove(&luid);
            self.recent.remove(&luid);
        } else {
            self.baselines.clear();
            self.recent.clear();
        }
    }
    /// The busiest node's percentage (Windows' own GPU reading).
    pub fn sample(&mut self, luid: Luid) -> Option<f64> {
        self.sample_nodes(luid).into_iter().flatten().map(|(_, value)| value).reduce(f64::max)
    }
    /// Every node's percentage for the same interval, for diagnosis. The
    /// telemetry lane reports the max; the Stability log prints the detail.
    pub fn sample_nodes(&mut self, luid: Luid) -> Option<Vec<(u32, f64)>> {
        self.sample_detail(luid).map(|sample| sample.nodes.into_iter().map(|node| (node.node, node.pct)).collect())
    }
    /// The full reading: every node's percentage plus the raw counter delta and
    /// wall interval behind it. This is what makes the published scalar
    /// auditable instead of a number that has to be trusted.
    pub fn sample_detail(&mut self, luid: Luid) -> Option<NodeSample> {
        if let Some((at, value)) = self.recent.get(&luid) {
            if at.elapsed().as_millis() < SAMPLE_CACHE_MS { return value.clone(); }
        }
        let value = self.sample_fresh(luid);
        self.recent.insert(luid, (Instant::now(), value.clone()));
        value
    }
    fn sample_fresh(&mut self, luid: Luid) -> Option<NodeSample> {
        #[cfg(windows)]
        { self.sample_windows(luid) }
        #[cfg(not(windows))]
        { let _ = luid; None }
    }
    #[cfg(windows)]
    fn sample_windows(&mut self, luid: Luid) -> Option<NodeSample> {
        let node_count = adapter_node_count(luid)?;
        if node_count == 0 || node_count > MAX_NODE_COUNT {
            self.baselines.remove(&luid);
            return None;
        }
        // Timestamp first: the denominator is the wall interval the counter
        // deltas are measured over, so reading the nodes cannot stretch it.
        let sampled_at = Instant::now();
        let mut nodes = Vec::with_capacity(node_count as usize);
        for id in 0..node_count {
            let global_running_time = node_running_time(luid, id)?;
            nodes.push(NodeReading { id, global_running_time });
        }
        let previous = self.baselines.insert(luid, Baseline { node_count, sampled_at, nodes });
        let Some(previous) = previous else { return None; };
        if previous.node_count != node_count { return None; }
        let elapsed_ms = sampled_at.duration_since(previous.sampled_at).as_secs_f64() * 1000.0;
        let current: Vec<(u32, u64)> = self.baselines.get(&luid)?.nodes.iter().map(|node| (node.id, node.global_running_time)).collect();
        let previous: Vec<(u32, u64)> = previous.nodes.iter().map(|node| (node.id, node.global_running_time)).collect();
        Some(NodeSample { wall_ms: elapsed_ms, nodes: node_utilization(&previous, &current, elapsed_ms) })
    }
}
impl Default for D3dkmtGpuUtil { fn default() -> Self { Self::new() } }

#[cfg(windows)]
#[repr(C, align(8))]
struct QueryBuffer([u8; QUERY_STATISTICS_SIZE]);

#[cfg(windows)]
fn query_buffer(kind: u32, luid: Luid, node: u32) -> QueryBuffer {
    let mut buffer = QueryBuffer([0u8; QUERY_STATISTICS_SIZE]);
    write_u32(&mut buffer.0, OFFSET_TYPE, kind);
    write_u32(&mut buffer.0, OFFSET_LUID_LOW, luid.low);
    write_u32(&mut buffer.0, OFFSET_LUID_HIGH, luid.high);
    write_u32(&mut buffer.0, OFFSET_QUERY_NODE, node);
    buffer
}

#[cfg(windows)]
fn adapter_node_count(luid: Luid) -> Option<u32> {
    let mut buffer = query_buffer(QUERY_STATISTICS_ADAPTER, luid, 0);
    if query_statistics(&mut buffer) != 0 { return None; }
    Some(read_u32(&buffer.0, OFFSET_ADAPTER_NODE_COUNT))
}

#[cfg(windows)]
fn node_running_time(luid: Luid, node: u32) -> Option<u64> {
    let mut buffer = query_buffer(QUERY_STATISTICS_NODE, luid, node);
    if query_statistics(&mut buffer) != 0 { return None; }
    Some(read_u64(&buffer.0, OFFSET_QUERY_RESULT))
}

#[cfg(windows)]
fn query_statistics(buffer: &mut QueryBuffer) -> i32 {
    #[link(name = "gdi32")]
    extern "system" {
        fn D3DKMTQueryStatistics(statistics: *mut std::ffi::c_void) -> i32;
    }
    unsafe { D3DKMTQueryStatistics(buffer.0.as_mut_ptr().cast()) }
}

fn write_u32(buffer: &mut [u8], offset: usize, value: u32) {
    buffer[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}
fn read_u32(buffer: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(buffer[offset..offset + 4].try_into().unwrap())
}
fn read_u64(buffer: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(buffer[offset..offset + 8].try_into().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn luid_strings_parse_to_windows_parts() {
        let luid = parse_luid(&serde_json::json!("0x08070605:0x04030201")).unwrap();
        assert_eq!(luid, Luid { high: 0x0807_0605, low: 0x0403_0201 });
        assert_eq!(parse_luid(&serde_json::json!("0x10:0x20")).unwrap(), Luid { high: 16, low: 32 });
        assert_eq!(parse_luid(&serde_json::json!("10:20")).unwrap(), Luid { high: 10, low: 20 });
        assert!(parse_luid(&serde_json::json!("bad")).is_none());
    }

    #[test]
    fn utilization_uses_the_busiest_node_and_wall_clock() {
        let previous = [(0, 0), (1, 0)];
        let current = [(0, 5_000_000), (1, 2_500_000)];
        assert_eq!(utilization_pct(&previous, &current, 1000.0), Some(50.0));
        assert_eq!(utilization_pct(&previous, &[(0, 10_000_000)], 1000.0), Some(100.0));
        // An overrun is reported as a saturated interval, not discarded.
        assert_eq!(utilization_pct(&previous, &[(0, 20_000_000)], 1000.0), Some(100.0));
        assert_eq!(utilization_pct(&[], &current, 1000.0), None);
        assert_eq!(utilization_pct(&previous, &current, 0.0), None);
    }

    #[test]
    fn an_oversized_delta_is_reported_instead_of_erased() {
        // The counter advances while the query is in flight, so a delta above
        // the wall interval is real. Discarding it used to drop the busy node
        // and leave the max over the remaining (idle) nodes at ~0 %.
        let nodes = node_utilization(&[(0, 0)], &[(0, 6_300_000)], 600.0);
        assert_eq!(nodes.len(), 1, "the node must survive the overrun");
        assert_eq!(nodes[0].delta_ticks, 6_300_000, "the raw delta is kept");
        assert_eq!(nodes[0].pct, 100.0, "and the percentage saturates at 100");
        assert_eq!(utilization_pct(&[(0, 0)], &[(0, 6_300_000)], 600.0), Some(100.0));
    }

    #[test]
    fn a_bursty_window_reports_the_interval_mean_not_the_last_burst() {
        // Six 100 ms sub-intervals alternating idle and saturated inside one
        // 600 ms window: the mean is 50 %, the last sub-interval alone is 100 %.
        let mut accumulated_ticks = 0_u64;
        for percentage in [0.0, 100.0, 0.0, 100.0, 0.0, 100.0] {
            accumulated_ticks += (percentage / 100.0 * 100.0 * TICKS_PER_MILLISECOND) as u64;
        }
        let nodes = node_utilization(&[(0, 0)], &[(0, accumulated_ticks)], 600.0);
        assert_eq!(nodes[0].delta_ticks, accumulated_ticks);
        assert!((nodes[0].pct - 50.0).abs() < 1e-9, "got {}", nodes[0].pct);
        assert_ne!(nodes[0].pct, 100.0, "the last burst must not become the reading");
        // Three equal sub-intervals of idle, saturated, idle: 33.3 %, not 0.
        let mut mixed = 0_u64;
        for percentage in [0.0, 100.0, 0.0] {
            mixed += (percentage / 100.0 * 200.0 * TICKS_PER_MILLISECOND) as u64;
        }
        let nodes = node_utilization(&[(0, 0)], &[(0, mixed)], 600.0);
        assert!((nodes[0].pct - 33.333).abs() < 0.01, "got {}", nodes[0].pct);
    }

    #[test]
    fn an_idle_interval_reports_zero_rather_than_disappearing() {
        let previous = [(0, 5_000), (1, 5_000)];
        let current = [(0, 5_000), (1, 5_000)];
        let nodes = node_utilization(&previous, &current, 600.0);
        assert_eq!(nodes[0].pct, 0.0, "an idle node is a real 0 %, not a missing row");
        assert_eq!(nodes.len(), 2);
        assert_eq!(utilization_pct(&previous, &current, 600.0), Some(0.0));
        // A 1 µs running-time delta is neither rounded away nor dropped: the
        // Electron reference returns the exact counter/interval ratio
        // (d3dkmt-gpu-util.js:105), so the busiest node reads a tiny non-zero
        // percentage.
        assert_eq!(utilization_pct(&previous, &[(0, 5_000), (1, 5_010)], 600.0),
            Some(10.0 / (600.0 * TICKS_PER_MILLISECOND) * 100.0));
    }

    #[test]
    fn node_detail_keeps_the_raw_delta_and_percentage_together() {
        let nodes = node_utilization(&[(0, 0), (7, 0)], &[(0, 5_580_000), (7, 120_000)], 600.0);
        assert_eq!(nodes[0].node, 0);
        assert_eq!(nodes[0].delta_ticks, 5_580_000);
        assert!((nodes[0].pct - 93.0).abs() < 1e-9, "got {}", nodes[0].pct);
        assert_eq!(nodes[1].node, 7);
        assert!((nodes[1].pct - 2.0).abs() < 1e-9, "got {}", nodes[1].pct);
    }

    #[test]
    fn utilization_averages_a_bursty_counter_series_over_the_full_interval() {
        let instantaneous_percentages = [0.0, 100.0, 0.0, 100.0, 0.0, 100.0];
        let interval_ms = 100.0;
        let mut accumulated_ticks = 0_u64;
        for percentage in instantaneous_percentages {
            accumulated_ticks += (percentage * interval_ms * TICKS_PER_MILLISECOND / 100.0) as u64;
        }

        let reported = utilization_pct(&[(0, 0)], &[(0, accumulated_ticks)], interval_ms * 6.0);
        assert_eq!(reported, Some(50.0));
        assert_ne!(reported, Some(*instantaneous_percentages.last().unwrap()));
    }

    #[test]
    fn a_copy_bound_series_reports_the_copy_node_and_never_the_idle_3d_node() {
        // Node 0 is 3-D and idle; node 1 is the copy engine at ~97%.
        let previous = [(0, 0), (1, 0)];
        let current = [(0, 0), (1, 9_700_000)];
        let reported = utilization_pct(&previous, &current, 1000.0);
        assert_eq!(reported, Some(97.0), "the busiest node wins, not node 0");

        let nodes = node_utilization_pcts(&previous, &current, 1000.0);
        assert_eq!(nodes, vec![(0, 0.0), (1, 97.0)], "per-node detail stays available");
    }

    #[test]
    fn per_node_detail_skips_reset_and_missing_nodes() {
        let previous = [(0, 500), (2, 0)];
        let current = [(0, 100), (1, 5_000_000), (2, 2_500_000)];
        assert_eq!(node_utilization_pcts(&previous, &current, 1000.0), vec![(2, 25.0)]);
    }

    #[test]
    fn counter_resets_are_ignored() {
        let previous = [(0, 100)];
        assert_eq!(utilization_pct(&previous, &[(0, 50)], 1000.0), None);
    }
}
