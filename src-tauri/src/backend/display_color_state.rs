//! Read Electron's persisted Display color intent. These values are not driver
//! read-back: `sent` only records whether Arc Power previously sent a group.
//! This reader performs no writes; Display routing remains brokered until the
//! complete native payload has parity.

use super::store_file::{atomic_replace, reject_reparse_components};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs::{self, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}};

const MAX_BYTES: u64 = 16 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ColorState {
    pub hue: f64,
    pub saturation: f64,
    pub brightness: f64,
    pub contrast: f64,
    pub hue_saturation_sent: bool,
    pub brightness_contrast_sent: bool,
}

impl Default for ColorState {
    fn default() -> Self {
        Self { hue: 0.0, saturation: 1.0, brightness: 0.0, contrast: 1.0,
            hue_saturation_sent: false, brightness_contrast_sent: false }
    }
}

pub(crate) struct DisplayColorStore { dir: Option<PathBuf> }

impl DisplayColorStore {
    pub(crate) fn application_default() -> Self {
        Self { dir: std::env::var_os("APPDATA").filter(|value| !value.is_empty()).map(PathBuf::from)
            .or_else(|| std::env::var_os("USERPROFILE").filter(|value| !value.is_empty())
                .map(|root| PathBuf::from(root).join("AppData").join("Roaming")))
            .map(|root| root.join("ArcPower").join("DisplayColorSettings")) }
    }

    #[cfg(test)]
    fn at(dir: PathBuf) -> Self { Self { dir: Some(dir) } }

    pub(crate) fn read(&self, key: &str) -> Result<ColorState, String> {
        if key.is_empty() || key.encode_utf16().count() > 4096 {
            return Err("A valid stable display key is required.".into());
        }
        let Some(dir) = &self.dir else { return Err("Display color settings directory is unavailable.".into()) };
        if !dir.is_absolute() { return Err("Display color settings directory must be an absolute path.".into()); }
        match fs::symlink_metadata(dir) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(ColorState::default()),
            Err(error) => return Err(error.to_string()),
            Ok(meta) if !meta.is_dir() || meta.file_type().is_symlink() => return Err("Display color settings directory is linked or invalid.".into()),
            Ok(_) => {}
        }
        reject_reparse_components(dir)?;
        let path = record_path(dir, key);
        let metadata = match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(ColorState::default()),
            Err(error) => return Err(error.to_string()),
            Ok(metadata) => metadata,
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() || !unlinked(&metadata) || metadata.len() > MAX_BYTES {
            return Err("Display color record is linked or too large; refusing to trust it.".into());
        }
        reject_reparse_components(&path)?;
        let mut bytes = Vec::new();
        let file = open_record(&path)?;
        file.take(MAX_BYTES + 1)
            .read_to_end(&mut bytes).map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_BYTES { return Err("Display color record is too large.".into()); }
        let value: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        parse_record(&value, key)
    }

    /// Persist one Electron-compatible color group after its driver SET has
    /// been accepted. The caller holds the shared Display mutex across the
    /// driver transaction and this atomic store update.
    pub(crate) fn save_group(
        &self,
        key: &str,
        group: &str,
        hue_or_brightness: f64,
        saturation_or_contrast: f64,
    ) -> Result<ColorState, String> {
        let fields: [(&str, f64, f64, f64, f64); 2] = match group {
            "hueSaturation" => [
                ("hue", hue_or_brightness, -180.0, 180.0, 1.0),
                ("saturation", saturation_or_contrast, 0.0, 2.0, 0.02),
            ],
            "brightnessContrast" => [
                ("brightness", hue_or_brightness, -100.0, 100.0, 2.0),
                ("contrast", saturation_or_contrast, 0.0, 2.0, 0.02),
            ],
            _ => return Err("Invalid display color group.".into()),
        };
        for (name, value, min, max, step) in fields {
            if number(&serde_json::json!(value), min, max, step).is_none() {
                return Err(format!("Invalid {name} value or step."));
            }
        }
        let mut next = self.read(key)?;
        match group {
            "hueSaturation" => {
                next.hue = hue_or_brightness;
                next.saturation = saturation_or_contrast;
                next.hue_saturation_sent = true;
            }
            "brightnessContrast" => {
                next.brightness = hue_or_brightness;
                next.contrast = saturation_or_contrast;
                next.brightness_contrast_sent = true;
            }
            _ => unreachable!("group validated above"),
        }
        let Some(dir) = &self.dir else {
            return Err("Display color settings directory is unavailable.".into());
        };
        ensure_color_directory(dir)?;
        let path = record_path(dir, key);
        reject_reparse_components(&path)?;
        atomic_write(&path, &record_value(key, &next))?;
        Ok(next)
    }
}

#[cfg(windows)]
fn open_record(path: &Path) -> Result<fs::File, String> {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_SHARE_DELETE};
    let file = fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(path).map_err(|error| error.to_string())?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    if info.dwFileAttributes & 0x410 != 0 || info.nNumberOfLinks != 1 {
        return Err("Display color record is linked or invalid; refusing to trust it.".into());
    }
    Ok(file)
}

#[cfg(not(windows))]
fn open_record(path: &Path) -> Result<fs::File, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || !unlinked(&metadata) { return Err("Display color record is linked or invalid.".into()); }
    Ok(file)
}

fn record_path(dir: &Path, key: &str) -> PathBuf {
    let digest = Sha256::digest(key.as_bytes());
    let name: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    dir.join(format!("{name}.json"))
}

fn record_value(key: &str, state: &ColorState) -> Value {
    serde_json::json!({
        "version": 1,
        "displayKey": key,
        "values": {
            "hue": state.hue,
            "saturation": state.saturation,
            "brightness": state.brightness,
            "contrast": state.contrast,
        },
        "sent": {
            "hueSaturation": state.hue_saturation_sent,
            "brightnessContrast": state.brightness_contrast_sent,
        },
    })
}

fn ensure_color_directory(dir: &Path) -> Result<(), String> {
    if !dir.is_absolute() { return Err("Display color settings directory must be an absolute path.".into()); }
    reject_reparse_components(dir)?;
    match fs::symlink_metadata(dir) {
        Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
            return Err("Display color settings directory is linked or invalid.".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        }
        Err(error) => return Err(error.to_string()),
    }
    reject_reparse_components(dir)
}

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
        reject_reparse_components(file)?;
        atomic_replace(&temporary, file)
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

fn exact<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a serde_json::Map<String, Value>> {
    let map = value.as_object()?;
    (map.len() == keys.len() && map.keys().all(|key| keys.contains(&key.as_str()))).then_some(map)
}

fn number(value: &Value, min: f64, max: f64, step: f64) -> Option<f64> {
    let value = value.as_f64()?;
    let steps = (value - min) / step;
    (value.is_finite() && value >= min && value <= max && (steps - steps.round()).abs() <= 1e-7).then_some(value)
}

fn parse_record(value: &Value, key: &str) -> Result<ColorState, String> {
    let record = exact(value, &["version", "displayKey", "values", "sent"])
        .ok_or("Display color record identity or schema is invalid.")?;
    if record["version"].as_f64() != Some(1.0) || record["displayKey"].as_str() != Some(key) {
        return Err("Display color record identity or schema is invalid.".into());
    }
    let values = exact(&record["values"], &["hue", "saturation", "brightness", "contrast"])
        .ok_or("Display color values schema is invalid.")?;
    let sent = exact(&record["sent"], &["hueSaturation", "brightnessContrast"])
        .ok_or("Display color sent-state schema is invalid.")?;
    Ok(ColorState {
        hue: number(&values["hue"], -180.0, 180.0, 1.0).ok_or("Invalid hue value.")?,
        saturation: number(&values["saturation"], 0.0, 2.0, 0.02).ok_or("Invalid saturation value.")?,
        brightness: number(&values["brightness"], -100.0, 100.0, 2.0).ok_or("Invalid brightness value.")?,
        contrast: number(&values["contrast"], 0.0, 2.0, 0.02).ok_or("Invalid contrast value.")?,
        hue_saturation_sent: sent["hueSaturation"].as_bool().ok_or("Display color sent-state schema is invalid.")?,
        brightness_contrast_sent: sent["brightnessContrast"].as_bool().ok_or("Display color sent-state schema is invalid.")?,
    })
}

#[cfg(windows)]
fn unlinked(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 == 0
}
#[cfg(unix)]
fn unlinked(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.nlink() == 1
}
#[cfg(not(any(windows, unix)))]
fn unlinked(_: &fs::Metadata) -> bool { true }

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("arc-display-color-test-{:032x}", rand::random::<u128>()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &Path { &self.0 }
    }
    impl Drop for TempDir { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    fn record(key: &str) -> Value { json!({"version":1,"displayKey":key,
        "values":{"hue":12,"saturation":1.2,"brightness":-10,"contrast":0.8},
        "sent":{"hueSaturation":true,"brightnessContrast":false}}) }

    #[test]
    fn reads_electron_record_and_preserves_sent_provenance() {
        let dir = TempDir::new();
        let key = "pci:1|display|example";
        fs::write(record_path(dir.path(), key), serde_json::to_vec(&record(key)).unwrap()).unwrap();
        assert_eq!(DisplayColorStore::at(dir.path().into()).read(key).unwrap(), ColorState {
            hue: 12.0, saturation: 1.2, brightness: -10.0, contrast: 0.8,
            hue_saturation_sent: true, brightness_contrast_sent: false });
    }

    #[test]
    fn save_group_preserves_other_group_and_round_trips_electron_schema() {
        let dir = TempDir::new();
        let store = DisplayColorStore::at(dir.path().into());
        let key = "pci:1|display|output|edid|abc";
        let first = store.save_group(key, "hueSaturation", 21.0, 1.24).unwrap();
        assert_eq!(first.hue, 21.0);
        assert_eq!(first.saturation, 1.24);
        assert!(first.hue_saturation_sent);
        assert!(!first.brightness_contrast_sent);

        let second = store.save_group(key, "brightnessContrast", -14.0, 0.82).unwrap();
        assert_eq!(second.hue, 21.0);
        assert_eq!(second.saturation, 1.24);
        assert_eq!(second.brightness, -14.0);
        assert_eq!(second.contrast, 0.82);
        assert_eq!(DisplayColorStore::at(dir.path().into()).read(key).unwrap(), second);
    }

    #[test]
    fn save_group_rejects_bad_groups_values_and_corrupt_existing_record() {
        let dir = TempDir::new();
        let store = DisplayColorStore::at(dir.path().into());
        assert!(store.save_group("display", "unknown", 0.0, 1.0).is_err());
        assert!(store.save_group("display", "hueSaturation", 0.5, 1.0).is_err());
        assert!(store.save_group("display", "brightnessContrast", 0.0, 1.01).is_err());
        let path = record_path(dir.path(), "display");
        fs::write(&path, b"corrupt").unwrap();
        assert!(store.save_group("display", "hueSaturation", 0.0, 1.0).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"corrupt");
    }

    #[test]
    fn missing_record_returns_unsent_defaults() {
        let dir = TempDir::new();
        assert_eq!(DisplayColorStore::at(dir.path().into()).read("display").unwrap(), ColorState::default());
        assert!(DisplayColorStore { dir: None }.read("display").is_err());
        assert!(DisplayColorStore::at(PathBuf::from("relative")).read("display").is_err());
    }

    #[test]
    fn rejects_wrong_identity_schema_and_invalid_steps() {
        let key = "display";
        let mut value = record(key);
        assert!(parse_record(&value, "other").is_err());
        value["values"]["saturation"] = json!(1.01);
        assert!(parse_record(&value, key).is_err());
        value = record(key);
        value["sent"]["extra"] = json!(false);
        assert!(parse_record(&value, key).is_err());
    }

    #[test]
    fn rejects_oversized_records_and_long_keys() {
        let dir = TempDir::new();
        fs::write(record_path(dir.path(), "display"), vec![b' '; MAX_BYTES as usize + 1]).unwrap();
        let store = DisplayColorStore::at(dir.path().into());
        assert!(store.read("display").is_err());
        assert!(store.read(&"x".repeat(4097)).is_err());
    }

    #[test]
    fn uses_electron_sha256_filename_and_rejects_hard_links() {
        let dir = TempDir::new();
        let path = record_path(dir.path(), "abc");
        assert_eq!(path.file_name().unwrap().to_str().unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.json");
        fs::write(&path, serde_json::to_vec(&record("abc")).unwrap()).unwrap();
        fs::hard_link(&path, dir.path().join("second-link")).unwrap();
        assert!(DisplayColorStore::at(dir.path().into()).read("abc").is_err());
    }
}
