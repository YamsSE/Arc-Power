//! Project color capabilities and Arc Power's stored intent into the Display
//! payload. Stored values are never represented as driver current values.
use super::{display_color_capabilities::ColorCapabilityClassification, display_color_state::ColorState};
use serde_json::{json, Value};

const MANAGED_REASON: &str = "Values shown are Arc Power settings, starting from defaults. Applying replaces the corresponding IGS color adjustments; changes made in IGS are not read here.";
const NO_SETTER: &str = "Display color adjustment is not available in this driver runtime.";
const NO_BLOCK: &str = "The required display color block is unavailable or ambiguous.";

pub(crate) fn project_color(
    display: &mut Value,
    caps: Result<ColorCapabilityClassification, String>,
    saved: Result<ColorState, String>,
    setter_available: bool,
) {
    let ranges = [("hue", -180.0, 180.0, 1.0, 0.0),
        ("saturation", 0.0, 2.0, 0.02, 1.0),
        ("brightness", -100.0, 100.0, 2.0, 0.0),
        ("contrast", 0.0, 2.0, 0.02, 1.0)];
    for (name, min, max, step, default) in ranges {
        let hue_group = name == "hue" || name == "saturation";
        let (supported, unsupported_reason) = match &caps {
            Ok(caps) if hue_group => (caps.hue_saturation_supported, caps.hue_saturation_unsupported_reason),
            Ok(caps) => (caps.brightness_contrast_supported, caps.brightness_contrast_unsupported_reason),
            Err(error) => (false, Some(error.as_str())),
        };
        let reason = if !supported { unsupported_reason.filter(|reason| !reason.is_empty()).unwrap_or(NO_BLOCK) }
            else if !setter_available { NO_SETTER }
            else if let Err(error) = &saved { error.as_str() }
            else { MANAGED_REASON };
        let mut value = json!({"value": null, "supported": supported,
            "controllable": supported && setter_available && saved.is_ok(),
            "reason": reason, "source": "igcl-managed-color"});
        if let Ok(state) = &saved {
            let (desired, sent) = match name {
                "hue" => (state.hue, state.hue_saturation_sent),
                "saturation" => (state.saturation, state.hue_saturation_sent),
                "brightness" => (state.brightness, state.brightness_contrast_sent),
                _ => (state.contrast, state.brightness_contrast_sent),
            };
            value["desiredValue"] = json!(desired);
            value["lastSent"] = json!(sent);
        }
        display[name] = value;
        display["supportedOptions"]["colorRanges"][name] = json!({"min": min, "max": max, "step": step, "default": default});
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::display_color_capabilities::{classify_color_capability_blocks, ColorTransformBlockMetadata};

    fn caps() -> ColorCapabilityClassification {
        classify_color_capability_blocks(&[
            ColorTransformBlockMetadata { id: 1, block_type: 3, sampling_type: None, num_samples_per_channel: None, num_channels: None },
            ColorTransformBlockMetadata { id: 2, block_type: 1, sampling_type: Some(0), num_samples_per_channel: Some(256), num_channels: Some(3) },
        ])
    }
    fn display() -> Value { json!({"supportedOptions": {"colorRanges": {}}}) }

    #[test]
    fn publishes_intent_without_claiming_driver_readback() {
        let mut display = display();
        let state = ColorState { hue: 12.0, hue_saturation_sent: true, ..ColorState::default() };
        project_color(&mut display, Ok(caps()), Ok(state), true);
        assert_eq!(display["hue"]["value"], Value::Null);
        assert_eq!(display["hue"]["desiredValue"], json!(12.0));
        assert_eq!(display["hue"]["lastSent"], true);
        assert_eq!(display["brightness"]["lastSent"], false);
        assert_eq!(display["brightness"]["controllable"], true);
        assert_eq!(display["supportedOptions"]["colorRanges"]["contrast"]["step"], json!(0.02));
    }

    #[test]
    fn errors_and_missing_setter_fail_closed_without_fabricating_saved_values() {
        let mut display = display();
        project_color(&mut display, Ok(caps()), Err("bad saved state".into()), true);
        assert_eq!(display["hue"]["controllable"], false);
        assert_eq!(display["hue"]["reason"], "bad saved state");
        assert!(display["hue"].get("desiredValue").is_none());
        project_color(&mut display, Ok(caps()), Ok(ColorState::default()), false);
        assert_eq!(display["hue"]["reason"], NO_SETTER);
        project_color(&mut display, Err("query failed".into()), Ok(ColorState::default()), true);
        assert_eq!(display["hue"]["supported"], false);
        assert_eq!(display["hue"]["reason"], "query failed");
    }
}
