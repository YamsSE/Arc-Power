//! Executable identity and scan-ingress policy ported from game-candidate.js.
//! Canonical IDs are lexical Win32 paths, not proof of a filesystem identity.
use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

fn js_trim(text:&str)->&str {
    text.trim_matches(|c:char|matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
fn drive_absolute(path:&str)->bool {
    let bytes=path.as_bytes();bytes.len()>=3&&bytes[0].is_ascii_alphabetic()&&bytes[1]==b':'&&bytes[2]==b'\\'
}
fn normalize_absolute_tail(tail:&str)->String {
    let mut parts=Vec::new();
    for part in tail.split('\\') {
        match part {""|"."=>{},".."=>{parts.pop();},_=>parts.push(part)}
    }
    parts.join("\\")
}

/// Same accepted outputs as canonicalExePath/path.win32.normalize. Relative
/// and root-relative inputs cannot become accepted absolute IDs (including
/// Node's colon/CVE guards), so they fail before normalization is needed.
pub fn canonical_exe_path(value:&Value)->Option<String> {
    let text=js_trim(value.as_str()?);
    if text.is_empty()||text.encode_utf16().count()>32768 {return None;}
    let mut path=text.replace('/',"\\");
    if (path.starts_with("\\\\?\\")||path.starts_with("\\\\.\\"))&&drive_absolute(&path[4..]) {path=path[4..].to_owned();}
    if let Some(rest)=path.strip_prefix("\\\\") {
        let first=rest.split('\\').next().unwrap_or("").to_ascii_lowercase();
        if matches!(first.as_str(),"?"|"."|"device"|"globalroot") {return None;}
    }
    let (root,tail)=if drive_absolute(&path) {
        (path[..2].to_owned(),&path[3..])
    } else if let Some(rest)=path.strip_prefix("\\\\") {
        let first_end=rest.find('\\')?;
        if first_end==0 {return None;}
        let server=&rest[..first_end];
        let after_server=rest[first_end..].trim_start_matches('\\');
        if after_server.is_empty(){return None;}
        let share_end=after_server.find('\\').unwrap_or(after_server.len());
        let share=&after_server[..share_end];
        (format!("\\\\{server}\\{share}"),&after_server[share_end..])
    } else {return None;};
    let mut normalized_tail=normalize_absolute_tail(tail);
    if !normalized_tail.is_empty()&&path.ends_with('\\'){normalized_tail.push('\\');}
    let normalized=format!("{root}\\{normalized_tail}");
    if !normalized.to_ascii_lowercase().ends_with(".exe"){return None;}
    Some(normalized.to_lowercase())
}

pub fn canonical_win32_exe_path(value:&Value)->Option<String> {canonical_exe_path(value)}
fn basename(path:&str)->&str {path.rsplit('\\').next().unwrap_or(path)}
fn cached_regex(cell:&'static OnceLock<Regex>,source:&str)->&'static Regex {cell.get_or_init(||Regex::new(source).expect("fixed game-candidate expression"))}
fn unsafe_candidate(text:&str)->bool {
    static RE:OnceLock<Regex>=OnceLock::new();
    cached_regex(&RE,r"^(?:uninstall(?:er|helper)?|unins[0-9]*|crash(?:report)?|(?:error|wer)report|update(?:r)?|launcher|bootstrapper|setup|install|adapter[_-]?info|detectarchitecture|directstoragecollector|dxinfo|storage(?:reader)?|systeminfo(?:helper|setupassistant)?)\.exe$").is_match(&text.to_ascii_lowercase())
}
fn league_helper(text:&str)->bool {
    static RE:OnceLock<Regex>=OnceLock::new();
    cached_regex(&RE,r"^leagueclientux(?:render)?(?:\.exe)?$").is_match(&text.to_ascii_lowercase())
}
pub fn is_verified_executable_path(value:&Value)->bool {
    canonical_exe_path(value).is_some_and(|p|!unsafe_candidate(basename(&p))&&!league_helper(basename(&p)))
}
fn title(text:&str)->bool {
    static RE:OnceLock<Regex>=OnceLock::new();
    cached_regex(&RE,r"(?:3dmark|assassin['’]?s creed|crusader kings|final fantasy|league of legends|monster hunter|palworld|(?-u:\b)peak(?-u:\b)|star wars outlaws|teamfight tactics|valorant|counter[- ]strike|fortnite|apex legends|dota(?: 2)?|elden ring|cyberpunk|grand theft auto|red dead redemption|the witcher|baldur['’]?s gate|diablo|overwatch|destiny|minecraft)").is_match(&text.to_ascii_lowercase())
}
fn non_game(text:&str)->bool {
    static RE:OnceLock<Regex>=OnceLock::new();
    cached_regex(&RE,r"(?:^|[\\/ ._-])(?:7[- ]?zip|administrative tools|aida64|applicationframehost|ascent(?:[-_]gep)?|asrrgbled|backgroundtaskhost|benchmate|charmap|chatgpt|codex|conhost|cpu[- ]?z|crashhelper|crossdevice|dataexchangehost|desktop overlay host|discord|disk cleanup|dismhost|enhancedrpc|explorer|firefox|free download manager|gameinputredistservice|git(?:[- ]|$)|google chrome|hisuite|hwinfo|intel(?:r)? graphics|iscsicpl|lm studio|magnify|microsoft|morepowertool|msiafterburner|msedgewebview2|narrator|node(?:\.exe)?|obs(?: studio)?|opencode|paint\.net|paradox launcher|pawnio|powershell|predatorbifrost|rpcs3|riot client|riotclientservices|rivatuner|roccat|runtimebroker|searchhost|shell(?:experience)?host|snippingtool|steam(?:webhelper)?|systemsettings|task(?:mgr|host)|teamspeak|turtle beach|ubisoft connect|vanguard|wallpaper engine|windows|winrar|xboxpcappft)(?:$|[\\/ ._-])").is_match(&text.to_ascii_lowercase())
}
fn game_library(path:&str)->bool {
    static RE:OnceLock<Regex>=OnceLock::new();
    let lower=path.to_ascii_lowercase();
    if cached_regex(&RE,r"\\(?:steamapps\\common|gog galaxy\\games|xboxgames|riot games\\[^\\]+\\game|ubisoft(?: game launcher)?\\(?:games|[^\\]+)|battle\.net\\games)\\").is_match(&lower) {return true;}
    // Preserve the original Epic branch literally: the final outer separator
    // follows its negative lookahead, rather than silently fixing the source.
    static EPIC:OnceLock<Regex>=OnceLock::new();
    cached_regex(&EPIC,r"\\epic games\\[^\\]+\\").find_iter(&lower).any(|m|{
        let rest=&lower[m.end()..];!rest.starts_with("directxredist")&&rest.starts_with('\\')
    })
}
fn js_string(value:Option<&Value>)->String {
    match value {
        None=>String::new(),Some(Value::Null)=>"null".into(),Some(Value::String(s))=>s.clone(),
        Some(Value::Array(items))=>items.iter().map(|v|if v.is_null(){String::new()}else{js_string(Some(v))}).collect::<Vec<_>>().join(","),
        Some(Value::Object(_))=>"[object Object]".into(),Some(value)=>value.to_string(),
    }
}
pub fn is_likely_game_candidate(raw:&Value)->bool {
    let Some(canonical)=canonical_exe_path(&raw["exePath"])else{return false;};
    if !is_verified_executable_path(&Value::String(canonical.clone())){return false;}
    let display=js_string(raw.get("displayName"));let process=js_string(raw.get("processName"));
    if league_helper(basename(&canonical))||league_helper(js_trim(&display))||league_helper(js_trim(&process)){return false;}
    if non_game(&format!("{canonical} {display} {process}")) {
        let lower=canonical.to_ascii_lowercase();
        if !title(&format!("{display} {canonical}"))||!["\\game\\","\\steamapps\\common\\","\\ubisoft\\"].iter().any(|part|lower.contains(part)){return false;}
    }
    game_library(&canonical)||title(&format!("{display} {process} {canonical}"))
}

const KNOWN_NON_GAME_EXECUTABLES:&[&str]=&[
    "applicationframehost.exe","backgroundtaskhost.exe","brave.exe","calculator.exe",
    "chatgpt.exe","chrome.exe","chromium.exe","codex.exe","discord.exe","explorer.exe",
    "firefox.exe","msedge.exe","msedgewebview2.exe","opera.exe","outlook.exe",
    "runtimebroker.exe","safari.exe","searchhost.exe","slack.exe","steam.exe",
    "steamwebhelper.exe","systemsettings.exe","teams.exe","vivaldi.exe","waterfox.exe",
];
pub fn is_known_non_game_executable(value:&Value)->bool {
    canonical_exe_path(value).is_some_and(|p|KNOWN_NON_GAME_EXECUTABLES.contains(&basename(&p)))
}

/// Explicit current-executable identity replaces the JS process.execPath input.
/// No filesystem query is performed when require_exists is false.
pub fn validate_safe_game_candidate_with_exists(
    value:&Value,current_exe:&Value,excluded_paths:&[Value],require_exists:bool,
    is_file:impl FnOnce(&str)->bool,
)->Option<String> {
    let canonical=canonical_exe_path(value)?;
    if !is_verified_executable_path(&Value::String(canonical.clone())){return None;}
    if std::iter::once(current_exe).chain(excluded_paths).filter_map(canonical_exe_path).any(|p|p==canonical){return None;}
    static ARC:OnceLock<Regex>=OnceLock::new();
    if cached_regex(&ARC,r"^arc[ ._-]*power(?:[ ._-].*)?\.exe$").is_match(basename(&canonical)){return None;}
    if require_exists&&!is_file(&canonical){return None;}
    Some(canonical)
}
pub fn validate_safe_game_candidate(value:&Value,current_exe:&Value,excluded_paths:&[Value],require_exists:bool)->Option<String> {
    validate_safe_game_candidate_with_exists(value,current_exe,excluded_paths,require_exists,|path|std::fs::metadata(path).map(|m|m.is_file()).unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn original_js_differential_path_heuristic_and_validation_contract() {
        let fixture:Value=serde_json::from_str(include_str!("fixtures/game-candidate-contract.json")).unwrap();
        for (index,case) in fixture["pathCases"].as_array().unwrap().iter().enumerate(){
            assert_eq!(canonical_exe_path(&case["value"]).map(Value::String).unwrap_or(Value::Null),case["canonical"],"path case {index}: {:?}",case["value"]);
            assert_eq!(json!(is_verified_executable_path(&case["value"])),case["verified"],"verified case {index}");
            assert_eq!(json!(is_known_non_game_executable(&case["value"])),case["known"],"known case {index}");
        }
        for (index,case) in fixture["likely"].as_array().unwrap().iter().enumerate(){
            assert_eq!(json!(is_likely_game_candidate(&case["raw"])),case["result"],"likely case {index}: {:?}",case["raw"]);
        }
        for (index,case) in fixture["validations"].as_array().unwrap().iter().enumerate(){
            let exists=|path:&str|fixture["files"].as_array().unwrap().iter().any(|v|v.as_str()==Some(path));
            let result=validate_safe_game_candidate_with_exists(&case["value"],&fixture["currentExe"],case["options"]["excludedPaths"].as_array().unwrap(),case["options"]["requireExists"].as_bool().unwrap(),exists);
            assert_eq!(result.map(Value::String).unwrap_or(Value::Null),case["result"],"validation case {index}");
        }
    }

    #[test]
    fn utf16_path_limit_js_whitespace_and_namespaces() {
        let prefix="C:\\";let suffix=".exe";
        let at_limit=format!("{prefix}{}{suffix}","a".repeat(32768-prefix.len()-suffix.len()));
        assert!(canonical_exe_path(&json!(at_limit)).is_some());
        assert!(canonical_exe_path(&json!(format!("C:\\{}.exe","😀".repeat(16381)))).is_none());
        assert!(canonical_exe_path(&json!(format!("{at_limit}a"))).is_none());
        assert_eq!(canonical_exe_path(&json!("\u{feff} C:/A.EXE \u{00a0}")),Some("c:\\a.exe".into()));
        assert!(canonical_exe_path(&json!("\u{0085}C:/a.exe")).is_none());
        for path in ["//?/UNC/server/share/a.exe","//Device/Harddisk/a.exe","//GlobalRoot/device/a.exe","//?/C:a.exe"] {assert!(canonical_exe_path(&json!(path)).is_none());}
    }

    #[test]
    fn missing_existence_requirement_performs_no_filesystem_probe() {
        let path=json!("C:/Games/A.exe");
        let out=validate_safe_game_candidate_with_exists(&path,&Value::Null,&[],false,|_|panic!("existence was not requested"));
        assert_eq!(out,Some("c:\\games\\a.exe".into()));
        assert!(validate_safe_game_candidate_with_exists(&path,&Value::Null,&[],true,|_|false).is_none());
        assert!(validate_safe_game_candidate_with_exists(&path,&path,&[],true,|_|panic!("excluded path should not be probed")).is_none());
    }

    #[test]
    fn native_file_check_is_read_only_and_accepts_only_regular_files() {
        // Use a fixture under a fresh temporary directory; never launch it.
        let nonce=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let temp=std::env::temp_dir().join(format!("arc-game-candidate-{}-{nonce}",std::process::id()));
        std::fs::create_dir(&temp).unwrap();let path=temp.join("game.exe");
        std::fs::write(&path,b"fixture only, not executable").unwrap();
        #[cfg(windows)] {
            let raw=json!(path.to_string_lossy());
            assert!(validate_safe_game_candidate(&raw,&Value::Null,&[],true).is_some());
            std::fs::remove_file(&path).unwrap();std::fs::create_dir(&path).unwrap();
            assert!(validate_safe_game_candidate(&raw,&Value::Null,&[],true).is_none());
            std::fs::remove_dir(&path).unwrap();
        }
        #[cfg(not(windows))] std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&temp).unwrap();
    }
}
