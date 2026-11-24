//! Renderer `overlay-layout-*` channels: one dispatcher owns the
//! snapshot -> mutation -> cache publication -> reaction order.
//!
//! `ipc-core.js` runs every layout request through one queue and, inside that
//! queue, publishes the committed settings snapshot to the compatibility
//! service's synchronous cache before it re-applies the selected layout. The
//! native dispatcher keeps that order in one place: the store side is a single
//! settings+sidecar transaction (the sidecar mutation and the settings write it
//! implies, under the layout and settings locks), the host then pushes the
//! transaction's own snapshot on `settings-cache`, and the advanced overlay
//! panel refreshes from the settings document it already polls.
//!
//! The payload adapter projects only the fields the JavaScript normalizer reads.
//! It preserves JavaScript's string checks, array filtering and numeric
//! coercion for the tagged values the native normalizer can match. A top-level
//! `null` layout and object-to-primitive coercions that can throw stay with the
//! compatibility handler so its exact TypeError messages remain authoritative.
use super::{native_store::NativeStore, overlay_layout::normalize_overlay_layout,
    services::{native_json, overlay_defaults}, wire::{self, WireValue}};
use serde_json::{json, Map, Value};

pub const CHANNELS: [&str; 5] = [
    "overlay-layouts-list", "overlay-layout-save", "overlay-layout-rename",
    "overlay-layout-select", "overlay-layout-delete",
];

/// The broker's two invalid-reply messages; the private store always answers a
/// complete pair, so these only guard against a future shape change.
const INVALID_SNAPSHOT: &str =
    "Native overlay layout snapshot returned an invalid settings cache";
const INVALID_TRANSACTION: &str =
    "Native overlay layout transaction returned an invalid settings snapshot";

pub fn handles(channel: &str) -> bool { CHANNELS.contains(&channel) }

/// Channels whose landed mutation re-applies the selected layout. The snapshot
/// read and a rename never apply one, exactly like the broker dispatcher.
pub fn applies_layout(channel: &str) -> bool {
    matches!(channel, "overlay-layout-save" | "overlay-layout-select" | "overlay-layout-delete")
}

/// Dispatch one layout channel. `None` keeps the compatibility service: a mock
/// run, a frame the tagged codec rejects, or a payload whose JavaScript
/// semantics only the handler can reproduce.
pub fn handle(store: &NativeStore, channel: &str, encoded: &Value) -> Option<Result<Value, String>> {
    let WireValue::Array(args) = wire::decode(encoded).ok()? else { return None; };
    match channel {
        "overlay-layouts-list" => Some(list(store, &args)),
        "overlay-layout-save" => save_payload(&args).map(|layout| save(store, &layout)),
        "overlay-layout-rename" => Some(mutate(store, "rename", &rename_payload(&args)?, None)),
        "overlay-layout-select" => Some(mutate(store, "select", &id_payload(&args), None)),
        "overlay-layout-delete" => Some(mutate(store, "delete", &id_payload(&args), None)),
        _ => None,
    }
}

/// The snapshot read returns the layout document itself, with the settings
/// cache the transaction published so the host can forward it unchanged.
fn list(store: &NativeStore, args: &[WireValue]) -> Result<Value, String> {
    if !args.is_empty() { return Err("overlay-layouts-list takes no arguments".into()); }
    let reply = native_json(store, "overlay-layout-list-snapshot", json!([]))?;
    encode_layout_data(reply.get("data").ok_or(INVALID_SNAPSHOT)?, None)
}

/// Save owns the normalization, exactly like the broker adapter: the shipped
/// path normalizes with the layout store's defaults (the current settings)
/// before the private transaction, which normalizes again under the settings
/// lock. Only a payload with an omitted field can observe a newer default.
fn save(store: &NativeStore, layout: &Value) -> Result<Value, String> {
    let defaults = overlay_defaults(&store.settings_store().load_settings()?);
    let normalized = normalize_overlay_layout(layout, &defaults)?;
    // A normalized null opacity is the JavaScript NaN that `Math.min`/`Math.max`
    // propagate. `JSON.stringify` writes it as sidecar null so a later load
    // inherits that load's defaults, and the broker adapter restores the
    // transient NaN in the reply the caller sees.
    let background = normalized.get("background");
    let transient_nan = background.and_then(|background| background.get("opacity")) == Some(&Value::Null);
    let nan_id = if transient_nan { normalized.get("id").and_then(Value::as_str) } else { None };
    mutate(store, "save", &normalized, nan_id)
}

/// One private native-store transaction owns the sidecar mutation and the
/// settings write it implies, and answers the committed settings cache next to
/// the layout document, so the host publishes the same moment the reply
/// describes.
fn mutate(store: &NativeStore, method: &str, value: &Value, transient_nan_id: Option<&str>) -> Result<Value, String> {
    let reply = native_json(store, "overlay-layout-mutate-and-apply", json!([method, value]))?;
    encode_layout_data(reply.get("data").ok_or(INVALID_TRANSACTION)?, transient_nan_id)
}

/// Encode the layout document as the renderer's tagged value, restoring the
/// transient NaN opacity a save reply carries for the layout it just wrote.
fn encode_layout_data(data: &Value, transient_nan_id: Option<&str>) -> Result<Value, String> {
    let mut value = wire::decode(&wire::encode_json(data)?)?;
    if let Some(id) = transient_nan_id { restore_nan_opacity(&mut value, id); }
    Ok(wire::tagged(&value))
}

fn restore_nan_opacity(value: &mut WireValue, id: &str) {
    let WireValue::Object(entries) = value else { return; };
    let Some((_, WireValue::Array(layouts))) = entries.iter_mut().find(|(key, _)| key == "layouts") else { return; };
    for layout in layouts {
        let WireValue::Object(fields) = layout else { continue; };
        let matches = fields.iter().any(|(key, value)| key == "id"
            && matches!(value, WireValue::String(value) if value == id));
        if !matches { continue; }
        let Some((_, WireValue::Object(background))) = fields.iter_mut().find(|(key, _)| key == "background") else { continue; };
        if let Some((_, opacity)) = background.iter_mut().find(|(key, _)| key == "opacity") {
            *opacity = WireValue::SpecialNumber("NaN".into());
        }
    }
}

/// The normalizer reads these top-level fields only. Keeping the projection
/// narrow matters for tagged values in ignored fields: JavaScript never
/// coerces them, so they must not force a broker round trip.
const LAYOUT_FIELDS: [&str; 9] = [
    "id", "name", "position", "scale", "theme", "stats", "deviceKeys",
    "background", "advancedPosition",
];

fn field<'a>(entries: &'a [(String, WireValue)], key: &str) -> Option<&'a WireValue> {
    entries.iter().find(|(name, _)| name == key).map(|(_, value)| value)
}

fn string_field(value: Option<&WireValue>) -> Option<Value> {
    match value? {
        WireValue::Undefined => None,
        WireValue::String(value) => Some(json!(value)),
        // For the string-only fields, null and every other non-string take
        // the same fallback branch in safeText/position/theme checks.
        _ => Some(Value::Null),
    }
}

fn string_array_field(value: Option<&WireValue>) -> Option<Value> {
    match value? {
        WireValue::Undefined => None,
        WireValue::Null => Some(Value::Null), // nullish coalescing uses defaults
        WireValue::Array(values) => Some(Value::Array(values.iter().filter_map(|value| {
            if let WireValue::String(value) = value { Some(json!(value)) } else { None }
        }).collect())),
        // A present, non-nullish non-array produces an empty stats array or
        // null deviceKeys; it must not accidentally inherit fallback values.
        _ => Some(json!(false)),
    }
}

fn special_number_text(value: &str, array_element: bool) -> &str {
    if array_element && value == "-0" { "0" } else { value }
}

/// Convert the values that Number() can safely consume through the existing
/// JS-number implementation. In arrays, JS first stringifies each element, so
/// undefined/null become empty slots and -0 becomes "0". Plain objects stringify
/// as [object Object], while an own `toString` data property can make the
/// coercion throw; that ambiguous case stays with Electron.
fn number_payload(value: &WireValue) -> Option<Value> {
    number_payload_inner(value, false)
}

fn number_payload_inner(value: &WireValue, array_element: bool) -> Option<Value> {
    Some(match value {
        WireValue::Undefined if array_element => Value::Null,
        WireValue::Undefined => return None,
        WireValue::Null => Value::Null,
        WireValue::Bool(value) => json!(value),
        WireValue::String(value) => json!(value),
        WireValue::Number(value) => Value::Number(value.clone()),
        WireValue::SpecialNumber(value) => json!(special_number_text(value, array_element)),
        // Number(BigInt) is explicitly supported by JavaScript; decimal string
        // parsing has the same IEEE-754 rounding for this integer payload.
        WireValue::BigInt(value) => json!(value),
        WireValue::Array(values) => Value::Array(values.iter()
            .map(|value| number_payload_inner(value, true))
            .collect::<Option<Vec<_>>>()?),
        WireValue::Object(entries) => {
            if entries.iter().any(|(key, _)| key == "toString") { return None; }
            // Direct Number({}) is NaN; in an array an ordinary object stringifies
            // to [object Object]. Its other properties are not consulted.
            json!({})
        }
    })
}

fn optional_number_field(value: Option<&WireValue>) -> Option<Option<Value>> {
    match value {
        None | Some(WireValue::Undefined) => Some(None),
        Some(value) => number_payload(value).map(Some),
    }
}

fn background_field(value: Option<&WireValue>) -> Option<Value> {
    match value? {
        WireValue::Undefined => None,
        WireValue::Null => Some(Value::Null),
        WireValue::Object(entries) => {
            let mut result = Map::new();
            if let Some(enabled) = field(entries, "enabled") {
                result.insert("enabled".into(), json!(matches!(enabled, WireValue::Bool(true))));
            }
            if let Some(color) = field(entries, "color") {
                let color = match color {
                    WireValue::Undefined => None,
                    WireValue::String(color) => Some(json!(color)),
                    WireValue::Null => Some(Value::Null),
                    _ => Some(json!(false)),
                };
                if let Some(color) = color { result.insert("color".into(), color); }
            }
            if let Some(opacity) = optional_number_field(field(entries, "opacity"))? {
                result.insert("opacity".into(), opacity);
            }
            Some(Value::Object(result))
        }
        // Property reads from any other present primitive yield undefined.
        // Keep it present and non-nullish so enabled cannot inherit fallback.
        _ => Some(json!(false)),
    }
}

fn save_object_payload(entries: &[(String, WireValue)]) -> Option<Value> {
    let mut result = Map::new();
    for key in LAYOUT_FIELDS {
        let value = field(entries, key);
        let projected = match key {
            "id" | "name" | "position" | "theme" | "advancedPosition" => string_field(value),
            "scale" => optional_number_field(value)?,
            "stats" | "deviceKeys" => string_array_field(value),
            "background" => background_field(value),
            _ => unreachable!(),
        };
        if let Some(projected) = projected { result.insert(key.into(), projected); }
    }
    Some(Value::Object(result))
}

/// `async (layout) =>`: no argument is the default parameter and normalizes an
/// empty object; a top-level null throws inside the handler's normalizer.
fn save_payload(args: &[WireValue]) -> Option<Value> {
    match args.first() {
        None | Some(WireValue::Undefined) => Some(json!({})),
        Some(WireValue::Null) => None,
        Some(WireValue::Object(entries)) => save_object_payload(entries),
        // Property reads on all non-null primitive values and arrays yield
        // undefined for the normalizer's named fields, just like an empty object.
        Some(_) => Some(json!({})),
    }
}

/// `async ({ id, name } = {})`: only the two names are read, so a non-object
/// payload reduces to the same two absent values the handler destructures, and
/// every other member is dropped. A top-level null is the destructuring
/// TypeError and stays with the handler.
fn rename_payload(args: &[WireValue]) -> Option<Value> {
    match args.first() {
        // A top-level null is the destructuring TypeError and stays with the
        // handler; every other non-object reduces to two absent names.
        Some(WireValue::Null) => None,
        Some(WireValue::Object(entries)) => Some(json!({
            "id": member(entries, "id"), "name": member(entries, "name"),
        })),
        _ => Some(json!({"id":Value::Null,"name":Value::Null})),
    }
}

fn member(entries: &[(String, WireValue)], key: &str) -> Value {
    match entries.iter().find(|(name, _)| name == key).map(|(_, value)| value) {
        Some(WireValue::String(value)) => json!(value),
        _ => Value::Null,
    }
}

/// `async (id) =>`: only a string can name a layout, so every other value is
/// the same "not found" the handler's strict comparison produces.
fn id_payload(args: &[WireValue]) -> Value {
    match args.first() { Some(WireValue::String(id)) => json!(id), _ => Value::Null }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::native_system::BuildKind;
    use crate::backend::services::{invoke, ServiceContext};
    use std::path::{Path, PathBuf};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("arc-layout-channel-{:032x}", rand::random::<u128>()));
            std::fs::create_dir(&path).unwrap(); Self(path)
        }
        fn store(&self) -> NativeStore { NativeStore::new(self.0.clone(), "advanced").unwrap() }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if self.0.parent() == Some(std::env::temp_dir().as_path()) { let _ = std::fs::remove_dir_all(&self.0); }
        }
    }

    fn data() -> Value {
        serde_json::from_str(include_str!("fixtures/overlay-layout-parity.json")).unwrap()
    }

    fn shared<'a>(data: &'a Value, case: &Value, field: &str) -> &'a Value {
        let index = case[field].as_u64().expect("a shared value index") as usize;
        &data["values"][index]
    }

    fn equivalent(actual: &Value, expected: &Value) -> bool {
        match (actual, expected) {
            (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
            (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equivalent(a, b)),
            (Value::Object(a), Value::Object(b)) => a.len() == b.len()
                && a.iter().all(|(key, a)| b.get(key).is_some_and(|b| equivalent(a, b))),
            _ => actual == expected,
        }
    }

    /// The top-level member order of the renderer's tagged reply.
    fn tagged_keys(value: &Value) -> Vec<&str> {
        value["v"].as_array().unwrap().iter().map(|pair| pair[0].as_str().unwrap()).collect()
    }

    fn keys_of(value: &Value) -> Vec<&str> {
        value.as_object().map(|object| object.keys().map(String::as_str).collect()).unwrap_or_default()
    }

    fn read(path: &Path) -> Value {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).expect("a JSON sidecar"),
            Err(_) => Value::Null,
        }
    }

    fn write_optional(path: &Path, text: Option<&Value>) {
        if let Some(text) = text.and_then(Value::as_str) { std::fs::write(path, text).unwrap(); }
    }

    /// Replays one case captured from the unmodified handler: the reply, the
    /// error string, both sidecars, and the native/mock delegation decision.
    fn replay(data: &Value, case: &Value) {
        let name = &case["name"];
        let fixture = Fixture::new();
        let settings_path = fixture.0.join("settings.json");
        let layouts_path = fixture.0.join("overlay-layouts.json");
        write_optional(&settings_path, Some(shared(data, case, "initialSettingsJson")));
        write_optional(&layouts_path, Some(shared(data, case, "initialLayoutsJson")));
        let before = (std::fs::read(&settings_path).ok(), std::fs::read(&layouts_path).ok());
        let store = fixture.store();
        let channel = case["channel"].as_str().unwrap();
        let result = invoke(channel, &case["wire"], ServiceContext { build_kind: BuildKind::Dev, mock_mode: false, store: &store });
        let Some(reply) = result else {
            // The compatibility handler owns the payload: the native arm must
            // have decided before reading or writing anything.
            assert_eq!(case["delegate"], true, "{name}: a delegated payload must stay with the handler");
            assert_eq!((std::fs::read(&settings_path).ok(), std::fs::read(&layouts_path).ok()), before,
                "{name}: a delegated payload writes nothing natively");
            return;
        };
        assert_eq!(case["delegate"], false, "{name}: a native payload must not delegate");
        match reply {
            Ok(encoded) => {
                assert!(case["expectedError"].is_null(), "{name}: expected {:?}", case["expectedError"]);
                let expected = shared(data, case, "expectedReplyWire");
                assert!(equivalent(&encoded, expected), "{name}: reply {encoded}");
                assert_eq!(tagged_keys(&encoded), shared(data, case, "expectedReplyKeys")
                    .as_array().unwrap().iter().map(|key| key.as_str().unwrap()).collect::<Vec<_>>(),
                    "{name}: reply key order");
            }
            Err(error) => {
                assert_eq!(case["expectedError"].as_str(), Some(error.as_str()), "{name}: error");
                assert!(shared(data, case, "expectedReplyWire").is_null(), "{name}: a rejected call replies nothing");
            }
        }
        let layouts = read(&layouts_path);
        assert!(equivalent(&layouts, shared(data, case, "expectedLayouts")), "{name}: layout sidecar {layouts}");
        if layouts.is_object() {
            assert_eq!(keys_of(&layouts), shared(data, case, "expectedLayoutsKeys")
                .as_array().unwrap().iter().map(|key| key.as_str().unwrap()).collect::<Vec<_>>(),
                "{name}: sidecar key order");
        }
        let settings = read(&settings_path);
        assert!(equivalent(&settings, shared(data, case, "expectedSettings")), "{name}: settings sidecar {settings}");
    }

    #[test]
    fn channel_replies_match_the_electron_handlers() {
        let data = data();
        let cases = data["cases"].as_array().unwrap();
        assert!(cases.len() >= 80, "the differential matrix must stay broad: {}", cases.len());
        for case in cases { replay(&data, case); }
        let delegated = cases.iter().filter(|case| case["delegate"] == true).count();
        // The per-field payload adapter answers every shape the JavaScript
        // normalizer reads, so exactly two payload kinds still delegate to the
        // handler: a top-level null layout (the normalizer's own TypeError)
        // and a top-level null rename payload (the destructuring TypeError).
        // Every formerly delegated case is pinned natively by the replay
        // above, so the guard only requires the delegated matrix to exist.
        // The remaining special-value cases are now owned natively; keep the
        // count assertion so the fixture still records how many were covered.
        assert_eq!(delegated, 2, "the delegated matrix must keep its two JavaScript payloads");
    }

    #[test]
    fn the_channel_list_and_apply_set_match_the_fixture() {
        let data = data();
        assert_eq!(json!(CHANNELS), data["channels"]);
        let applying: Vec<&str> = CHANNELS.into_iter().filter(|channel| applies_layout(channel)).collect();
        assert_eq!(json!(applying), data["appliesLayout"]);
        for channel in CHANNELS { assert!(handles(channel)); }
        assert!(!handles("overlay-layouts-rename"));
    }

    /// The host publishes `load_settings_sync()` on `settings-cache`; it must be
    /// the transaction's own committed snapshot, so the push cannot be stale.
    #[test]
    fn a_landed_mutation_publishes_the_settings_it_applied() {
        let data = data();
        for case in data["cases"].as_array().unwrap() {
            if case["delegate"] == true || !case["expectedError"].is_null() { continue; }
            if !applies_layout(case["channel"].as_str().unwrap()) { continue; }
            let name = &case["name"];
            // The handler applied exactly this layout; the native cache must
            // describe the same one.
            let Some(applied) = case["reactions"].as_array().unwrap().iter()
                .find(|reaction| reaction["kind"] == "apply").map(|reaction| shared(&data, reaction, "value")) else { continue; };
            let fixture = Fixture::new();
            write_optional(&fixture.0.join("settings.json"), Some(shared(&data, case, "initialSettingsJson")));
            write_optional(&fixture.0.join("overlay-layouts.json"), Some(shared(&data, case, "initialLayoutsJson")));
            let store = fixture.store();
            invoke(case["channel"].as_str().unwrap(), &case["wire"],
                ServiceContext { build_kind: BuildKind::Dev, mock_mode: false, store: &store }).unwrap().unwrap();
            let cache = store.settings_store().load_settings_sync().unwrap()
                .unwrap_or_else(|| panic!("{name}: a landed mutation must publish the settings cache"));
            let expected = shared(&data, case, "expectedSettings");
            for key in ["overlayPosition", "overlayScale", "overlayTheme", "overlayStats",
                "overlayDeviceKeys", "overlayBgEnabled", "overlayBgColor", "overlayBgOpacity",
                "advancedOverlayPosition"] {
                assert!(equivalent(&cache[key], &expected[key]), "{name}: published {key}");
            }
            assert_eq!(cache["overlayPosition"], applied["position"], "{name}: applied layout");
            assert!(equivalent(&cache["overlayScale"], &applied["scale"]), "{name}: applied scale");
            assert_eq!(cache["advancedOverlayPosition"], applied["advancedPosition"], "{name}: advanced position");
            assert!(equivalent(&cache["overlayBgOpacity"], &applied["background"]["opacity"]), "{name}: applied opacity");
        }
    }

    /// A rename and a snapshot read never publish new settings, so the host has
    /// nothing to re-apply.
    #[test]
    fn rename_and_the_snapshot_read_do_not_reapply_a_layout() {
        let data = data();
        for case in data["cases"].as_array().unwrap() {
            if case["delegate"] == true || !case["expectedError"].is_null() { continue; }
            if applies_layout(case["channel"].as_str().unwrap()) { continue; }
            let fixture = Fixture::new();
            write_optional(&fixture.0.join("settings.json"), Some(shared(&data, case, "initialSettingsJson")));
            write_optional(&fixture.0.join("overlay-layouts.json"), Some(shared(&data, case, "initialLayoutsJson")));
            let store = fixture.store();
            invoke(case["channel"].as_str().unwrap(), &case["wire"],
                ServiceContext { build_kind: BuildKind::Dev, mock_mode: false, store: &store }).unwrap().unwrap();
            assert_eq!(read(&fixture.0.join("settings.json")), *shared(&data, case, "expectedSettings"),
                "{}: no settings write", case["name"]);
        }
    }
}
