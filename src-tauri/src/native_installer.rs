//! Native setup and removal for the staged Tauri distribution.
//!
//! The installer entry is the same Tauri host copied to `Arc-Power_Installer.exe`.
//! It runs before Tauri/WebView initialization and uses only the filesystem,
//! per-user registry, Windows shell shortcuts, and a detached PowerShell cleanup
//! worker. The compatibility service remains a payload dependency for channels
//! which have not migrated yet.

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use crate::lifecycle::InstallerMode;

const PRODUCT: &str = "Arc Power";
const INSTALLED_EXE: &str = "Arc Power.exe";
const INSTALL_REGISTRY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Arc Power";
const START_MENU_RELATIVE: &str = r"Microsoft\Windows\Start Menu\Programs";
const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(windows)]
mod windows {
    use super::*;
    use winreg::{enums::{HKEY_CURRENT_USER, KEY_ENUMERATE_SUB_KEYS, KEY_QUERY_VALUE, KEY_SET_VALUE}, RegKey};

    fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(std::iter::once(0)).collect() }

    fn message(title: &str, body: &str, flags: u32) -> i32 {
        let title = wide(title);
        let body = wide(body);
        unsafe { windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(std::ptr::null_mut(), body.as_ptr(), title.as_ptr(), flags) }
    }

    fn powershell_path() -> PathBuf {
        std::env::var_os("SystemRoot").map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
            .join(r"System32\WindowsPowerShell\v1.0\powershell.exe")
    }

    fn ps_literal(value: &str) -> String { format!("'{}'", value.replace('\'', "''")) }

    fn powershell(script: &str) -> Result<(), String> {
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(
            script.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>());
        let mut command = Command::new(powershell_path());
        command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &encoded]);
        command.stdout(Stdio::null()).stderr(Stdio::piped());
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let output = command.output().map_err(|error| format!("Could not start Windows PowerShell: {error}"))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            return Err(if detail.is_empty() { format!("Windows shell operation failed ({})", output.status) }
                else { format!("Windows shell operation failed: {detail}") });
        }
        Ok(())
    }

    fn no_reparse_components(path: &Path) -> Result<(), String> {
        use std::os::windows::fs::MetadataExt;
        if !path.is_absolute() || path.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
            return Err("Arc Power paths must be absolute and cannot contain parent traversal".into());
        }
        let mut current = PathBuf::new();
        for part in path.components() {
            current.push(part.as_os_str());
            if let Ok(metadata) = fs::symlink_metadata(&current) {
                if metadata.file_attributes() & 0x400 != 0 || metadata.file_type().is_symlink() {
                    return Err(format!("Refusing a link or reparse point in an Arc Power path: {}", current.display()));
                }
            }
        }
        Ok(())
    }

    fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
        use std::os::windows::fs::MetadataExt;
        no_reparse_components(source)?;
        let metadata = fs::symlink_metadata(source).map_err(|error| format!("Cannot inspect payload entry {}: {error}", source.display()))?;
        if metadata.file_attributes() & 0x400 != 0 || metadata.file_type().is_symlink() {
            return Err(format!("Installer payload contains a reparse point: {}", source.display()));
        }
        if metadata.is_dir() {
            fs::create_dir_all(destination).map_err(|error| format!("Cannot create install directory: {error}"))?;
            for entry in fs::read_dir(source).map_err(|error| format!("Cannot read installer payload: {error}"))? {
                let entry = entry.map_err(|error| error.to_string())?;
                copy_tree(&entry.path(), &destination.join(entry.file_name()))?;
            }
            Ok(())
        } else if metadata.is_file() {
            if let Some(parent) = destination.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
            fs::copy(source, destination).map(|_| ()).map_err(|error| format!("Cannot copy {}: {error}", source.display()))
        } else { Err(format!("Unsupported installer payload entry: {}", source.display())) }
    }

    fn source_payload_root() -> Result<PathBuf, String> {
        let host = std::env::current_exe().map_err(|error| error.to_string())?;
        let source_parent = host.parent().ok_or("Cannot locate the Arc Power setup payload")?;
        no_reparse_components(source_parent)?;
        let root = source_parent.canonicalize()
            .map_err(|error| format!("Cannot resolve the Arc Power setup payload: {error}"))?;
        no_reparse_components(&root)?;
        for &relative in crate::runtime::NATIVE_PAYLOAD_FILES {
            if !root.join(relative).is_file() { return Err(format!("Setup payload is incomplete: {relative} is missing")); }
        }
        Ok(root)
    }

    fn required_env(name: &str) -> Result<PathBuf, String> {
        let value = std::env::var_os(name).ok_or_else(|| format!("Windows did not provide {name}"))?;
        let path = PathBuf::from(value);
        if !path.is_absolute() { return Err(format!("Windows returned an invalid {name} path")); }
        Ok(path)
    }

    fn installation_dir() -> Result<PathBuf, String> {
        // The packaged setup runs elevated and installs for all users by
        // default. A non-elevated/dev host falls back to the per-user Programs
        // folder so the same entry point still works.
        let base = std::env::var_os("ProgramFiles").map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .or_else(|| std::env::var_os("ProgramW6432").map(PathBuf::from)
                .filter(|path| path.is_absolute()));
        let root = match base {
            Some(base) => base.join(PRODUCT),
            None => required_env("LOCALAPPDATA")?.join("Programs").join(PRODUCT),
        };
        if !root.is_absolute() || root.parent().is_none() { return Err("Invalid Arc Power install location".into()); }
        Ok(root)
    }

    fn registry_key() -> RegKey {
        RegKey::predef(HKEY_CURRENT_USER)
    }

    fn registered_install_dir() -> Result<Option<PathBuf>, String> {
        let key = registry_key();
        let key = match key.open_subkey_with_flags(INSTALL_REGISTRY, KEY_QUERY_VALUE) {
            Ok(key) => key,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("Cannot read Arc Power setup registration: {error}")),
        };
        // Legacy installers may leave a different DisplayName or omit
        // InstallLocation entirely. A stale registration must not block an
        // upgrade; treat anything under the Arc Power key as ours and let the
        // caller decide whether the registered folder still contains the app.
        let name: String = match key.get_value("DisplayName") {
            Ok(value) => value,
            Err(_) => return Ok(None),
        };
        let lower = name.trim().to_ascii_lowercase();
        if !lower.starts_with("arc power") { return Ok(None); }
        let value: String = match key.get_value("InstallLocation") {
            Ok(value) => value,
            Err(_) => return Ok(None),
        };
        if value.trim().is_empty() { return Ok(None); }
        let path = PathBuf::from(value);
        if no_reparse_components(&path).is_err() { return Ok(None); }
        Ok(Some(path))
    }

    fn process_check(current_pid: u32) -> Result<(), String> {
        // Enumerate processes natively. The previous PowerShell/WMI check
        // surfaced CLIXML progress records as the user-facing error and made a
        // running Arc Power look like a shell failure.
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err("Setup could not check running Arc Power copies. Close Arc Power and retry.".into());
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut running = false;
            let mut found = Process32FirstW(snapshot, &mut entry) != 0;
            while found {
                if entry.th32ProcessID != current_pid {
                    let length = entry.szExeFile.iter().position(|unit| *unit == 0)
                        .unwrap_or(entry.szExeFile.len());
                    let name = String::from_utf16_lossy(&entry.szExeFile[..length]);
                    if name.eq_ignore_ascii_case(INSTALLED_EXE) { running = true; break; }
                }
                found = Process32NextW(snapshot, &mut entry) != 0;
            }
            let _ = CloseHandle(snapshot);
            if running {
                Err("Close Arc Power before installing or removing it, then retry.".into())
            } else {
                Ok(())
            }
        }
    }

    fn write_registration(install_dir: &Path) -> Result<(), String> {
        let key = registry_key().create_subkey(INSTALL_REGISTRY).map_err(|error| format!("Cannot register Arc Power with Windows: {error}"))?.0;
        let executable = install_dir.join(INSTALLED_EXE);
        let uninstall = format!("\"{}\" --uninstall", executable.display());
        let icon = format!("{},0", install_dir.join("resources/ArcPowerTaskbar-blue-gradient.ico").display());
        for (name, value) in [
            ("DisplayName", PRODUCT.to_owned()), ("DisplayVersion", VERSION.to_owned()),
            ("Publisher", "R.ID".to_owned()), ("InstallLocation", install_dir.to_string_lossy().into_owned()),
            ("UninstallString", uninstall.clone()), ("QuietUninstallString", uninstall), ("DisplayIcon", icon),
        ] { key.set_value(name, &value).map_err(|error| format!("Cannot write Arc Power registration: {error}"))?; }
        key.set_value("NoModify", &1u32).map_err(|error| error.to_string())?;
        key.set_value("NoRepair", &1u32).map_err(|error| error.to_string())?;
        Ok(())
    }

    fn create_shortcut(path: &Path, executable: &Path, install_dir: &Path, icon: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|error| format!("Cannot create shortcut directory: {error}"))?; }
        let script = format!(
            "$ErrorActionPreference='Stop'; $shell=New-Object -ComObject WScript.Shell; $link=$shell.CreateShortcut({}); $link.TargetPath={}; $link.WorkingDirectory={}; $link.Description={}; $link.IconLocation={}; $link.Save()",
            ps_literal(&path.to_string_lossy()), ps_literal(&executable.to_string_lossy()),
            ps_literal(&install_dir.to_string_lossy()), ps_literal(PRODUCT), ps_literal(&format!("{},0", icon.display()))
        );
        powershell(&script)
    }

    fn register_shortcuts(install_dir: &Path, desktop: bool) -> Result<(), String> {
        let paths = shortcut_paths(desktop)?;
        let executable = install_dir.join(INSTALLED_EXE);
        let icon = install_dir.join("resources/ArcPowerTaskbar-blue-gradient.ico");
        for path in paths { create_shortcut(&path, &executable, install_dir, &icon)?; }
        Ok(())
    }

    fn shortcut_paths(desktop: bool) -> Result<Vec<PathBuf>, String> {
        let mut paths = vec![required_env("APPDATA")?.join(START_MENU_RELATIVE).join("Arc Power.lnk")];
        if desktop { paths.push(required_env("USERPROFILE")?.join("Desktop").join("Arc Power.lnk")); }
        Ok(paths)
    }

    type RegistrationSnapshot = Option<Vec<(String, winreg::RegValue<'static>)>>;

    fn snapshot_registration() -> Result<RegistrationSnapshot, String> {
        let root = registry_key();
        let key = match root.open_subkey_with_flags(INSTALL_REGISTRY, KEY_QUERY_VALUE) {
            Ok(key) => key,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("Cannot preserve the current Arc Power registration: {error}")),
        };
        let mut values = Vec::new();
        for entry in key.enum_values() {
            let (name, value) = entry.map_err(|error| format!("Cannot preserve the current Arc Power registration: {error}"))?;
            values.push((name, value));
        }
        Ok(Some(values))
    }

    fn restore_registration(snapshot: RegistrationSnapshot) -> Result<(), String> {
        let root = registry_key();
        let key = match root.open_subkey_with_flags(INSTALL_REGISTRY, KEY_QUERY_VALUE | KEY_SET_VALUE | KEY_ENUMERATE_SUB_KEYS) {
            Ok(key) => key,
            Err(error) if snapshot.is_none() && error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("Cannot reopen the Arc Power registration during setup rollback: {error}")),
        };
        if let Some(values) = snapshot {
            let original_names: Vec<String> = values.iter().map(|(name, _)| name.to_ascii_lowercase()).collect();
            let current_names = key.enum_values().map(|entry| entry.map(|(name, _)| name))
                .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
            for name in current_names {
                if !original_names.iter().any(|original| original == &name.to_ascii_lowercase()) {
                    key.delete_value(&name).map_err(|error| format!("Cannot roll back Arc Power registration value {name}: {error}"))?;
                }
            }
            for (name, value) in values {
                key.set_raw_value(&name, &value).map_err(|error| format!("Cannot restore Arc Power registration value {name}: {error}"))?;
            }
        } else {
            let current_names = key.enum_values().map(|entry| entry.map(|(name, _)| name))
                .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
            for name in ["DisplayName", "DisplayVersion", "Publisher", "InstallLocation", "UninstallString",
                "QuietUninstallString", "DisplayIcon", "NoModify", "NoRepair"] {
                if current_names.iter().any(|current| current.eq_ignore_ascii_case(name)) {
                    key.delete_value(name).map_err(|error| format!("Cannot remove partial Arc Power registration value {name}: {error}"))?;
                }
            }
            let values_left = key.enum_values().collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
            let subkeys_left = key.enum_keys().collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
            if values_left.is_empty() && subkeys_left.is_empty() {
                root.delete_subkey(INSTALL_REGISTRY).map_err(|error| format!("Cannot remove partial Arc Power registration: {error}"))?;
            }
        }
        Ok(())
    }

    struct ShortcutSnapshot { path: PathBuf, contents: Option<Vec<u8>> }

    fn snapshot_shortcut(path: &Path) -> Result<ShortcutSnapshot, String> {
        use std::os::windows::fs::MetadataExt;
        no_reparse_components(path)?;
        let contents = match fs::symlink_metadata(path) {
            Ok(metadata) => {
                if metadata.file_attributes() & 0x400 != 0 || metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(format!("Refusing to replace an unsafe shortcut: {}", path.display()));
                }
                Some(fs::read(path).map_err(|error| format!("Cannot preserve shortcut {}: {error}", path.display()))?)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("Cannot inspect shortcut {}: {error}", path.display())),
        };
        Ok(ShortcutSnapshot { path: path.to_path_buf(), contents })
    }

    fn restore_shortcut(snapshot: ShortcutSnapshot) -> Result<(), String> {
        no_reparse_components(&snapshot.path)?;
        match snapshot.contents {
            Some(bytes) => {
                if let Some(parent) = snapshot.path.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
                fs::write(&snapshot.path, bytes).map_err(|error| format!("Cannot restore shortcut {}: {error}", snapshot.path.display()))
            }
            None => match fs::remove_file(&snapshot.path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(format!("Cannot remove partial shortcut {}: {error}", snapshot.path.display())),
            },
        }
    }

    fn remove_tree(path: &Path) -> Result<(), String> {
        if !path.exists() { return Ok(()); }
        no_reparse_components(path)?;
        fs::remove_dir_all(path).map_err(|error| format!("Could not remove {}: {error}", path.display()))
    }

    /// A prior install tree contains only what the setup payload writes.
    /// Anything else (a recording folder, a user file) makes the folder
    /// non-disposable; the installer keeps it and tells the user.
    fn removable_install_tree(path: &Path) -> bool {
        let known = ["Arc Power.exe", "resources", "CHANGELOG.md", "uninstall.exe"];
        let Ok(entries) = fs::read_dir(path) else { return false; };
        entries.filter_map(Result::ok).all(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            known.iter().any(|known| name.eq_ignore_ascii_case(known))
        })
    }

    fn install() -> Result<i32, String> {
        let source = source_payload_root()?;
        let default_dir = installation_dir()?;
        let registered = registered_install_dir()?;
        let (install_dir, old_install_dir) = match registered {
            Some(registered) if registered.is_dir() && registered.join(INSTALLED_EXE).is_file() => {
                let local_programs = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
                    .map(|path| path.join("Programs"));
                let under_local = local_programs.as_ref().is_some_and(|local| registered.starts_with(local));
                if under_local && !same_path(&registered, &default_dir) {
                    let move_to_default = message("Arc Power Setup", &format!(
                        "Arc Power is currently installed for this Windows account in:\n{}\n\nMove it to the standard all-users location?\n{}\n\nYour profiles and recordings are kept. Choose No to keep the current location.",
                        registered.display(), default_dir.display()), 0x00000024) == 6;
                    if move_to_default { (default_dir, Some(registered)) } else { (registered, None) }
                } else { (registered, None) }
            }
            // A stale registration, or a default folder with the app in it,
            // is replaced in place instead of blocking the upgrade.
            _ => (default_dir, None),
        };
        // A differently-keyed 1.3.2/1.3.3 registration can leave the old
        // per-user folder behind. If it is the product's default folder and
        // still contains the app, remove it after the new install lands.
        let stale_per_user = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
            .map(|path| path.join("Programs").join(PRODUCT))
            .filter(|path| !same_path(path, &install_dir) && path.join(INSTALLED_EXE).is_file());
        let old_install_dir = old_install_dir.or(stale_per_user);
        if source.ancestors().any(|parent| same_path(parent, &install_dir))
            || install_dir.ancestors().any(|parent| same_path(parent, &source))
        {
            return Err("Setup payload and install location must be separate folders".into());
        }
        no_reparse_components(&install_dir)?;
        if install_dir.exists() && fs::read_dir(&install_dir).map_err(|error| error.to_string())?.next().is_some()
            && !install_dir.join(INSTALLED_EXE).is_file() {
            return Err("The Arc Power install folder already contains files but no Arc Power executable. Choose an empty folder or remove it first.".into());
        }
        let desktop = message("Arc Power Setup", "Create a desktop shortcut? Choose No to use only the Start Menu shortcut.", 0x00000024) == 6;
        let confirm = message("Arc Power Setup", &format!("Install Arc Power {VERSION} for this Windows account?\n\nInstall location:\n{}\n\nYour ArcPower profile data will be preserved.", install_dir.display()), 0x00000024);
        if confirm != 6 { return Ok(0); }
        process_check(std::process::id())?;
        let registration_snapshot = snapshot_registration()?;
        let shortcut_snapshots = shortcut_paths(desktop)?.iter().map(|path| snapshot_shortcut(path))
            .collect::<Result<Vec<_>, _>>()?;

        let parent = install_dir.parent().ok_or("Invalid Arc Power install location")?;
        fs::create_dir_all(parent).map_err(|error| format!("Cannot create install parent: {error}"))?;
        let pid = std::process::id();
        let stage = parent.join(format!(".ArcPower-install-{pid}.stage"));
        let backup = parent.join(format!(".ArcPower-install-{pid}.backup"));
        if stage.exists() || backup.exists() { return Err("A previous setup recovery folder needs attention".into()); }
        fs::create_dir(&stage).map_err(|error| format!("Cannot create setup staging directory: {error}"))?;
        let copied = (|| {
            copy_tree(&source.join(INSTALLED_EXE), &stage.join(INSTALLED_EXE))?;
            copy_tree(&source.join("resources"), &stage.join("resources"))
        })();
        if let Err(error) = copied { let _ = remove_tree(&stage); return Err(error); }
        process_check(std::process::id())?;
        let had_install = install_dir.exists();
        if had_install {
            let registered_here = registered_install_dir()?.is_some_and(|registered| same_path(&registered, &install_dir));
            let known_app = install_dir.join(INSTALLED_EXE).is_file();
            if !registered_here && !known_app {
                let _ = remove_tree(&stage);
                return Err("Refusing to replace an unregistered folder at the Arc Power install location".into());
            }
            fs::rename(&install_dir, &backup).map_err(|error| format!("Cannot preserve the previous Arc Power files: {error}"))?;
        }
        if let Err(error) = fs::rename(&stage, &install_dir) {
            if had_install { let _ = fs::rename(&backup, &install_dir); }
            let _ = remove_tree(&stage);
            return Err(format!("Cannot install Arc Power: {error}"));
        }
        let finalize = register_shortcuts(&install_dir, desktop)
            .and_then(|_| write_registration(&install_dir))
            .map(|_| remove_legacy_uninstall_keys(&install_dir));
        if let Err(error) = finalize {
            let mut rollback_errors = Vec::new();
            if let Err(rollback) = restore_registration(registration_snapshot) { rollback_errors.push(rollback); }
            for snapshot in shortcut_snapshots.into_iter().rev() {
                if let Err(rollback) = restore_shortcut(snapshot) { rollback_errors.push(rollback); }
            }
            if let Err(rollback) = remove_tree(&install_dir) { rollback_errors.push(rollback); }
            if had_install {
                if let Err(rollback) = fs::rename(&backup, &install_dir) {
                    rollback_errors.push(format!("Could not restore the prior install from {}: {rollback}", backup.display()));
                }
            }
            return Err(if rollback_errors.is_empty() {
                format!("Setup failed and restored the previous Arc Power files and Windows registration: {error}")
            } else {
                format!("Setup failed: {error}. Rollback needs attention: {}", rollback_errors.join("; "))
            });
        }
        if had_install {
            if removable_install_tree(&backup) { let _ = remove_tree(&backup); }
            else {
                let _ = message("Arc Power Setup", &format!(
                    "The previous Arc Power folder was kept because it also contains files Setup did not install:\n{}\n\nYou can remove it after checking those files.", backup.display()), 0x00000040);
            }
        }
        // A one-time move from the per-user location leaves the old folder
        // behind; remove it only after the new install and registration landed.
        if let Some(old) = old_install_dir {
            if !same_path(&old, &install_dir) {
                if removable_install_tree(&old) { let _ = remove_tree(&old); }
                else {
                    let _ = message("Arc Power Setup", &format!(
                        "The previous per-user folder was kept because it also contains files Setup did not install:\n{}\n\nYour profiles and recordings are unaffected. You can remove that folder after checking those files.", old.display()), 0x00000040);
                }
            }
        }
        if message("Arc Power Setup", "Arc Power is installed. Launch it now?", 0x00000024) == 6 {
            let mut launch = Command::new(install_dir.join(INSTALLED_EXE));
            launch.current_dir(&install_dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            use std::os::windows::process::CommandExt;
            launch.creation_flags(0x00000008 | 0x00000200);
            launch.spawn().map_err(|error| format!("Arc Power installed, but it could not be launched: {error}"))?;
        }
        Ok(0)
    }

    pub struct SetupPlan {
        pub version: &'static str,
        pub default_dir: PathBuf,
        pub registered_dir: Option<PathBuf>,
    }

    pub struct InstallSelection {
        pub install_dir: PathBuf,
        pub old_install_dir: Option<PathBuf>,
        pub desktop_shortcut: bool,
    }

    pub fn setup_plan() -> Result<SetupPlan, String> {
        let default_dir = installation_dir()?;
        let registered_dir = registered_install_dir()?
            .filter(|dir| dir.is_dir() && dir.join(INSTALLED_EXE).is_file());
        Ok(SetupPlan { version: VERSION, default_dir, registered_dir })
    }

    /// Option-driven install used by the WebView setup. It runs the same
    /// validation, staging, registration, shortcut and rollback steps as the
    /// classic prompt flow, but never opens a message box.
    pub fn install_selected(selection: InstallSelection) -> Result<(), String> {
        let source = source_payload_root()?;
        let install_dir = selection.install_dir;
        let desktop = selection.desktop_shortcut;
        let old_install_dir = selection.old_install_dir
            .filter(|old| !same_path(old, &install_dir));
        if source.ancestors().any(|parent| same_path(parent, &install_dir))
            || install_dir.ancestors().any(|parent| same_path(parent, &source))
        {
            return Err("Setup payload and install location must be separate folders".into());
        }
        no_reparse_components(&install_dir)?;
        if install_dir.exists() && fs::read_dir(&install_dir).map_err(|error| error.to_string())?.next().is_some()
            && !install_dir.join(INSTALLED_EXE).is_file() {
            return Err("The Arc Power install folder already contains files but no Arc Power executable. Choose an empty folder or remove it first.".into());
        }
        process_check(std::process::id())?;
        let registration_snapshot = snapshot_registration()?;
        let shortcut_snapshots = shortcut_paths(desktop)?.iter().map(|path| snapshot_shortcut(path))
            .collect::<Result<Vec<_>, _>>()?;
        let parent = install_dir.parent().ok_or("Invalid Arc Power install location")?;
        fs::create_dir_all(parent).map_err(|error| format!("Cannot create install parent: {error}"))?;
        let pid = std::process::id();
        let stage = parent.join(format!(".ArcPower-install-{pid}.stage"));
        let backup = parent.join(format!(".ArcPower-install-{pid}.backup"));
        if stage.exists() || backup.exists() { return Err("A previous setup recovery folder needs attention".into()); }
        fs::create_dir(&stage).map_err(|error| format!("Cannot create setup staging directory: {error}"))?;
        let copied = (|| {
            copy_tree(&source.join(INSTALLED_EXE), &stage.join(INSTALLED_EXE))?;
            copy_tree(&source.join("resources"), &stage.join("resources"))
        })();
        if let Err(error) = copied { let _ = remove_tree(&stage); return Err(error); }
        process_check(std::process::id())?;
        let had_install = install_dir.exists();
        if had_install {
            let registered_here = registered_install_dir()?.is_some_and(|registered| same_path(&registered, &install_dir));
            let known_app = install_dir.join(INSTALLED_EXE).is_file();
            if !registered_here && !known_app {
                let _ = remove_tree(&stage);
                return Err("Refusing to replace an unregistered folder at the Arc Power install location".into());
            }
            fs::rename(&install_dir, &backup).map_err(|error| format!("Cannot preserve the previous Arc Power files: {error}"))?;
        }
        if let Err(error) = fs::rename(&stage, &install_dir) {
            if had_install { let _ = fs::rename(&backup, &install_dir); }
            let _ = remove_tree(&stage);
            return Err(format!("Cannot install Arc Power: {error}"));
        }
        let finalize = register_shortcuts(&install_dir, desktop)
            .and_then(|_| write_registration(&install_dir))
            .map(|_| remove_legacy_uninstall_keys(&install_dir));
        if let Err(error) = finalize {
            let mut rollback_errors = Vec::new();
            if let Err(rollback) = restore_registration(registration_snapshot) { rollback_errors.push(rollback); }
            for snapshot in shortcut_snapshots.into_iter().rev() {
                if let Err(rollback) = restore_shortcut(snapshot) { rollback_errors.push(rollback); }
            }
            if let Err(rollback) = remove_tree(&install_dir) { rollback_errors.push(rollback); }
            if had_install {
                if let Err(rollback) = fs::rename(&backup, &install_dir) {
                    rollback_errors.push(format!("Could not restore the prior install from {}: {rollback}", backup.display()));
                }
            }
            return Err(if rollback_errors.is_empty() {
                format!("Setup failed and restored the previous Arc Power files and Windows registration: {error}")
            } else {
                format!("Setup failed: {error}. Rollback needs attention: {}", rollback_errors.join("; "))
            });
        }
        if had_install {
            if removable_install_tree(&backup) { let _ = remove_tree(&backup); }
        }
        if let Some(old) = old_install_dir {
            if !same_path(&old, &install_dir) && removable_install_tree(&old) { let _ = remove_tree(&old); }
        }
        Ok(())
    }

    pub fn launch_installed(install_dir: &Path) -> Result<(), String> {
        let mut launch = Command::new(install_dir.join(INSTALLED_EXE));
        launch.current_dir(install_dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        use std::os::windows::process::CommandExt;
        launch.creation_flags(0x00000008 | 0x00000200);
        launch.spawn().map(|_| ()).map_err(|error| format!("Arc Power installed, but it could not be launched: {error}"))
    }

    /// Option-driven uninstall used by the WebView uninstaller. The cleanup
    /// helper still waits for this process to exit before deleting the folder.
    pub fn uninstall_selected() -> Result<(), String> {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        no_reparse_components(&executable)?;
        let install_path = executable.parent().ok_or("Cannot locate installed Arc Power")?;
        no_reparse_components(install_path)?;
        let install_dir = install_path.canonicalize()
            .map_err(|error| format!("Cannot resolve installed Arc Power: {error}"))?;
        validate_registered_install(&install_dir)?;
        process_check(std::process::id())?;
        let pid = std::process::id();
        let temp = std::env::temp_dir();
        no_reparse_components(&temp)?;
        let helper = temp.join(format!("arc-power-uninstall-{pid}-{}.ps1", rand::random::<u128>()));
        let script = cleanup_script(pid, &install_dir, &executable, &helper)?;
        use std::io::Write;
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&helper)
            .map_err(|error| format!("Cannot prepare uninstall helper: {error}"))?;
        file.write_all(b"\xEF\xBB\xBF").and_then(|_| file.write_all(script.as_bytes()))
            .map_err(|error| format!("Cannot write uninstall helper: {error}"))?;
        file.sync_all().map_err(|error| format!("Cannot flush uninstall helper: {error}"))?;
        let recovery = format!("\"{}\" -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"{}\" -Retry", powershell_path().display(), helper.display());
        if let Err(error) = set_recovery_registration(&install_dir, &recovery) {
            let _ = fs::remove_file(&helper);
            return Err(error);
        }
        let mut child = Command::new(powershell_path());
        child.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&helper).current_dir(&temp).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        use std::os::windows::process::CommandExt;
        child.creation_flags(0x00000008 | 0x00000200);
        if let Err(error) = child.spawn() {
            let _ = fs::remove_file(&helper);
            let _ = set_recovery_registration(&install_dir, &format!("\"{}\" --uninstall", executable.display()));
            return Err(format!("Could not start Arc Power removal: {error}"));
        }
        Ok(())
    }

    fn uninstall() -> Result<i32, String> {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        no_reparse_components(&executable)?;
        let install_path = executable.parent().ok_or("Cannot locate installed Arc Power")?;
        no_reparse_components(install_path)?;
        let install_dir = install_path.canonicalize()
            .map_err(|error| format!("Cannot resolve installed Arc Power: {error}"))?;
        validate_registered_install(&install_dir)?;
        let confirm = message("Remove Arc Power", &format!(
            "Remove Arc Power from this computer?\n\nThis removes the application, Arc Power caches, and saved profiles under AppData\\ArcPower. Recordings and files elsewhere are kept.\n\n{}",
            install_dir.display()), 0x00000024);
        if confirm != 6 { return Ok(0); }
        process_check(std::process::id())?;
        let pid = std::process::id();
        let temp = std::env::temp_dir();
        no_reparse_components(&temp)?;
        let helper = temp.join(format!("arc-power-uninstall-{pid}-{}.ps1", rand::random::<u128>()));
        let script = cleanup_script(pid, &install_dir, &executable, &helper)?;
        use std::io::Write;
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&helper)
            .map_err(|error| format!("Cannot prepare uninstall helper: {error}"))?;
        // Windows PowerShell 5.1 treats scripts without a BOM as ANSI.
        file.write_all(b"\xEF\xBB\xBF").and_then(|_| file.write_all(script.as_bytes()))
            .map_err(|error| format!("Cannot write uninstall helper: {error}"))?;
        file.sync_all().map_err(|error| format!("Cannot flush uninstall helper: {error}"))?;
        let recovery = format!("\"{}\" -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"{}\" -Retry", powershell_path().display(), helper.display());
        if let Err(error) = set_recovery_registration(&install_dir, &recovery) {
            let _ = fs::remove_file(&helper);
            return Err(error);
        }
        let mut child = Command::new(powershell_path());
        child.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&helper).current_dir(&temp).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        use std::os::windows::process::CommandExt;
        child.creation_flags(0x00000008 | 0x00000200);
        if let Err(error) = child.spawn() {
            let _ = fs::remove_file(&helper);
            let _ = set_recovery_registration(&install_dir, &format!("\"{}\" --uninstall", executable.display()));
            return Err(format!("Could not start Arc Power removal: {error}"));
        }
        Ok(0)
    }

    fn validate_registered_install(install_dir: &Path) -> Result<(), String> {
        // The uninstaller runs from the installed executable. A stale or
        // malformed registration from a prior release must not make the
        // uninstaller a no-op; the cleanup script removes the fixed key and
        // the folder this executable actually lives in.
        let executable = install_dir.join(INSTALLED_EXE).canonicalize()
            .map_err(|_| "Installed Arc Power executable is unavailable")?;
        let current = std::env::current_exe().map_err(|error| error.to_string())?.canonicalize()
            .map_err(|_| "Cannot resolve the running Arc Power executable")?;
        if !same_path(&executable, &current) {
            return Err("Arc Power uninstall must run from the installed executable".into());
        }
        Ok(())
    }

    fn set_recovery_registration(install_dir: &Path, uninstall: &str) -> Result<(), String> {
        let key = registry_key().create_subkey(INSTALL_REGISTRY)
            .map_err(|error| format!("Cannot preserve Arc Power removal recovery: {error}"))?.0;
        for (name, value) in [("UninstallString", uninstall.to_owned()), ("QuietUninstallString", uninstall.to_owned()),
            ("InstallLocation", install_dir.to_string_lossy().into_owned())] {
            key.set_value(name, &value).map_err(|error| format!("Cannot preserve Arc Power removal recovery: {error}"))?;
        }
        Ok(())
    }

    /// Remove a differently-named legacy uninstall entry left by an earlier
    /// setup. The fixed Arc Power key is overwritten by `write_registration`;
    /// this only cleans entries that identify this product and this (or a now
    /// missing) install folder, so a normal upgrade leaves one entry.
    fn remove_legacy_uninstall_keys(_install_dir: &Path) {
        let root = registry_key();
        let Ok(uninstall) = root.open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall", KEY_ENUMERATE_SUB_KEYS) else { return; };
        for name in uninstall.enum_keys().flatten() {
            if name.eq_ignore_ascii_case(PRODUCT) { continue; }
            let Ok(key) = uninstall.open_subkey_with_flags(&name, KEY_QUERY_VALUE) else { continue; };
            let Ok(display) = key.get_value::<String, _>("DisplayName") else { continue; };
            let lower = display.trim().to_ascii_lowercase();
            if lower != "arc power" && !lower.starts_with("arc power ") { continue; }
            let publisher = key.get_value::<String, _>("Publisher").unwrap_or_default();
            if !publisher.trim().is_empty() && !publisher.eq_ignore_ascii_case("R.ID") { continue; }
            // DisplayName + Publisher identify this product. The install folder
            // may be the old per-user path, a missing path, or the new all-users
            // path; any of them is the same legacy entry and must not survive.
            let _ = uninstall.delete_subkey(&name);
        }
    }

    fn cleanup_script(pid: u32, install_dir: &Path, executable: &Path, script_path: &Path) -> Result<String, String> {
        let app_data = required_env("APPDATA")?;
        let local = required_env("LOCALAPPDATA")?;
        let profile = app_data.join("ArcPower");
        let documents = required_env("USERPROFILE")?.join("Documents");
        let monitor_logs = documents.join("Arc Power");
        let start_menu = app_data.join(START_MENU_RELATIVE).join("Arc Power.lnk");
        let desktop = required_env("USERPROFILE")?.join("Desktop").join("Arc Power.lnk");
        let recovery_command = format!("\"{}\" -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"{}\" -Retry", powershell_path().display(), script_path.display());
        let cache_paths = [app_data.join("ArcPowerCache"), app_data.join("ArcPowerTauriCache"), app_data.join("arc-power"), app_data.join("rid-arc-power"),
            local.join("ArcPowerCache"), local.join("ArcPowerSetupCache"), local.join("arc-power"), local.join("rid-arc-power"), local.join("Arc Power/Cache")];
        let cache_literals = cache_paths.iter().map(|path| ps_literal(&path.to_string_lossy())).collect::<Vec<_>>().join(",");
        let cleanup_paths = [start_menu.clone(), desktop.clone(), profile.clone(), install_dir.to_path_buf()];
        let cleanup_literals = cleanup_paths.iter().map(|path| ps_literal(&path.to_string_lossy())).collect::<Vec<_>>().join(",");
        let tasks = ["ArcPowerStartup", "ArcPowerBootApply", "ArcPowerAppOnBoot", "ArcPowerApplyOnBoot"]
            .iter().map(|value| ps_literal(value)).collect::<Vec<_>>().join(",");
        let run_values = ["ArcPower", "Arc Power", "ArcPowerRTSS"].iter().map(|value| ps_literal(value)).collect::<Vec<_>>().join(",");
        let app_data_literal = ps_literal(&app_data.to_string_lossy());
        let profile_literal = ps_literal(&profile.to_string_lossy());
        let local_literal = ps_literal(&local.to_string_lossy());
        let docs_literal = ps_literal(&monitor_logs.to_string_lossy());
        let executable_literal = ps_literal(&executable.to_string_lossy());
        let install_literal = ps_literal(&install_dir.to_string_lossy());
        let recovery_literal = ps_literal(&recovery_command);
        let script_literal = ps_literal(&script_path.to_string_lossy());
        let script = format!(r#"
param([switch]$Retry)
$ErrorActionPreference='Continue'
$parentPid={pid}
$installDir={install_literal}
$executable={executable_literal}
$scriptPath={script_literal}
$profilePath={profile_literal}
$monitorLogPath={docs_literal}
$cachePaths=@({cache_literals})
$cleanupPaths=@({cleanup_literals})
$taskNames=@({tasks})
$runValueNames=@({run_values})
$appData={app_data_literal}
$localAppData={local_literal}
$recoveryCommand={recovery_literal}
$uninstallKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Arc Power'
$script:processQueryFailed=$false
Set-Location -LiteralPath $env:TEMP
function Write-Diagnostic([string]$message) {{ try {{ Add-Content -LiteralPath ($scriptPath+'.log') -Value ("{{0:u}} {{1}}" -f [DateTime]::UtcNow,$message) -Encoding UTF8 }} catch {{}} }}
function Test-OwnedPath([string]$candidate) {{ try {{ $root=[IO.Path]::GetFullPath($installDir).TrimEnd('\')+'\'; return [IO.Path]::GetFullPath($candidate).StartsWith($root,[StringComparison]::OrdinalIgnoreCase) }} catch {{ return $false }} }}
function Get-OwnedProcesses {{ try {{ return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {{ $_.ExecutablePath -and (Test-OwnedPath ([string]$_.ExecutablePath)) }}) }} catch {{ $script:processQueryFailed=$true; Write-Diagnostic $_.Exception.Message; return @() }} }}
function Test-NoReparse([string]$target) {{
  try {{
    if (-not (Test-Path -LiteralPath $target -ErrorAction Stop)) {{ return $true }}
    $root=Get-Item -LiteralPath $target -Force -ErrorAction Stop
    if ($root.Attributes -band [IO.FileAttributes]::ReparsePoint) {{ Write-Diagnostic ("refusing reparse point: {{0}}" -f $target); return $false }}
    if ($root.PSIsContainer) {{ foreach ($child in @(Get-ChildItem -LiteralPath $target -Force -ErrorAction Stop)) {{ if (-not (Test-NoReparse $child.FullName)) {{ return $false }} }} }}
    return $true
  }} catch {{ Write-Diagnostic ("could not inspect {{0}}: {{1}}" -f $target,$_.Exception.Message); return $false }}
}}
function Test-NoReparseParents([string]$target) {{
  try {{
    $parent=[IO.Directory]::GetParent([IO.Path]::GetFullPath($target))
    while ($null -ne $parent) {{
      if (Test-Path -LiteralPath $parent.FullName -ErrorAction Stop) {{
        $item=Get-Item -LiteralPath $parent.FullName -Force -ErrorAction Stop
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {{ return $false }}
      }}
      $parent=$parent.Parent
    }}
    return $true
  }} catch {{ return $false }}
}}
function Remove-Exact([string]$target) {{
  try {{
    if (-not (Test-NoReparseParents $target)) {{ return $false }}
    if (-not (Test-Path -LiteralPath $target -ErrorAction Stop)) {{ return $true }}
    if (-not (Test-NoReparse $target)) {{ return $false }}
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
    return -not (Test-Path -LiteralPath $target -ErrorAction Stop)
  }} catch {{ Write-Diagnostic ("could not remove {{0}}: {{1}}" -f $target,$_.Exception.Message); return $false }}
}}
function Test-PathAbsent([string]$target) {{ try {{ return -not (Test-Path -LiteralPath $target -ErrorAction Stop) }} catch {{ Write-Diagnostic ("could not verify path {{0}}: {{1}}" -f $target,$_.Exception.Message); return $false }} }}
function Test-TaskAbsent([string]$name) {{
  try {{ Get-ScheduledTask -TaskName $name -ErrorAction Stop | Out-Null; return $false }}
  catch {{ if ([string]$_.CategoryInfo.Category -eq 'ObjectNotFound') {{ return $true }}; Write-Diagnostic ("could not verify task {{0}}: {{1}}" -f $name,$_.Exception.Message); return $false }}
}}
function Test-RunValueAbsent([string]$name) {{
  try {{ $key=Get-Item -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction Stop; return $key.GetValueNames() -notcontains $name }}
  catch {{ if (-not (Test-Path -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue)) {{ return $true }}; Write-Diagnostic ("could not verify Run value {{0}}: {{1}}" -f $name,$_.Exception.Message); return $false }}
}}
function Remove-MonitorLogs {{
  try {{
    if (-not (Test-NoReparseParents $monitorLogPath)) {{ return $false }}
    if (-not (Test-Path -LiteralPath $monitorLogPath -ErrorAction Stop)) {{ return $true }}
    $folder=Get-Item -LiteralPath $monitorLogPath -Force -ErrorAction Stop
    if (($folder.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $folder.PSIsContainer) {{ return $false }}
    foreach ($log in @(Get-ChildItem -LiteralPath $monitorLogPath -Filter 'monitor-*.txt' -File -Force -ErrorAction Stop)) {{
      if ($log.Attributes -band [IO.FileAttributes]::ReparsePoint) {{ return $false }}
      Remove-Item -LiteralPath $log.FullName -Force -ErrorAction Stop
    }}
    if (@(Get-ChildItem -LiteralPath $monitorLogPath -Force -ErrorAction Stop).Count -eq 0) {{ Remove-Item -LiteralPath $monitorLogPath -Force -ErrorAction Stop }}
    return $true
  }} catch {{ Write-Diagnostic ("could not remove monitoring logs: {{0}}" -f $_.Exception.Message); return $false }}
}}
function Test-TuningQuarantine {{
  try {{
    $q=Join-Path $profilePath 'TuningQuarantine'
    if (-not (Test-Path -LiteralPath $q -ErrorAction Stop)) {{ return $true }}
    $dir=Get-Item -LiteralPath $q -Force -ErrorAction Stop
    if (-not $dir.PSIsContainer -or ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint)) {{ Write-Diagnostic 'GPU tuning safety data is unavailable'; return $false }}
    $markers=@(Get-ChildItem -LiteralPath $q -Filter 'arcpower-tuning-quarantine-*.json' -Force -ErrorAction Stop)
    if ($markers.Count -eq 0) {{ return $true }}
    $boot=[string](Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().Ticks
    foreach ($item in $markers) {{
      if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {{ return $false }}
      $marker=Get-Content -LiteralPath $item.FullName -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
      $match=[regex]::Match($item.Name,'^arcpower-tuning-quarantine-([0-9a-fA-F]{{64}})\.json$')
      if (-not $match.Success -or $marker.schemaVersion -ne 1 -or [string]$marker.deviceKeyHash -notmatch '^[0-9a-fA-F]{{64}}$' -or $match.Groups[1].Value -ne [string]$marker.deviceKeyHash -or [string]::IsNullOrWhiteSpace([string]$marker.requestId) -or [string]$marker.bootSessionId -notmatch '^\d{{15,}}$' -or $null -eq $marker.quarantinedAt -or [double]::IsNaN([double]$marker.quarantinedAt) -or [double]::IsInfinity([double]$marker.quarantinedAt)) {{ return $false }}
      if ([string]$marker.bootSessionId -eq $boot) {{ Write-Diagnostic 'A GPU tuning operation may still be active; restart Windows before uninstalling'; return $false }}
    }}
    return $true
  }} catch {{ Write-Diagnostic ("could not verify GPU tuning safety data: {{0}}" -f $_.Exception.Message); return $false }}
}}
if (-not $Retry) {{
  $deadline=[DateTime]::UtcNow.AddSeconds(60)
  while ((Get-Process -Id $parentPid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) {{ Start-Sleep -Milliseconds 150 }}
  if (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) {{ Write-Diagnostic 'Arc Power did not close before the uninstall timeout'; exit 1 }}
}}
$deadline=[DateTime]::UtcNow.AddSeconds(60)
do {{
  if (-not (Test-TuningQuarantine)) {{ Write-Diagnostic 'Arc Power removal stopped for GPU tuning safety'; exit 1 }}
  foreach ($target in @($cleanupPaths)+@($cachePaths)) {{ if (-not (Test-NoReparseParents ([string]$target)) -or -not (Test-NoReparse ([string]$target))) {{ Write-Diagnostic 'Arc Power removal stopped because an owned path is unsafe'; exit 1 }} }}
  foreach ($process in @(Get-OwnedProcesses)) {{ try {{ Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop }} catch {{ Write-Diagnostic $_.Exception.Message }} }}
  foreach ($name in $taskNames) {{ try {{ & schtasks.exe /delete /tn $name /f *> $null }} catch {{ Write-Diagnostic $_.Exception.Message }} }}
  try {{ $runKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'; foreach ($name in $runValueNames) {{ Remove-ItemProperty -LiteralPath $runKey -Name $name -Force -ErrorAction SilentlyContinue }} }} catch {{ Write-Diagnostic $_.Exception.Message }}
  foreach ($path in @($cleanupPaths)+@($cachePaths)) {{ [void](Remove-Exact ([string]$path)) }}
  $pathsAbsent=@(@($cleanupPaths)+@($cachePaths) | ForEach-Object {{ Test-PathAbsent ([string]$_) }})
  $logsOk=Remove-MonitorLogs
  $runValuesAbsent=@($runValueNames | ForEach-Object {{ Test-RunValueAbsent ([string]$_) }})
  $tasksAbsent=@($taskNames | ForEach-Object {{ Test-TaskAbsent ([string]$_) }})
  $left=Get-OwnedProcesses
  if (($pathsAbsent -notcontains $false) -and $logsOk -and ($runValuesAbsent -notcontains $false) -and ($tasksAbsent -notcontains $false) -and $left.Count -eq 0 -and -not $script:processQueryFailed) {{
    try {{ Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction Stop }} catch {{ Write-Diagnostic $_.Exception.Message }}
    if (-not (Test-Path -LiteralPath $uninstallKey -ErrorAction SilentlyContinue) -and ($pathsAbsent -notcontains $false) -and $logsOk -and ($runValuesAbsent -notcontains $false) -and ($tasksAbsent -notcontains $false) -and $left.Count -eq 0 -and -not $script:processQueryFailed) {{
      try {{ Remove-Item -LiteralPath ($scriptPath+'.log') -Force -ErrorAction SilentlyContinue }} catch {{}}
      try {{ Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue }} catch {{}}
      exit 0
    }}
  }}
  Start-Sleep -Milliseconds 500
}} while ([DateTime]::UtcNow -lt $deadline)
Write-Diagnostic 'Cleanup verification failed; run Remove Arc Power again from Windows Settings'
exit 1
"#);
        Ok(script)
    }

    fn same_path(left: &Path, right: &Path) -> bool {
        match (left.canonicalize(), right.canonicalize()) {
            (Ok(left), Ok(right)) => left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy()),
            _ => left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy()),
        }
    }

    pub fn run(mode: InstallerMode) -> Result<i32, String> {
        let result = match mode {
            InstallerMode::Install => install(),
            InstallerMode::Uninstall => uninstall(),
            InstallerMode::Update => Err("Updates are handled by the native update worker".into()),
        };
        if let Err(error) = &result { message("Arc Power setup failed", error, 0x00000010); }
        result
    }
}

#[cfg(not(windows))]
mod windows {
    use super::*;
    pub fn run(_mode: InstallerMode) -> Result<i32, String> { Err("Native setup and uninstall require Windows".into()) }
}

#[cfg(windows)]
pub use windows::{install_selected, launch_installed, setup_plan, uninstall_selected, InstallSelection, SetupPlan};

pub fn run(mode: InstallerMode) -> Result<i32, String> {
    match mode {
        InstallerMode::Install | InstallerMode::Uninstall => match crate::setup_ui::run(mode) {
            Ok(code) => Ok(code),
            // A host that cannot create a WebView2 setup window still gets a
            // working installer through the classic flow.
            Err(_) => windows::run(mode),
        },
        InstallerMode::Update => windows::run(mode),
    }
}

