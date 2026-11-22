//! Pure release selection for the native updater (and compatibility fallback).
//! The input is fetched release JSON plus trusted build/version metadata; this
//! module performs no network, filesystem, or renderer-facing work.
use super::arc_sleep_policy::{js_number, js_trim};
use serde_json::{json, Value};
use std::sync::OnceLock;
use url::Url;

const RELEASE_REPO_PREFIX: &str = "/YamsSE/Arc-Power/releases/download/";
const MAX_RELEASE_BYTES: usize = 1024 * 1024;
const MAX_RELEASE_DEPTH: usize = 32;
const MAX_RELEASE_ASSETS: usize = 256;
const MAX_RELEASE_NODES: usize = 50_000;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn unavailable() -> Value { json!({"available": false}) }

fn metadata_limits_exceeded(value: &Value, depth: usize, nodes: &mut usize) -> bool {
    *nodes += 1;
    if depth > MAX_RELEASE_DEPTH || *nodes > MAX_RELEASE_NODES { return true; }
    match value {
        Value::Array(values) => values.iter().any(|item| metadata_limits_exceeded(item, depth + 1, nodes)),
        Value::Object(values) => values.values().any(|item| metadata_limits_exceeded(item, depth + 1, nodes)),
        _ => false,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => {
            let number = value.as_f64().unwrap_or(f64::NAN);
            if number == 0.0 { "0".into() }
            else if number.is_finite() && number.fract() == 0.0 { format!("{number:.0}") }
            else { number.to_string() }
        }
        Value::String(value) => value.clone(),
        Value::Array(values) => values.iter().map(|value| {
            if value.is_null() { String::new() } else { js_string(value) }
        }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn parse_release_tag(value: Option<&Value>) -> Option<String> {
    let tag = value.filter(|value| !value.is_null()).map(js_string).unwrap_or_default();
    let tag = tag.strip_suffix("\r\n")
        .or_else(|| tag.strip_suffix('\n'))
        .or_else(|| tag.strip_suffix('\r'))
        .or_else(|| tag.strip_suffix('\u{2028}'))
        .or_else(|| tag.strip_suffix('\u{2029}'))
        .unwrap_or(&tag);
    static TAG: OnceLock<regex::Regex> = OnceLock::new();
    let captures = TAG.get_or_init(|| regex::Regex::new(r"^v?([0-9]+\.[0-9]+\.[0-9]+)\z").expect("fixed release tag pattern"))
        .captures(tag)?;
    captures.get(1).map(|value| value.as_str().to_owned())
}

fn newer_version(latest: &str, current: &str) -> bool {
    let latest: Vec<f64> = latest.split('.').map(|part| js_number(Some(&Value::String(part.into())))).collect();
    let current: Vec<f64> = current.split('.').map(|part| js_number(Some(&Value::String(part.into())))).collect();
    for index in 0..latest.len().max(current.len()) {
        let left = latest.get(index).copied().unwrap_or(0.0);
        let right = current.get(index).copied().unwrap_or(0.0);
        if left != right { return !((left - right) <= 0.0); }
    }
    false
}

fn array_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Array(values) => values.iter().map(array_string).collect::<Vec<_>>().join(","),
        _ => js_string(value),
    }
}

fn url_input(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Array(_)) => array_string(value.unwrap()),
        Some(value) => js_string(value),
    }
}

fn validate_asset_url(value: Option<&Value>, expected_name: &str) -> Option<String> {
    let parsed = Url::parse(&url_input(value)).ok()?;
    if parsed.scheme() != "https" || !parsed.host_str().is_some_and(|host| host.eq_ignore_ascii_case("github.com"))
        || !parsed.path().starts_with(RELEASE_REPO_PREFIX) { return None; }
    // Node's path.basename ignores trailing separators; URL parsing has
    // already normalized special-scheme backslashes to forward slashes.
    let pathname = parsed.path().trim_end_matches('/');
    let name = pathname.rsplit('/').next().unwrap_or("");
    if !name.to_ascii_lowercase().ends_with(".exe")
        || !name.eq_ignore_ascii_case(expected_name) { return None; }
    Some(parsed.to_string())
}

fn expected_asset_name(build_kind: &str) -> Option<&'static str> {
    match build_kind {
        "installed" => Some("Arc-Power_Installer.exe"),
        "portable" => Some("Arc-Power_Portable.exe"),
        _ => None,
    }
}

fn safe_size(value: Option<&Value>) -> Value {
    let Some(size) = value.and_then(Value::as_f64) else { return Value::Null; };
    if size.is_finite() && size.fract() == 0.0 && size > 0.0 && size <= MAX_SAFE_INTEGER {
        json!(size as u64)
    } else { Value::Null }
}

fn parse_sha256(value: Option<&Value>) -> Option<String> {
    let digest = value.and_then(Value::as_str)?;
    let digest = js_trim(digest);
    let hash = digest.strip_prefix("sha256:").or_else(|| {
        digest.get(..7).filter(|prefix| prefix.eq_ignore_ascii_case("sha256:")).map(|_| &digest[7..])
    })?;
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) { return None; }
    Some(hash.to_ascii_lowercase())
}

/// Select a newer, build-matching release asset and validate its trusted
/// download metadata. The checked asset digest is returned only to the private
/// main-process caller that maintains the download authorization cache.
pub fn select(release: &Value, build_kind: &Value, current_version: &Value) -> Result<Value, String> {
    let bytes = serde_json::to_vec(release).map_err(|_| "update-release-select metadata is invalid")?;
    if bytes.len() > MAX_RELEASE_BYTES { return Err("update-release-select metadata exceeds the size limit".into()); }
    let mut nodes = 0;
    if metadata_limits_exceeded(release, 0, &mut nodes) { return Err("update-release-select metadata exceeds structural limits".into()); }
    if release.get("assets").and_then(Value::as_array).is_some_and(|assets| assets.len() > MAX_RELEASE_ASSETS) {
        return Err("update-release-select asset count exceeds the limit".into());
    }
    let Some(build_kind_text) = build_kind.as_str() else {
        return Ok(json!({"available":false,"reason":"unknown-build-kind"}));
    };
    let Some(expected_name) = expected_asset_name(build_kind_text) else {
        return Ok(json!({"available":false,"reason":"unknown-build-kind"}));
    };
    let Some(current_version) = current_version.as_str() else {
        return Err("update-release-select current version must be a string".into());
    };
    let Some(version) = parse_release_tag(release.get("tag_name")) else { return Ok(unavailable()); };
    if !newer_version(&version, current_version) { return Ok(unavailable()); }
    let Some(assets) = release.get("assets").and_then(Value::as_array) else { return Ok(unavailable()); };
    let selected = assets.iter().find_map(|asset| {
        let name = asset.get("name").and_then(Value::as_str)?;
        if !name.eq_ignore_ascii_case(expected_name) { return None; }
        validate_asset_url(asset.get("browser_download_url"), expected_name).map(|url| (asset, url))
    });
    let Some((asset, asset_url)) = selected else { return Ok(unavailable()); };
    let asset_digest = asset.get("digest").and_then(Value::as_str)
        .ok_or("GitHub release asset is missing a valid SHA-256 digest")?;
    let expected_sha256 = parse_sha256(Some(&Value::String(asset_digest.to_owned())))
        .ok_or("GitHub release asset is missing a valid SHA-256 digest")?;
    Ok(json!({
        "available": true,
        "version": version,
        "assetUrl": asset_url,
        "assetName": expected_name,
        "assetSize": safe_size(asset.get("size")),
        "assetDigest": asset_digest,
        "expectedSha256": expected_sha256
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(url: &str, digest: Value) -> Value {
        json!({"tag_name":"v1.3.0","assets":[{
            "name":"Arc-Power_Portable.exe", "browser_download_url":url,
            "size":4096, "digest":digest
        }]})
    }

    #[test]
    fn selects_only_newer_matching_release_and_retains_verified_digest() {
        let digest = format!("sha256:{}", "aB".repeat(32));
        let value = release("https://github.com/YamsSE/Arc-Power/releases/download/v1.3.0/Arc-Power_Portable.exe", json!(digest));
        let selected = select(&value, &json!("portable"), &json!("1.2.5")).unwrap();
        assert_eq!(selected["available"], true);
        assert_eq!(selected["assetSize"], 4096);
        assert_eq!(selected["expectedSha256"], "ab".repeat(32));
        assert_eq!(select(&value, &json!("portable"), &json!("1.3.0")).unwrap(), unavailable());
        assert_eq!(select(&value, &json!("installed"), &json!("1.2.5")).unwrap(), unavailable());
    }

    #[test]
    fn rejects_untrusted_urls_and_missing_digest() {
        let digest = json!(format!("sha256:{}", "a".repeat(64)));
        let untrusted = release("https://example.com/YamsSE/Arc-Power/releases/download/v1.3.0/Arc-Power_Portable.exe", digest);
        assert_eq!(select(&untrusted, &json!("portable"), &json!("1.2.5")).unwrap(), unavailable());
        let missing = release("https://github.com/YamsSE/Arc-Power/releases/download/v1.3.0/Arc-Power_Portable.exe", Value::Null);
        assert!(select(&missing, &json!("portable"), &json!("1.2.5")).unwrap_err().contains("SHA-256"));
    }

    #[test]
    fn rejects_oversized_release_metadata_before_selecting_an_asset() {
        let too_many = json!({"tag_name":"v1.3.0","assets":vec![json!({}); MAX_RELEASE_ASSETS + 1]});
        assert!(select(&too_many, &json!("portable"), &json!("1.2.5")).unwrap_err().contains("asset count"));
    }
}
