//! CF_HDROP clipboard writes for already-authorized local files.
//! The DROPFILES buffer is built and tested independently of the clipboard so
//! the layout is verifiable without mutating the user's clipboard.

const DROPFILES_SIZE: usize = 20;
const CF_HDROP: u32 = 15;
const GMEM_MOVEABLE: u32 = 0x0002;
const GMEM_ZEROINIT: u32 = 0x0040;
const DROPEFFECT_COPY: u32 = 1;

/// Build the Unicode DROPFILES payload: 20-byte header, then a
/// double-null-terminated UTF-16 file list.
pub fn dropfiles_buffer(paths: &[String]) -> Result<Vec<u8>, String> {
    if paths.is_empty() { return Err("clipboard: at least one file is required".into()); }
    let mut list = Vec::new();
    for path in paths {
        if path.is_empty() || path.contains('\0') { return Err("clipboard: invalid file path".into()); }
        for unit in path.encode_utf16() { list.extend_from_slice(&unit.to_le_bytes()); }
        list.extend_from_slice(&0u16.to_le_bytes());
    }
    list.extend_from_slice(&0u16.to_le_bytes());
    let mut buffer = vec![0u8; DROPFILES_SIZE];
    buffer[0..4].copy_from_slice(&(DROPFILES_SIZE as u32).to_le_bytes());
    // pt = {0,0}, fNC = FALSE, fWide = TRUE.
    buffer[16..20].copy_from_slice(&1u32.to_le_bytes());
    buffer.extend_from_slice(&list);
    Ok(buffer)
}

#[cfg(windows)]
pub fn copy_files(paths: &[String]) -> Result<(), String> {
    use std::ffi::c_void;
    use std::ptr;
    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(hwnd: *mut c_void) -> i32;
        fn EmptyClipboard() -> i32;
        fn SetClipboardData(format: u32, mem: *mut c_void) -> *mut c_void;
        fn CloseClipboard() -> i32;
        fn RegisterClipboardFormatW(name: *const u16) -> u32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalAlloc(flags: u32, bytes: usize) -> *mut c_void;
        fn GlobalLock(mem: *mut c_void) -> *mut c_void;
        fn GlobalUnlock(mem: *mut c_void) -> i32;
        fn GlobalFree(mem: *mut c_void) -> *mut c_void;
    }
    fn global_copy(bytes: &[u8]) -> Result<*mut c_void, String> {
        let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.len()) };
        if memory.is_null() { return Err("clipboard: allocation failed".into()); }
        let target = unsafe { GlobalLock(memory) };
        if target.is_null() { unsafe { GlobalFree(memory); } return Err("clipboard: lock failed".into()); }
        unsafe { ptr::copy_nonoverlapping(bytes.as_ptr(), target.cast(), bytes.len()); GlobalUnlock(memory); }
        Ok(memory)
    }
    let dropfiles = dropfiles_buffer(paths)?;
    let drop_handle = global_copy(&dropfiles)?;
    let effect_handle = match global_copy(&DROPEFFECT_COPY.to_le_bytes()) {
        Ok(handle) => handle,
        Err(error) => { unsafe { GlobalFree(drop_handle); } return Err(error); }
    };
    if unsafe { OpenClipboard(ptr::null_mut()) } == 0 {
        unsafe { GlobalFree(drop_handle); GlobalFree(effect_handle); }
        return Err("clipboard: cannot open the clipboard".into());
    }
    let mut drop_transferred = false;
    let mut effect_transferred = false;
    let result = (|| {
        if unsafe { EmptyClipboard() } == 0 { return Err("clipboard: cannot empty the clipboard".into()); }
        if unsafe { SetClipboardData(CF_HDROP, drop_handle) }.is_null() {
            return Err("clipboard: cannot set CF_HDROP".into());
        }
        drop_transferred = true;
        let format: Vec<u16> = "Preferred DropEffect\0".encode_utf16().collect();
        let format = unsafe { RegisterClipboardFormatW(format.as_ptr()) };
        if format != 0 {
            if unsafe { SetClipboardData(format, effect_handle) }.is_null() {
                return Err("clipboard: cannot set the drop effect".into());
            }
            effect_transferred = true;
        }
        Ok(())
    })();
    unsafe { CloseClipboard(); }
    // SetClipboardData transfers ownership only on success.
    if !drop_transferred { unsafe { GlobalFree(drop_handle); } }
    if !effect_transferred { unsafe { GlobalFree(effect_handle); } }
    result
}

#[cfg(not(windows))]
pub fn copy_files(_paths: &[String]) -> Result<(), String> { Err("clipboard is only available on Windows".into()) }

#[cfg(windows)]
pub fn copy_text(text: &str) -> Result<(), String> {
    use std::ffi::c_void;
    use std::ptr;
    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(hwnd: *mut c_void) -> i32;
        fn EmptyClipboard() -> i32;
        fn SetClipboardData(format: u32, mem: *mut c_void) -> *mut c_void;
        fn CloseClipboard() -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalAlloc(flags: u32, bytes: usize) -> *mut c_void;
        fn GlobalLock(mem: *mut c_void) -> *mut c_void;
        fn GlobalUnlock(mem: *mut c_void) -> i32;
        fn GlobalFree(mem: *mut c_void) -> *mut c_void;
    }
    const CF_UNICODETEXT: u32 = 13;
    let mut bytes: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
    bytes.extend_from_slice(&[0, 0]);
    let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.len()) };
    if memory.is_null() { return Err("clipboard: allocation failed".into()); }
    let target = unsafe { GlobalLock(memory) };
    if target.is_null() { unsafe { GlobalFree(memory); } return Err("clipboard: lock failed".into()); }
    unsafe { ptr::copy_nonoverlapping(bytes.as_ptr(), target.cast(), bytes.len()); GlobalUnlock(memory); }
    if unsafe { OpenClipboard(ptr::null_mut()) } == 0 {
        unsafe { GlobalFree(memory); }
        return Err("clipboard: cannot open the clipboard".into());
    }
    let transferred = unsafe { EmptyClipboard() != 0 && !SetClipboardData(CF_UNICODETEXT, memory).is_null() };
    unsafe { CloseClipboard(); }
    if !transferred {
        unsafe { GlobalFree(memory); }
        return Err("clipboard: cannot set text".into());
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn copy_text(_text: &str) -> Result<(), String> { Err("clipboard is only available on Windows".into()) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dropfiles_layout_is_unicode_and_double_terminated() {
        let buffer = dropfiles_buffer(&["C:\\clips\\one.mp4".into()]).unwrap();
        assert_eq!(&buffer[0..4], &(20u32).to_le_bytes());
        assert_eq!(&buffer[16..20], &1u32.to_le_bytes());
        let list = &buffer[20..];
        let units: Vec<u16> = list.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        let text = String::from_utf16(&units[..units.len() - 2]).unwrap();
        assert_eq!(text, "C:\\clips\\one.mp4");
        assert_eq!(&units[units.len() - 2..], &[0, 0]);
        assert_eq!(dropfiles_buffer(&[]).unwrap_err(), "clipboard: at least one file is required");
        assert!(dropfiles_buffer(&["bad\0path".into()]).is_err());
    }
}
