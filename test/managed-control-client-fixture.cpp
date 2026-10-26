#include <windows.h>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <string>

#pragma pack(push, 1)
struct Request { uint32_t magic; uint16_t version; uint16_t size; uint32_t operation; uint32_t revision; uint32_t percent; uint32_t enabled; };
struct Reply { uint32_t magic; uint16_t version; uint16_t size; uint32_t status; uint32_t accepted_revision; uint32_t applied_revision; };
struct Acknowledgment { uint32_t magic; uint16_t version; uint16_t size; uint32_t revision; };
#pragma pack(pop)
static constexpr uint32_t kMagic = 0x43505341;
int wmain(int argc, wchar_t **argv) {
    if (argc != 2) return 2;
    FILETIME created{}, exited{}, kernel{}, user{};
    if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) return 3;
    const uint64_t creation = (static_cast<uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
    const DWORD pid = GetCurrentProcessId();
    std::wstring name = L"\\\\.\\pipe\\ArcPower.ManagedSharpening.v1." + std::to_wstring(pid);
    HANDLE pipe = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX,
        PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT, 1, sizeof(Reply), sizeof(Request), 0, nullptr);
    if (pipe == INVALID_HANDLE_VALUE) return 4;
    std::printf("%lu %llu\n", pid, static_cast<unsigned long long>(creation)); std::fflush(stdout);
    if (!ConnectNamedPipe(pipe, nullptr) && GetLastError() != ERROR_PIPE_CONNECTED) { CloseHandle(pipe); return 5; }
    Request request{}; DWORD count = 0;
    if (!ReadFile(pipe, &request, sizeof(request), &count, nullptr) || count != sizeof(request) || request.magic != kMagic || request.version != 1 || request.size != sizeof(Request)) { CloseHandle(pipe); return 6; }
    if (!std::wcscmp(argv[1], L"stall")) { Sleep(5000); CloseHandle(pipe); return 0; }
    Reply reply{kMagic, 1, sizeof(Reply), 0, request.operation == 1 ? request.revision : 7u, 6u};
    if (!WriteFile(pipe, &reply, sizeof(reply), &count, nullptr) || count != sizeof(reply)) { CloseHandle(pipe); return 7; }
    Acknowledgment ack{};
    if (!ReadFile(pipe, &ack, sizeof(ack), &count, nullptr) || count != sizeof(ack) || ack.magic != kMagic || ack.revision != reply.accepted_revision) { CloseHandle(pipe); return 8; }
    CloseHandle(pipe); return 0;
}
