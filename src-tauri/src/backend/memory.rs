//! Read-only Windows memory measurements. No process discovery or launching.
//!
//! The caller supplies the exact application-owned process IDs, including
//! attributable WebView2 children and native helpers. This module never sums
//! every WebView2 process on the machine. Working sets include shared pages;
//! their sum can double-count pages and is not a private working-set metric.
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalMemory {
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub used_bytes: u64,
}

impl PhysicalMemory {
    /// Mirrors memory-util.js: total minus available, or unavailable when
    /// subtraction would produce an impossible negative used-byte count.
    pub fn from_totals(total_bytes: u64, available_bytes: u64) -> Option<Self> {
        Some(Self {
            total_bytes,
            available_bytes,
            used_bytes: total_bytes.checked_sub(available_bytes)?,
        })
    }
}

/// A single GlobalMemoryStatusEx call; failure is None, never a zero sample.
#[cfg(windows)]
pub fn physical_memory() -> Option<PhysicalMemory> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    // MEMORYSTATUSEX contains integer fields only; zero is valid for each.
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
        return None;
    }
    PhysicalMemory::from_totals(status.ullTotalPhys, status.ullAvailPhys)
}

#[cfg(not(windows))]
pub fn physical_memory() -> Option<PhysicalMemory> {
    None
}

/// Drop-in numeric semantics for the existing RAM-used telemetry field.
pub fn detect_used_physical_bytes() -> Option<u64> {
    physical_memory().map(|memory| memory.used_bytes)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMemory {
    pub pid: u32,
    /// PROCESS_MEMORY_COUNTERS_EX.PrivateUsage: committed private bytes.
    /// This is not the number of resident private bytes.
    pub private_bytes: u64,
    /// PROCESS_MEMORY_COUNTERS_EX.WorkingSetSize: total resident working set.
    pub working_set_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMemoryTotals {
    pub private_bytes: u64,
    pub working_set_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMemoryMeasurement {
    /// Deduplicated and sorted caller-supplied process IDs.
    pub requested_pids: Vec<u32>,
    pub processes: Vec<ProcessMemory>,
    /// Exited, inaccessible or invalid PIDs. Such samples are not zero bytes.
    pub unavailable_pids: Vec<u32>,
    /// None for an empty request, any failed PID, or arithmetic overflow.
    /// This prevents a partial process tree being reported as a complete sum.
    pub totals: Option<ProcessMemoryTotals>,
}

/// Sample one process using query/read rights only and close its handle.
#[cfg(windows)]
pub fn measure_process(pid: u32) -> Option<ProcessMemory> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };
    if pid == 0 {
        return None;
    }
    struct ProcessHandle(HANDLE);
    impl Drop for ProcessHandle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0); }
        }
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let handle = ProcessHandle(handle);
    // The extended struct begins with PROCESS_MEMORY_COUNTERS. Passing its
    // actual size opts in to PrivateUsage; all fields are initialized integers.
    let mut counters: PROCESS_MEMORY_COUNTERS_EX = unsafe { std::mem::zeroed() };
    counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
    if unsafe {
        K32GetProcessMemoryInfo(
            handle.0,
            (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX).cast::<PROCESS_MEMORY_COUNTERS>(),
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
        )
    } == 0 {
        return None;
    }
    Some(ProcessMemory {
        pid,
        private_bytes: counters.PrivateUsage as u64,
        working_set_bytes: counters.WorkingSetSize as u64,
    })
}

#[cfg(not(windows))]
pub fn measure_process(_pid: u32) -> Option<ProcessMemory> {
    None
}

/// Samples only the supplied PIDs. The caller owns tree membership and must
/// account for process exits/PID reuse when collecting its launch records.
/// Samples are sequential, not an atomic snapshot of a changing process tree.
pub fn measure_processes(pids: &[u32]) -> ProcessMemoryMeasurement {
    measure_processes_with(pids, measure_process)
}

fn measure_processes_with(
    pids: &[u32],
    mut query: impl FnMut(u32) -> Option<ProcessMemory>,
) -> ProcessMemoryMeasurement {
    let requested_pids: Vec<_> = pids.iter().copied().collect::<BTreeSet<_>>().into_iter().collect();
    let mut processes = Vec::with_capacity(requested_pids.len());
    let mut unavailable_pids = Vec::new();
    let mut totals = if requested_pids.is_empty() {
        None
    } else {
        Some(ProcessMemoryTotals { private_bytes: 0, working_set_bytes: 0 })
    };
    for &pid in &requested_pids {
        match query(pid).filter(|sample| sample.pid == pid) {
            Some(sample) => {
                totals = totals.and_then(|sum| Some(ProcessMemoryTotals {
                    private_bytes: sum.private_bytes.checked_add(sample.private_bytes)?,
                    working_set_bytes: sum.working_set_bytes.checked_add(sample.working_set_bytes)?,
                }));
                processes.push(sample);
            }
            None => {
                unavailable_pids.push(pid);
                totals = None;
            }
        }
    }
    ProcessMemoryMeasurement { requested_pids, processes, unavailable_pids, totals }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn physical_bytes_keep_existing_units_and_invalid_total_semantics() {
        assert_eq!(PhysicalMemory::from_totals(32_000_000_000, 19_600_000_000).unwrap().used_bytes, 12_400_000_000);
        assert_eq!(PhysicalMemory::from_totals(0, 0).unwrap().used_bytes, 0);
        assert_eq!(PhysicalMemory::from_totals(u64::MAX, 0).unwrap().used_bytes, u64::MAX);
        assert_eq!(PhysicalMemory::from_totals(10, 11), None);
    }

    #[test]
    fn explicit_pids_are_deduplicated_and_summed_once() {
        let mut queried = Vec::new();
        let result = measure_processes_with(&[8, 3, 8], |pid| {
            queried.push(pid);
            Some(ProcessMemory { pid, private_bytes: pid as u64 * 10, working_set_bytes: pid as u64 * 20 })
        });
        assert_eq!(queried, vec![3, 8]);
        assert_eq!(result.requested_pids, vec![3, 8]);
        assert_eq!(result.totals, Some(ProcessMemoryTotals { private_bytes: 110, working_set_bytes: 220 }));
        assert!(result.unavailable_pids.is_empty());
    }

    #[test]
    fn partial_tree_is_unavailable_instead_of_a_smaller_complete_sum() {
        let result = measure_processes_with(&[1, 2, 3], |pid| {
            (pid != 2).then_some(ProcessMemory { pid, private_bytes: 10, working_set_bytes: 20 })
        });
        assert_eq!(result.unavailable_pids, vec![2]);
        assert_eq!(result.processes.len(), 2);
        assert_eq!(result.totals, None);
        let empty = measure_processes_with(&[], |_| panic!("empty input must not query any process"));
        assert_eq!(empty.totals, None);
    }

    #[test]
    fn overflows_and_wrong_identity_cannot_become_valid_totals() {
        for (private_bytes, working_set_bytes) in [(u64::MAX, 1), (1, u64::MAX)] {
            let result = measure_processes_with(&[1, 2], |pid| Some(ProcessMemory { pid, private_bytes, working_set_bytes }));
            assert_eq!(result.totals, None);
        }
        let wrong = measure_processes_with(&[1], |_| Some(ProcessMemory { pid: 2, private_bytes: 1, working_set_bytes: 1 }));
        assert_eq!(wrong.unavailable_pids, vec![1]);
        assert_eq!(wrong.totals, None);
    }

    #[cfg(windows)]
    #[test]
    fn windows_queries_current_process_and_system_without_launching_helpers() {
        let memory = physical_memory().expect("GlobalMemoryStatusEx should succeed on Windows");
        assert!(memory.total_bytes > 0);
        assert_eq!(memory.used_bytes, memory.total_bytes - memory.available_bytes);
        let pid = std::process::id();
        let result = measure_processes(&[pid, pid]);
        assert!(result.unavailable_pids.is_empty());
        assert_eq!(result.processes.len(), 1);
        let process = result.processes[0];
        assert!(process.private_bytes > 0);
        assert!(process.working_set_bytes > 0);
        assert_eq!(result.totals.unwrap().private_bytes, process.private_bytes);
        assert_eq!(measure_process(0), None);
    }
}
