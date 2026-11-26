//! Native Windows startup registration. Dev builds use the HKCU Run value;
//! packaged builds use the explicitly elevated per-user logon task so Windows
//! can launch the administrator-manifest host reliably at logon.
use super::{native_store::NativeStore, native_system::BuildKind};
use serde_json::{json, Value};
use std::{io::Write, path::{Path, PathBuf}};
use std::process::{Command, Output};

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "ArcPower";
const TASK_NAME: &str = "ArcPowerStartup";
const BOOT_APPLY_TASK_NAME: &str = "ArcPowerBootApply";
const LEGACY_TASK_NAMES: &[&str] = &["ArcPowerAppOnBoot", "ArcPowerApplyOnBoot"];
const LEGACY_RUN_VALUES: &[&str] = &["Arc Power"];

#[derive(Clone, Debug)]
pub struct LegacyRegistrationSnapshot {
    run_values: Vec<(&'static str, Option<(String, String)>)>,
    tasks: Vec<(&'static str, Option<Vec<u8>>)>,
}

struct Registration {
    value_exists: bool,
    task_exists: bool,
}

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

/// Decode output from `reg`/`schtasks`. They write UTF-16 on some paths and,
/// otherwise, the console **OEM code page** (936, 932, 850, ...), which is not
/// valid UTF-8 — decoding it as UTF-8 produced the mojibake users saw in error
/// toasts on CJK installs.
pub(crate) fn decode_console(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) {
        let units: Vec<u16> = bytes[2..].chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        return String::from_utf16_lossy(&units);
    }
    if bytes.len() >= 2 && bytes[0] != 0 && bytes[1] == 0 {
        let units: Vec<u16> = bytes.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        return String::from_utf16_lossy(&units);
    }
    if let Ok(text) = std::str::from_utf8(bytes) { return text.to_owned(); }
    #[cfg(windows)]
    if let Some(text) = decode_oem(bytes) { return text; }
    String::from_utf8_lossy(bytes).into_owned()
}

/// Decode a byte string that is in the system's OEM code page.
#[cfg(windows)]
fn decode_oem(bytes: &[u8]) -> Option<String> {
    use windows_sys::Win32::Globalization::{MultiByteToWideChar, CP_OEMCP};
    let length = i32::try_from(bytes.len()).ok()?;
    if length == 0 { return None; }
    let units = unsafe { MultiByteToWideChar(CP_OEMCP, 0, bytes.as_ptr(), length, std::ptr::null_mut(), 0) };
    if units <= 0 { return None; }
    let mut buffer = vec![0u16; units as usize];
    let written = unsafe { MultiByteToWideChar(CP_OEMCP, 0, bytes.as_ptr(), length, buffer.as_mut_ptr(), units) };
    if written <= 0 { return None; }
    buffer.truncate(written as usize);
    Some(String::from_utf16_lossy(&buffer))
}

fn quoted_path(value: &str) -> Option<String> {
    let value = value.trim();
    value.strip_prefix('"')?.strip_suffix('"').map(str::to_owned).filter(|value| !value.is_empty())
}

fn build_run_value(exec: &Path) -> String { format!("\"{}\"", exec.to_string_lossy()) }

fn parse_run_query(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let value = line.split_once("REG_SZ").map(|(_, value)| value)
            .or_else(|| line.split_once("REG_EXPAND_SZ").map(|(_, value)| value))?;
        quoted_path(value.trim())
    })
}

fn logon_executable(kind: BuildKind) -> Result<PathBuf, String> {
    if kind == BuildKind::Portable {
        if let Some(value) = std::env::var_os("PORTABLE_EXECUTABLE_FILE") {
            let path = PathBuf::from(value);
            if path.is_file() { return Ok(dunce::canonicalize(path).map_err(|error| error.to_string())?); }
        }
    }
    let current = std::env::current_exe().map_err(|error| error.to_string())?;
    dunce::canonicalize(&current).map_err(|_| format!("Cannot resolve the Arc Power executable at {}", current.display()))
}

/// `reg` and `schtasks` localize their error text, so "the value/task does not
/// exist" cannot be matched by English words. Both tools return exit code 1
/// when the requested value or task is absent, which is the dependable signal
/// on every display language.
fn exit_code_is_missing(code: Option<i32>) -> bool { code == Some(1) }

fn query_found_nothing(output: &Output) -> bool {
    // Exit code 1 means "the requested value/task is not present"; the text it
    // prints alongside is localized (German: "Das System kann die angegebene
    // Datei nicht finden"), so it must not be part of the decision.
    exit_code_is_missing(output.status.code())
}

fn read_run() -> Result<Registration, String> {
    let output = command("reg", &["query", RUN_KEY, "/v", RUN_VALUE])?;
    if !output.status.success() {
        if query_found_nothing(&output) {
            return Ok(Registration { value_exists: false, task_exists: false });
        }
        return Err(format!("startup-get: reg query failed: {}", decode_console(&output.stderr).trim()));
    }
    let parsed = parse_run_query(&decode_console(&output.stdout));
    Ok(Registration { value_exists: parsed.is_some(), task_exists: false })
}

fn xml_text(xml: &str, tag: &str) -> Option<String> {
    let start = xml.find(&format!("<{tag}>"))? + tag.len() + 2;
    let end = xml[start..].find(&format!("</{tag}>"))? + start;
    Some(xml[start..end].trim()
        .replace("&quot;", "\"").replace("&apos;", "'").replace("&lt;", "<")
        .replace("&gt;", ">").replace("&amp;", "&"))
}

fn read_task(exec: &Path) -> Result<Registration, String> {
    let output = command("schtasks", &["/query", "/tn", TASK_NAME, "/xml"])?;
    if !output.status.success() {
        if query_found_nothing(&output) {
            return Ok(Registration { value_exists: false, task_exists: false });
        }
        return Err(format!("startup-get: task query failed: {}", decode_console(&output.stderr).trim()));
    }
    let xml = decode_console(&output.stdout);
    let command_text = xml_text(&xml, "Command").unwrap_or_default();
    let arguments = xml_text(&xml, "Arguments").unwrap_or_default();
    let enabled = xml_text(&xml, "Enabled").map(|value| !value.eq_ignore_ascii_case("false")).unwrap_or(true);
    let matches = enabled
        && quoted_path(&command_text).or_else(|| Some(command_text.trim().to_owned()))
            .is_some_and(|command| command.eq_ignore_ascii_case(&exec.to_string_lossy()))
        && arguments.trim().is_empty();
    Ok(Registration { value_exists: matches, task_exists: true })
}

fn read_registration(kind: BuildKind, exec: &Path) -> Result<Registration, String> {
    if kind == BuildKind::Dev { read_run() } else { read_task(exec) }
}

fn ignore_exit(output: Result<Output, String>) { let _ = output; }

fn delete_run_value() -> Result<(), String> {
    let output = command("reg", &["delete", RUN_KEY, "/v", RUN_VALUE, "/f"])?;
    if output.status.success() { return Ok(()); }
    // Deleting an absent value also exits 1; that is already the desired state.
    if query_found_nothing(&output) { return Ok(()); }
    Err(format!("startup-set: Run cleanup failed: {}", decode_console(&output.stderr).trim()))
}

fn cleanup_legacy() {
    for task in LEGACY_TASK_NAMES { ignore_exit(command("schtasks", &["/delete", "/tn", task, "/f"])); }
    for value in LEGACY_RUN_VALUES { ignore_exit(command("reg", &["delete", RUN_KEY, "/v", value, "/f"])); }
}

fn read_legacy_run_value(name: &'static str) -> Result<Option<(String, String)>, String> {
    let output = command("reg", &["query", RUN_KEY, "/v", name])?;
    if !output.status.success() {
        if query_found_nothing(&output) { return Ok(None); }
        let error = decode_console(&output.stderr);
        let error = if error.trim().is_empty() { decode_console(&output.stdout) } else { error };
        return Err(format!("startup-set: could not snapshot legacy Run value {name}: {}", error.trim()));
    }
    let output = decode_console(&output.stdout);
    for line in output.lines() {
        let lower = line.to_ascii_lowercase();
        if !lower.contains(&name.to_ascii_lowercase()) { continue; }
        if let Some((_, value)) = line.split_once("REG_EXPAND_SZ") {
            return Ok(Some(("REG_EXPAND_SZ".into(), value.trim().to_owned())));
        }
        if let Some((_, value)) = line.split_once("REG_SZ") {
            return Ok(Some(("REG_SZ".into(), value.trim().to_owned())));
        }
    }
    Err(format!("startup-set: could not parse legacy Run value {name}"))
}

fn read_legacy_task_xml(name: &'static str) -> Result<Option<Vec<u8>>, String> {
    let output = command("schtasks", &["/query", "/tn", name, "/xml"])?;
    if output.status.success() { return Ok(Some(output.stdout)); }
    if query_found_nothing(&output) { return Ok(None); }
    let error = decode_console(&output.stderr);
    let error = if error.trim().is_empty() { decode_console(&output.stdout) } else { error };
    Err(format!("startup-set: could not snapshot legacy task {name}: {}", error.trim()))
}

pub fn legacy_registration_snapshot() -> Result<LegacyRegistrationSnapshot, String> {
    let run_values = LEGACY_RUN_VALUES.iter().map(|name| Ok((*name, read_legacy_run_value(name)?)))
        .collect::<Result<Vec<_>, String>>()?;
    let tasks = LEGACY_TASK_NAMES.iter().map(|name| Ok((*name, read_legacy_task_xml(name)?)))
        .collect::<Result<Vec<_>, String>>()?;
    Ok(LegacyRegistrationSnapshot { run_values, tasks })
}

fn restore_legacy_run_value(name: &'static str, previous: Option<&(String, String)>) -> Result<(), String> {
    match previous {
        Some((kind, data)) => {
            let output = command("reg", &["add", RUN_KEY, "/v", name, "/t", kind, "/d", data, "/f"])?;
            if !output.status.success() { return Err(format!("startup-set: could not restore legacy Run value {name}")); }
            if read_legacy_run_value(name)?.as_ref() != previous {
                return Err(format!("startup-set: legacy Run value {name} rollback could not be verified"));
            }
        }
        None => {
            let output = command("reg", &["delete", RUN_KEY, "/v", name, "/f"])?;
            if !output.status.success() && read_legacy_run_value(name)?.is_some() {
                return Err(format!("startup-set: could not restore absence of legacy Run value {name}"));
            }
            if read_legacy_run_value(name)?.is_some() {
                return Err(format!("startup-set: legacy Run value {name} still exists after rollback"));
            }
        }
    }
    Ok(())
}

fn restore_legacy_task(name: &'static str, previous: Option<&[u8]>) -> Result<(), String> {
    let current = read_legacy_task_xml(name)?;
    match (previous, current) {
        (Some(_), Some(_)) | (None, None) => Ok(()),
        (None, Some(_)) => {
            let output = command("schtasks", &["/delete", "/tn", name, "/f"])?;
            if !output.status.success() && read_legacy_task_xml(name)?.is_some() {
                return Err(format!("startup-set: could not restore absence of legacy task {name}"));
            }
            if read_legacy_task_xml(name)?.is_some() {
                return Err(format!("startup-set: legacy task {name} still exists after rollback"));
            }
            Ok(())
        }
        (Some(xml), None) => {
            let mut random = [0u8; 16];
            rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut random);
            let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
            let temporary = std::env::temp_dir().join(format!("ArcPower-legacy-task-rollback-{}-{suffix}.xml", std::process::id()));
            let write_result = (|| -> Result<(), String> {
                let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary)
                    .map_err(|error| error.to_string())?;
                file.write_all(xml).map_err(|error| error.to_string())?;
                file.sync_all().map_err(|error| error.to_string())?;
                Ok(())
            })();
            if let Err(error) = write_result {
                let _ = std::fs::remove_file(&temporary);
                return Err(error);
            }
            let path = temporary.to_string_lossy().into_owned();
            let output = command("schtasks", &["/create", "/tn", name, "/xml", &path, "/f"]);
            let _ = std::fs::remove_file(&temporary);
            let output = output?;
            if !output.status.success() || read_legacy_task_xml(name)?.is_none() {
                return Err(format!("startup-set: legacy task {name} could not be restored after a failed reset"));
            }
            Ok(())
        }
    }
}

pub fn restore_legacy_registration(snapshot: &LegacyRegistrationSnapshot) -> Result<(), String> {
    for (name, xml) in snapshot.tasks.iter().rev() {
        restore_legacy_task(name, xml.as_deref())?;
    }
    for (name, value) in snapshot.run_values.iter().rev() {
        restore_legacy_run_value(name, value.as_ref())?;
    }
    Ok(())
}

fn set_run(exec: &Path, enabled: bool) -> Result<(), String> {
    if enabled {
        let value = build_run_value(exec);
        let output = command("reg", &["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &value, "/f"])?;
        if !output.status.success() { return Err(format!("startup-set: reg add failed: {}", decode_console(&output.stderr).trim())); }
    } else if let Err(error) = delete_run_value() {
        return Err(error);
    }
    cleanup_legacy();
    Ok(())
}

fn set_task(exec: &Path, enabled: bool) -> Result<(), String> {
    let current = read_task(exec)?;
    if enabled {
        if !current.value_exists {
            let target = build_run_value(exec);
            let output = command("schtasks", &["/create", "/tn", TASK_NAME, "/sc", "onlogon", "/rl", "highest", "/tr", &target, "/f"])?;
            if !output.status.success() {
                return Err("startup-set: administrator approval is required to create the Windows startup task".into());
            }
            if !read_task(exec)?.value_exists {
                return Err("startup-set: the Windows startup task was not created or points at a different executable".into());
            }
        }
        delete_run_value()?;
    } else {
        if current.task_exists {
            let output = command("schtasks", &["/delete", "/tn", TASK_NAME, "/f"])?;
            if !output.status.success() {
                return Err("startup-set: administrator approval is required to remove the Windows startup task".into());
            }
        }
        delete_run_value()?;
        if read_task(exec)?.value_exists {
            return Err("startup-set: the Windows startup task could not be removed".into());
        }
    }
    cleanup_legacy();
    Ok(())
}

pub fn set_registration(kind: BuildKind, enabled: bool) -> Result<(), String> {
    let exec = logon_executable(kind)?;
    if kind == BuildKind::Dev { set_run(&exec, enabled) } else { set_task(&exec, enabled) }
}

/// Whether a startup registration currently exists, regardless of which
/// executable it points at.
pub fn registration_present(kind: BuildKind) -> Result<bool, String> {
    if kind == BuildKind::Dev {
        Ok(read_run()?.value_exists)
    } else {
        Ok(read_legacy_task_xml(TASK_NAME)?.is_some())
    }
}

/// Re-point an existing logon registration at a new executable after an
/// install location change. Called by the elevated setup; a missing
/// registration is left untouched.
pub fn repair_logon_registration(kind: BuildKind, exec: &Path) -> Result<bool, String> {
    if !registration_present(kind)? { return Ok(false); }
    let exec = dunce::canonicalize(exec).map_err(|error| error.to_string())?;
    if kind == BuildKind::Dev { set_run(&exec, true)?; } else { set_task(&exec, true)?; }
    Ok(true)
}

#[derive(Clone, Debug)]
pub struct RegistrationSnapshot {
    run_value: Option<(String, String)>,
    startup_task_xml: Option<Vec<u8>>,
}

/// Capture both registration locations because packaged cleanup removes a
/// stale Run value as well as the logon task.
pub fn registration_snapshot(kind: BuildKind) -> Result<RegistrationSnapshot, String> {
    let run_value = read_legacy_run_value(RUN_VALUE)?;
    let startup_task_xml = if kind == BuildKind::Dev {
        None
    } else {
        read_legacy_task_xml(TASK_NAME)?
    };
    Ok(RegistrationSnapshot { run_value, startup_task_xml })
}

/// Restore the pre-maintenance registration locations after a failed
/// preparation step, preserving the original task XML and Run value.
pub fn restore_registration(kind: BuildKind, snapshot: RegistrationSnapshot) -> Result<(), String> {
    if kind != BuildKind::Dev {
        restore_legacy_task(TASK_NAME, snapshot.startup_task_xml.as_deref())?;
    }
    restore_legacy_run_value(RUN_VALUE, snapshot.run_value.as_ref())?;
    Ok(())
}

pub fn boot_apply_task_exists() -> Result<bool, String> {
    let output = command("schtasks", &["/query", "/tn", BOOT_APPLY_TASK_NAME])?;
    if output.status.success() { return Ok(true); }
    // Exit code 1 is "no such task" regardless of the display language.
    if query_found_nothing(&output) { return Ok(false); }
    Err(format!("boot-setup: could not verify {BOOT_APPLY_TASK_NAME}: {}", decode_console(&output.stderr).trim()))
}

pub fn boot_apply_task_snapshot() -> Result<Option<Vec<u8>>, String> {
    read_legacy_task_xml(BOOT_APPLY_TASK_NAME)
}

/// Remove the separate self-gating boot-apply task. The compatibility setup
/// removes this task during reset and verifies absence before teardown. Do
/// not prompt here: normal packaged Tauri already runs elevated, and an
/// unprivileged host must fail before teardown.
pub fn remove_boot_apply_task() -> Result<(), String> {
    if !boot_apply_task_exists()? { return Ok(()); }
    let output = command("schtasks", &["/delete", "/tn", BOOT_APPLY_TASK_NAME, "/f"])?;
    if !output.status.success() && boot_apply_task_exists()? {
        return Err("boot-setup: administrator privileges are required to remove ArcPowerBootApply".into());
    }
    if boot_apply_task_exists()? {
        return Err("boot-setup: ArcPowerBootApply still exists after removal".into());
    }
    Ok(())
}

/// Restore the exact boot-apply task XML if pre-teardown maintenance fails
/// after the task was removed.
pub fn restore_boot_apply_task(previous: Option<&[u8]>) -> Result<(), String> {
    restore_legacy_task(BOOT_APPLY_TASK_NAME, previous)
}

/// Restore a missing registration when persisted startup/profile intent still
/// requests logon launch. This mirrors the Electron launch-time repair.
pub fn reconcile(store: &NativeStore, kind: BuildKind) -> Result<bool, String> {
    let exec = logon_executable(kind)?;
    let registration = read_registration(kind, &exec)?;
    if registration.value_exists { return Ok(false); }
    let settings = native_json(store, "load-settings")?;
    let intended_start = settings.get("startWithWindows").and_then(Value::as_bool) == Some(true);
    let intended_boot = settings.get("ocOnBoot").and_then(Value::as_bool) == Some(true)
        && (settings.get("activeProfileId").and_then(Value::as_str).is_some_and(|value| !value.trim().is_empty())
            || settings.get("activeProfileIds").and_then(Value::as_object).is_some_and(|values| values.values().any(|value| value.as_str().is_some_and(|value| !value.trim().is_empty()))));
    if !intended_start && !intended_boot { return Ok(false); }
    set_registration(kind, true)?;
    Ok(true)
}

fn native_json(store: &NativeStore, method: &str) -> Result<Value, String> {
    let encoded = super::wire::encode_json(&json!([]))?;
    let reply = store.invoke(method, &encoded)?;
    super::wire::decode(&reply)?.into_json()
}

/// Compose the public toggle state from registration truth and persisted
/// startup/profile intent, matching the Electron handler.
pub fn state(store: &NativeStore, kind: BuildKind) -> Result<Value, String> {
    let exec = logon_executable(kind)?;
    let registration = read_registration(kind, &exec)?;
    let settings = native_json(store, "load-settings")?;
    let _profiles = native_json(store, "load-profiles").unwrap_or_else(|_| json!([]));
    let has_active_profile = settings.get("activeProfileId").and_then(Value::as_str).is_some_and(|value| !value.trim().is_empty())
        || settings.get("activeProfileIds").and_then(Value::as_object).is_some_and(|values| values.values().any(|value| value.as_str().is_some_and(|value| !value.trim().is_empty())));
    let intended = settings.get("startWithWindows").and_then(Value::as_bool) == Some(true);
    let boot = settings.get("ocOnBoot").and_then(Value::as_bool) == Some(true);
    let mut output = json!({
        "startWithWindows": registration.value_exists && intended,
        "applyOnBoot": registration.value_exists && boot && has_active_profile,
    });
    if kind != BuildKind::Dev { output["registration"] = json!("task"); }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_values_and_queries_are_parsed_exactly() {
        let exec = Path::new(r"C:\Program Files\Arc Power\Arc Power.exe");
        let value = build_run_value(exec);
        assert_eq!(value, r#""C:\Program Files\Arc Power\Arc Power.exe""#);
        assert_eq!(quoted_path(&value).as_deref(), Some(r"C:\Program Files\Arc Power\Arc Power.exe"));
        let query = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\n    ArcPower    REG_SZ    \"C:\\Arc Power.exe\"\n";
        assert_eq!(parse_run_query(query).as_deref(), Some(r"C:\Arc Power.exe"));
    }

    #[test]
    fn task_xml_extracts_command_and_arguments() {
        let xml = r#"<Task><Actions><Exec><Command>&quot;C:\Arc Power.exe&quot;</Command><Arguments></Arguments></Exec></Actions><Settings><Enabled>true</Enabled></Settings></Task>"#;
        assert_eq!(xml_text(xml, "Command").as_deref(), Some(r#""C:\Arc Power.exe""#));
        assert_eq!(xml_text(xml, "Arguments").as_deref(), Some(""));
        assert_eq!(xml_text(xml, "Enabled").as_deref(), Some("true"));
    }

    #[test]
    fn read_only_run_query_is_bounded() {
        let registration = read_run().unwrap();
        let _ = registration.value_exists;
    }

    #[test]
    #[ignore = "live reg delete probe"]
    fn live_absent_value_delete_is_treated_as_clean() {
        // This is the command behind "startup-set: Run cleanup failed" on every
        // profile activation: the Run value is normally absent for packaged
        // builds, so `reg delete` exits 1.
        let output = command("reg", &["delete", RUN_KEY, "/v", "ArcPower__Absent_Test", "/f"])
            .expect("reg delete must run");
        assert!(!output.status.success(), "the probe value must not exist");
        println!("DELETE_EXIT {:?} STDERR {:?}", output.status.code(), decode_console(&output.stderr));
        assert!(query_found_nothing(&output), "an absent value must count as clean");
    }

    #[test]
    fn console_output_decoding_keeps_utf8_and_utf16() {
        // Valid UTF-8 (modern console CP 65001) must pass through unchanged.
        assert_eq!(decode_console("Grüße".as_bytes()), "Grüße");
        assert_eq!(decode_console(b"plain ascii"), "plain ascii");
        // UTF-16LE with a BOM (the reliable form) decodes any script.
        let utf16: Vec<u8> = "Ошибка".encode_utf16().flat_map(u16::to_le_bytes).collect();
        let mut bom = vec![0xff, 0xfe];
        bom.extend_from_slice(&utf16);
        assert_eq!(decode_console(&bom), "Ошибка");
        // Without a BOM only the ASCII shape is detectable; the rest is OEM.
        let ascii16: Vec<u8> = "Error".encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(decode_console(&ascii16), "Error");
        // Bytes that are not UTF-8 must not panic and must not come back empty.
        assert!(!decode_console(&[0x8f, 0xe0, 0xa8]).is_empty());
    }

    #[test]
    fn missing_entries_are_detected_by_exit_code_not_localized_text() {
        // `reg`/`schtasks` print a localized message; only the exit code is
        // dependable ("FEHLER: Das System kann die angegebene Datei nicht finden.").
        assert!(exit_code_is_missing(Some(1)));
        assert!(!exit_code_is_missing(Some(0)));
        assert!(!exit_code_is_missing(Some(2)));
        assert!(!exit_code_is_missing(None));
    }

    #[test]
    #[ignore = "live reg/schtasks query in this machine's display language"]
    fn live_missing_registration_entries_are_absent() {
        // These two names are never registered, and the command's message is
        // localized; before the exit-code fix both returned Err on German
        // Windows instead of "absent".
        assert_eq!(read_legacy_run_value("ArcPower__Absent_Test"), Ok(None));
        assert_eq!(read_legacy_task_xml("ArcPower__Absent_Test"), Ok(None));
        // The real startup task may exist on this machine; querying it must
        // never fail just because the executable moved.
        let registration = read_task(Path::new(r"C:\nonexistent\Arc Power.exe"))
            .expect("querying the startup task must not fail");
        let _ = registration.task_exists;
    }
}
