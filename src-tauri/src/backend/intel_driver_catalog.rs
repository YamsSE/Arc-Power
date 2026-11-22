//! Native port of the read-only metadata half of `src/main/intel-driver-update.js`.
//!
//! Four fixed `www.intel.com` pages are tried first, followed by the matching
//! four fixed official `www.intel.cn` regional pages if the US page is
//! unavailable. Release-detail URLs are accepted only in Intel's numeric
//! detail shape for the matching Arc or Arc Pro product root. Query strings,
//! fragments, ports, userinfo, other hosts, and prefix/substring lookalikes are
//! rejected. Metadata requests never follow redirects and are bounded to 8
//! seconds / 1 MiB.
//!
//! Deliberate deviation from Electron: a failed `check()` refresh is followed
//! by a 60-second negative backoff and reports `null` for that kind instead of
//! serving the last successful value indefinitely (Electron keeps returning
//! stale success and never backs off). Successful metadata keeps the 15-minute
//! cache. The catalog keeps its 15-minute / 60-second partial cache and adds an
//! in-flight wait so concurrent callers share one two-page fetch. The parsed
//! catalog sources live exactly as long as the value they produced, so
//! `resolve_release` maps a listed version to its URL without downloading the
//! catalog pages again, and the eight fixed landing pages share validated HTML
//! for at most 60 seconds so the startup update check warms the library. That
//! page window is never longer than the shortest catalog TTL, so a catalog
//! refresh is never served an HTML body older than the fetch it replaces.
use super::store_file::reject_reparse_components;
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::Path,
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};
use url::Url;

pub const ARC_OFFICIAL_PAGE_URL: &str = "https://www.intel.com/content/www/us/en/download/785597/intel-arc-graphics-windows.html";
pub const ARC_HISTORICAL_PAGE_URL: &str = "https://www.intel.com/content/www/us/en/download/857252/historical-intel-arc-graphics-drivers.html";
pub const PRO_OFFICIAL_PAGE_URL: &str = "https://www.intel.com/content/www/us/en/download/741626/intel-arc-pro-graphics-windows.html";
pub const PRO_HISTORICAL_PAGE_URL: &str = "https://www.intel.com/content/www/us/en/download/857390/historical-intel-arc-pro-graphics-drivers.html";
pub const ARC_REGIONAL_OFFICIAL_PAGE_URL: &str = "https://www.intel.cn/content/www/cn/zh/download/785597/intel-arc-graphics-windows.html";
pub const ARC_REGIONAL_HISTORICAL_PAGE_URL: &str = "https://www.intel.cn/content/www/cn/zh/download/857252/historical-intel-arc-graphics-drivers.html";
pub const PRO_REGIONAL_OFFICIAL_PAGE_URL: &str = "https://www.intel.cn/content/www/cn/zh/download/741626/intel-arc-pro-graphics-windows.html";
pub const PRO_REGIONAL_HISTORICAL_PAGE_URL: &str = "https://www.intel.cn/content/www/cn/zh/download/857390/historical-intel-arc-pro-graphics-drivers.html";

const FETCH_TIMEOUT_SECS: u64 = 8;
pub const MAX_METADATA_RESPONSE_BYTES: usize = 1024 * 1024;
const CHECK_CACHE_TTL_MS: f64 = 15.0 * 60.0 * 1000.0;
const NEGATIVE_CACHE_TTL_MS: f64 = 60.0 * 1000.0;
const CATALOG_CACHE_TTL_MS: f64 = 15.0 * 60.0 * 1000.0;
const PARTIAL_CATALOG_CACHE_TTL_MS: f64 = 60.0 * 1000.0;
/// Validated HTML for the eight fixed landing pages, so the startup
/// `intel-driver-update-check` warms `library()` instead of refetching the
/// same official page. It is deliberately no longer than the shortest catalog
/// TTL: every catalog refresh happens at or after this window, so a refresh
/// can never be served an HTML body older than the fetch it replaces.
const PAGE_HTML_CACHE_TTL_MS: f64 = 60.0 * 1000.0;
const MAX_CHANGELOG_ITEMS: usize = 20;
const MAX_CHANGELOG_ITEM_LENGTH: usize = 500;
const MAX_CHANGELOG_LENGTH: usize = 4000;
const MAX_CATALOG_RELEASES: usize = 100;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const DOWNLOAD_FILE_NAME: &str = "gfx_win_101.exe";

/// An explicit, stable desktop-Chrome User-Agent for Intel's public pages.
pub const INTEL_FETCH_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 ArcPower/1.3.0";

#[derive(Clone, Copy)]
pub struct IntelPages {
    pub official: &'static str,
    pub historical: &'static str,
}

pub fn pages(kind: &str) -> Option<IntelPages> {
    match kind {
        "arc" => Some(IntelPages { official: ARC_OFFICIAL_PAGE_URL, historical: ARC_HISTORICAL_PAGE_URL }),
        "pro" => Some(IntelPages { official: PRO_OFFICIAL_PAGE_URL, historical: PRO_HISTORICAL_PAGE_URL }),
        _ => None,
    }
}

pub fn regional_pages(kind: &str) -> Option<IntelPages> {
    match kind {
        "arc" => Some(IntelPages { official: ARC_REGIONAL_OFFICIAL_PAGE_URL, historical: ARC_REGIONAL_HISTORICAL_PAGE_URL }),
        "pro" => Some(IntelPages { official: PRO_REGIONAL_OFFICIAL_PAGE_URL, historical: PRO_REGIONAL_HISTORICAL_PAGE_URL }),
        _ => None,
    }
}

fn has_safe_page_authority(url: &Url) -> bool {
    url.scheme() == "https"
        && matches!(url.host_str(), Some("www.intel.com" | "www.intel.cn"))
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

fn same_page_identity(left: &Url, right: &Url) -> bool {
    has_safe_page_authority(left)
        && has_safe_page_authority(right)
        && left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.path() == right.path()
}

fn is_fixed_official_page(url: &Url) -> bool {
    ["arc", "pro"].iter().any(|kind| {
        let Some(primary) = pages(kind) else { return false; };
        let Some(regional) = regional_pages(kind) else { return false; };
        [primary.official, primary.historical, regional.official, regional.historical].iter().any(|known| {
            Url::parse(known).ok().is_some_and(|known| same_page_identity(url, &known))
        })
    })
}

/// Accepts only one of the eight fixed official Intel landing pages and
/// requires the response URL to match its host and path exactly.
pub fn valid_official_url(value: &str, expected_url: &str) -> bool {
    let (Ok(parsed), Ok(expected)) = (Url::parse(value), Url::parse(expected_url)) else { return false; };
    is_fixed_official_page(&expected) && same_page_identity(&parsed, &expected)
}

fn release_url(value: &str, kind: &str) -> Option<Url> {
    let pages = pages(kind)?;
    let regional = regional_pages(kind)?;
    let base = Url::parse(pages.official).ok()?;
    let url = base.join(value).ok()?;
    if !has_safe_page_authority(&url) { return None; }
    let path = url.path();
    let mut roots = Vec::new();
    for root_url in [pages.official, pages.historical, regional.official, regional.historical] {
        let root = Url::parse(root_url).ok()?;
        let id = regex::Regex::new(r"/download/(\d+)/").ok()?.captures(root.path())
            .and_then(|captures| captures.get(1)).map(|m| m.as_str().to_owned());
        let slug = regex::Regex::new(r"/download/\d+/([^/]+\.html)$").ok()?.captures(root.path())
            .and_then(|captures| captures.get(1)).map(|m| m.as_str().to_ascii_lowercase());
        let locale = if root.path().contains("/us/en/") { "us/en" } else { "cn/zh" };
        if same_page_identity(&url, &root) { return Some(url); }
        roots.push((root.host_str().unwrap_or_default().to_owned(), locale.to_owned(), id, slug));
    }
    let detail = regex::Regex::new(r"^/content/www/(us/en|cn/zh)/download/(\d+)/(\d+)/([^/]+\.html)$").ok()?;
    let captures = detail.captures(path)?;
    let locale = captures.get(1)?.as_str();
    let id = captures.get(2)?.as_str();
    let slug = captures.get(4)?.as_str().to_ascii_lowercase();
    roots.iter().any(|(root_host, root_locale, root_id, root_slug)| {
        url.host_str() == Some(root_host.as_str()) && root_locale == locale
            && root_id.as_deref() == Some(id) && root_slug.as_deref() == Some(slug.as_str())
    })
        .then_some(url)
}

/// Mirrors `validIntelDriverReleaseUrl`, including relative resolution against
/// the official page and the numeric detail-ID/slug allowlist.
pub fn valid_intel_driver_release_url(value: &str, kind: &str) -> bool { release_url(value, kind).is_some() }

fn attr_value(tag: &str, name: &str) -> Option<String> {
    let escaped = regex::Regex::new(r"([.*+?^${}()|\[\]\\])").unwrap().replace_all(name, r"\$1").into_owned();
    for quote in ['"', '\''] {
        let pattern = format!(r#"(?i)\b{}\s*=\s*{quote}([^{quote}]*){}"#, escaped, quote);
        if let Some(captures) = regex::Regex::new(&pattern).ok().and_then(|regex| regex.captures(tag)) {
            return captures.get(1).map(|m| m.as_str().to_owned());
        }
    }
    None
}

fn meta_attribute(source: &str, name: &str) -> Option<String> {
    let tag_regex = regex::Regex::new(r"(?is)<meta\b[^>]*>").unwrap();
    for tag in tag_regex.find_iter(source) {
        if attr_value(tag.as_str(), "name").is_some_and(|value| value.eq_ignore_ascii_case(name)) {
            return attr_value(tag.as_str(), "content");
        }
    }
    None
}

pub(super) fn decode_html_text(value: &str) -> String {
    let script = regex::Regex::new(r"(?is)<script\b[^>]*>[\s\S]*?</script\s*>").unwrap();
    let style = regex::Regex::new(r"(?is)<style\b[^>]*>[\s\S]*?</style\s*>").unwrap();
    let tags = regex::Regex::new(r"<[^>]*>").unwrap();
    let entity = regex::Regex::new(r"(?i)&(#x[\da-f]+;?|#\d+;?|[a-z][a-z\d]+;)").unwrap();
    let whitespace = regex::Regex::new(r"\s+").unwrap();
    let without_script = script.replace_all(value, " ");
    let without_style = style.replace_all(&without_script, " ");
    let without_markup = tags.replace_all(&without_style, " ");
    let decoded = entity.replace_all(&without_markup, |captures: &regex::Captures| {
        let reference = captures.get(1).unwrap().as_str();
        if !reference.starts_with('#') { return named_entity(reference).unwrap_or_else(|| captures.get(0).unwrap().as_str().to_owned()); }
        let hexadecimal = reference.len() > 1 && (reference.as_bytes()[1] == b'x' || reference.as_bytes()[1] == b'X');
        let digits = if hexadecimal { &reference[2..] } else { &reference[1..] };
        let digits = digits.trim_end_matches(';');
        let code_point = u32::from_str_radix(digits, if hexadecimal { 16 } else { 10 }).ok();
        match code_point {
            Some(0) | None => "\u{FFFD}".to_owned(),
            Some(value) => char::from_u32(value).map(|character| character.to_string()).unwrap_or_else(|| "\u{FFFD}".to_owned()),
        }
    });
    whitespace.replace_all(&decoded, " ").trim().to_owned()
}

fn named_entity(reference: &str) -> Option<String> {
    let name = reference.strip_suffix(';')?.to_ascii_lowercase();
    let character = match name.as_str() {
        "amp" => '&', "apos" => '\'', "bull" => '\u{2022}', "copy" => '\u{00A9}', "deg" => '\u{00B0}',
        "divide" => '\u{00F7}', "gt" => '>', "hellip" => '\u{2026}', "laquo" => '\u{00AB}', "ldquo" => '\u{201C}',
        "lsaquo" => '\u{2039}', "lt" => '<', "mdash" => '\u{2014}', "middot" => '\u{00B7}', "nbsp" => ' ',
        "ndash" => '\u{2013}', "plusmn" => '\u{00B1}', "quot" => '"', "raquo" => '\u{00BB}', "rdquo" => '\u{201D}',
        "reg" => '\u{00AE}', "rsaquo" => '\u{203A}', "trade" => '\u{2122}', "times" => '\u{00D7}',
        _ => return None,
    };
    Some(character.to_string())
}

fn strip_markup(value: &str) -> String {
    let script = regex::Regex::new(r"(?is)<script\b[^>]*>[\s\S]*?</script\s*>").unwrap();
    let style = regex::Regex::new(r"(?is)<style\b[^>]*>[\s\S]*?</style\s*>").unwrap();
    let tags = regex::Regex::new(r"<[^>]*>").unwrap();
    let whitespace = regex::Regex::new(r"\s+").unwrap();
    let without_script = script.replace_all(value, " ");
    let without_style = style.replace_all(&without_script, " ");
    let text = tags.replace_all(&without_style, " ");
    let text = regex::Regex::new(r"(?i)&nbsp;|&#160;").unwrap().replace_all(&text, " ");
    let text = regex::Regex::new(r"(?i)&amp;").unwrap().replace_all(&text, "&");
    whitespace.replace_all(&text, " ").trim().to_owned()
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    }
}

fn normalized_date(value: &str) -> Option<String> {
    let candidate = value.trim();
    let months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    let (year, month, day) = if let Some(captures) = regex::Regex::new(
        r"(?i)^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$").ok()?.captures(candidate) {
        (captures[1].parse::<i64>().ok()?, captures[2].parse::<i64>().ok()?, captures[3].parse::<i64>().ok()?)
    } else if let Some(captures) = regex::Regex::new(r"^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$").ok()?.captures(candidate) {
        (captures[3].parse::<i64>().ok()?, captures[1].parse::<i64>().ok()?, captures[2].parse::<i64>().ok()?)
    } else if let Some(captures) = regex::Regex::new(r"(?i)^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$").ok()?.captures(candidate) {
        let month = months.iter().position(|name| *name == captures[1].to_ascii_lowercase()).map(|index| index as i64 + 1)?;
        (captures[3].parse::<i64>().ok()?, month, captures[2].parse::<i64>().ok()?)
    } else { return None; };
    // JavaScript's Date.UTC maps a 0..99 year into 1900..1999, so the
    // getUTCFullYear equality check rejects those four-digit spellings.
    if year < 100 || year > 9999 || month < 1 || month > 12 || day < 1 || day > days_in_month(year, month) { return None; }
    Some(format!("{year:04}-{month:02}-{day:02}"))
}

fn version_boundary_ok(text: &str, end: usize) -> bool {
    let rest = &text[end..];
    if rest.as_bytes().first().is_some_and(u8::is_ascii_digit) { return false; }
    !(rest.starts_with('.') && rest.as_bytes().get(1).is_some_and(u8::is_ascii_digit))
}

fn version_at_start(value: &str) -> Option<String> {
    let value = value.trim_start();
    let captures = regex::Regex::new(r"^(\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5})").ok()?.captures(value)?;
    let matched = captures.get(1)?;
    version_boundary_ok(value, matched.end()).then(|| matched.as_str().to_owned())
}

pub fn is_full_driver_version(value: &str) -> bool {
    regex::Regex::new(r"^\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5}$").unwrap().is_match(value)
}

fn body_version(text: &str) -> Option<String> {
    let regex = regex::Regex::new(r"(?i)Intel(?:®)?\s+Graphics\s+Driver\s+(\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5})").ok()?;
    for captures in regex.captures_iter(text) {
        let matched = captures.get(1)?;
        if version_boundary_ok(text, matched.end()) { return Some(matched.as_str().to_owned()); }
    }
    None
}

fn release_selector_html(source: &str) -> Option<&str> {
    let open = regex::Regex::new(r"(?is)<select\b([^>]*)>").unwrap();
    for captures in open.captures_iter(source) {
        let Some(attributes) = captures.get(1) else { continue; };
        if attr_value(attributes.as_str(), "id").as_deref() != Some("version-driver-select") { continue; }
        let start = captures.get(0).unwrap().end();
        let rest = &source[start..];
        if let Some(close) = regex::Regex::new(r"(?i)</select\s*>").unwrap().find(rest) {
            return Some(&rest[..close.start()]);
        }
    }
    None
}

fn extract_release_options(source: &str, kind: &str, base_url: &str) -> Vec<(String, String)> {
    let Some(select) = release_selector_html(source) else { return Vec::new(); };
    let option = regex::Regex::new(r"(?is)<option\b([^>]*)>([\s\S]*?)</option\s*>").unwrap();
    let version_regex = regex::Regex::new(r"\b(\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5})\b").unwrap();
    let mut options: Vec<(String, String)> = Vec::new();
    let mut positions: HashMap<String, usize> = HashMap::new();
    for captures in option.captures_iter(select) {
        let Some(value) = captures.get(1).and_then(|attributes| attr_value(attributes.as_str(), "value")) else { continue; };
        let text = decode_html_text(captures.get(2).map(|m| m.as_str()).unwrap_or(""));
        let Some(version) = version_regex.captures(&text).and_then(|captures| captures.get(1)).map(|m| m.as_str().to_owned()) else { continue; };
        let Ok(base) = Url::parse(base_url) else { continue; };
        let Ok(url) = base.join(&value) else { continue; };
        if !valid_intel_driver_release_url(url.as_str(), kind) { continue; }
        // JavaScript's Map keeps the first version position and the last
        // duplicate value.
        if let Some(position) = positions.get(&version).copied() { options[position].1 = url.to_string(); }
        else { positions.insert(version.clone(), options.len()); options.push((version, url.to_string())); }
    }
    options
}

#[derive(Clone)]
struct Block {
    start: usize,
    end: usize,
    level: Option<usize>,
    text: String,
}

fn parse_tag(value: &str) -> Option<(String, bool)> {
    let captures = regex::Regex::new(r"(?i)^<\s*(/?)\s*([a-z0-9]+)").ok()?.captures(value)?;
    Some((captures[2].to_ascii_lowercase(), !captures[1].is_empty()))
}

fn html_blocks(html: &str) -> Vec<Block> {
    let token = regex::Regex::new(r"(?s)<[^>]*>|[^<]+").unwrap();
    let tokens: Vec<(usize, &str)> = token.find_iter(html).map(|matched| (matched.start(), matched.as_str())).collect();
    let mut blocks = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let (start, raw) = tokens[index];
        let Some((tag, closing)) = parse_tag(raw) else { index += 1; continue; };
        let level = match tag.as_str() {
            "h1" => Some(1), "h2" => Some(2), "h3" => Some(3), "h4" => Some(4), "h5" => Some(5), "h6" => Some(6),
            "p" => Some(0),
            _ => None,
        };
        let Some(level) = level.filter(|_| !closing) else { index += 1; continue; };
        let mut close_index = None;
        for (candidate, (_, candidate_raw)) in tokens.iter().enumerate().skip(index + 1) {
            if parse_tag(candidate_raw).is_some_and(|(name, candidate_closing)| candidate_closing && name == tag) {
                close_index = Some(candidate); break;
            }
        }
        let Some(close_index) = close_index else { index += 1; continue; };
        let inner_start = start + raw.len();
        let close_start = tokens[close_index].0;
        let close_end = close_start + tokens[close_index].1.len();
        blocks.push(Block {
            start,
            end: close_end,
            level: (level != 0).then_some(level),
            text: decode_html_text(&html[inner_start..close_start]),
        });
        index = close_index + 1;
    }
    blocks
}

fn changelog_section(cleaned: &str) -> Option<(usize, usize)> {
    let blocks = html_blocks(cleaned);
    let heading = regex::Regex::new(r"(?i)^Highlights(?:\s+of\s+this\s+Workstation\s+Driver)?\s*:?$").unwrap();
    let label = regex::Regex::new(r"(?i)Highlights(?:\s+of\s+this\s+Workstation\s+Driver)?\s*:?").unwrap();
    let next_after = |start: usize, level: usize| -> usize {
        blocks.iter().find(|block| {
            block.start >= start && block.level.is_some_and(|value| value <= level)
                && !heading.is_match(block.text.trim())
        }).map_or(cleaned.len(), |block| block.start)
    };

    // Older Intel pages wrap the highlights in a Detailed Description section.
    if let Some(detail) = blocks.iter().find(|block| {
        regex::Regex::new(r"(?i)^Detailed\s+Description\s*:?$").unwrap().is_match(block.text.trim())
    }) {
        let level = detail.level.unwrap_or(usize::MAX);
        let end = next_after(detail.end, level);
        if let Some(found) = label.find(&cleaned[detail.end..end]) {
            return Some((detail.end + found.end(), end));
        }
    }

    // Current Intel pages expose a standalone Highlights heading/list with no
    // Detailed Description wrapper at all. Accept that shape directly.
    let highlight = blocks.iter().find(|block| heading.is_match(block.text.trim()))?;
    let level = highlight.level.unwrap_or(usize::MAX);
    Some((highlight.end, next_after(highlight.end, level)))
}

fn strip_block_decoys(html: &str) -> String {
    let comment = regex::Regex::new(r"(?s)<!--[\s\S]*?(?:-->|$)").unwrap();
    let script = regex::Regex::new(r"(?is)<script\b[^>]*>[\s\S]*?(?:</script\s*>|$)").unwrap();
    let style = regex::Regex::new(r"(?is)<style\b[^>]*>[\s\S]*?(?:</style\s*>|$)").unwrap();
    style.replace_all(&script.replace_all(&comment.replace_all(html, " "), " "), " ").into_owned()
}

struct ArenaItem { text: String, children: Vec<usize> }

#[derive(Default)]
struct ChangelogParser {
    items: Vec<ArenaItem>,
    roots: Vec<usize>,
    loose: String,
    li_stack: Vec<usize>,
    list_stack: Vec<String>,
    block_stack: Vec<(String, String)>,
    malformed: bool,
}

impl ChangelogParser {
    fn push_item(&mut self, text: String, parent: Option<usize>) -> usize {
        let id = self.items.len();
        self.items.push(ArenaItem { text, children: Vec::new() });
        if let Some(parent) = parent { self.items[parent].children.push(id); } else { self.roots.push(id); }
        id
    }
    fn flush_loose(&mut self) {
        let text = decode_html_text(&self.loose);
        self.loose.clear();
        if !text.is_empty() { self.push_item(text, None); }
    }
    fn stop_label(value: &str) -> bool {
        regex::Regex::new(r"(?i)^(?:OS\s+Support|OS\s+Reference|Platform\s+Support|Platform\s*\(\s*OS\s+Support\s*\)|Notes?|Products?|Supported\s+Products|Products?\s+Supported)\s*(?::|$)").unwrap().is_match(value)
    }
    fn parse(mut self, section: &str) -> Option<(Vec<usize>, Vec<ArenaItem>)> {
        let tokens = regex::Regex::new(r"(?s)<[^>]*>|[^<]+").unwrap();
        for token in tokens.find_iter(section) {
            let raw = token.as_str();
            if !raw.starts_with('<') {
                let decoded = decode_html_text(raw);
                if let Some(current) = self.li_stack.last().copied() { self.items[current].text.push_str(raw); self.items[current].text.push(' '); }
                else if let Some((_, text)) = self.block_stack.last_mut() { text.push_str(raw); text.push(' '); }
                else {
                    if Self::stop_label(&decoded) { break; }
                    self.loose.push_str(raw); self.loose.push(' ');
                }
                continue;
            }
            let Some((name, closing)) = parse_tag(raw) else { continue; };
            if !closing && (name == "ul" || name == "ol") {
                self.flush_loose();
                self.list_stack.push(name);
            } else if closing && (name == "ul" || name == "ol") {
                if self.list_stack.pop().as_deref() != Some(name.as_str()) { self.malformed = true; break; }
            } else if !closing && name == "li" {
                self.flush_loose();
                let parent = self.li_stack.last().copied();
                let id = self.push_item(String::new(), parent);
                self.li_stack.push(id);
            } else if closing && name == "li" {
                let Some(id) = self.li_stack.pop() else { self.malformed = true; break; };
                self.items[id].text = decode_html_text(&self.items[id].text);
            } else if !closing && matches!(name.as_str(), "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
                self.flush_loose();
                self.block_stack.push((name, String::new()));
            } else if closing && matches!(name.as_str(), "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
                let Some((block_name, _)) = self.block_stack.pop() else { continue; };
                if block_name != name { self.malformed = true; break; }
                break;
            } else if !closing && name == "p" {
                self.flush_loose();
                self.block_stack.push((name, String::new()));
            } else if closing && name == "p" {
                let Some((block_name, text)) = self.block_stack.pop() else { continue; };
                if block_name != name { self.malformed = true; break; }
                let decoded = decode_html_text(&text);
                if Self::stop_label(&decoded) { break; }
                if !decoded.trim().is_empty() { self.push_item(decoded, None); }
            } else if !closing && name == "br" {
                if let Some(current) = self.li_stack.last().copied() { self.items[current].text.push(' '); }
                else if let Some((_, text)) = self.block_stack.last_mut() { text.push(' '); }
                else { self.flush_loose(); }
            }
        }
        self.flush_loose();
        if self.malformed || !self.li_stack.is_empty() || !self.list_stack.is_empty() || !self.block_stack.is_empty() { return None; }
        Some((self.roots, self.items))
    }
}

struct NormalizedItem { text: String, children: Vec<NormalizedItem> }
struct Limits { invalid: bool, item_count: usize, total_length: usize }

fn normalize_item(id: usize, items: &[ArenaItem], limits: &mut Limits) -> NormalizedItem {
    let item = &items[id];
    let text = regex::Regex::new(r"\s+").unwrap().replace_all(&item.text, " ").trim().to_owned();
    if !text.is_empty() {
        limits.item_count += 1;
        let length = text.encode_utf16().count();
        limits.total_length += length;
        if limits.item_count > MAX_CHANGELOG_ITEMS || length > MAX_CHANGELOG_ITEM_LENGTH
            || limits.total_length > MAX_CHANGELOG_LENGTH { limits.invalid = true; }
    }
    let children = item.children.iter().map(|child| normalize_item(*child, items, limits)).collect();
    NormalizedItem { text, children }
}

fn item_json(item: &NormalizedItem) -> Value {
    let mut object = Map::new();
    object.insert("text".into(), Value::String(item.text.clone()));
    object.insert("kind".into(), Value::String("item".into()));
    if !item.children.is_empty() {
        object.insert("children".into(), Value::Array(item.children.iter().map(item_json).collect()));
    }
    Value::Object(object)
}

fn flatten_changelog(items: &[Value]) -> Vec<Value> {
    fn visit(item: &Value, result: &mut Vec<Value>) {
        if let Some(text) = item.get("text").and_then(Value::as_str).filter(|text| !text.is_empty()) {
            result.push(Value::String(text.to_owned()));
        }
        for child in item.get("children").and_then(Value::as_array).into_iter().flatten() { visit(child, result); }
    }
    let mut result = Vec::new();
    for item in items { visit(item, &mut result); }
    result
}

fn is_heading(text: &str) -> bool {
    regex::Regex::new(r"(?i)^(?:Intel(?:®)?\s+Game\s+On\b|Game\s+performance\s+improvements\b)").unwrap().is_match(text)
        || regex::Regex::new(r":\s*$").unwrap().is_match(text)
}

fn extract_changelog(source: &str) -> Vec<Value> {
    let cleaned = strip_block_decoys(source);
    let Some((section_start, section_end)) = changelog_section(&cleaned) else { return Vec::new(); };
    let section = &cleaned[section_start..section_end];
    let Some((roots, parser_items)) = ChangelogParser::default().parse(section) else { return Vec::new(); };
    let mut limits = Limits { invalid: false, item_count: 0, total_length: 0 };
    let normalized: Vec<NormalizedItem> = roots.iter().map(|id| normalize_item(*id, &parser_items, &mut limits)).collect();
    if limits.invalid { return Vec::new(); }
    let mut result: Vec<Value> = Vec::new();
    let mut active_heading: Option<usize> = None;
    for item in normalized {
        if item.text.is_empty() { continue; }
        if is_heading(&item.text) {
            let mut object = Map::new();
            object.insert("text".into(), Value::String(item.text));
            object.insert("kind".into(), Value::String("heading".into()));
            object.insert("children".into(), Value::Array(item.children.iter().map(item_json).collect()));
            result.push(Value::Object(object));
            active_heading = Some(result.len() - 1);
        } else if let Some(index) = active_heading {
            result[index]["children"].as_array_mut().unwrap().push(item_json(&item));
        } else {
            result.push(item_json(&item));
        }
    }
    result
}

/// Mirrors `parseIntelDriverMetadata`; returns `Value::Null` when no four-part
/// Intel Graphics Driver version is present.
pub fn parse_intel_driver_metadata(source: &str) -> Value {
    let text = strip_markup(source);
    let version = meta_attribute(source, "DownloadVersion").and_then(|value| version_at_start(&value))
        .or_else(|| body_version(&text));
    let Some(version) = version else { return Value::Null; };
    let mut release_date = meta_attribute(source, "lastModifieddate").and_then(|value| normalized_date(&value));
    if release_date.is_none() {
        let date = regex::Regex::new(r"(?i)(?:release\s*date|date\s*released|published)\s*[:\-]?\s*((?:\d{4}[-/]\d{1,2}[-/]\d{1,2})|(?:\d{1,2}[/-]\d{1,2}[/-]\d{4})|(?:[A-Za-z]+\s+\d{1,2},?\s+\d{4}))").unwrap();
        release_date = date.captures(&text).and_then(|captures| captures.get(1)).and_then(|m| normalized_date(m.as_str()));
    }
    let sections = extract_changelog(source);
    let changelog = flatten_changelog(&sections);
    let has_structure = sections.iter().any(|entry| entry.get("kind").and_then(Value::as_str) == Some("heading")
        || entry.get("children").and_then(Value::as_array).is_some_and(|children| !children.is_empty()));
    let mut metadata = Map::new();
    metadata.insert("version".into(), Value::String(version));
    metadata.insert("releaseDate".into(), release_date.map(Value::String).unwrap_or(Value::Null));
    metadata.insert("changelog".into(), Value::Array(changelog));
    if has_structure { metadata.insert("changelogSections".into(), Value::Array(sections)); }
    Value::Object(metadata)
}

fn release_size_bytes(source: &str) -> Option<u64> {
    let size = regex::Regex::new(r"(?i)\bSize\b\s*:?\s*(?:<[^>]*>\s*)*(\d+(?:\.\d+)?)\s*(GB|MB|KB|bytes?)\b").ok()?;
    let captures = size.captures(source)?;
    let value = captures.get(1)?.as_str().parse::<f64>().ok()?;
    let unit = captures.get(2)?.as_str().to_ascii_lowercase();
    let multiplier = if unit.starts_with('g') { 1024f64.powi(3) } else if unit.starts_with('m') { 1024f64.powi(2) } else if unit.starts_with('k') { 1024.0 } else { 1.0 };
    let bytes = (value * multiplier).round();
    (bytes.is_finite() && bytes > 0.0 && bytes <= 9_007_199_254_740_991.0).then_some(bytes as u64)
}

fn regional_release_size_bytes(source: &str) -> Option<u64> {
    let text = decode_html_text(source);
    let size = regex::Regex::new(r"(?i)(?:文件大小|大小)\s*[:：]\s*(\d+(?:\.\d+)?)\s*(GB|MB|KB|bytes?)\b").ok()?;
    let captures = size.captures(&text)?;
    let value = captures.get(1)?.as_str().parse::<f64>().ok()?;
    let unit = captures.get(2)?.as_str().to_ascii_lowercase();
    let multiplier = if unit.starts_with('g') { 1024f64.powi(3) } else if unit.starts_with('m') { 1024f64.powi(2) } else if unit.starts_with('k') { 1024.0 } else { 1.0 };
    let bytes = (value * multiplier).round();
    (bytes.is_finite() && bytes > 0.0 && bytes <= 9_007_199_254_740_991.0).then_some(bytes as u64)
}

fn parse_release_metadata(kind: &str, official_page_url: &str, source: &str) -> Result<Value, String> {
    if !valid_intel_driver_release_url(official_page_url, kind) { return Err("Intel release URL is not allowed".into()); }
    let metadata = parse_intel_driver_metadata(source);
    if metadata.is_null() { return Err("Intel driver metadata was not found".into()); }
    let mut metadata = metadata.as_object().cloned().ok_or("Intel driver metadata was not found")?;
    let regional = Url::parse(official_page_url).ok().is_some_and(|url| url.host_str() == Some("www.intel.cn"));
    let size = if regional { regional_release_size_bytes(source).or_else(|| release_size_bytes(source)) } else { release_size_bytes(source) };
    metadata.insert("sizeBytes".into(), size.map(|bytes| json!(bytes)).unwrap_or(Value::Null));
    metadata.insert("officialPageUrl".into(), Value::String(official_page_url.to_owned()));
    Ok(Value::Object(metadata))
}

#[derive(Clone)]
pub struct FetchedPage { pub body: String, pub url: String }
pub type FetchFn = dyn Fn(&str) -> Result<FetchedPage, String> + Send + Sync;
pub type NowFn = dyn Fn() -> f64 + Send + Sync;

struct HttpRequest {
    url: String,
    reply: std::sync::mpsc::Sender<Result<FetchedPage, String>>,
}

/// Serial worker that owns the reqwest blocking client. Creating a blocking
/// client inside the Tauri async command thread would panic because reqwest
/// builds/drops its own runtime; this keeps client construction and use on a
/// plain thread while the command thread only waits for a bounded reply.
struct HttpWorker {
    sender: Mutex<std::sync::mpsc::Sender<HttpRequest>>,
}

impl HttpWorker {
    fn new() -> Result<Self, String> {
        let (sender, receiver) = std::sync::mpsc::channel::<HttpRequest>();
        let (ready, ready_receiver) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
        std::thread::Builder::new().name("arc-intel-metadata".into()).spawn(move || {
            let client = match reqwest::blocking::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
                .user_agent(INTEL_FETCH_USER_AGENT)
                .build() {
                Ok(client) => client,
                Err(error) => { let _ = ready.send(Err(format!("Intel metadata client unavailable: {error}"))); return; }
            };
            if ready.send(Ok(())).is_err() { return; }
            while let Ok(request) = receiver.recv() {
                let result = (|| {
                    let response = client.get(&request.url).send()
                        .map_err(|error| format!("Intel metadata request failed: {error}"))?;
                    if !response.status().is_success() { return Err("Intel metadata request failed validation".into()); }
                    let final_url = response.url().to_string();
                    let declared = response.headers().get(reqwest::header::CONTENT_LENGTH)
                        .and_then(|value| value.to_str().ok()).and_then(|value| value.parse::<u64>().ok());
                    if declared.is_some_and(|length| length > MAX_METADATA_RESPONSE_BYTES as u64) {
                        return Err("Intel metadata response too large".into());
                    }
                    let mut body = Vec::new();
                    response.take(MAX_METADATA_RESPONSE_BYTES as u64 + 1).read_to_end(&mut body)
                        .map_err(|error| format!("Intel metadata response could not be read: {error}"))?;
                    if body.len() > MAX_METADATA_RESPONSE_BYTES { return Err("Intel metadata response too large".into()); }
                    let body = String::from_utf8(body).map_err(|_| "Intel metadata response was not UTF-8".to_owned())?;
                    Ok(FetchedPage { body, url: final_url })
                })();
                let _ = request.reply.send(result);
            }
        }).map_err(|error| format!("Intel metadata worker unavailable: {error}"))?;
        match ready_receiver.recv() {
            Ok(Ok(())) => Ok(Self { sender: Mutex::new(sender) }),
            Ok(Err(error)) => Err(error),
            Err(_) => Err("Intel metadata worker stopped during initialization".into()),
        }
    }

    fn get(&self, url: &str) -> Result<FetchedPage, String> {
        let (reply, response) = std::sync::mpsc::channel();
        self.sender.lock().map_err(|_| "Intel metadata worker lock was poisoned")?
            .send(HttpRequest { url: url.to_owned(), reply })
            .map_err(|_| "Intel metadata worker stopped".to_owned())?;
        response.recv().map_err(|_| "Intel metadata worker stopped before replying".to_owned())?
    }
}

struct CacheState {
    check: HashMap<String, (Value, f64)>,
    check_failure: HashMap<String, f64>,
    library: HashMap<String, (Value, f64)>,
    /// Parsed catalog sources for the exact fetch that produced the cached
    /// `library` value, so `resolve_release` maps a version to its URL without
    /// downloading the two catalog pages a second time.
    sources: HashMap<String, (Vec<CatalogSource>, f64)>,
    /// Validated bodies of the fixed landing pages, keyed by request URL.
    page_html: HashMap<String, (String, f64)>,
    in_flight: HashSet<String>,
}

pub struct IntelDriverCatalog {
    fetch: Arc<FetchFn>,
    now: Arc<NowFn>,
    state: Mutex<CacheState>,
    ready: Condvar,
}

impl IntelDriverCatalog {
    /// Production singleton so the 15-minute caches and the in-flight dedupe
    /// span renderer invocations for the process lifetime.
    pub fn shared() -> Result<&'static IntelDriverCatalog, String> {
        static SERVICE: std::sync::OnceLock<Result<IntelDriverCatalog, String>> = std::sync::OnceLock::new();
        match SERVICE.get_or_init(IntelDriverCatalog::new) {
            Ok(service) => Ok(service),
            Err(error) => Err(error.clone()),
        }
    }

    /// Production transport: a dedicated worker thread owns the reqwest
    /// blocking client, so the Tauri async command thread never builds or
    /// drops a reqwest runtime. The worker enforces no redirects, 8s timeout,
    /// Chrome UA, and the 1 MiB cap.
    pub fn new() -> Result<Self, String> {
        let worker = Arc::new(HttpWorker::new()?);
        let fetch: Arc<FetchFn> = Arc::new(move |url: &str| worker.get(url));
        let now: Arc<NowFn> = Arc::new(|| super::platform_context::clock_snapshot().map(|clock| clock.now_ms).unwrap_or(0.0));
        Ok(Self::with_fetcher(fetch, now))
    }

    /// Test/DI seam. The fetcher must only be called with allowlisted URLs.
    pub fn with_fetcher(fetch: Arc<FetchFn>, now: Arc<NowFn>) -> Self {
        Self {
            fetch,
            now,
            state: Mutex::new(CacheState {
                check: HashMap::new(), check_failure: HashMap::new(),
                library: HashMap::new(), sources: HashMap::new(),
                page_html: HashMap::new(), in_flight: HashSet::new(),
            }),
            ready: Condvar::new(),
        }
    }

    fn fetch_html(&self, url: &str, expected_url: &str) -> Result<String, String> {
        let valid_expected = valid_official_url(expected_url, expected_url)
            || valid_intel_driver_release_url(expected_url, "arc")
            || valid_intel_driver_release_url(expected_url, "pro");
        if url != expected_url || !valid_expected { return Err("Intel metadata request failed validation".into()); }
        // Only the eight fixed landing pages share their HTML across channels;
        // detail pages stay per-request so the body count stays fixed and small.
        let shared_page = valid_official_url(expected_url, expected_url);
        if shared_page {
            let now = (self.now)();
            if let Ok(state) = self.state.lock() {
                if let Some((body, expires_at)) = state.page_html.get(url) {
                    if now < *expires_at { return Ok(body.clone()); }
                }
            }
        }
        let page = (self.fetch)(url)?;
        let same_exact_response = valid_official_url(&page.url, expected_url)
            || (page.url == expected_url && valid_intel_driver_release_url(&page.url, "arc"))
            || (page.url == expected_url && valid_intel_driver_release_url(&page.url, "pro"));
        if !same_exact_response { return Err("Intel metadata request failed validation".into()); }
        if page.body.len() > MAX_METADATA_RESPONSE_BYTES { return Err("Intel metadata response too large".into()); }
        if shared_page {
            let now = (self.now)();
            if let Ok(mut state) = self.state.lock() {
                state.page_html.retain(|_, (_, expires_at)| now < *expires_at);
                state.page_html.insert(url.to_owned(), (page.body.clone(), now + PAGE_HTML_CACHE_TTL_MS));
            }
        }
        Ok(page.body)
    }

    fn page_candidates(kind: &str, index: usize) -> Result<[&'static str; 2], String> {
        let primary = pages(kind).ok_or("invalid Intel driver catalog kind")?;
        let regional = regional_pages(kind).ok_or("invalid Intel driver catalog kind")?;
        Ok(if index == 0 {
            [primary.official, regional.official]
        } else {
            [primary.historical, regional.historical]
        })
    }

    fn cached_check(&self, kind: &str, now: f64) -> Option<Value> {
        let state = self.state.lock().ok()?;
        if let Some((value, at)) = state.check.get(kind) {
            if now - *at < CHECK_CACHE_TTL_MS { return Some(value.clone()); }
        }
        if state.check_failure.get(kind).is_some_and(|at| now - *at < NEGATIVE_CACHE_TTL_MS) {
            return Some(Value::Null);
        }
        None
    }

    /// Both kinds are attempted, matching Electron's `Promise.all` result
    /// shape. A failed refresh is negatively cached for 60s and reports null.
    pub fn check(&self) -> Value {
        let mut result = Map::new();
        for kind in ["arc", "pro"] {
            let candidates = Self::page_candidates(kind, 0).expect("fixed Intel page kinds");
            let now = (self.now)();
            if let Some(value) = self.cached_check(kind, now) {
                result.insert(kind.to_owned(), value);
                continue;
            }
            let parsed = candidates.iter().find_map(|page_url| {
                let source = self.fetch_html(page_url, page_url).ok()?;
                let metadata = parse_intel_driver_metadata(&source);
                (!metadata.is_null()).then(|| (metadata, *page_url))
            }).ok_or_else(|| "Intel driver metadata was not found".to_owned());
            match parsed {
                Ok((mut metadata, page_url)) => {
                    metadata["officialPageUrl"] = Value::String(page_url.to_owned());
                    if let Ok(mut state) = self.state.lock() {
                        state.check.insert(kind.to_owned(), (metadata.clone(), now));
                        state.check_failure.remove(kind);
                    }
                    result.insert(kind.to_owned(), metadata);
                }
                Err(_) => {
                    if let Ok(mut state) = self.state.lock() { state.check_failure.insert(kind.to_owned(), now); }
                    result.insert(kind.to_owned(), Value::Null);
                }
            }
        }
        Value::Object(result)
    }

    fn catalog_source_for_html(kind: &str, page_url: &str, index: usize, html: &str) -> CatalogSource {
            let selector = release_selector_html(&html);
            let option_count = selector.map(|selector| {
                regex::Regex::new(r"(?is)<option\b([^>]*)>([\s\S]*?)</option\s*>").unwrap()
                    .captures_iter(selector)
                    .filter(|captures| regex::Regex::new(r"\b\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5}\b").unwrap()
                        .is_match(&decode_html_text(captures.get(2).map(|m| m.as_str()).unwrap_or(""))))
                    .count()
            }).unwrap_or(0);
            let options = extract_release_options(&html, kind, page_url);
            let partial = selector.is_none() || option_count == 0 || options.len() < option_count;
            let latest = if index == 0 {
                let metadata = parse_intel_driver_metadata(&html);
                if metadata.is_null() { None } else { Some(metadata) }
            } else { None };
            CatalogSource { page_url: page_url.to_owned(), options, latest, partial }
    }

    fn catalog_source(&self, kind: &str, index: usize) -> CatalogSource {
        let candidates = Self::page_candidates(kind, index).unwrap_or(["", ""]);
        let mut last = None;
        for page_url in candidates {
            let Ok(html) = self.fetch_html(page_url, page_url) else { continue; };
            let source = Self::catalog_source_for_html(kind, page_url, index, &html);
            // Use a regional page only when the primary source has no usable
            // version entries. This preserves the existing US-first ordering.
            if !source.options.is_empty() || source.latest.is_some() { return source; }
            last = Some(source);
        }
        last.unwrap_or(CatalogSource { page_url: String::new(), options: Vec::new(), latest: None, partial: true })
    }

    fn fetch_sources(&self, kind: &str) -> Vec<CatalogSource> {
        vec![self.catalog_source(kind, 0), self.catalog_source(kind, 1)]
    }

    /// Dedupes the official page before the historical page and promotes the
    /// official page's own version, matching the merged `versions` order.
    fn merged_options(sources: &[CatalogSource]) -> Vec<(String, String)> {
        let mut options: Vec<(String, String)> = Vec::new();
        let mut seen = HashSet::new();
        for source in sources {
            for (version, url) in &source.options {
                if seen.insert(version.clone()) { options.push((version.clone(), url.clone())); }
            }
        }
        if let Some(latest) = sources.first().and_then(|source| source.latest.as_ref()) {
            if let Some(version) = latest.get("version").and_then(Value::as_str) {
                if !seen.contains(version) { options.insert(0, (version.to_owned(), sources[0].page_url.clone())); }
            }
        }
        options
    }

    fn sources_partial(sources: &[CatalogSource]) -> bool {
        sources.iter().any(|source| source.partial) || Self::merged_options(sources).len() > MAX_CATALOG_RELEASES
    }

    fn fetch_catalog(&self, kind: &str) -> Result<(Value, f64, Vec<CatalogSource>), String> {
        if pages(kind).is_none() { return Err("invalid Intel driver catalog kind".into()); }
        let sources = self.fetch_sources(kind);
        let options = Self::merged_options(&sources);
        let partial = sources.iter().any(|source| source.partial) || options.len() > MAX_CATALOG_RELEASES;
        let versions: Vec<Value> = options.iter().take(MAX_CATALOG_RELEASES).map(|(version, _)| Value::String(version.clone())).collect();
        if versions.is_empty() { return Err("Intel driver catalog contains no readable versions".into()); }
        let value = json!({"versions": versions, "partial": partial});
        Ok((value, if partial { PARTIAL_CATALOG_CACHE_TTL_MS } else { CATALOG_CACHE_TTL_MS }, sources))
    }

    /// Catalog sources for `resolve_release`: reuse the parsed pages behind a
    /// cached `library` result, and fetch only when that window is cold.
    fn catalog_sources(&self, kind: &str) -> Vec<CatalogSource> {
        let now = (self.now)();
        if let Ok(state) = self.state.lock() {
            if let Some((sources, expires_at)) = state.sources.get(kind) {
                if now < *expires_at { return sources.clone(); }
            }
        }
        let sources = self.fetch_sources(kind);
        let ttl = if Self::sources_partial(&sources) { PARTIAL_CATALOG_CACHE_TTL_MS } else { CATALOG_CACHE_TTL_MS };
        if let Ok(mut state) = self.state.lock() {
            state.sources.insert(kind.to_owned(), (sources.clone(), (self.now)() + ttl));
        }
        sources
    }

    /// Catalog cache with in-flight dedupe: a second caller waits for the
    /// active two-page fetch and then reads its cached success instead of
    /// starting another pair of requests.
    pub fn library(&self, kind: &str) -> Result<Value, String> {
        if pages(kind).is_none() { return Err("invalid Intel driver catalog kind".into()); }
        let now = (self.now)();
        let mut state = self.state.lock().map_err(|_| "Intel catalog cache lock was poisoned")?;
        loop {
            if let Some((value, expires_at)) = state.library.get(kind) {
                if now < *expires_at { return Ok(value.clone()); }
            }
            if state.in_flight.contains(kind) {
                state = self.ready.wait(state).map_err(|_| "Intel catalog cache lock was poisoned")?;
                continue;
            }
            state.in_flight.insert(kind.to_owned());
            break;
        }
        drop(state);
        let result = self.fetch_catalog(kind);
        let mut state = self.state.lock().map_err(|_| "Intel catalog cache lock was poisoned")?;
        state.in_flight.remove(kind);
        if let Ok((value, ttl, sources)) = &result {
            // The parsed sources share the catalog value's window, so a
            // following `resolve_release` maps the version to its URL without
            // downloading either catalog page again.
            let expires_at = (self.now)() + ttl;
            state.library.insert(kind.to_owned(), (value.clone(), expires_at));
            state.sources.insert(kind.to_owned(), (sources.clone(), expires_at));
        }
        drop(state);
        self.ready.notify_all();
        result.map(|(value, _, _)| value)
    }

    /// Resolve one catalog-listed version from the cached catalog sources, then
    /// fetch only that selected detail page and require its metadata version to
    /// equal the request.
    pub fn resolve_release(&self, kind: &str, version: &str) -> Result<Value, String> {
        if pages(kind).is_none() { return Err("invalid Intel driver release identity".into()); }
        if !is_full_driver_version(version) { return Err("invalid Intel driver release identity".into()); }
        let sources = self.catalog_sources(kind);
        let selected = sources.iter().flat_map(|source| source.options.iter())
            .find(|(candidate, _)| candidate == version).cloned()
            .or_else(|| {
                let first = sources.first()?;
                first.latest.as_ref()
                    .filter(|latest| latest.get("version").and_then(Value::as_str) == Some(version))
                    .map(|_| (version.to_owned(), first.page_url.clone()))
            });
        let Some((_, url)) = selected else { return Err("Intel driver version is not available in the official catalog".into()); };
        if !valid_intel_driver_release_url(&url, kind) { return Err("Intel driver release URL is not allowed".into()); }
        let source = self.fetch_html(&url, &url)?;
        let metadata = parse_release_metadata(kind, &url, &source)?;
        if metadata.get("version").and_then(Value::as_str) != Some(version) {
            return Err("Intel release page version does not match the selected version".into());
        }
        Ok(metadata)
    }
}

#[derive(Clone)]
struct CatalogSource {
    page_url: String,
    options: Vec<(String, String)>,
    latest: Option<Value>,
    partial: bool,
}

/// Local download-status contract for Phase 1: exact path, lstat/regular file
/// only, no hash and no directory creation.
pub fn driver_download_status(root: &Path, kind: &str, version: &str) -> Value {
    if pages(kind).is_none() || !is_full_driver_version(version) { return json!({"downloaded": false, "sizeBytes": null}); }
    let target = root.join("DriverDownloads").join(kind).join(version).join(DOWNLOAD_FILE_NAME);
    if reject_reparse_components(&target).is_err() { return json!({"downloaded": false, "sizeBytes": null}); }
    let Ok(metadata) = fs::symlink_metadata(&target) else { return json!({"downloaded": false, "sizeBytes": null}); };
    if !metadata.file_type().is_file() { return json!({"downloaded": false, "sizeBytes": null}); }
    let size = metadata.len();
    json!({
        "downloaded": size > 0 && size <= MAX_FILE_BYTES,
        "sizeBytes": size,
    })
}

/// The versionless page-open target is the US/English page, matching
/// Electron's `INTEL_DRIVER_PAGES[kind].officialPageUrl`. The `www.intel.cn`
/// pages exist only as a catalog-refresh fallback.
pub fn official_download_page(kind: &str) -> Result<&'static str, String> {
    pages(kind).map(|pages| pages.official).ok_or("intel-driver-download-page-open: invalid kind".into())
}

/// Opens only an already validated Intel page. This intentionally does not
/// reuse `native_system::open_external`, which is GitHub-only.
pub fn open_download_page(url: &str, kind: &str) -> Result<(), String> {
    let pages = pages(kind).ok_or("intel-driver-download-page-open: invalid kind")?;
    if url != pages.official && !valid_intel_driver_release_url(url, kind) {
        return Err("intel-driver-download-page-open: invalid URL".into());
    }
    shell_open(url)
}

#[cfg(windows)]
fn shell_open(target: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide = |value: &str| value.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    let operation = wide("open");
    let file = wide(target);
    let result = unsafe {
        ShellExecuteW(std::ptr::null_mut(), operation.as_ptr(), file.as_ptr(),
            std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL)
    };
    if (result as isize) <= 32 { Err("intel-driver-download-page-open: the system could not open the link".into()) } else { Ok(()) }
}

#[cfg(not(windows))]
fn shell_open(_target: &str) -> Result<(), String> {
    Err("intel-driver-download-page-open is only available on Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

    fn page(version: &str, date: &str) -> String {
        format!("<main>Intel Graphics Driver {version}. {date}</main>")
    }

    fn fake_now(value: Arc<Mutex<f64>>) -> Arc<NowFn> {
        Arc::new(move || *value.lock().unwrap())
    }

    fn fake_fetch(pages: HashMap<String, String>, calls: Arc<Mutex<Vec<String>>>) -> Arc<FetchFn> {
        Arc::new(move |url: &str| {
            calls.lock().unwrap().push(url.to_owned());
            let body = pages.get(url).cloned().ok_or_else(|| format!("unexpected URL: {url}"))?;
            Ok(FetchedPage { body, url: url.to_owned() })
        })
    }

    fn selector(options: &[(&str, &str)], latest: &str) -> String {
        format!("<meta name=\"DownloadVersion\" content=\"{latest}\"><select id=\"version-driver-select\">{}</select>",
            options.iter().map(|(version, url)| format!("<option value=\"{url}\">Intel Graphics Driver {version}</option>")).collect::<String>())
    }

    #[test]
    fn metadata_parser_matches_electron_version_and_date_rules() {
        assert_eq!(parse_intel_driver_metadata("<p>Intel® Graphics Driver 32.0.101.9030</p><p>Release Date: September 2, 2026</p>"),
            json!({"version":"32.0.101.9030","releaseDate":"2026-09-02","changelog":[]}));
        for value in ["32.0.101", "32.0.101.9030.1", "1.2.3.4", "Driver 32.0.101.9030"] {
            assert!(parse_intel_driver_metadata(value).is_null(), "{value}");
        }
        assert_eq!(parse_intel_driver_metadata("Intel Graphics Driver 1.2.3.4 Release Date: 2026-02-30"),
            json!({"version":"1.2.3.4","releaseDate":null,"changelog":[]}));
        assert_eq!(parse_intel_driver_metadata("<meta name=\"DownloadVersion\" content=\"32.0.101.8805-PRO\"><meta name=\"lastModifieddate\" content=\"2026-09-02T00:00:00Z\">"),
            json!({"version":"32.0.101.8805","releaseDate":"2026-09-02","changelog":[]}));
        assert_eq!(parse_intel_driver_metadata("<meta name=\"DownloadVersion\" content=\"32.0.101.8805.1\">"), Value::Null);
    }

    #[test]
    fn changelog_parser_accepts_a_standalone_highlights_heading() {
        // Intel's current download pages dropped the "Detailed Description"
        // wrapper; the highlights list is a top-level section of its own.
        let release = parse_intel_driver_metadata("Intel Graphics Driver 32.0.101.9175 WHQL Certified<h3>Highlights:</h3><p>Intel Game On Driver support for:</p><ul><li>Football Manager 27*</li><li>Phantom Blade Zero*</li></ul><h3>Fixed Issues:</h3><ul><li>Not a highlight</li></ul>");
        assert_eq!(release["changelog"], json!([
            "Intel Game On Driver support for:",
            "Football Manager 27*",
            "Phantom Blade Zero*",
        ]));
    }

    #[test]
    fn changelog_parser_preserves_nested_sections_and_stops_at_support_sections() {
        let arc = parse_intel_driver_metadata("Intel Graphics Driver 32.0.101.9030<h2>Detailed Description</h2><h2>Highlights:</h2><ul>\n<li>Improved stability &amp; performance<ul><li>Updated game profile</li></ul></li>\n<li>Fixed <strong>display</strong> flicker</li>\n</ul><h2>Specifications</h2><ul><li>Not a highlight</li></ul>");
        assert_eq!(arc["changelog"], json!(["Improved stability & performance", "Updated game profile", "Fixed display flicker"]));

        let plain = parse_intel_driver_metadata("Intel Graphics Driver 32.0.101.9030<h2>Detailed Description</h2><p><strong>Highlights:</strong></p><p>Intel Game On Driver support for the latest titles, including:</p><ul><li>WARDOGS*</li><li>Nested parent<ul><li>Nested child</li></ul></li></ul><p><strong>OS Support:</strong></p><ul><li>Windows 11</li></ul>");
        assert_eq!(plain["changelog"], json!(["Intel Game On Driver support for the latest titles, including:", "WARDOGS*", "Nested parent", "Nested child"]));

        let pro = parse_intel_driver_metadata("Intel Graphics Driver 32.0.101.8805<h2>Detailed Description</h2><p><b>Highlights of this Workstation Driver:</b></p><p>New features and fixes for professional applications.</p><ul><li>Application certification updates</li></ul><p>Platform Support</p><ul><li>Windows</li></ul>");
        assert_eq!(pro["changelog"], json!(["New features and fixes for professional applications.", "Application certification updates"]));

        let sections = parse_intel_driver_metadata("Intel Graphics Driver 32.0.101.9030<h2>Detailed Description</h2><h2>Highlights:</h2><ul><li>Intel® Game On driver support on Intel® Arc\u{2122} B-series Graphics GPUs for:<ul><li>1666: Amsterdam*</li></ul></li></ul>");
        assert_eq!(sections["changelogSections"], json!([
            {"text":"Intel® Game On driver support on Intel® Arc\u{2122} B-series Graphics GPUs for:","kind":"heading","children":[
                {"text":"1666: Amsterdam*","kind":"item"}
            ]}
        ]));
    }

    #[test]
    fn changelog_ignores_decoys_and_enforces_caps() {
        let decoys = parse_intel_driver_metadata("Intel Graphics Driver 32.0.101.9030<!-- <h2>Detailed Description</h2><p>Highlights: comment decoy</p> --><script>var page = '<h2>Detailed Description</h2><p>Highlights: script decoy</p>';</script><h2>Detailed Description</h2><p><strong>Highlights:</strong></p><p>Actual driver highlights.</p><ul><li>Actual item</li></ul><h2>Other section</h2><p>Highlights: unrelated later content</p>");
        assert_eq!(decoys["changelog"], json!(["Actual driver highlights.", "Actual item"]));
        let oversized = parse_intel_driver_metadata(&format!("Intel Graphics Driver 32.0.101.9030<h2>Detailed Description</h2><h2>Highlights:</h2><ul><li>{}</li></ul>", "x".repeat(501)));
        assert_eq!(oversized["changelog"], json!([]));
        let too_many = parse_intel_driver_metadata(&format!("Intel Graphics Driver 32.0.101.9030<h2>Detailed Description</h2><h2>Highlights:</h2><ul>{}</ul>", "<li>Item</li>".repeat(21)));
        assert_eq!(too_many["changelog"], json!([]));
        let malformed = parse_intel_driver_metadata("Intel Graphics Driver 32.0.101.9030<h2>Detailed Description</h2><h2>Highlights:</h2><ul><li>Missing closing item</ul>");
        assert_eq!(malformed["changelog"], json!([]));
    }

    #[test]
    fn release_url_allowlist_rejects_host_userinfo_port_query_hash_and_wrong_slug() {
        let detail = "https://www.intel.com/content/www/us/en/download/785597/123456/intel-arc-graphics-windows.html";
        let regional_detail = "https://www.intel.cn/content/www/cn/zh/download/785597/123456/intel-arc-graphics-windows.html";
        assert!(valid_intel_driver_release_url(detail, "arc"));
        assert!(valid_intel_driver_release_url(regional_detail, "arc"));
        assert!(valid_intel_driver_release_url(ARC_HISTORICAL_PAGE_URL, "arc"));
        assert!(valid_intel_driver_release_url(ARC_REGIONAL_HISTORICAL_PAGE_URL, "arc"));
        assert!(valid_intel_driver_release_url(PRO_OFFICIAL_PAGE_URL, "pro"));
        assert!(valid_intel_driver_release_url(PRO_REGIONAL_OFFICIAL_PAGE_URL, "pro"));
        assert!(valid_intel_driver_release_url(PRO_REGIONAL_HISTORICAL_PAGE_URL, "pro"));
        assert!(valid_intel_driver_release_url("https://www.intel.com/content/www/us/en/download/741626/123456/intel-arc-pro-graphics-windows.html", "pro"));
        for value in [
            "http://www.intel.com/content/www/us/en/download/785597/123456/intel-arc-graphics-windows.html",
            "https://www.intel.com.evil.example/content/www/us/en/download/785597/123456/intel-arc-graphics-windows.html",
            "https://www.intel.com@evil.example/content/www/us/en/download/785597/123456/intel-arc-graphics-windows.html",
            "https://www.intel.com:8443/content/www/us/en/download/785597/123456/intel-arc-graphics-windows.html",
            "https://www.intel.com/content/www/us/en/download/785597/123456/intel-arc-graphics-windows.html?redirect=1",
            "https://www.intel.com/content/www/us/en/download/785597/123456/intel-arc-graphics-windows.html#x",
            "https://www.intel.com/content/www/us/en/download/999999/123456/intel-arc-graphics-windows.html",
            "https://www.intel.com/content/www/us/en/download/785597/123456/wrong.html",
            "https://evil.example/content/www/us/en/download/785597/123456/intel-arc-graphics-windows.html",
            "https://www.intel.cn/content/www/cn/zh/download/999999/123456/intel-arc-graphics-windows.html",
            "https://www.intel.cn/content/www/us/en/download/785597/123456/intel-arc-graphics-windows.html",
            "https://www.intel.cn/content/www/cn/zh/download/785597/123456/intel-arc-pro-graphics-windows.html",
            "https://www.intel.cn/content/www/cn/zh/download/785597/123456/intel-arc-graphics-windows.html?redirect=1",
        ] { assert!(!valid_intel_driver_release_url(value, "arc"), "{value}"); }
        assert!(!valid_intel_driver_release_url(detail, "pro"));
        assert!(!valid_intel_driver_release_url(detail, "other"));
        assert!(!valid_official_url(&(ARC_OFFICIAL_PAGE_URL.to_owned() + "?x=1"), ARC_OFFICIAL_PAGE_URL));
        assert!(valid_official_url(ARC_REGIONAL_OFFICIAL_PAGE_URL, ARC_REGIONAL_OFFICIAL_PAGE_URL));
        assert!(!valid_official_url("https://www.intel.cn/content/www/cn/zh/download/785597/extra.html", "https://www.intel.cn/content/www/cn/zh/download/785597/extra.html"));
    }

    fn catalog_pages() -> HashMap<String, String> {
        let detail = "https://www.intel.com/content/www/us/en/download/785597/123456/intel-arc-graphics-windows.html";
        HashMap::from([
            (ARC_OFFICIAL_PAGE_URL.to_owned(), selector(&[
                ("32.0.101.9000", "/content/www/us/en/download/785597/111111/intel-arc-graphics-windows.html"),
                ("32.0.101.8826", "/content/www/us/en/download/785597/222222/intel-arc-graphics-windows.html"),
            ], "32.0.101.9000")),
            (ARC_HISTORICAL_PAGE_URL.to_owned(), selector(&[
                ("32.0.101.8826", "/content/www/us/en/download/785597/333333/intel-arc-graphics-windows.html"),
                ("32.0.101.7000", detail),
            ], "32.0.101.8826")),
            (detail.to_owned(), "<meta name=\"DownloadVersion\" content=\"32.0.101.7000\"><p>Intel Graphics Driver 32.0.101.7000</p><div>Size: 1.25 GB</div>".to_owned()),
        ])
    }

    #[test]
    fn catalog_merges_pages_and_resolves_only_the_selected_release() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let service = IntelDriverCatalog::with_fetcher(
            fake_fetch(catalog_pages(), calls.clone()),
            fake_now(Arc::new(Mutex::new(500.0))),
        );
        assert_eq!(service.library("arc").unwrap(), json!({"versions":["32.0.101.9000","32.0.101.8826","32.0.101.7000"],"partial":false}));
        let release = service.resolve_release("arc", "32.0.101.7000").unwrap();
        assert_eq!(release["version"], "32.0.101.7000");
        assert_eq!(release["officialPageUrl"], "https://www.intel.com/content/www/us/en/download/785597/123456/intel-arc-graphics-windows.html");
        assert_eq!(release["sizeBytes"], json!((1.25f64 * 1024f64.powi(3)).round() as u64));
        let fetched = calls.lock().unwrap().clone();
        assert_eq!(fetched.iter().filter(|url| url.as_str() == "https://www.intel.com/content/www/us/en/download/785597/123456/intel-arc-graphics-windows.html").count(), 1);
        assert!(!fetched.iter().any(|url| url.contains("111111") || url.contains("222222")));
    }

    #[test]
    fn resolve_after_library_reuses_the_cached_catalog_sources() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let service = IntelDriverCatalog::with_fetcher(
            fake_fetch(catalog_pages(), calls.clone()),
            fake_now(Arc::new(Mutex::new(500.0))),
        );
        service.library("arc").unwrap();
        assert_eq!(calls.lock().unwrap().len(), 2, "a cold library fetches the official and historical pages");
        let release = service.resolve_release("arc", "32.0.101.7000").unwrap();
        assert_eq!(release["version"], "32.0.101.7000");
        let fetched = calls.lock().unwrap().clone();
        assert_eq!(fetched[2..], ["https://www.intel.com/content/www/us/en/download/785597/123456/intel-arc-graphics-windows.html"],
            "resolve must fetch only the selected detail page");
        assert_eq!(fetched.len(), 3, "no catalog page is requested twice in one window");
        assert_eq!(fetched.iter().filter(|url| *url == ARC_OFFICIAL_PAGE_URL).count(), 1);
        assert_eq!(fetched.iter().filter(|url| *url == ARC_HISTORICAL_PAGE_URL).count(), 1);
    }

    #[test]
    fn update_check_shares_its_landing_page_with_the_library() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let service = IntelDriverCatalog::with_fetcher(
            fake_fetch(catalog_pages(), calls.clone()),
            fake_now(Arc::new(Mutex::new(0.0))),
        );
        assert_eq!(service.check()["arc"]["version"], "32.0.101.9000");
        assert_eq!(calls.lock().unwrap().len(), 3, "check probes the official page of each kind plus the pro fallback");
        service.library("arc").unwrap();
        let fetched = calls.lock().unwrap().clone();
        assert_eq!(fetched.len(), 4, "the library reuses the official page check already downloaded");
        assert_eq!(fetched[3], ARC_HISTORICAL_PAGE_URL);
        assert_eq!(fetched.iter().filter(|url| *url == ARC_OFFICIAL_PAGE_URL).count(), 1);
    }

    #[test]
    fn shared_landing_page_html_never_outlives_the_sixty_second_window() {
        let now = Arc::new(Mutex::new(0.0));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let service = IntelDriverCatalog::with_fetcher(fake_fetch(catalog_pages(), calls.clone()), fake_now(now.clone()));
        service.check();
        *now.lock().unwrap() = 60_001.0;
        service.library("arc").unwrap();
        let fetched = calls.lock().unwrap().clone();
        assert_eq!(fetched.iter().filter(|url| *url == ARC_OFFICIAL_PAGE_URL).count(), 2,
            "a refresh after the 60s window downloads the page instead of reusing it");
    }

    #[test]
    fn regional_fallback_uses_only_fixed_pages_and_resolves_product_release() {
        let version = "32.0.101.7000";
        let detail = "https://www.intel.cn/content/www/cn/zh/download/785597/123456/intel-arc-graphics-windows.html";
        let mut fixtures = HashMap::from([
            (ARC_REGIONAL_OFFICIAL_PAGE_URL.to_owned(), selector(&[(version, detail)], version)),
            (detail.to_owned(), format!("<meta name=\"DownloadVersion\" content=\"{version}\"><p>Intel Graphics Driver {version}</p><div>大小&#xff1a;862.6 MB</div>")),
        ]);
        let history = format!("<meta name=\"DownloadVersion\" content=\"{version}\"><select id=\"version-driver-select\"><option value=\"https://www.intel.cn/content/www/cn/zh/download/857252/222222/historical-intel-arc-graphics-drivers.html\">Intel Graphics Driver {version}</option></select>");
        fixtures.insert(ARC_REGIONAL_HISTORICAL_PAGE_URL.to_owned(), history);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let service = IntelDriverCatalog::with_fetcher(fake_fetch(fixtures, calls.clone()), fake_now(Arc::new(Mutex::new(500.0))));
        assert_eq!(service.library("arc").unwrap(), json!({"versions":[version],"partial":false}));
        let release = service.resolve_release("arc", version).unwrap();
        assert_eq!(release["version"], version);
        assert_eq!(release["officialPageUrl"], detail);
        assert_eq!(release["sizeBytes"], json!((862.6f64 * 1024f64.powi(2)).round() as u64));
        let calls = calls.lock().unwrap();
        assert!(calls.contains(&ARC_OFFICIAL_PAGE_URL.to_owned()));
        assert!(calls.contains(&ARC_REGIONAL_OFFICIAL_PAGE_URL.to_owned()));
        assert!(!calls.iter().any(|url| url.contains("evil")));
    }

    #[test]
    fn catalog_marks_a_missing_history_source_partial() {
        let version = "32.0.101.8805";
        let pages = HashMap::from([(PRO_OFFICIAL_PAGE_URL.to_owned(), selector(&[
            (version, "/content/www/us/en/download/741626/123456/intel-arc-pro-graphics-windows.html"),
        ], version))]);
        let service = IntelDriverCatalog::with_fetcher(fake_fetch(pages, Arc::new(Mutex::new(Vec::new()))), fake_now(Arc::new(Mutex::new(0.0))));
        assert_eq!(service.library("pro").unwrap(), json!({"versions":[version],"partial":true}));
    }

    #[test]
    fn catalog_caps_versions_at_one_hundred() {
        let mut options = Vec::new();
        for index in 0..105 {
            let value = format!("/content/www/us/en/download/785597/{}/intel-arc-graphics-windows.html", 100_000 + index);
            options.push((format!("32.0.101.{index}"), value));
        }
        let option_refs: Vec<(&str, &str)> = options.iter().map(|(version, url)| (version.as_str(), url.as_str())).collect();
        let pages = HashMap::from([(ARC_OFFICIAL_PAGE_URL.to_owned(), selector(&option_refs, "32.0.101.104"))]);
        let service = IntelDriverCatalog::with_fetcher(fake_fetch(pages, Arc::new(Mutex::new(Vec::new()))), fake_now(Arc::new(Mutex::new(0.0))));
        let catalog = service.library("arc").unwrap();
        assert_eq!(catalog["versions"].as_array().unwrap().len(), 100);
        assert_eq!(catalog["partial"], true);
        assert_eq!(catalog["versions"][0], "32.0.101.0");
        assert_eq!(catalog["versions"][99], "32.0.101.99");
    }

    #[test]
    fn release_metadata_version_must_equal_the_selected_version() {
        let mut pages = catalog_pages();
        pages.insert("https://www.intel.com/content/www/us/en/download/785597/123456/intel-arc-graphics-windows.html".to_owned(),
            "<meta name=\"DownloadVersion\" content=\"32.0.101.7001\"><p>Intel Graphics Driver 32.0.101.7001</p>".to_owned());
        let service = IntelDriverCatalog::with_fetcher(fake_fetch(pages, Arc::new(Mutex::new(Vec::new()))), fake_now(Arc::new(Mutex::new(0.0))));
        assert!(service.resolve_release("arc", "32.0.101.7000").unwrap_err().contains("does not match"));
    }

    #[test]
    fn metadata_failures_use_a_bounded_negative_cache_instead_of_stale_success() {
        let now = Arc::new(Mutex::new(100_000.0));
        let calls = Arc::new(AtomicUsize::new(0));
        let fail = Arc::new(AtomicBool::new(true));
        let fetch: Arc<FetchFn> = {
            let calls = calls.clone();
            let fail = fail.clone();
            Arc::new(move |url: &str| {
                calls.fetch_add(1, Ordering::SeqCst);
                if fail.load(Ordering::SeqCst) { return Err("offline".into()); }
                let kind = if url.contains("/741626/") { "pro" } else { "arc" };
                Ok(FetchedPage { body: page(if kind == "pro" { "32.0.101.8805" } else { "32.0.101.9030" }, ""), url: url.to_owned() })
            })
        };
        let service = IntelDriverCatalog::with_fetcher(fetch, fake_now(now.clone()));
        assert_eq!(service.check(), json!({"arc":null,"pro":null}));
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        assert_eq!(service.check(), json!({"arc":null,"pro":null}));
        assert_eq!(calls.load(Ordering::SeqCst), 4, "the negative backoff suppresses a retry");
        *now.lock().unwrap() = 161_000.0;
        fail.store(false, Ordering::SeqCst);
        let recovered = service.check();
        assert_eq!(recovered["arc"]["version"], "32.0.101.9030");
        assert_eq!(recovered["pro"]["version"], "32.0.101.8805");
        assert_eq!(calls.load(Ordering::SeqCst), 6);
        *now.lock().unwrap() = 200_000.0;
        assert_eq!(service.check()["arc"]["version"], "32.0.101.9030");
        assert_eq!(calls.load(Ordering::SeqCst), 6, "fresh success stays cached");
        *now.lock().unwrap() = 1_200_000.0;
        assert_eq!(service.check()["arc"]["version"], "32.0.101.9030");
        assert_eq!(calls.load(Ordering::SeqCst), 8, "the 15-minute success cache expires");
    }

    #[test]
    fn catalog_caches_full_results_for_fifteen_minutes_and_partials_for_sixty_seconds() {
        let now = Arc::new(Mutex::new(0.0));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let service = IntelDriverCatalog::with_fetcher(fake_fetch(catalog_pages(), calls.clone()), fake_now(now.clone()));
        assert_eq!(service.library("arc").unwrap()["versions"].as_array().unwrap().len(), 3);
        service.library("arc").unwrap();
        assert_eq!(calls.lock().unwrap().len(), 2, "a full catalog is cached");
        *now.lock().unwrap() = 14.0 * 60.0 * 1000.0;
        service.library("arc").unwrap();
        assert_eq!(calls.lock().unwrap().len(), 2);
        *now.lock().unwrap() = 15.0 * 60.0 * 1000.0 + 1.0;
        service.library("arc").unwrap();
        assert_eq!(calls.lock().unwrap().len(), 4, "the full catalog TTL expires");

        let partial_now = Arc::new(Mutex::new(0.0));
        let partial_calls = Arc::new(Mutex::new(Vec::new()));
        let version = "32.0.101.8805";
        let pages = HashMap::from([(PRO_OFFICIAL_PAGE_URL.to_owned(), selector(&[
            (version, "/content/www/us/en/download/741626/123456/intel-arc-pro-graphics-windows.html"),
        ], version))]);
        let partial = IntelDriverCatalog::with_fetcher(fake_fetch(pages, partial_calls.clone()), fake_now(partial_now.clone()));
        assert_eq!(partial.library("pro").unwrap(), json!({"versions":[version],"partial":true}));
        partial.library("pro").unwrap();
        assert_eq!(partial_calls.lock().unwrap().len(), 3, "a partial catalog is cached");
        *partial_now.lock().unwrap() = 59_999.0;
        partial.library("pro").unwrap();
        assert_eq!(partial_calls.lock().unwrap().len(), 3);
        *partial_now.lock().unwrap() = 60_001.0;
        partial.library("pro").unwrap();
        assert_eq!(partial_calls.lock().unwrap().len(), 6, "the partial catalog TTL is 60s");
    }

    #[test]
    fn concurrent_catalog_calls_share_one_fetch_pair() {
        let calls = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let fetch: Arc<FetchFn> = {
            let calls = calls.clone();
            let gate = gate.clone();
            Arc::new(move |url: &str| {
                calls.fetch_add(1, Ordering::SeqCst);
                if url == ARC_OFFICIAL_PAGE_URL {
                    let mut released = gate.0.lock().unwrap();
                    *released = true;
                    gate.1.notify_all();
                    while *released { released = gate.1.wait(released).unwrap(); }
                }
                let body = if url == ARC_OFFICIAL_PAGE_URL || url == ARC_HISTORICAL_PAGE_URL {
                    selector(&[("32.0.101.9000", "/content/www/us/en/download/785597/111111/intel-arc-graphics-windows.html")], "32.0.101.9000")
                } else { String::new() };
                Ok(FetchedPage { body, url: url.to_owned() })
            })
        };
        let service = Arc::new(IntelDriverCatalog::with_fetcher(fetch, fake_now(Arc::new(Mutex::new(0.0)))));
        let first = { let service = service.clone(); std::thread::spawn(move || service.library("arc").unwrap()) };
        {
            let mut released = gate.0.lock().unwrap();
            while !*released { released = gate.1.wait(released).unwrap(); }
            *released = false;
            gate.1.notify_all();
        }
        let second = { let service = service.clone(); std::thread::spawn(move || service.library("arc").unwrap()) };
        std::thread::sleep(Duration::from_millis(120));
        {
            let mut released = gate.0.lock().unwrap();
            *released = true;
            gate.1.notify_all();
        }
        let first = first.join().unwrap();
        let second = second.join().unwrap();
        assert_eq!(first, second);
        assert_eq!(calls.load(Ordering::SeqCst), 2, "the waiter must not start a second two-page fetch");
    }

    #[test]
    fn production_transport_constructs_the_blocking_worker_without_network() {
        let catalog = IntelDriverCatalog::new().expect("reqwest blocking client should initialize");
        drop(catalog);
    }

    #[test]
    fn metadata_body_cap_and_redirected_response_url_are_rejected() {
        let oversized: Arc<FetchFn> = Arc::new(|url: &str| Ok(FetchedPage { body: "x".repeat(MAX_METADATA_RESPONSE_BYTES + 1), url: url.to_owned() }));
        let service = IntelDriverCatalog::with_fetcher(oversized, fake_now(Arc::new(Mutex::new(0.0))));
        assert_eq!(service.check(), json!({"arc":null,"pro":null}));

        let redirected: Arc<FetchFn> = Arc::new(|_url: &str| Ok(FetchedPage {
            body: page("32.0.101.9030", ""), url: "https://www.intel.com/evil".to_owned(),
        }));
        let service = IntelDriverCatalog::with_fetcher(redirected, fake_now(Arc::new(Mutex::new(0.0))));
        assert_eq!(service.check(), json!({"arc":null,"pro":null}));
    }

    #[test]
    fn download_status_is_lstat_only_and_never_creates_directories() {
        let root = std::env::temp_dir().join(format!("arc-intel-status-test-{:032x}", rand::random::<u128>()));
        fs::create_dir(&root).unwrap();
        let version = "32.0.101.9030";
        assert_eq!(driver_download_status(&root, "arc", version), json!({"downloaded":false,"sizeBytes":null}));
        assert!(!root.join("DriverDownloads").exists(), "status must not create the download tree");
        let target = root.join("DriverDownloads").join("arc").join(version).join(DOWNLOAD_FILE_NAME);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, [0x4d, 0x5a, 1, 2]).unwrap();
        assert_eq!(driver_download_status(&root, "arc", version), json!({"downloaded":true,"sizeBytes":4}));
        fs::remove_file(&target).unwrap();
        fs::create_dir(&target).unwrap();
        assert_eq!(driver_download_status(&root, "arc", version), json!({"downloaded":false,"sizeBytes":null}));
        fs::remove_dir(&target).unwrap();
        assert_eq!(driver_download_status(&root, "pro", version), json!({"downloaded":false,"sizeBytes":null}));
        assert_eq!(driver_download_status(&root, "arc", "../escape"), json!({"downloaded":false,"sizeBytes":null}));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn page_open_validation_rejects_every_non_intel_url_before_shelling_out() {
        assert_eq!(official_download_page("arc").unwrap(), ARC_OFFICIAL_PAGE_URL);
        assert_eq!(official_download_page("pro").unwrap(), PRO_OFFICIAL_PAGE_URL);
        assert!(official_download_page("other").is_err());
        for url in [
            "https://www.intel.com/evil",
            "https://evil.example/content/www/us/en/download/785597/123456/intel-arc-graphics-windows.html",
            "http://www.intel.com/content/www/us/en/download/785597/123456/intel-arc-graphics-windows.html",
            "https://www.intel.com/content/www/us/en/download/785597/123456/intel-arc-graphics-windows.html?x=1",
        ] { assert!(open_download_page(url, "arc").is_err(), "{url}"); }
    }
}


