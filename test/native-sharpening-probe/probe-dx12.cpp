#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d12.h>
#include <dxgi1_6.h>
#include <d3dcompiler.h>
#include <wrl/client.h>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <string>
#include <vector>

#pragma comment(lib, "d3d12.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "d3dcompiler.lib")
using Microsoft::WRL::ComPtr;

static constexpr UINT kWidth = 960;
static constexpr UINT kHeight = 640;
static constexpr UINT kBufferCount = 2;
static HWND g_window;

static LRESULT CALLBACK WindowProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_CLOSE) { DestroyWindow(hwnd); return 0; }
    if (msg == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

static void Fail(const char* what, HRESULT hr) {
    std::fprintf(stderr, "%s failed: 0x%08lx\n", what, static_cast<unsigned long>(hr));
    std::exit(2);
}

static void Check(HRESULT hr, const char* what) { if (FAILED(hr)) Fail(what, hr); }

static ComPtr<ID3DBlob> Compile(const char* source, const char* target) {
    ComPtr<ID3DBlob> code, errors;
    const HRESULT hr = D3DCompile(source, std::strlen(source), "native-sharpening-probe-dx12.hlsl",
        nullptr, nullptr, "main", target, D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &code, &errors);
    if (FAILED(hr)) {
        if (errors) std::fwrite(errors->GetBufferPointer(), 1, errors->GetBufferSize(), stderr);
        Fail("D3DCompile", hr);
    }
    return code;
}

static ComPtr<ID3D12Resource> CreateBuffer(ID3D12Device* device, UINT64 bytes,
        D3D12_HEAP_TYPE heapType, D3D12_RESOURCE_STATES initialState) {
    D3D12_HEAP_PROPERTIES heap{};
    heap.Type = heapType;
    heap.CreationNodeMask = heap.VisibleNodeMask = 1;
    D3D12_RESOURCE_DESC desc{};
    desc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    desc.Width = bytes;
    desc.Height = 1;
    desc.DepthOrArraySize = 1;
    desc.MipLevels = 1;
    desc.SampleDesc.Count = 1;
    desc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    ComPtr<ID3D12Resource> resource;
    Check(device->CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &desc, initialState,
        nullptr, IID_PPV_ARGS(&resource)), "CreateCommittedResource(buffer)");
    return resource;
}

static void WaitForFence(ID3D12CommandQueue* queue, ID3D12Fence* fence, HANDLE eventHandle,
                         UINT64& value) {
    ++value;
    Check(queue->Signal(fence, value), "CommandQueue::Signal");
    if (fence->GetCompletedValue() < value) {
        Check(fence->SetEventOnCompletion(value, eventHandle), "Fence::SetEventOnCompletion");
        if (WaitForSingleObject(eventHandle, INFINITE) != WAIT_OBJECT_0) {
            std::fprintf(stderr, "WaitForSingleObject(fence) failed: %lu\n", GetLastError());
            std::exit(2);
        }
    }
}

static void WriteBmp(const wchar_t* path, const uint8_t* bgra, uint64_t& checksum,
                     uint64_t& nonBlackPixels, uint8_t roi[4]) {
    const uint32_t imageBytes = kWidth * kHeight * 4;
    BITMAPFILEHEADER file{};
    BITMAPINFOHEADER info{};
    file.bfType = 0x4d42;
    file.bfOffBits = sizeof(file) + sizeof(info);
    file.bfSize = file.bfOffBits + imageBytes;
    info.biSize = sizeof(info);
    info.biWidth = kWidth;
    info.biHeight = -static_cast<LONG>(kHeight);
    info.biPlanes = 1;
    info.biBitCount = 32;
    info.biCompression = BI_RGB;
    info.biSizeImage = imageBytes;
    FILE* out = nullptr;
    _wfopen_s(&out, path, L"wb");
    if (!out) { std::fwprintf(stderr, L"Cannot open output: %s\n", path); std::exit(2); }
    std::fwrite(&file, sizeof(file), 1, out);
    std::fwrite(&info, sizeof(info), 1, out);
    std::fwrite(bgra, 1, imageBytes, out);
    std::fclose(out);
    checksum = 1469598103934665603ull;
    nonBlackPixels = 0;
    for (uint32_t i = 0; i < imageBytes; i += 4) {
        for (int c = 0; c < 4; ++c) { checksum ^= bgra[i + c]; checksum *= 1099511628211ull; }
        if (bgra[i] || bgra[i + 1] || bgra[i + 2]) ++nonBlackPixels;
    }
    const size_t center = (static_cast<size_t>(kHeight / 2) * kWidth + kWidth / 2) * 4;
    for (int c = 0; c < 4; ++c) roi[c] = bgra[center + c];
}

int wmain(int argc, wchar_t** argv) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    const wchar_t* output = nullptr;
    int frames = 120;
    for (int i = 1; i < argc; ++i) {
        if (!wcscmp(argv[i], L"--output") && i + 1 < argc) output = argv[++i];
        else if (!wcscmp(argv[i], L"--frames") && i + 1 < argc) frames = _wtoi(argv[++i]);
        else { std::fwprintf(stderr, L"Unknown/incomplete argument: %s\n", argv[i]); return 2; }
    }
    if (!output || frames < 1) {
        std::fwprintf(stderr, L"Usage: native-sharpening-probe-dx12.exe --output absolute.bmp [--frames 120]\n");
        return 2;
    }

    WNDCLASSW wc{};
    wc.lpfnWndProc = WindowProc;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"NativeSharpeningProbeDx12Window";
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    RegisterClassW(&wc);
    RECT wr{0, 0, static_cast<LONG>(kWidth), static_cast<LONG>(kHeight)};
    AdjustWindowRect(&wr, WS_OVERLAPPEDWINDOW, FALSE);
    g_window = CreateWindowW(wc.lpszClassName, L"Native D3D12 sharpening render probe",
        WS_OVERLAPPEDWINDOW, 80, 80, wr.right - wr.left, wr.bottom - wr.top,
        nullptr, nullptr, wc.hInstance, nullptr);
    if (!g_window) { std::fprintf(stderr, "CreateWindow failed: %lu\n", GetLastError()); return 2; }
    ShowWindow(g_window, SW_SHOW);
    UpdateWindow(g_window);
    SetForegroundWindow(g_window);
    SetWindowPos(g_window, HWND_TOPMOST, 80, 80, wr.right - wr.left, wr.bottom - wr.top,
        SWP_SHOWWINDOW | SWP_NOACTIVATE);

    ComPtr<IDXGIFactory6> factory;
    Check(CreateDXGIFactory2(0, IID_PPV_ARGS(&factory)), "CreateDXGIFactory2");
    ComPtr<IDXGIAdapter1> adapter;
    DXGI_ADAPTER_DESC1 adapterDesc{};
    bool found = false;
    for (UINT i = 0; factory->EnumAdapters1(i, &adapter) != DXGI_ERROR_NOT_FOUND; ++i) {
        adapter->GetDesc1(&adapterDesc);
        if (!(adapterDesc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) &&
            adapterDesc.VendorId == 0x8086 && adapterDesc.DeviceId == 0xe20b) {
            found = true;
            break;
        }
        adapter.Reset();
    }
    if (!found) {
        std::fprintf(stderr, "Intel Arc B580 (vendor 8086, device e20b) not found; refusing to use another GPU\n");
        return 3;
    }

    ComPtr<ID3D12Device> device;
    Check(D3D12CreateDevice(adapter.Get(), D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&device)), "D3D12CreateDevice");
    D3D12_COMMAND_QUEUE_DESC queueDesc{};
    queueDesc.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
    ComPtr<ID3D12CommandQueue> queue;
    Check(device->CreateCommandQueue(&queueDesc, IID_PPV_ARGS(&queue)), "CreateCommandQueue");

    DXGI_SWAP_CHAIN_DESC1 swapDesc{};
    swapDesc.Width = kWidth;
    swapDesc.Height = kHeight;
    swapDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    swapDesc.SampleDesc.Count = 1;
    swapDesc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    swapDesc.BufferCount = kBufferCount;
    swapDesc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    swapDesc.AlphaMode = DXGI_ALPHA_MODE_IGNORE;
    ComPtr<IDXGISwapChain1> swap1;
    Check(factory->CreateSwapChainForHwnd(queue.Get(), g_window, &swapDesc, nullptr, nullptr, &swap1),
        "CreateSwapChainForHwnd");
    Check(factory->MakeWindowAssociation(g_window, DXGI_MWA_NO_ALT_ENTER), "MakeWindowAssociation");
    ComPtr<IDXGISwapChain3> swap;
    Check(swap1.As(&swap), "Query IDXGISwapChain3");

    D3D12_DESCRIPTOR_HEAP_DESC rtvHeapDesc{};
    rtvHeapDesc.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
    rtvHeapDesc.NumDescriptors = kBufferCount;
    ComPtr<ID3D12DescriptorHeap> rtvHeap;
    Check(device->CreateDescriptorHeap(&rtvHeapDesc, IID_PPV_ARGS(&rtvHeap)), "Create RTV heap");
    const UINT rtvStride = device->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_RTV);
    D3D12_CPU_DESCRIPTOR_HANDLE rtvStart = rtvHeap->GetCPUDescriptorHandleForHeapStart();
    ComPtr<ID3D12Resource> backBuffers[kBufferCount];
    for (UINT i = 0; i < kBufferCount; ++i) {
        Check(swap->GetBuffer(i, IID_PPV_ARGS(&backBuffers[i])), "SwapChain::GetBuffer");
        D3D12_CPU_DESCRIPTOR_HANDLE handle = rtvStart;
        handle.ptr += static_cast<SIZE_T>(i) * rtvStride;
        device->CreateRenderTargetView(backBuffers[i].Get(), nullptr, handle);
    }

    D3D12_ROOT_SIGNATURE_DESC rootDesc{};
    rootDesc.Flags = D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT;
    ComPtr<ID3DBlob> serializedRoot, rootErrors;
    HRESULT hr = D3D12SerializeRootSignature(&rootDesc, D3D_ROOT_SIGNATURE_VERSION_1,
        &serializedRoot, &rootErrors);
    if (FAILED(hr)) {
        if (rootErrors) std::fwrite(rootErrors->GetBufferPointer(), 1, rootErrors->GetBufferSize(), stderr);
        Fail("D3D12SerializeRootSignature", hr);
    }
    ComPtr<ID3D12RootSignature> rootSignature;
    Check(device->CreateRootSignature(0, serializedRoot->GetBufferPointer(), serializedRoot->GetBufferSize(),
        IID_PPV_ARGS(&rootSignature)), "CreateRootSignature");

    const char* vsSource =
        "struct O{float4 p:SV_POSITION;};"
        "O main(uint id:SV_VertexID){float2 p[3]={float2(-1,-1),float2(-1,3),float2(3,-1)};"
        "O o;o.p=float4(p[id],0,1);return o;}";
    const char* psSource =
        "float4 main(float4 pos:SV_POSITION):SV_TARGET{float2 p=pos.xy;"
        "float inside=(p.x>48&&p.x<912&&p.y>64&&p.y<576)?1:0;"
        "float checker=fmod(floor(p.x/24)+floor(p.y/24),2);"
        "float3 c=inside?lerp(float3(.416,.537,.737),float3(.792,.682,.298),checker):float3(.035,.045,.065);"
        "if(inside&&p.x>110&&p.x<850&&abs(p.y-(p.x*.75+70))<=2)c=float3(.96,.93,.88);"
        "if(inside&&p.x>140&&p.x<820&&p.y>165&&p.y<475)c=float3(.137,.282,.408);"
        "if(inside&&p.x>160&&p.x<800&&p.y>185&&p.y<455&&fmod(floor(p.x/7)+floor(p.y/9),5)==0)c=float3(.518,.749,.835);"
        "return float4(c,1);}";
    ComPtr<ID3DBlob> vs = Compile(vsSource, "vs_5_1");
    ComPtr<ID3DBlob> ps = Compile(psSource, "ps_5_1");
    D3D12_GRAPHICS_PIPELINE_STATE_DESC psoDesc{};
    psoDesc.pRootSignature = rootSignature.Get();
    psoDesc.VS = {vs->GetBufferPointer(), vs->GetBufferSize()};
    psoDesc.PS = {ps->GetBufferPointer(), ps->GetBufferSize()};
    psoDesc.BlendState.AlphaToCoverageEnable = FALSE;
    psoDesc.BlendState.IndependentBlendEnable = FALSE;
    const D3D12_RENDER_TARGET_BLEND_DESC defaultBlend{
        FALSE, FALSE, D3D12_BLEND_ONE, D3D12_BLEND_ZERO, D3D12_BLEND_OP_ADD,
        D3D12_BLEND_ONE, D3D12_BLEND_ZERO, D3D12_BLEND_OP_ADD,
        D3D12_LOGIC_OP_NOOP, D3D12_COLOR_WRITE_ENABLE_ALL};
    for (auto& rt : psoDesc.BlendState.RenderTarget) rt = defaultBlend;
    psoDesc.SampleMask = UINT_MAX;
    psoDesc.RasterizerState.FillMode = D3D12_FILL_MODE_SOLID;
    psoDesc.RasterizerState.CullMode = D3D12_CULL_MODE_NONE;
    psoDesc.RasterizerState.DepthClipEnable = TRUE;
    psoDesc.DepthStencilState.DepthEnable = FALSE;
    psoDesc.DepthStencilState.StencilEnable = FALSE;
    psoDesc.InputLayout = {nullptr, 0};
    psoDesc.PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
    psoDesc.NumRenderTargets = 1;
    psoDesc.RTVFormats[0] = swapDesc.Format;
    psoDesc.SampleDesc.Count = 1;
    ComPtr<ID3D12PipelineState> pso;
    Check(device->CreateGraphicsPipelineState(&psoDesc, IID_PPV_ARGS(&pso)), "CreateGraphicsPipelineState");

    ComPtr<ID3D12CommandAllocator> allocator;
    Check(device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&allocator)), "CreateCommandAllocator");
    ComPtr<ID3D12GraphicsCommandList> commandList;
    Check(device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, allocator.Get(), pso.Get(),
        IID_PPV_ARGS(&commandList)), "CreateCommandList");
    Check(commandList->Close(), "Close initial command list");

    D3D12_PLACED_SUBRESOURCE_FOOTPRINT readbackFootprint{};
    UINT rows = 0;
    UINT64 rowBytes = 0, readbackBytes = 0;
    const D3D12_RESOURCE_DESC backDesc = backBuffers[0]->GetDesc();
    device->GetCopyableFootprints(&backDesc, 0, 1, 0, &readbackFootprint, &rows, &rowBytes, &readbackBytes);
    ComPtr<ID3D12Resource> readback = CreateBuffer(device.Get(), readbackBytes, D3D12_HEAP_TYPE_READBACK,
        D3D12_RESOURCE_STATE_COPY_DEST);
    D3D12_RANGE cpuReadRange{0, static_cast<SIZE_T>(readbackBytes)};
    uint8_t* mappedReadback = nullptr;
    Check(readback->Map(0, &cpuReadRange, reinterpret_cast<void**>(&mappedReadback)), "Map readback buffer");

    ComPtr<ID3D12Fence> fence;
    Check(device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&fence)), "CreateFence");
    HANDLE fenceEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!fenceEvent) { std::fprintf(stderr, "CreateEvent failed: %lu\n", GetLastError()); return 2; }
    UINT64 fenceValue = 0;
    std::vector<uint8_t> pixels(static_cast<size_t>(kWidth) * kHeight * 4);
    bool hasCapture = false;

    for (int frame = 0; frame < frames; ++frame) {
        MSG msg{};
        while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if (!IsWindow(g_window)) { std::fprintf(stderr, "Probe window closed before capture\n"); return 4; }
        const UINT bufferIndex = swap->GetCurrentBackBufferIndex();
        Check(allocator->Reset(), "CommandAllocator::Reset");
        Check(commandList->Reset(allocator.Get(), pso.Get()), "CommandList::Reset");
        D3D12_RESOURCE_BARRIER toTarget{};
        toTarget.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
        toTarget.Transition.pResource = backBuffers[bufferIndex].Get();
        toTarget.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
        toTarget.Transition.StateBefore = D3D12_RESOURCE_STATE_PRESENT;
        toTarget.Transition.StateAfter = D3D12_RESOURCE_STATE_RENDER_TARGET;
        commandList->ResourceBarrier(1, &toTarget);
        D3D12_CPU_DESCRIPTOR_HANDLE rtv = rtvStart;
        rtv.ptr += static_cast<SIZE_T>(bufferIndex) * rtvStride;
        commandList->OMSetRenderTargets(1, &rtv, FALSE, nullptr);
        const float clear[4]{0.035f, 0.045f, 0.065f, 1.0f};
        commandList->ClearRenderTargetView(rtv, clear, 0, nullptr);
        commandList->SetGraphicsRootSignature(rootSignature.Get());
        commandList->SetPipelineState(pso.Get());
        commandList->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        D3D12_VIEWPORT viewport{0, 0, static_cast<float>(kWidth), static_cast<float>(kHeight), 0, 1};
        D3D12_RECT scissor{0, 0, static_cast<LONG>(kWidth), static_cast<LONG>(kHeight)};
        commandList->RSSetViewports(1, &viewport);
        commandList->RSSetScissorRects(1, &scissor);
        commandList->DrawInstanced(3, 1, 0, 0);
        D3D12_RESOURCE_BARRIER toPresent = toTarget;
        toPresent.Transition.StateBefore = D3D12_RESOURCE_STATE_RENDER_TARGET;
        toPresent.Transition.StateAfter = D3D12_RESOURCE_STATE_PRESENT;
        commandList->ResourceBarrier(1, &toPresent);
        Check(commandList->Close(), "Close render command list");
        ID3D12CommandList* renderLists[]{commandList.Get()};
        queue->ExecuteCommandLists(1, renderLists);
        Check(swap->Present(1, 0), "Present");
        // Retire the render allocator before resetting it for the readback list.
        WaitForFence(queue.Get(), fence.Get(), fenceEvent, fenceValue);

        // ReShade hooks Present and processes the submitted backbuffer before the
        // original presentation. Read back that exact retained buffer afterward.
        // The queued copy executes after Present on the same direct queue.
        Check(allocator->Reset(), "CommandAllocator::Reset after Present");
        Check(commandList->Reset(allocator.Get(), nullptr), "CommandList::Reset for post-Present copy");
        D3D12_RESOURCE_BARRIER toCopy{};
        toCopy.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
        toCopy.Transition.pResource = backBuffers[bufferIndex].Get();
        toCopy.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
        toCopy.Transition.StateBefore = D3D12_RESOURCE_STATE_PRESENT;
        toCopy.Transition.StateAfter = D3D12_RESOURCE_STATE_COPY_SOURCE;
        commandList->ResourceBarrier(1, &toCopy);
        D3D12_TEXTURE_COPY_LOCATION src{};
        src.pResource = backBuffers[bufferIndex].Get();
        src.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
        src.SubresourceIndex = 0;
        D3D12_TEXTURE_COPY_LOCATION dst{};
        dst.pResource = readback.Get();
        dst.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
        dst.PlacedFootprint = readbackFootprint;
        commandList->CopyTextureRegion(&dst, 0, 0, 0, &src, nullptr);
        D3D12_RESOURCE_BARRIER toPresentAgain = toCopy;
        toPresentAgain.Transition.StateBefore = D3D12_RESOURCE_STATE_COPY_SOURCE;
        toPresentAgain.Transition.StateAfter = D3D12_RESOURCE_STATE_PRESENT;
        commandList->ResourceBarrier(1, &toPresentAgain);
        Check(commandList->Close(), "Close post-Present copy list");
        ID3D12CommandList* copyLists[]{commandList.Get()};
        queue->ExecuteCommandLists(1, copyLists);
        WaitForFence(queue.Get(), fence.Get(), fenceEvent, fenceValue);

        const uint8_t* srcBytes = mappedReadback + readbackFootprint.Offset;
        for (UINT y = 0; y < kHeight; ++y) {
            std::memcpy(pixels.data() + static_cast<size_t>(y) * kWidth * 4,
                srcBytes + static_cast<size_t>(y) * readbackFootprint.Footprint.RowPitch,
                static_cast<size_t>(kWidth) * 4);
        }
        hasCapture = true;
    }
    if (hasCapture) {
        D3D12_RANGE readRange{0, static_cast<SIZE_T>(readbackBytes)};
        readback->Unmap(0, &readRange);
    }
    CloseHandle(fenceEvent);
    const UINT64 expectedPixels = static_cast<UINT64>(kWidth) * kHeight;
    uint64_t checksum = 0, nonBlackPixels = 0;
    uint8_t roi[4]{};
    WriteBmp(output, pixels.data(), checksum, nonBlackPixels, roi);
    if (nonBlackPixels < expectedPixels / 100) {
        std::fprintf(stderr, "Post-Present backbuffer readback is nearly black (%llu/%llu non-black pixels); this is not shader pixel proof\n",
            static_cast<unsigned long long>(nonBlackPixels), static_cast<unsigned long long>(expectedPixels));
        return 6;
    }
    std::wstring outputJson(output);
    for (auto &character : outputJson) if (character == L'\\') character = L'/';
    std::printf("{\"adapter\":\"%ls\",\"vendorId\":%u,\"deviceId\":%u,\"api\":\"D3D12\",\"presentedFrames\":%d,\"captureWidth\":%u,\"captureHeight\":%u,\"checksumFnv1a64\":\"%016llx\",\"centerBGRA\":[%u,%u,%u,%u],\"nonBlackPixels\":%llu,\"capture\":\"%ls\",\"captureMode\":\"post-Present retained swapchain backbuffer copied PRESENT->COPY_SOURCE via direct queue, fence-waited readback\",\"shaderProof\":\"candidate only when ReShade D3D12 hook is active and post-Present output shows its pixel change\"}\n",
        adapterDesc.Description, adapterDesc.VendorId, adapterDesc.DeviceId, frames, kWidth, kHeight,
        static_cast<unsigned long long>(checksum), roi[0], roi[1], roi[2], roi[3],
        static_cast<unsigned long long>(nonBlackPixels), outputJson.c_str());
    return 0;
}
