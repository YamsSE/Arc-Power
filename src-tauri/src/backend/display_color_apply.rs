//! Staged Display color setter, routed by `display:apply`.
//!
//! The IGCL color path has no reliable effective-value read-back on every
//! driver. This transaction preserves Electron's honest `readback-unavailable`
//! contract: it validates identity and capabilities, merges each requested
//! control with its persisted sibling, calls SET at most once per group, and
//! persists Arc Power intent only after the setter reports success. It never
//! fabricates a read-back or attempts a rollback without an observed baseline.
//!
//! `services.rs` routes only a patch made of `hue`, `saturation`, `brightness`
//! and `contrast` plus the `replaceExistingColorSettings` acknowledgement; a
//! color key mixed with any other control, and every other patch shape, stays
//! broker-owned.

use super::{
    display_apply::{self, DisplayApplyTarget, DisplayOutputIdentity},
    display_color_state::{ColorState, DisplayColorStore},
    gpu_apply_identity::{self, ApplyIdentity},
    gpu_capabilities,
    igcl_read_only::ReadOnlyIgcl,
};
use serde_json::Value;
use std::{path::PathBuf, sync::{Mutex, OnceLock}};

static DISPLAY_COLOR_APPLY_GATE: OnceLock<Mutex<()>> = OnceLock::new();

/// Electron's accepted color SET message (`igcl-backend.js` applyDisplay),
/// verbatim. The renderer shows it in its "Color settings sent" toast.
pub(crate) const DISPLAY_COLOR_SENT_MESSAGE: &str =
    "The driver accepted the color settings. Values shown are saved by Arc Power; current-value read-back is unavailable.";
/// Electron's refusal when a group was never sent by Arc Power and the request
/// did not acknowledge replacing the IGS value, verbatim.
pub(crate) const DISPLAY_COLOR_REPLACE_REQUIRED_MESSAGE: &str =
    "Use Apply Arc Power settings to replace the corresponding IGS adjustments with Arc Power settings.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DisplayColorGroup { HueSaturation, BrightnessContrast }

impl DisplayColorGroup {
    /// The one execution order Electron uses for a multi-group color patch.
    const ORDER: [Self; 2] = [Self::HueSaturation, Self::BrightnessContrast];

    fn key(self) -> &'static str {
        match self { Self::HueSaturation => "hueSaturation", Self::BrightnessContrast => "brightnessContrast" }
    }
    pub(crate) fn fields(self) -> [DisplayColorKey; 2] {
        match self { Self::HueSaturation => [DisplayColorKey::Hue, DisplayColorKey::Saturation], Self::BrightnessContrast => [DisplayColorKey::Brightness, DisplayColorKey::Contrast] }
    }
    fn sent(self, state: &ColorState) -> bool {
        match self { Self::HueSaturation => state.hue_saturation_sent, Self::BrightnessContrast => state.brightness_contrast_sent }
    }
    fn current(self, state: &ColorState) -> (f64, f64) {
        let [first, second] = self.fields();
        (first.persisted(state), second.persisted(state))
    }
    /// Electron's sibling merge: `normalized[key] ?? saved.values[key]`. One
    /// SET therefore always carries the complete pair, even for a single-key
    /// patch, so the driver never receives half of a coupled adjustment.
    fn merged_values(self, requested: &DisplayColorPatch, saved: &ColorState) -> (f64, f64) {
        let [first, second] = self.fields();
        (requested.value(first).unwrap_or_else(|| first.persisted(saved)),
            requested.value(second).unwrap_or_else(|| second.persisted(saved)))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DisplayColorKey { Hue, Saturation, Brightness, Contrast }

impl DisplayColorKey {
    pub(crate) fn from_name(name: &str) -> Option<Self> {
        match name {
            "hue" => Some(Self::Hue),
            "saturation" => Some(Self::Saturation),
            "brightness" => Some(Self::Brightness),
            "contrast" => Some(Self::Contrast),
            _ => None,
        }
    }
    pub(crate) fn name(self) -> &'static str {
        match self { Self::Hue => "hue", Self::Saturation => "saturation", Self::Brightness => "brightness", Self::Contrast => "contrast" }
    }
    fn persisted(self, state: &ColorState) -> f64 {
        match self { Self::Hue => state.hue, Self::Saturation => state.saturation, Self::Brightness => state.brightness, Self::Contrast => state.contrast }
    }
    /// Electron's clamp + step normalization (`DISPLAY_COLOR_RANGES`).
    fn normalize(self, value: f64) -> Option<f64> {
        let (min, max, step) = match self {
            Self::Hue => (-180.0, 180.0, 1.0),
            Self::Saturation => (0.0, 2.0, 0.02),
            Self::Brightness => (-100.0, 100.0, 2.0),
            Self::Contrast => (0.0, 2.0, 0.02),
        };
        if !value.is_finite() { return None; }
        let bounded = value.clamp(min, max);
        Some((min + ((bounded - min) / step).round() * step).round_decimal_8())
    }
}

/// One Display color patch: 1..4 controls plus Electron's
/// `replaceExistingColorSettings` acknowledgement. The acknowledgement is a
/// flag, never a control: it produces no `perControl` entry and does not count
/// toward the patch's control keys.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct DisplayColorPatch {
    pub(crate) hue: Option<f64>,
    pub(crate) saturation: Option<f64>,
    pub(crate) brightness: Option<f64>,
    pub(crate) contrast: Option<f64>,
    pub(crate) replace_existing: bool,
}

impl DisplayColorPatch {
    pub(crate) fn set(&mut self, key: DisplayColorKey, value: f64) {
        match key {
            DisplayColorKey::Hue => self.hue = Some(value),
            DisplayColorKey::Saturation => self.saturation = Some(value),
            DisplayColorKey::Brightness => self.brightness = Some(value),
            DisplayColorKey::Contrast => self.contrast = Some(value),
        }
    }
    pub(crate) fn value(&self, key: DisplayColorKey) -> Option<f64> {
        match key {
            DisplayColorKey::Hue => self.hue,
            DisplayColorKey::Saturation => self.saturation,
            DisplayColorKey::Brightness => self.brightness,
            DisplayColorKey::Contrast => self.contrast,
        }
    }
    pub(crate) fn is_empty(&self) -> bool { self.requested_keys().next().is_none() }
    /// Requested controls in the canonical hue/saturation/brightness/contrast
    /// order.
    pub(crate) fn requested_keys(&self) -> impl Iterator<Item = DisplayColorKey> + '_ {
        [DisplayColorKey::Hue, DisplayColorKey::Saturation, DisplayColorKey::Brightness, DisplayColorKey::Contrast]
            .into_iter().filter(|key| self.value(*key).is_some())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DisplayColorApplyResult {
    pub(crate) ok: bool,
    pub(crate) error_code: Option<&'static str>,
    pub(crate) message: Option<String>,
    pub(crate) requested: Option<(f64, f64)>,
    pub(crate) readback_unavailable: bool,
    pub(crate) intent_saved: bool,
    pub(crate) state_may_have_changed: bool,
}

impl DisplayColorApplyResult {
    pub(crate) fn failed(code: &'static str, message: impl Into<String>) -> Self {
        Self { ok: false, error_code: Some(code), message: Some(message.into()), requested: None,
            readback_unavailable: true, intent_saved: false, state_may_have_changed: false }
    }
}

/// One color transaction's results, one entry per requested group in Electron's
/// execution order. A pre-write refusal or failure is recorded for every
/// requested group, so no requested control is ever silently dropped.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DisplayColorApplyOutcome {
    pub(crate) groups: Vec<(DisplayColorGroup, DisplayColorApplyResult)>,
}

impl DisplayColorApplyOutcome {
    pub(crate) fn ok(&self) -> bool {
        !self.groups.is_empty() && self.groups.iter().all(|(_, result)| result.ok)
    }
}

pub(crate) trait DisplayColorIntentStore {
    fn read_intent(&mut self, display_key: &str) -> Result<ColorState, String>;
    fn save_group(&mut self, display_key: &str, group: DisplayColorGroup, values: (f64, f64)) -> Result<ColorState, String>;
}

impl DisplayColorIntentStore for DisplayColorStore {
    fn read_intent(&mut self, display_key: &str) -> Result<ColorState, String> { self.read(display_key) }
    fn save_group(&mut self, display_key: &str, group: DisplayColorGroup, values: (f64, f64)) -> Result<ColorState, String> {
        DisplayColorStore::save_group(self, display_key, group.key(), values.0, values.1)
    }
}

pub(crate) trait DisplayColorApplyBackend {
    fn assert_device_target(&mut self, device_id: u64, expected_device_key: &str, physical_target: &Value) -> Result<(), String>;
    fn active_outputs(&mut self, expected_device_key: &str) -> Result<Vec<DisplayOutputIdentity>, String>;
    fn set_color_group(
        &mut self,
        device_id: u64,
        expected_device_key: &str,
        physical_target: &Value,
        display_key: &str,
        group: DisplayColorGroup,
        values: (f64, f64),
    ) -> Result<(), String>;
}

/// Apply a Display color patch while holding the cross-process Display lock.
/// Each requested group gets at most one SET, in `hueSaturation` then
/// `brightnessContrast` order, carrying its unrequested sibling from the
/// persisted intent. No driver value is reported as read back; `sent` remains
/// Arc Power persistence provenance, matching the Electron backend.
pub(crate) fn apply_color_patch(
    _display_guard: &super::display_lock::DisplayLockGuard,
    backend: &mut dyn DisplayColorApplyBackend,
    store: &mut dyn DisplayColorIntentStore,
    target: &DisplayApplyTarget<'_>,
    intent_key: &str,
    patch: &DisplayColorPatch,
) -> DisplayColorApplyOutcome {
    let _gate = DISPLAY_COLOR_APPLY_GATE.get_or_init(|| Mutex::new(()))
        .lock().unwrap_or_else(std::sync::PoisonError::into_inner);

    let groups: Vec<DisplayColorGroup> = DisplayColorGroup::ORDER.into_iter()
        .filter(|group| group.fields().iter().any(|key| patch.value(*key).is_some()))
        .collect();
    let fail_all = |code: &'static str, message: String| DisplayColorApplyOutcome {
        groups: groups.iter().map(|group| {
            (*group, DisplayColorApplyResult::failed(code, message.clone()))
        }).collect(),
    };

    if target.device_key.trim().is_empty() || target.display_key.trim().is_empty()
        || intent_key.trim().is_empty() || !target.physical_target.is_object()
        || !display_apply::display_key_belongs_to_device(target.device_key, target.display_key)
    {
        return fail_all("stale-target", "the display color request requires matching stable adapter and output identities".into());
    }
    // Normalize every requested value exactly like Electron before any driver
    // IO: a non-finite value refuses the whole patch.
    let mut normalized = DisplayColorPatch { replace_existing: patch.replace_existing, ..DisplayColorPatch::default() };
    for key in patch.requested_keys() {
        let Some(value) = patch.value(key).and_then(|value| key.normalize(value)) else {
            return fail_all("out-of-range", "Display color values must be finite numbers.".into());
        };
        normalized.set(key, value);
    }
    if let Err((code, message)) = ensure_target(backend, target) {
        return fail_all(code, message);
    }

    let saved = match store.read_intent(intent_key) {
        Ok(state) => state,
        Err(error) => return fail_all("io-failed", format!("Display color intent could not be read: {error}")),
    };

    let mut outcome = DisplayColorApplyOutcome { groups: Vec::with_capacity(groups.len()) };
    // A lost target proof stops further writes; the remaining requested groups
    // inherit the same honest failure instead of writing to an unproven output.
    let mut blocked: Option<(&'static str, String)> = None;
    for group in groups {
        if let Some((code, message)) = &blocked {
            outcome.groups.push((group, DisplayColorApplyResult::failed(*code, message.clone())));
            continue;
        }
        if !group.sent(&saved) && !patch.replace_existing {
            outcome.groups.push((group, DisplayColorApplyResult::failed(
                "unsupported", DISPLAY_COLOR_REPLACE_REQUIRED_MESSAGE,
            )));
            continue;
        }
        let values = group.merged_values(&normalized, &saved);

        // The production backend reopens by PCI/BDF identity, re-resolves the
        // active output, and queries a unique supported capability block
        // directly before issuing this one write.
        if let Err(error) = backend.set_color_group(
            target.device_id, target.device_key, target.physical_target, target.display_key, group, values,
        ) {
            let mut result = DisplayColorApplyResult::failed("io-failed", format!("Display color setter failed: {error}"));
            // IGCL has no reliable current-value GET for these blocks on all
            // drivers, so a setter error cannot prove that no partial change occurred.
            result.state_may_have_changed = true;
            outcome.groups.push((group, result));
            continue;
        }

        // The OS or another driver client may change topology during the SET.
        // Refuse to claim the stored intent belongs to the requested target if
        // the adapter/output identity no longer resolves.
        if let Err((code, message)) = ensure_target(backend, target) {
            let mut result = DisplayColorApplyResult::failed(code, message.clone());
            result.requested = Some(values);
            result.state_may_have_changed = true;
            blocked = Some((code, message));
            outcome.groups.push((group, result));
            continue;
        }
        outcome.groups.push((group, commit_group(store, intent_key, group, values)));
    }
    outcome
}

/// Persist one accepted group and report Electron's `readback-unavailable`
/// success only after the stored intent round-trips.
fn commit_group(
    store: &mut dyn DisplayColorIntentStore,
    intent_key: &str,
    group: DisplayColorGroup,
    values: (f64, f64),
) -> DisplayColorApplyResult {
    let accepted = || DisplayColorApplyResult {
        ok: true, error_code: None, message: Some(DISPLAY_COLOR_SENT_MESSAGE.to_owned()),
        requested: Some(values), readback_unavailable: true, intent_saved: true, state_may_have_changed: false,
    };
    match store.save_group(intent_key, group, values) {
        Ok(_) => match store.read_intent(intent_key) {
            Ok(after) if group.current(&after) == values && group.sent(&after) => accepted(),
            Ok(_) => {
                let mut result = DisplayColorApplyResult::failed("io-failed", "The driver accepted the settings, but Arc Power could not verify the saved color intent.");
                result.requested = Some(values);
                result.state_may_have_changed = true;
                result
            }
            Err(error) => {
                let mut result = DisplayColorApplyResult::failed("io-failed", format!("The driver accepted the settings, but Arc Power could not verify the saved color intent: {error}"));
                result.requested = Some(values);
                result.state_may_have_changed = true;
                result
            }
        },
        Err(error) => {
            // A failed atomic write can be ambiguous if replacement completed
            // before a later OS error. Re-read and accept only an exact durable
            // intent; no hardware rollback is attempted without a baseline.
            if store.read_intent(intent_key).is_ok_and(|after| group.current(&after) == values && group.sent(&after)) {
                return accepted();
            }
            let mut result = DisplayColorApplyResult::failed(
                "io-failed", format!("The driver accepted the settings, but Arc Power could not save them: {error}"),
            );
            result.requested = Some(values);
            result.state_may_have_changed = true;
            result
        }
    }
}

trait RoundDecimal8 { fn round_decimal_8(self) -> f64; }
impl RoundDecimal8 for f64 { fn round_decimal_8(self) -> f64 { (self * 100_000_000.0).round() / 100_000_000.0 } }

fn ensure_target(
    backend: &mut dyn DisplayColorApplyBackend,
    target: &DisplayApplyTarget<'_>,
) -> Result<(), (&'static str, String)> {
    backend.assert_device_target(target.device_id, target.device_key, target.physical_target)
        .map_err(|error| ("stale-target", format!("the selected graphics adapter changed; refresh Display and try again: {error}")))?;
    let outputs = backend.active_outputs(target.device_key)
        .map_err(|error| ("io-failed", format!("display output enumeration failed: {error}")))?;
    let matches: Vec<_> = outputs.iter().filter(|output| output.display_key == target.display_key).collect();
    match matches.as_slice() {
        [] => Err(("stale-target", "the selected display is no longer connected; refresh Display and try again".into())),
        [output] if output.active && output.identity_verified => Ok(()),
        [_] => Err(("stale-target", "the selected display identity is not verified as active; refresh Display and try again".into())),
        _ => Err(("ambiguous-target", "the selected display is no longer uniquely connected; refresh Display and try again".into())),
    }
}

struct NativeDisplayColorBackend {
    dll_path: PathBuf,
    identity: ApplyIdentity,
    selected_device_key: String,
    physical_target: Value,
    device_id: u64,
}

impl NativeDisplayColorBackend {
    fn with_session<T>(
        &self,
        device_id: u64,
        expected_device_key: &str,
        physical_target: &Value,
        operation: impl FnOnce(&mut ReadOnlyIgcl, usize) -> Result<T, String>,
    ) -> Result<T, String> {
        if device_id != self.device_id || expected_device_key != self.selected_device_key || physical_target != &self.physical_target {
            return Err("the selected adapter identity changed".into());
        }
        if expected_device_key.starts_with("pnp:") {
            let inventory = super::display_wire_format_apply::native_inventory_with_pnp(&self.dll_path)?;
            let row = super::display_wire_format_apply::normalize_wire_target_from_inventory(
                expected_device_key, physical_target, device_id, &inventory,
            )?;
            gpu_apply_identity::ensure_same_target(&self.identity, &gpu_apply_identity::identity_from_row(&row)?)?;
        } else {
            let row = display_apply::normalize_physical_target(expected_device_key, physical_target)?;
            gpu_apply_identity::ensure_same_target(&self.identity, &gpu_apply_identity::identity_from_row(&row)?)?;
        }
        let (mut session, index, device) = gpu_capabilities::open_for_identity(&self.dll_path, &self.identity)?;
        let result = (|| {
            gpu_apply_identity::ensure_same_target(&self.identity, &gpu_apply_identity::identity_from_row(&device)?)?;
            operation(&mut session, index)
        })();
        let close = session.close().map_err(|error| error.to_string());
        match (result, close) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), Ok(())) => Err(error),
            (Ok(_), Err(close)) => Err(format!("IGCL session cleanup failed: {close}")),
            (Err(error), Err(close)) => Err(format!("{error}; IGCL session cleanup failed: {close}")),
        }
    }
}

impl DisplayColorApplyBackend for NativeDisplayColorBackend {
    fn assert_device_target(&mut self, device_id: u64, expected_device_key: &str, physical_target: &Value) -> Result<(), String> {
        self.with_session(device_id, expected_device_key, physical_target, |_, _| Ok(()))
    }

    fn active_outputs(&mut self, expected_device_key: &str) -> Result<Vec<DisplayOutputIdentity>, String> {
        self.with_session(self.device_id, expected_device_key, &self.physical_target, |session, index| {
            display_apply::fresh_display_outputs(session, index, expected_device_key)
                .map(|outputs| outputs.into_iter().map(|(_, identity)| identity).collect())
        })
    }

    fn set_color_group(
        &mut self,
        device_id: u64,
        expected_device_key: &str,
        physical_target: &Value,
        display_key: &str,
        group: DisplayColorGroup,
        values: (f64, f64),
    ) -> Result<(), String> {
        self.with_session(device_id, expected_device_key, physical_target, |session, index| {
            let handle = display_apply::resolve_display_handle(session, index, expected_device_key, display_key)?;
            session.display_apply_api().set_pixel_color_group(
                handle,
                matches!(group, DisplayColorGroup::HueSaturation),
                values.0,
                values.1,
            )
                .map_err(|error| error.to_string())
        })
    }
}

/// Native entry point for a routed `display:apply` color patch. It accepts
/// direct PCI aliases and inventory-unique PNP aliases, preserving the supplied
/// physical PCI/BDF proof throughout identity revalidation.
pub(crate) fn apply_display_color_patch_native(
    display_guard: &super::display_lock::DisplayLockGuard,
    target: &DisplayApplyTarget<'_>,
    patch: &DisplayColorPatch,
) -> DisplayColorApplyOutcome {
    let refuse = |code: &'static str, message: String| DisplayColorApplyOutcome {
        groups: DisplayColorGroup::ORDER.into_iter()
            .filter(|group| group.fields().iter().any(|key| patch.value(*key).is_some()))
            .map(|group| (group, DisplayColorApplyResult::failed(code, message.clone())))
            .collect(),
    };
    if target.device_key.trim().is_empty() || target.display_key.trim().is_empty()
        || !display_apply::display_key_belongs_to_device(target.device_key, target.display_key)
    {
        return refuse("stale-target", "the display color request requires matching stable adapter and output identities".into());
    }
    let Some(dll_path) = super::display_igcl_dll::locate_dll() else {
        return refuse("io-failed", "The trusted Intel display runtime is unavailable.".into());
    };
    let normalized = if target.device_key.starts_with("pnp:") {
        let inventory = match super::display_wire_format_apply::native_inventory_with_pnp(&dll_path) {
            Ok(inventory) => inventory,
            Err(error) => return refuse("stale-target", format!("the complete current graphics adapter inventory is unavailable: {error}")),
        };
        super::display_wire_format_apply::normalize_wire_target_from_inventory(
            target.device_key, target.physical_target, target.device_id, &inventory,
        )
    } else {
        display_apply::normalize_physical_target(target.device_key, target.physical_target)
    };
    let normalized = match normalized {
        Ok(row) => row,
        Err(error) => return refuse("stale-target", format!("the selected graphics adapter identity is invalid: {error}")),
    };
    let identity = match gpu_apply_identity::identity_from_row(&normalized) {
        Ok(identity) => identity,
        Err(error) => return refuse("stale-target", format!("the selected graphics adapter identity is invalid: {error}")),
    };
    let Some(intent_key) = super::display::display_key_in_namespace(&target.display_key, Some(&identity.device_key)) else {
        return refuse("stale-target", "the stable display key could not be resolved for color settings".into());
    };
    let mut backend = NativeDisplayColorBackend {
        dll_path, identity, selected_device_key: target.device_key.to_owned(),
        physical_target: target.physical_target.clone(), device_id: target.device_id,
    };
    let mut store = DisplayColorStore::application_default();
    apply_color_patch(display_guard, &mut backend, &mut store, target, &intent_key, patch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::OnceLock;

    const DEVICE_KEY: &str = "pci:gpu-a";
    const DISPLAY_KEY: &str = "pci:gpu-a|display|encoder-a|edid|abcd1234";

    struct FakeBackend {
        outputs: Vec<DisplayOutputIdentity>,
        output_checks: usize,
        deactivate_on_check: Option<usize>,
        writes: Vec<(DisplayColorGroup, (f64, f64))>,
        fail_set: bool,
    }

    impl FakeBackend {
        fn new() -> Self {
            Self {
                outputs: vec![DisplayOutputIdentity { display_key: DISPLAY_KEY.into(), active: true, identity_verified: true }],
                output_checks: 0, deactivate_on_check: None, writes: Vec::new(), fail_set: false,
            }
        }
    }

    impl DisplayColorApplyBackend for FakeBackend {
        fn assert_device_target(&mut self, device_id: u64, expected_device_key: &str, physical_target: &Value) -> Result<(), String> {
            if device_id != 0 || expected_device_key != DEVICE_KEY || physical_target != &json!({"bdf":"0000:03:00.0"}) {
                return Err("physical adapter proof changed".into());
            }
            Ok(())
        }

        fn active_outputs(&mut self, _expected_device_key: &str) -> Result<Vec<DisplayOutputIdentity>, String> {
            self.output_checks += 1;
            if self.deactivate_on_check == Some(self.output_checks) { self.outputs[0].active = false; }
            Ok(self.outputs.clone())
        }

        fn set_color_group(
            &mut self,
            device_id: u64,
            expected_device_key: &str,
            physical_target: &Value,
            _display_key: &str,
            group: DisplayColorGroup,
            values: (f64, f64),
        ) -> Result<(), String> {
            self.assert_device_target(device_id, expected_device_key, physical_target)?;
            self.writes.push((group, values));
            if self.fail_set { Err("fixture setter failure".into()) } else { Ok(()) }
        }
    }

    struct FakeStore {
        state: ColorState,
        fail_save: bool,
        saves: usize,
    }

    impl FakeStore { fn new() -> Self { Self { state: ColorState::default(), fail_save: false, saves: 0 } } }

    impl DisplayColorIntentStore for FakeStore {
        fn read_intent(&mut self, _display_key: &str) -> Result<ColorState, String> { Ok(self.state.clone()) }
        fn save_group(&mut self, _display_key: &str, group: DisplayColorGroup, values: (f64, f64)) -> Result<ColorState, String> {
            self.saves += 1;
            if self.fail_save { return Err("fixture store failure".into()); }
            match group {
                DisplayColorGroup::HueSaturation => {
                    self.state.hue = values.0;
                    self.state.saturation = values.1;
                    self.state.hue_saturation_sent = true;
                }
                DisplayColorGroup::BrightnessContrast => {
                    self.state.brightness = values.0;
                    self.state.contrast = values.1;
                    self.state.brightness_contrast_sent = true;
                }
            }
            Ok(self.state.clone())
        }
    }

    fn target() -> DisplayApplyTarget<'static> {
        static PROOF: OnceLock<Value> = OnceLock::new();
        DisplayApplyTarget {
            device_id: 0, device_key: DEVICE_KEY,
            physical_target: PROOF.get_or_init(|| json!({"bdf":"0000:03:00.0"})),
            display_key: DISPLAY_KEY,
        }
    }

    fn patch(keys: &[(DisplayColorKey, f64)], replace_existing: bool) -> DisplayColorPatch {
        let mut patch = DisplayColorPatch { replace_existing, ..DisplayColorPatch::default() };
        for (key, value) in keys { patch.set(*key, *value); }
        patch
    }

    fn apply(backend: &mut FakeBackend, store: &mut FakeStore, requested: &DisplayColorPatch) -> DisplayColorApplyOutcome {
        let guard = super::super::display_lock::acquire().expect("shared Display lock should be available");
        apply_color_patch(&guard, backend, store, &target(), DISPLAY_KEY, requested)
    }

    /// One-group adapter for the original per-group transaction seams.
    fn apply_group(backend: &mut FakeBackend, store: &mut FakeStore, group: DisplayColorGroup,
        values: (f64, f64), replace_existing: bool) -> DisplayColorApplyResult {
        let [first, second] = group.fields();
        apply(backend, store, &patch(&[(first, values.0), (second, values.1)], replace_existing))
            .groups.into_iter()
            .find(|(name, _)| *name == group)
            .map(|(_, result)| result)
            .expect("every requested group is reported exactly once")
    }

    #[test]
    fn setter_success_saves_normalized_intent_without_fabricating_readback() {
        let mut backend = FakeBackend::new();
        let mut store = FakeStore::new();
        let result = apply_group(&mut backend, &mut store, DisplayColorGroup::HueSaturation, (21.3, 1.239), true);
        assert!(result.ok);
        assert!(result.readback_unavailable);
        assert!(result.intent_saved);
        assert!(!result.state_may_have_changed);
        assert_eq!(result.requested, Some((21.0, 1.24)));
        assert_eq!(backend.writes, vec![(DisplayColorGroup::HueSaturation, (21.0, 1.24))]);
        assert_eq!((store.state.hue, store.state.saturation), (21.0, 1.24));
        assert!(store.state.hue_saturation_sent);
    }

    #[test]
    fn unsent_group_requires_explicit_replace_before_set() {
        let mut backend = FakeBackend::new();
        let mut store = FakeStore::new();
        let result = apply_group(&mut backend, &mut store, DisplayColorGroup::BrightnessContrast, (-10.0, 1.0), false);
        assert_eq!(result.error_code, Some("unsupported"));
        assert_eq!(result.message.as_deref(), Some(
            "Use Apply Arc Power settings to replace the corresponding IGS adjustments with Arc Power settings."));
        assert!(backend.writes.is_empty());
        assert_eq!(store.saves, 0);
    }

    #[test]
    fn setter_and_store_failures_report_possible_driver_change_without_fake_rollback() {
        let mut backend = FakeBackend::new();
        backend.fail_set = true;
        let mut store = FakeStore::new();
        let result = apply_group(&mut backend, &mut store, DisplayColorGroup::HueSaturation, (0.0, 1.0), true);
        assert!(!result.ok);
        assert!(result.state_may_have_changed);
        assert_eq!(store.saves, 0);
        assert_eq!(backend.writes.len(), 1);

        let mut backend = FakeBackend::new();
        let mut store = FakeStore::new();
        store.fail_save = true;
        let result = apply_group(&mut backend, &mut store, DisplayColorGroup::HueSaturation, (0.0, 1.0), true);
        assert!(!result.ok);
        assert!(result.state_may_have_changed);
        assert_eq!(store.saves, 1);
        assert_eq!(backend.writes.len(), 1, "there is no unsupported compensating write");
    }

    #[test]
    fn output_change_after_set_does_not_commit_color_intent() {
        let mut backend = FakeBackend::new();
        backend.deactivate_on_check = Some(2);
        let mut store = FakeStore::new();
        let result = apply_group(&mut backend, &mut store, DisplayColorGroup::HueSaturation, (0.0, 1.0), true);
        assert!(!result.ok);
        assert_eq!(result.error_code, Some("stale-target"));
        assert!(result.state_may_have_changed);
        assert_eq!(backend.writes.len(), 1);
        assert_eq!(store.saves, 0);
    }

    #[test]
    fn single_key_patch_sends_the_persisted_sibling_in_one_group_set() {
        let mut backend = FakeBackend::new();
        let mut store = FakeStore::new();
        // Arc Power previously sent this pair; this patch carries only hue.
        store.state.hue = 12.0;
        store.state.saturation = 1.4;
        store.state.hue_saturation_sent = true;
        let outcome = apply(&mut backend, &mut store, &patch(&[(DisplayColorKey::Hue, 21.3)], false));
        assert!(outcome.ok());
        assert_eq!(outcome.groups.len(), 1);
        assert_eq!(backend.writes, vec![(DisplayColorGroup::HueSaturation, (21.0, 1.4))],
            "the paired saturation must come from the persisted intent");
        assert_eq!((store.state.hue, store.state.saturation), (21.0, 1.4));
    }

    #[test]
    fn acknowledged_group_merges_the_persisted_sibling_before_the_set() {
        let mut backend = FakeBackend::new();
        let mut store = FakeStore::new();
        // Never sent by Arc Power, but a prior IGS state is recorded as intent.
        store.state.brightness = -14.0;
        store.state.contrast = 0.82;
        let outcome = apply(&mut backend, &mut store, &patch(&[(DisplayColorKey::Contrast, 0.9)], true));
        assert!(outcome.ok());
        assert_eq!(backend.writes, vec![(DisplayColorGroup::BrightnessContrast, (-14.0, 0.9))]);
        assert_eq!((store.state.brightness, store.state.contrast), (-14.0, 0.9));
    }

    #[test]
    fn accepted_group_message_matches_electron_byte_for_byte() {
        let mut backend = FakeBackend::new();
        let mut store = FakeStore::new();
        let outcome = apply(&mut backend, &mut store, &patch(&[(DisplayColorKey::Contrast, 0.9)], true));
        assert!(outcome.ok());
        assert_eq!(outcome.groups[0].1.message.as_deref(), Some(
            "The driver accepted the color settings. Values shown are saved by Arc Power; current-value read-back is unavailable."));
    }

    #[test]
    fn four_control_patch_sets_each_group_once_in_electron_order() {
        let mut backend = FakeBackend::new();
        let mut store = FakeStore::new();
        let outcome = apply(&mut backend, &mut store, &patch(&[
            (DisplayColorKey::Hue, 10.0), (DisplayColorKey::Saturation, 1.2),
            (DisplayColorKey::Brightness, -20.0), (DisplayColorKey::Contrast, 0.8),
        ], true));
        assert!(outcome.ok());
        assert_eq!(backend.writes, vec![
            (DisplayColorGroup::HueSaturation, (10.0, 1.2)),
            (DisplayColorGroup::BrightnessContrast, (-20.0, 0.8)),
        ], "one SET per group, hue/saturation before brightness/contrast");
        assert_eq!(store.saves, 2);
        assert_eq!(outcome.groups.len(), 2);
        assert!(outcome.groups.iter().all(|(_, result)| result.intent_saved));
    }

    #[test]
    fn lost_target_after_the_first_group_blocks_the_second_write() {
        let mut backend = FakeBackend::new();
        backend.deactivate_on_check = Some(2);
        let mut store = FakeStore::new();
        let outcome = apply(&mut backend, &mut store, &patch(&[
            (DisplayColorKey::Hue, 0.0), (DisplayColorKey::Brightness, 0.0),
        ], true));
        assert!(!outcome.ok());
        assert_eq!(outcome.groups.len(), 2);
        assert!(outcome.groups.iter().all(|(_, result)| result.error_code == Some("stale-target")));
        assert_eq!(backend.writes.len(), 1, "no write may follow a lost target proof");
        assert_eq!(store.saves, 0);
    }
}

