use serde_json::Value;
use std::io::{self, BufRead};

pub const PREFIX: &str = "@arcpower-rpc:v1";
pub const MAX_FRAME: usize = 8 * 1024 * 1024;
pub const MAX_MEDIA_BODY: usize = 4 * 1024 * 1024;

pub fn read_bounded_line(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() { return Ok(if line.is_empty() { None } else { Some(line) }); }
        let end = available.iter().position(|byte| *byte == b'\n').map(|p| p + 1).unwrap_or(available.len());
        if line.len() + end > MAX_FRAME { return Err(io::Error::new(io::ErrorKind::InvalidData, "broker frame exceeds limit")); }
        let finished = available[end - 1] == b'\n';
        line.extend_from_slice(&available[..end]);
        reader.consume(end);
        if finished { return Ok(Some(line)); }
    }
}

pub fn parse_frame(line: &[u8], session: &str) -> Result<Option<Value>, String> {
    if !line.starts_with(PREFIX.as_bytes()) { return Ok(None); }
    let frame: Value = serde_json::from_slice(&line[PREFIX.len()..]).map_err(|_| "Invalid broker JSON")?;
    if frame.get("v").and_then(Value::as_u64) != Some(1)
        || frame.get("session").and_then(Value::as_str) != Some(session) {
        return Err("Broker protocol/session mismatch".into());
    }
    Ok(Some(frame))
}

pub fn media_source_url(uri: &str) -> Result<String, String> {
    let parsed = url::Url::parse(uri).map_err(|_| "Invalid media URL")?;
    if !((parsed.scheme() == "http" && parsed.host_str() == Some("arc-power-media.localhost"))
        || (parsed.scheme() == "arc-power-media" && parsed.host_str() == Some("localhost")))
        || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("Invalid media origin".into());
    }
    let segments: Vec<_> = parsed.path().trim_start_matches('/').split('/').collect();
    if segments.len() != 2 || !matches!(segments[0], "clip" | "thumbnail") {
        return Err("Invalid media route".into());
    }
    let id = segments[1];
    if !(8..=128).contains(&id.len()) || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
        return Err("Invalid opaque clip id".into());
    }
    Ok(format!("arc-power-media://{}/{}", segments[0], id))
}

pub fn trusted_main_url(url: &url::Url) -> bool {
    ((url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
        || (url.scheme() == "tauri" && url.host_str() == Some("localhost")))
        && url.path() == "/renderer/index.html" && url.username().is_empty()
        && url.password().is_none() && url.port().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authenticates_frames_and_ignores_logs() {
        assert!(parse_frame(b"normal broker log\n", "s").unwrap().is_none());
        assert!(parse_frame(br#"@arcpower-rpc:v1{"v":1,"session":"s","kind":"ready"}"#, "s").unwrap().is_some());
        assert!(parse_frame(br#"@arcpower-rpc:v1{"v":1,"session":"other"}"#, "s").is_err());
        assert!(parse_frame(br#"@arcpower-rpc:v1{"v":2,"session":"s"}"#, "s").is_err());
    }
    #[test]
    fn accepts_only_opaque_media_routes() {
        assert_eq!(media_source_url("http://arc-power-media.localhost/clip/abcdefgh").unwrap(), "arc-power-media://clip/abcdefgh");
        for url in ["http://evil/clip/abcdefgh", "http://arc-power-media.localhost/clip/..", "http://arc-power-media.localhost/clip/abc%2Fdefgh", "http://arc-power-media.localhost/file/C:/private", "http://arc-power-media.localhost/clip/abcdefgh?path=x"] {
            assert!(media_source_url(url).is_err(), "{url}");
        }
    }
    #[test]
    fn native_commands_require_the_packaged_main_document() {
        assert!(trusted_main_url(&url::Url::parse("http://tauri.localhost/renderer/index.html?theme=dark").unwrap()));
        for url in ["https://example.org/renderer/index.html", "http://tauri.localhost/renderer/overlay.html", "http://tauri.localhost.evil/renderer/index.html", "http://tauri.localhost:8000/renderer/index.html"] {
            assert!(!trusted_main_url(&url::Url::parse(url).unwrap()));
        }
    }
    #[test]
    fn bounded_reader_handles_eof_and_rejects_large_lines() {
        let mut input = io::Cursor::new(b"one\ntwo".to_vec());
        assert_eq!(read_bounded_line(&mut input).unwrap().unwrap(), b"one\n");
        assert_eq!(read_bounded_line(&mut input).unwrap().unwrap(), b"two");
        assert!(read_bounded_line(&mut input).unwrap().is_none());
        assert!(read_bounded_line(&mut io::Cursor::new(vec![b'x'; MAX_FRAME + 1])).is_err());
    }
}
