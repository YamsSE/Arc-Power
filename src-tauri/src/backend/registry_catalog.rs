//! Fixed Windows registry catalog reads and planned action execution.
//!
//! The JSON catalog is shared with Electron's compatibility handler, so the
//! descriptors and apply actions remain byte-for-structure identical. Reads
//! use fixed `reg query` commands; elevated applies execute only the selected
//! catalog's fixed add/delete steps without a shell.

use serde_json::{json, Value};
use std::sync::OnceLock;
#[cfg(windows)]
use std::time::{Duration, Instant};

const CATALOG_JSON: &str = include_str!("../../../src/main/registry-catalog.json");
const REG_NOT_FOUND: i32 = 1;
const MAX_CAPTURED_BYTES: usize = 64 * 1024;
#[cfg(windows)]
const QUERY_TIMEOUT: Duration = Duration::from_secs(10);
pub const REG_APPLY_CANCELED_ERROR: &str = "Applying this tweak requires administrator approval.";
pub const REG_APPLY_START_TIMEOUT_ERROR: &str = "The registry helper did not reach the apply request in time; no registry steps ran.";
pub const REG_APPLY_TIMEOUT_ERROR: &str = "The registry apply timed out after 3 minutes. A registry write that was already in flight may still be completing or may already have landed. Wait for the helper to finish, refresh the registry state, and check the result before retrying or using Revert.";
pub const REG_APPLY_INDETERMINATE_ERROR: &str = "The helper response was lost after the apply request may have been delivered. A registry write may have completed or may still be finishing. Wait for the helper to finish, refresh the registry state, and check the result before retrying or using Revert.";
const JS_WHITESPACE: &str = r"[\x{0009}-\x{000D}\x{0020}\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";
const JS_NON_WHITESPACE: &str = r"[^\x{0009}-\x{000D}\x{0020}\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReadState {
    Enabled,
    Disabled,
    Unknown,
    Default,
}

impl ReadState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Enabled => "enabled",
            Self::Disabled => "disabled",
            Self::Unknown => "unknown",
            Self::Default => "default",
        }
    }
}

#[derive(Default)]
struct QueryResult {
    found: bool,
    value: Option<String>,
    values: Vec<EnumeratedValue>,
}

struct EnumeratedValue {
    data: String,
}

fn named_value_pattern() -> &'static regex::Regex {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        let pattern = format!(r"^[ \t]*{JS_NON_WHITESPACE}+{JS_WHITESPACE}+REG_(?:DWORD|SZ|EXPAND_SZ|BINARY){JS_WHITESPACE}+({JS_NON_WHITESPACE}+){JS_WHITESPACE}*$");
        regex::RegexBuilder::new(&pattern)
            .multi_line(true)
            .build()
            .expect("registry value parser regex is valid")
    })
}

fn key_enum_pattern() -> &'static regex::Regex {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        let pattern = format!(r"^[ \t]*({JS_NON_WHITESPACE}+){JS_WHITESPACE}+REG_[A-Za-z0-9_]+{JS_WHITESPACE}+(.+?){JS_WHITESPACE}*$");
        regex::RegexBuilder::new(&pattern)
            .multi_line(true)
            .build()
            .expect("registry key parser regex is valid")
    })
}

fn normalize_js_line_terminators(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut characters = value.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            '\r' => {
                if characters.peek() == Some(&'\n') { characters.next(); }
                normalized.push('\n');
            }
            '\u{2028}' | '\u{2029}' => normalized.push('\n'),
            other => normalized.push(other),
        }
    }
    normalized
}

fn parse_named_value(stdout: &str, exit_code: Option<i32>) -> QueryResult {
    if exit_code == Some(REG_NOT_FOUND) { return QueryResult::default(); }
    let stdout = normalize_js_line_terminators(stdout);
    let Some(value) = named_value_pattern().captures(&stdout)
        .and_then(|captures| captures.get(1))
        .map(|capture| capture.as_str().to_owned()) else { return QueryResult::default(); };
    QueryResult { found: true, value: Some(value), values: Vec::new() }
}

fn parse_key_enum(stdout: &str, exit_code: Option<i32>) -> QueryResult {
    if exit_code == Some(REG_NOT_FOUND) { return QueryResult::default(); }
    let stdout = normalize_js_line_terminators(stdout);
    let values = key_enum_pattern().captures_iter(&stdout).filter_map(|captures| {
        captures.get(2)
            .map(|capture| EnumeratedValue { data: capture.as_str().to_owned() })
    }).collect::<Vec<_>>();
    QueryResult { found: !values.is_empty(), value: None, values }
}

#[cfg(windows)]
fn query_stdout(arguments: &[String]) -> Option<(String, Option<i32>)> {
    use std::{
        os::windows::process::CommandExt,
        path::PathBuf,
        process::{Command, Stdio},
        sync::mpsc,
        thread,
    };
    use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;

    fn drain_pipe<R: std::io::Read + Send + 'static>(mut pipe: R, capture: bool,
        overflow: std::sync::mpsc::Sender<()>) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut captured = Vec::with_capacity(if capture { MAX_CAPTURED_BYTES } else { 0 });
            let mut total = 0usize;
            let mut buffer = [0u8; 4096];
            loop {
                match pipe.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        let next_total = total.saturating_add(count);
                        if total <= MAX_CAPTURED_BYTES && next_total > MAX_CAPTURED_BYTES {
                            let _ = overflow.send(());
                        }
                        total = next_total;
                        if capture {
                            let remaining = MAX_CAPTURED_BYTES.saturating_sub(captured.len());
                            captured.extend_from_slice(&buffer[..count.min(remaining)]);
                        }
                    }
                }
            }
            captured
        })
    }

    fn stop_child(child: &mut std::process::Child) {
        let _ = child.kill();
        let _ = child.wait();
    }

    let mut system_directory = [0u16; 32768];
    let length = unsafe { GetSystemDirectoryW(system_directory.as_mut_ptr(), system_directory.len() as u32) } as usize;
    if length == 0 || length >= system_directory.len() { return None; }
    let executable = PathBuf::from(String::from_utf16(&system_directory[..length]).ok()?).join("reg.exe");
    let mut child = Command::new(executable)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
        .spawn().ok()?;
    let Some(stdout) = child.stdout.take() else {
        stop_child(&mut child);
        return None;
    };
    let Some(stderr) = child.stderr.take() else {
        stop_child(&mut child);
        return None;
    };
    let (overflow_tx, overflow_rx) = mpsc::channel();
    let stdout_reader = drain_pipe(stdout, true, overflow_tx.clone());
    let stderr_reader = drain_pipe(stderr, false, overflow_tx);

    let deadline = Instant::now() + QUERY_TIMEOUT;
    let mut max_buffer_error = false;
    let status = loop {
        if overflow_rx.try_recv().is_ok() {
            max_buffer_error = true;
            break None;
        }
        if Instant::now() >= deadline { break None; }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(_) => break None,
        }
    };
    if status.is_none() { stop_child(&mut child); }
    let captured = stdout_reader.join().ok()?;
    let _ = stderr_reader.join();
    // A reader can discover the buffer limit after try_wait observes process
    // exit. The execFile-style maxBuffer error still takes precedence over an
    // exit code of 1, so parse the captured stdout with a non-1 error code.
    max_buffer_error |= overflow_rx.try_recv().is_ok();
    let exit_code = if max_buffer_error { None } else { status.and_then(|status| status.code()) };
    Some((String::from_utf8_lossy(&captured).into_owned(), exit_code))
}

#[cfg(not(windows))]
fn query_stdout(_arguments: &[String]) -> Option<(String, Option<i32>)> { None }

fn query_read(read: &Value) -> QueryResult {
    let Some(path) = read.get("path").and_then(Value::as_str) else { return QueryResult::default(); };
    let Some(value) = read.get("value") else { return QueryResult::default(); };
    let mut arguments = vec!["query".to_owned(), path.to_owned()];
    let enumerating = value.is_null();
    if let Some(value) = value.as_str() {
        arguments.extend(["/v".to_owned(), value.to_owned()]);
    } else if !enumerating {
        return QueryResult::default();
    }
    let Some((stdout, exit_code)) = query_stdout(&arguments) else { return QueryResult::default(); };
    if enumerating { parse_key_enum(&stdout, exit_code) } else { parse_named_value(&stdout, exit_code) }
}

fn embedded_catalog() -> Result<Vec<Value>, String> {
    serde_json::from_str(CATALOG_JSON).map_err(|_| "Invalid embedded registry catalog".to_owned())
}

/// Select an immutable apply plan from the shared catalog. This route only
/// returns descriptors; it never reads or writes the Windows registry.
pub fn plan_apply(entry_id: &Value, action: &Value) -> Result<Value, String> {
    let entry_id = entry_id.as_str().ok_or("registry-apply: entryId must be a non-empty string")?;
    if entry_id.is_empty() { return Err("registry-apply: entryId must be a non-empty string".into()); }
    let entries = embedded_catalog()?;
    let entry = entries.iter().find(|entry| entry.get("id").and_then(Value::as_str) == Some(entry_id))
        .ok_or_else(|| format!("registry-apply: unknown entry '{entry_id}'"))?;
    let action = action.as_str().ok_or("registry-apply: action must be one of enable, disable, revert")?;
    if !matches!(action, "enable" | "disable" | "revert") {
        return Err("registry-apply: action must be one of enable, disable, revert".into());
    }
    let steps = entry.get("apply").and_then(Value::as_object)
        .filter(|apply| apply.get("applyable") == Some(&Value::Bool(true)))
        .and_then(|apply| apply.get("actions"))
        .and_then(|actions| actions.get(action))
        .and_then(Value::as_array)
        .ok_or_else(|| format!("registry-apply: '{entry_id}' is read-only (no {action} commands)"))?;
    Ok(json!({"entry":entry.clone(),"action":action,"steps":steps.clone()}))
}

/// The helper's parent-lease callback is checked before each registry step.
/// It may stop future steps, but cannot interrupt a registry call already in flight.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ApplyLease { Continue, Stop }

/// Execute an embedded-catalog plan from the authenticated helper. The caller
/// must hold the cross-process apply mutex; the helper has already validated
/// and pinned the parent SID hive if this action contains current-user steps.
pub fn execute_apply_with_user_hive<F>(entry_id: &str, action: &str, user_sid: &str, mut lease: F) -> Result<Value, String>
where F: FnMut() -> ApplyLease {
    if !is_valid_user_sid(user_sid) {
        return Err("registry-apply: authenticated parent user SID is invalid".into());
    }
    let plan = plan_apply(&Value::String(entry_id.to_owned()), &Value::String(action.to_owned()))?;
    execute_plan(&plan, &mut lease, Some(user_sid))
}

/// Validate the embedded action and report whether it contains current-user
/// writes. This is a pure plan inspection used to avoid demanding write access
/// to a user hive for machine-only catalog actions.
pub fn apply_plan_uses_authenticated_user_hive(entry_id: &str, action: &str, user_sid: &str) -> Result<bool, String> {
    if !is_valid_user_sid(user_sid) {
        return Err("registry-apply: authenticated parent user SID is invalid".into());
    }
    let plan = plan_apply(&Value::String(entry_id.to_owned()), &Value::String(action.to_owned()))?;
    let steps = plan.get("steps").and_then(Value::as_array).ok_or("registry-apply: invalid embedded plan")?;
    let prepared = prepared_steps(steps, Some(user_sid))?;
    Ok(prepared.iter().any(|step| step.root == RegistryRoot::AuthenticatedUser))
}

/// Accept only canonical decimal Windows SID strings. The caller obtains this
/// value from the authenticated parent process token, never from IPC.
pub fn is_valid_user_sid(value: &str) -> bool {
    let mut parts = value.split('-');
    if parts.next() != Some("S") || parts.next() != Some("1") { return false; }
    let Some(authority) = parts.next() else { return false; };
    if authority.is_empty() || !authority.bytes().all(|byte| byte.is_ascii_digit())
        || authority.parse::<u64>().ok().filter(|value| *value <= 0x0000_FFFF_FFFF_FFFF).is_none() {
        return false;
    }
    let subauthorities = parts.collect::<Vec<_>>();
    !subauthorities.is_empty() && subauthorities.len() <= 15
        && subauthorities.iter().all(|part| {
            !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())
                && part.parse::<u32>().is_ok()
        })
}

/// Rewrite current-user paths from the embedded catalog and reject alternate
/// user-hive roots that could bypass the authenticated parent's SID. Machine
/// roots remain untouched. Malformed user-root forms fail closed.
fn path_for_user_hive(path: &str, user_sid: &str) -> Result<String, String> {
    if !is_valid_user_sid(user_sid) {
        return Err("registry-apply: authenticated parent user SID is invalid".into());
    }
    let root = path.split(['\\', '/']).next().unwrap_or("");
    let current_user_root = root.eq_ignore_ascii_case("HKCU") || root.eq_ignore_ascii_case("HKEY_CURRENT_USER");
    if !current_user_root {
        if ["HKU", "HKEY_USERS", "HKCR", "HKEY_CLASSES_ROOT"].iter().any(|alias| root.eq_ignore_ascii_case(alias)) {
            return Err("registry-apply: embedded plan contains an unsupported user-hive root".into());
        }
        return Ok(path.to_owned());
    }

    let prefix_length = root.len() + 1;
    let suffix = path.get(prefix_length..).filter(|_| {
        path.get(..prefix_length).is_some_and(|prefix| {
            prefix[..prefix.len() - 1].eq_ignore_ascii_case(root) && prefix.ends_with('\\')
        })
    })
        .ok_or("registry-apply: malformed embedded HKCU path")?;
    if suffix.is_empty() || suffix.split('\\').any(|part| {
        part.is_empty() || part == "." || part == ".." || part.contains('/') || part.contains(':') || part.contains('\0')
    }) {
        return Err("registry-apply: malformed embedded HKCU path".into());
    }
    Ok(format!("HKU\\{user_sid}\\{suffix}"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RegistryRoot { AuthenticatedUser, LocalMachine }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RegistryWrite { AddDword(u32), DeleteValue }

#[derive(Clone, Debug, PartialEq, Eq)]
struct PreparedStep {
    root: RegistryRoot,
    key_path: String,
    value_name: String,
    write: RegistryWrite,
    label: String,
}

trait RegistryExecutor {
    fn execute(&mut self, step: &PreparedStep) -> Result<(), String>;
}

fn required_step_text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value.get(key).and_then(Value::as_str)
        .ok_or_else(|| format!("registry-apply: invalid embedded step field '{key}'"))
}

fn parse_registry_path(path: &str, user_sid: Option<&str>) -> Result<(RegistryRoot, String), String> {
    let path = match user_sid {
        Some(user_sid) => path_for_user_hive(path, user_sid)?,
        None => path.to_owned(),
    };
    let (root, subkey) = path.split_once('\\').ok_or("registry-apply: invalid embedded registry path")?;
    if subkey.is_empty() || subkey.split('\\').any(|part| {
        part.is_empty() || part == "." || part == ".." || part.contains('/') || part.contains(':') || part.contains('\0')
    }) {
        return Err("registry-apply: invalid embedded registry path".into());
    }
    if root.eq_ignore_ascii_case("HKLM") || root.eq_ignore_ascii_case("HKEY_LOCAL_MACHINE") {
        return Ok((RegistryRoot::LocalMachine, subkey.to_owned()));
    }
    if root.eq_ignore_ascii_case("HKCU") || root.eq_ignore_ascii_case("HKEY_CURRENT_USER") {
        return Err("registry-apply: current-user writes require the authenticated parent SID".into());
    }
    if root.eq_ignore_ascii_case("HKU") || root.eq_ignore_ascii_case("HKEY_USERS") {
        let user_sid = user_sid.ok_or("registry-apply: explicit user-hive roots are unsupported")?;
        let sid_prefix = format!("{user_sid}\\");
        let relative = subkey.strip_prefix(&sid_prefix)
            .filter(|relative| !relative.is_empty())
            .ok_or("registry-apply: mapped path does not target the authenticated user hive")?;
        return Ok((RegistryRoot::AuthenticatedUser, relative.to_owned()));
    }
    if root.eq_ignore_ascii_case("HKCR") || root.eq_ignore_ascii_case("HKEY_CLASSES_ROOT") {
        return Err("registry-apply: explicit user-hive roots are unsupported".into());
    }
    if root.eq_ignore_ascii_case("HKCC") || root.eq_ignore_ascii_case("HKEY_CURRENT_CONFIG") {
        return Err("registry-apply: unsupported embedded registry root".into());
    }
    Err("registry-apply: unsupported embedded registry root".into())
}

fn prepare_step(step: &Value, user_sid: Option<&str>) -> Result<PreparedStep, String> {
    let kind = required_step_text(step, "kind")?;
    let original_path = required_step_text(step, "path")?;
    let (root, key_path) = parse_registry_path(original_path, user_sid)?;
    let value_name = required_step_text(step, "value")?;
    if value_name.is_empty() || value_name.contains('\\') || value_name.contains('/') || value_name.contains('\0') {
        return Err("registry-apply: invalid embedded registry value name".into());
    }
    let write = match kind {
        "add" => {
            if !required_step_text(step, "type")?.eq_ignore_ascii_case("REG_DWORD") {
                return Err("registry-apply: only embedded REG_DWORD writes are supported".into());
            }
            let data = required_step_text(step, "data")?;
            if data.is_empty() || !data.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err("registry-apply: invalid embedded DWORD data".into());
            }
            RegistryWrite::AddDword(data.parse::<u32>().map_err(|_| "registry-apply: embedded DWORD data is out of range")?)
        }
        "delete" => RegistryWrite::DeleteValue,
        _ => return Err(format!("registry-apply: unknown step kind '{kind}'")),
    };
    let label = match &write {
        RegistryWrite::AddDword(data) => format!("{value_name}={data} written to {original_path}"),
        RegistryWrite::DeleteValue => format!("{value_name} deleted from {original_path}"),
    };
    Ok(PreparedStep { root, key_path, value_name: value_name.to_owned(), write, label })
}

fn prepared_steps(steps: &[Value], user_sid: Option<&str>) -> Result<Vec<PreparedStep>, String> {
    steps.iter().map(|step| prepare_step(step, user_sid)).collect()
}

fn not_run_result(prepared: &[PreparedStep], message: &str) -> Value {
    let per_step = prepared.iter().enumerate().map(|(index, step)| json!({
        "step": index,
        "ok": false,
        "status": "not-run",
        "label": step.label,
    })).collect::<Vec<_>>();
    json!({"ok": false, "canceled": true, "message": message, "perStep": per_step})
}

fn catalog_steps_for_result(entry_id: &str, action: &str) -> Result<Vec<PreparedStep>, String> {
    let plan = plan_apply(&Value::String(entry_id.to_owned()), &Value::String(action.to_owned()))?;
    let steps = plan.get("steps").and_then(Value::as_array).ok_or("registry-apply: invalid embedded plan")?;
    // This SID is only a parser sentinel for embedded HKCU labels. It is never
    // authenticated, opened, or passed to a registry executor.
    prepared_steps(steps, Some("S-1-0-0"))
}

/// Build the result for a helper startup timeout, before any apply request
/// could have been delivered. This remains a pure catalog operation.
pub fn helper_start_timeout_result(entry_id: &str, action: &str) -> Result<Value, String> {
    not_run_timeout_result(entry_id, action, REG_APPLY_START_TIMEOUT_ERROR)
}

/// Build a pure timed-out result for any operation that stopped before it
/// began executing registry steps.
pub fn not_run_timeout_result(entry_id: &str, action: &str, message: &str) -> Result<Value, String> {
    let prepared = catalog_steps_for_result(entry_id, action)?;
    let mut result = not_run_result(&prepared, message);
    result["canceled"] = Value::Bool(false);
    result["timedOut"] = Value::Bool(true);
    Ok(result)
}

/// Build a pure result when the helper response is lost after request delivery
/// may have begun. No step can honestly be called done or not-run in this case.
pub fn indeterminate_apply_result(entry_id: &str, action: &str, message: &str) -> Result<Value, String> {
    let prepared = catalog_steps_for_result(entry_id, action)?;
    let per_step = prepared.iter().enumerate().map(|(index, step)| json!({
        "step": index,
        "ok": false,
        "status": "unknown",
        "label": step.label,
    })).collect::<Vec<_>>();
    Ok(json!({
        "ok": false,
        "canceled": false,
        "indeterminate": true,
        "message": message,
        "perStep": per_step,
    }))
}

/// Construct timeout/cancel output from the embedded plan alone. This path
/// never opens a registry key or acquires an apply mutex.
pub fn stopped_apply_result(entry_id: &str, action: &str, message: &str) -> Result<Value, String> {
    let prepared = catalog_steps_for_result(entry_id, action)?;
    Ok(not_run_result(&prepared, message))
}

fn execute_prepared_plan<F, E>(name: &str, prepared: &[PreparedStep], lease: &mut F, executor: &mut E) -> Value
where F: FnMut() -> ApplyLease, E: RegistryExecutor {
    let mut per_step = Vec::with_capacity(prepared.len());
    let mut done = 0usize;
    let mut not_run = 0usize;
    let mut failed_at = None;
    let mut stopped = false;
    for (index, step) in prepared.iter().enumerate() {
        if lease() == ApplyLease::Stop {
            stopped = true;
            per_step.extend(prepared.iter().enumerate().skip(index).map(|(remaining, step)| json!({
                "step": remaining, "ok": false, "status": "not-run", "label": step.label,
            })));
            not_run = prepared.len() - index;
            break;
        }
        let ok = executor.execute(step).is_ok();
        if ok { done += 1; } else { failed_at = Some(index + 1); }
        per_step.push(json!({
            "step": index,
            "ok": ok,
            "status": if ok { "done" } else { "failed" },
            "label": step.label,
        }));
        if !ok {
            per_step.extend(prepared.iter().enumerate().skip(index + 1).map(|(remaining, step)| json!({
                "step": remaining, "ok": false, "status": "not-run", "label": step.label,
            })));
            not_run = prepared.len().saturating_sub(index + 1);
            break;
        }
    }
    let message = if stopped {
        REG_APPLY_TIMEOUT_ERROR.to_owned()
    } else if done == prepared.len() {
        let labels = prepared.iter().map(|step| step.label.as_str()).collect::<Vec<_>>().join("; ");
        format!("{name}: {labels}")
    } else if failed_at.is_some() {
        format!("Partial apply: {done} of {} step(s) landed, step {} failed, {not_run} not run. Nothing was rolled back automatically - use Revert to restore the previous state.", prepared.len(), failed_at.unwrap_or(1))
    } else {
        "No steps landed - the apply failed before writing anything.".to_owned()
    };
    json!({"ok": done == prepared.len(), "canceled": stopped, "timedOut": stopped, "message": message, "perStep": per_step})
}

#[cfg(windows)]
struct WinregExecutor { authenticated_user_hive: Option<winreg::RegKey> }

#[cfg(windows)]
fn apply_step_to_hive(hive: &winreg::RegKey, step: &PreparedStep) -> Result<(), String> {
    use winreg::enums::{KEY_CREATE_SUB_KEY, KEY_SET_VALUE};
    match step.write {
        RegistryWrite::AddDword(data) => {
            let (key, _) = hive.create_subkey_with_flags(&step.key_path, KEY_CREATE_SUB_KEY | KEY_SET_VALUE)
                .map_err(|error| format!("Cannot open embedded registry key: {error}"))?;
            key.set_value(&step.value_name, &data)
                .map_err(|error| format!("Cannot write embedded REG_DWORD value: {error}"))
        }
        RegistryWrite::DeleteValue => {
            let key = hive.open_subkey_with_flags(&step.key_path, KEY_SET_VALUE)
                .map_err(|error| format!("Cannot open embedded registry key: {error}"))?;
            key.delete_value(&step.value_name)
                .map_err(|error| format!("Cannot delete embedded registry value: {error}"))
        }
    }
}

#[cfg(windows)]
impl RegistryExecutor for WinregExecutor {
    fn execute(&mut self, step: &PreparedStep) -> Result<(), String> {
        use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
        match step.root {
            RegistryRoot::AuthenticatedUser => apply_step_to_hive(
                self.authenticated_user_hive.as_ref()
                    .ok_or("registry-apply: authenticated parent hive was not opened")?,
                step,
            ),
            RegistryRoot::LocalMachine => apply_step_to_hive(&RegKey::predef(HKEY_LOCAL_MACHINE), step),
        }
    }
}

fn execute_plan<F>(plan: &Value, lease: &mut F, user_sid: Option<&str>) -> Result<Value, String>
where F: FnMut() -> ApplyLease {
    let entry = plan.get("entry").filter(|entry| entry.is_object()).ok_or("registry-apply: invalid embedded plan")?;
    let name = entry.get("name").and_then(Value::as_str).ok_or("registry-apply: invalid embedded plan")?;
    let steps = plan.get("steps").and_then(Value::as_array).ok_or("registry-apply: invalid embedded plan")?;
    // Validate every embedded operation and translate all user-hive paths
    // before the first write, so bad metadata cannot cause a partial apply.
    let prepared = prepared_steps(steps, user_sid)?;
    #[cfg(windows)]
    {
        use winreg::enums::{KEY_CREATE_SUB_KEY, KEY_SET_VALUE};
        let needs_authenticated_user_hive = prepared.iter().any(|step| step.root == RegistryRoot::AuthenticatedUser);
        let authenticated_user_hive = match (user_sid, needs_authenticated_user_hive) {
            (Some(user_sid), true) => Some(winreg::HKU.open_subkey_with_flags(user_sid, KEY_CREATE_SUB_KEY | KEY_SET_VALUE)
                .map_err(|error| format!("Cannot open authenticated parent hive HKEY_USERS\\{user_sid}: {error}"))?),
            _ => None,
        };
        let mut executor = WinregExecutor { authenticated_user_hive };
        Ok(execute_prepared_plan(name, &prepared, lease, &mut executor))
    }
    #[cfg(not(windows))]
    {
        let _ = (name, prepared, lease);
        Err("registry-apply is only available on Windows".into())
    }
}

#[cfg(test)]
mod user_hive_path_tests {
    use super::{
        apply_plan_uses_authenticated_user_hive, execute_prepared_plan, helper_start_timeout_result,
        indeterminate_apply_result, is_valid_user_sid,
        path_for_user_hive, prepare_step, plan_apply, prepared_steps, stopped_apply_result,
        ApplyLease, PreparedStep, RegistryExecutor,
        RegistryRoot, RegistryWrite,
    };
    use serde_json::{json, Value};

    #[derive(Default)]
    struct FakeExecutor { calls: Vec<String>, fail_on: Option<usize> }

    impl RegistryExecutor for FakeExecutor {
        fn execute(&mut self, step: &PreparedStep) -> Result<(), String> {
            let index = self.calls.len();
            self.calls.push(step.value_name.clone());
            if self.fail_on == Some(index) { Err("fake write failure".into()) } else { Ok(()) }
        }
    }

    #[test]
    fn maps_only_hkcu_roots_to_authenticated_sid() {
        let sid = "S-1-5-21-100-200-300-1001";
        assert!(is_valid_user_sid(sid));
        let expected = r"HKU\S-1-5-21-100-200-300-1001\SOFTWARE\Microsoft\DirectX\UserGpuPreferences";
        assert_eq!(
            path_for_user_hive(r"HKCU\SOFTWARE\Microsoft\DirectX\UserGpuPreferences", sid).unwrap(),
            expected,
        );
        assert_eq!(
            path_for_user_hive(r"HKEY_CURRENT_USER\SOFTWARE\Microsoft\DirectX\UserGpuPreferences", sid).unwrap(),
            expected,
        );
        assert_eq!(path_for_user_hive(r"HKLM\Software\Example", sid).unwrap(), r"HKLM\Software\Example");
    }

    #[test]
    fn rejects_invalid_sid_and_malformed_hkcu_paths() {
        assert!(!is_valid_user_sid("S-1-5-21-not-a-sid"));
        assert!(path_for_user_hive(r"HKCU\Software\..\Example", "S-1-5-21-1").is_err());
        assert!(path_for_user_hive("HKCU", "S-1-5-21-1").is_err());
        assert!(path_for_user_hive(r"HKCU/Software/Example", "S-1-5-21-1").is_err());
        assert!(path_for_user_hive(r"HKU\S-1-5-21-999\Software\Example", "S-1-5-21-1").is_err());
        assert!(path_for_user_hive(r"HKEY_USERS\S-1-5-21-999\Software\Example", "S-1-5-21-1").is_err());
        assert!(path_for_user_hive(r"HKCR\Software\Classes\Example", "S-1-5-21-1").is_err());
        assert!(path_for_user_hive(r"HKEY_CLASSES_ROOT\Example", "S-1-5-21-1").is_err());
    }

    #[test]
    fn prepares_dword_for_parent_hive_and_preserves_original_label() {
        let sid = "S-1-5-21-100-200-300-1001";
        let step = json!({
            "kind": "add",
            "path": r"HKCU\Software\Example",
            "value": "Enabled",
            "type": "REG_DWORD",
            "data": "1"
        });
        let prepared = prepare_step(&step, Some(sid)).unwrap();
        assert_eq!(prepared.root, RegistryRoot::AuthenticatedUser);
        assert_eq!(prepared.key_path, r"Software\Example");
        assert_eq!(prepared.write, RegistryWrite::AddDword(1));
        assert_eq!(prepared.label, r"Enabled=1 written to HKCU\Software\Example");
    }

    #[test]
    fn validates_catalog_entry_and_action_without_execution() {
        assert!(plan_apply(&json!("unknown-entry"), &json!("enable")).is_err());
        assert!(plan_apply(&json!("mpo"), &json!("unknown-action")).is_err());
        assert!(plan_apply(&json!("mpo"), &json!("enable")).is_ok());
    }

    #[test]
    fn only_current_user_plans_require_hive_write_access() {
        let sid = "S-1-5-21-100-200-300-1001";
        assert!(apply_plan_uses_authenticated_user_hive("mpo", "enable", sid).unwrap());
        assert!(!apply_plan_uses_authenticated_user_hive("hags", "enable", sid).unwrap());
        assert!(!apply_plan_uses_authenticated_user_hive("game-dvr", "enable", sid).unwrap());
    }

    #[test]
    fn pre_request_timeout_is_pure_and_reports_all_steps_not_run() {
        let result = helper_start_timeout_result("mpo", "enable").unwrap();
        assert_eq!(result["ok"], Value::Bool(false));
        assert_eq!(result["canceled"], Value::Bool(false));
        assert_eq!(result["timedOut"], Value::Bool(true));
        assert_eq!(result["message"], "The registry helper did not reach the apply request in time; no registry steps ran.");
        assert!(result["perStep"].as_array().unwrap().iter().all(|step| step["status"] == "not-run"));
    }

    #[test]
    fn lost_helper_response_marks_every_step_unknown_and_preserves_labels() {
        let result = indeterminate_apply_result("mpo", "enable", "response lost").unwrap();
        assert_eq!(result["ok"], Value::Bool(false));
        assert_eq!(result["canceled"], Value::Bool(false));
        assert_eq!(result["indeterminate"], Value::Bool(true));
        let steps = result["perStep"].as_array().unwrap();
        assert_eq!(steps.len(), 3);
        assert!(steps.iter().all(|step| step["status"] == "unknown" && step["ok"] == Value::Bool(false)));
        assert_eq!(steps[1]["label"], r"MPOHack=1 written to HKCU\SOFTWARE\Microsoft\DirectX\UserGpuPreferences");
    }

    #[test]
    fn explicit_user_hive_roots_fail_closed_without_an_authenticated_sid() {
        let hku = json!({"kind":"delete","path":r"HKU\S-1-5-21-999\Software\Example","value":"One"});
        let users = json!({"kind":"delete","path":r"HKEY_USERS\S-1-5-21-999\Software\Example","value":"One"});
        let hkcr = json!({"kind":"delete","path":r"HKCR\Software\Classes\Example","value":"One"});
        let classes = json!({"kind":"delete","path":r"HKEY_CLASSES_ROOT\Software\Example","value":"One"});
        let hkcc = json!({"kind":"delete","path":r"HKCC\Software\Example","value":"One"});
        assert!(prepare_step(&hku, None).is_err());
        assert!(prepare_step(&users, None).is_err());
        assert!(prepare_step(&hkcr, None).is_err());
        assert!(prepare_step(&classes, None).is_err());
        assert!(prepare_step(&hkcc, None).is_err());
    }

    #[test]
    fn fake_executor_stops_after_first_failed_write_and_keeps_ordered_labels() {
        let steps = vec![
            json!({"kind":"add","path":r"HKLM\Software\Example","value":"One","type":"REG_DWORD","data":"1"}),
            json!({"kind":"delete","path":r"HKLM\Software\Example","value":"Two"}),
        ];
        let prepared = prepared_steps(&steps, None).unwrap();
        let mut executor = FakeExecutor { calls: Vec::new(), fail_on: Some(0) };
        let result = execute_prepared_plan("Example", &prepared, &mut || ApplyLease::Continue, &mut executor);
        assert_eq!(executor.calls, vec!["One"]);
        assert_eq!(result["ok"], Value::Bool(false));
        assert_eq!(result["perStep"][0]["status"], "failed");
        assert_eq!(result["perStep"][1]["status"], "not-run");
        assert_eq!(result["perStep"][0]["label"], "One=1 written to HKLM\\Software\\Example");
    }

    #[test]
    fn fake_executor_runs_all_steps_in_order_on_success() {
        let steps = vec![
            json!({"kind":"add","path":r"HKLM\Software\Example","value":"One","type":"REG_DWORD","data":"1"}),
            json!({"kind":"delete","path":r"HKLM\Software\Example","value":"Two"}),
        ];
        let prepared = prepared_steps(&steps, None).unwrap();
        let mut executor = FakeExecutor::default();
        let mut lease = || ApplyLease::Continue;
        let result = execute_prepared_plan("Example", &prepared, &mut lease, &mut executor);
        assert_eq!(executor.calls, vec!["One", "Two"]);
        assert_eq!(result["ok"], Value::Bool(true));
        assert_eq!(result["perStep"][0]["status"], "done");
        assert_eq!(result["perStep"][1]["status"], "done");
    }

    #[test]
    fn stop_before_first_write_and_stopped_result_are_registry_free() {
        let steps = vec![
            json!({"kind":"delete","path":r"HKLM\Software\Example","value":"One"}),
            json!({"kind":"delete","path":r"HKLM\Software\Example","value":"Two"}),
        ];
        let prepared = prepared_steps(&steps, None).unwrap();
        let mut executor = FakeExecutor::default();
        let result = execute_prepared_plan("Example", &prepared, &mut || ApplyLease::Stop, &mut executor);
        assert!(executor.calls.is_empty());
        assert_eq!(result["ok"], Value::Bool(false));
        assert_eq!(result["canceled"], Value::Bool(true));
        assert_eq!(result["perStep"][0]["status"], "not-run");

        let mut executor = FakeExecutor::default();
        let mut checks = 0usize;
        let mut lease = || {
            checks += 1;
            if checks == 1 { ApplyLease::Continue } else { ApplyLease::Stop }
        };
        let result = execute_prepared_plan("Example", &prepared, &mut lease, &mut executor);
        assert_eq!(executor.calls, vec!["One"]);
        assert_eq!(result["canceled"], Value::Bool(true));
        assert_eq!(result["perStep"][0]["status"], "done");
        assert_eq!(result["perStep"][1]["status"], "not-run");

        let timeout = stopped_apply_result("mpo", "enable", "timeout").unwrap();
        assert_eq!(timeout["canceled"], Value::Bool(true));
        assert_eq!(timeout["ok"], Value::Bool(false));
        assert_eq!(timeout["perStep"].as_array().unwrap().len(), 3);
        assert_eq!(timeout["perStep"][1]["label"], "MPOHack=1 written to HKCU\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences");
    }
}

fn is_js_whitespace(character: char) -> bool {
    matches!(character,
        '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}'
        | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}'
        | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

fn norm_reg_value(value: Option<&str>) -> String {
    let lowered = value.unwrap_or("").trim_matches(is_js_whitespace).to_lowercase();
    lowered.strip_prefix("0x").unwrap_or(&lowered).to_owned()
}

fn interpret_read(read: &Value, result: &QueryResult) -> (ReadState, String) {
    if !result.found { return (ReadState::Default, "not present".into()); }
    if read.get("value").is_some_and(Value::is_null) {
        let token = norm_reg_value(read.get("on").and_then(Value::as_str));
        let flagged = result.values.iter().filter(|value| norm_reg_value(Some(&value.data)).contains(&token)).count();
        if flagged > 0 {
            return (ReadState::Enabled, format!("{flagged} app(s) carry the {} flag", read["on"].as_str().unwrap_or("")));
        }
        return (ReadState::Disabled, "flags present, none carry the token".into());
    }
    let raw = result.value.as_deref().unwrap_or("");
    let normalized = norm_reg_value(Some(raw));
    if normalized == norm_reg_value(read.get("on").and_then(Value::as_str)) {
        (ReadState::Enabled, format!("{}={raw}", read["value"].as_str().unwrap_or("")))
    } else if read.get("off").and_then(Value::as_str)
        .is_some_and(|off| normalized == norm_reg_value(Some(off))) {
        (ReadState::Disabled, format!("{}={raw}", read["value"].as_str().unwrap_or("")))
    } else {
        (ReadState::Unknown, format!("{}={raw} (unexpected)", read["value"].as_str().unwrap_or("")))
    }
}

fn interpret_entry(entry: &Value, reads: &[(ReadState, String)]) -> (ReadState, String) {
    if reads.iter().any(|(state, _)| *state == ReadState::Unknown) {
        return (ReadState::Unknown, "Unexpected registry values - inspect the reads below".into());
    }
    let state = if reads.iter().any(|(state, _)| *state == ReadState::Enabled) {
        ReadState::Enabled
    } else if reads.iter().any(|(state, _)| *state == ReadState::Disabled) {
        ReadState::Disabled
    } else {
        ReadState::Default
    };
    let detail = if state == ReadState::Default {
        entry.get("absentLabel").and_then(Value::as_str).unwrap_or("").to_owned()
    } else {
        reads.iter().map(|(_, detail)| detail.as_str()).collect::<Vec<_>>().join(" · ")
    };
    (state, detail)
}

/// Return the fixed catalog descriptors and the current read-only state.
/// Query and parse failures deliberately degrade to the existing default
/// state; this path never writes registry values.
pub fn read_catalog() -> Result<Value, String> {
    let entries = embedded_catalog()?;
    let mut states = Vec::with_capacity(entries.len());
    for entry in &entries {
        let mut read_descriptors = Vec::new();
        let mut interpreted = Vec::new();
        for read in entry.get("reads").and_then(Value::as_array).into_iter().flatten() {
            let result = query_read(read);
            let (state, detail) = interpret_read(read, &result);
            let enumerating = read.get("value").is_some_and(Value::is_null);
            let value = if !enumerating && result.found {
                result.value.clone().map(Value::String).unwrap_or(Value::Null)
            } else {
                Value::Null
            };
            read_descriptors.push(json!({
                "read": read.clone(),
                "found": result.found,
                "value": value,
                "state": state.as_str(),
                "detail": detail,
            }));
            interpreted.push((state, detail));
        }
        let (state, detail) = interpret_entry(entry, &interpreted);
        states.push(json!({
            "id": entry.get("id").cloned().unwrap_or(Value::Null),
            "state": state.as_str(),
            "detail": detail,
            "reads": read_descriptors,
        }));
    }
    Ok(json!({"entries": entries, "states": states}))
}
