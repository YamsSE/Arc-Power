//! DPAPI-backed OBS stream credential storage. The host owns the fixed path;
//! no renderer or compatibility service can select a filename.
use super::store_file::{atomic_replace, reject_reparse_components};
use std::{fs, path::PathBuf};

const FILE_NAME: &str = "obs-stream-password.bin";
const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

pub struct CredentialStore { root: PathBuf }
impl CredentialStore {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        if !root.is_absolute() { return Err("Credential root must be an absolute fixed path".into()); }
        Ok(Self { root })
    }
    fn path(&self) -> PathBuf { self.root.join(FILE_NAME) }
    pub fn load(&self) -> Result<Option<String>, String> {
        let path = self.path();
        reject_reparse_components(&path)?;
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        unprotect(&bytes).map(Some)
    }
    pub fn save(&self, password: &str) -> Result<(), String> {
        if password.chars().count() > 512 { return Err("obs-credential-save: password is too long".into()); }
        let encrypted = protect(password.as_bytes())?;
        fs::create_dir_all(&self.root).map_err(|error| error.to_string())?;
        reject_reparse_components(&self.root)?;
        let destination = self.path();
        reject_reparse_components(&destination)?;
        let temporary = self.root.join(format!(".{FILE_NAME}.{:032x}.tmp", rand::random::<u128>()));
        fs::write(&temporary, encrypted).map_err(|error| error.to_string())?;
        let result = atomic_replace(&temporary, &destination);
        if result.is_err() { let _ = fs::remove_file(&temporary); }
        result
    }
    pub fn clear(&self) -> Result<(), String> {
        match fs::remove_file(self.path()) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[cfg(windows)]
fn protect(data: &[u8]) -> Result<Vec<u8>, String> { dpapi(data, false) }

#[cfg(windows)]
fn unprotect(data: &[u8]) -> Result<String, String> {
    String::from_utf8(dpapi(data, true)?).map_err(|_| "obs-credential-load: decrypted value is not UTF-8".into())
}

#[cfg(windows)]
fn dpapi(data: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    use std::ffi::c_void;
    use std::ptr;
    #[repr(C)]
    struct DataBlob { size: u32, data: *mut u8 }
    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(input: *const DataBlob, description: *const u16, entropy: *const DataBlob,
            reserved: *mut c_void, prompt: *mut c_void, flags: u32, output: *mut DataBlob) -> i32;
        fn CryptUnprotectData(input: *const DataBlob, description: *mut *mut u16, entropy: *const DataBlob,
            reserved: *mut c_void, prompt: *mut c_void, flags: u32, output: *mut DataBlob) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" { fn LocalFree(memory: *mut c_void) -> *mut c_void; }
    let empty = [0u8; 1];
    let input = DataBlob { size: data.len() as u32,
        data: if data.is_empty() { empty.as_ptr() as *mut u8 } else { data.as_ptr() as *mut u8 } };
    let mut output = DataBlob { size: 0, data: ptr::null_mut() };
    let ok = unsafe {
        if decrypt {
            let mut description: *mut u16 = ptr::null_mut();
            let result = CryptUnprotectData(&input, &mut description, ptr::null(), ptr::null_mut(),
                ptr::null_mut(), CRYPTPROTECT_UI_FORBIDDEN, &mut output);
            if !description.is_null() { LocalFree(description as *mut c_void); }
            result
        } else {
            CryptProtectData(&input, ptr::null(), ptr::null(), ptr::null_mut(), ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        }
    };
    if ok == 0 { return Err("obs-credential: DPAPI operation failed".into()); }
    let bytes = unsafe { std::slice::from_raw_parts(output.data, output.size as usize).to_vec() };
    unsafe { LocalFree(output.data as *mut c_void); }
    Ok(bytes)
}

#[cfg(not(windows))]
fn protect(_data: &[u8]) -> Result<Vec<u8>, String> { Err("credentials are only available on Windows".into()) }
#[cfg(not(windows))]
fn unprotect(_data: &[u8]) -> Result<String, String> { Err("credentials are only available on Windows".into()) }

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp { fn new() -> Self { let root = std::env::temp_dir().join(format!("arc-credential-test-{:032x}", rand::random::<u128>())); fs::create_dir(&root).unwrap(); Self(root) } }
    impl Drop for Temp { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    #[cfg(windows)]
    #[test]
    fn dpapi_round_trip_never_stores_plaintext() {
        let temp = Temp::new();
        let store = CredentialStore::new(temp.0.clone()).unwrap();
        assert_eq!(store.load().unwrap(), None);
        store.save("correct horse battery staple").unwrap();
        assert_eq!(store.load().unwrap().as_deref(), Some("correct horse battery staple"));
        let bytes = fs::read(temp.0.join(FILE_NAME)).unwrap();
        assert!(!bytes.windows(28).any(|window| window == b"correct horse battery staple"));
        store.clear().unwrap();
        assert_eq!(store.load().unwrap(), None);
    }
    #[cfg(windows)]
    #[test]
    fn malformed_credentials_fail_closed_without_rewriting() {
        let temp = Temp::new();
        let store = CredentialStore::new(temp.0.clone()).unwrap();
        let path = temp.0.join(FILE_NAME);
        fs::write(&path, b"not a dpapi blob").unwrap();
        assert!(store.load().is_err());
        assert_eq!(fs::read(&path).unwrap(), b"not a dpapi blob");
        assert!(store.save(&"x".repeat(513)).is_err());
    }
}
