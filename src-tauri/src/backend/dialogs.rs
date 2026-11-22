//! Native Windows common-item pickers for the recording folder and game
//! executable. Dialogs run on a dedicated STA thread; no renderer path input.
#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use windows::core::{Interface, IUnknown, PCWSTR, PWSTR, GUID};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree,
        CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
    use windows::Win32::UI::Shell::{IFileOpenDialog, IModalWindow, FOS_FILEMUSTEXIST,
        FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, SIGDN_FILESYSPATH};

    const CLSID_FILE_OPEN_DIALOG: GUID = GUID::from_u128(0xdc1c5a9c_e88a_4dde_a5a1_60f82a20aef7);
    const ERROR_CANCELLED: i32 = 0x800704C7u32 as i32;

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

    fn show(folder: bool) -> Result<Option<String>, String> {
        unsafe {
            let dialog: IFileOpenDialog = CoCreateInstance(&CLSID_FILE_OPEN_DIALOG,
                None::<&IUnknown>, CLSCTX_INPROC_SERVER).map_err(|error| error.message())?;
            let mut options = FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST;
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
            let modal: IModalWindow = dialog.cast().map_err(|error| error.message())?;
            match modal.Show(None) {
                Ok(()) => {}
                Err(error) if error.code().0 == ERROR_CANCELLED => return Ok(None),
                Err(error) => return Err(error.message()),
            }
            let item = dialog.GetResult().map_err(|error| error.message())?;
            let path = take_string(item.GetDisplayName(SIGDN_FILESYSPATH).map_err(|error| error.message())?);
            Ok(if path.is_empty() { None } else { Some(path) })
        }
    }

    fn pick(folder: bool) -> Result<Option<String>, String> {
        std::thread::spawn(move || {
            let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            if initialized.is_err() {
                return Err(format!("dialog: COM initialization failed: {}", initialized.message()));
            }
            let selected = show(folder);
            unsafe { CoUninitialize(); }
            selected
        }).join().map_err(|_| "dialog: picker thread panicked".to_owned())?
    }

    pub fn pick_folder() -> Result<Option<String>, String> { pick(true) }
    pub fn pick_executable() -> Result<Option<String>, String> { pick(false) }
}

#[cfg(windows)]
pub use imp::{pick_executable, pick_folder};

#[cfg(not(windows))]
pub fn pick_folder() -> Result<Option<String>, String> { Ok(None) }
#[cfg(not(windows))]
pub fn pick_executable() -> Result<Option<String>, String> { Ok(None) }
