#include <windows.h>
#include <winternl.h>
#include <d3d12.h>
#include <dxgi1_2.h>
#include <d3dkmthk.h>
#include <wrl/client.h>

#include <array>
#include <charconv>
#include <cstdio>
#include <cwchar>
#include <iostream>
#include <map>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {
constexpr size_t kMaxTargets = 16;
constexpr UINT kMaxAdapters = 64;
constexpr size_t kMaxInputLine = 96;

struct Target {
    UINT domain = 0, bus = 0, device = 0, function = 0, vendorId = 0, deviceId = 0;
    std::string bdf;
};
struct Adapter {
    ComPtr<IDXGIAdapter1> dxgi;
    UINT vendorId = 0, deviceId = 0;
    std::string bdf;
    bool bdfResolved = false;
};
struct ProbeResult { bool positive = false; const char* reason = "unknown"; };

bool parseHex(const std::string& text, UINT digits, UINT maxValue, UINT& value) {
    if (text.empty() || text.size() > digits) return false;
    value = 0;
    const auto parsed = std::from_chars(text.data(), text.data() + text.size(), value, 16);
    return parsed.ec == std::errc{} && parsed.ptr == text.data() + text.size() && value <= maxValue;
}

bool parseBdf(const std::string& text, Target& target) {
    const auto c1 = text.find(':');
    const auto c2 = c1 == std::string::npos ? c1 : text.find(':', c1 + 1);
    const auto dot = c2 == std::string::npos ? c2 : text.find('.', c2 + 1);
    if (c1 == std::string::npos || c2 == std::string::npos || dot == std::string::npos
        || text.find(':', c2 + 1) != std::string::npos || text.find('.', dot + 1) != std::string::npos) return false;
    if (!parseHex(text.substr(0, c1), 4, 0xffff, target.domain)
        || !parseHex(text.substr(c1 + 1, c2 - c1 - 1), 2, 0xff, target.bus)
        || !parseHex(text.substr(c2 + 1, dot - c2 - 1), 2, 0x1f, target.device)
        || !parseHex(text.substr(dot + 1), 1, 7, target.function)) return false;
    char canonical[16]{};
    std::snprintf(canonical, sizeof(canonical), "%04x:%02x:%02x.%x", target.domain, target.bus, target.device, target.function);
    target.bdf = canonical;
    return true;
}

bool parseTarget(const std::string& line, Target& target) {
    const auto c1 = line.find(',');
    const auto c2 = c1 == std::string::npos ? c1 : line.find(',', c1 + 1);
    if (c1 == std::string::npos || c2 == std::string::npos || line.find(',', c2 + 1) != std::string::npos) return false;
    return parseBdf(line.substr(0, c1), target)
        && parseHex(line.substr(c1 + 1, c2 - c1 - 1), 4, 0xffff, target.vendorId)
        && parseHex(line.substr(c2 + 1), 4, 0xffff, target.deviceId);
}

std::string targetKey(const Target& target) {
    char ids[16]{};
    std::snprintf(ids, sizeof(ids), "%04x,%04x", target.vendorId, target.deviceId);
    return target.bdf + "," + ids;
}

bool resolveBdf(const LUID& luid, std::string& bdf) {
    D3DKMT_OPENADAPTERFROMLUID open{};
    open.AdapterLuid = luid;
    if (D3DKMTOpenAdapterFromLuid(&open) != 0) return false;
    struct CloseAdapter {
        D3DKMT_HANDLE handle;
        ~CloseAdapter() { D3DKMT_CLOSEADAPTER close{}; close.hAdapter = handle; D3DKMTCloseAdapter(&close); }
    } close{ open.hAdapter };

    D3DKMT_ADAPTERADDRESS address{};
    D3DKMT_QUERYADAPTERINFO query{};
    query.hAdapter = open.hAdapter;
    query.Type = KMTQAITYPE_ADAPTERADDRESS;
    query.pPrivateDriverData = &address;
    query.PrivateDriverDataSize = sizeof(address);
    if (D3DKMTQueryAdapterInfo(&query) != 0 || address.BusNumber > 0xff
        || address.DeviceNumber > 0x1f || address.FunctionNumber > 7) return false;
    // The KMT address has no segment field. Only segment-zero targets can match.
    char canonical[16]{};
    std::snprintf(canonical, sizeof(canonical), "0000:%02x:%02x.%x", address.BusNumber, address.DeviceNumber, address.FunctionNumber);
    bdf = canonical;
    return true;
}

ProbeResult queryFullCpuVisibleVram(IDXGIAdapter1* adapter) {
    ComPtr<ID3D12Device> device;
    if (FAILED(D3D12CreateDevice(adapter, D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&device)))) return { false, "device-create-failed" };
    D3D12_FEATURE_DATA_ARCHITECTURE architecture{};
    architecture.NodeIndex = 0;
    if (FAILED(device->CheckFeatureSupport(D3D12_FEATURE_ARCHITECTURE, &architecture, sizeof(architecture)))) return { false, "architecture-query-failed" };
    if (architecture.UMA != FALSE) return { false, "adapter-is-uma" };
    // Microsoft documents this capability as the discrete-GPU signal for
    // full VRAM CPU visibility. FALSE and query failure are both unknown.
    D3D12_FEATURE_DATA_D3D12_OPTIONS16 options16{};
    if (FAILED(device->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS16, &options16, sizeof(options16)))) return { false, "options16-query-failed" };
    if (options16.GPUUploadHeapSupported != TRUE) return { false, "gpu-upload-heap-not-supported" };
    return { true, "positive" };
}

std::vector<Target> readTargets() {
    std::vector<Target> targets;
    std::string line;
    while (std::getline(std::cin, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty() || line.size() > kMaxInputLine || targets.size() >= kMaxTargets) return {};
        Target target;
        if (!parseTarget(line, target)) return {};
        targets.push_back(std::move(target));
    }
    if (!std::cin.eof() || targets.empty()) return {};
    return targets;
}

std::vector<std::string> queryBatch(const std::vector<Target>& targets, std::vector<std::string>& diagnostics) {
    std::vector<std::string> output;
    std::map<std::string, size_t> countsByBdf;
    for (const auto& target : targets) ++countsByBdf[target.bdf];
    auto unknownAll = [&](const char* reason) {
        for (const auto& target : targets) {
            output.push_back(targetKey(target) + ",unknown\n");
            diagnostics.push_back(targetKey(target) + "=" + reason);
        }
    };

    ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) { unknownAll("dxgi-factory-failed"); return output; }
    std::vector<Adapter> adapters;
    bool enumerationComplete = true;
    const char* enumerationFailure = "adapter-inventory-incomplete";
    bool enumerationEnded = false;
    for (UINT index = 0; index < kMaxAdapters; ++index) {
        ComPtr<IDXGIAdapter1> adapter;
        const HRESULT hr = factory->EnumAdapters1(index, &adapter);
        if (hr == DXGI_ERROR_NOT_FOUND) { enumerationEnded = true; break; }
        if (FAILED(hr) || !adapter) { enumerationComplete = false; enumerationFailure = "dxgi-enumeration-failed"; break; }
        DXGI_ADAPTER_DESC1 desc{};
        if (FAILED(adapter->GetDesc1(&desc))) { enumerationComplete = false; enumerationFailure = "dxgi-adapter-description-failed"; break; }
        std::string bdf;
        const bool bdfResolved = resolveBdf(desc.AdapterLuid, bdf);
        adapters.push_back({ adapter, desc.VendorId, desc.DeviceId, std::move(bdf), bdfResolved });
    }
    if (!enumerationEnded && enumerationComplete) { enumerationComplete = false; enumerationFailure = "dxgi-adapter-limit-reached"; }

    for (const auto& target : targets) {
        ProbeResult probe{};
        if (!enumerationComplete) probe.reason = enumerationFailure;
        else if (target.domain != 0) probe.reason = "nonzero-pci-segment-unavailable";
        else if (countsByBdf[target.bdf] != 1) probe.reason = "duplicate-target-bdf";
        else {
            std::vector<const Adapter*> bdfMatches;
            bool unresolvedSamePciId = false;
            for (const auto& adapter : adapters) {
                if (adapter.bdfResolved && adapter.bdf == target.bdf) bdfMatches.push_back(&adapter);
                else if (!adapter.bdfResolved && adapter.vendorId == target.vendorId && adapter.deviceId == target.deviceId) unresolvedSamePciId = true;
            }
            if (unresolvedSamePciId) probe.reason = "same-vid-did-adapter-bdf-unresolved";
            else if (bdfMatches.empty()) probe.reason = "no-physical-bdf-match";
            else if (bdfMatches.size() != 1) probe.reason = "duplicate-dxgi-bdf-match";
            else if (bdfMatches.front()->vendorId != target.vendorId || bdfMatches.front()->deviceId != target.deviceId) probe.reason = "pci-vid-did-mismatch";
            else probe = queryFullCpuVisibleVram(bdfMatches.front()->dxgi.Get());
        }
        output.push_back(targetKey(target) + (probe.positive ? ",positive\n" : ",unknown\n"));
        diagnostics.push_back(targetKey(target) + "=" + probe.reason);
    }
    return output;
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
    const bool diagnostics = argc == 2 && wcscmp(argv[1], L"--diagnostics") == 0;
    if (argc > 2 || (argc == 2 && !diagnostics)) return 2;
    const auto targets = readTargets();
    if (targets.empty()) return 2;
    std::vector<std::string> messages;
    std::vector<std::string> details;
    messages = queryBatch(targets, details);
    for (const auto& line : messages) std::cout << line;
    if (diagnostics) for (const auto& line : details) std::cerr << line << '\n';
    return std::cout.good() ? 0 : 3;
}
