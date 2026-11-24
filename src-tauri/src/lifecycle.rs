use std::{path::{Path, PathBuf}, process::Command, time::Duration};

pub fn validate_launch_args(args: &[String]) -> Result<(), String> {
    if is_boot_apply(args) { return Ok(()); }
    if args.len() > 4 { return Err("Too many host launch arguments".into()); }
    let mut seen = std::collections::HashSet::new();
    let mut maintenance = 0;
    for arg in args {
        if !seen.insert(arg) { return Err("Duplicate host launch argument".into()); }
        match arg.as_str() {
            "--mock" | "--profile-boot" => {}
            "--clear-cache" => maintenance += 1,
            _ if arg.starts_with("--ui-test-port=") => { ui_test_port(args)?; }
            _ => {
                let value = arg.strip_prefix("--arc-power-maintenance=").ok_or("Unsupported host launch argument")?;
                let (action, token) = value.split_once(':').ok_or("Invalid maintenance argument")?;
                if !matches!(action, "reset" | "reset-with-drivers") || !(16..=128).contains(&token.len())
                    || !token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
                    return Err("Invalid maintenance argument".into());
                }
                maintenance += 1;
            }
        }
    }
    if maintenance > 1 { return Err("Duplicate maintenance action".into()); }
    Ok(())
}

/// Explicit mock-only instrumentation. Elevated WebView2 ignores the usual
/// diagnostic environment variables, so pass this bounded option via its API.
pub fn ui_test_port(args: &[String]) -> Result<Option<u16>, String> {
    let values: Vec<_> = args.iter().filter_map(|arg| arg.strip_prefix("--ui-test-port=")).collect();
    if values.is_empty() { return Ok(None); }
    if values.len() != 1 || !args.iter().any(|arg| arg == "--mock") {
        return Err("UI test diagnostics require mock mode and one port".into());
    }
    values[0].parse::<u16>().ok().filter(|port| *port >= 1024)
        .map(Some).ok_or_else(|| "Invalid local UI test port".into())
}

pub fn is_boot_apply(args: &[String]) -> bool { args.len() == 1 && args[0] == "--boot-apply" }

fn validate_relaunch_args(args: &[String]) -> Result<(), String> {
    validate_launch_args(args)?;
    if is_boot_apply(args) { return Err("Headless boot-apply cannot be requested by a UI relaunch".into()); }
    Ok(())
}

fn command_at(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

fn artifact_launch_name(name: &str, kind: &str) -> bool {
    // Same actual-launch convention as resolvePortableStartupPath, including
    // browser duplicate-download suffixes. Relaunch must retain the actual
    // wrapper identity, rather than guessing a canonical updater filename.
    fn optional_separator(value: &str) -> &str {
        if value.starts_with(['-', '_', ' ']) { &value[1..] } else { value }
    }
    let name = name.to_ascii_lowercase();
    let Some(stem) = name.strip_suffix(".exe") else { return false; };
    let Some(rest) = stem.strip_prefix("arc") else { return false; };
    let Some(rest) = optional_separator(rest).strip_prefix("power") else { return false; };
    let Some(suffix) = optional_separator(rest).strip_prefix(kind) else { return false; };
    suffix.is_empty() || suffix.starts_with(['-', '_', ' ', '.', '('])
}

#[cfg(test)]
fn portable_launch_name(name: &str) -> bool { artifact_launch_name(name, "portable") }

fn validated_wrapper_file(value: &std::ffi::OsStr, kind: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(value);
    // This is the inherited NSIS marker, never a path supplied over the UI
    // bridge. Match the actual wrapper launch convention in build-kind.js.
    if !candidate.is_absolute()
        || candidate.components().any(|part| matches!(part, std::path::Component::ParentDir))
        || !candidate.file_name().and_then(|name| name.to_str())
            .is_some_and(|name| artifact_launch_name(name, kind)) {
        return Err("Invalid wrapper executable marker".into());
    }
    let metadata = std::fs::symlink_metadata(candidate)
        .map_err(|error| format!("Cannot validate wrapper executable: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Wrapper executable must be an ordinary file".into());
    }
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Wrapper executable cannot be a reparse point".into());
        }
    }
    let canonical = dunce::canonicalize(candidate).map_err(|error| error.to_string())?;
    if !canonical.file_name().and_then(|name| name.to_str())
        .is_some_and(|name| artifact_launch_name(name, kind)) {
        return Err("Invalid canonical wrapper executable".into());
    }
    Ok(canonical)
}

fn resolve_relaunch_target(current_exe: &Path, portable_file: Option<&std::ffi::OsStr>) -> Result<PathBuf, String> {
    match portable_file {
        Some(value) => validated_wrapper_file(value, "portable"),
        None => Ok(current_exe.to_path_buf()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallerMode { Install, Uninstall, Update }

/// Classify only original process arguments and the inherited NSIS marker.
/// This runs before worker, mock, GPU service, or WebView initialization.
pub fn installer_mode(args: &[String], portable_file: Option<&std::ffi::OsStr>) -> Result<Option<InstallerMode>, String> {
    let installer_wrapper = portable_file.filter(|value| Path::new(value).file_name()
        .and_then(|name| name.to_str()).is_some_and(|name| artifact_launch_name(name, "installer")));
    if let Some(value) = installer_wrapper { validated_wrapper_file(value, "installer")?; }
    if args.iter().any(|arg| arg == "--uninstall") {
        return if args.len() == 1 { Ok(Some(InstallerMode::Uninstall)) }
            else { Err("Uninstall accepts only --uninstall".into()) };
    }
    if args.iter().any(|arg| arg == "--install") {
        return if args.len() == 1 && installer_wrapper.is_none() { Ok(Some(InstallerMode::Install)) }
            else { Err("Setup accepts only --install from the staged native payload".into()) };
    }
    if args.iter().any(|arg| arg == "--update") {
        if args.len() != 5 || args[0] != "--update" { return Err("Invalid installer update arguments".into()); }
        let mut pid_seen = false;
        let mut directory_seen = false;
        for pair in args[1..].chunks_exact(2) {
            match pair[0].as_str() {
                "--update-parent-pid" if !pid_seen => {
                    if pair[1].is_empty() || !pair[1].bytes().all(|byte| byte.is_ascii_digit())
                        || pair[1].parse::<u32>().ok().filter(|pid| *pid > 0).is_none() {
                        return Err("Update parent PID must be a positive process ID".into());
                    }
                    pid_seen = true;
                }
                "--update-install-dir" if !directory_seen => {
                    let path = Path::new(&pair[1]);
                    if !path.is_absolute()
                        || !path.components().any(|part| matches!(part, std::path::Component::Normal(_)))
                        || path.components().any(|part| matches!(part, std::path::Component::ParentDir))
                        || pair[1].chars().any(|character| matches!(character, '\0' | '\r' | '\n' | '"')) {
                        return Err("Update install directory must be an absolute non-root directory".into());
                    }
                    directory_seen = true;
                }
                _ => return Err("Unsupported or duplicate installer update argument".into()),
            }
        }
        return if pid_seen && directory_seen { Ok(Some(InstallerMode::Update)) }
            else { Err("Missing installer update arguments".into()) };
    }
    if installer_wrapper.is_some() {
        return if args.is_empty() { Ok(Some(InstallerMode::Install)) }
            else { Err("Installer wrapper accepts no application or worker arguments".into()) };
    }
    Ok(None)
}

fn relaunch_target() -> Result<PathBuf, String> {
    resolve_relaunch_target(&std::env::current_exe().map_err(|e| e.to_string())?,
        std::env::var_os("PORTABLE_EXECUTABLE_FILE").as_deref())
}

pub fn spawn_relaunch_waiter(args: Vec<String>) -> Result<(), String> {
    spawn_relaunch_waiter_with_wait(args, false)
}

/// Spawn the maintenance relaunch helper without a deadline. Reset failures
/// can show a modal Windows error dialog, and the helper must remain alive
/// until the user dismisses it and the old host exits.
pub fn spawn_relaunch_waiter_indefinite(args: Vec<String>) -> Result<(), String> {
    spawn_relaunch_waiter_with_wait(args, true)
}

fn spawn_relaunch_waiter_with_wait(mut args: Vec<String>, wait_indefinitely: bool) -> Result<(), String> {
    let original_args: Vec<String> = std::env::args().skip(1).collect();
    if original_args.iter().any(|arg| arg == "--mock") && !args.iter().any(|arg| arg == "--mock") { args.push("--mock".into()); }
    if let Some(port) = ui_test_port(&original_args)? {
        if !args.iter().any(|arg| arg.starts_with("--ui-test-port=")) { args.push(format!("--ui-test-port={port}")); }
    }
    validate_relaunch_args(&args)?;
    let target = relaunch_target()?;
    let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // The helper is the same already-loaded native image, and its early mode
    // uses only system libraries. It never reads the compatibility payload or
    // initializes WebView2, so NSIS may remove the old extracted resources.
    // Avoid retaining the extraction directory as the helper's working dir.
    let pid = std::process::id().to_string();
    let mut command = command_at(&current_exe);
    command.current_dir(target.parent().ok_or("Missing relaunch executable directory")?)
        .args(["--relaunch-after", pid.as_str()]);
    if wait_indefinitely { command.arg("--wait-indefinitely"); }
    command.arg("--").args(args)
        .spawn().map_err(|e| format!("Cannot start host relaunch waiter: {e}"))?;
    Ok(())
}

/// Runs before creating WebView2, so the next instance cannot race profile or
/// cache locks held by the previous instance. Only the inherited validated NSIS
/// wrapper marker can select an executable other than the native host itself.
pub fn run_relaunch_waiter(args: &[String]) -> Result<bool, String> {
    if args.first().map(String::as_str) != Some("--relaunch-after") { return Ok(false); }
    if args.len() < 3 { return Err("Invalid relaunch waiter arguments".into()); }
    let pid = args[1].parse::<u32>().map_err(|_| "Invalid relaunch process ID")?;
    if pid == 0 || pid == std::process::id() { return Err("Invalid relaunch process ID".into()); }
    let (wait_indefinitely, delimiter) = match args[2].as_str() {
        "--" => (false, 2),
        "--wait-indefinitely" if args.get(3).map(String::as_str) == Some("--") => (true, 3),
        _ => return Err("Invalid relaunch waiter arguments".into()),
    };
    let launch_args = &args[delimiter + 1..];
    validate_relaunch_args(launch_args)?;
    relaunch_target()?;
    if wait_indefinitely { wait_process_exit_indefinitely(pid)?; }
    else { wait_process_exit(pid, Duration::from_secs(60))?; }
    // NSIS removes the old extraction after its ExecWait returns. Relaunching
    // that extracted host would race deletion of its compatibility backend.
    // The stable outer wrapper extracts a complete fresh payload instead.
    let target = relaunch_target()?;
    command_at(&target).current_dir(target.parent().ok_or("Missing relaunch executable directory")?)
        .args(launch_args).spawn().map_err(|e| format!("Cannot relaunch Arc Power: {e}"))?;
    Ok(true)
}

#[cfg(windows)]
pub(crate) fn wait_process_exit(pid: u32, timeout: Duration) -> Result<(), String> {
    use windows_sys::Win32::{Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0}, System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE}};
    unsafe {
        let process = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if process.is_null() {
            if GetLastError() == ERROR_INVALID_PARAMETER { return Ok(()); }
            return Err(format!("Cannot observe previous Arc Power host: {}", std::io::Error::last_os_error()));
        }
        let result = WaitForSingleObject(process, timeout.as_millis().min(u32::MAX as u128) as u32);
        CloseHandle(process);
        if result == WAIT_OBJECT_0 { Ok(()) } else { Err("Previous Arc Power host did not exit within 60 seconds; relaunch cancelled".into()) }
    }
}

#[cfg(windows)]
fn wait_process_exit_indefinitely(pid: u32) -> Result<(), String> {
    use windows_sys::Win32::{Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0}, System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE}};
    unsafe {
        let process = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if process.is_null() {
            if GetLastError() == ERROR_INVALID_PARAMETER { return Ok(()); }
            return Err(format!("Cannot observe previous Arc Power host: {}", std::io::Error::last_os_error()));
        }
        let result = WaitForSingleObject(process, u32::MAX);
        CloseHandle(process);
        if result == WAIT_OBJECT_0 { Ok(()) }
        else { Err("Cannot wait for previous Arc Power host to exit".into()) }
    }
}

#[cfg(not(windows))]
fn wait_process_exit_indefinitely(_pid: u32) -> Result<(), String> { Err("Windows required".into()) }

#[cfg(not(windows))]
fn wait_process_exit(_pid: u32, _timeout: Duration) -> Result<(), String> { Err("Windows required".into()) }

fn reject_reparse(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 { return Err("Refusing a reparse point in WebView2 cache".into()); }
    }
    if metadata.file_type().is_symlink() { return Err("Refusing a symbolic link in WebView2 cache".into()); }
    Ok(())
}

fn check_tree(path: &Path, root: &Path) -> Result<(), String> {
    reject_reparse(path)?;
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(root) { return Err("WebView2 cache entry escaped its fixed root".into()); }
    if path.is_dir() {
        for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
            check_tree(&entry.map_err(|e| e.to_string())?.path(), root)?;
        }
    }
    Ok(())
}

fn remove_checked_tree(path: &Path, root: &Path) -> Result<(), String> {
    reject_reparse(path)?;
    if !path.canonicalize().map_err(|e| e.to_string())?.starts_with(root) { return Err("Cache deletion escaped its fixed root".into()); }
    if path.is_dir() {
        for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
            remove_checked_tree(&entry.map_err(|e| e.to_string())?.path(), root)?;
        }
        std::fs::remove_dir(path).map_err(|e| e.to_string())
    } else { std::fs::remove_file(path).map_err(|e| e.to_string()) }
}

pub fn clear_webview_cache_if_requested(args: &[String]) -> Result<(), String> {
    if !args.iter().any(|arg| arg == "--clear-cache" || arg.starts_with("--arc-power-maintenance=")) { return Ok(()); }
    let app_data = PathBuf::from(std::env::var_os("APPDATA").ok_or("APPDATA is required for cache maintenance")?);
    clear_webview_cache_at(&app_data)
}

fn clear_webview_cache_at(app_data: &Path) -> Result<(), String> {
    if !app_data.is_absolute() || app_data.parent().is_none() { return Err("Invalid application data root".into()); }
    let cache = app_data.join("ArcPowerTauriCache");
    // Every existing ancestor must be an ordinary directory. Only this fixed,
    // explicitly named browser cache is eligible; durable ArcPower is separate.
    for ancestor in cache.ancestors() {
        if ancestor.exists() { reject_reparse(ancestor)?; }
    }
    if !cache.exists() { return Ok(()); }
    let root = cache.canonicalize().map_err(|e| e.to_string())?;
    if root.parent().is_none() || root.file_name().and_then(|n| n.to_str()) != Some("ArcPowerTauriCache") { return Err("Invalid WebView2 cache target".into()); }
    check_tree(&cache, &root)?;
    remove_checked_tree(&cache, &root)
}

/// Result of resetting the durable roaming data directory. `removed` contains
/// only direct ArcPower children whose removal completed successfully.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ArcPowerDataResetResult {
    pub removed: Vec<PathBuf>,
    pub recording_retained: bool,
    pub recording_output: Option<PathBuf>,
}

fn normalized_absolute_path(path: &Path, label: &str) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!("{label} must be a non-empty absolute path"));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(_) | std::path::Component::RootDir => normalized.push(component.as_os_str()),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                // `path.resolve` clamps parent traversal at the filesystem root.
                if normalized.file_name().is_some() {
                    normalized.pop();
                } else if !normalized.has_root() {
                    return Err(format!("{label} is not a safe absolute path"));
                }
            }
            std::path::Component::Normal(_) => normalized.push(component.as_os_str()),
        }
    }
    if !normalized.is_absolute() {
        return Err(format!("{label} must be a non-empty absolute path"));
    }
    Ok(normalized)
}

fn reset_path_key(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    { value.to_lowercase() }
    #[cfg(not(windows))]
    { value.into_owned() }
}

fn reset_same_path(left: &Path, right: &Path) -> bool {
    reset_path_key(left) == reset_path_key(right)
}

fn reset_path_contains(parent: &Path, child: &Path) -> bool {
    let parent = reset_path_key(parent);
    let child = reset_path_key(child);
    if parent == child { return true; }
    let separator = std::path::MAIN_SEPARATOR;
    let boundary = if parent.ends_with(separator) { parent } else { format!("{parent}{separator}") };
    child.starts_with(&boundary)
}

fn reject_reset_reparse(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err(format!("Refusing to reset Arc Power data through a symbolic link: {}", path.display()));
    }
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(format!("Refusing to reset Arc Power data through a reparse point: {}", path.display()));
        }
    }
    Ok(())
}

/// Match the Electron lstat walk: inspect every existing component without
/// following links, while allowing missing path components.
fn validate_reset_path_components(path: &Path) -> Result<PathBuf, String> {
    let resolved = normalized_absolute_path(path, "targetPath")?;
    let mut components: Vec<PathBuf> = resolved.ancestors().map(Path::to_path_buf).collect();
    components.reverse();
    for component in components {
        match std::fs::symlink_metadata(&component) {
            Ok(_) => reject_reset_reparse(&component)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(resolved)
}

fn preflight_reset_tree(path: &Path, root: &Path) -> Result<(), String> {
    if !reset_path_contains(root, path) || reset_same_path(root, path) {
        return Err(format!("Arc Power reset target escaped its fixed data root: {}", path.display()));
    }
    reject_reset_reparse(path)?;
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path).map_err(|error| error.to_string())? {
            preflight_reset_tree(&entry.map_err(|error| error.to_string())?.path(), root)?;
        }
    }
    Ok(())
}

fn read_reset_recording_metadata(path: &Path) -> Result<Option<serde_json::Value>, String> {
    let recording_path = path.join("recording.json");
    validate_reset_path_components(&recording_path)?;
    let raw = match std::fs::read(&recording_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let text = std::str::from_utf8(&raw).map_err(|_| {
        "Refusing to reset Arc Power data because recording.json is malformed; repair recording.json before trying again".to_owned()
    })?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    serde_json::from_str(text).map(Some).map_err(|_| {
        "Refusing to reset Arc Power data because recording.json is malformed; repair recording.json before trying again".to_owned()
    })
}

fn write_reset_recording_temporary(recording_path: &Path, retained: &serde_json::Value) -> Result<PathBuf, String> {
    let mut random = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut random);
    let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let temporary = PathBuf::from(format!("{}.{}.{}.tmp", recording_path.display(), std::process::id(), suffix));
    validate_reset_path_components(&temporary)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let write_result = (|| -> Result<(), String> {
        let mut file = options.open(&temporary).map_err(|error| error.to_string())?;
        serde_json::to_writer_pretty(&mut file, retained).map_err(|error| error.to_string())?;
        use std::io::Write;
        file.flush().map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(temporary)
}

/// Remove only children of `<app_data_root>/ArcPower`, retaining validated
/// recording metadata and its external output folder. The caller must quiesce
/// the running app before invoking this pre-boot helper.
struct ArcPowerDataResetPlan {
    canonical_data_path: PathBuf,
    recording_path: PathBuf,
    retained_recording: Option<serde_json::Value>,
    recording_output: Option<PathBuf>,
    deletion_children: Vec<PathBuf>,
}

fn prepare_arc_power_data_reset_plan(
    app_data_root: &Path,
    include_driver_downloads: bool,
) -> Result<Option<ArcPowerDataResetPlan>, String> {
    let app_data_root = normalized_absolute_path(app_data_root, "appDataRoot")?;
    let data_path = app_data_root.join("ArcPower");
    let data_path = validate_reset_path_components(&data_path)?;
    let data_metadata = match std::fs::symlink_metadata(&data_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !data_metadata.is_dir() {
        return Err(format!("Cannot reset Arc Power data directory: {} is not a directory", data_path.display()));
    }
    let canonical_data_path = data_path.canonicalize().map_err(|error| error.to_string())?;

    let recording_path = data_path.join("recording.json");
    let raw_recording = read_reset_recording_metadata(&data_path)?;
    let mut retained_recording = None;
    let mut recording_output = None;
    if let Some(raw) = raw_recording {
        let object = raw.as_object().ok_or_else(|| {
            "Refusing to reset Arc Power data because recording.json uses an unsupported shape".to_owned()
        })?;
        let schema = object.get("schemaVersion").and_then(|value| {
            value.as_i64().map(|number| number as f64).or_else(|| value.as_u64().map(|number| number as f64)).or_else(|| value.as_f64())
        });
        let clips = object.get("clips").filter(|value| value.is_array());
        let markers = object.get("markers").filter(|value| value.is_array());
        let settings = object.get("settings").and_then(serde_json::Value::as_object);
        let location = settings.and_then(|value| value.get("location")).and_then(serde_json::Value::as_str);
        if !schema.is_some_and(|schema| schema == 1.0 || schema == 2.0)
            || clips.is_none() || markers.is_none() || location.is_none() {
            return Err("Refusing to reset Arc Power data because recording.json uses an unsupported shape".into());
        }
        let location = location.expect("validated above");
        let output_path = normalized_absolute_path(Path::new(location), "recording location").map_err(|_| {
            "Refusing to reset Arc Power data because recording.json has no safe absolute recording location; choose a valid Recording output folder before trying again".to_owned()
        })?;
        let output_path = validate_reset_path_components(&output_path).map_err(|_| {
            "Refusing to reset Arc Power data because recording.json has no safe absolute recording location; choose a valid Recording output folder before trying again".to_owned()
        })?;
        if reset_path_contains(&output_path, &data_path) {
            return Err("Refusing to reset Arc Power data because the Recording output folder contains ArcPower preferences; choose a Recording output folder outside ArcPower or inside a dedicated child folder before resetting".into());
        }
        recording_output = Some(output_path);
        retained_recording = Some(serde_json::json!({
            "schemaVersion": if schema == Some(1.0) { 1 } else { 2 },
            "clips": clips.expect("validated above"),
            "markers": markers.expect("validated above"),
            "settings": { "location": location },
        }));
    }

    let entries: Vec<_> = std::fs::read_dir(&data_path).map_err(|error| error.to_string())?
        .map(|entry| entry.map_err(|error| error.to_string()))
        .collect::<Result<_, _>>()?;
    let mut deletion_children = Vec::with_capacity(entries.len());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if name == "tuningquarantine" || name == "runtime-version.json"
            || (!include_driver_downloads && name == "driverdownloads") {
            continue;
        }
        let child = entry.path();
        let child = validate_reset_path_components(&child)?;
        if !reset_path_contains(&data_path, &child) || reset_same_path(&data_path, &child) {
            return Err(format!("Arc Power reset target escaped its fixed data root: {}", child.display()));
        }
        if !reset_same_path(&child, &recording_path)
            && !recording_output.as_ref().is_some_and(|output| reset_path_contains(&child, output)) {
            deletion_children.push(child);
        }
    }

    // Build and validate the full deletion plan before removing any child.
    for child in &deletion_children { preflight_reset_tree(child, &data_path)?; }
    Ok(Some(ArcPowerDataResetPlan {
        canonical_data_path,
        recording_path,
        retained_recording,
        recording_output,
        deletion_children,
    }))
}

/// Read-only validation pass for reset. It checks the full removal plan,
/// recording metadata, external output path, and reparse boundaries without
/// writing files or deleting data.
pub fn preflight_arc_power_data_reset_at(
    app_data_root: &Path,
    include_driver_downloads: bool,
) -> Result<ArcPowerDataResetResult, String> {
    let Some(plan) = prepare_arc_power_data_reset_plan(app_data_root, include_driver_downloads)? else {
        return Ok(ArcPowerDataResetResult::default());
    };
    Ok(ArcPowerDataResetResult {
        removed: Vec::new(),
        recording_retained: plan.retained_recording.is_some(),
        recording_output: plan.recording_output,
    })
}

pub fn reset_arc_power_data_at(
    app_data_root: &Path,
    include_driver_downloads: bool,
) -> Result<ArcPowerDataResetResult, String> {
    let Some(plan) = prepare_arc_power_data_reset_plan(app_data_root, include_driver_downloads)? else {
        return Ok(ArcPowerDataResetResult::default());
    };
    let temporary = match plan.retained_recording.as_ref() {
        Some(retained) => Some(write_reset_recording_temporary(&plan.recording_path, retained)?),
        None => None,
    };
    let mut removed = Vec::with_capacity(plan.deletion_children.len());
    for child in &plan.deletion_children {
        match std::fs::symlink_metadata(child) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                if let Some(temporary) = &temporary { let _ = std::fs::remove_file(temporary); }
                return Err(error.to_string());
            }
        }
        if let Err(error) = remove_checked_tree(child, &plan.canonical_data_path) {
            if let Some(temporary) = &temporary { let _ = std::fs::remove_file(temporary); }
            return Err(error);
        }
        removed.push(child.clone());
    }
    if let Some(temporary) = temporary {
        if let Err(error) = std::fs::rename(&temporary, &plan.recording_path) {
            let _ = std::fs::remove_file(&temporary);
            return Err(error.to_string());
        }
    }
    Ok(ArcPowerDataResetResult {
        removed,
        recording_retained: plan.retained_recording.is_some(),
        recording_output: plan.recording_output,
    })
}

pub fn mock_selected(args: &[String], backend: Option<&str>) -> bool {
    args.iter().any(|arg| arg == "--mock") || backend == Some("mock")
}

pub fn prepare_mock_environment(args: &[String]) -> Result<(), String> {
    if !mock_selected(args, std::env::var("RID_BACKEND").as_deref().ok()) { return Ok(()); }
    if std::env::var_os("RID_MOCK_FEATURESET").is_none() {
        std::env::set_var("RID_MOCK_FEATURESET", "b580");
    }
    // Avoid Rust's extended-length \\?\ prefix here: Node's path.relative
    // treats it as another root when validating the same temporary directory.
    let temporary = dunce::canonicalize(std::env::temp_dir()).map_err(|e| e.to_string())?;
    let root = if let Some(value) = std::env::var_os("ARC_POWER_TAURI_MOCK_ROOT") {
        let candidate = PathBuf::from(value);
        if !candidate.is_absolute() || candidate.components().any(|component| matches!(component, std::path::Component::ParentDir))
            || !candidate.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("ArcPower-Tauri-Mock-")) {
            return Err("Invalid isolated mock root".into());
        }
        let parent = dunce::canonicalize(candidate.parent().ok_or("Invalid isolated mock root")?).map_err(|e| e.to_string())?;
        if parent != temporary { return Err("Mock root must be a direct child of the temporary directory".into()); }
        candidate
    } else {
        let mut random = [0u8; 16];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut random);
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        temporary.join(format!("ArcPower-Tauri-Mock-{suffix}"))
    };
    if root.exists() { reject_reparse(&root)?; }
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    for name in ["Roaming", "Local"] {
        let child = root.join(name);
        if child.exists() { reject_reparse(&child)?; }
        std::fs::create_dir_all(&child).map_err(|e| e.to_string())?;
    }
    std::env::set_var("ARC_POWER_TAURI_MOCK_ROOT", &root);
    std::env::set_var("APPDATA", root.join("Roaming"));
    std::env::set_var("LOCALAPPDATA", root.join("Local"));
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn environment_selected_mock_uses_the_same_host_isolation_policy() {
        assert!(super::mock_selected(&[], Some("mock")));
        assert!(super::mock_selected(&["--mock".into()], None));
        assert!(!super::mock_selected(&[], None));
        assert!(!super::mock_selected(&[], Some("igcl")));
    }
    use super::*;
    fn arguments(values: &[&str]) -> Vec<String> { values.iter().map(|value| (*value).into()).collect() }

    #[test]
    fn installer_modes_are_early_strict_and_do_not_classify_normal_launches() {
        assert_eq!(installer_mode(&[], None).unwrap(), None);
        for args in [arguments(&["--mock"]), arguments(&["--boot-apply"]), arguments(&["--profile-boot"])] {
            assert_eq!(installer_mode(&args, None).unwrap(), None);
        }
        assert_eq!(installer_mode(&arguments(&["--uninstall"]), None).unwrap(), Some(InstallerMode::Uninstall));
        let destination = std::env::temp_dir().join("ArcPower-Installer-Target");
        let destination = destination.to_str().unwrap();
        for values in [["--update", "--update-parent-pid", "42", "--update-install-dir", destination],
            ["--update", "--update-install-dir", destination, "--update-parent-pid", "42"]] {
            assert_eq!(installer_mode(&arguments(&values), None).unwrap(), Some(InstallerMode::Update));
        }
        let root = std::env::temp_dir().join(format!("ArcPower-Tauri-Installer-Test-{}", rand::random::<u128>()));
        std::fs::create_dir_all(&root).unwrap();
        let wrapper = root.join("Arc-Power_Installer (1).exe");
        std::fs::write(&wrapper, b"non-executed installer fixture").unwrap();
        assert_eq!(installer_mode(&[], Some(wrapper.as_os_str())).unwrap(), Some(InstallerMode::Install));
        for args in [arguments(&["--mock"]), arguments(&["--installer"]), arguments(&["--boot-apply"]),
            arguments(&["--tauri-broker"]), arguments(&["--relaunch-after", "42", "--"])] {
            assert!(installer_mode(&args, Some(wrapper.as_os_str())).is_err());
        }
        std::fs::remove_file(&wrapper).unwrap();
        assert!(installer_mode(&[], Some(wrapper.as_os_str())).is_err());
        assert!(installer_mode(&[], Some(std::ffi::OsStr::new("Arc-Power_Installer.exe"))).is_err());
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn installer_filename_pattern_is_anchored_and_supports_actual_download_names() {
        for name in ["Arc-Power_Installer.exe", "Arc-Power_Installer (1).exe", "ARCPOWERINSTALLER.EXE",
            "Arc Power Installer-1.3.0.exe", "Arc_Power-Installer.test.exe", "ArcPowerInstaller(2).exe"] {
            assert!(artifact_launch_name(name, "installer"), "{name}");
        }
        for name in ["Arc Power.exe", "Arc-Power_Portable.exe", "Arc-Power_InstallerX.exe",
            "other-Arc-Power_Installer.exe", "Arc-Power_Installer.exe.cmd", "Arc--Power_Installer.exe"] {
            assert!(!artifact_launch_name(name, "installer"), "{name}");
        }
    }

    #[test]
    fn installer_rejects_mixed_worker_update_flags_and_unsafe_directories() {
        let destination = std::env::temp_dir().join("ArcPower-Installer-Target");
        let destination = destination.to_str().unwrap();
        for values in [vec!["--uninstall", "--mock"], vec!["--uninstall", "--update"],
            vec!["--update"], vec!["--update", "--update-parent-pid", "42", "--update-parent-pid", "43"],
            vec!["--update", "--update-parent-pid", "42", "--update-install-dir", destination, "--apply-worker"],
            vec!["--update", "--apply-worker", "42", "--update-install-dir", destination]] {
            assert!(installer_mode(&arguments(&values), None).is_err(), "{values:?}");
        }
        for pid in ["0", "-1", "+1", "4294967296", "worker", ""] {
            assert!(installer_mode(&arguments(&["--update", "--update-parent-pid", pid, "--update-install-dir", destination]), None).is_err());
        }
        let root = destination_path_root();
        for directory in ["", "relative", root.as_str(), "C:\\Programs\\..", "C:\\Programs\nUnexpected", "C:\\Programs\"Unexpected"] {
            assert!(installer_mode(&arguments(&["--update", "--update-parent-pid", "42", "--update-install-dir", directory]), None).is_err(), "{directory:?}");
        }
        #[cfg(windows)]
        for directory in ["C:\\", "C:\\.", "\\\\server\\share\\"] {
            assert!(installer_mode(&arguments(&["--update", "--update-parent-pid", "42", "--update-install-dir", directory]), None).is_err());
        }
    }

    fn destination_path_root() -> String {
        let temporary = std::env::temp_dir();
        temporary.ancestors().last().unwrap().to_str().unwrap().to_owned()
    }

    #[test]
    fn ui_diagnostics_are_explicit_mock_only_and_bounded() {
        let args = |items: &[&str]| items.iter().map(|value| (*value).to_owned()).collect::<Vec<_>>();
        assert_eq!(ui_test_port(&args(&["--mock"])).unwrap(), None);
        assert_eq!(ui_test_port(&args(&["--mock", "--ui-test-port=9347"])).unwrap(), Some(9347));
        assert!(validate_launch_args(&args(&["--mock", "--ui-test-port=9347", "--clear-cache"])).is_ok());
        for items in [vec!["--ui-test-port=9347"], vec!["--mock", "--ui-test-port=80"],
            vec!["--mock", "--ui-test-port=65536"], vec!["--mock", "--ui-test-port=9347 --no-sandbox"],
            vec!["--mock", "--ui-test-port=9347", "--ui-test-port=9348"]] {
            assert!(validate_launch_args(&args(&items)).is_err(), "{items:?}");
        }
    }
    #[test]
    fn portable_restart_uses_stable_wrapper_after_extraction_is_removed() {
        let root = std::env::temp_dir().join(format!("ArcPower-Tauri-Relaunch-Test-{}", rand::random::<u128>()));
        let extraction = root.join("extracted");
        std::fs::create_dir_all(&extraction).unwrap();
        let host = extraction.join("Arc Power.exe");
        let wrapper = root.join("Arc-Power_Portable.exe");
        std::fs::write(&host, b"native host").unwrap();
        std::fs::write(&wrapper, b"stable wrapper").unwrap();
        // Installed and source launches have no NSIS marker and keep identity.
        assert_eq!(resolve_relaunch_target(&host, None).unwrap(), host);
        let expected = dunce::canonicalize(&wrapper).unwrap();
        assert_eq!(resolve_relaunch_target(&host, Some(wrapper.as_os_str())).unwrap(), expected);
        std::fs::remove_file(&host).unwrap();
        std::fs::remove_dir(&extraction).unwrap();
        assert_eq!(resolve_relaunch_target(&host, Some(wrapper.as_os_str())).unwrap(), expected);
        std::fs::remove_file(&wrapper).unwrap();
        std::fs::remove_dir(&root).unwrap();
    }

    #[test]
    fn invalid_portable_markers_fail_closed_instead_of_using_extracted_host() {
        let root = std::env::temp_dir().join(format!("ArcPower-Tauri-Relaunch-Test-{}", rand::random::<u128>()));
        std::fs::create_dir_all(&root).unwrap();
        let host = root.join("Arc Power.exe");
        std::fs::write(&host, b"native host").unwrap();
        let directory = root.join("Arc-Power_Portable.exe");
        std::fs::create_dir(&directory).unwrap();
        for invalid in [PathBuf::new(), PathBuf::from("Arc-Power_Portable.exe"), host.clone(),
            root.join("missing").join("Arc-Power_Portable.exe"), directory.clone(),
            root.join("..").join("Arc-Power_Portable.exe")] {
            assert!(resolve_relaunch_target(&host, Some(invalid.as_os_str())).is_err(), "{invalid:?}");
        }
        std::fs::remove_file(&host).unwrap();
        std::fs::remove_dir(directory).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn portable_launch_pattern_retains_duplicate_download_identity() {
        for name in ["Arc-Power_Portable.exe", "Arc-Power_Portable (1).exe", "ARCPOWERPORTABLE.EXE",
            "Arc Power Portable-1.3.0.exe", "Arc_Power-Portable.test.exe", "ArcPowerPortable(2).exe"] {
            assert!(portable_launch_name(name), "{name}");
        }
        for name in ["other.exe", "Arc Power.exe", "Arc-Power_PortableX.exe", "Arc--Power_Portable.exe",
            "Arc-Power_Portable.exe.cmd", "Arc-Power_Portable"] {
            assert!(!portable_launch_name(name), "{name}");
        }
        let root = std::env::temp_dir().join(format!("ArcPower-Tauri-Relaunch-Test-{}", rand::random::<u128>()));
        std::fs::create_dir_all(&root).unwrap();
        let wrapper = root.join("Arc-Power_Portable (1).exe");
        std::fs::write(&wrapper, b"actual downloaded wrapper").unwrap();
        assert_eq!(resolve_relaunch_target(&root.join("extracted/Arc Power.exe"), Some(wrapper.as_os_str())).unwrap(),
            dunce::canonicalize(&wrapper).unwrap());
        std::fs::remove_file(wrapper).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn waiter_rejects_headless_boot_apply_before_waiting_or_launching() {
        assert!(run_relaunch_waiter(&["--relaunch-after".into(), "1".into(), "--".into(), "--boot-apply".into()]).is_err());
        assert!(validate_relaunch_args(&["--mock".into(), "--profile-boot".into(), "--clear-cache".into()]).is_ok());
        assert!(validate_relaunch_args(&["--mock".into(), "--arc-power-maintenance=reset:1234567890123456".into()]).is_ok());
    }

    #[test]
    fn launch_args_reject_arbitrary_commands_and_duplicate_reset() {
        assert!(is_boot_apply(&["--boot-apply".into()]));
        assert!(!is_boot_apply(&["--boot-apply".into(), "--mock".into()]));
        assert!(validate_relaunch_args(&["--boot-apply".into()]).is_err());
        assert!(validate_launch_args(&["--mock".into(), "--clear-cache".into()]).is_ok());
        assert!(validate_launch_args(&["--arc-power-maintenance=reset:12345678-1234-1234-1234-123456789012".into()]).is_ok());
        for args in [vec!["--headless".into()], vec!["C:\\other.exe".into()], vec!["--clear-cache".into(), "--arc-power-maintenance=reset:1234567890123456".into()], vec!["--arc-power-maintenance=reset:../../private".into()], vec!["--mock".into(), "--mock".into()]] {
            assert!(validate_launch_args(&args).is_err());
        }
    }

    #[test]
    fn cache_reset_removes_only_the_explicit_browser_cache() {
        let root = std::env::temp_dir().join(format!("ArcPower-Tauri-Cache-Test-{}", rand::random::<u128>()));
        let cache = root.join("ArcPowerTauriCache");
        let profiles = root.join("ArcPower");
        std::fs::create_dir_all(cache.join("nested")).unwrap();
        std::fs::create_dir_all(&profiles).unwrap();
        std::fs::write(cache.join("nested/temporary"), b"cache").unwrap();
        std::fs::write(profiles.join("settings.json"), b"preserved").unwrap();
        clear_webview_cache_at(&root).unwrap();
        assert!(!cache.exists());
        assert_eq!(std::fs::read(profiles.join("settings.json")).unwrap(), b"preserved");
        std::fs::remove_file(profiles.join("settings.json")).unwrap();
        std::fs::remove_dir(profiles).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
