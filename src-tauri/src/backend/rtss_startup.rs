//! Native RTSS startup registration. The RTSS executable is an independent
//! HKCU Run value; Arc Power never elevates or launches RTSS from this path.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "ArcPowerRTSS";
const RTSS_EXE: &str = "RTSS.exe";

fn command(program: &str, args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new(program);
    command.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.output().map_err(|error| error.to_string())
}
fn text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) {
        String::from_utf16_lossy(&bytes[2..].chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect::<Vec<_>>())
    } else if bytes.len() >= 2 && bytes[0] != 0 && bytes[1] == 0 {
        String::from_utf16_lossy(&bytes.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect::<Vec<_>>())
    } else { String::from_utf8_lossy(bytes).into_owned() }
}
fn quoted(value: &str) -> String { format!("\"{}\"", value.replace('"', "")) }
fn unquoted(value: &str) -> String {
    let value = value.trim();
    value.strip_prefix('"').and_then(|value| value.strip_suffix('"')).unwrap_or(value).to_owned()
}
fn same_path(left: &str, right: &str) -> bool {
    left.trim().replace('/', "\\").to_ascii_lowercase() == right.trim().replace('/', "\\").to_ascii_lowercase()
}
fn parse_query(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let value = line.split_once("REG_SZ").map(|(_, value)| value)
            .or_else(|| line.split_once("REG_EXPAND_SZ").map(|(_, value)| value))?;
        let value = value.trim();
        (!value.is_empty()).then(|| unquoted(value))
    })
}
fn registry_install_path() -> Option<String> {
    for (key, value) in [
        (r"HKLM\SOFTWARE\WOW6432Node\Unwinder\RTSS", "InstallPath"),
        (r"HKLM\SOFTWARE\Unwinder\RTSS", "InstallPath"),
        (r"HKLM\SOFTWARE\WOW6432Node\Unwinder\RTSS", "InstallDir"),
        (r"HKLM\SOFTWARE\Unwinder\RTSS", "InstallDir"),
    ] {
        if let Ok(output) = command("reg", &["query", key, "/v", value]) {
            if output.status.success() {
                if let Some(path) = parse_query(&text(&output.stdout)) {
                    let path = if path.to_ascii_lowercase().ends_with(&RTSS_EXE.to_ascii_lowercase()) { path } else { Path::new(&path).join(RTSS_EXE).to_string_lossy().into_owned() };
                    if Path::new(&path).is_file() { return Some(path); }
                }
            }
        }
    }
    None
}
fn known_paths() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for name in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(name) { roots.push(PathBuf::from(root)); }
    }
    roots.into_iter().map(|root| root.join("RivaTuner Statistics Server").join(RTSS_EXE)).filter(|path| path.is_file()).collect()
}
#[cfg(windows)]
fn running_image() -> Option<Option<String>> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE { return None; }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = None;
        let mut next = Process32FirstW(snapshot, &mut entry);
        while next != 0 {
            let end = entry.szExeFile.iter().position(|value| *value == 0).unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..end]).eq_ignore_ascii_case(RTSS_EXE) {
                found = Some(None);
                let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
                if !process.is_null() {
                    let mut path = vec![0u16; 32768];
                    let mut length = path.len() as u32;
                    let ok = QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut length);
                    CloseHandle(process);
                    if ok != 0 {
                        found = Some(Some(String::from_utf16_lossy(&path[..length as usize])));
                        break;
                    }
                }
            }
            next = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        found
    }
}

#[cfg(not(windows))]
fn running_image() -> Option<Option<String>> { None }

pub fn is_running() -> bool { running_image().is_some() }
pub fn executable_path() -> Option<String> {
    let registration = query_registration().ok().flatten();
    resolve_executable(registration.as_deref())
}
fn resolve_executable(registered: Option<&str>) -> Option<String> {
    if let Some(path) = running_image().flatten().filter(|path| Path::new(path).is_file()) { return Some(path); }
    if let Some(path) = known_paths().into_iter().next() { return Some(path.to_string_lossy().into_owned()); }
    if let Some(path) = registry_install_path() { return Some(path); }
    if let Some(path) = registered.filter(|path| path.to_ascii_lowercase().ends_with(&RTSS_EXE.to_ascii_lowercase()) && Path::new(path).is_file()) {
        return Some(path.to_owned());
    }
    None
}
fn query_registration() -> Result<Option<String>, String> {
    let output = command("reg", &["query", RUN_KEY, "/v", RUN_VALUE])?;
    if !output.status.success() {
        let error = text(&output.stderr);
        if output.status.code() == Some(1) && (error.to_ascii_lowercase().contains("unable to find") || error.to_ascii_lowercase().contains("cannot find") || error.trim().is_empty()) {
            return Ok(None);
        }
        return Err(format!("rtss-startup: registry query failed: {}", error.trim()));
    }
    Ok(parse_query(&text(&output.stdout)))
}

/// Read the exact ArcPowerRTSS Run target for maintenance rollback without
/// requiring RTSS to be installed or running.
pub fn registration_snapshot() -> Result<Option<String>, String> { query_registration() }

/// Restore a captured Run target after a failed reset preparation. This writes
/// the existing path directly, so rollback does not depend on RTSS discovery.
pub fn restore_registration(previous: Option<&str>) -> Result<(), String> {
    let Some(previous) = previous else { return set(false).map(|_| ()); };
    let value = quoted(previous);
    let output = command("reg", &["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &value, "/f"])?;
    if !output.status.success() {
        return Err(format!("rtss-startup: registration rollback failed: {}", text(&output.stderr).trim()));
    }
    let after = query_registration()?;
    if after.as_deref().is_none_or(|path| !same_path(path, previous)) {
        return Err("rtss-startup: registration rollback could not be verified".into());
    }
    Ok(())
}

pub fn state() -> Result<Value, String> {
    let registration = query_registration()?;
    let executable = resolve_executable(registration.as_deref());
    let running = running_image().is_some();
    Ok(json!({
        "capable": executable.is_some(),
        "executablePath": executable,
        "valueExists": registration.is_some(),
        "value": registration.as_deref().map(quoted),
        "registeredPath": registration,
        "registered": executable.as_deref().zip(registration.as_deref()).is_some_and(|(left, right)| same_path(left, right)),
        "running": running,
    }))
}

pub fn set(enabled: bool) -> Result<Value, String> {
    if enabled {
        let current = state()?;
        let executable = current.get("executablePath").and_then(Value::as_str).filter(|value| Path::new(value).is_file())
            .ok_or("rtss-startup: RTSS.exe was not found")?;
        let value = quoted(executable);
        let output = command("reg", &["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &value, "/f"])?;
        if !output.status.success() { return Err(format!("rtss-startup: registry write failed: {}", text(&output.stderr).trim())); }
        let after = state()?;
        if after.get("registered").and_then(Value::as_bool) != Some(true) { return Err("rtss-startup: registration could not be verified".into()); }
        return Ok(after);
    }
    let output = command("reg", &["delete", RUN_KEY, "/v", RUN_VALUE, "/f"])?;
    if !output.status.success() {
        let error = text(&output.stderr);
        let lower = error.to_ascii_lowercase();
        if !(lower.contains("unable to find") || lower.contains("cannot find") || error.trim().is_empty()) {
            return Err(format!("rtss-startup: registry removal failed: {}", error.trim()));
        }
    }
    let after = state()?;
    if after.get("valueExists").and_then(Value::as_bool) == Some(true) { return Err("rtss-startup: registration removal could not be verified".into()); }
    Ok(after)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_value_helpers_are_stable() {
        assert_eq!(quoted(r"C:\RivaTuner Statistics Server\RTSS.exe"), r#""C:\RivaTuner Statistics Server\RTSS.exe""#);
        assert_eq!(unquoted(r#""C:\RTSS.exe""#), r"C:\RTSS.exe");
        assert!(same_path(r"C:\RTSS.EXE", "c:/rtss.exe"));
        assert_eq!(parse_query("HKEY_CURRENT_USER\n    ArcPowerRTSS    REG_SZ    \"C:\\RTSS.exe\"\n").as_deref(), Some(r"C:\RTSS.exe"));
    }

    #[test]
    fn read_only_state_is_bounded() {
        let state = state().unwrap();
        assert!(state.get("capable").unwrap().is_boolean());
        assert!(state.get("valueExists").unwrap().is_boolean());
    }
}
