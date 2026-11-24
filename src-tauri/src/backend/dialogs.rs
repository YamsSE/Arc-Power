//! Native Windows common-item pickers for the recording folder and game
//! executable. The picker runs on the thread that owns the owner HWND (the
//! Tauri main thread); Windows common dialogs are thread-affine, and a
//! cross-thread owner can hang or crash the host. A dedicated STA worker is
//! only the fallback when the main thread cannot initialize COM.
#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::io::Write;
    use std::sync::atomic::{AtomicIsize, Ordering};
    use std::sync::Mutex;
    use windows::core::{Interface, IUnknown, PCWSTR, PWSTR, GUID};
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree,
        CoUninitialize, IBindCtx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
    use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
    use windows::Win32::UI::Shell::{BROWSEINFOW, BIF_RETURNONLYFSDIRS,
        IFileOpenDialog, IModalWindow, IShellItem, SHBrowseForFolderW,
        SHCreateItemFromParsingName, SHGetPathFromIDListW, FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM,
        FOS_NOCHANGEDIR, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, SIGDN_FILESYSPATH};
    use windows::Win32::UI::WindowsAndMessaging::IsWindow;

    const CLSID_FILE_OPEN_DIALOG: GUID = GUID::from_u128(0xdc1c5a9c_e88a_4dde_a5a1_60f82a20aef7);
    const ERROR_CANCELLED: i32 = 0x800704C7u32 as i32;
    const COM_UNAVAILABLE: &str = "dialog-main-thread-com-unavailable";

    /// Diagnostic trail for the recording/game picker. A hard crash in the
    /// shell namespace otherwise leaves no evidence; the last line names the
    /// step that was running.
    fn log(message: &str) {
        let Some(appdata) = std::env::var_os("APPDATA") else { return; };
        let directory = std::path::PathBuf::from(appdata).join("ArcPower");
        let _ = std::fs::create_dir_all(&directory);
        let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true)
            .open(directory.join("dialog.log")) else { return; };
        let seconds = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs()).unwrap_or(0);
        let _ = writeln!(file, "{seconds} {message}");
    }

    /// The main window HWND used as the dialog owner. It is valid only while
    /// the main window lives; `IsWindow` guards every use.
    static OWNER: AtomicIsize = AtomicIsize::new(0);
    type Task = Box<dyn FnOnce() + Send + 'static>;
    type Dispatcher = Box<dyn Fn(Task) -> bool + Send + Sync>;
    /// Post a task to the thread that owns the owner HWND. `main.rs` installs
    /// the Tauri `run_on_main_thread` closure; keeping the callback generic
    /// stops the backend library from linking the full webview runtime.
    static DISPATCH: Mutex<Option<Dispatcher>> = Mutex::new(None);

    pub fn set_owner(hwnd: isize) { OWNER.store(hwnd, Ordering::SeqCst); }

    /// Register the host dispatcher so the picker can run on the owner thread.
    pub fn set_dispatcher(dispatcher: impl Fn(Task) -> bool + Send + Sync + 'static) {
        if let Ok(mut slot) = DISPATCH.lock() { *slot = Some(Box::new(dispatcher)); }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn take_string(value: PWSTR) -> String {
        if value.0.is_null() { return String::new(); }
        let mut length = 0usize;
        while *value.0.add(length) != 0 { length += 1; }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(value.0, length));
        CoTaskMemFree(Some(value.0 as *const c_void));
        text
    }

    fn show(folder: bool, owner: Option<HWND>, default_path: Option<&str>) -> Result<Option<String>, String> {
        unsafe {
            let dialog: IFileOpenDialog = CoCreateInstance(&CLSID_FILE_OPEN_DIALOG,
                None::<&IUnknown>, CLSCTX_INPROC_SERVER).map_err(|error| error.message())?;
            let mut options = FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR;
            options |= if folder { FOS_PICKFOLDERS } else { FOS_FILEMUSTEXIST };
            dialog.SetOptions(options).map_err(|error| error.message())?;
            let title = wide(if folder { "Select a recording folder" } else { "Select a game executable" });
            dialog.SetTitle(PCWSTR::from_raw(title.as_ptr())).map_err(|error| error.message())?;
            if !folder {
                let name = wide("Executable files (*.exe)");
                let spec = wide("*.exe");
                dialog.SetFileTypes(&[COMDLG_FILTERSPEC {
                    pszName: PCWSTR::from_raw(name.as_ptr()),
                    pszSpec: PCWSTR::from_raw(spec.as_ptr()),
                }]).map_err(|error| error.message())?;
            }
            // Open at the current recording/game folder instead of the shell
            // namespace root. Enumerating "This PC" and network providers is
            // where the common dialog's third-party namespace crashes occur.
            let default_path = default_path.filter(|path| !path.trim().is_empty());
            if let Some(path) = default_path {
                let path = wide(path);
                match SHCreateItemFromParsingName::<_, _, IShellItem>(
                    PCWSTR::from_raw(path.as_ptr()), None::<&IBindCtx>) {
                    Ok(item) => {
                        if let Err(error) = dialog.SetFolder(&item) {
                            log(&format!("set-folder failed: {}", error.message()));
                        }
                    }
                    Err(error) => log(&format!("default-folder unavailable: {}", error.message())),
                }
            }
            let modal: IModalWindow = dialog.cast().map_err(|error| error.message())?;
            log(&format!("show folder={folder} owner={}", owner.is_some()));
            match modal.Show(owner) {
                Ok(()) => {}
                Err(error) if error.code().0 == ERROR_CANCELLED => { log("canceled"); return Ok(None); }
                Err(error) => {
                    log(&format!("show failed: {}", error.message()));
                    return Err(error.message());
                }
            }
            let item = dialog.GetResult().map_err(|error| error.message())?;
            let path = take_string(item.GetDisplayName(SIGDN_FILESYSPATH).map_err(|error| error.message())?);
            log(if path.is_empty() { "selected-empty" } else { "selected" });
            Ok(if path.is_empty() { None } else { Some(path) })
        }
    }

    /// The modern IFileOpenDialog folder mode crashes inside `Show` on systems
    /// with a third-party shell namespace/provider. The classic shell browser
    /// uses a separate code path and is the stable folder picker.
    fn browse_folder(owner: Option<HWND>) -> Result<Option<String>, String> {
        unsafe {
            let mut display = [0u16; 260];
            let title = wide("Select a recording folder");
            let info = BROWSEINFOW {
                hwndOwner: owner.unwrap_or_default(),
                pidlRoot: std::ptr::null_mut(),
                pszDisplayName: PWSTR(display.as_mut_ptr()),
                lpszTitle: PCWSTR::from_raw(title.as_ptr()),
                ulFlags: BIF_RETURNONLYFSDIRS,
                lpfn: None,
                lParam: LPARAM(0),
                iImage: 0,
            };
            log(&format!("browse start owner={}", owner.is_some()));
            let pidl = SHBrowseForFolderW(&info);
            if pidl.is_null() { log("browse canceled"); return Ok(None); }
            let mut path = [0u16; 260];
            let got_path = SHGetPathFromIDListW(pidl, &mut path).as_bool();
            CoTaskMemFree(Some(pidl as *const c_void));
            if !got_path {
                log("browse no filesystem path");
                return Err("dialog: the selected folder has no filesystem path".into());
            }
            let length = path.iter().position(|unit| *unit == 0).unwrap_or(path.len());
            let selected = String::from_utf16_lossy(&path[..length]);
            log("browse selected");
            Ok(if selected.is_empty() { None } else { Some(selected) })
        }
    }

    fn browse_here(owner: Option<HWND>) -> Result<Option<String>, String> {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| browse_folder(owner)))
            .unwrap_or_else(|_| { log("browse panic"); Err("dialog: picker panicked".to_owned()) })
    }

    fn owner_handle() -> Option<HWND> {
        let owner = OWNER.load(Ordering::SeqCst);
        if owner == 0 { return None; }
        let hwnd = HWND(owner as *mut c_void);
        unsafe { IsWindow(Some(hwnd)).as_bool().then_some(hwnd) }
    }

    /// Show the dialog on the current thread. The caller is responsible for
    /// COM initialization; `show` catches panics so a shell fault becomes a
    /// normal invoke error rather than an unhandled crash.
    fn show_here(folder: bool, owner: Option<HWND>, default_path: Option<&str>) -> Result<Option<String>, String> {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            show(folder, owner, default_path)
        }));
        match result {
            Ok(selected) => selected,
            Err(_) => {
                log("panic");
                Err("dialog: picker panicked".to_owned())
            }
        }
    }

    fn pick_worker(folder: bool, default_path: Option<String>) -> Result<Option<String>, String> {
        log("worker-fallback");
        std::thread::spawn(move || {
            let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
            if initialized.is_err() {
                return Err(format!("dialog: COM initialization failed: {}", initialized.message()));
            }
            // The owner HWND belongs to the main thread; never pass it from
            // this worker. The dialog is still top-level and modal to itself.
            let selected = if folder { browse_here(None) } else { show_here(false, None, default_path.as_deref()) };
            unsafe { CoUninitialize(); }
            selected
        }).join().map_err(|_| "dialog: picker thread panicked".to_owned())?
    }

    fn pick(folder: bool, default_path: Option<String>) -> Result<Option<String>, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        let task_path = default_path.clone();
        let task: Task = Box::new(move || {
            let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
            if initialized.is_err() {
                log(&format!("main-thread COM unavailable: {}", initialized.message()));
                let _ = tx.send(Err(COM_UNAVAILABLE.to_owned()));
                return;
            }
            let selected = if folder {
                browse_here(owner_handle())
            } else {
                show_here(false, owner_handle(), task_path.as_deref())
            };
            unsafe { CoUninitialize(); }
            let _ = tx.send(selected);
        });
        let dispatched = DISPATCH.lock().ok()
            .and_then(|slot| slot.as_ref().map(|dispatcher| dispatcher(task)))
            .unwrap_or(false);
        if dispatched {
            match rx.recv() {
                Ok(Ok(selected)) => return Ok(selected),
                Ok(Err(error)) if error == COM_UNAVAILABLE => {}
                Ok(Err(error)) => return Err(error),
                Err(_) => return Err("dialog: picker did not return".to_owned()),
            }
        }
        pick_worker(folder, default_path)
    }

    pub fn pick_folder(default_path: Option<&str>) -> Result<Option<String>, String> {
        pick(true, default_path.map(str::to_owned))
    }
    pub fn pick_executable(default_path: Option<&str>) -> Result<Option<String>, String> {
        pick(false, default_path.map(str::to_owned))
    }
}

#[cfg(windows)]
pub use imp::{pick_executable, pick_folder, set_dispatcher, set_owner};

#[cfg(not(windows))]
pub fn set_owner(_hwnd: isize) {}
#[cfg(not(windows))]
pub fn set_dispatcher(_dispatcher: impl Fn(Box<dyn FnOnce() + Send + 'static>) -> bool + Send + Sync + 'static) {}

#[cfg(not(windows))]
pub fn pick_folder(_default_path: Option<&str>) -> Result<Option<String>, String> { Ok(None) }
#[cfg(not(windows))]
pub fn pick_executable(_default_path: Option<&str>) -> Result<Option<String>, String> { Ok(None) }
