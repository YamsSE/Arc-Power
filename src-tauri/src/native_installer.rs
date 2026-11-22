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
        let root = required_env("LOCALAPPDATA")?.join("Programs").join(PRODUCT);
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
        let name: String = key.get_value("DisplayName").map_err(|_| "Arc Power setup registration is incomplete")?;
        if !name.trim().eq_ignore_ascii_case(PRODUCT) { return Err("The Arc Power setup registration belongs to another product".into()); }
        let value: String = key.get_value("InstallLocation").map_err(|_| "Arc Power setup registration has no install location")?;
        let path = PathBuf::from(value);
        no_reparse_components(&path)?;
        Ok(Some(path))
    }

    fn process_check(current_pid: u32) -> Result<(), String> {
        let script = format!("$ErrorActionPreference='Stop'; $session=(Get-Process -Id {current_pid} -ErrorAction Stop).SessionId; $running=@(Get-CimInstance Win32_Process -Filter \"Name='Arc Power.exe'\" -ErrorAction Stop | Where-Object {{ $_.ProcessId -ne {current_pid} -and $_.SessionId -eq $session -and $_.CommandLine -notmatch '--type=|--apply-worker|sysman.*helper|rtss-profile-helper|--headless|--gpu-diagnostics|--ui-verify' }}); if ($running.Count -gt 0) {{ throw 'Close Arc Power and retry Setup.' }}");
        powershell(&script).map_err(|error| if error.contains("Close Arc Power") { error } else { "Setup could not verify whether Arc Power is running. Close other Arc Power copies and retry.".into() })
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

    fn install() -> Result<i32, String> {
        let source = source_payload_root()?;
        let install_dir = installation_dir()?;
        if source.ancestors().any(|parent| same_path(parent, &install_dir))
            || install_dir.ancestors().any(|parent| same_path(parent, &source))
        {
            return Err("Setup payload and install location must be separate folders".into());
        }
        no_reparse_components(&install_dir)?;
        if let Some(registered) = registered_install_dir()? {
            let registered = registered.canonicalize().map_err(|_| "The registered Arc Power installation is unavailable")?;
            if !same_path(&registered, &install_dir) {
                return Err("A different Arc Power install location is already registered. Remove it before installing this distribution.".into());
            }
        } else if install_dir.exists() && fs::read_dir(&install_dir).map_err(|error| error.to_string())?.next().is_some() {
            return Err("The default Arc Power install folder already contains files and is not registered. Choose an empty folder or remove it first.".into());
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
            if !registered_install_dir()?.is_some_and(|registered| same_path(&registered, &install_dir)) {
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
        let finalize = register_shortcuts(&install_dir, desktop).and_then(|_| write_registration(&install_dir));
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
        if had_install { let _ = remove_tree(&backup); }
        if message("Arc Power Setup", "Arc Power is installed. Launch it now?", 0x00000024) == 6 {
            let mut launch = Command::new(install_dir.join(INSTALLED_EXE));
            launch.current_dir(&install_dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            use std::os::windows::process::CommandExt;
            launch.creation_flags(0x00000008 | 0x00000200);
            launch.spawn().map_err(|error| format!("Arc Power installed, but it could not be launched: {error}"))?;
        }
        Ok(0)
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
        let key = registry_key().open_subkey_with_flags(INSTALL_REGISTRY, KEY_QUERY_VALUE)
            .map_err(|_| "Arc Power uninstall registration is missing".to_owned())?;
        let name: String = key.get_value("DisplayName").map_err(|_| "Arc Power uninstall registration is invalid")?;
        let path: String = key.get_value("InstallLocation").map_err(|_| "Arc Power uninstall registration is invalid")?;
        let uninstall: String = key.get_value("UninstallString").map_err(|_| "Arc Power uninstall registration is invalid")?;
        let registered = PathBuf::from(path);
        no_reparse_components(&registered)?;
        let registered = registered.canonicalize().map_err(|_| "Registered Arc Power install location is unavailable")?;
        if !name.trim().eq_ignore_ascii_case(PRODUCT) || !same_path(&registered, install_dir) {
            return Err("Arc Power uninstall registration does not match this executable".into());
        }
        let executable = install_dir.join(INSTALLED_EXE).canonicalize().map_err(|_| "Installed Arc Power executable is unavailable")?;
        let registered_executable = uninstall.trim_start().strip_prefix('"').and_then(|value| value.split_once('"').map(|pair| pair.0))
            .unwrap_or_else(|| uninstall.split_whitespace().next().unwrap_or(""));
        let registered_executable = PathBuf::from(registered_executable);
        no_reparse_components(&registered_executable)?;
        let registered_executable = registered_executable.canonicalize()
            .map_err(|_| "Arc Power uninstall command is invalid")?;
        if !same_path(&registered_executable, &executable) || !same_path(&executable, &std::env::current_exe().map_err(|error| error.to_string())?) {
            return Err("Arc Power uninstall registration does not identify this installation".into());
        }
        Ok(())
    }

    fn set_recovery_registration(install_dir: &Path, uninstall: &str) -> Result<(), String> {
        let key = registry_key().open_subkey_with_flags(INSTALL_REGISTRY, KEY_SET_VALUE)
            .map_err(|error| format!("Cannot preserve Arc Power removal recovery: {error}"))?;
        for (name, value) in [("UninstallString", uninstall.to_owned()), ("QuietUninstallString", uninstall.to_owned()),
            ("InstallLocation", install_dir.to_string_lossy().into_owned())] {
            key.set_value(name, &value).map_err(|error| format!("Cannot preserve Arc Power removal recovery: {error}"))?;
        }
        Ok(())
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
            local.join("ArcPowerCache"), local.join("arc-power"), local.join("rid-arc-power"), local.join("Arc Power/Cache")];
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

pub fn run(mode: InstallerMode) -> Result<i32, String> { windows::run(mode) }

