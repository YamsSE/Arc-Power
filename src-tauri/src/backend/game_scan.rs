//! Native game discovery and local artwork resolver. Read-only: it enumerates
//! uninstall entries, Start Menu shortcuts and running executables, applies the
//! shared game-candidate gate, extracts the executable icon and resolves local
//! poster/Steam cache artwork. No discovered path is executed and no network
//! request is made.
use super::game_candidate::{
    canonical_exe_path, is_likely_game_candidate, is_verified_executable_path,
    validate_safe_game_candidate,
};
use super::game_profile_contract::{deterministic_artwork_key, is_valid_artwork, is_valid_banner};
use base64::Engine;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
};

const MAX_START_MENU_ITEMS: usize = 256;
const MAX_REGISTRY_ITEMS: usize = 512;
const MAX_INSTALL_CANDIDATES: usize = 16;
const MAX_PROCESSES: usize = 512;
const MAX_ARTWORK_ITEMS: usize = 64;
const MAX_ARTWORK_BYTES: usize = 4 * 1024 * 1024;
const MAX_BANNER_BYTES: usize = 12_000_000;
const POSTER_MAX_BYTES: u64 = 8 * 1024 * 1024;
const STEAM_MAX_MANIFESTS: usize = 512;
const STEAM_MAX_USERS: usize = 16;

const POSTER_NAMES: &[&str] = &[
    "library_hero", "library_capsule", "header", "banner", "cover", "poster", "capsule",
    "steam_grid",
];
const POSTER_EXTENSIONS: &[(&str, &str)] =
    &[(".png", "image/png"), (".jpg", "image/jpeg"), (".jpeg", "image/jpeg"), (".webp", "image/webp")];
const STEAM_ARTWORK_FILES: &[&str] = &[
    "library_hero_2x", "library_hero", "library_capsule_2x", "library_capsule",
    "library_600x900_2x", "library_600x900", "header_2x", "header", "logo",
];
const STEAM_GRID_ARTWORK_FILES: &[&str] =
    &["p", "p_2x", "", "_2x", "_hero", "_hero_2x", "_header", "_header_2x", "_capsule", "_capsule_2x"];

#[derive(Clone, Copy, PartialEq, Eq)]
enum RowSource {
    Registry,
    StartMenu,
    Process,
}

struct ScanRow {
    exe_path: String,
    display_name: Option<String>,
    process_name: Option<String>,
    artwork: Option<String>,
    banner: Option<String>,
    source: RowSource,
}

#[derive(Clone)]
struct GameApp {
    exe_path: String,
    process_name: String,
    display_name: String,
    artwork: String,
    banner: Option<String>,
}

struct ArtworkCandidate {
    path: PathBuf,
    extension: &'static str,
    mime: &'static str,
}

fn fixed_env(value: &str) -> Option<String> {
    env::var(value).ok().filter(|value| !value.trim().is_empty())
}

fn expand_env(value: &str) -> String {
    let mut result = String::new();
    let mut index = 0;
    while index < value.len() {
        if value.as_bytes()[index] == b'%' {
            if let Some(offset) = value[index + 1..].find('%') {
                let name = &value[index + 1..index + 1 + offset];
                if let Ok(expanded) = env::var(name) {
                    result.push_str(&expanded);
                    index += offset + 2;
                    continue;
                }
            }
        }
        let Some(character) = value[index..].chars().next() else { break; };
        result.push(character);
        index += character.len_utf8();
    }
    result
}

fn clean_path(value: &str) -> String {
    let value = value.split(',').next().unwrap_or(value).trim();
    let value = value.strip_prefix('"').and_then(|value| value.strip_suffix('"')).unwrap_or(value);
    expand_env(value.trim())
}

fn add_row(rows: &mut Vec<ScanRow>, path: &str, display: Option<&str>, source: RowSource) {
    let path = clean_path(path);
    if path.is_empty() { return; }
    let Some(canonical) = canonical_exe_path(&json!(path)) else { return; };
    if !Path::new(&canonical).is_file() { return; }
    rows.push(ScanRow {
        exe_path: canonical,
        display_name: display.map(str::to_owned),
        process_name: Path::new(&path).file_name().and_then(|name| name.to_str()).map(str::to_owned),
        artwork: None,
        banner: None,
        source,
    });
}

fn collect_files(root: &Path, extension: &str, depth: u32, limit: usize, output: &mut Vec<PathBuf>) {
    if output.len() >= limit { return; }
    let Ok(entries) = std::fs::read_dir(root) else { return; };
    let mut directories = Vec::new();
    for entry in entries.flatten() {
        if output.len() >= limit { return; }
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else { continue; };
        if file_type.is_dir() {
            if depth > 0 { directories.push(path); }
        } else if file_type.is_file()
            && path.extension().and_then(|value| value.to_str()).is_some_and(|value| value.eq_ignore_ascii_case(extension)) {
            output.push(path);
        }
    }
    for directory in directories {
        collect_files(&directory, extension, depth.saturating_sub(1), limit, output);
        if output.len() >= limit { return; }
    }
}

fn shortcut_target(path: &Path) -> Option<String> {
    use windows::core::{GUID, HSTRING, Interface};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, STGM_READ,
    };
    use windows::Win32::UI::Shell::IShellLinkW;
    let clsid = GUID::from_u128(0x00021401_0000_0000_c000_000000000046);
    let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let result = (|| unsafe {
        let link: IShellLinkW = CoCreateInstance(&clsid, None, CLSCTX_INPROC_SERVER).ok()?;
        let persist: IPersistFile = link.cast().ok()?;
        persist.Load(&HSTRING::from(path.as_os_str()), STGM_READ).ok()?;
        let mut buffer = [0u16; 32768];
        link.GetPath(&mut buffer, std::ptr::null_mut(), 0).ok()?;
        let length = buffer.iter().position(|value| *value == 0).unwrap_or(buffer.len());
        String::from_utf16(&buffer[..length]).ok()
    })();
    if initialized.is_ok() { unsafe { CoUninitialize(); } }
    result
}

#[cfg(windows)]
fn registry_rows(rows: &mut Vec<ScanRow>) {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;
    const ROOTS: &[(winreg::HKEY, &str)] = &[
        (HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Uninstall"),
        (HKEY_LOCAL_MACHINE, r"Software\Microsoft\Windows\CurrentVersion\Uninstall"),
        (HKEY_LOCAL_MACHINE, r"Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
    ];
    let mut count = 0usize;
    for (hive, path) in ROOTS {
        if count >= MAX_REGISTRY_ITEMS { break; }
        let root = RegKey::predef(*hive);
        let Ok(key) = root.open_subkey(path) else { continue; };
        for name in key.enum_keys().flatten() {
            if count >= MAX_REGISTRY_ITEMS { break; }
            count += 1;
            let Ok(app) = key.open_subkey(&name) else { continue; };
            let display = app.get_value::<String, _>("DisplayName").ok()
                .map(|value| value.trim().to_owned()).filter(|value| !value.is_empty());
            let Some(display) = display else { continue; };
            if let Ok(icon) = app.get_value::<String, _>("DisplayIcon") {
                add_row(rows, &icon, Some(&display), RowSource::Registry);
            }
            let Ok(location) = app.get_value::<String, _>("InstallLocation") else { continue; };
            let location = clean_path(&location);
            if location.is_empty() || !Path::new(&location).is_dir() { continue; }
            let mut executables = Vec::new();
            collect_files(Path::new(&location), "exe", 2, MAX_INSTALL_CANDIDATES, &mut executables);
            for executable in executables {
                add_row(rows, &executable.to_string_lossy(), Some(&display), RowSource::Registry);
            }
        }
    }
}

#[cfg(not(windows))]
fn registry_rows(_rows: &mut Vec<ScanRow>) {}

#[cfg(windows)]
fn shortcut_rows(rows: &mut Vec<ScanRow>) {
    let mut shortcuts = Vec::new();
    for variable in ["APPDATA", "ProgramData"] {
        let Some(root) = fixed_env(variable) else { continue; };
        let programs = Path::new(&root).join("Microsoft").join("Windows").join("Start Menu").join("Programs");
        collect_files(&programs, "lnk", 4, MAX_START_MENU_ITEMS, &mut shortcuts);
        if shortcuts.len() >= MAX_START_MENU_ITEMS { break; }
    }
    for shortcut in shortcuts.into_iter().take(MAX_START_MENU_ITEMS) {
        let display = shortcut.file_stem().and_then(|value| value.to_str()).map(str::to_owned);
        if let Some(target) = shortcut_target(&shortcut) {
            add_row(rows, &target, display.as_deref(), RowSource::StartMenu);
        }
    }
}

#[cfg(not(windows))]
fn shortcut_rows(_rows: &mut Vec<ScanRow>) {}

#[cfg(windows)]
fn process_rows(rows: &mut Vec<ScanRow>) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::EnumProcesses;
    use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};
    let mut pids = vec![0u32; 4096];
    let mut needed = 0u32;
    let ok = unsafe { EnumProcesses(pids.as_mut_ptr(), (pids.len() * 4) as u32, &mut needed) };
    if ok == 0 { return; }
    let count = (needed as usize / 4).min(pids.len());
    let mut added = 0usize;
    for pid in pids.into_iter().take(count) {
        if added >= MAX_PROCESSES { break; }
        if pid == 0 { continue; }
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() { continue; }
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        let ok = unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) };
        unsafe { CloseHandle(process); }
        if ok == 0 { continue; }
        let path = String::from_utf16_lossy(&buffer[..length as usize]);
        let display = Path::new(&path).file_stem().and_then(|value| value.to_str()).map(str::to_owned);
        add_row(rows, &path, display.as_deref(), RowSource::Process);
        added += 1;
    }
}

#[cfg(not(windows))]
fn process_rows(_rows: &mut Vec<ScanRow>) {}

/// Strip a trailing `.exe` without assuming the preceding byte is a character
/// boundary. `display[len - 4..]` panics when the last four bytes straddle a
/// multi-byte character (for example a name ending in "ü"), and the whole scan
/// used to die with it.
fn strip_exe_suffix(display: &str) -> String {
    if display.len() > 4 && display.to_ascii_lowercase().ends_with(".exe") {
        display[..display.len() - 4].to_owned()
    } else {
        display.to_owned()
    }
}

fn candidate_score(item: &GameApp, source: RowSource) -> i32 {
    let base = Path::new(&item.exe_path).file_stem().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    let display = item.display_name.to_ascii_lowercase().split(|character: char| !character.is_ascii_alphanumeric()).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
    let base_words = base.split(|character: char| !character.is_ascii_alphanumeric()).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
    let mut score = if source == RowSource::Registry { 20 } else { 0 };
    if base_words == display || display.starts_with(&format!("{base_words} ")) { score += 1000; }
    let lower = item.exe_path.to_ascii_lowercase();
    if lower.contains("\\game\\") { score += 100; }
    if lower.contains("\\bin\\x64\\") || lower.contains("\\bin\\win64\\") { score += 40; }
    if ["client", "ux", "render", "service", "helper", "tray", "runtime", "bootstrap", "launcher", "crash", "report", "setup", "assistant"]
        .iter().any(|suffix| base.ends_with(suffix)) { score -= 300; }
    score
}

fn normalize_rows(rows: Vec<ScanRow>, current_exe: &Value, excluded: &[Value], only_games: bool) -> Vec<GameApp> {
    let mut apps: Vec<GameApp> = Vec::new();
    let mut by_display: HashMap<String, usize> = HashMap::new();
    let mut by_path: HashMap<String, usize> = HashMap::new();
    for row in rows {
        let path_value = json!(row.exe_path);
        if !is_verified_executable_path(&path_value) { continue; }
        let Some(exe_path) = validate_safe_game_candidate(&path_value, current_exe, excluded, true) else { continue; };
        let basename = Path::new(&exe_path).file_name().and_then(|value| value.to_str()).unwrap_or("").to_owned();
        let process_name = row.process_name.as_deref().map(str::trim).filter(|value| !value.is_empty())
            .map(|value| value.chars().take(260).collect::<String>()).unwrap_or_else(|| basename.clone());
        let explicit_display = row.display_name.as_deref().map(str::trim).filter(|value| !value.is_empty());
        let display_raw = explicit_display.unwrap_or(&process_name).to_owned();
        let display_name = strip_exe_suffix(&display_raw);
        if only_games && !is_likely_game_candidate(&json!({"exePath": exe_path, "displayName": display_name, "processName": process_name})) { continue; }        let app = GameApp {
            artwork: row.artwork.clone().unwrap_or_else(|| deterministic_artwork_key(&json!(exe_path))),
            exe_path: exe_path.clone(),
            process_name: if process_name.is_empty() { basename } else { process_name },
            display_name,
            banner: row.banner.clone(),
        };
        if let Some(index) = by_path.get(&exe_path).copied() {
            let existing = &mut apps[index];
            if existing.process_name.is_empty() { existing.process_name = app.process_name; }
            if explicit_display.is_none() && existing.display_name.is_empty() { existing.display_name = app.display_name; }
            if existing.artwork.starts_with("fallback-") && !app.artwork.starts_with("fallback-") { existing.artwork = app.artwork; }
            if existing.banner.is_none() { existing.banner = app.banner; }
            continue;
        }
        let display_key = app.display_name.to_lowercase();
        if let Some(index) = by_display.get(&display_key).copied() {
            if candidate_score(&app, row.source) <= candidate_score(&apps[index], row.source) { continue; }
            by_display.remove(&display_key);
            by_path.remove(&apps[index].exe_path);
            apps.remove(index);
            for value in by_display.values_mut() {
                if *value > index { *value -= 1; }
            }
            for value in by_path.values_mut() {
                if *value > index { *value -= 1; }
            }
        }
        by_display.insert(display_key, apps.len());
        by_path.insert(exe_path, apps.len());
        apps.push(app);
    }
    apps.sort_by(|left, right| {
        let left_key = format!("{}\0{}", left.display_name.to_lowercase(), left.exe_path);
        let right_key = format!("{}\0{}", right.display_name.to_lowercase(), right.exe_path);
        left_key.cmp(&right_key)
            .then_with(|| left.display_name.cmp(&right.display_name))
            .then_with(|| left.exe_path.cmp(&right.exe_path))
    });
    apps
}

fn app_json(app: GameApp) -> Value {
    json!({
        "exePath": app.exe_path,
        "processName": app.process_name,
        "displayName": app.display_name,
        "artwork": app.artwork,
        "banner": app.banner,
        "source": "scan",
    })
}

fn row_from_value(row: &Value) -> Option<ScanRow> {
    let path = row.get("exePath").or_else(|| row.get("ExecutablePath"))?.as_str()?.trim();
    if path.is_empty() { return None; }
    let display = row.get("displayName").and_then(Value::as_str).map(str::to_owned);
    let process = row.get("processName").or_else(|| row.get("Name")).and_then(Value::as_str).map(str::to_owned);
    let artwork = row.get("artwork").filter(|value| is_valid_artwork(value)).and_then(Value::as_str).map(str::to_owned);
    let banner = row.get("banner").filter(|value| is_valid_banner(value)).and_then(Value::as_str).map(str::to_owned);
    let source = match row.get("source").and_then(Value::as_str).map(str::to_ascii_lowercase).as_deref() {
        Some("registry") => RowSource::Registry,
        Some("start-menu") => RowSource::StartMenu,
        _ => RowSource::Process,
    };
    Some(ScanRow { exe_path: path.replace('/', "\\"), display_name: display, process_name: process, artwork, banner, source })
}

/// Normalize scan-shaped rows supplied by an existing caller (catalog sync).
/// The same safe-candidate and optional game gate as the live scanner applies.
pub fn normalize_scanned_apps(rows: &Value, only_games: bool) -> Value {
    let current_exe = std::env::current_exe().ok().map(|path| json!(path.to_string_lossy())).unwrap_or(Value::Null);
    let excluded = excluded_paths();
    let rows = rows.as_array().into_iter().flatten().filter_map(row_from_value).collect::<Vec<_>>();
    json!(normalize_rows(rows, &current_exe, &excluded, only_games).into_iter().map(app_json).collect::<Vec<_>>())
}

fn image_pixel_area(bytes: &[u8], extension: &str) -> u64 {
    if extension == ".png" && bytes.len() >= 24
        && bytes[0..4] == [0x89, 0x50, 0x4e, 0x47] && bytes[4..8] == [0x0d, 0x0a, 0x1a, 0x0a] {
        let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap()) as u64;
        let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap()) as u64;
        return width.saturating_mul(height);
    }
    if (extension == ".jpg" || extension == ".jpeg") && bytes.len() >= 30 && bytes[0] == 0xff && bytes[1] == 0xd8 {
        let mut offset = 2usize;
        while offset + 9 < bytes.len() {
            if bytes[offset] != 0xff { offset += 1; continue; }
            let marker = bytes[offset + 1];
            if marker == 0xd8 || marker == 0xd9 || (0xd0..=0xd7).contains(&marker) { offset += 2; continue; }
            let length = u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]) as usize;
            if length < 2 || offset + 2 + length > bytes.len() { break; }
            if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
                let height = u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]]) as u64;
                let width = u16::from_be_bytes([bytes[offset + 7], bytes[offset + 8]]) as u64;
                return width.saturating_mul(height);
            }
            offset += 2 + length;
        }
    }
    if extension == ".webp" && bytes.len() >= 30
        && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" && &bytes[12..16] == b"VP8X" {
        let width = 1 + u64::from(bytes[24]) + (u64::from(bytes[25]) << 8) + (u64::from(bytes[26]) << 16);
        let height = 1 + u64::from(bytes[27]) + (u64::from(bytes[28]) << 8) + (u64::from(bytes[29]) << 16);
        return width.saturating_mul(height);
    }
    0
}

fn choose_best_artwork(candidates: &[ArtworkCandidate], max_bytes: u64) -> Option<String> {
    let mut accepted: Vec<(u64, usize, usize, &ArtworkCandidate, Vec<u8>)> = Vec::new();
    for (index, candidate) in candidates.iter().enumerate() {
        let Ok(bytes) = std::fs::read(&candidate.path) else { continue; };
        if bytes.is_empty() || bytes.len() as u64 > max_bytes { continue; }
        let area = image_pixel_area(&bytes, candidate.extension);
        accepted.push((area, bytes.len(), index, candidate, bytes));
    }
    accepted.sort_by(|left, right| {
        if left.0 > 0 || right.0 > 0 {
            right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)).then_with(|| left.2.cmp(&right.2))
        } else {
            left.2.cmp(&right.2)
        }
    });
    accepted.first().map(|(_, _, _, candidate, bytes)| {
        format!("data:{};base64,{}", candidate.mime, base64::engine::general_purpose::STANDARD.encode(bytes))
    })
}

fn parse_vdf_paths(text: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let lower = text.to_ascii_lowercase();
    let mut offset = 0;
    while let Some(found) = lower[offset..].find("\"path\"") {
        let start = offset + found + 6;
        let Some(quote_start) = text[start..].find('"') else { break; };
        let value_start = start + quote_start + 1;
        let mut value_end = value_start;
        let bytes = text.as_bytes();
        while value_end < bytes.len() {
            if bytes[value_end] == b'"' && (value_end == value_start || bytes[value_end - 1] != b'\\') { break; }
            value_end += 1;
        }
        if value_end >= bytes.len() { break; }
        let decoded = text[value_start..value_end].replace("\\\\", "\\").replace("\\\"", "\"");
        if !decoded.trim().is_empty() { paths.push(decoded.trim().to_owned()); }
        offset = value_end + 1;
    }
    paths
}

fn discover_steam_roots(library_root: &str) -> Vec<String> {
    let mut roots: Vec<String> = vec![library_root.to_owned()];
    for variable in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
        if let Some(base) = fixed_env(variable) {
            let candidate = Path::new(&base).join("Steam");
            if let Some(candidate) = candidate.to_str() {
                if !roots.iter().any(|root| root.eq_ignore_ascii_case(candidate)) { roots.push(candidate.to_owned()); }
            }
        }
    }
    for fallback in [r"C:\Program Files (x86)\Steam", r"C:\Program Files\Steam"] {
        if !roots.iter().any(|root| root.eq_ignore_ascii_case(fallback)) { roots.push(fallback.to_owned()); }
    }
    for root in roots.clone() {
        for file in ["steamapps/libraryfolders.vdf", "libraryfolders.vdf"] {
            let Ok(text) = std::fs::read_to_string(Path::new(&root).join(file)) else { continue; };
            for candidate in parse_vdf_paths(&text) {
                if !roots.iter().any(|root| root.eq_ignore_ascii_case(&candidate)) { roots.push(candidate); }
            }
        }
    }
    roots
}

fn steam_context(canonical: &str) -> Option<(String, String)> {
    let lower = canonical.to_ascii_lowercase();
    let marker = "\\steamapps\\common\\";
    let position = lower.find(marker)?;
    let steamapps = &canonical[..position + "\\steamapps".len()];
    let install = canonical[position + marker.len()..].split('\\').next()?.to_ascii_lowercase();
    let entries = std::fs::read_dir(steamapps).ok()?;
    let mut manifests: Vec<PathBuf> = entries.flatten().map(|entry| entry.path())
        .filter(|path| path.file_name().and_then(|name| name.to_str())
            .is_some_and(|name| name.len() > 12 && name.to_ascii_lowercase().starts_with("appmanifest_")
                && name.to_ascii_lowercase().ends_with(".acf")))
        .collect();
    manifests.sort();
    for manifest in manifests.into_iter().take(STEAM_MAX_MANIFESTS) {
        let Some(name) = manifest.file_name().and_then(|value| value.to_str()) else { continue; };
        let lower_name = name.to_ascii_lowercase();
        let Some(app_id) = lower_name.strip_prefix("appmanifest_").and_then(|name| name.strip_suffix(".acf")) else { continue; };
        let app_id = app_id.to_owned();
        let Ok(text) = std::fs::read_to_string(&manifest) else { continue; };
        let lower_text = text.to_ascii_lowercase();
        let Some(found) = lower_text.find("\"installdir\"") else { continue; };
        let rest = &text[found + 12..];
        let Some(start) = rest.find('"') else { continue; };
        let Some(end) = rest[start + 1..].find('"') else { continue; };
        let install_dir = rest[start + 1..start + 1 + end].to_ascii_lowercase();
        if install_dir == install {
            return Some((app_id, Path::new(steamapps).parent()?.to_string_lossy().into_owned()));
        }
    }
    None
}

fn steam_file_candidates(root: &str, app_id: &str) -> Vec<ArtworkCandidate> {
    let library_cache = Path::new(root).join("appcache").join("librarycache");
    let app_cache = library_cache.join(app_id);
    let mut candidates = Vec::new();
    for base in STEAM_ARTWORK_FILES {
        for (extension, mime) in POSTER_EXTENSIONS {
            candidates.push(ArtworkCandidate { path: library_cache.join(format!("{app_id}_{base}{extension}")), extension, mime });
            candidates.push(ArtworkCandidate { path: app_cache.join(format!("{base}{extension}")), extension, mime });
        }
    }
    candidates
}

fn steam_grid_candidates(root: &str, app_id: &str) -> Vec<ArtworkCandidate> {
    let mut candidates = Vec::new();
    let Ok(entries) = std::fs::read_dir(Path::new(root).join("userdata")) else { return candidates; };
    let mut users: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).filter(|path| path.is_dir()).collect();
    users.sort();
    for user in users.into_iter().take(STEAM_MAX_USERS) {
        let grid = user.join("config").join("grid");
        for suffix in STEAM_GRID_ARTWORK_FILES {
            for (extension, mime) in POSTER_EXTENSIONS {
                candidates.push(ArtworkCandidate { path: grid.join(format!("{app_id}{suffix}{extension}")), extension, mime });
            }
        }
    }
    candidates
}

fn find_banner(exe_path: &str) -> Option<String> {
    let canonical = canonical_exe_path(&json!(exe_path))?;
    let mut directories = Vec::new();
    let mut directory = Path::new(&canonical).parent();
    for _ in 0..3 {
        let Some(current) = directory else { break; };
        if !directories.iter().any(|value: &PathBuf| value == current) { directories.push(current.to_path_buf()); }
        directory = current.parent();
    }
    let mut candidates = Vec::new();
    for directory in &directories {
        for base in POSTER_NAMES {
            for (extension, mime) in POSTER_EXTENSIONS {
                candidates.push(ArtworkCandidate { path: directory.join(format!("{base}{extension}")), extension, mime });
            }
        }
    }
    if let Some(local) = choose_best_artwork(&candidates, POSTER_MAX_BYTES) { return Some(local); }
    let (app_id, root) = steam_context(&canonical)?;
    let mut steam = Vec::new();
    for library in discover_steam_roots(&root) {
        steam.extend(steam_file_candidates(&library, &app_id));
        steam.extend(steam_grid_candidates(&library, &app_id));
    }
    choose_best_artwork(&steam, POSTER_MAX_BYTES)
}

#[cfg(windows)]
fn icon_data_url(path: &str) -> Option<String> {
    use std::ffi::c_void;
    use windows_sys::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows_sys::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

    struct Icon(*mut c_void);
    impl Drop for Icon { fn drop(&mut self) { unsafe { DestroyIcon(self.0); } } }
    struct Bitmap(*mut c_void);
    impl Drop for Bitmap { fn drop(&mut self) { if !self.0.is_null() { unsafe { DeleteObject(self.0); } } } }

    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut info: SHFILEINFOW = unsafe { std::mem::zeroed() };
    let ok = unsafe { SHGetFileInfoW(wide.as_ptr(), 0, &mut info, std::mem::size_of::<SHFILEINFOW>() as u32, SHGFI_ICON | SHGFI_LARGEICON) };
    if ok == 0 || info.hIcon.is_null() { return None; }
    let icon = Icon(info.hIcon);
    let mut icon_info: ICONINFO = unsafe { std::mem::zeroed() };
    if unsafe { GetIconInfo(icon.0, &mut icon_info) } == 0 { return None; }
    let color = Bitmap(icon_info.hbmColor);
    let mask = Bitmap(icon_info.hbmMask);
    if color.0.is_null() { return None; }
    let mut bitmap: BITMAP = unsafe { std::mem::zeroed() };
    if unsafe { GetObjectW(color.0, std::mem::size_of::<BITMAP>() as i32, &mut bitmap as *mut _ as *mut c_void) } == 0 { return None; }
    let width = bitmap.bmWidth.max(0) as usize;
    let height = bitmap.bmHeight.max(0) as usize;
    if width == 0 || height == 0 || width > 1024 || height > 1024 { return None; }
    let mut header: BITMAPINFO = unsafe { std::mem::zeroed() };
    header.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    header.bmiHeader.biWidth = width as i32;
    header.bmiHeader.biHeight = -(height as i32);
    header.bmiHeader.biPlanes = 1;
    header.bmiHeader.biBitCount = 32;
    header.bmiHeader.biCompression = BI_RGB;
    let mut pixels = vec![0u8; width * height * 4];
    let dc = unsafe { GetDC(std::ptr::null_mut()) };
    if dc.is_null() { return None; }
    let lines = unsafe { GetDIBits(dc, color.0, 0, height as u32, pixels.as_mut_ptr() as *mut c_void, &mut header, DIB_RGB_COLORS) };
    let mut mask_pixels = vec![0u8; width * height * 4];
    let mask_lines = if mask.0.is_null() { 0 } else {
        unsafe { GetDIBits(dc, mask.0, 0, height as u32, mask_pixels.as_mut_ptr() as *mut c_void, &mut header, DIB_RGB_COLORS) }
    };
    unsafe { ReleaseDC(std::ptr::null_mut(), dc); }
    if lines == 0 { return None; }
    let has_alpha = pixels.chunks_exact(4).any(|pixel| pixel[3] != 0);
    let mut rgba = Vec::with_capacity(pixels.len());
    for (index, pixel) in pixels.chunks_exact(4).enumerate() {
        let mut alpha = pixel[3];
        if !has_alpha {
            alpha = if mask_lines != 0 && mask_pixels[index * 4] > 127 { 0 } else { 255 };
        }
        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], alpha]);
    }
    let mut encoded = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut encoded, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&rgba).ok()?;
    }
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(encoded)))
}

#[cfg(not(windows))]
fn icon_data_url(_path: &str) -> Option<String> { None }

fn enrich(apps: &mut [GameApp]) {
    let mut artwork_bytes = 0usize;
    let mut banner_bytes = 0usize;
    for app in apps.iter_mut().take(MAX_ARTWORK_ITEMS) {
        if let Some(icon) = icon_data_url(&app.exe_path) {
            if artwork_bytes + icon.len() <= MAX_ARTWORK_BYTES {
                artwork_bytes += icon.len();
                app.artwork = icon;
            }
        }
        if let Some(banner) = find_banner(&app.exe_path) {
            if banner_bytes + banner.len() <= MAX_BANNER_BYTES {
                banner_bytes += banner.len();
                app.banner = Some(banner);
            }
        }
    }
}

fn panic_detail(payload: &(dyn std::any::Any + Send)) -> String {
    payload.downcast_ref::<&str>().map(|text| (*text).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".to_owned())
}

pub fn scan() -> Value {
    match std::panic::catch_unwind(scan_inner) {
        Ok(value) => value,
        Err(payload) => {
            // Name the panic so a report is actionable instead of a dead end.
            let detail = panic_detail(payload.as_ref());
            json!({"apps": [], "error": format!("Game scan failed safely ({detail}); no catalog was changed")})
        }
    }
}

fn excluded_paths() -> Vec<Value> {
    let mut excluded = Vec::new();
    for variable in ["ARC_POWER_BROKER_EXECUTABLE", "ARC_POWER_HOST_EXECUTABLE"] {
        if let Some(path) = fixed_env(variable) { excluded.push(json!(path)); }
    }
    excluded
}

fn scan_inner() -> Value {
    let current_exe = std::env::current_exe().ok().map(|path| json!(path.to_string_lossy())).unwrap_or(Value::Null);
    let excluded = excluded_paths();
    let mut rows = Vec::new();
    // One malformed uninstall entry, shortcut or artwork file must not blank
    // the whole catalog; each phase is isolated.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| registry_rows(&mut rows)));
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| shortcut_rows(&mut rows)));
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| process_rows(&mut rows)));
    let mut apps = normalize_rows(rows, &current_exe, &excluded, true);
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| enrich(&mut apps)));
    json!({"apps": apps.into_iter().map(app_json).collect::<Vec<_>>()})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_detail_names_the_failure() {
        let payload = std::panic::catch_unwind(|| panic!("bad entry at index 3")).unwrap_err();
        let detail = panic_detail(payload.as_ref());
        assert!(detail.contains("bad entry at index 3"), "detail was {detail:?}");
        assert_eq!(panic_detail(&42u32), "unknown panic");
    }

    #[test]
    #[ignore = "live game scan on this machine"]
    fn live_scan_returns_apps_without_error() {
        let result = scan();
        assert!(result.get("error").is_none(), "scan reported {:?}", result.get("error"));
        let apps = result.get("apps").and_then(Value::as_array).expect("apps array");
        println!("LIVE_SCAN_APPS {}", apps.len());
        if let Some(first) = apps.first() {
            println!("LIVE_SCAN_FIRST {}", serde_json::to_string(first).unwrap_or_default());
        }
    }

    #[test]
    fn exe_suffix_stripping_never_splits_a_character() {
        // The old code sliced at len-4, which lands inside a 2-byte "ü" here
        // and panicked the entire scan on Unicode display names.
        assert_eq!(strip_exe_suffix("Grüße.exe"), "Grüße");
        assert_eq!(strip_exe_suffix("日本語.EXE"), "日本語");
        assert_eq!(strip_exe_suffix("Game.exe"), "Game");
        assert_eq!(strip_exe_suffix("NoSuffix"), "NoSuffix");
        assert_eq!(strip_exe_suffix("ends with ü"), "ends with ü");
        assert_eq!(strip_exe_suffix(".exe"), ".exe", "a name that is only the suffix is left alone");
    }

    #[test]
    fn env_expansion_and_display_icon_paths_are_bounded() {
        std::env::set_var("ARC_GAME_SCAN_TEST_ROOT", r"C:\Games");
        assert_eq!(expand_env(r"%ARC_GAME_SCAN_TEST_ROOT%\Tool.exe"), r"C:\Games\Tool.exe");
        assert_eq!(clean_path(r#""%ARC_GAME_SCAN_TEST_ROOT%\Tool.exe",0"#), r"C:\Games\Tool.exe");
        assert_eq!(expand_env("%ARC_GAME_SCAN_MISSING%\\x.exe"), "%ARC_GAME_SCAN_MISSING%\\x.exe");
    }

    #[test]
    fn image_area_reads_png_jpeg_and_webp_headers() {
        let mut png = vec![0u8; 24];
        png[0..8].copy_from_slice(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        png[16..20].copy_from_slice(&640u32.to_be_bytes());
        png[20..24].copy_from_slice(&360u32.to_be_bytes());
        assert_eq!(image_pixel_area(&png, ".png"), 230_400);

        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00];
        jpeg.extend_from_slice(&[0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x64, 0x00, 0xc8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(image_pixel_area(&jpeg, ".jpg"), 200 * 100);

        let mut webp = vec![0u8; 30];
        webp[0..4].copy_from_slice(b"RIFF");
        webp[8..12].copy_from_slice(b"WEBP");
        webp[12..16].copy_from_slice(b"VP8X");
        webp[24] = 2; webp[25] = 1; webp[27] = 1;
        assert_eq!(image_pixel_area(&webp, ".webp"), (1 + 2 + 256) * (1 + 1));
    }

    #[test]
    fn vdf_paths_are_decoded_and_deduplicated_by_callers() {
        let paths = parse_vdf_paths(r#"{"libraryfolders":{"0":{"path":"C:\\Games\\Steam"},"1":{"path":"D:\\Steam Library"}}}"#);
        assert_eq!(paths, vec![r"C:\Games\Steam".to_owned(), r"D:\Steam Library".to_owned()]);
    }

    #[cfg(windows)]
    #[test]
    fn candidate_normalization_keeps_only_existing_game_paths() {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("arc-game-scan-{}-{nonce}", std::process::id()));
        let game_dir = root.join("steamapps").join("common").join("Fixture Game");
        std::fs::create_dir_all(&game_dir).unwrap();
        let game = game_dir.join("Cyberpunk2077.exe");
        std::fs::write(&game, b"fixture only").unwrap();
        let rows = vec![
            ScanRow { exe_path: game.to_string_lossy().into_owned(), display_name: Some("Cyberpunk 2077".into()), process_name: Some("Cyberpunk2077.exe".into()), artwork: None, banner: None, source: RowSource::Registry },
            ScanRow { exe_path: root.join("missing.exe").to_string_lossy().into_owned(), display_name: Some("Missing Game".into()), process_name: None, artwork: None, banner: None, source: RowSource::Process },
        ];
        let apps = normalize_rows(rows, &Value::Null, &[], true);
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].display_name, "Cyberpunk 2077");
        assert!(apps[0].exe_path.ends_with("cyberpunk2077.exe"));
        assert!(apps[0].artwork.starts_with("fallback-"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "read-only live inventory probe; run explicitly on a desktop"]
    fn live_scan_is_read_only_and_bounded() {
        let result = scan();
        let apps = result["apps"].as_array().expect("scan result apps");
        assert!(apps.len() <= MAX_REGISTRY_ITEMS + MAX_START_MENU_ITEMS + MAX_PROCESSES);
        for app in apps {
            assert!(app["exePath"].as_str().is_some_and(|path| path.ends_with(".exe")));
            assert_eq!(app["source"], "scan");
            assert!(app["artwork"].as_str().is_some_and(|artwork| artwork.starts_with("data:image/") || artwork.starts_with("fallback-")));
        }
        eprintln!("live game scan produced {} apps", apps.len());
        for app in apps {
            eprintln!("  {} [{}] artwork={} banner={}", app["displayName"].as_str().unwrap_or("?"), app["exePath"].as_str().unwrap_or("?"), app["artwork"].as_str().map(str::len).unwrap_or(0), app["banner"].as_str().map(str::len).unwrap_or(0));
        }
    }

    #[cfg(windows)]
    #[test]
    fn shell_icon_extraction_returns_a_png_data_url() {
        let icon = icon_data_url(r"C:\Windows\System32\notepad.exe");
        if let Some(icon) = icon {
            assert!(icon.starts_with("data:image/png;base64,"));
            let encoded = icon.trim_start_matches("data:image/png;base64,");
            let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).unwrap();
            assert_eq!(&bytes[..8], &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        }
    }
}
