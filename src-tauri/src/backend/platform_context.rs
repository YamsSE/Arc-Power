//! Read-only platform inputs replacing Electron path/clock/UUID context.
//! Known folders honor current-user redirection; lookup creates nothing and
//! does not decide whether a later file mutation is permitted at that path.
//! API contracts verified against Windows SDK10.0.26100.0 and Microsoft docs:
//! https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shgetknownfolderpath
//! https://learn.microsoft.com/en-us/windows/win32/api/winnls/nf-winnls-getuserdefaultlocalename
//! https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-getsystemtime
use rand::RngCore;
use serde::Serialize;
use std::{fmt,path::PathBuf,time::{Duration,SystemTime,UNIX_EPOCH}};

#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct PlatformError {pub operation:&'static str,pub code:Option<i64>,pub detail:String}
impl PlatformError {
    fn local(operation:&'static str,detail:impl Into<String>)->Self{Self{operation,code:None,detail:detail.into()}}
    #[cfg(windows)]
    fn last(operation:&'static str)->Self{let e=std::io::Error::last_os_error();Self{operation,code:e.raw_os_error().map(i64::from),detail:e.to_string()}}
}
impl fmt::Display for PlatformError{fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result{write!(f,"{}: {}",self.operation,self.detail)}}
impl std::error::Error for PlatformError{}

#[derive(Clone,Debug,PartialEq,Serialize)]
#[serde(rename_all="camelCase")]
pub struct ClockSnapshot {pub now_ms:f64,pub now_iso:String}
impl super::stability_contract::StabilityClock for ClockSnapshot {
    fn now_ms(&self)->f64{self.now_ms}
    fn now_iso(&self)->&str{&self.now_iso}
}
fn days_from_civil(year:i64,month:i64,day:i64)->i64{
    let year=year-i64::from(month<=2);let era=year.div_euclid(400);let yoe=year-era*400;
    let mp=month+if month>2{-3}else{9};let doy=(153*mp+2)/5+day-1;
    era*146097+yoe*365+yoe/4-yoe/100+doy-719468
}
fn civil_from_days(days:i64)->(i64,i64,i64){
    let days=days+719468;let era=days.div_euclid(146097);let doe=days-era*146097;
    let yoe=(doe-doe/1460+doe/36524-doe/146096)/365;let mut year=yoe+era*400;
    let doy=doe-(365*yoe+yoe/4-yoe/100);let mp=(5*doy+2)/153;
    let day=doy-(153*mp+2)/5+1;let month=mp+if mp<10{3}else{-9};year+=i64::from(month<=2);
    (year,month,day)
}
impl ClockSnapshot {
    /// One supplied instant drives both values. Fractional milliseconds are
    /// truncated consistently with JavaScript's integer-millisecond context.
    pub fn from_system_time(time:SystemTime)->Result<Self,PlatformError>{
        let millis=match time.duration_since(UNIX_EPOCH){
            Ok(d)=>i64::try_from(d.as_millis()).map_err(|_|PlatformError::local("clock","epoch overflow"))?,
            Err(e)=>-i64::try_from(e.duration().as_millis()).map_err(|_|PlatformError::local("clock","epoch overflow"))?,
        };
        let days=millis.div_euclid(86_400_000);let within=millis.rem_euclid(86_400_000);
        let(year,month,day)=civil_from_days(days);
        if !(1..=9999).contains(&year){return Err(PlatformError::local("clock","UTC year outside four-digit ISO contract"));}
        Ok(Self{now_ms:millis as f64,now_iso:format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
            within/3_600_000,(within/60_000)%60,(within/1000)%60,within%1000)})
    }
}
#[cfg(windows)]
pub fn clock_snapshot()->Result<ClockSnapshot,PlatformError>{
    use windows_sys::Win32::{Foundation::SYSTEMTIME,System::SystemInformation::GetSystemTime};
    let mut utc:SYSTEMTIME=unsafe{std::mem::zeroed()};unsafe{GetSystemTime(&mut utc);}
    let(year,month,day)=(i64::from(utc.wYear),i64::from(utc.wMonth),i64::from(utc.wDay));
    if !(1..=9999).contains(&year)||!(1..=12).contains(&month)||!(1..=31).contains(&day)
        ||utc.wHour>23||utc.wMinute>59||utc.wSecond>59||utc.wMilliseconds>999{
        return Err(PlatformError::local("GetSystemTime","invalid UTC fields"));
    }
    let days=days_from_civil(year,month,day);
    if civil_from_days(days)!=(year,month,day){return Err(PlatformError::local("GetSystemTime","invalid UTC calendar date"));}
    let millis=days*86_400_000+i64::from(utc.wHour)*3_600_000+i64::from(utc.wMinute)*60_000+i64::from(utc.wSecond)*1000+i64::from(utc.wMilliseconds);
    let duration=Duration::from_millis(millis.unsigned_abs());
    let instant=if millis>=0{UNIX_EPOCH.checked_add(duration)}else{UNIX_EPOCH.checked_sub(duration)}
        .ok_or_else(||PlatformError::local("clock","SystemTime overflow"))?;
    ClockSnapshot::from_system_time(instant)
}
#[cfg(not(windows))]
pub fn clock_snapshot()->Result<ClockSnapshot,PlatformError>{ClockSnapshot::from_system_time(SystemTime::now())}

fn uuid_from_bytes(mut bytes:[u8;16])->String{
    bytes[6]=(bytes[6]&0x0f)|0x40;bytes[8]=(bytes[8]&0x3f)|0x80;
    let text:String=bytes.iter().map(|b|format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}",&text[..8],&text[8..12],&text[12..16],&text[16..20],&text[20..])
}
/// OS-backed randomness; RNG failure is returned rather than using a weak seed.
pub fn uuid_v4()->Result<String,PlatformError>{
    let mut bytes=[0_u8;16];rand::rngs::OsRng.try_fill_bytes(&mut bytes)
        .map_err(|e|PlatformError::local("uuid-rng",e.to_string()))?;Ok(uuid_from_bytes(bytes))
}

const MAX_LOCALE_UNITS:usize=85; // LOCALE_NAME_MAX_LENGTH, SDK um/winnt.h:2357.
const MAX_PATH_UNITS:usize=32768;
fn decode_locale(units:&[u16])->Result<String,PlatformError>{
    if units.is_empty()||units.len()>MAX_LOCALE_UNITS||units.last()!=Some(&0)||units[..units.len()-1].contains(&0){
        return Err(PlatformError::local("locale","invalid bounded NUL-terminated UTF-16 locale"));
    }
    let locale=String::from_utf16(&units[..units.len()-1]).map_err(|_|PlatformError::local("locale","invalid UTF-16"))?;
    if locale.is_empty()||!locale.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-')||locale.split('-').any(str::is_empty){
        return Err(PlatformError::local("locale","Windows locale is not a supported BCP47-form name"));
    }Ok(locale)
}
/// OS user locale, not a claim about a browser's potentially overridden locale.
#[cfg(windows)]
pub fn current_user_bcp47_locale()->Result<String,PlatformError>{
    let mut units=[0_u16;MAX_LOCALE_UNITS];
    let length=unsafe{windows_sys::Win32::Globalization::GetUserDefaultLocaleName(units.as_mut_ptr(),units.len() as i32)};
    if length==0{return Err(PlatformError::last("GetUserDefaultLocaleName"));}
    if length<0||length as usize>units.len(){return Err(PlatformError::local("locale","invalid returned locale length"));}
    decode_locale(&units[..length as usize])
}
#[cfg(not(windows))]
pub fn current_user_bcp47_locale()->Result<String,PlatformError>{Err(PlatformError::local("platform","Windows user locale is unavailable"))}

#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize)]
#[serde(rename_all="camelCase")]
pub enum KnownFolder {Videos,Pictures,Downloads,Desktop,Documents,RoamingAppData,LocalAppData}
#[cfg(windows)]
pub fn known_folder_path(folder:KnownFolder)->Result<PathBuf,PlatformError>{
    use std::{ffi::OsString,os::windows::ffi::OsStringExt,ptr};
    use windows_sys::Win32::{System::Com::CoTaskMemFree,UI::Shell::{SHGetKnownFolderPath,
        FOLDERID_Videos,FOLDERID_Pictures,FOLDERID_Downloads,FOLDERID_Desktop,FOLDERID_Documents,FOLDERID_RoamingAppData,FOLDERID_LocalAppData,KF_FLAG_DONT_VERIFY}};
    let id=match folder{KnownFolder::Videos=>FOLDERID_Videos,KnownFolder::Pictures=>FOLDERID_Pictures,
        KnownFolder::Downloads=>FOLDERID_Downloads,KnownFolder::Desktop=>FOLDERID_Desktop,KnownFolder::Documents=>FOLDERID_Documents,
        KnownFolder::RoamingAppData=>FOLDERID_RoamingAppData,KnownFolder::LocalAppData=>FOLDERID_LocalAppData};
    struct ReturnedPath(*mut u16);
    impl Drop for ReturnedPath{fn drop(&mut self){if !self.0.is_null(){unsafe{CoTaskMemFree(self.0.cast());}}}}
    let mut raw=ptr::null_mut();
    // DONT_VERIFY bypasses existence checks without creating or requesting the
    // default unredirected location. NULL token means the current user.
    let status=unsafe{SHGetKnownFolderPath(&id,KF_FLAG_DONT_VERIFY as u32,ptr::null_mut(),&mut raw)};
    let owned=ReturnedPath(raw); // Free even when HRESULT indicates failure.
    if status<0{return Err(PlatformError{operation:"SHGetKnownFolderPath",code:Some(i64::from(status)),detail:format!("HRESULT 0x{:08x}",status as u32)});}
    if owned.0.is_null(){return Err(PlatformError::local("known-folder","success returned null path"));}
    let mut length=0;
    while length<MAX_PATH_UNITS&&unsafe{*owned.0.add(length)}!=0{length+=1;}
    if length==0||length==MAX_PATH_UNITS{return Err(PlatformError::local("known-folder","empty or oversized path"));}
    let path=PathBuf::from(OsString::from_wide(unsafe{std::slice::from_raw_parts(owned.0,length)}));
    if !path.is_absolute(){return Err(PlatformError::local("known-folder","OS returned nonabsolute folder path"));}
    Ok(path)
}
#[cfg(not(windows))]
pub fn known_folder_path(_folder:KnownFolder)->Result<PathBuf,PlatformError>{Err(PlatformError::local("platform","Windows known folders are unavailable"))}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn fixed_epoch_clock_is_consistent_utc_with_millisecond_precision(){
        for (millis,expected) in [(0_i64,"1970-01-01T00:00:00.000Z"),(-1,"1969-12-31T23:59:59.999Z"),
            (951_827_696_789,"2000-02-29T12:34:56.789Z"),(4_107_542_400_000,"2100-03-01T00:00:00.000Z")]{
            let duration=Duration::from_millis(millis.unsigned_abs());
            let time=if millis>=0{UNIX_EPOCH+duration}else{UNIX_EPOCH-duration};
            let snapshot=ClockSnapshot::from_system_time(time).unwrap();assert_eq!(snapshot.now_iso,expected);assert_eq!(snapshot.now_ms,millis as f64);
        }
    }
    #[test]
    fn civil_calendar_roundtrips_leap_and_century_boundaries(){
        for y in [1601,1900,1969,1970,2000,2026,2100,2400,9999]{for m in 1..=12{for d in [1,28]{assert_eq!(civil_from_days(days_from_civil(y,m,d)),(y,m,d));}}}
    }
    #[test]
    fn uuid_version_and_variant_bits_are_fixed_without_weak_randomness(){
        assert_eq!(uuid_from_bytes([0;16]),"00000000-0000-4000-8000-000000000000");
        assert_eq!(uuid_from_bytes([255;16]),"ffffffff-ffff-4fff-bfff-ffffffffffff");
        let random=uuid_v4().unwrap();assert_eq!(random.len(),36);assert_eq!(&random[14..15],"4");assert!(matches!(&random[19..20],"8"|"9"|"a"|"b"));
    }
    #[test]
    fn locale_decoding_checks_length_terminator_utf16_and_bcp47_form(){
        assert_eq!(decode_locale(&"de-DE\0".encode_utf16().collect::<Vec<_>>()).unwrap(),"de-DE");
        for bad in [vec![],vec![0xd800,0],vec![65],vec![65,0,66,0],vec![0],vec![0;86]]{assert!(decode_locale(&bad).is_err());}
        assert!(decode_locale(&"de-DE_phoneb\0".encode_utf16().collect::<Vec<_>>()).is_err());
    }
    #[test]
    #[cfg(windows)]
    fn host_locale_clock_and_redirected_folder_lookups_are_read_only(){
        assert!(!current_user_bcp47_locale().unwrap().is_empty());
        let snapshot=clock_snapshot().unwrap();assert!(snapshot.now_ms>0.0);assert!(snapshot.now_iso.ends_with('Z'));
        for folder in [KnownFolder::Videos,KnownFolder::Pictures,KnownFolder::Downloads,KnownFolder::Desktop,KnownFolder::Documents,KnownFolder::RoamingAppData,KnownFolder::LocalAppData]{
            assert!(known_folder_path(folder).unwrap().is_absolute());
        }
    }
}
