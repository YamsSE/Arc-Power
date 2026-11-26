//! Human-readable diagnostic snapshot copied from an error toast. It never
//! includes profile contents or credentials: version, platform, GPU rows,
//! startup registration state and the tails of the operational logs.

use serde_json::Value;
use std::fmt::Write as _;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const LOG_FILES: &[&str] = &["webview.log", "dialog.log", "recording.log", "rebar-diagnostic.log"];
const TAIL_LINES: usize = 40;
const TAIL_BYTES: u64 = 8192;

pub fn text(kind: super::native_system::BuildKind, root: &Path) -> String {
    let startup = match super::startup::registration_present(kind) {
        Ok(present) => format!("registered={present}"),
        Err(error) => format!("error: {error}"),
    };
    let gpus = super::gpu_devices::list_devices_merged()
        .as_array().cloned().unwrap_or_default();
    render(kind, root, &startup, &gpus)
}

fn render(kind: super::native_system::BuildKind, root: &Path, startup: &str, gpus: &[Value]) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "Arc Power {} ({})", env!("CARGO_PKG_VERSION"), kind.as_str());
    match windows_version() {
        Some((product, display, build)) => {
            let _ = writeln!(out, "{product} {display} (build {build}) {}", std::env::consts::ARCH);
        }
        None => {
            let _ = writeln!(out, "{} {}", std::env::consts::OS, std::env::consts::ARCH);
        }
    }
    let seconds = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs()).unwrap_or(0);
    let _ = writeln!(out, "Captured at unix {seconds}");
    let _ = writeln!(out, "Startup: {startup}");
    if gpus.is_empty() {
        let _ = writeln!(out, "GPU: none reported");
    }
    for gpu in gpus {
        let name = gpu["name"].as_str().unwrap_or("unknown GPU");
        let driver = gpu["driverVersion"].as_str().unwrap_or("unknown");
        let key = gpu["deviceKey"].as_str().unwrap_or("no device key");
        let _ = writeln!(out, "GPU: {name} | driver {driver} | {key}");
    }
    for name in LOG_FILES {
        let path = root.join(name);
        match read_tail(&path) {
            Some(tail) if !tail.trim().is_empty() => {
                let _ = writeln!(out, "\n--- {name} (last {TAIL_LINES} lines) ---\n{tail}");
            }
            _ => {}
        }
    }
    out
}

fn windows_version() -> Option<(String, String, String)> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_LOCAL_MACHINE;
        use winreg::RegKey;
        let key = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion").ok()?;
        let product = key.get_value::<String, _>("ProductName").ok()?;
        let display = key.get_value::<String, _>("DisplayVersion").unwrap_or_default();
        let build = key.get_value::<String, _>("CurrentBuild").unwrap_or_default();
        Some((product, display, build))
    }
    #[cfg(not(windows))]
    {
        None
    }
}

fn read_tail(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(TAIL_BYTES))).ok()?;
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer).ok()?;
    let text = String::from_utf8_lossy(&buffer).into_owned();
    let lines: Vec<&str> = text.lines().collect();
    Some(lines[lines.len().saturating_sub(TAIL_LINES)..].join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn snapshot_names_the_build_gpu_and_log_tail() {
        let root = std::env::temp_dir().join(format!("arcpower-diagnostics-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let log: String = (0..60).map(|index| format!("line {index}\n")).collect();
        std::fs::write(root.join("dialog.log"), log).unwrap();
        let gpus = vec![json!({"name":"Intel Arc B580","driverVersion":"0x1","deviceKey":"pci:test"})];
        let text = render(super::super::native_system::BuildKind::Installed, &root, "registered=true", &gpus);
        assert!(text.contains(env!("CARGO_PKG_VERSION")));
        assert!(text.contains("Intel Arc B580"));
        assert!(text.contains("driver 0x1"));
        assert!(text.contains("registered=true"));
        assert!(text.contains("line 59"), "the newest lines are included");
        assert!(!text.contains("line 0\n"), "only the tail is included");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_logs_are_skipped_without_failing() {
        let root = std::env::temp_dir().join(format!("arcpower-diagnostics-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let text = render(super::super::native_system::BuildKind::Dev, &root, "registered=false", &[]);
        assert!(text.contains("GPU: none reported"));
        assert!(text.contains("Startup: registered=false"));
        assert!(!text.contains("---"));
    }
}
