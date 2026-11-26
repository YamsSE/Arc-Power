//! Native RTSS startup registration. The RTSS executable is an independent
//! HKCU Run value; Arc Power never elevates or launches RTSS from this path.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use winreg::{
    enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_SET_VALUE},
    RegKey,
};

const RUN_SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "ArcPowerRTSS";
const RTSS_EXE: &str = "RTSS.exe";

/// Registry API instead of `reg.exe`: no output parsing, no console code page.
fn registration_value() -> Result<Option<String>, String> {
    let key = match RegKey::predef(HKEY_CURRENT_USER).open_subkey(RUN_SUBKEY) {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("rtss-startup: could not open the Run key: {error}")),
    };
    match key.get_value::<String, _>(RUN_VALUE) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("rtss-startup: registry query failed: {error}")),
    }
}

fn write_registration(value: &str) -> Result<(), String> {
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(RUN_SUBKEY)
        .map_err(|error| format!("rtss-startup: could not open the Run key: {error}"))?;
    key.set_value(RUN_VALUE, &value).map_err(|error| format!("rtss-startup: registry write failed: {error}"))
}

fn remove_registration() -> Result<(), String> {
    let key = match RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(RUN_SUBKEY, KEY_SET_VALUE) {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("rtss-startup: could not open the Run key: {error}")),
    };
    match key.delete_value(RUN_VALUE) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("rtss-startup: registry removal failed: {error}")),
    }
}

fn quoted(value: &str) -> String { format!("\"{}\"", value.replace('"', "")) }
fn unquoted(value: &str) -> String {
    let value = value.trim();
    value.strip_prefix('"').and_then(|value| value.strip_suffix('"')).unwrap_or(value).to_owned()
}
fn same_path(left: &str, right: &str) -> bool {
    left.trim().replace('/', "\\").to_ascii_lowercase() == right.trim().replace('/', "\\").to_ascii_lowercase()
}
fn registry_install_path() -> Option<String> {
    for (hive, subkey) in [
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Unwinder\RTSS"),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\Unwinder\RTSS"),
    ] {
        let Ok(key) = RegKey::predef(hive).open_subkey(subkey) else { continue; };
        for name in ["InstallPath", "InstallDir"] {
            let Ok(path) = key.get_value::<String, _>(name) else { continue; };
            let path = if path.to_ascii_lowercase().ends_with(&RTSS_EXE.to_ascii_lowercase()) {
                path
            } else {
                Path::new(&path).join(RTSS_EXE).to_string_lossy().into_owned()
            };
            if Path::new(&path).is_file() { return Some(path); }
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
    Ok(registration_value()?.map(|value| unquoted(&value)))
}

/// Read the exact ArcPowerRTSS Run target for maintenance rollback without
/// requiring RTSS to be installed or running.
pub fn registration_snapshot() -> Result<Option<String>, String> { query_registration() }

/// Restore a captured Run target after a failed reset preparation. This writes
/// the existing path directly, so rollback does not depend on RTSS discovery.
pub fn restore_registration(previous: Option<&str>) -> Result<(), String> {
    let Some(previous) = previous else { return set(false).map(|_| ()); };
    write_registration(&quoted(previous))?;
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
        write_registration(&quoted(executable))?;
        let after = state()?;
        if after.get("registered").and_then(Value::as_bool) != Some(true) { return Err("rtss-startup: registration could not be verified".into()); }
        return Ok(after);
    }
    remove_registration()?;
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
    }

    #[test]
    fn read_only_state_is_bounded() {
        let state = state().unwrap();
        assert!(state.get("capable").unwrap().is_boolean());
        assert!(state.get("valueExists").unwrap().is_boolean());
    }
}
