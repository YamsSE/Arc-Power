//! One-time, best-effort installation of the already-bundled official PawnIO
//! setup. The installer is only started from an elevated host, silently, and
//! is always bounded; telemetry remains available if any step fails.
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

const INSTALLER_ARGS: &[&str] = &["-install", "-silent"];
const INSTALLER_TIMEOUT: Duration = Duration::from_secs(120);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const DEVICE_PATH: &str = r"\\?\GLOBALROOT\Device\PawnIO";
const SERVICE_KEY: &str = r"SYSTEM\CurrentControlSet\Services\PawnIO";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InstallOutcome {
    AlreadyInstalled,
    Installed,
    InstallFailed(String),
    InstallerMissing,
}

#[derive(Clone)]
enum ProcessState {
    Running,
    Exited(Option<i32>),
}

trait InstallerProcess {
    fn try_wait(&mut self) -> Result<ProcessState, String>;
    fn kill(&mut self) -> Result<(), String>;
}

trait PawnIoApi {
    fn device_present(&self) -> bool;
    fn service_present(&self) -> bool;
    fn elevated(&self) -> bool;
    fn installer_path(&self) -> Option<PathBuf>;
    fn spawn_installer(&self, path: &Path, args: &[&str]) -> Result<Box<dyn InstallerProcess>, String>;
}

struct SystemApi;

impl PawnIoApi for SystemApi {
    fn device_present(&self) -> bool {
        #[cfg(windows)]
        {
            use std::{os::windows::ffi::OsStrExt, ptr};
            use windows_sys::Win32::{
                Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE},
                Storage::FileSystem::{CreateFileW, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING},
            };

            let path: Vec<u16> = std::ffi::OsStr::new(DEVICE_PATH).encode_wide().chain(Some(0)).collect();
            let handle = unsafe {
                CreateFileW(path.as_ptr(), GENERIC_READ | GENERIC_WRITE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    ptr::null(), OPEN_EXISTING, 0, ptr::null_mut())
            };
            if handle == INVALID_HANDLE_VALUE { return false; }
            unsafe { CloseHandle(handle); }
            true
        }
        #[cfg(not(windows))]
        { false }
    }

    fn service_present(&self) -> bool {
        #[cfg(windows)]
        {
            use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
            RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(SERVICE_KEY).is_ok()
        }
        #[cfg(not(windows))]
        { false }
    }

    fn elevated(&self) -> bool { super::arc_sleep_system::host_elevated() }

    fn installer_path(&self) -> Option<PathBuf> {
        let mut candidates = Vec::new();
        if let Some(root) = std::env::current_exe().ok().and_then(|path| path.parent().map(Path::to_path_buf)) {
            // build-tauri-dist stages the complete compatibility payload here;
            // PawnIO_setup.exe is an Electron asar-unpacked resource.
            candidates.push(root.join("compatibility-backend/resources/app.asar.unpacked/src/main/backend/PawnIO_setup.exe"));
            // Also support a direct native resource layout if one is introduced.
            candidates.push(root.join("resources/PawnIO_setup.exe"));
        }
        if let Some(root) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
            candidates.push(root.join("src/main/backend/PawnIO_setup.exe"));
        }
        candidates.into_iter().find(|candidate| candidate.is_file())
    }

    fn spawn_installer(&self, path: &Path, args: &[&str]) -> Result<Box<dyn InstallerProcess>, String> {
        let mut command = Command::new(path);
        command.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        command.spawn()
            .map(|child| Box::new(SystemProcess(child)) as Box<dyn InstallerProcess>)
            .map_err(|error| format!("cannot start bundled installer: {error}"))
    }
}

struct SystemProcess(Child);

impl InstallerProcess for SystemProcess {
    fn try_wait(&mut self) -> Result<ProcessState, String> {
        self.0.try_wait().map(|status| match status {
            Some(status) => ProcessState::Exited(status.code()),
            None => ProcessState::Running,
        }).map_err(|error| format!("cannot check installer process: {error}"))
    }

    fn kill(&mut self) -> Result<(), String> {
        self.0.kill().map_err(|error| format!("cannot terminate installer after timeout: {error}"))
    }
}

/// Check the PawnIO device and service key. Either is sufficient to treat the
/// driver as installed, matching the supported device/service detection.
pub fn is_installed() -> bool { is_installed_with(&SystemApi) }

fn is_installed_with(api: &impl PawnIoApi) -> bool {
    api.device_present() || api.service_present()
}

/// Ensure PawnIO is present. This function never panics and only runs the
/// bundled official installer from an already-elevated host.
pub fn ensure_installed() -> InstallOutcome {
    let start = Instant::now();
    ensure_installed_with(&SystemApi, INSTALLER_TIMEOUT, || start.elapsed(), thread::sleep)
}

fn ensure_installed_with(
    api: &impl PawnIoApi,
    timeout: Duration,
    mut elapsed: impl FnMut() -> Duration,
    mut sleep: impl FnMut(Duration),
) -> InstallOutcome {
    if is_installed_with(api) { return InstallOutcome::AlreadyInstalled; }
    if !api.elevated() { return InstallOutcome::InstallFailed("not elevated".into()); }
    let Some(installer) = api.installer_path() else { return InstallOutcome::InstallerMissing; };
    let mut process = match api.spawn_installer(&installer, INSTALLER_ARGS) {
        Ok(process) => process,
        Err(reason) => return InstallOutcome::InstallFailed(reason),
    };
    match wait_for_installer(process.as_mut(), timeout, &mut elapsed, &mut sleep) {
        Ok(()) if is_installed_with(api) => InstallOutcome::Installed,
        Ok(()) => InstallOutcome::InstallFailed("installer exited successfully but PawnIO is still absent".into()),
        Err(reason) => InstallOutcome::InstallFailed(reason),
    }
}

fn wait_for_installer(
    process: &mut dyn InstallerProcess,
    timeout: Duration,
    elapsed: &mut impl FnMut() -> Duration,
    sleep: &mut impl FnMut(Duration),
) -> Result<(), String> {
    loop {
        match process.try_wait()? {
            ProcessState::Exited(Some(0)) => return Ok(()),
            ProcessState::Exited(Some(code)) => return Err(format!("installer exited with code {code}")),
            ProcessState::Exited(None) => return Err("installer exited without an exit code".into()),
            ProcessState::Running => {}
        }
        if elapsed() >= timeout {
            let kill_error = process.kill().err();
            return Err(match kill_error {
                Some(error) => format!("installer timed out after {timeout:?}; {error}"),
                None => format!("installer timed out after {timeout:?}"),
            });
        }
        sleep(POLL_INTERVAL);
    }
}

/// Start the ensure/install attempt once without delaying telemetry startup.
/// A missing driver or installer remains a degraded telemetry condition.
pub fn ensure_installed_once_async() {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() { return; }
    if let Err(error) = thread::Builder::new().name("arc-pawnio-ensure".into()).spawn(|| {
        log_outcome(&ensure_installed());
        ENSURE_FINISHED.store(true, Ordering::Release);
    }) {
        log(&format!("[pawnio] install failed: cannot start ensure worker: {error}"));
        ENSURE_FINISHED.store(true, Ordering::Release);
    }
}

static ENSURE_FINISHED: AtomicBool = AtomicBool::new(false);

/// True after the one-time installation check has completed (successfully or
/// not). The LHM bridge is opened only afterward so it can see a newly
/// installed PawnIO device at hardware initialization.
pub fn ensure_attempt_finished() -> bool { ENSURE_FINISHED.load(Ordering::Acquire) }

fn log(message: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr().lock(), "{message}");
}

fn log_outcome(outcome: &InstallOutcome) {
    match outcome {
        InstallOutcome::AlreadyInstalled => log("[pawnio] already present"),
        InstallOutcome::Installed => log("[pawnio] installed"),
        InstallOutcome::InstallerMissing => log("[pawnio] installer missing"),
        InstallOutcome::InstallFailed(reason) if reason == "not elevated" => log("[pawnio] not elevated"),
        InstallOutcome::InstallFailed(reason) => log(&format!("[pawnio] install failed: {reason}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc,
        },
    };

    struct FakeProcess {
        states: VecDeque<ProcessState>,
        killed: Arc<AtomicBool>,
        installed: Arc<AtomicBool>,
    }

    impl InstallerProcess for FakeProcess {
        fn try_wait(&mut self) -> Result<ProcessState, String> {
            let state = self.states.pop_front().unwrap_or(ProcessState::Running);
            if matches!(&state, ProcessState::Exited(Some(0))) {
                self.installed.store(true, Ordering::SeqCst);
            }
            Ok(state)
        }

        fn kill(&mut self) -> Result<(), String> {
            self.killed.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    struct FakeApi {
        device: bool,
        service: bool,
        elevated: bool,
        installer: Option<PathBuf>,
        process_states: VecDeque<ProcessState>,
        starts: AtomicUsize,
        killed: Arc<AtomicBool>,
        installed: Arc<AtomicBool>,
    }

    impl FakeApi {
        fn new(device: bool, service: bool) -> Self {
            Self {
                device,
                service,
                elevated: true,
                installer: Some(PathBuf::from("PawnIO_setup.exe")),
                process_states: VecDeque::from([ProcessState::Exited(Some(0))]),
                starts: AtomicUsize::new(0),
                killed: Arc::new(AtomicBool::new(false)),
                installed: Arc::new(AtomicBool::new(false)),
            }
        }
    }

    impl PawnIoApi for FakeApi {
        fn device_present(&self) -> bool { self.device || self.installed.load(Ordering::SeqCst) }
        fn service_present(&self) -> bool { self.service || self.installed.load(Ordering::SeqCst) }
        fn elevated(&self) -> bool { self.elevated }
        fn installer_path(&self) -> Option<PathBuf> { self.installer.clone() }

        fn spawn_installer(&self, _path: &Path, args: &[&str]) -> Result<Box<dyn InstallerProcess>, String> {
            assert_eq!(args, INSTALLER_ARGS);
            self.starts.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(FakeProcess {
                states: self.process_states.clone(),
                killed: self.killed.clone(),
                installed: self.installed.clone(),
            }))
        }
    }

    fn run(api: &FakeApi, timeout: Duration) -> InstallOutcome {
        let mut elapsed = Duration::ZERO;
        ensure_installed_with(api, timeout, || {
            let value = elapsed;
            elapsed += Duration::from_millis(60);
            value
        }, |_| {})
    }

    #[test]
    fn detects_pawnio_from_device_or_service() {
        assert!(is_installed_with(&FakeApi::new(true, false)));
        assert!(is_installed_with(&FakeApi::new(false, true)));
        assert!(!is_installed_with(&FakeApi::new(false, false)));
    }

    #[test]
    fn ensure_is_a_noop_when_device_or_service_is_present() {
        for api in [FakeApi::new(true, false), FakeApi::new(false, true)] {
            assert_eq!(run(&api, Duration::from_secs(1)), InstallOutcome::AlreadyInstalled);
            assert_eq!(api.starts.load(Ordering::SeqCst), 0);
        }
    }

    #[test]
    fn installer_nonzero_exit_is_reported_as_failure() {
        let mut api = FakeApi::new(false, false);
        api.process_states = VecDeque::from([ProcessState::Exited(Some(5))]);
        assert!(matches!(run(&api, Duration::from_secs(1)), InstallOutcome::InstallFailed(reason) if reason.contains("5")));
    }

    #[test]
    fn successful_installer_is_confirmed_by_a_post_install_check() {
        let api = FakeApi::new(false, false);
        assert_eq!(run(&api, Duration::from_secs(1)), InstallOutcome::Installed);
    }

    #[test]
    fn missing_installer_is_reported_without_spawning() {
        let mut api = FakeApi::new(false, false);
        api.installer = None;
        assert_eq!(run(&api, Duration::from_secs(1)), InstallOutcome::InstallerMissing);
        assert_eq!(api.starts.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn installer_wait_times_out_and_terminates_child() {
        let mut api = FakeApi::new(false, false);
        api.process_states.clear();
        assert!(matches!(run(&api, Duration::from_millis(100)), InstallOutcome::InstallFailed(reason) if reason.contains("timed out")));
        assert!(api.killed.load(Ordering::SeqCst));
    }

    #[test]
    fn an_unelevated_host_does_not_spawn_the_installer() {
        let mut api = FakeApi::new(false, false);
        api.elevated = false;
        assert!(matches!(run(&api, Duration::from_secs(1)), InstallOutcome::InstallFailed(reason) if reason == "not elevated"));
        assert_eq!(api.starts.load(Ordering::SeqCst), 0);
    }
}
