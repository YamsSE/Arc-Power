//! Windows system ICU collation with explicit caller-selected BCP47 locale.
//! No lexical fallback. OS ICU/CLDR may differ from Node/WebView2 ICU versions;
//! passing the same locale and options establishes the same comparison family,
//! not universal equality across data versions.
//!
//! Verified Windows SDK10.0.26100.0 um/icu.h: U_EXPORT2 is __cdecl;
//! UErrorCode/UColAttribute/UColAttributeValue/UCollationResult are int enums,
//! UChar is char16_t; U_FAILURE is status > 0 (negative values are warnings).
//! https://learn.microsoft.com/en-us/windows/win32/intl/international-components-for-unicode--icu-
use std::{cmp::Ordering, fmt};

pub const MAX_TEXT_UTF16_UNITS: usize = 1_048_576;
const MAX_LOCALE_BYTES: usize = 255;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sensitivity { Variant, Base }
#[derive(Clone, Debug)]
pub struct CollationError {pub operation: &'static str,pub status: Option<i32>,pub detail: String}
impl CollationError {
    fn local(operation:&'static str,detail:impl Into<String>)->Self {Self{operation,status:None,detail:detail.into()}}
    #[cfg(windows)]
    fn status(operation:&'static str,status:i32)->Self {Self{operation,status:Some(status),detail:format!("ICU error {status}")}}
}
impl fmt::Display for CollationError {
    fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result {write!(f,"{}: {}",self.operation,self.detail)}
}
impl std::error::Error for CollationError {}
fn validate_locale(locale:&str)->Result<(),CollationError> {
    if locale.is_empty()||locale.len()>MAX_LOCALE_BYTES||!locale.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-') {
        return Err(CollationError::local("locale","expected one bounded explicit BCP47 language tag"));
    }Ok(())
}
fn utf16(text:&str)->Result<Vec<u16>,CollationError> {
    let units:Vec<_>=text.encode_utf16().take(MAX_TEXT_UTF16_UNITS+1).collect();
    if units.len()>MAX_TEXT_UTF16_UNITS{return Err(CollationError::local("text","UTF-16 comparison input exceeds bound"));}Ok(units)
}

#[cfg(windows)]
pub use native::Collator;
#[cfg(not(windows))]
pub struct Collator;
#[cfg(not(windows))]
impl Collator {
    pub fn new(locale:&str,_sensitivity:Sensitivity)->Result<Self,CollationError> {
        validate_locale(locale)?;Err(CollationError::local("platform","Windows system ICU is unavailable"))
    }
    pub fn new_with_numeric(locale:&str,sensitivity:Sensitivity,_numeric:bool)->Result<Self,CollationError>{Self::new(locale,sensitivity)}
    pub fn compare(&mut self,_left:&str,_right:&str)->Result<Ordering,CollationError> {
        Err(CollationError::local("platform","Windows system ICU is unavailable"))
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{ffi::{c_char,c_void,CString},marker::PhantomData,ptr,rc::Rc};
    use windows_sys::Win32::{Foundation::{FreeLibrary,HMODULE},System::LibraryLoader::{
        GetProcAddress,LoadLibraryExW,LOAD_LIBRARY_SEARCH_SYSTEM32}};
    // icu.h UColAttribute sequential values: French=0, alternate=1, caseFirst=2,
    // caseLevel=3, normalization=4, strength=5; numeric=strength+2=7.
    const UCOL_CASE_LEVEL:i32=3;
    const UCOL_NORMALIZATION_MODE:i32=4;
    const UCOL_STRENGTH:i32=5;
    const UCOL_NUMERIC_COLLATION:i32=7;
    const UCOL_PRIMARY:i32=0;
    const UCOL_TERTIARY:i32=2;
    const UCOL_OFF:i32=16;
    const UCOL_ON:i32=17;
    type Open=unsafe extern "C" fn(*const c_char,*mut i32)->*mut c_void;
    type Close=unsafe extern "C" fn(*mut c_void);
    type Compare=unsafe extern "C" fn(*const c_void,*const u16,i32,*const u16,i32)->i32;
    type Attribute=unsafe extern "C" fn(*mut c_void,i32,i32,*mut i32);
    type ForLanguageTag=unsafe extern "C" fn(*const c_char,*mut c_char,i32,*mut i32,*mut i32)->i32;
    type Version=unsafe extern "C" fn(*mut u8);
    struct Library(HMODULE);
    impl Drop for Library {fn drop(&mut self){unsafe{FreeLibrary(self.0);}}}
    /// Thread-confined, mutable access: no concurrent use of UCollator. It owns
    /// its library for the entire collator lifetime and closes in that order.
    pub struct Collator {
        raw:*mut c_void,close:Close,compare:Compare,_library:Library,
        _thread_affinity:PhantomData<Rc<()>>,
        pub locale:String,pub sensitivity:Sensitivity,pub icu_version:[u8;4],
        /// ICU warnings (negative) are not errors; expose fallback diagnostics.
        pub open_warning:i32,
    }
    impl Collator {
        pub fn new(locale:&str,sensitivity:Sensitivity)->Result<Self,CollationError> {
            Self::open(locale,sensitivity,None)
        }
        /// Explicit numeric option overrides a locale Unicode `kn` extension,
        /// as Intl.Collator's options do.
        pub fn new_with_numeric(locale:&str,sensitivity:Sensitivity,numeric:bool)->Result<Self,CollationError>{
            Self::open(locale,sensitivity,Some(numeric))
        }
        fn open(locale:&str,sensitivity:Sensitivity,numeric:Option<bool>)->Result<Self,CollationError> {
            validate_locale(locale)?;
            let dll:Vec<u16>="icu.dll\0".encode_utf16().collect();
            let module=unsafe{LoadLibraryExW(dll.as_ptr(),ptr::null_mut(),LOAD_LIBRARY_SEARCH_SYSTEM32)};
            if module.is_null(){return Err(CollationError::local("LoadLibraryExW(icu.dll)",std::io::Error::last_os_error().to_string()));}
            let library=Library(module);
            macro_rules! bind {($name:literal,$ty:ty)=>{{
                let function=unsafe{GetProcAddress(module,concat!($name,"\0").as_ptr())}
                    .ok_or_else(||CollationError::local("GetProcAddress",concat!("missing ICU export ",$name)))?;
                unsafe{std::mem::transmute::<unsafe extern "system" fn()->isize,$ty>(function)}
            }};}
            let open=bind!("ucol_open",Open);let close=bind!("ucol_close",Close);
            let compare=bind!("ucol_strcoll",Compare);let attribute=bind!("ucol_setAttribute",Attribute);
            let for_tag=bind!("uloc_forLanguageTag",ForLanguageTag);let version=bind!("u_getVersion",Version);
            let input=CString::new(locale).map_err(|_|CollationError::local("locale","embedded NUL"))?;
            let mut locale_id=[0_i8;512];let mut parsed=0;let mut status=0;
            let length=unsafe{for_tag(input.as_ptr(),locale_id.as_mut_ptr(),locale_id.len() as i32,&mut parsed,&mut status)};
            if status>0{return Err(CollationError::status("uloc_forLanguageTag",status));}
            if parsed as usize!=locale.len()||length<0||length as usize>=locale_id.len(){return Err(CollationError::local("locale","language tag was not fully parsed within the locale bound"));}
            status=0;
            let raw=unsafe{open(locale_id.as_ptr(),&mut status)};
            if status>0||raw.is_null(){
                if !raw.is_null(){unsafe{close(raw);}}
                return Err(if status>0{CollationError::status("ucol_open",status)}else{CollationError::local("ucol_open","returned null collator")});
            }
            let warning=status;
            let mut icu_version=[0_u8;4];unsafe{version(icu_version.as_mut_ptr());}
            let result=Self{raw,close,compare,_library:library,_thread_affinity:PhantomData,
                locale:locale.into(),sensitivity,icu_version,open_warning:warning};
            // Intl's base/variant distinction: primary/tertiary, no extra case
            // level, with canonical-equivalence normalization enabled. Other
            // locale attributes (including Unicode extensions) stay ICU-owned.
            for (key,value) in [(UCOL_STRENGTH,match sensitivity{Sensitivity::Base=>UCOL_PRIMARY,Sensitivity::Variant=>UCOL_TERTIARY}),
                (UCOL_CASE_LEVEL,UCOL_OFF),(UCOL_NORMALIZATION_MODE,UCOL_ON)] {
                status=0;unsafe{attribute(raw,key,value,&mut status);}
                if status>0{return Err(CollationError::status("ucol_setAttribute",status));}
            }
            if let Some(numeric)=numeric{
                status=0;unsafe{attribute(raw,UCOL_NUMERIC_COLLATION,if numeric{UCOL_ON}else{UCOL_OFF},&mut status);}
                if status>0{return Err(CollationError::status("ucol_setAttribute(numeric)",status));}
            }
            Ok(result)
        }
        pub fn compare(&mut self,left:&str,right:&str)->Result<Ordering,CollationError> {
            let left=utf16(left)?;let right=utf16(right)?;self.compare_utf16(&left,&right)
        }
        /// Explicit lengths permit embedded NUL and preserve JS UTF-16 units,
        /// including unpaired surrogates supplied by an existing wire decoder.
        pub fn compare_utf16(&mut self,left:&[u16],right:&[u16])->Result<Ordering,CollationError> {
            if left.len()>MAX_TEXT_UTF16_UNITS||right.len()>MAX_TEXT_UTF16_UNITS {
                return Err(CollationError::local("text","UTF-16 comparison input exceeds bound"));
            }
            let l=i32::try_from(left.len()).map_err(|_|CollationError::local("text","left ICU length overflow"))?;
            let r=i32::try_from(right.len()).map_err(|_|CollationError::local("text","right ICU length overflow"))?;
            match unsafe{(self.compare)(self.raw,left.as_ptr(),l,right.as_ptr(),r)} {
                -1=>Ok(Ordering::Less),0=>Ok(Ordering::Equal),1=>Ok(Ordering::Greater),
                other=>Err(CollationError::local("ucol_strcoll",format!("invalid comparison result {other}"))),
            }
        }
    }
    impl Drop for Collator {fn drop(&mut self){unsafe{(self.close)(self.raw);}}}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn input_bounds_fail_without_loading_a_library() {
        for bad in ["","en_US","en\0US","en US"]{assert!(validate_locale(bad).is_err());}
        assert!(validate_locale(&"a".repeat(MAX_LOCALE_BYTES+1)).is_err());
        assert!(utf16(&"a".repeat(MAX_TEXT_UTF16_UNITS+1)).is_err());
        assert_eq!(utf16("😀\0").unwrap(),vec![0xd83d,0xde00,0]);
    }
    #[test]
    #[cfg(windows)]
    fn explicit_numeric_option_overrides_locale_extension(){
        let mut numeric=Collator::new_with_numeric("en-US",Sensitivity::Base,true).unwrap();
        assert_eq!(numeric.compare("File2","file10").unwrap(),Ordering::Less);
        let mut lexical=Collator::new_with_numeric("en-US-u-kn-true",Sensitivity::Base,false).unwrap();
        assert_eq!(lexical.compare("file2","file10").unwrap(),Ordering::Greater);
    }
    /// Runs only system ICU and a Node Intl oracle, never an application/GPU.
    /// A failure can expose OS/Node ICU data drift and must not be papered over.
    #[test]
    #[cfg(windows)]
    fn host_system_icu_matches_explicit_node_intl_comparison_matrix() {
        use serde_json::{json,Value};
        let pairs=[("pci:8086:@1:0.0","pci:8086:@10:0.0"),("a","A"),("a","ä"),
            ("z","ä"),("a\u{308}","ä"),("file2","file10"),("Å","Z"),("same","same"),("a\0b","ab")];
        for locale in ["en-US","de-DE","sv-SE","en-US-u-kn-true"] {
            for (sensitivity,label) in [(Sensitivity::Variant,"variant"),(Sensitivity::Base,"base")] {
                let input=json!({"locale":locale,"sensitivity":label,"pairs":pairs});
                let output=std::process::Command::new("node").args(["--input-type=module","-e",
                    "const q=JSON.parse(process.argv[1]);const c=new Intl.Collator(q.locale,{sensitivity:q.sensitivity});console.log(JSON.stringify({icu:process.versions.icu,orders:q.pairs.map(([a,b])=>Math.sign(c.compare(a,b)))}));",
                    &input.to_string()]).output().expect("Node is required for host differential collation test");
                assert!(output.status.success(),"Node oracle failed: {}",String::from_utf8_lossy(&output.stderr));
                let expected:Value=serde_json::from_slice(&output.stdout).unwrap();
                let mut collator=Collator::new(locale,sensitivity).unwrap();
                for (index,(left,right)) in pairs.iter().enumerate() {
                    let actual=match collator.compare(left,right).unwrap(){Ordering::Less=>-1,Ordering::Equal=>0,Ordering::Greater=>1};
                    assert_eq!(actual,expected["orders"][index].as_i64().unwrap(),
                        "{locale}/{label} {left:?}/{right:?}; OS ICU {:?}, Node ICU {}",collator.icu_version,expected["icu"]);
                }
            }
        }
    }
}
