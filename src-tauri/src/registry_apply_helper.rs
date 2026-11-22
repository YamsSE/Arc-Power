//! Strict elevated helper handoff for registry apply.
//!
//! The unelevated host launches only its own executable. The helper receives
//! a one-use private pipe identity, independently validates the parent and
//! resolves only an entry ID/action through the embedded registry catalog.

use arc_power_tauri::backend::{registry_catalog, wire::{self, WireValue}};
use serde_json::{json, Value};
use std::time::Duration;
#[cfg(windows)]
use std::{sync::{Mutex, OnceLock}, time::Instant};

const HELPER_SWITCH: &str = "--registry-apply-helper";
const PIPE_PREFIX: &str = r"\\.\pipe\ArcPower-Tauri-";
const MAX_FRAME_BYTES: usize = 8 * 1024;
const HELPER_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const HELPER_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const APPLY_OVERALL_TIMEOUT: Duration = Duration::from_secs(180);
const APPLY_GRACE_TIMEOUT: Duration = Duration::from_secs(5);
const APPLY_MUTEX_NAME: &str = r"Global\ArcPower-Registry-Apply-v1";
const CANCEL_BYTE: u8 = 0x18;

#[cfg(windows)]
struct AuthenticatedParent {
    process: windows_sys::Win32::Foundation::HANDLE,
    token: windows_sys::Win32::Foundation::HANDLE,
    pid: u32,
    user_sid: String,
}

#[cfg(windows)]
impl AuthenticatedParent {
    fn is_live(&self) -> bool {
        use windows_sys::Win32::{Foundation::WAIT_TIMEOUT, System::Threading::WaitForSingleObject};
        unsafe { WaitForSingleObject(self.process, 0) == WAIT_TIMEOUT }
    }

    fn matches_pid(&self, expected_pid: u32) -> bool {
        use windows_sys::Win32::System::Threading::GetProcessId;
        self.pid == expected_pid && unsafe { GetProcessId(self.process) == expected_pid } && self.is_live()
    }
}

#[cfg(windows)]
impl Drop for AuthenticatedParent {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe {
            if !self.token.is_null() { CloseHandle(self.token); }
            if !self.process.is_null() { CloseHandle(self.process); }
        }
    }
}

#[cfg(windows)]
struct UserHiveHandle(windows_sys::Win32::System::Registry::HKEY);

#[cfg(windows)]
impl Drop for UserHiveHandle {
    fn drop(&mut self) {
        use windows_sys::Win32::System::Registry::RegCloseKey;
        unsafe { RegCloseKey(self.0); }
    }
}

#[derive(Clone)]
struct HelperArgs {
    pipe: String,
    parent_pid: u32,
}

fn is_helper_option(value: &str) -> bool {
    value.starts_with(HELPER_SWITCH)
}

fn valid_pipe_path(path: &str) -> bool {
    let Some(suffix) = path.strip_prefix(PIPE_PREFIX) else { return false; };
    suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn parse_helper_args(args: &[String]) -> Result<Option<HelperArgs>, String> {
    if !args.iter().any(|value| is_helper_option(value)) { return Ok(None); }
    if args.len() != 3 || args[0] != HELPER_SWITCH {
        return Err("Invalid registry apply helper arguments".into());
    }
    let pipe = args[1].strip_prefix("--pipe=")
        .filter(|pipe| valid_pipe_path(pipe))
        .ok_or("Invalid registry apply helper pipe")?;
    let pid_text = args[2].strip_prefix("--parent-pid=")
        .filter(|pid| !pid.is_empty() && pid.bytes().all(|byte| byte.is_ascii_digit()))
        .ok_or("Invalid registry apply helper parent PID")?;
    let parent_pid = pid_text.parse::<u32>().ok().filter(|pid| *pid != 0)
        .ok_or("Invalid registry apply helper parent PID")?;
    Ok(Some(HelperArgs { pipe: pipe.to_owned(), parent_pid }))
}

/// Called before installer, relaunch, boot-apply, mock and WebView startup.
/// Any malformed attempt to select helper mode is rejected as helper input.
pub fn run_if_requested(args: &[String]) -> Result<bool, String> {
    let Some(helper) = parse_helper_args(args)? else { return Ok(false); };
    #[cfg(windows)]
    run_helper(&helper)?;
    #[cfg(not(windows))]
    return Err("Registry apply helper requires Windows".into());
    Ok(true)
}

/// Parent-side entry used by the already-authorized Tauri bridge dispatch.
/// It returns the same tagged result shape as the Electron channel.
pub fn launch(encoded_args: &Value) -> Result<Value, String> {
    let (entry_id, action) = decode_apply_args(encoded_args)?;
    let timeout_result = registry_catalog::helper_start_timeout_result(&entry_id, &action)?;
    #[cfg(windows)]
    {
        let result = launch_helper(&entry_id, &action, timeout_result)?;
        wire::encode_json(&result)
    }
    #[cfg(not(windows))]
    {
        let _ = timeout_result;
        Err("Registry apply helper requires Windows".into())
    }
}

fn decode_apply_args(encoded_args: &Value) -> Result<(String, String), String> {
    let WireValue::Array(args) = wire::decode(encoded_args)? else {
        return Err("registry-apply expects an argument array".into());
    };
    let entry_id = match args.first() {
        Some(WireValue::String(value)) if !value.is_empty() => value.clone(),
        _ => return Err("registry-apply: entryId must be a non-empty string".into()),
    };
    let action = match args.get(1) {
        Some(WireValue::String(value)) if matches!(value.as_str(), "enable" | "disable" | "revert") => value.clone(),
        _ => return Err("registry-apply: action must be one of enable, disable, revert".into()),
    };
    // Validate unknown and read-only IDs before opening UAC. The helper will
    // independently resolve the same ID/action after authenticating the pipe.
    registry_catalog::plan_apply(&json!(entry_id), &json!(action))?;
    Ok((entry_id, action))
}

fn no_run_result(entry_id: &str, action: &str, message: &str) -> Result<Value, String> {
    registry_catalog::stopped_apply_result(entry_id, action, message)
}

fn indeterminate_result(entry_id: &str, action: &str, detail: &str) -> Result<Value, String> {
    let message = format!("{} {detail}", registry_catalog::REG_APPLY_INDETERMINATE_ERROR);
    registry_catalog::indeterminate_apply_result(entry_id, action, &message)
}

fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    let Some(object) = value.as_object() else { return false; };
    object.len() == keys.len() && object.keys().all(|key| keys.contains(&key.as_str()))
}

fn frame_bytes(value: &Value) -> Result<Vec<u8>, String> {
    let payload = serde_json::to_vec(value).map_err(|_| "Cannot encode registry helper frame".to_owned())?;
    if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
        return Err("Registry helper frame exceeds its size limit".into());
    }
    let mut frame = Vec::with_capacity(payload.len() + 4);
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

#[cfg(windows)]
fn token_user_sid(token: windows_sys::Win32::Foundation::HANDLE) -> Result<String, String> {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{Authorization::ConvertSidToStringSidW, GetTokenInformation, TokenUser, TOKEN_USER},
    };
    unsafe {
        let mut length = 0;
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut length);
        if length == 0 || length > 64 * 1024 { return Err("Invalid authenticated parent token size".into()); }
        // usize-backed allocation guarantees TOKEN_USER alignment.
        let mut buffer = vec![0usize; (length as usize + std::mem::size_of::<usize>() - 1) / std::mem::size_of::<usize>()];
        if GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), length, &mut length) == 0 {
            return Err(format!("Cannot read authenticated parent TokenUser: {}", std::io::Error::last_os_error()));
        }
        let user = &*(buffer.as_ptr().cast::<TOKEN_USER>());
        let mut string_sid = ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut string_sid) == 0 {
            return Err(format!("Cannot format authenticated parent TokenUser SID: {}", std::io::Error::last_os_error()));
        }
        let mut sid_length = 0;
        while *string_sid.add(sid_length) != 0 { sid_length += 1; }
        let value = String::from_utf16(std::slice::from_raw_parts(string_sid, sid_length))
            .map_err(|_| "Authenticated parent SID has invalid encoding".to_owned());
        LocalFree(string_sid.cast());
        let sid = value?;
        if !registry_catalog::is_valid_user_sid(&sid) {
            return Err("Authenticated parent TokenUser SID is invalid".into());
        }
        Ok(sid)
    }
}

#[cfg(windows)]
fn authenticated_parent(parent_pid: u32, own_exe: &std::path::Path) -> Result<AuthenticatedParent, String> {
    use std::{path::PathBuf, ptr};
    use windows_sys::Win32::{
        Storage::FileSystem::SYNCHRONIZE,
        Security::{TOKEN_QUERY},
        System::Threading::{GetProcessId, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, parent_pid) };
    if process.is_null() {
        return Err(format!("Registry helper parent is not live: {}", std::io::Error::last_os_error()));
    }
    let mut parent = AuthenticatedParent { process, token: ptr::null_mut(), pid: parent_pid, user_sid: String::new() };
    if !parent.is_live() { return Err("Registry helper parent exited before authentication".into()); }
    if unsafe { GetProcessId(parent.process) } != parent_pid {
        return Err("Registry helper parent process ID changed during authentication".into());
    }

    unsafe {
        let mut image = vec![0u16; 32768];
        let mut length = image.len() as u32;
        if QueryFullProcessImageNameW(parent.process, 0, image.as_mut_ptr(), &mut length) == 0 {
            return Err(format!("Cannot verify registry helper parent image: {}", std::io::Error::last_os_error()));
        }
        let parent_text = String::from_utf16(&image[..length as usize])
            .map_err(|_| "Registry helper parent image has invalid encoding")?;
        let parent_image = dunce::canonicalize(PathBuf::from(parent_text))
            .map_err(|error| format!("Cannot canonicalize registry helper parent image: {error}"))?;
        let own_image = dunce::canonicalize(own_exe)
            .map_err(|error| format!("Cannot canonicalize registry helper image: {error}"))?;
        if !parent_image.to_string_lossy().eq_ignore_ascii_case(&own_image.to_string_lossy()) {
            return Err("Registry helper parent image does not match the helper".into());
        }

        if OpenProcessToken(parent.process, TOKEN_QUERY, &mut parent.token) == 0 {
            return Err(format!("Cannot open authenticated parent process token: {}", std::io::Error::last_os_error()));
        }
        parent.user_sid = token_user_sid(parent.token)?;
    }
    if !parent.is_live() { return Err("Registry helper parent exited during authentication".into()); }
    Ok(parent)
}

#[cfg(windows)]
fn open_authenticated_user_hive(user_sid: &str) -> Result<UserHiveHandle, String> {
    use std::ptr;
    use windows_sys::Win32::System::Registry::{RegOpenKeyExW, HKEY_USERS, KEY_CREATE_SUB_KEY, KEY_READ, KEY_SET_VALUE};
    if !registry_catalog::is_valid_user_sid(user_sid) {
        return Err("Cannot verify original user's registry hive: invalid parent SID".into());
    }
    let sid: Vec<u16> = user_sid.encode_utf16().chain(Some(0)).collect();
    let mut hive = ptr::null_mut();
    // This exact existing SID root is opened with the rights required for its
    // catalog subkeys and held before any action step. The executor will open
    // the same root through winreg and use only relative subpaths.
    let status = unsafe { RegOpenKeyExW(HKEY_USERS, sid.as_ptr(), 0, KEY_READ | KEY_CREATE_SUB_KEY | KEY_SET_VALUE, &mut hive) };
    if status != 0 {
        return Err(format!("Cannot open authenticated parent registry hive HKEY_USERS\\{user_sid}: {}", std::io::Error::from_raw_os_error(status as i32)));
    }
    if hive.is_null() { return Err("Authenticated parent registry hive returned an invalid handle".into()); }
    Ok(UserHiveHandle(hive))
}

#[cfg(windows)]
struct ApplyMutexGuard {
    handle: windows_sys::Win32::Foundation::HANDLE,
    owned: bool,
}

#[cfg(windows)]
enum ApplyMutexWait {
    Acquired(ApplyMutexGuard),
    Abandoned(ApplyMutexGuard),
    Canceled,
}

#[cfg(windows)]
impl Drop for ApplyMutexGuard {
    fn drop(&mut self) {
        use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::ReleaseMutex};
        unsafe {
            if self.owned { ReleaseMutex(self.handle); }
            if !self.handle.is_null() { CloseHandle(self.handle); }
        }
    }
}

#[cfg(windows)]
fn create_apply_mutex(user_sid: &str) -> Result<ApplyMutexGuard, String> {
    use std::{ffi::c_void, ptr};
    use windows_sys::Win32::{
        Foundation::{GetLastError, LocalFree},
        Security::{Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1}, SECURITY_ATTRIBUTES},
        System::Threading::CreateMutexW,
    };
    let sddl = format!("D:P(A;;GA;;;{user_sid})(A;;GA;;;BA)(A;;GA;;;SY)");
    let sddl: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    let name: Vec<u16> = APPLY_MUTEX_NAME.encode_utf16().chain(Some(0)).collect();
    unsafe {
        let mut descriptor: *mut c_void = ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, ptr::null_mut()) == 0 {
            return Err(format!("Cannot create registry apply mutex security descriptor: {}", std::io::Error::last_os_error()));
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let handle = CreateMutexW(&attributes, 0, name.as_ptr());
        let error = if handle.is_null() { Some(GetLastError()) } else { None };
        LocalFree(descriptor);
        if let Some(error) = error {
            return Err(format!("Cannot open cross-process registry apply mutex: {}", std::io::Error::from_raw_os_error(error as i32)));
        }
        Ok(ApplyMutexGuard { handle, owned: false })
    }
}

#[cfg(windows)]
fn acquire_apply_mutex(
    user_sid: &str,
    parent: &AuthenticatedParent,
    pipe: &mut crate::transport::PipeStream,
) -> Result<ApplyMutexWait, String> {
    use windows_sys::Win32::{
        Foundation::{GetLastError, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::Threading::WaitForSingleObject,
    };
    let mut guard = create_apply_mutex(user_sid)?;
    loop {
        let waited = unsafe { WaitForSingleObject(guard.handle, 50) };
        if waited == WAIT_OBJECT_0 {
            guard.owned = true;
            return Ok(ApplyMutexWait::Acquired(guard));
        }
        if waited == WAIT_ABANDONED {
            guard.owned = true;
            return Ok(ApplyMutexWait::Abandoned(guard));
        }
        if waited != WAIT_TIMEOUT {
            let error = unsafe { GetLastError() };
            return Err(format!("Cannot wait for cross-process registry apply mutex: {}", std::io::Error::from_raw_os_error(error as i32)));
        }
        if !parent.is_live() { return Ok(ApplyMutexWait::Canceled); }
        let mut control = [0u8; 1];
        match pipe.read_with_timeout(&mut control, Duration::ZERO) {
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {}
            _ => return Ok(ApplyMutexWait::Canceled),
        }
    }
}

#[cfg(windows)]
fn write_all_until(pipe: &mut crate::transport::PipeStream, bytes: &[u8], deadline: Instant) -> std::io::Result<()> {
    let mut offset = 0usize;
    while offset < bytes.len() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "Registry helper pipe write timed out"));
        }
        match pipe.write_with_timeout(&bytes[offset..], remaining)? {
            0 => return Err(std::io::Error::new(std::io::ErrorKind::WriteZero, "Registry helper pipe closed during write")),
            written => offset += written,
        }
    }
    Ok(())
}

#[cfg(windows)]
fn write_frame(pipe: &mut crate::transport::PipeStream, value: &Value, timeout: Duration) -> Result<(), String> {
    let frame = frame_bytes(value)?;
    let deadline = Instant::now() + timeout;
    write_all_until(pipe, &frame, deadline).map_err(|error| format!("Registry helper pipe write failed: {error}"))
}

#[cfg(windows)]
#[derive(Default)]
struct FrameReader {
    header: [u8; 4],
    header_len: usize,
    payload: Vec<u8>,
    payload_len: Option<usize>,
    payload_read: usize,
}

#[cfg(windows)]
impl FrameReader {
    fn read_frame(&mut self, pipe: &mut crate::transport::PipeStream, timeout: Duration) -> std::io::Result<Value> {
        let deadline = Instant::now() + timeout;
        while self.header_len < self.header.len() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "Registry helper frame timed out"));
            }
            let read = pipe.read_with_timeout(&mut self.header[self.header_len..], remaining)?;
            if read == 0 { return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "Registry helper pipe closed")); }
            self.header_len += read;
        }
        if self.payload_len.is_none() {
            let length = u32::from_be_bytes(self.header) as usize;
            if length == 0 || length > MAX_FRAME_BYTES {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "Invalid registry helper frame length"));
            }
            self.payload_len = Some(length);
            self.payload = vec![0; length];
        }
        let length = self.payload_len.unwrap();
        while self.payload_read < length {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "Registry helper frame timed out"));
            }
            let read = pipe.read_with_timeout(&mut self.payload[self.payload_read..], remaining)?;
            if read == 0 { return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "Registry helper pipe closed")); }
            self.payload_read += read;
        }
        let value = serde_json::from_slice(&self.payload)
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "Invalid registry helper frame JSON"))?;
        *self = Self::default();
        Ok(value)
    }
}

fn validate_result(result: &Value, template: &Value) -> Result<(), String> {
    let has_timed_out = exact_keys(result, &["ok", "canceled", "message", "perStep", "timedOut"]);
    if (!has_timed_out && !exact_keys(result, &["ok", "canceled", "message", "perStep"]))
        || !result["ok"].is_boolean() || !result["canceled"].is_boolean()
        || !result["message"].is_string()
        || (has_timed_out && !result["timedOut"].is_boolean()) {
        return Err("Registry helper returned an invalid apply result".into());
    }
    let expected = template["perStep"].as_array().ok_or("Invalid local registry plan")?;
    let actual = result["perStep"].as_array().ok_or("Registry helper returned an invalid step list")?;
    if actual.len() != expected.len() { return Err("Registry helper returned an invalid step count".into()); }
    let mut all_done = true;
    let mut failed_seen = false;
    let mut not_run_seen = false;
    for (index, (step, expected_step)) in actual.iter().zip(expected).enumerate() {
        if !exact_keys(step, &["step", "ok", "status", "label"])
            || step["step"].as_u64() != Some(index as u64)
            || step["label"] != expected_step["label"]
            || !step["ok"].is_boolean()
            || !matches!(step["status"].as_str(), Some("done" | "failed" | "not-run")) {
            return Err("Registry helper returned an invalid step result".into());
        }
        let status = step["status"].as_str().unwrap();
        let ok = status == "done";
        if step["ok"] != Value::Bool(ok) { return Err("Registry helper returned contradictory step status".into()); }
        match status {
            "done" if !failed_seen && !not_run_seen => {}
            "failed" if !failed_seen && !not_run_seen => { failed_seen = true; all_done = false; }
            "not-run" => { not_run_seen = true; all_done = false; }
            _ => return Err("Registry helper returned an out-of-order step result".into()),
        }
    }
    let canceled = result["canceled"].as_bool().unwrap_or(false);
    let no_steps_ran = actual.iter().all(|step| step["status"] == "not-run");
    let timed_out = has_timed_out && result["timedOut"] == Value::Bool(true);
    if has_timed_out && ((timed_out && canceled && (!not_run_seen || failed_seen))
        || (timed_out && !canceled && !no_steps_ran)
        || (!timed_out && canceled)) {
        return Err("Registry helper returned a contradictory timeout state".into());
    }
    let proven_no_write_timeout = timed_out && !canceled && no_steps_ran;
    if (canceled && (!not_run_seen || failed_seen))
        || (!canceled && not_run_seen && !failed_seen && !proven_no_write_timeout) {
        return Err("Registry helper returned a contradictory cancellation state".into());
    }
    if result["ok"] != Value::Bool(all_done) { return Err("Registry helper returned a contradictory apply status".into()); }
    Ok(())
}

#[cfg(windows)]
fn launch_helper(entry_id: &str, action: &str, timeout_result: Value) -> Result<Value, String> {
    use crate::transport::PipeServer;
    use std::sync::mpsc;

    let reservation = reserve_helper_slot()?;
    let server = PipeServer::create()?;
    let pipe_path = server.path().to_owned();
    let parent_pid = std::process::id();
    let executable = std::env::current_exe().map_err(|error| format!("Cannot locate Arc Power helper image: {error}"))?;
    let helper_args = vec![
        HELPER_SWITCH.to_owned(),
        format!("--pipe={pipe_path}"),
        format!("--parent-pid={parent_pid}"),
    ];
    let parameters = helper_args.join(" ");
    let already_elevated = current_process_is_elevated()?;
    let deadline = Instant::now() + APPLY_OVERALL_TIMEOUT;
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let result = if already_elevated {
            spawn_helper_direct(&executable, &helper_args)
        } else {
            shell_execute_helper(&executable, &parameters)
        };
        let _ = sender.send(result);
    });

    let (launched_pid, monitor_handle) = match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(Ok((pid, handle))) => {
            let monitor = reservation.track(pid, handle)?;
            (pid, monitor)
        }
        Ok(Err(ShellLaunchError::Canceled)) => {
            drop(server);
            return no_run_result(entry_id, action, registry_catalog::REG_APPLY_CANCELED_ERROR);
        }
        Ok(Err(ShellLaunchError::Failed(error))) => {
            drop(server);
            return Err(error);
        }
        Ok(Err(ShellLaunchError::StartedUnidentified { message, handle })) => {
            drop(server);
            if let Some(handle) = handle { reservation.track(0, handle)?; }
            else { reservation.mark_unknown()?; }
            return Err(message);
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            drop(server); // revoke the pipe before a late UAC approval can connect
            let _ = receiver.recv_timeout(APPLY_GRACE_TIMEOUT);
            return Ok(timeout_result);
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            drop(server);
            return Err("Registry helper launcher stopped before reporting its process".into());
        }
    };

    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        drop(server);
        let _ = receiver.recv_timeout(APPLY_GRACE_TIMEOUT);
        return Ok(timeout_result);
    }
    let mut pipe = match server.accept_while(launched_pid, remaining, || monitor_handle.is_running()) {
        Ok(pipe) => pipe,
        Err(error) if error.contains("timed out") => return Ok(timeout_result),
        Err(error) if error.contains("canceled") && monitor_handle.exited() => {
            return Err("Registry helper exited before connecting to its authenticated pipe".into());
        }
        Err(error) if error.contains("canceled") && !monitor_handle.is_running() => {
            return Err("Cannot verify that the registry helper stayed live during pipe authentication".into());
        }
        Err(error) => return Err(format!("Registry helper pipe authentication failed: {error}")),
    };

    let request = json!({"version": 1, "kind": "registry-apply-request", "entryId": entry_id, "action": action});
    let frame = frame_bytes(&request)?;
    let request_timeout = deadline.saturating_duration_since(Instant::now());
    if request_timeout.is_zero() { return Ok(timeout_result); }
    if let Err(error) = write_all_until(&mut pipe, &frame, deadline) {
        return indeterminate_result(entry_id, action, &format!("Request delivery failed: {error}"));
    }
    let mut reader = FrameReader::default();
    let response = match reader.read_frame(&mut pipe, deadline.saturating_duration_since(Instant::now())) {
        Ok(response) => response,
        Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {
            let grace_deadline = Instant::now() + APPLY_GRACE_TIMEOUT;
            let _ = pipe.write_all_with_timeout(&[CANCEL_BYTE], grace_deadline.saturating_duration_since(Instant::now()));
            match reader.read_frame(&mut pipe, grace_deadline.saturating_duration_since(Instant::now())) {
                Ok(response) => response,
                Err(error) => return indeterminate_result(entry_id, action, &format!("No complete helper response arrived: {error}")),
            }
        }
        Err(error) => return indeterminate_result(entry_id, action, &format!("Helper response failed: {error}")),
    };
    match decode_response(response.clone(), &timeout_result) {
        Ok(result) => Ok(result),
        Err(error) if is_explicit_helper_error(&response) => Err(error),
        Err(error) => indeterminate_result(entry_id, action, &format!("Helper response could not be verified: {error}")),
    }
}

#[cfg(windows)]
fn is_explicit_helper_error(response: &Value) -> bool {
    response.get("version").and_then(Value::as_u64) == Some(1)
        && response.get("kind").and_then(Value::as_str) == Some("registry-apply-error")
        && exact_keys(response, &["version", "kind", "message"])
        && response.get("message").is_some_and(Value::is_string)
}

#[cfg(windows)]
fn decode_response(response: Value, template: &Value) -> Result<Value, String> {
    if response.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("Registry helper protocol version mismatch".into());
    }
    match response.get("kind").and_then(Value::as_str) {
        Some("registry-apply-result") if exact_keys(&response, &["version", "kind", "result"]) => {
            let result = response.get("result").ok_or("Registry helper omitted its result")?;
            validate_result(result, template)?;
            Ok(result.clone())
        }
        Some("registry-apply-error") if exact_keys(&response, &["version", "kind", "message"]) => {
            Err(response.get("message").and_then(Value::as_str).unwrap_or("Registry helper rejected the request").to_owned())
        }
        _ => Err("Registry helper returned an invalid response frame".into()),
    }
}

#[cfg(windows)]
enum ShellLaunchError {
    Canceled,
    Failed(String),
    StartedUnidentified { message: String, handle: Option<HelperProcessHandle> },
}

#[cfg(windows)]
struct HelperProcessHandle(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for HelperProcessHandle {}
#[cfg(windows)]
impl HelperProcessHandle {
    fn exited(&self) -> bool {
        unsafe { windows_sys::Win32::System::Threading::WaitForSingleObject(self.0, 0)
            == windows_sys::Win32::Foundation::WAIT_OBJECT_0 }
    }

    fn is_running(&self) -> bool {
        unsafe { windows_sys::Win32::System::Threading::WaitForSingleObject(self.0, 0)
            == windows_sys::Win32::Foundation::WAIT_TIMEOUT }
    }

    fn duplicate(&self) -> Result<Self, String> {
        use std::ptr;
        use windows_sys::Win32::{
            Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS},
            System::Threading::GetCurrentProcess,
        };
        unsafe {
            let process = GetCurrentProcess();
            let mut duplicate = ptr::null_mut();
            if DuplicateHandle(process, self.0, process, &mut duplicate, 0, 0, DUPLICATE_SAME_ACCESS) == 0 {
                return Err(format!("Cannot duplicate registry helper process handle: {}", std::io::Error::last_os_error()));
            }
            Ok(Self(duplicate))
        }
    }
}
#[cfg(windows)]
impl Drop for HelperProcessHandle {
    fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0); } }
}

#[cfg(windows)]
struct TrackedHelper { _pid: u32, handle: HelperProcessHandle }
#[cfg(windows)]
#[derive(Default)]
struct HelperFenceState { reserved: bool, unknown_active: bool, active: Vec<TrackedHelper> }
#[cfg(windows)]
static HELPER_FENCE: OnceLock<Mutex<HelperFenceState>> = OnceLock::new();

#[cfg(windows)]
struct HelperReservation;
#[cfg(windows)]
impl HelperReservation {
    fn track(&self, pid: u32, handle: HelperProcessHandle) -> Result<HelperProcessHandle, String> {
        let monitor = handle.duplicate()?;
        let state = HELPER_FENCE.get_or_init(|| Mutex::new(HelperFenceState::default()));
        let mut state = state.lock().map_err(|_| "Registry helper fence is unavailable".to_owned())?;
        if !handle.exited() { state.active.push(TrackedHelper { _pid: pid, handle }); }
        Ok(monitor)
    }
    fn mark_unknown(&self) -> Result<(), String> {
        let state = HELPER_FENCE.get_or_init(|| Mutex::new(HelperFenceState::default()));
        state.lock().map_err(|_| "Registry helper fence is unavailable".to_owned())?.unknown_active = true;
        Ok(())
    }
}
#[cfg(windows)]
impl Drop for HelperReservation {
    fn drop(&mut self) {
        if let Some(state) = HELPER_FENCE.get() {
            if let Ok(mut state) = state.lock() { state.reserved = false; }
        }
    }
}

#[cfg(windows)]
fn reserve_helper_slot() -> Result<HelperReservation, String> {
    let state = HELPER_FENCE.get_or_init(|| Mutex::new(HelperFenceState::default()));
    let mut state = state.lock().map_err(|_| "Registry helper fence is unavailable".to_owned())?;
    state.active.retain(|helper| !helper.handle.exited());
    if state.reserved || state.unknown_active || !state.active.is_empty() {
        return Err("A previous registry apply helper is still active; wait before retrying.".into());
    }
    state.reserved = true;
    Ok(HelperReservation)
}

#[cfg(windows)]
fn current_process_is_elevated() -> Result<bool, String> {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    unsafe {
        let mut token = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(format!("Cannot inspect Arc Power elevation: {}", std::io::Error::last_os_error()));
        }
        let result = (|| {
            let mut elevation: TOKEN_ELEVATION = std::mem::zeroed();
            let mut returned = 0;
            if GetTokenInformation(token, TokenElevation, (&mut elevation as *mut TOKEN_ELEVATION).cast(),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32, &mut returned) == 0 {
                return Err(format!("Cannot determine Arc Power elevation: {}", std::io::Error::last_os_error()));
            }
            Ok(elevation.TokenIsElevated != 0)
        })();
        CloseHandle(token);
        result
    }
}

#[cfg(windows)]
fn spawn_helper_direct(executable: &std::path::Path, helper_args: &[String]) -> Result<(u32, HelperProcessHandle), ShellLaunchError> {
    use std::{os::windows::{io::AsRawHandle, process::CommandExt}, process::{Command, Stdio}};
    use windows_sys::Win32::{
        Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS},
        Storage::FileSystem::SYNCHRONIZE,
        System::Threading::{GetCurrentProcess, OpenProcess, CREATE_NO_WINDOW, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    let child = Command::new(executable)
        .args(helper_args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| ShellLaunchError::Failed(format!("Cannot start elevated registry helper: {error}")))?;
    let pid = child.id();
    unsafe {
        let process = GetCurrentProcess();
        let mut handle = std::ptr::null_mut();
        if DuplicateHandle(process, child.as_raw_handle(), process, &mut handle, 0, 0, DUPLICATE_SAME_ACCESS) == 0 {
            let duplicate_error = std::io::Error::last_os_error();
            let opened = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid);
            if !opened.is_null() { return Ok((pid, HelperProcessHandle(opened))); }
            return Err(ShellLaunchError::StartedUnidentified {
                message: format!("Elevated registry helper started but its process handle could not be retained: {duplicate_error}"),
                handle: None,
            });
        }
        Ok((pid, HelperProcessHandle(handle)))
    }
}

#[cfg(windows)]
fn shell_execute_helper(executable: &std::path::Path, parameters: &str) -> Result<(u32, HelperProcessHandle), ShellLaunchError> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::{
        Foundation::{GetLastError, ERROR_CANCELLED},
        UI::{Shell::{ShellExecuteExW, SHELLEXECUTEINFOW, SEE_MASK_NOCLOSEPROCESS}, WindowsAndMessaging::SW_HIDE},
        System::Threading::GetProcessId,
    };
    let verb: Vec<u16> = OsStr::new("runas").encode_wide().chain(Some(0)).collect();
    let file: Vec<u16> = executable.as_os_str().encode_wide().chain(Some(0)).collect();
    let parameters: Vec<u16> = OsStr::new(parameters).encode_wide().chain(Some(0)).collect();
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = parameters.as_ptr();
    info.nShow = SW_HIDE;
    let started = unsafe { ShellExecuteExW(&mut info) };
    if started == 0 {
        let error = unsafe { GetLastError() };
        if !info.hProcess.is_null() {
            return Err(ShellLaunchError::StartedUnidentified {
                message: format!("Registry helper launch returned an unexpected process handle: {}", std::io::Error::from_raw_os_error(error as i32)),
                handle: Some(HelperProcessHandle(info.hProcess)),
            });
        }
        if error == ERROR_CANCELLED { return Err(ShellLaunchError::Canceled); }
        return Err(ShellLaunchError::Failed(format!("Cannot launch elevated registry helper: {}", std::io::Error::from_raw_os_error(error as i32))));
    }
    if info.hProcess.is_null() {
        return Err(ShellLaunchError::StartedUnidentified {
            message: "Elevated registry helper started without a process handle".into(),
            handle: None,
        });
    }
    let pid = unsafe { GetProcessId(info.hProcess) };
    let handle = HelperProcessHandle(info.hProcess);
    if pid == 0 {
        return Err(ShellLaunchError::StartedUnidentified {
            message: "Cannot identify elevated registry helper process".into(),
            handle: Some(handle),
        });
    }
    Ok((pid, handle))
}

#[cfg(windows)]
fn run_helper(args: &HelperArgs) -> Result<(), String> {
    use crate::transport::PipeClient;
    use std::{io, ptr};
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };

    fn check_elevated_token() -> Result<(), String> {
        unsafe {
            let mut token = ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(format!("Cannot inspect elevated helper token: {}", io::Error::last_os_error()));
            }
            let mut elevation: TOKEN_ELEVATION = std::mem::zeroed();
            let mut returned = 0;
            let ok = GetTokenInformation(token, TokenElevation, (&mut elevation as *mut TOKEN_ELEVATION).cast(),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32, &mut returned);
            CloseHandle(token);
            if ok == 0 { return Err(format!("Cannot verify elevated helper token: {}", io::Error::last_os_error())); }
            if elevation.TokenIsElevated == 0 { return Err("Registry helper requires an elevated token".into()); }
            Ok(())
        }
    }

    fn exact_keys(value: &Value, keys: &[&str]) -> bool {
        let Some(object) = value.as_object() else { return false; };
        object.len() == keys.len() && object.keys().all(|key| keys.contains(&key.as_str()))
    }

    check_elevated_token()?;
    let own_exe = std::env::current_exe().map_err(|error| format!("Cannot locate registry helper image: {error}"))?;
    // Pin the PID's process object before connecting. PipeClient checks that
    // the server PID equals this expected PID; this held handle plus the live
    // recheck below prevents PID reuse from substituting another process.
    let parent = authenticated_parent(args.parent_pid, &own_exe)?;
    let mut pipe = PipeClient::connect(&args.pipe, args.parent_pid, HELPER_CONNECT_TIMEOUT)?;
    if !parent.matches_pid(args.parent_pid) {
        return send_error(&mut pipe, "Authenticated registry apply parent exited or changed during pipe connection");
    }
    // The parent SID came from the pinned process's primary token. No SID or
    // user path is accepted from the request frame.

    let mut reader = FrameReader::default();
    let request = reader.read_frame(&mut pipe, HELPER_REQUEST_TIMEOUT)
        .map_err(|error| format!("Registry helper request failed: {error}"))?;
    if !exact_keys(&request, &["version", "kind", "entryId", "action"])
        || request["version"].as_u64() != Some(1)
        || request["kind"] != "registry-apply-request" {
        return send_error(&mut pipe, "Invalid registry helper request");
    }
    let Some(entry_id) = request["entryId"].as_str().filter(|value| !value.is_empty()) else {
        return send_error(&mut pipe, "registry-apply: entryId must be a non-empty string");
    };
    let Some(action) = request["action"].as_str().filter(|value| matches!(*value, "enable" | "disable" | "revert")) else {
        return send_error(&mut pipe, "registry-apply: action must be one of enable, disable, revert");
    };

    // Inspect the fully validated embedded plan first. Machine-only actions
    // do not require the caller's hive; mixed MPO plans must open and pin it
    // before their first HKLM step so they cannot partially apply.
    let needs_user_hive = match registry_catalog::apply_plan_uses_authenticated_user_hive(entry_id, action, &parent.user_sid) {
        Ok(needs_user_hive) => needs_user_hive,
        Err(error) => return send_error(&mut pipe, &error),
    };
    let _user_hive = if needs_user_hive {
        match open_authenticated_user_hive(&parent.user_sid) {
            Ok(hive) => Some(hive),
            Err(error) => return send_error(&mut pipe, &error),
        }
    } else {
        None
    };

    // This global mutex serializes helpers from separate Tauri host processes.
    // An abandoned owner may have stopped between multi-step writes, so report
    // the indeterminate state and do not start another plan in this helper.
    let _apply_mutex = match acquire_apply_mutex(&parent.user_sid, &parent, &mut pipe) {
        Ok(ApplyMutexWait::Acquired(mutex)) => mutex,
        Ok(ApplyMutexWait::Abandoned(mutex)) => {
            let response = send_error(&mut pipe, "A previous registry apply ended unexpectedly; its write state is indeterminate. Refresh the registry state before retrying or using Revert.");
            drop(mutex);
            return response;
        }
        Ok(ApplyMutexWait::Canceled) => {
            let result = registry_catalog::not_run_timeout_result(
                entry_id,
                action,
                "The apply timed out before acquiring the registry mutex; no steps ran in this operation. Refresh registry state before retrying.",
            )?;
            return write_frame(&mut pipe, &json!({"version":1,"kind":"registry-apply-result","result":result}), Duration::from_secs(5));
        }
        Err(error) => return send_error(&mut pipe, &error),
    };

    let result = registry_catalog::execute_apply_with_user_hive(entry_id, action, &parent.user_sid, || {
        if !parent.is_live() { return registry_catalog::ApplyLease::Stop; }
        let mut control = [0u8; 1];
        match pipe.read_with_timeout(&mut control, Duration::ZERO) {
            Ok(0) => registry_catalog::ApplyLease::Stop,
            Ok(1) if control[0] == CANCEL_BYTE => registry_catalog::ApplyLease::Stop,
            Ok(_) => registry_catalog::ApplyLease::Stop,
            Err(error) if error.kind() == io::ErrorKind::TimedOut => registry_catalog::ApplyLease::Continue,
            Err(_) => registry_catalog::ApplyLease::Stop,
        }
    });
    match result {
        Ok(result) => write_frame(&mut pipe, &json!({"version":1,"kind":"registry-apply-result","result":result}), Duration::from_secs(5)),
        Err(error) => send_error(&mut pipe, &error),
    }
}

#[cfg(windows)]
fn send_error(pipe: &mut crate::transport::PipeStream, message: &str) -> Result<(), String> {
    write_frame(pipe, &json!({"version":1,"kind":"registry-apply-error","message":message}), Duration::from_secs(5))
}

#[cfg(not(windows))]
fn run_helper(_args: &HelperArgs) -> Result<(), String> { Err("Registry apply helper requires Windows".into()) }

#[cfg(test)]
mod tests {
    use super::{no_run_result, parse_helper_args, validate_result, HELPER_SWITCH};
    use arc_power_tauri::backend::registry_catalog;

    #[test]
    fn parses_only_fixed_helper_pipe_and_parent_identity() {
        let args = vec![
            HELPER_SWITCH.to_owned(),
            r"--pipe=\\.\pipe\ArcPower-Tauri-0123456789abcdef0123456789abcdef".to_owned(),
            "--parent-pid=1234".to_owned(),
        ];
        let parsed = parse_helper_args(&args).unwrap().unwrap();
        assert_eq!(parsed.parent_pid, 1234);
        assert_eq!(parsed.pipe, r"\\.\pipe\ArcPower-Tauri-0123456789abcdef0123456789abcdef");
    }

    #[test]
    fn rejects_malformed_helper_identity_without_opening_a_pipe() {
        let args = vec![
            HELPER_SWITCH.to_owned(),
            r"--pipe=\\.\pipe\ArcPower-Tauri-../../../../".to_owned(),
            "--parent-pid=0".to_owned(),
        ];
        assert!(parse_helper_args(&args).is_err());
    }

    #[test]
    fn no_run_result_is_built_from_the_embedded_plan_only() {
        let result = no_run_result("mpo", "enable", "timeout").unwrap();
        assert_eq!(result["ok"], false);
        assert_eq!(result["canceled"], true);
        assert_eq!(result["message"], "timeout");
        assert_eq!(result["perStep"].as_array().unwrap().len(), 3);
        assert!(result["perStep"].as_array().unwrap().iter().all(|step| step["status"] == "not-run"));
    }

    #[test]
    fn validates_only_the_proven_no_write_timeout_shape() {
        let template = no_run_result("mpo", "enable", "template").unwrap();
        let result = registry_catalog::not_run_timeout_result("mpo", "enable", "lock timed out").unwrap();
        assert_eq!(result["canceled"], false);
        assert_eq!(result["timedOut"], true);
        assert!(result["perStep"].as_array().unwrap().iter().all(|step| step["status"] == "not-run"));
        assert!(validate_result(&result, &template).is_ok());

        let mut contradictory = result;
        contradictory["perStep"][0]["status"] = serde_json::Value::String("failed".into());
        contradictory["perStep"][0]["ok"] = serde_json::Value::Bool(false);
        assert!(validate_result(&contradictory, &template).is_err());
    }
}
