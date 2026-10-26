#include <windows.h>
#include <sddl.h>
#include <fcntl.h>
#include <io.h>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <cstring>
#include <string>
#include <vector>

#pragma pack(push, 1)
struct Request { uint32_t magic; uint16_t version; uint16_t size; uint32_t operation; uint32_t revision; uint32_t percent; uint32_t enabled; };
struct Reply { uint32_t magic; uint16_t version; uint16_t size; uint32_t status; uint32_t accepted_revision; uint32_t applied_revision; };
struct Acknowledgment { uint32_t magic; uint16_t version; uint16_t size; uint32_t revision; };
#pragma pack(pop)
static constexpr uint32_t kMagic = 0x43505341;
static constexpr DWORD kDeadlineMs = 2000;

static bool parse_u64(const char *s, uint64_t &v) {
    if (!s || !*s) return false;
    uint64_t parsed = 0;
    for (; *s; ++s) { if (*s < '0' || *s > '9') return false; unsigned d = *s - '0'; if (parsed > (UINT64_MAX - d) / 10) return false; parsed = parsed * 10 + d; }
    v = parsed;
    return true;
}
static bool token_user(HANDLE process, std::vector<uint8_t> &buf, PSID &sid) {
    HANDLE token = nullptr;
    if (!OpenProcessToken(process, TOKEN_QUERY, &token)) return false;
    DWORD size = 0; GetTokenInformation(token, TokenUser, nullptr, 0, &size);
    buf.resize(size);
    bool ok = size && GetTokenInformation(token, TokenUser, buf.data(), size, &size);
    CloseHandle(token);
    if (ok) sid = reinterpret_cast<TOKEN_USER *>(buf.data())->User.Sid;
    return ok;
}
static bool target_process(DWORD pid, uint64_t creation, HANDLE &process) {
    process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
    if (!process) return false;
    FILETIME created{}, exited{}, kernel{}, user{};
    DWORD targetSession = 0, selfSession = 0;
    std::vector<uint8_t> targetBuf, selfBuf; PSID targetSid = nullptr, selfSid = nullptr;
    HANDLE self = GetCurrentProcess();
    if (!GetProcessTimes(process, &created, &exited, &kernel, &user) ||
        (static_cast<uint64_t>(created.dwHighDateTime) << 32 | created.dwLowDateTime) != creation ||
        WaitForSingleObject(process, 0) != WAIT_TIMEOUT ||
        !ProcessIdToSessionId(pid, &targetSession) || !ProcessIdToSessionId(GetCurrentProcessId(), &selfSession) || targetSession != selfSession ||
        !token_user(process, targetBuf, targetSid) || !token_user(self, selfBuf, selfSid) || !EqualSid(targetSid, selfSid)) {
        CloseHandle(process); process = nullptr; return false;
    }
    return true;
}
static bool still_same(HANDLE process, DWORD pid, uint64_t creation) {
    FILETIME c{}, e{}, k{}, u{};
    return WaitForSingleObject(process, 0) == WAIT_TIMEOUT && GetProcessId(process) == pid &&
        GetProcessTimes(process, &c, &e, &k, &u) &&
        ((static_cast<uint64_t>(c.dwHighDateTime) << 32) | c.dwLowDateTime) == creation;
}
static bool io(HANDLE pipe, bool write, void *data, DWORD size) {
    OVERLAPPED ov{}; ov.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr); if (!ov.hEvent) return false;
    DWORD done = 0; BOOL immediate = write ? WriteFile(pipe, data, size, &done, &ov) : ReadFile(pipe, data, size, &done, &ov);
    bool ok = false;
    if (immediate) ok = done == size;
    else if (GetLastError() == ERROR_IO_PENDING) {
        DWORD wait = WaitForSingleObject(ov.hEvent, kDeadlineMs);
        if (wait == WAIT_OBJECT_0) ok = GetOverlappedResult(pipe, &ov, &done, FALSE) && done == size;
        else {
            CancelIoEx(pipe, &ov);
            // The caller's two-second deadline bounds the requested operation.
            // Drain its cancellation completion before releasing OVERLAPPED,
            // event, or caller-owned data; this is a local named-pipe handle.
            DWORD ignored = 0;
            GetOverlappedResult(pipe, &ov, &ignored, TRUE);
        }
    }
    CloseHandle(ov.hEvent); return ok;
}
static bool transact(DWORD pid, uint64_t creation, bool set, uint32_t revision, uint32_t enabled, uint32_t percent, Reply &out) {
    HANDLE target = nullptr; if (!target_process(pid, creation, target)) return false;
    std::wstring name = L"\\\\.\\pipe\\ArcPower.ManagedSharpening.v1." + std::to_wstring(pid);
    HANDLE pipe = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
    bool ok = pipe != INVALID_HANDLE_VALUE;
    ULONG serverPid = 0;
    if (ok) ok = GetNamedPipeServerProcessId(pipe, &serverPid) && serverPid == pid && still_same(target, pid, creation);
    Request req{kMagic, 1, sizeof(Request), set ? 1u : 2u, revision, percent, enabled};
    if (ok) ok = io(pipe, true, &req, sizeof(req)) && still_same(target, pid, creation) && io(pipe, false, &out, sizeof(out));
    if (ok) ok = out.magic == kMagic && out.version == 1 && out.size == sizeof(Reply);
    if (ok) {
        Acknowledgment ack{kMagic, 1, sizeof(Acknowledgment), out.accepted_revision};
        ok = still_same(target, pid, creation) && io(pipe, true, &ack, sizeof(ack));
    }
    if (pipe != INVALID_HANDLE_VALUE) CloseHandle(pipe);
    CloseHandle(target); return ok;
}
static bool read_line(std::vector<unsigned char> &line, bool &oversized, bool &bad_byte) {
    line.clear(); oversized = false; bad_byte = false;
    for (;;) {
        int c = std::getchar();
        if (c == EOF) return !line.empty() || oversized || bad_byte;
        if (c == '\n') return true;
        if (line.size() < 256) line.push_back(static_cast<unsigned char>(c));
        else oversized = true;
        if (c == 0 || c > 0x7f || (c < 0x20 && c != '\t' && c != '\r')) bad_byte = true;
    }
}
static int serve() {
    std::vector<unsigned char> bytes;
    bool oversized = false, badByte = false;
    while (read_line(bytes, oversized, badByte)) {
        uint64_t id = 0;
        std::string line(bytes.begin(), bytes.end());
        char *t[8]{}; int count = 0; char *p = line.data();
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.find('\r') != std::string::npos) badByte = true;
        p = line.data();
        while (*p && count < 7) { while (*p == ' ' || *p == '\t') ++p; if (!*p) break; t[count++] = p; while (*p && *p != ' ' && *p != '\t') ++p; if (*p) *p++ = 0; }
        while (*p == ' ' || *p == '\t') ++p;
        if (count > 1) parse_u64(t[1], id);
        uint64_t pid64=0,creation=0,rev=0,en=0,percent=0; bool set = count && !std::strcmp(t[0], "SET");
        bool valid = !oversized && !badByte && (!*p && (set ? count == 7 : count == 4) && (!std::strcmp(t[0], "QUERY") || set));
        valid = valid && parse_u64(t[1], id) && parse_u64(t[2], pid64) && pid64 && pid64 <= MAXDWORD && parse_u64(t[3], creation);
        if (set) valid = valid && parse_u64(t[4], rev) && rev && rev <= MAXDWORD && parse_u64(t[5], en) && en <= 1 && parse_u64(t[6], percent) && percent <= 100;
        if (!valid) { std::fprintf(stderr, "rejected malformed request\n"); std::printf("ERROR %llu malformed\n", static_cast<unsigned long long>(id)); std::fflush(stdout); continue; }
        Reply out{};
        if (!transact(static_cast<DWORD>(pid64), creation, set, static_cast<uint32_t>(rev), static_cast<uint32_t>(en), static_cast<uint32_t>(percent), out)) { char b[80]; std::snprintf(b,sizeof(b),"ERROR %llu pipe_or_identity",static_cast<unsigned long long>(id)); std::puts(b); std::fflush(stdout); continue; }
        std::printf("RESULT %llu %u %u %u\n", static_cast<unsigned long long>(id), out.status, out.accepted_revision, out.applied_revision); std::fflush(stdout);
    }
    return std::ferror(stdin) ? 1 : 0;
}
int wmain(int argc, wchar_t **argv) {
    if (argc == 2 && !std::wcscmp(argv[1], L"--help")) { std::puts("--serve: QUERY id pid creationFILETIME | SET id pid creationFILETIME revision enabled(0|1) percent(0..100)"); return 0; }
    if (argc == 2 && !std::wcscmp(argv[1], L"--serve")) {
        if (_setmode(_fileno(stdin), _O_BINARY) == -1) { std::fprintf(stderr, "could not set stdin to binary mode\n"); return 1; }
        return serve();
    }
    return 2;
}
