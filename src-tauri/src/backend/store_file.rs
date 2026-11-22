//! Fixed-root JSON store. No caller-supplied filenames or application data lookup.
use super::migrations::{assert_current_schema, migrate_store_data};
use serde_json::Value;
use std::{fs::{self, File, OpenOptions}, io::{Read, Write}, path::{Component, Path, PathBuf}, sync::{Mutex, MutexGuard}};

#[derive(Clone, Copy, Debug)]
pub enum StoreFile { Profiles, Settings }

impl StoreFile {
    fn filename(self) -> &'static str { match self { Self::Profiles => "profiles.json", Self::Settings => "settings.json" } }
    fn kind(self) -> &'static str { match self { Self::Profiles => "profiles", Self::Settings => "settings" } }
}

pub struct SchemaStore { root: PathBuf, lock: Mutex<()> }

fn error(context: &str, err: impl std::fmt::Display) -> String { format!("{context}: {err}") }

/// Reject links in every existing component, including Windows directory junctions.
pub(crate) fn reject_reparse_components(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                #[cfg(windows)]
                let reparse = {
                    use std::os::windows::fs::MetadataExt;
                    metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
                };
                #[cfg(not(windows))]
                let reparse = metadata.file_type().is_symlink();
                if reparse { return Err(format!("Store path contains a link or reparse point: {}", current.display())); }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => return Err(error("Cannot inspect store path", e)),
        }
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn atomic_replace(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination.as_os_str().encode_wide().chain(Some(0)).collect();
    let ok = unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) };
    if ok == 0 { Err(error("Atomic store replacement failed", std::io::Error::last_os_error())) } else { Ok(()) }
}

#[cfg(not(windows))]
pub(crate) fn atomic_replace(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|e| error("Atomic store replacement failed", e))
}

impl SchemaStore {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self, String> {
        let root = root.into();
        if !root.is_absolute() || root.components().any(|p| matches!(p, Component::ParentDir)) {
            return Err("Store root must be an absolute path without parent traversal".into());
        }
        if root.as_os_str().to_string_lossy().contains('\0') { return Err("Store root contains a NUL character".into()); }
        reject_reparse_components(&root)?;
        if root.exists() && !root.is_dir() { return Err("Store root is not a directory".into()); }
        Ok(Self { root, lock: Mutex::new(()) })
    }

    fn guard(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.lock.lock().map_err(|_| "Store transaction mutex was poisoned".into())
    }

    fn read_unlocked(&self, kind: StoreFile) -> Result<Option<(Value, bool)>, String> {
        let path = self.root.join(kind.filename());
        reject_reparse_components(&path)?;
        let mut file = match File::open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(error("Cannot open store file", e)),
        };
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(|e| error("Cannot read store file", e))?;
        let content = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
        let original: Value = serde_json::from_slice(content).map_err(|e| error("Corrupt store JSON; refusing to overwrite", e))?;
        let migrated = migrate_store_data(&original, kind.kind())?;
        assert_current_schema(&migrated)?;
        let changed = original != migrated;
        Ok(Some((migrated, changed)))
    }

    fn write_unlocked(&self, kind: StoreFile, data: &Value) -> Result<(), String> {
        assert_current_schema(data)?;
        let mut bytes = serde_json::to_vec_pretty(data).map_err(|e| error("Cannot serialize store", e))?;
        bytes.push(b'\n');
        reject_reparse_components(&self.root)?;
        fs::create_dir_all(&self.root).map_err(|e| error("Cannot create store directory", e))?;
        let destination = self.root.join(kind.filename());
        reject_reparse_components(&destination)?;
        let mut created = None;
        for _ in 0..16 {
            let temporary = self.root.join(format!(".{}.{}.{:032x}.tmp", kind.filename(), std::process::id(), rand::random::<u128>()));
            match OpenOptions::new().write(true).create_new(true).open(&temporary) {
                Ok(file) => { created = Some((temporary, file)); break; }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(error("Cannot create exclusive store temporary file", e)),
            }
        }
        let (temporary, mut file) = created.ok_or("Cannot allocate unique store temporary file")?;
        let result = (|| {
            file.write_all(&bytes).map_err(|e| error("Cannot write store temporary file", e))?;
            file.flush().map_err(|e| error("Cannot flush store temporary file", e))?;
            file.sync_all().map_err(|e| error("Cannot sync store temporary file", e))?;
            drop(file);
            reject_reparse_components(&temporary)?;
            reject_reparse_components(&destination)?;
            atomic_replace(&temporary, &destination)
        })();
        if result.is_err() { let _ = fs::remove_file(&temporary); }
        result
    }

    /// Load and persist a migration once. Missing files do not create a directory.
    pub fn load(&self, kind: StoreFile) -> Result<Option<Value>, String> {
        let _guard = self.guard()?;
        let Some((data, changed)) = self.read_unlocked(kind)? else { return Ok(None); };
        if changed { self.write_unlocked(kind, &data)?; }
        Ok(Some(data))
    }

    /// Existing corrupt or future-schema files are validated before any replacement.
    pub fn save(&self, kind: StoreFile, data: &Value) -> Result<Value, String> {
        let _guard = self.guard()?;
        self.read_unlocked(kind)?;
        let data = migrate_store_data(data, kind.kind())?;
        self.write_unlocked(kind, &data)?;
        Ok(data)
    }

    /// The closure runs under the same lock as reading and atomic replacement.
    /// A closure error leaves the original bytes intact, including legacy schemas.
    pub fn transaction<F>(&self, kind: StoreFile, update: F) -> Result<Value, String>
    where F: FnOnce(Option<Value>) -> Result<Value, String> {
        let _guard = self.guard()?;
        let current = self.read_unlocked(kind)?.map(|(value, _)| value);
        let updated = update(current)?;
        let updated = migrate_store_data(&updated, kind.kind())?;
        self.write_unlocked(kind, &updated)?;
        Ok(updated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("arc-power-store-test-{:032x}", rand::random::<u128>()));
            fs::create_dir(&path).unwrap(); Self(path)
        }
        fn store(&self) -> SchemaStore { SchemaStore::new(self.0.clone()).unwrap() }
    }
    impl Drop for Temp { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn missing_file_does_not_create_store_directory() {
        let temp = Temp::new();
        let missing = temp.0.join("absent");
        let store = SchemaStore::new(missing.clone()).unwrap();
        assert_eq!(store.load(StoreFile::Settings).unwrap(),None);
        assert!(!missing.exists());
        assert!(SchemaStore::new("relative").is_err());
        assert!(SchemaStore::new(temp.0.join("..").join("escape")).is_err());
    }

    #[test]
    fn bom_legacy_migration_persists_once_and_retains_v2_fields() {
        let temp = Temp::new(); let store = temp.store();
        let path = temp.0.join("settings.json");
        let mut bytes = vec![0xef,0xbb,0xbf];
        bytes.extend(br#"{"schemaVersion":2,"overlayStats":["fps"],"custom":{"x":1}}"#);
        fs::write(&path,bytes).unwrap();
        let migrated = store.load(StoreFile::Settings).unwrap().unwrap();
        assert_eq!(migrated["overlayStats"],json!(["fps","gpu-voltage","gpu-vram-temp"]));
        assert_eq!(migrated["custom"],json!({"x":1}));
        let after = fs::read(&path).unwrap();
        assert!(!after.starts_with(&[0xef,0xbb,0xbf]));
        // A current-schema file remains byte-for-byte untouched, including formatting/BOM.
        let untouched = [vec![0xef,0xbb,0xbf],br#"{ "schemaVersion":3, "overlayStats":["fps"] }"#.to_vec()].concat();
        fs::write(&path,&untouched).unwrap();
        assert_eq!(store.load(StoreFile::Settings).unwrap().unwrap()["overlayStats"],json!(["fps"]));
        assert_eq!(fs::read(&path).unwrap(),untouched);
    }

    #[test]
    fn corrupt_and_newer_files_are_never_overwritten() {
        let temp = Temp::new(); let store = temp.store(); let path = temp.0.join("profiles.json");
        for bytes in [b"corrupt".as_slice(),br#"{"schemaVersion":4,"profiles":[{"important":true}]}"#.as_slice(),br#"{"schemaVersion":"3"}"#.as_slice()] {
            fs::write(&path,bytes).unwrap();
            assert!(store.load(StoreFile::Profiles).is_err());
            assert!(store.save(StoreFile::Profiles,&json!({"schemaVersion":3,"profiles":[]})).is_err());
            assert!(store.transaction(StoreFile::Profiles, |_| panic!("must not run")).is_err());
            assert_eq!(fs::read(&path).unwrap(),bytes);
        }
    }

    #[test]
    fn failed_transaction_and_invalid_update_preserve_original_bytes() {
        let temp = Temp::new(); let store = temp.store(); let path = temp.0.join("settings.json");
        let legacy = br#"{"schemaVersion":2,"custom":"retain"}"#;
        fs::write(&path,legacy).unwrap();
        assert!(store.transaction(StoreFile::Settings, |_| Err("cancelled".into())).is_err());
        assert_eq!(fs::read(&path).unwrap(),legacy);
        assert!(store.transaction(StoreFile::Settings, |_| Ok(json!({"schemaVersion":99}))).is_err());
        assert_eq!(fs::read(&path).unwrap(),legacy);
    }

    #[test]
    fn concurrent_transactions_serialize_read_modify_write() {
        let temp = Temp::new(); let store = Arc::new(temp.store());
        let threads:Vec<_> = (0..8).map(|_| { let store=Arc::clone(&store); std::thread::spawn(move || {
            for _ in 0..10 {
                store.transaction(StoreFile::Settings, |current| {
                    let mut current=current.unwrap_or_else(||json!({"schemaVersion":3,"count":0}));
                    current["count"]=json!(current["count"].as_u64().unwrap()+1);
                    Ok(current)
                }).unwrap();
            }
        }) }).collect();
        for thread in threads { thread.join().unwrap(); }
        assert_eq!(store.load(StoreFile::Settings).unwrap().unwrap()["count"],json!(80));
        assert_eq!(fs::read_dir(&temp.0).unwrap().count(),1);
    }

    #[cfg(windows)]
    #[test]
    fn failed_atomic_replacement_does_not_delete_existing_file() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp=Temp::new(); let store=temp.store(); let path=temp.0.join("settings.json");
        store.save(StoreFile::Settings,&json!({"schemaVersion":3,"value":"original"})).unwrap();
        let original=fs::read(&path).unwrap();
        // Allow reads but deny delete/rename, as an antivirus/editor lock can do.
        let held=OpenOptions::new().read(true).share_mode(1).open(&path).unwrap();
        assert!(store.save(StoreFile::Settings,&json!({"schemaVersion":3,"value":"replacement"})).is_err());
        assert_eq!(fs::read(&path).unwrap(),original);
        assert_eq!(fs::read_dir(&temp.0).unwrap().count(),1);
        drop(held);
    }

    #[cfg(windows)]
    #[test]
    fn directory_junctions_are_refused_at_root_and_child() {
        let temp=Temp::new(); let target=temp.0.join("target"); let link=temp.0.join("junction");
        fs::create_dir(&target).unwrap();
        let status=std::process::Command::new("cmd.exe").arg("/c").arg("mklink").arg("/J").arg(&link).arg(&target).status().unwrap();
        assert!(status.success());
        assert!(SchemaStore::new(link.clone()).is_err());
        assert!(SchemaStore::new(link.join("nested")).is_err());
        // Remove only the junction itself before normal temporary cleanup.
        fs::remove_dir(link).unwrap();
    }
}
