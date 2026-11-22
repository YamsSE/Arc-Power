//! Port of Electron's `display-scaling-state.js`: the durable Display scaling
//! editor selection, one file per stable display identity.
//!
//! Path: `%APPDATA%\ArcPower\DisplayScalingSettings\<sha256(displayKey)>.json`
//! Schema: `{version:1, displayKey, state:{identityScaling,
//! nativePreferredScalingType, customX, customY}}`.
//!
//! Native scaling writes commit this selector inside their own Scaling Mode
//! transaction, and invalidation reconciliation can run in either host, so this
//! record may be written by Electron or by the native path. Writes use
//! exclusive-create + `MoveFileEx` replacement, and a record that fails
//! identity/schema validation is never overwritten: the reader reports the
//! failure and the Display read keeps its driver value instead of inventing a
//! preference.

use super::store_file::{atomic_replace, reject_reparse_components};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs::{self, OpenOptions}, io::Write, path::{Path, PathBuf}};

/// `MAX_RECORD_BYTES` from the oracle; a larger file is never trusted.
const MAX_RECORD_BYTES: u64 = 16 * 1024;
/// `NATIVE_SCALING_TYPES`: the driver's `PreferredScalingType` flag values.
const NATIVE_SCALING_TYPES: [u32; 6] = [0, 1, 2, 4, 8, 16];
const STATE_KEYS: [&str; 4] = ["identityScaling", "nativePreferredScalingType", "customX", "customY"];

/// A persisted record's `state`. `custom_x`/`custom_y` are always written
/// together and are `None` only before the first custom selection.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ScalingSelection {
    pub(crate) identity_scaling: bool,
    pub(crate) native_preferred_scaling_type: Option<u32>,
    pub(crate) custom_x: Option<u32>,
    pub(crate) custom_y: Option<u32>,
}

/// A partial selection write. `saveSelection` preserves the stored custom
/// coordinates when the caller omits them, so the update carries the pair
/// explicitly; ordinary selection changes and reconciliations may omit it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SelectionUpdate {
    pub(crate) identity_scaling: bool,
    pub(crate) native_preferred_scaling_type: Option<u32>,
    pub(crate) custom: Option<(u32, u32)>,
}

impl SelectionUpdate {
    fn selection(self, current: Option<ScalingSelection>) -> ScalingSelection {
        ScalingSelection {
            identity_scaling: self.identity_scaling,
            native_preferred_scaling_type: self.native_preferred_scaling_type,
            custom_x: self.custom.map(|(x, _)| x).or(current.and_then(|state| state.custom_x)),
            custom_y: self.custom.map(|(_, y)| y).or(current.and_then(|state| state.custom_y)),
        }
    }
}

/// The store itself. `dir: None` is the degraded host (no roaming-profile
/// root): reads report "no selection" and writes validate but persist
/// nothing. A failure here only ever costs the preference hint; it never
/// fails a Display read.
pub(crate) struct DisplayScalingStore {
    dir: Option<PathBuf>,
}

impl DisplayScalingStore {
    /// `createDisplayScalingStateStore({dir})`: the directory must be absolute.
    /// Production always uses `application_default()`; tests need a temp root.
    #[cfg(test)]
    pub(crate) fn at(dir: PathBuf) -> Result<Self, String> {
        if !dir.is_absolute() {
            return Err("Display scaling settings directory must be an absolute path or null.".into());
        }
        Ok(Self { dir: Some(dir) })
    }

    /// `defaultDirectory()`: `%APPDATA%\ArcPower\DisplayScalingSettings`.
    pub(crate) fn application_default() -> Self {
        let root = std::env::var_os("APPDATA").filter(|value| !value.is_empty()).map(PathBuf::from)
            .or_else(|| std::env::var_os("USERPROFILE").filter(|value| !value.is_empty())
                .or_else(|| std::env::var_os("HOME").filter(|value| !value.is_empty()))
                .map(PathBuf::from).map(|home| home.join("AppData").join("Roaming")));
        let dir = root.map(|root| root.join("ArcPower").join("DisplayScalingSettings"))
            .filter(|path| path.is_absolute());
        Self { dir }
    }

    /// `read`: `Ok(None)` when the directory or record is absent. A linked,
    /// oversized, malformed, foreign-key or future-schema record is an error.
    pub(crate) fn read(&self, display_key: &str) -> Result<Option<ScalingSelection>, String> {
        validate_display_key(display_key)?;
        let Some(dir) = &self.dir else { return Ok(None) };
        if !ensure_safe_directory(dir, false)? { return Ok(None); }
        read_record(&record_path(dir, display_key), display_key)
    }

    /// `saveSelection`: validate, load, merge, then atomically replace.
    pub(crate) fn save_selection(
        &self,
        display_key: &str,
        update: &SelectionUpdate,
    ) -> Result<ScalingSelection, String> {
        validate_display_key(display_key)?;
        validate_native_preferred(update.native_preferred_scaling_type)?;
        if let Some((x, y)) = update.custom {
            if x > 100 { return Err("Display customX scaling value is invalid.".into()); }
            if y > 100 { return Err("Display customY scaling value is invalid.".into()); }
        }
        let current = self.read(display_key)?;
        let next = update.selection(current);
        let Some(dir) = &self.dir else { return Ok(next) };
        ensure_safe_directory(dir, true)?;
        atomic_write(&record_path(dir, display_key), &record_value(display_key, &next))?;
        Ok(next)
    }

    /// Clear a stale identity-selection bit only if the exact selection staged
    /// by the caller is still present. Callers must hold the shared Display
    /// mutex across driver revalidation and this compare/write transaction.
    /// A missing or changed record is a refusal, never an invitation to merge
    /// a newer user selection into an old driver observation.
    pub(crate) fn invalidate_if_current(
        &self,
        display_key: &str,
        expected: ScalingSelection,
    ) -> Result<bool, String> {
        validate_display_key(display_key)?;
        if !expected.identity_scaling { return Ok(false); }
        let Some(dir) = &self.dir else { return Ok(false) };
        if !ensure_safe_directory(dir, false)? { return Ok(false); }
        let path = record_path(dir, display_key);
        if read_record(&path, display_key)? != Some(expected) { return Ok(false); }
        let next = ScalingSelection { identity_scaling: false, ..expected };
        atomic_write(&path, &record_value(display_key, &next))?;
        Ok(true)
    }
}

fn validate_display_key(display_key: &str) -> Result<(), String> {
    // JavaScript's `displayKey.length` counts UTF-16 code units.
    let length = display_key.encode_utf16().count();
    if length == 0 || length > 4096 {
        return Err("A valid stable display key is required.".into());
    }
    Ok(())
}

fn validate_native_preferred(value: Option<u32>) -> Result<(), String> {
    if value.is_some_and(|value| !NATIVE_SCALING_TYPES.contains(&value)) {
        return Err("Display native preferred scaling type is invalid.".into());
    }
    Ok(())
}

fn display_file_name(display_key: &str) -> String {
    let digest = Sha256::digest(display_key.as_bytes());
    let mut name = String::with_capacity(64 + 5);
    for byte in digest { name.push_str(&format!("{byte:02x}")); }
    name.push_str(".json");
    name
}

fn record_path(dir: &Path, display_key: &str) -> PathBuf {
    dir.join(display_file_name(display_key))
}

fn record_value(display_key: &str, state: &ScalingSelection) -> Value {
    json!({
        "version": 1,
        "displayKey": display_key,
        "state": {
            "identityScaling": state.identity_scaling,
            "nativePreferredScalingType": state.native_preferred_scaling_type,
            "customX": state.custom_x,
            "customY": state.custom_y,
        },
    })
}

fn object_has_exactly<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a serde_json::Map<String, Value>> {
    let object = value.as_object()?;
    (object.len() == keys.len() && object.keys().all(|key| keys.contains(&key.as_str()))).then_some(object)
}

/// `validateState`: exactly four known keys, boolean selection, a flag value
/// from the driver set, and a paired 0-100 custom pair.
fn parse_state(value: &Value) -> Result<ScalingSelection, String> {
    let state = object_has_exactly(value, &STATE_KEYS)
        .ok_or("Display scaling state schema is invalid.")?;
    let identity_scaling = state["identityScaling"].as_bool()
        .ok_or("Display identity scaling selection is invalid.")?;
    let native_preferred_scaling_type = match &state["nativePreferredScalingType"] {
        Value::Null => None,
        Value::Number(number) => {
            let value = number.as_u64().and_then(|value| u32::try_from(value).ok())
                .filter(|value| NATIVE_SCALING_TYPES.contains(value))
                .ok_or("Display native preferred scaling type is invalid.")?;
            Some(value)
        }
        _ => return Err("Display native preferred scaling type is invalid.".into()),
    };
    let custom_x = parse_custom(&state["customX"], "customX")?;
    let custom_y = parse_custom(&state["customY"], "customY")?;
    if custom_x.is_some() != custom_y.is_some() {
        return Err("Custom display scaling values must be paired.".into());
    }
    Ok(ScalingSelection { identity_scaling, native_preferred_scaling_type, custom_x, custom_y })
}

fn parse_custom(value: &Value, key: &str) -> Result<Option<u32>, String> {
    match value {
        Value::Null => Ok(None),
        Value::Number(number) => number.as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .filter(|value| *value <= 100)
            .map(Some)
            .ok_or_else(|| format!("Display {key} scaling value is invalid.")),
        _ => Err(format!("Display {key} scaling value is invalid.")),
    }
}

/// `validateRecord`: the record must belong to exactly this display key.
fn parse_record(value: &Value, display_key: &str) -> Result<ScalingSelection, String> {
    let record = object_has_exactly(value, &["version", "displayKey", "state"])
        .ok_or("Display scaling record identity or schema is invalid.")?;
    if record["version"].as_f64() != Some(1.0) || record["displayKey"].as_str() != Some(display_key) {
        return Err("Display scaling record identity or schema is invalid.".into());
    }
    parse_state(&record["state"])
}

fn read_record(file: &Path, display_key: &str) -> Result<Option<ScalingSelection>, String> {
    let metadata = match fs::symlink_metadata(file) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || !unlinked(&metadata)
        || metadata.len() > MAX_RECORD_BYTES
    {
        return Err("Display scaling record is linked or too large; refusing to trust it.".into());
    }
    let bytes = fs::read(file).map_err(|error| error.to_string())?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    parse_record(&value, display_key).map(Some)
}

/// Stable metadata offers no hard-link count on Windows, so the reparse-point
/// attribute (which `is_symlink` does not cover for every tag) is the guard
/// there; Unix rejects a file with any other link.
#[cfg(windows)]
fn unlinked(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
}

#[cfg(unix)]
fn unlinked(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.nlink() == 1
}

#[cfg(not(any(windows, unix)))]
fn unlinked(_metadata: &fs::Metadata) -> bool { true }

/// `ensureSafeDirectory`: a missing directory is `false` unless the caller is
/// writing, and an existing directory may not be a link.
fn ensure_safe_directory(dir: &Path, create: bool) -> Result<bool, String> {
    match fs::symlink_metadata(dir) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !create { return Ok(false); }
            fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        }
        Err(error) => return Err(error.to_string()),
    }
    let metadata = fs::symlink_metadata(dir).map_err(|error| error.to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Display scaling settings directory is linked or invalid.".into());
    }
    reject_reparse_components(dir)?;
    Ok(true)
}

/// `atomicWrite`: exclusive-create the temporary file, sync it, then replace
/// the destination in one operation. The temporary name carries this process's
/// id, so two writers never share a scratch file.
fn atomic_write(file: &Path, record: &Value) -> Result<(), String> {
    let mut temporary = file.as_os_str().to_owned();
    temporary.push(format!(".{}.{:016x}.tmp", std::process::id(), rand::random::<u64>()));
    let temporary = PathBuf::from(temporary);
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let bytes = serde_json::to_vec(record).map_err(|error| error.to_string())?;
        let mut handle = options.open(&temporary).map_err(|error| error.to_string())?;
        handle.write_all(&bytes).map_err(|error| error.to_string())?;
        handle.sync_all().map_err(|error| error.to_string())?;
        drop(handle);
        reject_reparse_components(&temporary)?;
        atomic_replace(&temporary, file)
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("arc-display-scaling-test-{:032x}", rand::random::<u128>()));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn store(&self) -> DisplayScalingStore { DisplayScalingStore::at(self.0.join("DisplayScalingSettings")).unwrap() }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            if self.0.parent() == Some(std::env::temp_dir().as_path()) { let _ = fs::remove_dir_all(&self.0); }
        }
    }

    const KEY: &str = "pci:0x00008086:0x0000e20b@3:0.0|display|4100000000000000000000000000000000aa|edid|0f0e0d0c";

    fn selection(identity: bool, native: Option<u32>, custom: Option<(u32, u32)>) -> SelectionUpdate {
        SelectionUpdate { identity_scaling: identity, native_preferred_scaling_type: native, custom }
    }

    #[test]
    fn round_trip_writes_the_oracle_schema_at_the_hashed_path() {
        let temp = Temp::new();
        let store = temp.store();
        assert_eq!(store.read(KEY).unwrap(), None);
        // A read must not create the directory (the oracle's create=false).
        assert!(!temp.0.join("DisplayScalingSettings").exists());

        let saved = store.save_selection(KEY, &selection(true, Some(8), Some((90, 70)))).unwrap();
        assert_eq!(saved, ScalingSelection {
            identity_scaling: true, native_preferred_scaling_type: Some(8),
            custom_x: Some(90), custom_y: Some(70),
        });
        assert_eq!(store.read(KEY).unwrap(), Some(saved));

        let dir = temp.0.join("DisplayScalingSettings");
        let entries: Vec<_> = fs::read_dir(&dir).unwrap().map(|entry| entry.unwrap().path()).collect();
        assert_eq!(entries.len(), 1, "the temporary file never survives a successful write");
        assert_eq!(entries[0].file_name().unwrap().to_string_lossy(), display_file_name(KEY));
        let raw: Value = serde_json::from_slice(&fs::read(&entries[0]).unwrap()).unwrap();
        assert_eq!(raw, json!({
            "version": 1, "displayKey": KEY,
            "state": {"identityScaling": true, "nativePreferredScalingType": 8, "customX": 90, "customY": 70},
        }));
        // JSON.stringify has no trailing newline; the Electron reader shares it.
        assert!(!fs::read(&entries[0]).unwrap().ends_with(b"\n"));
    }

    #[test]
    fn a_partial_write_merges_the_stored_custom_pair() {
        let temp = Temp::new();
        let store = temp.store();
        store.save_selection(KEY, &selection(true, Some(2), Some((90, 70)))).unwrap();
        // A partial selection update omits the custom pair and must keep it.
        let invalidated = store.save_selection(KEY, &selection(false, Some(2), None)).unwrap();
        assert_eq!(invalidated, ScalingSelection {
            identity_scaling: false, native_preferred_scaling_type: Some(2),
            custom_x: Some(90), custom_y: Some(70),
        });
        assert_eq!(store.read(KEY).unwrap(), Some(invalidated));
        // A selection with a null fingerprint is a valid record too.
        let null_fingerprint = store.save_selection(KEY, &selection(false, None, None)).unwrap();
        assert_eq!(null_fingerprint.native_preferred_scaling_type, None);
    }

    #[test]
    fn conditional_invalidation_preserves_custom_coordinates_and_refuses_a_changed_record() {
        let temp = Temp::new();
        let store = temp.store();
        let original = selection(true, Some(8), Some((90, 70)));
        let expected = store.save_selection(KEY, &original).unwrap();
        let invalidated = ScalingSelection { identity_scaling: false, ..expected };

        assert!(store.invalidate_if_current(KEY, expected).unwrap());
        assert_eq!(store.read(KEY).unwrap(), Some(invalidated));

        // A later user selection wins. An old staged intent cannot clear it
        // or replace its fingerprint/custom values.
        let later = store.save_selection(KEY, &selection(true, Some(2), Some((75, 60)))).unwrap();
        let dir = temp.0.join("DisplayScalingSettings");
        let path = dir.join(display_file_name(KEY));
        let before = fs::read(&path).unwrap();
        assert!(!store.invalidate_if_current(KEY, expected).unwrap());
        assert_eq!(store.read(KEY).unwrap(), Some(later));
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn schema_and_identity_mismatches_are_refused_without_rewriting_bytes() {
        let temp = Temp::new();
        let store = temp.store();
        store.save_selection(KEY, &selection(true, Some(1), Some((10, 20)))).unwrap();
        let dir = temp.0.join("DisplayScalingSettings");
        let path = dir.join(display_file_name(KEY));
        let original = fs::read(&path).unwrap();

        let corrupt: Vec<Vec<u8>> = vec![
            b"not json".to_vec(),
            serde_json::to_vec(&json!({"version": 2, "displayKey": KEY, "state": {
                "identityScaling": true, "nativePreferredScalingType": 1, "customX": 10, "customY": 20}})).unwrap(),
            serde_json::to_vec(&json!({"version": 1, "displayKey": "other", "state": {
                "identityScaling": true, "nativePreferredScalingType": 1, "customX": 10, "customY": 20}})).unwrap(),
            serde_json::to_vec(&json!({"version": 1, "displayKey": KEY, "state": {
                "identityScaling": true, "nativePreferredScalingType": 1, "customX": 10, "customY": 20}, "extra": 1})).unwrap(),
            serde_json::to_vec(&json!({"version": 1, "displayKey": KEY, "state": {
                "identityScaling": "yes", "nativePreferredScalingType": 1, "customX": 10, "customY": 20}})).unwrap(),
            serde_json::to_vec(&json!({"version": 1, "displayKey": KEY, "state": {
                "identityScaling": true, "nativePreferredScalingType": 3, "customX": 10, "customY": 20}})).unwrap(),
            serde_json::to_vec(&json!({"version": 1, "displayKey": KEY, "state": {
                "identityScaling": true, "nativePreferredScalingType": 1, "customX": 10, "customY": null}})).unwrap(),
            serde_json::to_vec(&json!({"version": 1, "displayKey": KEY, "state": {
                "identityScaling": true, "nativePreferredScalingType": 1, "customX": 101, "customY": 20}})).unwrap(),
            serde_json::to_vec(&json!({"version": 1, "displayKey": KEY, "state": {
                "identityScaling": true, "nativePreferredScalingType": 1, "customX": 10}})).unwrap(),
        ];
        for bytes in corrupt {
            fs::write(&path, &bytes).unwrap();
            assert!(store.read(KEY).is_err(), "{}", String::from_utf8_lossy(&bytes));
            // A save loads before writing, so a corrupt record is never replaced.
            assert!(store.save_selection(KEY, &selection(false, None, None)).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        fs::write(&path, &original).unwrap();
        assert!(store.read(KEY).unwrap().is_some());
        assert!(store.read("").is_err(), "an empty display key is invalid");
    }

    #[test]
    fn invalid_selections_are_refused_before_any_write() {
        let temp = Temp::new();
        let store = temp.store();
        assert!(store.save_selection(KEY, &selection(true, Some(3), None)).is_err(), "flag value must be in the driver set");
        assert!(store.save_selection(KEY, &selection(true, Some(1), Some((101, 0)))).is_err());
        assert!(!temp.0.join("DisplayScalingSettings").exists());
        assert!(DisplayScalingStore::at(PathBuf::from("relative")).is_err());
    }

    #[test]
    #[cfg(windows)]
    fn a_denied_replacement_leaves_the_previous_record_and_no_scratch_file() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = Temp::new();
        let store = temp.store();
        store.save_selection(KEY, &selection(true, Some(1), Some((10, 20)))).unwrap();
        let dir = temp.0.join("DisplayScalingSettings");
        let path = dir.join(display_file_name(KEY));
        let original = fs::read(&path).unwrap();
        // Allow reads but deny delete/rename, as an antivirus or the Electron
        // writer can while it owns the destination.
        let held = OpenOptions::new().read(true).share_mode(1).open(&path).unwrap();
        assert!(store.save_selection(KEY, &selection(false, None, None)).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "the temporary file is cleaned up");
        drop(held);
    }
}
