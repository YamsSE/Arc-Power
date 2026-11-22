use serde_json::Value;

pub const AUXILIARY: &[&str] = &["overlay", "advanced-overlay", "recording-toast", "recording-status-pill", "splash"];

pub fn role(label: &str) -> Option<&str> {
    if label == "main" { return Some("main"); }
    AUXILIARY.iter().copied().find(|role| label.strip_prefix(&format!("{role}-")).is_some_and(|id| {
        !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit())
            && !id.starts_with('0') && id.parse::<u64>().is_ok_and(|id| id >= 1_000_000)
    }))
}

pub fn document(role: &str) -> Option<String> {
    if role == "main" { Some("renderer/index.html".into()) }
    else if AUXILIARY.contains(&role) { Some(format!("renderer/{role}.html")) }
    else { None }
}

pub fn trusted_url(label: &str, url: &url::Url) -> bool {
    let Some(document) = role(label).and_then(document) else { return false; };
    ((url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
        || (url.scheme() == "tauri" && url.host_str() == Some("localhost")))
        && url.path() == format!("/{document}") && url.username().is_empty()
        && url.password().is_none() && url.port().is_none()
}

pub fn passive(role: &str) -> bool { matches!(role, "overlay" | "recording-toast" | "recording-status-pill") }

pub fn theme_background(theme: &str) -> Option<(u8, u8, u8)> {
    match theme {
        "dark" => Some((0x0f, 0x11, 0x16)), "midnight" => Some((0x0b, 0x10, 0x20)),
        "light" => Some((0xf2, 0xf4, 0xf8)), "red" => Some((0x1a, 0x0d, 0x10)),
        "yellow" => Some((0x1a, 0x16, 0x08)), _ => None,
    }
}

pub fn bounds(role: &str, value: &Value) -> Result<(f64, f64, f64, f64), String> {
    let number = |key| value[key].as_f64().filter(|value| value.is_finite()).ok_or_else(|| format!("Invalid window {key}"));
    let (x, y, width, height) = (number("x")?, number("y")?, number("width")?, number("height")?);
    let (min_width, min_height) = if role == "main" { (980.0, 640.0) } else { (1.0, 1.0) };
    if x.abs() > 100000.0 || y.abs() > 100000.0 || !(min_width..=16384.0).contains(&width) || !(min_height..=16384.0).contains(&height) {
        return Err("Window bounds exceed role limits".into());
    }
    Ok((x, y, width, height))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn labels_and_documents_cannot_cross_roles() {
        for role_name in AUXILIARY {
            let label = format!("{role_name}-1000000");
            assert_eq!(role(&label), Some(*role_name));
            assert!(trusted_url(&label, &url::Url::parse(&format!("http://tauri.localhost/{}?theme=dark", document(role_name).unwrap())).unwrap()));
            assert!(!trusted_url(&label, &url::Url::parse("http://tauri.localhost/renderer/index.html").unwrap()));
        }
        for label in ["overlay-1", "overlay-01000000", "overlay--1000000", "unknown-1000000", "main-1000000", "overlay-1000000/../main"] {
            assert!(role(label).is_none(), "{label}");
        }
        assert!(!trusted_url("overlay-1000000", &url::Url::parse("https://example.org/renderer/overlay.html").unwrap()));
    }
    #[test]
    fn pill_bounds_remain_small_while_main_retains_minimum() {
        let value = serde_json::json!({"x":-48,"y":0,"width":48,"height":30});
        assert!(bounds("recording-status-pill", &value).is_ok());
        assert!(bounds("main", &value).is_err());
        assert!(bounds("overlay", &serde_json::json!({"x":0,"y":0,"width":0,"height":1})).is_err());
    }

    #[test]
    fn native_first_paint_matches_all_software_themes() {
        for theme in ["dark", "midnight", "light", "red", "yellow"] { assert!(theme_background(theme).is_some()); }
        assert_eq!(theme_background("midnight"), Some((11, 16, 32)));
        assert!(theme_background("system").is_none());
    }
}
