use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

#[path = "native_installer.rs"]
pub(crate) mod native_installer;

pub(super) const NATIVE_PAYLOAD_FILES: &[&str] = &[
    "Arc Power.exe",
    "resources/app-icon.ico",
    "resources/ArcPowerTaskbar-blue-gradient.ico",
    "resources/lhm/ArcPower.LhmBridge.exe",
    "resources/recording-runtime/bin/64bit/ffmpeg.exe",
    "resources/recording-runtime/bin/64bit/ffprobe.exe",
    "resources/recording-runtime/bin/64bit/ascent-obs.exe",
    "resources/app.asar.unpacked/src/main/backend/igcl2023/IntelControlLib.dll",
    "resources/ArcPower.D3D12UploadHeapQuery.exe",
    "resources/PawnIO_setup.exe",
];

#[derive(Debug)]
pub struct CompatibilityRuntime { pub executable: PathBuf, pub app_argument: Option<PathBuf> }

fn checked(executable: PathBuf, app_argument: Option<PathBuf>) -> Result<CompatibilityRuntime, String> {
    if !executable.is_absolute() || !executable.is_file() || app_argument.as_ref().is_some_and(|path| !path.is_absolute() || !path.exists()) {
        return Err("The fixed Arc Power compatibility runtime is missing; rebuild or repair this installation".into());
    }
    Ok(CompatibilityRuntime { executable, app_argument })
}

fn discover_at(host: &Path, development_root: Option<&Path>, override_paths: Option<(PathBuf, PathBuf)>) -> Result<CompatibilityRuntime, String> {
    if let Some((executable, app)) = override_paths { return checked(executable, Some(app)); }
    if let Some(root) = development_root {
        return checked(root.join("node_modules/electron/dist/electron.exe"), Some(root.to_owned()));
    }
    let directory = host.parent().ok_or("Cannot locate native host directory")?.join("compatibility-backend");
    let archive = directory.join("resources/app.asar");
    if !archive.is_file() { return Err("Packaged compatibility-backend/resources/app.asar is missing".into()); }
    let packaged = directory.join("ArcPower.Backend.exe");
    if packaged.is_file() { checked(packaged, None) }
    else { checked(directory.join("electron.exe"), Some(archive)) }
}

pub fn discover() -> Result<CompatibilityRuntime, String> {
    let host = std::env::current_exe().map_err(|e| e.to_string())?;
    let root = if cfg!(debug_assertions) { Path::new(env!("CARGO_MANIFEST_DIR")).parent() } else { None };
    // Source-checkout overrides are development-only. A released host can run
    // only its fixed packaged compatibility-backend directory.
    let overrides = if cfg!(debug_assertions) {
        match (std::env::var_os("ARC_POWER_BROKER_EXECUTABLE"), std::env::var_os("ARC_POWER_BROKER_APP_PATH")) {
            (Some(executable), Some(app)) => Some((executable.into(), app.into())),
            (None, None) => None,
            _ => return Err("Both development compatibility runtime overrides must be supplied together".into()),
        }
    } else { None };
    discover_at(&host, root, overrides)
}

pub fn command(runtime: &CompatibilityRuntime) -> Command {
    let mut command = Command::new(&runtime.executable);
    if let Some(app) = &runtime.app_argument { command.arg(app); }
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

pub fn run_boot_apply() -> Result<i32, String> {
    let runtime = discover()?;
    let status = command(&runtime).arg("--boot-apply")
        .env_remove("ELECTRON_RUN_AS_NODE")
        .env_remove("ARC_POWER_TAURI_SESSION").env_remove("ARC_POWER_TAURI_PIPE")
        .status().map_err(|e| format!("Cannot start the existing boot-apply service: {e}"))?;
    Ok(status.code().unwrap_or(1))
}

/// The portable updater helper runs from the already-loaded native host image,
/// waits for its parent to exit, then replaces the outer wrapper with a
/// receipt-verified release. It does not initialize Tauri or the compatibility
/// service.
pub fn run_portable_update_if_requested(args: &[String]) -> Result<Option<i32>, String> {
    if args.first().map(String::as_str) != Some("--portable-update") { return Ok(None); }
    if args.len() != 5 { return Err("Invalid portable update helper arguments".into()); }
    let parent_pid = args[1].parse::<u32>().ok().filter(|pid| *pid > 0 && *pid != std::process::id())
        .ok_or("Invalid portable update parent process ID")?;
    // Native NSIS portable entry points remain alive while their extracted
    // host runs. Retain that wrapper PID so replacement waits for the SFX image
    // itself to release its executable file lock as well as the app host.
    let wrapper_pid = std::env::var("ARC_POWER_PORTABLE_WRAPPER_PID").ok().map(|value| {
        value.parse::<u32>().ok().filter(|pid| *pid > 0 && *pid != parent_pid && *pid != std::process::id())
            .ok_or_else(|| "Invalid portable wrapper process ID".to_owned())
    }).transpose()?;
    let downloaded = PathBuf::from(&args[2]);
    let expected_digest = args[3].to_ascii_lowercase();
    let target = PathBuf::from(&args[4]);
    if !downloaded.is_absolute() || !target.is_absolute()
        || expected_digest.len() != 64
        || !expected_digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid portable update paths or digest".into());
    }
    if !target.extension().and_then(|extension| extension.to_str()).is_some_and(|extension| extension.eq_ignore_ascii_case("exe")) {
        return Err("Portable update target is not an executable".into());
    }
    let inherited_target = std::env::var_os("PORTABLE_EXECUTABLE_FILE").map(PathBuf::from)
        .ok_or("Portable wrapper identity is unavailable")?;
    if !same_windows_path(&target, &inherited_target) {
        return Err("Portable update target does not match the active wrapper".into());
    }
    let staging_root_path = std::env::temp_dir().join("arc-power-updates");
    reject_update_reparse(&staging_root_path)?;
    let staging_root = staging_root_path.canonicalize()
        .map_err(|_| "Portable update staging directory is unavailable")?;
    reject_update_reparse(&downloaded)?;
    let downloaded = downloaded.canonicalize().map_err(|_| "Downloaded portable update is unavailable")?;
    if !downloaded.starts_with(&staging_root)
        || downloaded.file_name().and_then(|name| name.to_str()).is_none_or(|name| !name.eq_ignore_ascii_case("Arc-Power_Portable.exe")) {
        return Err("Downloaded portable update is outside its fixed staging directory".into());
    }
    reject_update_reparse(&target)?;
    let target = target.canonicalize().map_err(|error| format!("Cannot resolve portable wrapper: {error}"))?;
    if downloaded == target { return Err("Downloaded portable update cannot replace itself".into()); }
    if hash_file(&downloaded)? != expected_digest { return Err("Downloaded update SHA-256 does not match its receipt".into()); }
    let downloaded_size = fs::metadata(&downloaded).map_err(|error| error.to_string())?.len();
    if downloaded_size == 0 || downloaded_size > 1024 * 1024 * 1024 { return Err("Downloaded portable update has an invalid size".into()); }

    if let Some(wrapper_pid) = wrapper_pid {
        // The NSIS script uses ExecWait for the host and exits only after that
        // child has terminated; the image-bound process handle is therefore
        // the complete handoff barrier for both processes.
        wait_portable_wrapper_exit(wrapper_pid, &target, Duration::from_secs(60))?;
    } else {
        // Compatibility with previous portable wrappers which do not publish
        // their own PID; those launchers do not keep their image open.
        crate::lifecycle::wait_process_exit(parent_pid, Duration::from_secs(60))?;
    }
    let parent = target.parent().ok_or("Portable wrapper has no parent directory")?;
    reject_update_reparse(parent)?;
    let stem = target.file_name().ok_or("Portable wrapper name is invalid")?.to_string_lossy();
    let staged = parent.join(format!("{stem}.arc-power-update-{parent_pid}.tmp"));
    let backup = parent.join(format!("{stem}.arc-power-backup-{parent_pid}.tmp"));
    if staged.exists() || backup.exists() { return Err("A previous portable update recovery file needs attention".into()); }
    let mut source = File::open(&downloaded).map_err(|error| error.to_string())?;
    let mut stage_file = OpenOptions::new().write(true).create_new(true).open(&staged)
        .map_err(|error| format!("Cannot stage portable update: {error}"))?;
    if let Err(error) = std::io::copy(&mut source, &mut stage_file) {
        let _ = fs::remove_file(&staged);
        return Err(format!("Cannot copy portable update: {error}"));
    }
    stage_file.sync_all().map_err(|error| format!("Cannot flush portable update: {error}"))?;
    drop(stage_file);
    if hash_file(&staged)? != expected_digest {
        let _ = fs::remove_file(&staged);
        return Err("Staged portable update failed SHA-256 verification".into());
    }

    if let Err(error) = fs::rename(&target, &backup) {
        let _ = fs::remove_file(&staged);
        return Err(format!("Cannot preserve the current portable wrapper: {error}"));
    }
    if let Err(error) = fs::rename(&staged, &target) {
        let restored = fs::rename(&backup, &target).is_ok();
        let _ = fs::remove_file(&staged);
        return Err(if restored {
            format!("Cannot install portable update; the previous wrapper was restored: {error}")
        } else {
            format!("Cannot install portable update and could not restore the previous wrapper; recovery file: {}", backup.display())
        });
    }
    let target_matches = hash_file(&target).is_ok_and(|digest| digest == expected_digest)
        && fs::metadata(&target).is_ok_and(|metadata| metadata.len() == downloaded_size);
    if !target_matches {
        let _ = fs::remove_file(&target);
        let restored = fs::rename(&backup, &target).is_ok();
        return Err(if restored {
            "Portable update replacement failed verification; the previous wrapper was restored".into()
        } else {
            format!("Portable update replacement failed verification; recovery file: {}", backup.display())
        });
    }

    let mut launch = Command::new(&target);
    launch.current_dir(parent).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        launch.creation_flags(0x00000008 | 0x00000200); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    }
    launch.env_remove("ARC_POWER_PORTABLE_WRAPPER_PID");
    if let Err(error) = launch.spawn() {
        let _ = fs::remove_file(&target);
        let restored = fs::rename(&backup, &target).is_ok();
        return Err(if restored {
            format!("Updated portable wrapper could not be relaunched; the previous wrapper was restored: {error}")
        } else {
            format!("Updated portable wrapper could not be relaunched; recovery file: {} ({error})", backup.display())
        });
    }
    fs::remove_file(&backup).map_err(|error| format!("Update succeeded, but the previous wrapper backup remains at {}: {error}", backup.display()))?;
    Ok(Some(0))
}

fn same_windows_path(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy()),
        _ => left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy()),
    }
}

fn reject_update_reparse(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        if !ancestor.exists() { continue; }
        let metadata = fs::symlink_metadata(ancestor).map_err(|error| format!("Cannot inspect update path: {error}"))?;
        #[cfg(windows)]
        let reparse = {
            use std::os::windows::fs::MetadataExt;
            metadata.file_attributes() & 0x400 != 0
        };
        #[cfg(not(windows))]
        let reparse = metadata.file_type().is_symlink();
        if reparse { return Err(format!("Update path contains a link or reparse point: {}", ancestor.display())); }
    }
    Ok(())
}

#[cfg(windows)]
fn wait_portable_wrapper_exit(pid: u32, expected_executable: &Path, timeout: Duration) -> Result<(), String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0},
        System::Threading::{OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE},
    };
    unsafe {
        let process = OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            if GetLastError() == ERROR_INVALID_PARAMETER { return Ok(()); }
            return Err(format!("Cannot observe portable launcher process: {}", std::io::Error::last_os_error()));
        }
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        if QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) == 0 {
            CloseHandle(process);
            return Err(format!("Cannot verify portable launcher process: {}", std::io::Error::last_os_error()));
        }
        let image = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length as usize]));
        if !same_windows_path(&image, expected_executable) {
            CloseHandle(process);
            return Err("Portable launcher process does not match the active wrapper".into());
        }
        let result = WaitForSingleObject(process, timeout.as_millis().min(u32::MAX as u128) as u32);
        CloseHandle(process);
        if result == WAIT_OBJECT_0 { Ok(()) }
        else { Err("Portable launcher did not exit within 60 seconds; update cancelled".into()) }
    }
}

#[cfg(not(windows))]
fn wait_portable_wrapper_exit(_pid: u32, _expected_executable: &Path, _timeout: Duration) -> Result<(), String> {
    Err("Portable wrapper updates require Windows".into())
}

fn hash_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 { break; }
        hash.update(&buffer[..read]);
    }
    Ok(hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect::<String>())
}

fn installer_command(runtime: &CompatibilityRuntime, host: &Path, args: &[String]) -> Result<Command, String> {
    let root = host.parent().filter(|root| root.is_absolute() && root.parent().is_some())
        .ok_or("Cannot locate native installer payload root")?;
    let mut child = command(runtime);
    child.args(args)
        .env("ARC_POWER_TAURI_INSTALL_ROOT", root)
        .env("ARC_POWER_TAURI_HOST_EXECUTABLE", host)
        .env_remove("ELECTRON_RUN_AS_NODE")
        .env_remove("ARC_POWER_TAURI_SESSION").env_remove("ARC_POWER_TAURI_PIPE");
    Ok(child)
}

pub fn run_installer_if_requested(args: &[String]) -> Result<Option<i32>, String> {
    let host = std::env::current_exe().map_err(|error| error.to_string())?;
    // The standalone archive carries a copy named Arc-Power_Installer.exe.
    // Older portable wrappers provide their outer executable through the same
    // inherited marker, which lifecycle validates before classifying setup.
    let wrapper = std::env::var_os("PORTABLE_EXECUTABLE_FILE");
    let marker = wrapper.as_deref().or(Some(host.as_os_str()));
    let Some(mode) = crate::lifecycle::installer_mode(args, marker)? else { return Ok(None); };
    match mode {
        crate::lifecycle::InstallerMode::Update => {
            #[cfg(windows)]
            return run_native_installed_update(args).map(Some);
            #[cfg(not(windows))]
            return Err("Native installed updates require Windows".into());
        }
        mode @ (crate::lifecycle::InstallerMode::Install | crate::lifecycle::InstallerMode::Uninstall) => {
            native_installer::run(mode).map(Some)
        }
    }
}

#[cfg(windows)]
fn run_native_installed_update(args: &[String]) -> Result<i32, String> {
    match apply_native_installed_update(args) {
        Ok(()) => Ok(0),
        Err(error) => {
            show_update_error(&error);
            Err(error)
        }
    }
}

#[cfg(windows)]
fn apply_native_installed_update(args: &[String]) -> Result<(), String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    let value_after = |name: &str| -> Result<&str, String> {
        let index = args.iter().position(|value| value == name).ok_or("Invalid installer update arguments")?;
        args.get(index + 1).map(String::as_str).ok_or_else(|| "Invalid installer update arguments".into())
    };
    let parent_pid = value_after("--update-parent-pid")?.parse::<u32>()
        .ok().filter(|pid| *pid > 0 && *pid != std::process::id())
        .ok_or("Invalid installer update parent process ID")?;
    let install_dir = PathBuf::from(value_after("--update-install-dir")?);
    if !install_dir.is_absolute() || install_dir.components().any(|part| matches!(part, std::path::Component::ParentDir))
        || install_dir.components().filter(|part| matches!(part, std::path::Component::Normal(_))).count() == 0 {
        return Err("Update install directory must be an absolute non-root path".into());
    }
    let host = std::env::current_exe().map_err(|error| error.to_string())?;
    let source_root_path = host.parent().ok_or("Cannot locate the native update payload")?;
    reject_update_reparse(source_root_path)?;
    let source_root = source_root_path.canonicalize()
        .map_err(|error| format!("Cannot resolve the native update payload: {error}"))?;
    reject_update_reparse(&install_dir)?;
    let install_dir = install_dir.canonicalize().map_err(|error| format!("Cannot resolve installed Arc Power directory: {error}"))?;
    reject_update_reparse(&source_root)?;
    reject_update_reparse(&install_dir)?;
    if path_overlaps(&source_root, &install_dir) { return Err("Update payload overlaps the installed Arc Power directory".into()); }
    validate_native_payload(&source_root)?;
    validate_registered_install(&install_dir)?;
    let uninstall_key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Arc Power",
            winreg::enums::KEY_QUERY_VALUE | winreg::enums::KEY_SET_VALUE)
        .map_err(|error| format!("Cannot update Arc Power uninstall registration: {error}"))?;
    let previous_display_version: String = uninstall_key.get_value("DisplayVersion")
        .map_err(|error| format!("Cannot read the installed Arc Power version registration: {error}"))?;

    crate::lifecycle::wait_process_exit(parent_pid, Duration::from_secs(60))?;
    let parent = install_dir.parent().ok_or("Installed Arc Power directory has no parent")?;
    let pid = std::process::id();
    let stage = parent.join(format!(".ArcPower-update-{pid}.stage"));
    let backup = parent.join(format!(".ArcPower-update-{pid}.backup"));
    if stage.exists() || backup.exists() { return Err("A previous Arc Power update recovery directory needs attention".into()); }
    fs::create_dir(&stage).map_err(|error| format!("Cannot create update staging directory: {error}"))?;
    let staged = (|| {
        for entry in fs::read_dir(&install_dir).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry.file_name().to_string_lossy().eq_ignore_ascii_case("compatibility-backend") {
                continue;
            }
            copy_update_tree(&entry.path(), &stage.join(entry.file_name()))?;
        }
        copy_update_tree(&source_root, &stage)?;
        validate_native_payload(&stage)?;
        verify_update_payload(&source_root, &stage)?;
        Ok::<(), String>(())
    })();
    if let Err(error) = staged {
        let _ = fs::remove_dir_all(&stage);
        return Err(error);
    }

    if let Err(error) = native_installer::rename_with_retry(
        &install_dir, &backup, "Cannot preserve the installed Arc Power files") {
        let _ = fs::remove_dir_all(&stage);
        return Err(error);
    }
    if let Err(error) = fs::rename(&stage, &install_dir) {
        let restored = fs::rename(&backup, &install_dir).is_ok();
        let _ = fs::remove_dir_all(&stage);
        return Err(if restored {
            format!("Cannot install the update; the previous files were restored: {error}")
        } else {
            format!("Cannot install the update and could not restore the previous files; recovery directory: {}", backup.display())
        });
    }

    if let Err(error) = validate_native_payload(&install_dir).and_then(|_| verify_update_payload(&source_root, &install_dir)) {
        let failed = parent.join(format!(".ArcPower-update-{pid}.failed"));
        let _ = fs::rename(&install_dir, &failed);
        let restored = fs::rename(&backup, &install_dir).is_ok();
        return Err(if restored {
            format!("Installed update verification failed; the previous files were restored: {error}")
        } else {
            format!("Installed update verification failed; recovery files are at {} and {}: {error}", backup.display(), failed.display())
        });
    }

    if let Err(error) = uninstall_key.set_value("DisplayVersion", &env!("CARGO_PKG_VERSION")) {
        let failed = parent.join(format!(".ArcPower-update-{pid}.failed"));
        let _ = fs::rename(&install_dir, &failed);
        let restored = fs::rename(&backup, &install_dir).is_ok();
        let registration_restored = uninstall_key.set_value("DisplayVersion", &previous_display_version).is_ok();
        return Err(if restored {
            format!("Cannot update the installed version registration; the previous files were restored{}: {error}",
                if registration_restored { "" } else { ", but the previous version registration could not be restored" })
        } else {
            format!("Cannot update version registration and restore the previous files; recovery files are at {} and {}{}", backup.display(), failed.display(),
                if registration_restored { "" } else { " and the previous version registration could not be restored" })
        });
    }

    let executable = install_dir.join("Arc Power.exe");
    let mut launch = Command::new(&executable);
    launch.current_dir(&install_dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .env_remove("PORTABLE_EXECUTABLE_FILE")
        .env_remove("PORTABLE_EXECUTABLE_DIR")
        .env_remove("PORTABLE_EXECUTABLE_APP_FILENAME")
        .env_remove("ARC_POWER_TAURI_SESSION")
        .env_remove("ARC_POWER_TAURI_PIPE");
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        launch.creation_flags(0x00000008 | 0x00000200); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    }
    if let Err(error) = launch.spawn() {
        let failed = parent.join(format!(".ArcPower-update-{pid}.failed"));
        let _ = fs::rename(&install_dir, &failed);
        let restored = fs::rename(&backup, &install_dir).is_ok();
        let registration_restored = uninstall_key.set_value("DisplayVersion", &previous_display_version).is_ok();
        return Err(if restored {
            format!("Updated Arc Power could not be launched; the previous files were restored{}: {error}",
                if registration_restored { "" } else { ", but the previous version registration could not be restored" })
        } else {
            format!("Updated Arc Power could not be launched; recovery files are at {} and {}{}: {error}", backup.display(), failed.display(),
                if registration_restored { "" } else { " and the previous version registration could not be restored" })
        });
    }

    if let Err(error) = remove_update_tree_checked(&backup) {
        eprintln!("Arc Power updated successfully; previous files remain at {}: {error}", backup.display());
    }
    Ok(())
}

#[cfg(windows)]
fn validate_registered_install(install_dir: &Path) -> Result<(), String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Arc Power")
        .map_err(|_| "Arc Power update registration is missing".to_owned())?;
    let name: String = key.get_value("DisplayName").map_err(|_| "Arc Power update registration is invalid")?;
    let registered_dir: String = key.get_value("InstallLocation").map_err(|_| "Arc Power update registration is invalid")?;
    let uninstall: String = key.get_value("UninstallString").map_err(|_| "Arc Power update registration is invalid")?;
    if !name.trim().eq_ignore_ascii_case("Arc Power") { return Err("Arc Power update registration identity conflicts with this installation".into()); }
    let registered_dir = PathBuf::from(registered_dir);
    reject_update_reparse(&registered_dir)?;
    let registered_dir = registered_dir.canonicalize().map_err(|_| "Arc Power update registration directory is unavailable")?;
    if !same_windows_path(install_dir, &registered_dir) { return Err("Arc Power update directory conflicts with its registration".into()); }
    let registered_executable = if uninstall.trim_start().starts_with('"') {
        uninstall.trim_start().trim_start_matches('"').split('"').next().unwrap_or("")
    } else { uninstall.split_whitespace().next().unwrap_or("") };
    let executable = PathBuf::from(registered_executable);
    reject_update_reparse(&executable)?;
    let executable = executable.canonicalize()
        .map_err(|_| "Arc Power uninstall registration does not identify an installed executable")?;
    if !same_windows_path(&executable, &install_dir.join("Arc Power.exe"))
        || !install_dir.join("Arc Power.exe").is_file() {
        return Err("Arc Power uninstall registration does not identify this installation".into());
    }
    Ok(())
}

#[cfg(windows)]
fn validate_native_payload(root: &Path) -> Result<(), String> {
    for &relative in NATIVE_PAYLOAD_FILES {
        let path = root.join(relative);
        reject_update_reparse(&path)?;
        if !path.is_file() { return Err(format!("Native update payload is missing {relative}")); }
    }
    Ok(())
}

#[cfg(windows)]
fn copy_update_tree(source: &Path, destination: &Path) -> Result<(), String> {
    reject_update_reparse(source)?;
    let metadata = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if is_update_reparse(&metadata) { return Err(format!("Update payload contains a reparse point: {}", source.display())); }
    if metadata.is_dir() {
        fs::create_dir_all(destination).map_err(|error| format!("Cannot create update directory: {error}"))?;
        for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            copy_update_tree(&entry.path(), &destination.join(entry.file_name()))?;
        }
        Ok(())
    } else if metadata.is_file() {
        if let Some(parent) = destination.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
        fs::copy(source, destination).map(|_| ()).map_err(|error| format!("Cannot copy update payload file: {error}"))
    } else { Err(format!("Update payload contains an unsupported entry: {}", source.display())) }
}

#[cfg(windows)]
fn verify_update_payload(source: &Path, destination: &Path) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    for &relative in NATIVE_PAYLOAD_FILES {
        let hash = |path: &Path| -> Result<String, String> {
            let mut file = File::open(path).map_err(|error| error.to_string())?;
            let mut hasher = Sha256::new();
            let mut buffer = [0u8; 64 * 1024];
            loop {
                let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
                if read == 0 { break; }
                hasher.update(&buffer[..read]);
            }
            Ok(hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect::<String>())
        };
        if hash(&source.join(relative))? != hash(&destination.join(relative))? {
            return Err(format!("Installed update verification failed for {relative}"));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_update_reparse(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(windows)]
fn remove_update_tree_checked(path: &Path) -> Result<(), String> {
    let canonical = path.canonicalize().map_err(|error| error.to_string())?;
    let parent = path.parent().ok_or("Update cleanup path has no parent")?.canonicalize().map_err(|error| error.to_string())?;
    if canonical.parent() != Some(parent.as_path()) || !path.file_name().is_some_and(|name| name.to_string_lossy().starts_with(".ArcPower-update-")) {
        return Err("Update cleanup path is outside the fixed recovery location".into());
    }
    validate_update_tree_without_reparse(&canonical)?;
    fs::remove_dir_all(path).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn validate_update_tree_without_reparse(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if is_update_reparse(&metadata) { return Err("Update recovery directory contains a reparse point".into()); }
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
            validate_update_tree_without_reparse(&entry.map_err(|error| error.to_string())?.path())?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn path_overlaps(left: &Path, right: &Path) -> bool {
    let left = left.to_string_lossy().to_ascii_lowercase();
    let right = right.to_string_lossy().to_ascii_lowercase();
    left == right || left.starts_with(&format!("{right}\\")) || right.starts_with(&format!("{left}\\"))
}

#[cfg(windows)]
fn show_update_error(message: &str) {
    let title: Vec<u16> = "Arc Power update failed\0".encode_utf16().collect();
    let text: Vec<u16> = format!("{message}\0").encode_utf16().collect();
    unsafe { windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x00000010); }
}

pub fn show_portable_update_error(message: &str) {
    #[cfg(windows)] show_update_error(message);
    #[cfg(not(windows))] eprintln!("Arc Power update failed: {message}");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installer_delegation_uses_fixed_runtime_and_native_payload_without_private_rpc() {
        let root = std::env::temp_dir().join("ArcPower-Tauri-Installer-Command-Test");
        let host = root.join("Arc Power.exe");
        let runtime = CompatibilityRuntime { executable: root.join("compatibility-backend/ArcPower.Backend.exe"), app_argument: None };
        let args = vec!["--update".into(), "--update-parent-pid".into(), "42".into(),
            "--update-install-dir".into(), root.join("installed").to_str().unwrap().into()];
        let child = installer_command(&runtime, &host, &args).unwrap();
        assert_eq!(child.get_program(), runtime.executable.as_os_str());
        assert_eq!(child.get_args().collect::<Vec<_>>(), args.iter().map(std::ffi::OsStr::new).collect::<Vec<_>>());
        let environment: std::collections::HashMap<_, _> = child.get_envs().collect();
        assert_eq!(environment.get(std::ffi::OsStr::new("ARC_POWER_TAURI_INSTALL_ROOT")), Some(&Some(root.as_os_str())));
        assert_eq!(environment.get(std::ffi::OsStr::new("ARC_POWER_TAURI_HOST_EXECUTABLE")), Some(&Some(host.as_os_str())));
        for name in ["ELECTRON_RUN_AS_NODE", "ARC_POWER_TAURI_SESSION", "ARC_POWER_TAURI_PIPE"] {
            assert_eq!(environment.get(std::ffi::OsStr::new(name)), Some(&None));
        }
        assert!(installer_command(&runtime, Path::new("relative/Arc Power.exe"), &args).is_err());
    }

    #[test]
    fn discovers_fixed_development_and_staged_distribution_without_executing_them() {
        let root = std::env::temp_dir().join(format!("ArcPower-Tauri-Discovery-Test-{}", rand::random::<u128>()));
        let development = root.join("checkout");
        let electron = development.join("node_modules/electron/dist/electron.exe");
        std::fs::create_dir_all(electron.parent().unwrap()).unwrap();
        std::fs::write(&electron, b"not an executable; discovery fixture only").unwrap();
        let host = root.join("host.exe");
        let found = discover_at(&host, Some(&development), None).unwrap();
        assert_eq!(found.executable, electron);
        assert_eq!(found.app_argument, Some(development.clone()));
        assert!(discover_at(&host, None, None).is_err());
        let backend = root.join("compatibility-backend");
        std::fs::create_dir_all(backend.join("resources")).unwrap();
        std::fs::write(backend.join("resources/app.asar"), b"archive fixture").unwrap();
        std::fs::write(backend.join("ArcPower.Backend.exe"), b"binary fixture").unwrap();
        let found = discover_at(&host, None, None).unwrap();
        assert_eq!(found.executable, backend.join("ArcPower.Backend.exe"));
        assert!(found.app_argument.is_none());
        // Remove only this exact fixture tree, with its resolved root checked.
        let resolved = root.canonicalize().unwrap();
        assert_eq!(resolved.parent().unwrap(), std::env::temp_dir().canonicalize().unwrap());
        assert!(resolved.file_name().unwrap().to_str().unwrap().starts_with("ArcPower-Tauri-Discovery-Test-"));
        std::fs::remove_dir_all(resolved).unwrap();
    }
}
