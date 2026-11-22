//! Pure classifier for IGCL pixel-transformation CAPABILITY blocks.
//!
//! This mirrors `queryDisplayColorCapabilities` in
//! `src/main/backend/igcl-display-color.js`. It deliberately accepts already
//! decoded metadata and performs no driver calls or buffer reads. The IGCL
//! layer remains responsible for validating the native buffer layout and
//! block count before passing metadata here.
//!
//! The staged native Display read uses this classifier; the public Display
//! channel remains brokered until the complete payload has parity.

const BLOCK_LUT_1D: u32 = 1;
const BLOCK_MATRIX_3X3: u32 = 3;
const UNIFORM_SAMPLING: u32 = 0;
const MIN_LUT_SAMPLES: u32 = 2;
const MAX_LUT_SAMPLES: u32 = 8192;

const HUE_SATURATION_AMBIGUOUS: &str =
    "Multiple hue/saturation transform blocks are ambiguous.";
const HUE_SATURATION_MISSING: &str = "This output does not expose a hue/saturation matrix.";
const RGB_LUT_AMBIGUOUS: &str = "Multiple RGB color LUT blocks are ambiguous.";
const RGB_LUT_MISSING: &str = "This output does not expose an RGB color LUT.";
const RGB_LUT_NON_UNIFORM: &str =
    "Non-uniform LUT sampling is unsupported without verified sample positions.";
const RGB_LUT_INVALID_COUNT: &str =
    "RGB LUT sample count must be from 2 through 8192.";

/// The metadata the JavaScript capability query extracts from one block.
///
/// LUT-only fields are optional because matrix blocks do not carry them. A
/// missing LUT field fails closed using the same reason precedence as the
/// JavaScript implementation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ColorTransformBlockMetadata {
    pub(crate) id: u32,
    pub(crate) block_type: u32,
    pub(crate) sampling_type: Option<u32>,
    pub(crate) num_samples_per_channel: Option<u32>,
    pub(crate) num_channels: Option<u32>,
}

/// The selected block IDs let a caller retrieve the corresponding owned
/// native blocks without copying or interpreting their payload here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ColorCapabilityClassification {
    pub(crate) hue_saturation_block_id: Option<u32>,
    pub(crate) brightness_contrast_block_id: Option<u32>,
    pub(crate) hue_saturation_supported: bool,
    pub(crate) brightness_contrast_supported: bool,
    pub(crate) hue_saturation_unsupported_reason: Option<&'static str>,
    pub(crate) brightness_contrast_unsupported_reason: Option<&'static str>,
}

/// Select the unique matrix and uniform RGB LUT supported by Arc Power.
///
/// Matrix candidates are counted by type alone. LUT candidates must be type 1
/// with exactly three channels. If more than one candidate exists, the group
/// is ambiguous even if only one candidate would otherwise pass its metadata
/// checks, matching the Electron oracle.
pub(crate) fn classify_color_capability_blocks(
    blocks: &[ColorTransformBlockMetadata],
) -> ColorCapabilityClassification {
    let matrix_candidates: Vec<usize> = blocks
        .iter()
        .enumerate()
        .filter_map(|(index, block)| (block.block_type == BLOCK_MATRIX_3X3).then_some(index))
        .collect();
    let hue_saturation_block_id = match matrix_candidates.as_slice() {
        [index] => Some(blocks[*index].id),
        _ => None,
    };
    let hue_saturation_unsupported_reason = match matrix_candidates.len() {
        0 => Some(HUE_SATURATION_MISSING),
        1 => None,
        _ => Some(HUE_SATURATION_AMBIGUOUS),
    };

    let lut_candidates: Vec<usize> = blocks
        .iter()
        .enumerate()
        .filter_map(|(index, block)| {
            (block.block_type == BLOCK_LUT_1D && block.num_channels == Some(3))
                .then_some(index)
        })
        .collect();
    let (brightness_contrast_block_id, brightness_contrast_unsupported_reason) =
        match lut_candidates.as_slice() {
            [] => (None, Some(RGB_LUT_MISSING)),
            [index] => {
                let block = &blocks[*index];
                if block.sampling_type != Some(UNIFORM_SAMPLING) {
                    (None, Some(RGB_LUT_NON_UNIFORM))
                } else if !block
                    .num_samples_per_channel
                    .is_some_and(|count| (MIN_LUT_SAMPLES..=MAX_LUT_SAMPLES).contains(&count))
                {
                    (None, Some(RGB_LUT_INVALID_COUNT))
                } else {
                    (Some(block.id), None)
                }
            }
            _ => (None, Some(RGB_LUT_AMBIGUOUS)),
        };

    ColorCapabilityClassification {
        hue_saturation_block_id,
        brightness_contrast_block_id,
        hue_saturation_supported: hue_saturation_block_id.is_some(),
        brightness_contrast_supported: brightness_contrast_block_id.is_some(),
        hue_saturation_unsupported_reason,
        brightness_contrast_unsupported_reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matrix(id: u32) -> ColorTransformBlockMetadata {
        ColorTransformBlockMetadata {
            id,
            block_type: BLOCK_MATRIX_3X3,
            sampling_type: None,
            num_samples_per_channel: None,
            num_channels: None,
        }
    }

    fn lut(
        id: u32,
        channels: u32,
        sampling_type: u32,
        samples: u32,
    ) -> ColorTransformBlockMetadata {
        ColorTransformBlockMetadata {
            id,
            block_type: BLOCK_LUT_1D,
            sampling_type: Some(sampling_type),
            num_samples_per_channel: Some(samples),
            num_channels: Some(channels),
        }
    }

    #[test]
    fn capability_fixtures_select_only_unique_supported_blocks() {
        let fixtures = [
            (
                "unique matrix and RGB LUT",
                vec![matrix(41), lut(9, 3, UNIFORM_SAMPLING, 256)],
                Some(41),
                Some(9),
                None,
                None,
            ),
            (
                "matrix ambiguity",
                vec![matrix(41), matrix(42), lut(9, 3, UNIFORM_SAMPLING, 256)],
                None,
                Some(9),
                Some(HUE_SATURATION_AMBIGUOUS),
                None,
            ),
            (
                "RGB LUT ambiguity",
                vec![
                    matrix(41),
                    lut(9, 3, UNIFORM_SAMPLING, 256),
                    lut(10, 3, UNIFORM_SAMPLING, 512),
                ],
                Some(41),
                None,
                None,
                Some(RGB_LUT_AMBIGUOUS),
            ),
            (
                "non-RGB LUT does not create ambiguity",
                vec![lut(8, 4, UNIFORM_SAMPLING, 256), lut(9, 3, UNIFORM_SAMPLING, 256)],
                None,
                Some(9),
                Some(HUE_SATURATION_MISSING),
                None,
            ),
            (
                "unrelated block types are ignored",
                vec![ColorTransformBlockMetadata {
                    id: 99,
                    block_type: 7,
                    sampling_type: None,
                    num_samples_per_channel: None,
                    num_channels: None,
                }],
                None,
                None,
                Some(HUE_SATURATION_MISSING),
                Some(RGB_LUT_MISSING),
            ),
        ];

        for (name, blocks, matrix_id, lut_id, matrix_reason, lut_reason) in fixtures {
            let result = classify_color_capability_blocks(&blocks);
            assert_eq!(result.hue_saturation_block_id, matrix_id, "fixture: {name}");
            assert_eq!(result.brightness_contrast_block_id, lut_id, "fixture: {name}");
            assert_eq!(result.hue_saturation_supported, matrix_id.is_some(), "fixture: {name}");
            assert_eq!(result.brightness_contrast_supported, lut_id.is_some(), "fixture: {name}");
            assert_eq!(result.hue_saturation_unsupported_reason, matrix_reason, "fixture: {name}");
            assert_eq!(result.brightness_contrast_unsupported_reason, lut_reason, "fixture: {name}");
        }
    }

    #[test]
    fn lut_sampling_is_checked_before_sample_count() {
        let non_uniform = classify_color_capability_blocks(&[lut(5, 3, 1, 1)]);
        assert_eq!(non_uniform.brightness_contrast_unsupported_reason, Some(RGB_LUT_NON_UNIFORM));

        let missing_sampling = classify_color_capability_blocks(&[ColorTransformBlockMetadata {
            id: 5,
            block_type: BLOCK_LUT_1D,
            sampling_type: None,
            num_samples_per_channel: Some(256),
            num_channels: Some(3),
        }]);
        assert_eq!(missing_sampling.brightness_contrast_unsupported_reason, Some(RGB_LUT_NON_UNIFORM));
    }

    #[test]
    fn lut_sample_count_accepts_only_inclusive_supported_bounds() {
        for count in [MIN_LUT_SAMPLES, MAX_LUT_SAMPLES] {
            let result = classify_color_capability_blocks(&[lut(5, 3, UNIFORM_SAMPLING, count)]);
            assert!(result.brightness_contrast_supported, "accepted boundary: {count}");
            assert_eq!(result.brightness_contrast_unsupported_reason, None);
        }

        for count in [0, 1, MAX_LUT_SAMPLES + 1] {
            let result = classify_color_capability_blocks(&[lut(5, 3, UNIFORM_SAMPLING, count)]);
            assert!(!result.brightness_contrast_supported, "rejected boundary: {count}");
            assert_eq!(result.brightness_contrast_unsupported_reason, Some(RGB_LUT_INVALID_COUNT));
        }

        let missing_count = classify_color_capability_blocks(&[ColorTransformBlockMetadata {
            id: 5,
            block_type: BLOCK_LUT_1D,
            sampling_type: Some(UNIFORM_SAMPLING),
            num_samples_per_channel: None,
            num_channels: Some(3),
        }]);
        assert_eq!(missing_count.brightness_contrast_unsupported_reason, Some(RGB_LUT_INVALID_COUNT));
    }
}
