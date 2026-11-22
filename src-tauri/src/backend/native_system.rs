//! Direct, bounded read-only host commands. Registry discovery deliberately
//! retains driver-info.js's adapter-0000 semantics; this is a display class
//! date, not proof of the currently selected GPU's package identity.
use super::wire::{decode, encode_json, WireValue};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuildKind { Dev, Portable, Installed }

impl BuildKind {
    pub fn as_str(self) -> &'static str {
        match self { Self::Dev => "dev", Self::Portable => "portable", Self::Installed => "installed" }
    }
}

/// Build kind must come from the trusted host distribution context, never a
/// renderer payload. Mock sessions keep their injected driver fixture in the
/// compatibility service until that fixture service itself is migrated.
pub fn invoke(channel: &str, args: &Value, kind: BuildKind, mock_mode: bool) -> Option<Result<Value, String>> {
    match channel {
        "app:build-info" => Some(no_payload(channel, args).and_then(|_| encode_json(&json!({"kind":kind.as_str()})))),
        "driver-info" if !mock_mode => Some(no_payload(channel, args).and_then(|_| encode_json(&json!({"driverDate":driver_date()})))),
        _ => None,
    }
}

/// Distribution kind comes from trusted host context, matching build-kind.js:
/// mock sessions classify as portable, an unpackaged run is dev, a packaged
/// run with the portable wrapper marker is portable, otherwise it is installed.
pub fn build_kind(mock_mode: bool) -> BuildKind {
    if mock_mode { return BuildKind::Portable; }
    if cfg!(debug_assertions) { return BuildKind::Dev; }
    if std::env::var_os("PORTABLE_EXECUTABLE_FILE").is_some() { BuildKind::Portable } else { BuildKind::Installed }
}

/// The renderer may open only the Arc Power GitHub repository. This mirrors
/// ipc-core.js's parsed-URL checks and deliberately rejects string-prefix
/// lookalikes such as github.com.evil.example.
pub fn open_external_url(args: &Value) -> Result<String, String> {
    let WireValue::Array(args) = decode(args)? else { return Err("Expected argument array".into()); };
    if args.len() != 1 { return Err("open-external expects one URL argument".into()); }
    let WireValue::String(url) = &args[0] else { return Err("open-external: url must be a non-empty string".into()); };
    if url.is_empty() { return Err("open-external: url must be a non-empty string".into()); }
    let parsed = url::Url::parse(url).map_err(|_| "open-external: url is not a valid URL".to_owned())?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("github.com") {
        return Err("open-external: only https://github.com links are allowed".into());
    }
    let path = parsed.path();
    if path != "/YamsSE/Arc-Power" && !path.starts_with("/YamsSE/Arc-Power/") {
        return Err("open-external: only the Arc-Power repository is allowed".into());
    }
    Ok(parsed.to_string())
}

pub fn open_external(args: &Value) -> Result<(), String> {
    shell_open(&open_external_url(args)?)
}

pub fn open_path(path: &str) -> Result<(), String> { shell_open(path) }

#[cfg(windows)]
fn shell_open(target: &str) -> Result<(), String> {
    use std::ffi::c_void;
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(hwnd: *mut c_void, operation: *const u16, file: *const u16,
            parameters: *const u16, directory: *const u16, show: i32) -> *mut c_void;
    }
    let wide = |value: &str| value.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    let operation = wide("open");
    let file = wide(target);
    let result = unsafe { ShellExecuteW(std::ptr::null_mut(), operation.as_ptr(), file.as_ptr(),
        std::ptr::null(), std::ptr::null(), 1) };
    if (result as isize) <= 32 { Err("open-external: the system could not open the link".into()) } else { Ok(()) }
}

#[cfg(not(windows))]
fn shell_open(_target: &str) -> Result<(), String> { Err("open-external is only available on Windows".into()) }

fn no_payload(channel: &str, args: &Value) -> Result<(), String> {
    let WireValue::Array(args) = decode(args)? else { return Err("Expected argument array".into()); };
    if !args.is_empty() { return Err(format!("{channel} does not accept a payload")); }
    Ok(())
}

const MAX_DATE_UNITS: usize = 2048;

fn decode_driver_date(units: &[u16], byte_count: usize, registry_type: u32) -> Option<String> {
    // REG_SZ only. Do not accept a partial or unterminated buffer as a date.
    if registry_type != 1 || byte_count == 0 || byte_count % 2 != 0 || byte_count / 2 > units.len()
        || byte_count / 2 > MAX_DATE_UNITS { return None; }
    let units = &units[..byte_count / 2];
    let end = units.iter().position(|unit| *unit == 0)?;
    let text = String::from_utf16(&units[..end]).ok()?;
    // parseRegDriverDate extracts the first non-whitespace token after REG_SZ.
    text.split_whitespace().next().map(str::to_owned)
}

#[cfg(windows)]
pub fn driver_date() -> Option<String> {
    use std::ffi::c_void;
    // Declare only the one read API needed, avoiding a new runtime dependency
    // or an external reg.exe process. RegGetValueW closes its own subkey.
    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(key: *mut c_void, subkey: *const u16, value: *const u16,
            flags: u32, value_type: *mut u32, data: *mut c_void, byte_count: *mut u32) -> i32;
    }
    let key: Vec<u16> = "SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0000\0".encode_utf16().collect();
    let value: Vec<u16> = "DriverDate\0".encode_utf16().collect();
    let mut units = [0u16; MAX_DATE_UNITS];
    let mut byte_count = std::mem::size_of_val(&units) as u32;
    let mut value_type = 0;
    // HKEY_LOCAL_MACHINE is the sign-extended predefined handle 0x80000002.
    // RRF_RT_REG_SZ (2) excludes every other registry data type. A fixed-size
    // buffer bounds allocation; ERROR_MORE_DATA degrades to the existing null.
    let status = unsafe { RegGetValueW((-2147483646isize) as *mut c_void,
        key.as_ptr(), value.as_ptr(), 2, &mut value_type, units.as_mut_ptr().cast(), &mut byte_count) };
    if status != 0 { return None; }
    decode_driver_date(&units, byte_count as usize, value_type)
}

#[cfg(not(windows))]
pub fn driver_date() -> Option<String> { None }

#[cfg(test)]
mod tests {
    use super::*;
    fn empty() -> Value { json!({"t":"array","v":[]}) }

    #[test]
    fn build_info_preserves_all_distribution_shapes() {
        for kind in [BuildKind::Dev, BuildKind::Portable, BuildKind::Installed] {
            let reply = invoke("app:build-info", &empty(), kind, false).unwrap().unwrap();
            assert_eq!(decode(&reply).unwrap().into_json().unwrap(), json!({"kind":kind.as_str()}));
        }
    }

    #[test]
    fn native_system_claims_only_its_own_channels() {
        // Module-scope boundary only: `apply-settings` is native and owned by
        // `services::invoke`; `native_system::invoke` declining it is not an
        // ownership claim.
        for channel in ["driver-info", "app:build-info"] {
            for payload in [json!({"t":"null"}), json!({"t":"array","v":[{"t":"undefined"}]}), json!({"t":"array","v":[],"extra":true})] {
                assert!(invoke(channel, &payload, BuildKind::Dev, false).unwrap().is_err());
            }
        }
        assert!(invoke("driver-info", &empty(), BuildKind::Dev, true).is_none());
        assert!(invoke("apply-settings", &empty(), BuildKind::Dev, false).is_none());
    }

    #[test]
    fn registry_date_matches_first_token_and_rejects_invalid_buffers() {
        let units: Vec<u16> = " 7-5-2026 extra\0".encode_utf16().collect();
        assert_eq!(decode_driver_date(&units, units.len() * 2, 1).as_deref(), Some("7-5-2026"));
        for (data, bytes, kind) in [(vec![65], 2, 1), (vec![65, 0], 3, 1), (vec![65, 0], 4, 2),
            (vec![0], 2, 1), (vec![0xD800, 0], 4, 1), (vec![65, 0], 6, 1)] {
            assert!(decode_driver_date(&data, bytes, kind).is_none());
        }
    }

    #[cfg(windows)]
    #[test]
    fn live_registry_read_is_bounded_and_returns_existing_reply_shape() {
        // Date absence is a supported machine state; a successful read must
        // be one bounded token, and either outcome is encoded as date/null.
        if let Some(date) = driver_date() {
            assert!(!date.is_empty() && date.encode_utf16().count() < MAX_DATE_UNITS);
            assert!(!date.chars().any(char::is_whitespace));
        }
        let reply = invoke("driver-info", &empty(), BuildKind::Dev, false).unwrap().unwrap();
        let json = decode(&reply).unwrap().into_json().unwrap();
        assert!(json["driverDate"].is_string() || json["driverDate"].is_null());
    }

    #[test]
    fn build_kind_uses_trusted_host_context() {
        assert_eq!(build_kind(true), BuildKind::Portable);
        if cfg!(debug_assertions) { assert_eq!(build_kind(false), BuildKind::Dev); }
    }

    #[test]
    fn open_external_accepts_only_the_arc_power_repository() {
        let args = |value: &str| json!({"t":"array","v":[{"t":"string","v":value}]});
        for url in ["https://github.com/YamsSE/Arc-Power", "https://github.com/YamsSE/Arc-Power/",
            "https://github.com/YamsSE/Arc-Power/releases", "https://github.com/YamsSE/Arc-Power?tab=readme"] {
            assert!(open_external_url(&args(url)).is_ok(), "{url}");
        }
        for url in ["http://github.com/YamsSE/Arc-Power", "https://github.com.evil.example/YamsSE/Arc-Power",
            "https://github.com@evil.example/YamsSE/Arc-Power", "https://github.com/YamsSE/Other",
            "https://github.com/YamsSE/Arc-Power-evil", "not a url", ""] {
            assert!(open_external_url(&args(url)).is_err(), "{url}");
        }
        assert!(open_external_url(&json!({"t":"array","v":[]})).is_err());
        assert!(open_external_url(&json!({"t":"array","v":[{"t":"number","v":1}]})).is_err());
        assert!(open_external_url(&json!({"t":"null"})).is_err());
    }
}
