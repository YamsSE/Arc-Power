//! Atomic, serialized storage for the fixed application metadata sidecars.
//! Each domain owns its schema and validates the previous document in the
//! transaction callback before a replacement is prepared.
use super::store_file::{atomic_replace, reject_reparse_components};
use serde_json::Value;
use std::{fs::{self, OpenOptions}, io::Write, path::{Component, PathBuf}, sync::Mutex};

#[derive(Clone, Copy)]
pub enum Sidecar { Games, Recording, OverlayLayouts, Stability, FanResume, WindowState, ArcSyncRanges }
impl Sidecar {
    fn filename(self) -> &'static str { match self {
        Self::Games=>"game-profiles.json", Self::Recording=>"recording.json",
        Self::OverlayLayouts=>"overlay-layouts.json", Self::Stability=>"stability.json", Self::FanResume=>"FanResume.json",
        Self::WindowState=>"window-state.json", Self::ArcSyncRanges=>"arc-sync-ranges.json",
    } }
}

pub struct SidecarFile { root: PathBuf, file: Sidecar, lock: Mutex<()> }
impl SidecarFile {
    pub fn new(root: PathBuf, file: Sidecar) -> Result<Self,String> {
        if !root.is_absolute() || root.components().any(|component|matches!(component,Component::ParentDir)) {
            return Err("Sidecar root must be an absolute fixed path without parent traversal".into());
        }
        reject_reparse_components(&root)?;
        if root.exists() && !root.is_dir() { return Err("Sidecar root must be a directory".into()); }
        Ok(Self { root, file, lock:Mutex::new(()) })
    }
    fn read_unlocked(&self) -> Result<Option<Value>,String> {
        let path = self.root.join(self.file.filename());
        reject_reparse_components(&path)?;
        let bytes = match fs::read(&path) {
            Ok(bytes)=>bytes, Err(error) if error.kind()==std::io::ErrorKind::NotFound=>return Ok(None),
            Err(error)=>return Err(format!("Cannot read {}: {error}",self.file.filename())),
        };
        serde_json::from_slice(bytes.strip_prefix(&[0xef,0xbb,0xbf]).unwrap_or(&bytes))
            .map(Some).map_err(|error|format!("Cannot load {}: invalid JSON ({error})",self.file.filename()))
    }
    pub fn read(&self) -> Result<Option<Value>,String> {
        let _lock = self.lock.lock().map_err(|_|"Sidecar lock was poisoned")?;
        self.read_unlocked()
    }
    fn write_unlocked(&self, value: &Value) -> Result<(),String> {
        let mut bytes = serde_json::to_vec_pretty(value).map_err(|error|error.to_string())?;
        bytes.push(b'\n');
        reject_reparse_components(&self.root)?;
        fs::create_dir_all(&self.root).map_err(|error|error.to_string())?;
        let destination = self.root.join(self.file.filename());
        reject_reparse_components(&destination)?;
        let temporary = self.root.join(format!(".{}.{:032x}.tmp",self.file.filename(),rand::random::<u128>()));
        let mut handle = OpenOptions::new().create_new(true).write(true).open(&temporary).map_err(|error|error.to_string())?;
        let result = (|| {
            handle.write_all(&bytes).map_err(|error|error.to_string())?;
            handle.flush().map_err(|error|error.to_string())?;
            handle.sync_all().map_err(|error|error.to_string())?;
            drop(handle);
            reject_reparse_components(&temporary)?;
            reject_reparse_components(&destination)?;
            atomic_replace(&temporary,&destination)
        })();
        if result.is_err() { let _ = fs::remove_file(&temporary); }
        result
    }
    pub fn transaction<T>(&self, operation: impl FnOnce(Option<Value>)->Result<(Value,T),String>) -> Result<T,String> {
        self.transaction_optional(|previous|operation(previous).map(|(updated,result)|(Some(updated),result)))
    }
    /// The domain can return None for a validated no-op without rewriting its
    /// original bytes or creating a previously absent file.
    pub fn transaction_optional<T>(&self, operation: impl FnOnce(Option<Value>)->Result<(Option<Value>,T),String>) -> Result<T,String> {
        let _lock = self.lock.lock().map_err(|_|"Sidecar lock was poisoned")?;
        let (updated,result) = operation(self.read_unlocked()?)?;
        if let Some(updated)=updated {self.write_unlocked(&updated)?;}
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    struct Temp(PathBuf);
    impl Temp { fn new()->Self { let root=std::env::temp_dir().join(format!("arc-sidecar-test-{:032x}",rand::random::<u128>())); fs::create_dir(&root).unwrap();Self(root) } }
    impl Drop for Temp { fn drop(&mut self) { if self.0.parent()==Some(std::env::temp_dir().as_path()) {let _=fs::remove_dir_all(&self.0);} } }
    #[test]
    fn failed_domain_validation_leaves_original_bytes_and_missing_reads_create_nothing() {
        let temp=Temp::new(); let root=temp.0.join("missing");
        let store=SidecarFile::new(root.clone(),Sidecar::Recording).unwrap();
        assert!(store.read().unwrap().is_none()); assert!(!root.exists());
        fs::create_dir(&root).unwrap(); let path=root.join("recording.json");
        let original=b"\xef\xbb\xbf{\"schemaVersion\":999}"; fs::write(&path,original).unwrap();
        assert_eq!(store.read().unwrap().unwrap()["schemaVersion"],999);
        assert!(store.transaction::<()>(|_|Err("Future schema refused".into())).is_err());
        assert_eq!(fs::read(path).unwrap(),original);
        assert_eq!(store.transaction_optional(|_|Ok((None,42))).unwrap(),42);
        assert_eq!(fs::read(root.join("recording.json")).unwrap(),original);
    }
    #[test]
    fn shared_instance_serializes_updates_and_corruption_never_gets_overwritten() {
        let temp=Temp::new(); let store=Arc::new(SidecarFile::new(temp.0.clone(),Sidecar::Games).unwrap());
        let threads:Vec<_>=(0..8).map(|_| {let store=store.clone();std::thread::spawn(move||for _ in 0..10 {
            store.transaction(|old|Ok((json!({"count":old.and_then(|v|v["count"].as_u64()).unwrap_or(0)+1}),()))).unwrap();
        })}).collect();
        for thread in threads {thread.join().unwrap();}
        assert_eq!(store.read().unwrap().unwrap()["count"],80);
        fs::write(temp.0.join("game-profiles.json"),b"broken").unwrap();
        assert!(store.transaction(|_|Ok((json!({}),()))).is_err());
        assert_eq!(fs::read(temp.0.join("game-profiles.json")).unwrap(),b"broken");
    }
}
