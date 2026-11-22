//! Native port of `src/main/intel-driver-download.js` for the remaining driver
//! channels: download, cancel, delete and install. The Phase 1 metadata and
//! catalog logic stays in `intel_driver_catalog.rs`.
//!
//! Safety boundaries:
//! - the renderer supplies only kind/version; every filesystem path is fixed;
//! - pages and mirror URLs are allowlisted exactly, and redirects are manual,
//!   revalidated at every hop, capped at five, and the final URL is rechecked;
//! - the page is capped at 2 MiB / 20s and the installer at 2 GiB / 30min;
//! - bytes are hashed while streaming, the `.part` file must start with `MZ`,
//!   and only a verified file is renamed into its final path;
//! - the installer is spawned detached with no arguments and no
//!   `CREATE_NO_WINDOW`, then the whole app is asked to quit.
use super::intel_driver_catalog::{self, INTEL_FETCH_USER_AGENT};
use super::store_file::{atomic_replace, reject_reparse_components};
use serde_json::{json, Value};
use sha2::{Digest, Sha256, Sha512};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{mpsc, Arc, Condvar, Mutex, OnceLock},
    time::{Duration, Instant},
};
use url::Url;

pub const PROGRESS_CHANNEL: &str = "intel-driver-download:progress";
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_PAGE_BYTES: usize = 2 * 1024 * 1024;
const PAGE_TIMEOUT: Duration = Duration::from_secs(20);
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MAX_REDIRECTS: usize = 5;
const DOWNLOAD_FILE_NAME: &str = "gfx_win_101.exe";
const QUIESCE_MESSAGE: &str = "driver downloads are paused for Arc Power maintenance";
const OPERATION_ACTIVE: &str = "a driver operation is already active for this driver kind";
const DOWNLOAD_ACTIVE: &str = "a download is already active for this driver kind";
const INSTALL_BLOCKED: &str = "a download or deletion is already active for this driver kind";
const INSTALL_ACTIVE: &str = "a driver install is already active for this driver kind";
const DELETE_ACTIVE: &str = "cannot delete a driver download while a driver operation is active";
const DELETE_REGULAR: &str = "Intel driver download is not a regular file";
const INSTALL_UNVERIFIED: &str = "Saved Intel driver could not be verified. Download it again.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HashAlgorithm { Sha256, Sha512 }

impl HashAlgorithm {
    fn from_label(value: &str) -> Option<Self> {
        match value { "256" => Some(Self::Sha256), "512" => Some(Self::Sha512), _ => None }
    }
}
enum Hasher { Sha256(Sha256), Sha512(Sha512) }
impl Hasher {
    fn new(algorithm: HashAlgorithm) -> Self {
        match algorithm { HashAlgorithm::Sha256 => Self::Sha256(Sha256::new()), HashAlgorithm::Sha512 => Self::Sha512(Sha512::new()) }
    }
    fn update(&mut self, bytes: &[u8]) {
        match self { Self::Sha256(hasher) => hasher.update(bytes), Self::Sha512(hasher) => hasher.update(bytes) }
    }
    fn finish(self) -> String {
        let bytes = match self { Self::Sha256(hasher) => hasher.finalize().to_vec(), Self::Sha512(hasher) => hasher.finalize().to_vec() };
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DownloadPage {
    pub version: String,
    pub url: String,
    pub size_bytes: u64,
    pub size_tolerance_bytes: u64,
    pub algorithm: HashAlgorithm,
    pub digest: String,
}

fn valid_kind(kind: &str) -> bool { matches!(kind, "arc" | "pro") }

fn attr_value(tag: &str, name: &str) -> Option<String> {
    let escaped = regex::Regex::new(r"([.*+?^${}()|\[\]\\])").unwrap().replace_all(name, r"\$1").into_owned();
    for quote in ['"', '\''] {
        let pattern = format!(r#"(?i)\b{}\s*=\s*{quote}([^{quote}]*){}"#, escaped, quote);
        if let Some(captures) = regex::Regex::new(&pattern).ok().and_then(|regex| regex.captures(tag)) {
            return captures.get(1).map(|value| value.as_str().to_owned());
        }
    }
    None
}

fn meta_attribute(source: &str, name: &str) -> Option<String> {
    let tags = regex::Regex::new(r"(?is)<meta\b[^>]*>").unwrap();
    for tag in tags.find_iter(source) {
        if attr_value(tag.as_str(), "name").is_some_and(|value| value.eq_ignore_ascii_case(name)) {
            return attr_value(tag.as_str(), "content");
        }
    }
    None
}

fn safe_url(value: &str, hosts: &[&str]) -> bool {
    let Ok(url) = Url::parse(value) else { return false; };
    url.scheme() == "https"
        && url.host_str().is_some_and(|host| hosts.iter().any(|candidate| host.eq_ignore_ascii_case(candidate)))
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

pub fn valid_mirror_url(value: &str) -> bool {
    if !safe_url(value, &["downloadmirror.intel.com"]) { return false; }
    let Ok(url) = Url::parse(value) else { return false; };
    regex::Regex::new(r"^/\d+/gfx_win_101\.\d+\.exe$").unwrap().is_match(url.path())
}

/// Redirect hops may use either fixed official Intel hostname, but still may
/// not add userinfo, a port, query, hash, or another scheme/host.
pub fn valid_www_intel_url(value: &str) -> bool { safe_url(value, &["www.intel.com", "www.intel.cn"]) }

fn redirect_target(current: &str, location: &str, validator: impl Fn(&str) -> bool) -> Result<String, String> {
    let base = Url::parse(current).map_err(|_| "Intel redirect base URL is invalid".to_owned())?;
    let next = base.join(location).map_err(|_| "Intel redirect location is invalid".to_owned())?;
    if !validator(next.as_str()) { return Err("Intel redirected outside the allowlist".into()); }
    Ok(next.to_string())
}

fn normalized_href(href: &str) -> String { href.replace("&amp;", "&") }

fn extract_size(source: &str) -> Option<(f64, f64, u32)> {
    let regex = regex::Regex::new(r"(?i)\bSize\b\s*:?\s*(?:<[^>]*>\s*)*(\d+(?:\.\d+)?)\s*(GB|MB|KB|bytes?)\b").ok()?;
    let captures = regex.captures(source)?;
    let value = captures.get(1)?.as_str().parse::<f64>().ok()?;
    let unit = captures.get(2)?.as_str().to_ascii_lowercase();
    let multiplier = if unit.starts_with('g') { 1024f64.powi(3) } else if unit.starts_with('m') { 1024f64.powi(2) } else if unit.starts_with('k') { 1024.0 } else { 1.0 };
    let decimals = captures.get(1)?.as_str().split('.').nth(1).map(|part| part.len() as u32).unwrap_or(0);
    Some((value, multiplier, decimals))
}

fn extract_regional_size(source: &str) -> Option<(f64, f64, u32)> {
    let text = intel_driver_catalog::decode_html_text(source);
    let regex = regex::Regex::new(r"(?i)(?:文件大小|大小)\s*[:：]\s*(\d+(?:\.\d+)?)\s*(GB|MB|KB|bytes?)\b").ok()?;
    let captures = regex.captures(&text)?;
    let value_text = captures.get(1)?.as_str();
    let value = value_text.parse::<f64>().ok()?;
    let unit = captures.get(2)?.as_str().to_ascii_lowercase();
    let multiplier = if unit.starts_with('g') { 1024f64.powi(3) } else if unit.starts_with('m') { 1024f64.powi(2) } else if unit.starts_with('k') { 1024.0 } else { 1.0 };
    let decimals = value_text.split('.').nth(1).map(|part| part.len() as u32).unwrap_or(0);
    Some((value, multiplier, decimals))
}

/// Exact `parseIntelDownloadPage` rules, including the mandatory size and
/// digest fields and the installer-name/version cross-check.
pub fn parse_intel_download_page(source: &str, kind: &str) -> Result<DownloadPage, String> {
    parse_intel_download_page_inner(source, kind, None)
}

/// Parse a selected detail page after its fixed product URL has been checked.
/// The localized labels and quarter suffix are accepted only for Intel's four
/// fixed `www.intel.cn` Arc/Arc Pro roots and their numeric detail pages.
pub fn parse_intel_download_page_for_url(source: &str, kind: &str, page_url: &str) -> Result<DownloadPage, String> {
    if !intel_driver_catalog::valid_intel_driver_release_url(page_url, kind) {
        return Err("Intel release page is not valid".into());
    }
    let regional = Url::parse(page_url).ok().is_some_and(|url| url.host_str() == Some("www.intel.cn"));
    parse_intel_download_page_inner(source, kind, Some((page_url, regional)))
}

fn parse_intel_download_page_inner(source: &str, kind: &str, page: Option<(&str, bool)>) -> Result<DownloadPage, String> {
    if !valid_kind(kind) { return Err("invalid kind".into()); }
    let regional = page.is_some_and(|(_, regional)| regional);
    let version_text = meta_attribute(source, "DownloadVersion").unwrap_or_default();
    let version_pattern = if regional {
        r"(?i)^(\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5})(?:(?:\s+-\s+Q\d{1,2}\.\d{2}(?:\.R\d+)?)|(?:(?:\s+-\s+|\s+)(?:WHQL(?:\s+Certified)?|Non-WHQL|Beta)))?$"
    } else {
        r"(?i)^(\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5})(?:(?:\s+-\s+Q\d{1,2}\.\d{2}\.R\d+)|(?:(?:\s+-\s+|\s+)(?:WHQL(?:\s+Certified)?|Non-WHQL|Beta)))?$"
    };
    let version_match = regex::Regex::new(version_pattern).unwrap().captures(version_text.trim());
    let Some(version) = version_match.and_then(|captures| captures.get(1)).map(|value| value.as_str().to_owned()) else {
        return Err("Intel release page has an invalid driver version".into());
    };
    let mut hrefs = Vec::new();
    if kind == "pro" || regional {
        if let Some(recommended) = meta_attribute(source, "RecommendedDownloadUrl") { hrefs.push(normalized_href(&recommended)); }
    }
    let links = regex::Regex::new(r#"(?i)\b(?:data-href|href)\s*=\s*(?:"([^"]*)"|'([^']*)')"#).unwrap();
    for captures in links.captures_iter(source) {
        if let Some(value) = captures.get(1).or_else(|| captures.get(2)) { hrefs.push(normalized_href(value.as_str())); }
    }
    let base_url = if let Some((page_url, true)) = page { page_url } else {
        match kind { "arc" => intel_driver_catalog::ARC_OFFICIAL_PAGE_URL, _ => intel_driver_catalog::PRO_OFFICIAL_PAGE_URL }
    };
    let base = Url::parse(base_url).map_err(|_| "Intel official page URL is invalid".to_owned())?;
    let url = hrefs.iter().filter_map(|href| base.join(href).ok()).find(|url| valid_mirror_url(url.as_str()))
        .ok_or("Intel release page has no valid installer link")?;
    let installer = url.path().rsplit('/').next().unwrap_or("");
    let installer_match = regex::Regex::new(r"(?i)^gfx_win_101\.(\d+)\.exe$").unwrap().captures(installer);
    let installer_digits = installer_match.and_then(|captures| captures.get(1)).map(|value| value.as_str().to_owned())
        .ok_or("Intel release page has no valid installer link")?;
    let expected_digits = version.rsplit('.').next().unwrap_or("");
    if installer_digits != expected_digits { return Err("Intel installer link version does not match the page version".into()); }
    let size_info = if regional { extract_regional_size(source).or_else(|| extract_size(source)) } else { extract_size(source) };
    let Some((size_value, multiplier, decimals)) = size_info else {
        return Err("Intel release page has no valid installer size".into());
    };
    let size_bytes = (size_value * multiplier).round();
    if !size_bytes.is_finite() || size_bytes <= 0.0 || size_bytes > MAX_FILE_BYTES as f64 {
        return Err("Intel installer size is outside the allowed limit".into());
    }
    let size_tolerance_bytes = 1024f64.max((multiplier * 0.5 * 10f64.powi(-(decimals as i32))).ceil()) as u64;
    let (sha_source, sha_pattern) = if regional {
        (intel_driver_catalog::decode_html_text(source), r"(?i)\bSHA\s*[- ]?(256|512)\s*[:：]\s*([a-f\d]+)\b")
    } else {
        (source.to_owned(), r"(?i)\bSHA\s*[- ]?(256|512)\b\s*:?\s*(?:<[^>]*>\s*)*([a-f\d]{128}|[a-f\d]{64})")
    };
    let sha = regex::Regex::new(sha_pattern).unwrap().captures(&sha_source)
        .ok_or("Intel release page has no valid SHA256 or SHA512 digest")?;
    let label = sha.get(1).map(|value| value.as_str()).ok_or("Intel release page has no valid SHA256 or SHA512 digest")?;
    let algorithm = HashAlgorithm::from_label(label).ok_or("Intel release page has no valid SHA256 or SHA512 digest")?;
    let digest = sha.get(2).map(|value| value.as_str().to_ascii_lowercase()).ok_or("Intel release page has no valid SHA256 or SHA512 digest")?;
    let expected_length = match algorithm { HashAlgorithm::Sha256 => 64, HashAlgorithm::Sha512 => 128 };
    if digest.len() != expected_length { return Err("Intel digest length is invalid".into()); }
    Ok(DownloadPage {
        version,
        url: url.to_string(),
        size_bytes: size_bytes as u64,
        size_tolerance_bytes,
        algorithm,
        digest,
    })
}

#[derive(Clone, Debug)]
pub struct DownloadReport {
    pub final_url: String,
    pub content_length: Option<u64>,
    pub bytes: u64,
}

/// Network seam. Production performs manual redirects and streaming on a plain
/// worker thread; tests inject pages, chunks, failures and cancellation.
pub trait DownloadSource: Send + Sync {
    fn fetch_page(&self, url: &str) -> Result<String, String>;
    fn download(
        &self,
        url: &str,
        cancel: Arc<std::sync::atomic::AtomicBool>,
        on_start: &mut dyn FnMut(Option<u64>) -> Result<(), String>,
        on_chunk: &mut dyn FnMut(&[u8]) -> Result<(), String>,
    ) -> Result<DownloadReport, String>;
}

#[derive(Clone, Debug)]
pub struct ResolvedRelease { pub official_page_url: String }
pub trait ReleaseResolver: Send + Sync {
    fn resolve(&self, kind: &str, version: &str) -> Result<ResolvedRelease, String>;
}
pub trait InstallerSpawner: Send + Sync {
    fn spawn(&self, executable: &Path) -> Result<(), String>;
}

enum StreamMessage {
    Start { content_length: Option<u64> },
    Chunk(Vec<u8>),
    End { final_url: String, content_length: Option<u64>, bytes: u64 },
    Error(String),
}

pub struct ReqwestSource;

impl DownloadSource for ReqwestSource {
    fn fetch_page(&self, url: &str) -> Result<String, String> {
        let (sender, receiver) = mpsc::sync_channel(1);
        let url = url.to_owned();
        std::thread::Builder::new().name("arc-intel-page".into()).spawn(move || {
            let _ = sender.send(fetch_page_blocking(&url));
        }).map_err(|error| format!("Intel page worker unavailable: {error}"))?;
        receiver.recv().map_err(|_| "Intel page worker stopped before replying".to_owned())?
    }

    fn download(
        &self,
        url: &str,
        cancel: Arc<std::sync::atomic::AtomicBool>,
        on_start: &mut dyn FnMut(Option<u64>) -> Result<(), String>,
        on_chunk: &mut dyn FnMut(&[u8]) -> Result<(), String>,
    ) -> Result<DownloadReport, String> {
        let (sender, receiver) = mpsc::sync_channel::<StreamMessage>(8);
        let worker_url = url.to_owned();
        std::thread::Builder::new().name("arc-intel-download".into()).spawn(move || {
            if let Err(error) = stream_download_blocking(&worker_url, &cancel, &sender) {
                let _ = sender.send(StreamMessage::Error(error));
            }
        }).map_err(|error| format!("Intel download worker unavailable: {error}"))?;
        loop {
            match receiver.recv().map_err(|_| "Intel download stream ended unexpectedly".to_owned())? {
                StreamMessage::Start { content_length: declared } => on_start(declared)?,
                StreamMessage::Chunk(chunk) => on_chunk(&chunk)?,
                StreamMessage::End { final_url, content_length: declared, bytes: reported } => {
                    return Ok(DownloadReport { final_url, content_length: declared, bytes: reported });
                }
                StreamMessage::Error(error) => return Err(error),
            }
        }
    }
}

fn build_client(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .user_agent(INTEL_FETCH_USER_AGENT)
        .build().map_err(|error| format!("Intel request client unavailable: {error}"))
}

fn fetch_page_blocking(url: &str) -> Result<String, String> {
    if !intel_driver_catalog::valid_intel_driver_release_url(url, "arc")
        && !intel_driver_catalog::valid_intel_driver_release_url(url, "pro") {
        return Err("Intel release page is not valid".into());
    }
    let client = build_client(PAGE_TIMEOUT)?;
    let expected = Url::parse(url).map_err(|_| "Intel release page is not valid".to_owned())?;
    let expected_host = expected.host_str().ok_or("Intel release page is not valid")?.to_owned();
    let mut current = url.to_owned();
    for hop in 0..=MAX_REDIRECTS {
        let response = client.get(&current).send().map_err(|error| format!("Intel release page request failed: {error}"))?;
        if response.status().is_redirection() {
            let location = response.headers().get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok()).map(str::to_owned)
                .ok_or("Intel release page redirect had no location")?;
            if hop == MAX_REDIRECTS { return Err("too many or invalid Intel redirects".into()); }
            current = redirect_target(&current, &location, |value| {
                valid_www_intel_url(value) && Url::parse(value).ok().is_some_and(|target| target.host_str() == Some(expected_host.as_str()))
            })?;
            continue;
        }
        if !response.status().is_success() { return Err(format!("Intel request failed ({})", response.status().as_u16())); }
        let final_url = response.url().to_string();
        if Url::parse(&final_url).ok().as_ref() != Some(&expected) { return Err("Intel release page URL changed".into()); }
        let declared = response.headers().get(reqwest::header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok()).and_then(|value| value.parse::<u64>().ok());
        if declared.is_some_and(|length| length > MAX_PAGE_BYTES as u64) { return Err("Intel release page is too large".into()); }
        let mut body = Vec::new();
        response.take(MAX_PAGE_BYTES as u64 + 1).read_to_end(&mut body)
            .map_err(|error| format!("Intel release page could not be read: {error}"))?;
        if body.len() > MAX_PAGE_BYTES { return Err("Intel release page is too large".into()); }
        return String::from_utf8(body).map_err(|_| "Intel release page was not UTF-8".to_owned());
    }
    Err("too many Intel redirects".into())
}

fn stream_download_blocking(
    url: &str,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
    sender: &mpsc::SyncSender<StreamMessage>,
) -> Result<(), String> {
    if !valid_mirror_url(url) { return Err("Intel download URL is not allowed".into()); }
    let client = build_client(TRANSFER_TIMEOUT)?;
    let mut current = url.to_owned();
    for hop in 0..=MAX_REDIRECTS {
        let response = client.get(&current).send().map_err(|error| format!("Intel download request failed: {error}"))?;
        if response.status().is_redirection() {
            let location = response.headers().get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok()).map(str::to_owned)
                .ok_or("Intel download redirect had no location")?;
            if hop == MAX_REDIRECTS { return Err("too many or invalid Intel redirects".into()); }
            current = redirect_target(&current, &location, valid_mirror_url)?;
            continue;
        }
        if !response.status().is_success() { return Err(format!("Intel request failed ({})", response.status().as_u16())); }
        let final_url = response.url().to_string();
        if !valid_mirror_url(&final_url) { return Err("Intel redirected outside the allowlist".into()); }
        let declared = response.headers().get(reqwest::header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| if value.is_empty() { None } else { value.parse::<u64>().ok() });
        if declared.is_some_and(|length| length == 0 || length > MAX_FILE_BYTES) {
            return Err("download content length does not match Intel page size".into());
        }
        sender.send(StreamMessage::Start { content_length: declared }).map_err(|_| "Intel download receiver stopped".to_owned())?;
        let mut reader = response;
        let mut buffer = [0u8; 64 * 1024];
        let mut bytes = 0u64;
        loop {
            if cancel.load(std::sync::atomic::Ordering::SeqCst) { return Err("Intel download cancelled".into()); }
            let read = reader.read(&mut buffer).map_err(|error| format!("Intel download stream failed: {error}"))?;
            if read == 0 { break; }
            bytes += read as u64;
            if bytes > MAX_FILE_BYTES || declared.is_some_and(|length| bytes > length) {
                return Err("Intel download exceeded declared size".into());
            }
            sender.send(StreamMessage::Chunk(buffer[..read].to_vec())).map_err(|_| "Intel download receiver stopped".to_owned())?;
        }
        if declared.is_some_and(|length| bytes != length) { return Err("Intel download size does not match release page".into()); }
        sender.send(StreamMessage::End { final_url, content_length: declared, bytes }).map_err(|_| "Intel download receiver stopped".to_owned())?;
        return Ok(());
    }
    Err("too many Intel redirects".into())
}

struct CatalogReleases;
impl ReleaseResolver for CatalogReleases {
    fn resolve(&self, kind: &str, version: &str) -> Result<ResolvedRelease, String> {
        let release = intel_driver_catalog::IntelDriverCatalog::shared()?.resolve_release(kind, version)?;
        let official_page_url = release.get("officialPageUrl").and_then(Value::as_str)
            .ok_or("Intel release page is not valid")?.to_owned();
        Ok(ResolvedRelease { official_page_url })
    }
}

struct SystemSpawner;
impl InstallerSpawner for SystemSpawner {
    fn spawn(&self, executable: &Path) -> Result<(), String> {
        let mut command = Command::new(executable);
        command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Node's `detached: true` maps to DETACHED_PROCESS. Do not add
            // CREATE_NO_WINDOW: the installer owns its own windows.
            command.creation_flags(0x0000_0008);
        }
        command.spawn().map(|_| ()).map_err(spawn_error)
    }
}

fn spawn_error(error: std::io::Error) -> String {
    if error.raw_os_error() == Some(740) {
        format!("Cannot start the Intel driver installer: ERROR_ELEVATION_REQUIRED (740): {error}")
    } else {
        format!("Cannot start the Intel driver installer: {error}")
    }
}

#[derive(Clone)]
struct Transfer {
    cancel: Arc<std::sync::atomic::AtomicBool>,
    reason: Arc<Mutex<Option<String>>>,
    settled: Arc<(Mutex<bool>, Condvar)>,
}
impl Transfer {
    fn new() -> Self {
        Self {
            cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            reason: Arc::new(Mutex::new(None)),
            settled: Arc::new((Mutex::new(false), Condvar::new())),
        }
    }
    fn cancel(&self, reason: &str) {
        if let Ok(mut slot) = self.reason.lock() { *slot = Some(reason.to_owned()); }
        self.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    fn reason(&self) -> Option<String> { self.reason.lock().ok().and_then(|reason| reason.clone()) }
    fn settle(&self) {
        let (lock, ready) = &*self.settled;
        if let Ok(mut settled) = lock.lock() { *settled = true; ready.notify_all(); }
    }
    fn wait(&self, timeout: Duration) -> Result<(), String> {
        let (lock, ready) = &*self.settled;
        let settled = lock.lock().map_err(|_| "Intel download transfer lock was poisoned")?;
        if *settled { return Ok(()); }
        let (settled, result) = ready.wait_timeout(settled, timeout).map_err(|_| "Intel download transfer lock was poisoned")?;
        if result.timed_out() && !*settled { return Err("Intel driver download did not stop before maintenance".into()); }
        Ok(())
    }
}

struct State {
    quiescing: bool,
    transfers: HashMap<String, Transfer>,
    installs: HashSet<String>,
    deletions: HashSet<String>,
}

struct Inner {
    root: PathBuf,
    source: Arc<dyn DownloadSource>,
    releases: Arc<dyn ReleaseResolver>,
    spawner: Arc<dyn InstallerSpawner>,
    quit: Arc<dyn Fn() + Send + Sync>,
    state: Mutex<State>,
}

#[derive(Clone)]
pub struct IntelDriverDownloadService { inner: Arc<Inner> }

pub type QuitHook = Arc<dyn Fn() + Send + Sync>;
pub type EmitHook = Arc<dyn Fn(&str, Value) + Send + Sync>;
static EMIT_HOOK: OnceLock<EmitHook> = OnceLock::new();
static QUIT_HOOK: OnceLock<QuitHook> = OnceLock::new();
static SHARED: OnceLock<Result<IntelDriverDownloadService, String>> = OnceLock::new();

pub fn set_runtime_hooks(emit: EmitHook, quit: QuitHook) -> Result<(), String> {
    EMIT_HOOK.set(emit).map_err(|_| "Intel driver progress hook is already set")?;
    QUIT_HOOK.set(quit).map_err(|_| "Intel driver quit hook is already set")?;
    Ok(())
}

pub fn runtime_emit(channel: &str, payload: Value) {
    if let Some(hook) = EMIT_HOOK.get() { hook(channel, payload); }
}

fn runtime_quit() {
    if let Some(hook) = QUIT_HOOK.get() { hook(); }
}

impl IntelDriverDownloadService {
    pub fn production(root: PathBuf) -> Result<Self, String> {
        let quit: QuitHook = Arc::new(runtime_quit);
        Self::with_seams(root, Arc::new(ReqwestSource), Arc::new(CatalogReleases), Arc::new(SystemSpawner), quit)
    }

    pub fn with_seams(
        root: PathBuf,
        source: Arc<dyn DownloadSource>,
        releases: Arc<dyn ReleaseResolver>,
        spawner: Arc<dyn InstallerSpawner>,
        quit: QuitHook,
    ) -> Result<Self, String> {
        if !root.is_absolute() { return Err("Intel driver root must be an absolute path".into()); }
        reject_reparse_components(&root).map_err(|error| format!("Intel driver root is unsafe: {error}"))?;
        Ok(Self { inner: Arc::new(Inner {
            root, source, releases, spawner, quit,
            state: Mutex::new(State { quiescing: false, transfers: HashMap::new(), installs: HashSet::new(), deletions: HashSet::new() }),
        }) })
    }

    /// Process-wide production service. The fixed root comes from NativeStore.
    pub fn shared(root: &Path) -> Result<&'static IntelDriverDownloadService, String> {
        match SHARED.get_or_init(|| Self::production(root.to_path_buf())) {
            Ok(service) => Ok(service),
            Err(error) => Err(error.clone()),
        }
    }

    pub fn quiesce_shared(root: &Path, timeout: Duration) -> Result<Value, String> { Self::shared(root)?.quiesce(timeout) }
    pub fn resume_shared(root: &Path) -> Result<(), String> { Self::shared(root)?.resume(); Ok(()) }

    fn target(&self, kind: &str, version: &str) -> PathBuf {
        self.inner.root.join("DriverDownloads").join(kind).join(version).join(DOWNLOAD_FILE_NAME)
    }
    fn partial(&self, kind: &str, version: &str) -> PathBuf {
        self.target(kind, version).with_file_name(format!("{DOWNLOAD_FILE_NAME}.part"))
    }

    fn resolve_page(&self, kind: &str, version: &str) -> Result<DownloadPage, String> {
        let release = self.inner.releases.resolve(kind, version)?;
        if !intel_driver_catalog::valid_intel_driver_release_url(&release.official_page_url, kind) {
            return Err("Intel release page is not valid".into());
        }
        let html = self.inner.source.fetch_page(&release.official_page_url)?;
        if html.len() > MAX_PAGE_BYTES { return Err("Intel release page is too large".into()); }
        let page = parse_intel_download_page_for_url(&html, kind, &release.official_page_url)?;
        if page.version != version { return Err("Intel release version no longer matches expected version".into()); }
        Ok(page)
    }

    pub fn start_download(&self, kind: &str, version: &str, on_progress: &mut dyn FnMut(Value)) -> Result<Value, String> {
        if !valid_kind(kind) { return Err("invalid kind".into()); }
        if !intel_driver_catalog::is_full_driver_version(version) { return Err("invalid Intel driver version".into()); }
        let transfer = Transfer::new();
        {
            let mut state = self.inner.state.lock().map_err(|_| "Intel driver state lock was poisoned")?;
            if state.quiescing { return Err(QUIESCE_MESSAGE.into()); }
            if state.installs.contains(kind) || state.deletions.contains(kind) { return Err(OPERATION_ACTIVE.into()); }
            if state.transfers.contains_key(kind) { return Err(DOWNLOAD_ACTIVE.into()); }
            state.transfers.insert(kind.to_owned(), transfer.clone());
        }
        let result = self.download_locked(kind, version, &transfer, on_progress);
        if let Ok(mut state) = self.inner.state.lock() { state.transfers.remove(kind); }
        transfer.settle();
        result
    }

    fn download_locked(&self, kind: &str, version: &str, transfer: &Transfer, on_progress: &mut dyn FnMut(Value)) -> Result<Value, String> {
        let target = self.target(kind, version);
        let partial = self.partial(kind, version);
        assert_safe_path(&target, true)?;
        let page = self.resolve_page(kind, version)?;
        if transfer.cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(transfer.reason().unwrap_or_else(|| "Intel download cancelled".into()));
        }
        if !valid_mirror_url(&page.url) { return Err("Intel release page has no valid installer link".into()); }
        if let Some(size) = existing_file_size(&target)? {
            if size > 0 && size <= MAX_FILE_BYTES {
                if let Ok(verified) = verify_download(&target, &page) { return Ok(json!({"downloaded": true, "sizeBytes": verified})); }
            }
            // Electron removes an invalid target before redownloading.
            assert_safe_path(&target, false)?;
            let metadata = fs::symlink_metadata(&target).map_err(|error| error.to_string())?;
            if !metadata.file_type().is_file() { return Err("existing Intel driver download is not a regular file".into()); }
            fs::remove_file(&target).map_err(|error| error.to_string())?;
        }
        if let Some(parent) = target.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
        assert_safe_path(&partial, true)?;
        match fs::symlink_metadata(&partial) {
            Ok(metadata) => {
                if !metadata.file_type().is_file() { return Err("existing partial Intel download is not a regular file".into()); }
                fs::remove_file(&partial).map_err(|error| error.to_string())?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        let mut options = OpenOptions::new();
        options.create_new(true).write(true).read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&partial).map_err(|error| error.to_string())?;
        let mut hasher = Hasher::new(page.algorithm);
        let mut bytes = 0u64;
        let expected = std::cell::Cell::new(page.size_bytes);
        let mut on_start = |content_length: Option<u64>| -> Result<(), String> {
            if let Some(length) = content_length {
                if length == 0 || length > MAX_FILE_BYTES || length.abs_diff(page.size_bytes) > page.size_tolerance_bytes {
                    return Err("download content length does not match Intel page size".into());
                }
                expected.set(length);
            }
            Ok(())
        };
        let mut on_chunk = |chunk: &[u8]| -> Result<(), String> {
            bytes += chunk.len() as u64;
            if bytes > MAX_FILE_BYTES || bytes > page.size_bytes.saturating_add(page.size_tolerance_bytes) {
                return Err("Intel download exceeded declared size".into());
            }
            hasher.update(chunk);
            file.write_all(chunk).map_err(|error| error.to_string())?;
            let percent = ((bytes as u128 * 100) / expected.get().max(1) as u128).min(99) as u64;
            on_progress(json!({
                "kind": kind, "version": version, "bytesDownloaded": bytes,
                "totalBytes": expected.get(), "percent": percent,
            }));
            Ok(())
        };
        let result = self.inner.source.download(&page.url, transfer.cancel.clone(), &mut on_start, &mut on_chunk);
        let report = match result {
            Ok(report) => report,
            Err(error) => {
                drop(file);
                let _ = fs::remove_file(&partial);
                let error = if transfer.cancel.load(std::sync::atomic::Ordering::SeqCst) {
                    transfer.reason().unwrap_or(error)
                } else { error };
                return Err(error);
            }
        };
        let verification = (|| {
            if !valid_mirror_url(&report.final_url) { return Err("Intel redirected outside the allowlist".to_string()); }
            if report.bytes != bytes { return Err("Intel download size does not match release page".into()); }
            if let Some(length) = report.content_length {
                if report.bytes != length { return Err("Intel download size does not match release page".into()); }
            }
            if report.bytes.abs_diff(page.size_bytes) > page.size_tolerance_bytes {
                return Err("Intel download size does not match release page".into());
            }
            if hasher.finish() != page.digest { return Err("Intel installer checksum does not match Intel".into()); }
            file.flush().map_err(|error| error.to_string())?;
            file.seek(SeekFrom::Start(0)).map_err(|error| error.to_string())?;
            let mut header = [0u8; 2];
            if file.read_exact(&mut header).is_err() || &header != b"MZ" { return Err("download is not a Windows executable".into()); }
            Ok(())
        })();
        if let Err(error) = verification { drop(file); let _ = fs::remove_file(&partial); return Err(error); }
        drop(file);
        let finalize = (|| {
            assert_safe_path(&partial, false)?;
            assert_safe_path(&target, true)?;
            atomic_replace(&partial, &target).map_err(|error| error.to_string())
        })();
        if let Err(error) = finalize { let _ = fs::remove_file(&partial); return Err(error); }
        on_progress(json!({
            "kind": kind, "version": version, "bytesDownloaded": bytes,
            "totalBytes": expected.get(), "percent": 100,
        }));
        Ok(json!({"downloaded": true, "sizeBytes": bytes}))
    }

    pub fn cancel_download(&self, kind: &str) -> Result<Value, String> {
        if !valid_kind(kind) { return Err("invalid kind".into()); }
        let transfer = self.inner.state.lock().map_err(|_| "Intel driver state lock was poisoned")?.transfers.get(kind).cloned();
        if let Some(transfer) = transfer {
            transfer.cancel("Intel download cancelled");
            return Ok(json!({"cancelled": true}));
        }
        Ok(json!({"cancelled": false}))
    }

    pub fn delete_downloaded(&self, kind: &str, version: &str) -> Result<Value, String> {
        if !valid_kind(kind) { return Err("invalid kind".into()); }
        if !intel_driver_catalog::is_full_driver_version(version) { return Err("invalid Intel driver version".into()); }
        {
            let mut state = self.inner.state.lock().map_err(|_| "Intel driver state lock was poisoned")?;
            if state.quiescing { return Err(QUIESCE_MESSAGE.into()); }
            if state.transfers.contains_key(kind) || state.installs.contains(kind) || state.deletions.contains(kind) { return Err(DELETE_ACTIVE.into()); }
            state.deletions.insert(kind.to_owned());
        }
        let result = self.delete_locked(kind, version);
        if let Ok(mut state) = self.inner.state.lock() { state.deletions.remove(kind); }
        result
    }

    fn delete_locked(&self, kind: &str, version: &str) -> Result<Value, String> {
        let target = self.target(kind, version);
        if let Err(error) = reject_reparse_components(&target) { return Err(format!("Intel driver download path is unsafe: {error}")); }
        let metadata = match fs::symlink_metadata(&target) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(json!({"deleted": true})),
            Err(error) => return Err(error.to_string()),
        };
        if !metadata.file_type().is_file() { return Err(DELETE_REGULAR.into()); }
        assert_safe_path(&target, false)?;
        if let Err(error) = reject_reparse_components(&target) { return Err(format!("Intel driver download path is unsafe: {error}")); }
        match fs::remove_file(&target) {
            Ok(()) => Ok(json!({"deleted": true})),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({"deleted": true})),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn install_downloaded(&self, kind: &str, version: &str) -> Result<Value, String> {
        if !valid_kind(kind) { return Err("invalid kind".into()); }
        if !intel_driver_catalog::is_full_driver_version(version) { return Err("invalid Intel driver version".into()); }
        {
            let mut state = self.inner.state.lock().map_err(|_| "Intel driver state lock was poisoned")?;
            if state.quiescing { return Err(QUIESCE_MESSAGE.into()); }
            if state.transfers.contains_key(kind) || state.deletions.contains(kind) { return Err(INSTALL_BLOCKED.into()); }
            if state.installs.contains(kind) { return Err(INSTALL_ACTIVE.into()); }
            state.installs.insert(kind.to_owned());
        }
        let result = self.install_locked(kind, version);
        if let Ok(mut state) = self.inner.state.lock() { state.installs.remove(kind); }
        result
    }

    fn install_locked(&self, kind: &str, version: &str) -> Result<Value, String> {
        let target = self.target(kind, version);
        assert_safe_path(&target, false)?;
        let page = self.resolve_page(kind, version)?;
        if let Err(error) = verify_download(&target, &page) {
            if !error.contains("unsafe") && !error.contains("path changed") {
                if assert_safe_path(&target, false).is_ok() {
                    if let Ok(metadata) = fs::symlink_metadata(&target) {
                        if metadata.file_type().is_file() { let _ = fs::remove_file(&target); }
                    }
                }
            }
            return Err(INSTALL_UNVERIFIED.into());
        }
        assert_safe_path(&target, false)?;
        self.inner.spawner.spawn(&target)?;
        (self.inner.quit)();
        Ok(json!({"launched": true}))
    }

    pub fn quiesce(&self, timeout: Duration) -> Result<Value, String> {
        let transfers = {
            let mut state = self.inner.state.lock().map_err(|_| "Intel driver state lock was poisoned")?;
            state.quiescing = true;
            if !state.installs.is_empty() || !state.deletions.is_empty() {
                return Err("an Intel driver install or file operation is still active".into());
            }
            state.transfers.values().cloned().collect::<Vec<_>>()
        };
        for transfer in &transfers { transfer.cancel("Arc Power is restarting for maintenance"); }
        let deadline = Instant::now() + timeout;
        for transfer in &transfers {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() { return Err("Intel driver download did not stop before maintenance".into()); }
            transfer.wait(remaining)?;
        }
        let state = self.inner.state.lock().map_err(|_| "Intel driver state lock was poisoned")?;
        if !state.transfers.is_empty() || !state.installs.is_empty() || !state.deletions.is_empty() {
            return Err("Intel driver activity remains active".into());
        }
        Ok(json!({"cancelledTransfers": transfers.len()}))
    }

    pub fn resume(&self) {
        if let Ok(mut state) = self.inner.state.lock() { state.quiescing = false; }
    }
}

fn assert_safe_path(path: &Path, allow_missing: bool) -> Result<(), String> {
    if let Err(error) = reject_reparse_components(path) {
        return Err(format!("Intel installer path is unsafe: {error}"));
    }
    if !allow_missing && !path.exists() { return Err("Intel installer path is missing".into()); }
    Ok(())
}

fn existing_file_size(target: &Path) -> Result<Option<u64>, String> {
    match fs::symlink_metadata(target) {
        Ok(metadata) => Ok(metadata.file_type().is_file().then_some(metadata.len())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn verify_download(target: &Path, page: &DownloadPage) -> Result<u64, String> {
    assert_safe_path(target, false)?;
    let metadata = fs::symlink_metadata(target).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_file() { return Err(DELETE_REGULAR.into()); }
    let size = metadata.len();
    if size > MAX_FILE_BYTES || size.abs_diff(page.size_bytes) > page.size_tolerance_bytes {
        return Err("saved Intel installer size does not match the release page".into());
    }
    let mut file = File::open(target).map_err(|error| error.to_string())?;
    let mut hasher = Hasher::new(page.algorithm);
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 { break; }
        total += read as u64;
        hasher.update(&buffer[..read]);
    }
    if total != size || hasher.finish() != page.digest { return Err("saved Intel installer checksum does not match Intel".into()); }
    file.seek(SeekFrom::Start(0)).map_err(|error| error.to_string())?;
    let mut header = [0u8; 2];
    if file.read_exact(&mut header).is_err() || &header != b"MZ" { return Err("download is not a Windows executable".into()); }
    if let Err(error) = reject_reparse_components(target) { return Err(format!("Intel installer path changed during verification: {error}")); }
    Ok(size)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    const PAGE: &str = "https://www.intel.com/content/www/us/en/download/785597/123456/intel-arc-graphics-windows.html";
    const VERSION: &str = "32.0.101.9030";

    fn digest(bytes: &[u8], algorithm: HashAlgorithm) -> String {
        let mut hasher = Hasher::new(algorithm);
        hasher.update(bytes);
        hasher.finish()
    }

    fn page_html(kind: &str, version: &str, body: &[u8], size: u64, algorithm: HashAlgorithm, digest_override: Option<&str>) -> String {
        let mirror = format!("https://downloadmirror.intel.com/123456/gfx_win_101.{}.exe", version.rsplit('.').next().unwrap());
        let label = if algorithm == HashAlgorithm::Sha512 { "SHA512" } else { "SHA256" };
        let digest = digest_override.map(str::to_owned).unwrap_or_else(|| digest(body, algorithm));
        let recommended = if kind == "pro" { format!("<meta name=\"RecommendedDownloadUrl\" content=\"{mirror}\">") } else { String::new() };
        format!("<meta name=\"DownloadVersion\" content=\"{version}\">{recommended}<a data-href=\"{mirror}\">Download</a><div>Size: {size} bytes</div><div>{label}: {digest}</div>")
    }

    fn mz_body(length: usize) -> Vec<u8> {
        let mut body = vec![b'M', b'Z'];
        body.extend(std::iter::repeat(0x5a).take(length.saturating_sub(2)));
        body
    }

    struct FakeSource {
        pages: Mutex<HashMap<String, String>>,
        body: Vec<u8>,
        chunk_size: usize,
        delay: Duration,
        report_content_length: Option<Option<u64>>,
        report_error: Option<String>,
        started: Option<Arc<(Mutex<bool>, Condvar)>>,
    }
    impl FakeSource {
        fn new(html: String, body: Vec<u8>) -> Self {
            Self { pages: Mutex::new(HashMap::from([(PAGE.to_owned(), html)])), body, chunk_size: 64 * 1024, delay: Duration::ZERO, report_content_length: None, report_error: None, started: None }
        }
        fn with_chunks(mut self, chunk_size: usize, delay: Duration) -> Self { self.chunk_size = chunk_size; self.delay = delay; self }
        fn with_content_length(mut self, length: Option<u64>) -> Self { self.report_content_length = Some(length); self }
        fn with_error(mut self, error: &str) -> Self { self.report_error = Some(error.to_owned()); self }
        fn with_started(mut self, started: Arc<(Mutex<bool>, Condvar)>) -> Self { self.started = Some(started); self }
    }
    impl DownloadSource for FakeSource {
        fn fetch_page(&self, url: &str) -> Result<String, String> {
            self.pages.lock().unwrap().get(url).cloned().ok_or_else(|| format!("unexpected page URL: {url}"))
        }
        fn download(&self, url: &str, cancel: Arc<AtomicBool>, on_start: &mut dyn FnMut(Option<u64>) -> Result<(), String>, on_chunk: &mut dyn FnMut(&[u8]) -> Result<(), String>) -> Result<DownloadReport, String> {
            if let Some(error) = &self.report_error { return Err(error.clone()); }
            let declared = self.report_content_length.unwrap_or(Some(self.body.len() as u64));
            on_start(declared)?;
            if let Some(started) = &self.started {
                let (lock, ready) = &**started;
                *lock.lock().unwrap() = true;
                ready.notify_all();
            }
            let mut bytes = 0u64;
            for chunk in self.body.chunks(self.chunk_size.max(1)) {
                if cancel.load(Ordering::SeqCst) { return Err("Intel download cancelled".into()); }
                on_chunk(chunk)?;
                bytes += chunk.len() as u64;
                if !self.delay.is_zero() { std::thread::sleep(self.delay); }
            }
            Ok(DownloadReport { final_url: url.to_owned(), content_length: declared, bytes })
        }
    }

    struct FakeReleases { url: String }
    impl ReleaseResolver for FakeReleases {
        fn resolve(&self, _kind: &str, _version: &str) -> Result<ResolvedRelease, String> {
            Ok(ResolvedRelease { official_page_url: self.url.clone() })
        }
    }
    impl FakeReleases {
        fn new() -> Self { Self { url: PAGE.to_owned() } }
    }

    struct FakeSpawner { spawned: Mutex<Vec<PathBuf>>, error: Mutex<Option<String>> }
    impl FakeSpawner {
        fn new() -> Arc<Self> { Arc::new(Self { spawned: Mutex::new(Vec::new()), error: Mutex::new(None) }) }
    }
    impl InstallerSpawner for FakeSpawner {
        fn spawn(&self, executable: &Path) -> Result<(), String> {
            if let Some(error) = self.error.lock().unwrap().clone() { return Err(error); }
            self.spawned.lock().unwrap().push(executable.to_path_buf());
            Ok(())
        }
    }

    struct Fixture { root: PathBuf, service: IntelDriverDownloadService, spawner: Arc<FakeSpawner>, quits: Arc<AtomicUsize> }
    impl Drop for Fixture { fn drop(&mut self) { if self.root.parent() == Some(std::env::temp_dir().as_path()) { let _ = fs::remove_dir_all(&self.root); } } }

    fn fixture(kind: &str, body: Vec<u8>, algorithm: HashAlgorithm, digest_override: Option<&str>, source: Option<FakeSource>) -> Fixture {
        let root = std::env::temp_dir().join(format!("arc-intel-download-test-{:032x}", rand::random::<u128>()));
        fs::create_dir(&root).unwrap();
        let html = page_html(kind, VERSION, &body, body.len() as u64, algorithm, digest_override);
        let source = Arc::new(source.unwrap_or_else(|| FakeSource::new(html, body)));
        let spawner = FakeSpawner::new();
        let quits = Arc::new(AtomicUsize::new(0));
        let quit = quits.clone();
        let service = IntelDriverDownloadService::with_seams(root.clone(), source.clone(), Arc::new(FakeReleases::new()), spawner.clone(),
            Arc::new(move || { quit.fetch_add(1, Ordering::SeqCst); })).unwrap();
        Fixture { root, service, spawner, quits }
    }


    #[test]
    fn download_page_requires_size_hash_mirror_and_matching_version_digits() {
        let body = mz_body(16);
        let good = page_html("arc", VERSION, &body, body.len() as u64, HashAlgorithm::Sha512, None);
        let parsed = parse_intel_download_page(&good, "arc").unwrap();
        assert_eq!(parsed.version, VERSION);
        assert_eq!(parsed.size_bytes, body.len() as u64);
        assert_eq!(parsed.algorithm, HashAlgorithm::Sha512);
        assert!(valid_mirror_url(&parsed.url));

        let pro = page_html("pro", "32.0.101.8805", &body, body.len() as u64, HashAlgorithm::Sha256, None);
        assert_eq!(parse_intel_download_page(&pro, "pro").unwrap().algorithm, HashAlgorithm::Sha256);
        let suffix = good.replace("content=\"32.0.101.9030\"", "content=\"32.0.101.9030 - Q2.26.R2\"");
        assert_eq!(parse_intel_download_page(&suffix, "arc").unwrap().version, "32.0.101.9030");
        let recommended = format!("<meta name=\"DownloadVersion\" content=\"{VERSION}\"><meta name=\"RecommendedDownloadUrl\" content=\"https://downloadmirror.intel.com/123456/gfx_win_101.9030.exe\"><a href=\"https://evil.example/123456/gfx_win_101.9030.exe\">bad</a><div>Size: {} bytes</div><div>SHA512: {}</div>", body.len(), digest(&body, HashAlgorithm::Sha512));
        assert_eq!(parse_intel_download_page(&recommended, "pro").unwrap().url, "https://downloadmirror.intel.com/123456/gfx_win_101.9030.exe");
        for (source, message) in [
            (good.replace("Size: 16 bytes", ""), "no valid installer size"),
            (good.replace(&digest(&body, HashAlgorithm::Sha512), ""), "no valid SHA256 or SHA512 digest"),
            (good.replace("downloadmirror.intel.com", "evil.example"), "no valid installer link"),
            (good.replace("gfx_win_101.9030.exe", "gfx_win_101.9031.exe"), "does not match the page version"),
            (good.replace("<meta name=\"DownloadVersion\" content=\"32.0.101.9030\">", "<meta name=\"DownloadVersion\" content=\"32.0.101\">"), "invalid driver version"),
            (good.replace("SHA512:", "SHA256:"), "digest length is invalid"),
        ] { assert!(parse_intel_download_page(&source, "arc").unwrap_err().contains(message), "{message}"); }
        assert!(parse_intel_download_page(&good, "other").is_err());
    }

    #[test]
    fn regional_detail_parser_is_scoped_and_requires_exact_version_size_hash_and_mirror() {
        let regional_arc = "https://www.intel.cn/content/www/cn/zh/download/785597/123456/intel-arc-graphics-windows.html";
        let regional_pro = "https://www.intel.cn/content/www/cn/zh/download/741626/654321/intel-arc-pro-graphics-windows.html";
        let arc_hash = "a".repeat(128);
        let arc_html = format!(
            "<meta name=\"DownloadVersion\" content=\"32.0.101.9175 WHQL Certified\"><meta name=\"RecommendedDownloadUrl\" content=\"https://downloadmirror.intel.com/932449/gfx_win_101.9175.exe\"><li>大小&#xff1a;862.6 MB</li><li>SHA512&#xff1a;{arc_hash}</li>"
        );
        let arc = parse_intel_download_page_for_url(&arc_html, "arc", regional_arc).unwrap();
        assert_eq!(arc.version, "32.0.101.9175");
        assert_eq!(arc.size_bytes, (862.6f64 * 1024f64.powi(2)).round() as u64);
        assert_eq!(arc.algorithm, HashAlgorithm::Sha512);
        assert_eq!(arc.digest, arc_hash);
        assert_eq!(arc.url, "https://downloadmirror.intel.com/932449/gfx_win_101.9175.exe");
        assert!(!valid_mirror_url("https://www.intel.cn/content/www/cn/zh/download/785597/gfx_win_101.9175.exe"));

        let pro_hash = "b".repeat(64);
        let pro_html = format!(
            "<meta name=\"DownloadVersion\" content=\"32.0.101.8976 - Q3.26\"><meta name=\"RecommendedDownloadUrl\" content=\"https://downloadmirror.intel.com/929467/gfx_win_101.8976.exe\"><li>大小：855 MB</li><li>SHA256：{pro_hash}</li>"
        );
        let pro = parse_intel_download_page_for_url(&pro_html, "pro", regional_pro).unwrap();
        assert_eq!(pro.version, "32.0.101.8976");
        assert_eq!(pro.size_bytes, 855 * 1024 * 1024);
        assert_eq!(pro.algorithm, HashAlgorithm::Sha256);
        assert_eq!(pro.digest, pro_hash);

        let arc_history_url = "https://www.intel.cn/content/www/cn/zh/download/857252/222222/historical-intel-arc-graphics-drivers.html";
        let arc_history_hash = "c".repeat(64);
        let arc_history_html = format!(
            "<meta name=\"DownloadVersion\" content=\"32.0.101.8824\"><meta name=\"RecommendedDownloadUrl\" content=\"https://downloadmirror.intel.com/926935/gfx_win_101.8824.exe\"><li>大小：784.9 MB</li><li>SHA256：{arc_history_hash}</li>"
        );
        let arc_history = parse_intel_download_page_for_url(&arc_history_html, "arc", arc_history_url).unwrap();
        assert_eq!(arc_history.version, "32.0.101.8824");
        assert_eq!(arc_history.algorithm, HashAlgorithm::Sha256);
        assert_eq!(arc_history.digest, arc_history_hash);
        assert_eq!(arc_history.url, "https://downloadmirror.intel.com/926935/gfx_win_101.8824.exe");

        let pro_history_url = "https://www.intel.cn/content/www/cn/zh/download/857390/333333/historical-intel-arc-pro-graphics-drivers.html";
        let pro_history_hash = "d".repeat(64);
        let pro_history_html = format!(
            "<meta name=\"DownloadVersion\" content=\"32.0.101.6637 - Q1.25\"><meta name=\"RecommendedDownloadUrl\" content=\"https://downloadmirror.intel.com/869841/gfx_win_101.6637.exe\"><li>大小：628.2 MB</li><li>SHA256：{pro_history_hash}</li>"
        );
        let pro_history = parse_intel_download_page_for_url(&pro_history_html, "pro", pro_history_url).unwrap();
        assert_eq!(pro_history.version, "32.0.101.6637");
        assert_eq!(pro_history.algorithm, HashAlgorithm::Sha256);
        assert_eq!(pro_history.digest, pro_history_hash);
        assert_eq!(pro_history.url, "https://downloadmirror.intel.com/869841/gfx_win_101.6637.exe");

        assert!(parse_intel_download_page(&arc_html, "arc").is_err(), "localized fields require validated regional URL context");
        assert!(parse_intel_download_page_for_url(&pro_html, "arc", regional_pro).is_err(), "product path cannot be relabeled Arc");
        assert!(parse_intel_download_page_for_url(&arc_html.replace("9175.exe", "9176.exe"), "arc", regional_arc)
            .unwrap_err().contains("does not match"));
        assert!(parse_intel_download_page_for_url(&arc_html.replace(&arc_hash, "a".repeat(127).as_str()), "arc", regional_arc)
            .unwrap_err().contains("digest length"));
        assert!(parse_intel_download_page_for_url(&arc_html.replace("downloadmirror.intel.com", "evil.example"), "arc", regional_arc)
            .unwrap_err().contains("installer link"));
        assert!(parse_intel_download_page_for_url(&arc_html, "arc", "https://www.intel.cn/content/www/cn/zh/download/785597/123456/other.html").is_err());
    }

    #[test]
    fn redirect_targets_are_revalidated_at_every_hop() {
        let current = "https://www.intel.com/content/www/us/en/download/785597/1/intel-arc-graphics-windows.html";
        assert!(redirect_target(current, "/content/www/us/en/download/785597/2/intel-arc-graphics-windows.html", valid_www_intel_url).is_ok());
        for target in ["https://evil.example/x", "http://www.intel.com/x", "https://www.intel.com/x?q=1", "https://www.intel.com:8443/x", "https://www.intel.com@evil.example/x"] {
            assert!(redirect_target(current, target, valid_www_intel_url).is_err(), "{target}");
        }
        let mirror = "https://downloadmirror.intel.com/123456/gfx_win_101.9030.exe";
        assert!(redirect_target(mirror, "/654321/gfx_win_101.9030.exe", valid_mirror_url).is_ok());
        assert!(redirect_target(mirror, "https://evil.example/654321/gfx_win_101.9030.exe", valid_mirror_url).is_err());
        let regional = "https://www.intel.cn/content/www/cn/zh/download/785597/123456/intel-arc-graphics-windows.html";
        let regional_host_only = |value: &str| valid_www_intel_url(value)
            && Url::parse(value).ok().and_then(|url| url.host_str().map(str::to_owned)).as_deref() == Some("www.intel.cn");
        assert!(redirect_target(regional, "/content/www/cn/zh/download/785597/123457/intel-arc-graphics-windows.html", regional_host_only).is_ok());
        assert!(redirect_target(regional, "https://www.intel.com/content/www/us/en/download/785597/123456/intel-arc-graphics-windows.html", regional_host_only).is_err());
    }

    #[test]
    fn download_streams_99_then_100_and_verifies_hash_and_mz() {
        let body = mz_body(100);
        let test = fixture("arc", body.clone(), HashAlgorithm::Sha512, None, Some(
            FakeSource::new(page_html("arc", VERSION, &body, 100, HashAlgorithm::Sha512, None), body.clone()).with_chunks(40, Duration::ZERO)));
        let mut progress = Vec::new();
        let result = test.service.start_download("arc", VERSION, &mut |payload| progress.push(payload)).unwrap();
        assert_eq!(result, json!({"downloaded":true,"sizeBytes":100}));
        assert_eq!(progress.iter().map(|value| value["percent"].as_u64().unwrap()).collect::<Vec<_>>(), vec![40, 80, 99, 100]);
        assert_eq!(progress.last().unwrap()["bytesDownloaded"], 100);
        assert_eq!(progress.last().unwrap()["totalBytes"], 100);
        assert_eq!(fs::read(test.root.join("DriverDownloads/arc").join(VERSION).join(DOWNLOAD_FILE_NAME)).unwrap(), body);
        assert!(!test.root.join("DriverDownloads/arc").join(VERSION).join("gfx_win_101.exe.part").exists());
    }

    #[test]
    fn content_length_mismatch_overflow_hash_and_mz_failures_remove_partial() {
        for (label, source, expected) in [
            ("length", FakeSource::new(page_html("arc", VERSION, &mz_body(100), 100, HashAlgorithm::Sha512, None), mz_body(100)).with_content_length(Some(2000)), "content length"),
            ("length-cap", FakeSource::new(page_html("arc", VERSION, &mz_body(100), 100, HashAlgorithm::Sha512, None), mz_body(100)).with_content_length(Some(MAX_FILE_BYTES + 1)), "content length"),
            ("overflow", FakeSource::new(page_html("arc", VERSION, &vec![0u8; 64], 64, HashAlgorithm::Sha512, None), vec![0u8; 4096]).with_content_length(Some(64)), "exceeded declared size"),
            ("hash", FakeSource::new(page_html("arc", VERSION, &mz_body(100), 100, HashAlgorithm::Sha512, Some(&"0".repeat(128))), mz_body(100)), "checksum"),
            ("mz", FakeSource::new(page_html("arc", VERSION, &vec![b'P', b'K', 1, 2], 4, HashAlgorithm::Sha512, None), vec![b'P', b'K', 1, 2]), "not a Windows executable"),
            ("source", FakeSource::new(page_html("arc", VERSION, &mz_body(100), 100, HashAlgorithm::Sha512, None), mz_body(100)).with_error("Intel request failed (500)"), "Intel request failed"),
        ] {
            let test = fixture("arc", mz_body(100), HashAlgorithm::Sha512, None, Some(source));
            let error = test.service.start_download("arc", VERSION, &mut |_| {}).unwrap_err();
            assert!(error.contains(expected), "{label}: {error}");
            assert!(!test.root.join("DriverDownloads/arc").join(VERSION).join("gfx_win_101.exe.part").exists(), "{label}");
            assert!(test.spawner.spawned.lock().unwrap().is_empty(), "{label}");
        }
    }

    #[test]
    fn cancel_removes_partial_and_rejects_pending_start() {
        let body = mz_body(64 * 1024);
        let started = Arc::new((Mutex::new(false), Condvar::new()));
        let source = FakeSource::new(page_html("arc", VERSION, &body, body.len() as u64, HashAlgorithm::Sha512, None), body)
            .with_chunks(4096, Duration::from_millis(5)).with_started(started.clone());
        let test = fixture("arc", mz_body(10), HashAlgorithm::Sha512, None, Some(source));
        let service = test.service.clone();
        let worker = std::thread::spawn(move || service.start_download("arc", VERSION, &mut |_| {}));
        {
            let (lock, ready) = &*started;
            let mut ready_flag = lock.lock().unwrap();
            while !*ready_flag { ready_flag = ready.wait(ready_flag).unwrap(); }
        }
        assert_eq!(test.service.cancel_download("arc").unwrap(), json!({"cancelled":true}));
        let error = worker.join().unwrap().unwrap_err();
        assert!(error.contains("cancelled"), "{error}");
        assert!(!test.root.join("DriverDownloads/arc").join(VERSION).join("gfx_win_101.exe.part").exists());
        assert_eq!(test.service.cancel_download("arc").unwrap(), json!({"cancelled":false}));
    }

    #[test]
    fn stale_partial_is_replaced_and_delete_is_idempotent_and_regular_file_only() {
        let body = mz_body(32);
        let test = fixture("arc", body.clone(), HashAlgorithm::Sha512, None, None);
        let dir = test.root.join("DriverDownloads/arc").join(VERSION);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("gfx_win_101.exe.part"), b"stale").unwrap();
        test.service.start_download("arc", VERSION, &mut |_| {}).unwrap();
        assert!(!dir.join("gfx_win_101.exe.part").exists());
        assert_eq!(test.service.delete_downloaded("arc", VERSION).unwrap(), json!({"deleted":true}));
        assert_eq!(test.service.delete_downloaded("arc", VERSION).unwrap(), json!({"deleted":true}));
        fs::create_dir_all(dir.join("gfx_win_101.exe")).unwrap();
        assert!(test.service.delete_downloaded("arc", VERSION).is_err());
    }

    #[test]
    fn delete_is_refused_while_a_transfer_is_active() {
        let body = mz_body(64 * 1024);
        let started = Arc::new((Mutex::new(false), Condvar::new()));
        let source = FakeSource::new(page_html("arc", VERSION, &body, body.len() as u64, HashAlgorithm::Sha512, None), body)
            .with_chunks(4096, Duration::from_millis(5)).with_started(started.clone());
        let test = fixture("arc", mz_body(10), HashAlgorithm::Sha512, None, Some(source));
        let service = test.service.clone();
        let worker = std::thread::spawn(move || service.start_download("arc", VERSION, &mut |_| {}));
        {
            let (lock, ready) = &*started;
            let mut ready_flag = lock.lock().unwrap();
            while !*ready_flag { ready_flag = ready.wait(ready_flag).unwrap(); }
        }
        assert!(test.service.delete_downloaded("arc", VERSION).unwrap_err().contains("active"));
        test.service.cancel_download("arc").unwrap();
        let _ = worker.join().unwrap();
    }

    #[test]
    fn oversized_page_is_rejected_before_a_partial_is_created() {
        let huge = format!("<html>{}</html>", "x".repeat(MAX_PAGE_BYTES + 1));
        let source = FakeSource::new(huge, mz_body(16));
        let test = fixture("arc", mz_body(16), HashAlgorithm::Sha512, None, Some(source));
        let error = test.service.start_download("arc", VERSION, &mut |_| {}).unwrap_err();
        assert!(error.contains("too large"), "{error}");
        assert!(!test.root.join("DriverDownloads/arc").join(VERSION).join("gfx_win_101.exe.part").exists());
    }

    #[test]
    fn install_version_mismatch_never_verifies_or_spawns() {
        let body = mz_body(32);
        let wrong = page_html("arc", "32.0.101.9999", &body, body.len() as u64, HashAlgorithm::Sha512, None);
        let test = fixture("arc", body.clone(), HashAlgorithm::Sha512, None, Some(FakeSource::new(wrong, body.clone())));
        let target = test.root.join("DriverDownloads/arc").join(VERSION).join(DOWNLOAD_FILE_NAME);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, &body).unwrap();
        let error = test.service.install_downloaded("arc", VERSION).unwrap_err();
        assert!(error.contains("no longer matches"), "{error}");
        assert!(target.exists());
        assert!(test.spawner.spawned.lock().unwrap().is_empty());
        assert_eq!(test.quits.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn duplicate_start_and_install_while_downloading_use_exact_lock_messages() {
        let body = mz_body(64 * 1024);
        let started = Arc::new((Mutex::new(false), Condvar::new()));
        let source = FakeSource::new(page_html("arc", VERSION, &body, body.len() as u64, HashAlgorithm::Sha512, None), body)
            .with_chunks(4096, Duration::from_millis(5)).with_started(started.clone());
        let test = fixture("arc", mz_body(10), HashAlgorithm::Sha512, None, Some(source));
        let service = test.service.clone();
        let worker = std::thread::spawn(move || service.start_download("arc", VERSION, &mut |_| {}));
        {
            let (lock, ready) = &*started;
            let mut ready_flag = lock.lock().unwrap();
            while !*ready_flag { ready_flag = ready.wait(ready_flag).unwrap(); }
        }
        assert!(test.service.start_download("arc", VERSION, &mut |_| {}).unwrap_err().contains("already active"));
        assert!(test.service.install_downloaded("arc", VERSION).unwrap_err().contains("download or deletion"));
        test.service.cancel_download("arc").unwrap();
        let _ = worker.join().unwrap();
    }

    #[test]
    fn existing_invalid_target_is_removed_and_redownloaded() {
        let body = mz_body(32);
        let test = fixture("arc", body.clone(), HashAlgorithm::Sha512, None, None);
        let target = test.root.join("DriverDownloads/arc").join(VERSION).join(DOWNLOAD_FILE_NAME);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        let mut corrupted = body.clone();
        corrupted[0] = b'X';
        fs::write(&target, &corrupted).unwrap();
        assert_eq!(test.service.start_download("arc", VERSION, &mut |_| {}).unwrap(), json!({"downloaded":true,"sizeBytes":32}));
        assert_eq!(fs::read(&target).unwrap(), body);
        assert!(!target.with_file_name("gfx_win_101.exe.part").exists());
    }

    #[test]
    fn install_failure_deletes_retained_file_and_never_spawns() {
        let body = mz_body(32);
        let test = fixture("arc", body.clone(), HashAlgorithm::Sha512, Some(&"0".repeat(128)), None);
        let target = test.root.join("DriverDownloads/arc").join(VERSION).join(DOWNLOAD_FILE_NAME);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, &body).unwrap();
        let error = test.service.install_downloaded("arc", VERSION).unwrap_err();
        assert_eq!(error, INSTALL_UNVERIFIED);
        assert!(!target.exists());
        assert!(test.spawner.spawned.lock().unwrap().is_empty());
        assert_eq!(test.quits.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn spawn_error_preserves_the_windows_740_text() {
        let error = spawn_error(std::io::Error::from_raw_os_error(740));
        assert!(error.contains("ERROR_ELEVATION_REQUIRED (740)"), "{error}");
        assert!(error.contains("Cannot start the Intel driver installer"));
    }

    #[test]
    fn install_spawn_failure_does_not_quit() {
        let body = mz_body(32);
        let test = fixture("arc", body.clone(), HashAlgorithm::Sha512, None, None);
        let target = test.root.join("DriverDownloads/arc").join(VERSION).join(DOWNLOAD_FILE_NAME);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, &body).unwrap();
        *test.spawner.error.lock().unwrap() = Some("ERROR_ELEVATION_REQUIRED (740)".into());
        let error = test.service.install_downloaded("arc", VERSION).unwrap_err();
        assert!(error.contains("740"), "{error}");
        assert_eq!(test.quits.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn install_success_spawns_detached_and_quits_once() {
        let body = mz_body(32);
        let test = fixture("arc", body.clone(), HashAlgorithm::Sha512, None, None);
        let target = test.root.join("DriverDownloads/arc").join(VERSION).join(DOWNLOAD_FILE_NAME);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, &body).unwrap();
        assert_eq!(test.service.install_downloaded("arc", VERSION).unwrap(), json!({"launched":true}));
        assert_eq!(test.spawner.spawned.lock().unwrap().as_slice(), &[target]);
        assert_eq!(test.quits.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn quiesce_cancels_and_resume_allows_a_new_download() {
        let body = mz_body(64 * 1024);
        let started = Arc::new((Mutex::new(false), Condvar::new()));
        let source = FakeSource::new(page_html("arc", VERSION, &body, body.len() as u64, HashAlgorithm::Sha512, None), body)
            .with_chunks(4096, Duration::from_millis(5)).with_started(started.clone());
        let test = fixture("arc", mz_body(10), HashAlgorithm::Sha512, None, Some(source));
        let service = test.service.clone();
        let worker = std::thread::spawn(move || service.start_download("arc", VERSION, &mut |_| {}));
        {
            let (lock, ready) = &*started;
            let mut ready_flag = lock.lock().unwrap();
            while !*ready_flag { ready_flag = ready.wait(ready_flag).unwrap(); }
        }
        let quiesced = test.service.quiesce(Duration::from_secs(2)).unwrap();
        assert_eq!(quiesced["cancelledTransfers"], 1);
        assert!(worker.join().unwrap().is_err());
        assert!(test.service.start_download("arc", VERSION, &mut |_| {}).is_err());
        test.service.resume();
        assert!(test.service.start_download("arc", VERSION, &mut |_| {}).is_ok());
    }
}
