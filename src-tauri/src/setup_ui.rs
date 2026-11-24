//! WebView setup and uninstaller. This is a separate Tauri window that runs
//! before the main application so the packaged installer can present the
//! Electron-style pages instead of a chain of message boxes.
use crate::lifecycle::InstallerMode;
use crate::runtime::native_installer::{self, InstallSelection};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::Manager;

struct SetupMode(&'static str);

fn rtss_installed() -> bool {
    let roots = [std::env::var_os("ProgramFiles(x86)"), std::env::var_os("ProgramFiles"), std::env::var_os("LOCALAPPDATA")];
    roots.into_iter().flatten().any(|root| {
        PathBuf::from(root).join("RivaTuner Statistics Server").join("RTSS.exe").is_file()
    })
}

fn install_rtss() -> Option<String> {
    if rtss_installed() { return Some("RTSS is already installed".into()); }
    let mut command = Command::new("winget.exe");
    command.args(["install", "--id", "Guru3D.RTSS", "--exact", "--silent",
        "--accept-package-agreements", "--accept-source-agreements"])
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    match command.status() {
        Ok(status) if status.success() && rtss_installed() => Some("RTSS installed".into()),
        Ok(status) => Some(format!("RTSS was not installed (WinGet exit {}); Arc Power still installed.", status.code().unwrap_or(-1))),
        Err(error) => Some(format!("RTSS install skipped: WinGet is unavailable ({error}). Arc Power still installed.")),
    }
}

#[tauri::command]
fn setup_state(mode: tauri::State<SetupMode>) -> Result<Value, String> {
    let plan = native_installer::setup_plan()?;
    Ok(json!({
        "mode": mode.0,
        "version": plan.version,
        "defaultDir": plan.default_dir.to_string_lossy(),
        "registeredDir": plan.registered_dir.as_ref().map(|dir| dir.to_string_lossy().to_string()),
        // The setup defaults to the all-users Program Files location. An old
        // per-user install is moved/cleaned after the new install lands; the
        // user can still pick another folder.
        "currentDir": plan.default_dir.to_string_lossy(),
        "rtssInstalled": rtss_installed(),
        "hasExisting": plan.registered_dir.is_some(),
    }))
}

#[tauri::command]
async fn setup_pick_folder(current: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        arc_power_tauri::backend::dialogs::pick_folder(Some(&current))
            .map(|path| path.unwrap_or_default())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn setup_install(path: String, desktop: bool, launch: bool, rtss: bool) -> Result<Value, String> {
    let path = PathBuf::from(path.trim());
    if !path.is_absolute() { return Err("Choose an absolute install folder".into()); }
    let plan = native_installer::setup_plan()?;
    let old = plan.registered_dir.filter(|registered| {
        !registered.to_string_lossy().eq_ignore_ascii_case(&path.to_string_lossy())
    });
    let target = path.clone();
    let rtss_note = tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
        native_installer::install_selected(InstallSelection {
            install_dir: target.clone(),
            old_install_dir: old,
            desktop_shortcut: desktop,
        })?;
        let note = if rtss { install_rtss() } else { None };
        if launch { native_installer::launch_installed(&target)?; }
        Ok(note)
    }).await.map_err(|error| error.to_string())??;
    Ok(json!({"ok": true, "rtss": rtss_note}))
}

#[tauri::command]
async fn setup_uninstall() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(native_installer::uninstall_selected)
        .await.map_err(|error| error.to_string())??;
    Ok(json!({"ok": true}))
}

#[tauri::command]
fn setup_close(app: tauri::AppHandle) {
    app.exit(0);
}

pub fn run(mode: InstallerMode) -> Result<i32, String> {
    let label = match mode {
        InstallerMode::Install => "install",
        InstallerMode::Uninstall => "uninstall",
        InstallerMode::Update => return Err("Updates are handled by the native update worker".into()),
    };
    let title = if label == "install" { "Arc Power Setup" } else { "Remove Arc Power" };
    let app = tauri::Builder::default()
        .manage(SetupMode(label))
        .invoke_handler(tauri::generate_handler![
            setup_state, setup_pick_folder, setup_install, setup_uninstall, setup_close
        ])
        .setup(move |app| {
            let cache = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir).join("ArcPowerSetupCache");
            let window = tauri::WebviewWindowBuilder::new(app, "setup",
                tauri::WebviewUrl::App("renderer/setup.html".into()))
                .title(title)
                .inner_size(660.0, 430.0)
                .min_inner_size(660.0, 430.0)
                .resizable(false)
                .center()
                .data_directory(cache)
                .initialization_script(&format!("window.__arcSetupMode = '{label}';"))
                .build()?;
            if let Ok(hwnd) = window.hwnd() {
                arc_power_tauri::backend::dialogs::set_owner(hwnd.0 as isize);
            }
            let dialog_app = app.handle().clone();
            arc_power_tauri::backend::dialogs::set_dispatcher(move |task| {
                dialog_app.run_on_main_thread(move || task()).is_ok()
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .map_err(|error| format!("The Arc Power setup window could not start: {error}"))?;
    app.run(|_, _| {});
    Ok(0)
}
