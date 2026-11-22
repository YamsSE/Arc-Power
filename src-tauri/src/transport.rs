//! A local-only duplex pipe. GUI Electron cannot reliably inherit fd 0 on this
//! Windows host, so RPC uses an authenticated private named pipe instead.
use std::{fs::File, time::Duration};

#[cfg(windows)]
mod windows_pipe {
    use super::*;
    use std::{ffi::c_void, io, os::windows::io::{AsRawHandle, FromRawHandle}, ptr, time::Instant};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, LocalFree, ERROR_BROKEN_PIPE, ERROR_FILE_NOT_FOUND, ERROR_IO_INCOMPLETE, ERROR_IO_PENDING, ERROR_OPERATION_ABORTED, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT},
        Security::{Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1}, GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER},
        Storage::FileSystem::{CreateFileW, ReadFile, WriteFile, FILE_FLAG_OVERLAPPED, FILE_FLAG_FIRST_PIPE_INSTANCE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX},
        System::{IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED}, Pipes::{ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, GetNamedPipeServerProcessId, SetNamedPipeHandleState, WaitNamedPipeW, PIPE_NOWAIT, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT}, Threading::{CreateEventW, GetCurrentProcess, OpenProcessToken, WaitForSingleObject}},
    };

    fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }
    fn last_error(context: &str) -> String { format!("{context}: {}", io::Error::last_os_error()) }

    // A synchronous Windows pipe serializes a pending read with writes on its
    // cloned handle. Use independent overlapped operations so a quiet broker
    // cannot freeze the UI's next host event behind the reader thread.
    pub struct PipeStream(File);
    impl PipeStream {
        pub fn try_clone(&self) -> io::Result<Self> { self.0.try_clone().map(Self) }
        fn transfer_with_timeout(&self, buffer: *mut u8, length: usize, writing: bool, timeout: Option<Duration>) -> io::Result<usize> {
            unsafe {
                let event = CreateEventW(ptr::null(), 1, 0, ptr::null());
                if event.is_null() { return Err(io::Error::last_os_error()); }
                let mut operation: OVERLAPPED = std::mem::zeroed();
                operation.hEvent = event;
                let mut transferred = 0;
                let length = length.min(u32::MAX as usize) as u32;
                let started = if writing { WriteFile(self.0.as_raw_handle(), buffer, length, &mut transferred, &mut operation) }
                    else { ReadFile(self.0.as_raw_handle(), buffer, length, &mut transferred, &mut operation) };
                let error = if started == 0 { GetLastError() } else { 0 };
                let result = if started != 0 { Ok(transferred as usize) }
                    else if error == ERROR_IO_PENDING {
                        // Keep the buffer, event and OVERLAPPED alive until the
                        // exact operation either completes or is cancelled.
                        let wait_ms = timeout.map(|duration| duration.as_millis().min(u32::MAX as u128) as u32).unwrap_or(u32::MAX);
                        let waited = WaitForSingleObject(event, wait_ms);
                        if timeout.is_some() && waited == WAIT_TIMEOUT {
                            CancelIoEx(self.0.as_raw_handle(), &operation);
                            if GetOverlappedResult(self.0.as_raw_handle(), &operation, &mut transferred, 1) != 0 {
                                Ok(transferred as usize)
                            } else {
                                let error = GetLastError();
                                if error == ERROR_OPERATION_ABORTED {
                                    Err(io::Error::new(io::ErrorKind::TimedOut, "Broker pipe operation timed out; operation was cancelled"))
                                } else { Err(io::Error::from_raw_os_error(error as i32)) }
                            }
                        } else if waited == WAIT_OBJECT_0 && GetOverlappedResult(self.0.as_raw_handle(), &operation, &mut transferred, 0) != 0 {
                            Ok(transferred as usize)
                        } else if timeout.is_none() && GetOverlappedResult(self.0.as_raw_handle(), &operation, &mut transferred, 1) != 0 {
                            Ok(transferred as usize)
                        } else {
                            CancelIoEx(self.0.as_raw_handle(), &operation);
                            let _ = GetOverlappedResult(self.0.as_raw_handle(), &operation, &mut transferred, 1);
                            Err(io::Error::last_os_error())
                        }
                    } else if !writing && error == ERROR_BROKEN_PIPE { Ok(0) }
                    else { Err(io::Error::from_raw_os_error(error as i32)) };
                CloseHandle(event);
                result
            }
        }
        pub fn read_with_timeout(&mut self, buffer: &mut [u8], timeout: Duration) -> io::Result<usize> {
            self.transfer_with_timeout(buffer.as_mut_ptr(), buffer.len(), false, Some(timeout))
        }
        pub fn write_with_timeout(&mut self, buffer: &[u8], timeout: Duration) -> io::Result<usize> {
            self.transfer_with_timeout(buffer.as_ptr().cast_mut(), buffer.len(), true, Some(timeout))
        }
        pub fn write_all_with_timeout(&mut self, buffer: &[u8], timeout: Duration) -> io::Result<()> {
            let deadline = Instant::now() + timeout;
            let mut offset = 0;
            while offset < buffer.len() {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() { return Err(io::Error::new(io::ErrorKind::TimedOut, "Broker pipe write timed out")); }
                match self.write_with_timeout(&buffer[offset..], remaining)? {
                    0 => return Err(io::Error::new(io::ErrorKind::WriteZero, "Broker pipe closed during write")),
                    count => offset += count,
                }
            }
            Ok(())
        }
    }
    impl io::Read for PipeStream {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> { self.transfer_with_timeout(buffer.as_mut_ptr(), buffer.len(), false, None) }
    }
    impl io::Write for PipeStream {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> { self.transfer_with_timeout(buffer.as_ptr().cast_mut(), buffer.len(), true, Some(Duration::from_secs(5))) }
        fn flush(&mut self) -> io::Result<()> { Ok(()) }
    }

    pub struct PipeClient;
    impl PipeClient {
        pub fn connect(path: &str, expected_server_pid: u32, timeout: Duration) -> Result<PipeStream, String> {
            if !valid_pipe_path(path) || expected_server_pid == 0 { return Err("Invalid private pipe identity".into()); }
            let path_wide = wide(path);
            let deadline = Instant::now() + timeout;
            loop {
                let handle = unsafe { CreateFileW(path_wide.as_ptr(), GENERIC_READ | GENERIC_WRITE, 0,
                    ptr::null(), OPEN_EXISTING, FILE_FLAG_OVERLAPPED, ptr::null_mut()) };
                if handle != INVALID_HANDLE_VALUE {
                    let mut server_pid = 0;
                    if unsafe { GetNamedPipeServerProcessId(handle, &mut server_pid) } == 0 {
                        let error = last_error("Cannot identify private pipe server");
                        unsafe { CloseHandle(handle); }
                        return Err(error);
                    }
                    if server_pid != expected_server_pid {
                        unsafe { CloseHandle(handle); }
                        return Err("Private pipe server PID does not match the parent".into());
                    }
                    let mode = PIPE_READMODE_BYTE | PIPE_WAIT;
                    if unsafe { SetNamedPipeHandleState(handle, &mode, ptr::null(), ptr::null()) } == 0 {
                        let error = last_error("Cannot set private pipe client mode");
                        unsafe { CloseHandle(handle); }
                        return Err(error);
                    }
                    return Ok(PipeStream(unsafe { File::from_raw_handle(handle) }));
                }
                let error = unsafe { GetLastError() };
                if !matches!(error, ERROR_PIPE_BUSY | ERROR_FILE_NOT_FOUND) {
                    return Err(format!("Cannot connect to private pipe: {}", io::Error::from_raw_os_error(error as i32)));
                }
                if Instant::now() >= deadline { return Err("Private pipe connection timed out".into()); }
                let wait_ms = deadline.saturating_duration_since(Instant::now()).as_millis().min(50) as u32;
                unsafe { WaitNamedPipeW(path_wide.as_ptr(), wait_ms.max(1)); }
            }
        }
    }

    fn valid_pipe_path(path: &str) -> bool {
        let Some(suffix) = path.strip_prefix(r"\\.\pipe\ArcPower-Tauri-") else { return false; };
        suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }

    fn current_user_sid() -> Result<String, String> {
        unsafe {
            let mut token = ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 { return Err(last_error("Cannot open current user token")); }
            let result = (|| {
                let mut length = 0;
                GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut length);
                if length == 0 || length > 64 * 1024 { return Err("Invalid current user token size".into()); }
                // usize-backed allocation guarantees TOKEN_USER alignment.
                let mut buffer = vec![0usize; (length as usize + std::mem::size_of::<usize>() - 1) / std::mem::size_of::<usize>()];
                if GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), length, &mut length) == 0 { return Err(last_error("Cannot read current user token")); }
                let user = &*(buffer.as_ptr().cast::<TOKEN_USER>());
                let mut string_sid = ptr::null_mut();
                if ConvertSidToStringSidW(user.User.Sid, &mut string_sid) == 0 { return Err(last_error("Cannot format current user SID")); }
                let mut length = 0;
                while *string_sid.add(length) != 0 { length += 1; }
                let value = String::from_utf16(std::slice::from_raw_parts(string_sid, length)).map_err(|_| "Invalid user SID encoding".to_owned());
                LocalFree(string_sid.cast());
                value
            })();
            CloseHandle(token);
            result
        }
    }

    pub struct PipeServer { file: File, path: String }
    impl PipeServer {
        pub fn create() -> Result<Self, String> {
            let mut random = [0u8; 16];
            rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut random);
            let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
            let path = format!(r"\\.\pipe\ArcPower-Tauri-{suffix}");
            let sid = current_user_sid()?;
            // Alternate-credential UAC helpers run as another Administrators
            // member, so grant the built-in group pipe access as well. The
            // launched-child PID check in accept remains the authorization
            // fence for the one-use connection.
            let sddl = wide(&format!("D:P(A;;GA;;;SY)(A;;GA;;;S-1-5-32-544)(A;;GA;;;{sid})"));
            unsafe {
                let mut descriptor: *mut c_void = ptr::null_mut();
                if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, ptr::null_mut()) == 0 {
                    return Err(last_error("Cannot create private pipe security descriptor"));
                }
                let attributes = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor, bInheritHandle: 0 };
                // NOWAIT is used only for bounded startup acceptance. Once the
                // authenticated child connects, the pipe switches to WAIT mode.
                // PipeStream performs all I/O with explicit OVERLAPPED state.
                let handle = CreateNamedPipeW(wide(&path).as_ptr(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    1, 64 * 1024, 64 * 1024, 0, &attributes);
                LocalFree(descriptor);
                if handle == INVALID_HANDLE_VALUE { return Err(last_error("Cannot create private broker pipe")); }
                Ok(Self { file: File::from_raw_handle(handle), path })
            }
        }
        pub fn path(&self) -> &str { &self.path }
        pub fn accept(self, expected_child_pid: u32, timeout: Duration) -> Result<PipeStream, String> {
            self.accept_while(expected_child_pid, timeout, || true)
        }
        pub fn accept_while<F>(self, expected_child_pid: u32, timeout: Duration, mut keep_waiting: F) -> Result<PipeStream, String>
        where F: FnMut() -> bool {
            let deadline = Instant::now() + timeout;
            loop {
                unsafe {
                    let mut operation: OVERLAPPED = std::mem::zeroed();
                    let connected = ConnectNamedPipe(self.file.as_raw_handle(), &mut operation);
                    let error = if connected == 0 { GetLastError() } else { 0 };
                    let mut connected_now = connected != 0 || error == ERROR_PIPE_CONNECTED;
                    if error == ERROR_IO_PENDING {
                        // NOWAIT normally returns ERROR_PIPE_LISTENING. If a
                        // provider reports a pending overlapped connect, poll
                        // it without letting the OVERLAPPED storage expire.
                        loop {
                            let mut transferred = 0;
                            if GetOverlappedResult(self.file.as_raw_handle(), &mut operation, &mut transferred, 0) != 0 {
                                connected_now = true;
                                break;
                            }
                            let poll_error = GetLastError();
                            if poll_error != ERROR_IO_INCOMPLETE {
                                return Err(last_error("Cannot complete broker pipe connection"));
                            }
                            if Instant::now() >= deadline || !keep_waiting() {
                                let _ = CancelIoEx(self.file.as_raw_handle(), &operation);
                                let _ = GetOverlappedResult(self.file.as_raw_handle(), &mut operation, &mut transferred, 1);
                                return Err(if Instant::now() >= deadline {
                                    "Private broker pipe startup timed out".into()
                                } else {
                                    "Private broker pipe startup was canceled".into()
                                });
                            }
                            std::thread::sleep(Duration::from_millis(25));
                        }
                    }
                    if connected_now {
                        let mut actual_pid = 0;
                        if GetNamedPipeClientProcessId(self.file.as_raw_handle(), &mut actual_pid) == 0 {
                            return Err(last_error("Cannot identify broker pipe client"));
                        }
                        if actual_pid != expected_child_pid { return Err("Broker pipe client PID does not match spawned process".into()); }
                        let mode = PIPE_READMODE_BYTE | PIPE_WAIT;
                        if SetNamedPipeHandleState(self.file.as_raw_handle(), &mode, ptr::null(), ptr::null()) == 0 {
                            return Err(last_error("Cannot set connected pipe mode"));
                        }
                        // A pending connect can finish concurrently with the
                        // caller's deadline or process-liveness transition.
                        // Recheck both after authenticating the peer and just
                        // before releasing the connected stream.
                        if Instant::now() >= deadline { return Err("Private broker pipe startup timed out".into()); }
                        if !keep_waiting() { return Err("Private broker pipe startup was canceled".into()); }
                        return Ok(PipeStream(self.file));
                    }
                    if error != ERROR_PIPE_LISTENING { return Err(last_error("Cannot accept broker pipe")); }
                }
                if Instant::now() >= deadline { return Err("Private broker pipe startup timed out".into()); }
                if !keep_waiting() { return Err("Private broker pipe startup was canceled".into()); }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{io::{Read, Write}, process::{Command, Stdio}};

        #[test]
        #[ignore = "subprocess helper invoked by private pipe tests"]
        fn pipe_child_roundtrip() {
            let path = std::env::var("ARC_POWER_PIPE_TEST").expect("test pipe path");
            let mut pipe = std::fs::OpenOptions::new().read(true).write(true).open(path).unwrap();
            if std::env::var_os("ARC_POWER_PIPE_TEST_READ_FIRST").is_some() {
                let mut request = [0u8; 4];
                pipe.read_exact(&mut request).unwrap();
                assert_eq!(&request, b"pong");
                pipe.write_all(b"ping").unwrap();
                return;
            }
            pipe.write_all(b"ping").unwrap();
            if std::env::var_os("ARC_POWER_PIPE_TEST_WRITE_ONLY").is_none() {
                let mut reply = [0u8; 4];
                pipe.read_exact(&mut reply).unwrap();
                assert_eq!(&reply, b"pong");
            } else {
                std::thread::sleep(Duration::from_millis(250));
            }
        }

        fn child(server: &PipeServer, write_only: bool) -> std::process::Child {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command.args(["--exact", "transport::windows_pipe::tests::pipe_child_roundtrip", "--ignored"])
                .env("ARC_POWER_PIPE_TEST", server.path()).stdout(Stdio::null()).stderr(Stdio::inherit());
            if write_only { command.env("ARC_POWER_PIPE_TEST_WRITE_ONLY", "1"); }
            command.spawn().unwrap()
        }

        #[test]
        fn pipe_authenticates_child_and_transfers_bytes() {
            let server = PipeServer::create().unwrap();
            let mut child = child(&server, false);
            let pipe = server.accept(child.id(), Duration::from_secs(5));
            if pipe.is_err() { let _ = child.kill(); }
            let mut pipe = pipe.unwrap();
            let mut request = [0u8; 4];
            pipe.read_exact(&mut request).unwrap();
            assert_eq!(&request, b"ping");
            pipe.write_all(b"pong").unwrap();
            assert!(child.wait().unwrap().success());
        }

        #[test]
        fn pipe_rejects_unexpected_process_id() {
            let server = PipeServer::create().unwrap();
            let mut child = child(&server, true);
            let result = server.accept(child.id().wrapping_add(1), Duration::from_secs(5));
            let _ = child.kill(); let _ = child.wait();
            assert!(result.err().unwrap().contains("PID does not match"));
        }

        #[test]
        fn accept_while_cancels_without_a_connected_client() {
            let server = PipeServer::create().unwrap();
            let error = server.accept_while(std::process::id(), Duration::from_secs(5), || false)
                .err().expect("a canceled accept must not return a stream");
            assert!(error.contains("canceled"));
        }

        #[test]
        fn accept_while_rechecks_liveness_after_authenticating_connected_client() {
            let server = PipeServer::create().unwrap();
            let _client = std::fs::OpenOptions::new().read(true).write(true).open(server.path()).unwrap();
            let error = server.accept_while(std::process::id(), Duration::from_secs(5), || false)
                .err().expect("a client must be rejected when the final liveness check fails");
            assert!(error.contains("canceled"));
        }

        #[test]
        fn pending_pipe_read_does_not_block_concurrent_write() {
            let server = PipeServer::create().unwrap();
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "transport::windows_pipe::tests::pipe_child_roundtrip", "--ignored"])
                .env("ARC_POWER_PIPE_TEST", server.path()).env("ARC_POWER_PIPE_TEST_READ_FIRST", "1")
                .stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().unwrap();
            let mut pipe = server.accept(child.id(), Duration::from_secs(5)).unwrap();
            let mut writer = pipe.try_clone().unwrap();
            let reader = std::thread::spawn(move || {
                let mut reply = [0u8; 4];
                pipe.read_exact(&mut reply).map(|_| reply)
            });
            // Put ReadFile in flight before the write, matching the idle broker
            // reader and the native focus event that froze initial navigation.
            std::thread::sleep(Duration::from_millis(100));
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            let writing = std::thread::spawn(move || { let _ = sender.send(writer.write_all(b"pong")); });
            let written = receiver.recv_timeout(Duration::from_secs(3));
            if written.is_err() { let _ = child.kill(); }
            let status = child.wait().unwrap();
            writing.join().unwrap();
            let reply = reader.join().unwrap();
            assert!(written.unwrap().is_ok(), "concurrent pipe write failed");
            assert!(status.success());
            assert_eq!(&reply.unwrap(), b"ping");
        }

        #[test]
        fn pipe_startup_wait_is_bounded() {
            let server = PipeServer::create().unwrap();
            assert!(server.accept(std::process::id(), Duration::from_millis(20)).err().unwrap().contains("timed out"));
        }
    }
}

#[cfg(windows)]
pub use windows_pipe::{PipeClient, PipeServer, PipeStream};

#[cfg(not(windows))]
pub type PipeStream = File;

#[cfg(not(windows))]
pub struct PipeServer;
#[cfg(not(windows))]
impl PipeServer {
    pub fn create() -> Result<Self, String> { Err("Arc Power currently supports Windows only".into()) }
    pub fn path(&self) -> &str { "" }
    pub fn accept(self, _pid: u32, _timeout: Duration) -> Result<File, String> { Err("Windows required".into()) }
    pub fn accept_while<F>(self, _pid: u32, _timeout: Duration, _keep_waiting: F) -> Result<File, String>
    where F: FnMut() -> bool { Err("Windows required".into()) }
}

#[cfg(not(windows))]
pub struct PipeClient;
#[cfg(not(windows))]
impl PipeClient {
    pub fn connect(_path: &str, _pid: u32, _timeout: Duration) -> Result<File, String> { Err("Windows required".into()) }
}
