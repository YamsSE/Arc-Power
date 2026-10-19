#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dwmapi.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <d3dcompiler.h>
#include <wrl/client.h>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <cstdlib>
#include <string>
#include <vector>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "d3dcompiler.lib")
using Microsoft::WRL::ComPtr;

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
static ComPtr<ID3DBlob> Compile(const char* source, const char* target) {
    ComPtr<ID3DBlob> code, errors;
    HRESULT hr = D3DCompile(source, std::strlen(source), nullptr, nullptr, nullptr, "main", target,
        D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &code, &errors);
    if (FAILED(hr)) {
        if (errors) std::fwrite(errors->GetBufferPointer(), 1, errors->GetBufferSize(), stderr);
        Fail("D3DCompile", hr);
    }
    return code;
}
static void WriteBmp(const wchar_t* path, const uint8_t* bgra, int width, int height,
                     uint64_t& checksum, uint8_t roi[4]) {
    const uint32_t imageBytes = static_cast<uint32_t>(width * height * 4);
    BITMAPFILEHEADER file{}; BITMAPINFOHEADER info{};
    file.bfType = 0x4d42; file.bfOffBits = sizeof(file) + sizeof(info); file.bfSize = file.bfOffBits + imageBytes;
    info.biSize = sizeof(info); info.biWidth = width; info.biHeight = -height;
    info.biPlanes = 1; info.biBitCount = 32; info.biCompression = BI_RGB; info.biSizeImage = imageBytes;
    FILE* out = nullptr; _wfopen_s(&out, path, L"wb");
    if (!out) { std::fwprintf(stderr, L"Cannot open output: %s\n", path); std::exit(2); }
    std::fwrite(&file, sizeof(file), 1, out); std::fwrite(&info, sizeof(info), 1, out);
    std::fwrite(bgra, 1, imageBytes, out); std::fclose(out);
    checksum = 1469598103934665603ull;
    for (uint32_t i = 0; i < imageBytes; ++i) { checksum ^= bgra[i]; checksum *= 1099511628211ull; }
    const size_t center = (static_cast<size_t>(height / 2) * width + width / 2) * 4;
    for (int c = 0; c < 4; ++c) roi[c] = bgra[center + c];
}

int wmain(int argc, wchar_t** argv) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    const wchar_t* output = nullptr; int frames = 120; bool gpuCapture = false;
    for (int i = 1; i < argc; ++i) {
        if (!wcscmp(argv[i], L"--output") && i + 1 < argc) output = argv[++i];
        else if (!wcscmp(argv[i], L"--frames") && i + 1 < argc) frames = _wtoi(argv[++i]);
        else if (!wcscmp(argv[i], L"--capture") && i + 1 < argc) gpuCapture = !wcscmp(argv[++i], L"gpu");
    }
    if (!output || frames < 1) { std::fwprintf(stderr, L"Usage: probe.exe --output absolute.bmp [--frames 120]\n"); return 2; }

    WNDCLASSW wc{}; wc.lpfnWndProc = WindowProc; wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"NativeSharpeningProbeWindow"; wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    RegisterClassW(&wc);
    RECT wr{0, 0, 960, 640}; AdjustWindowRect(&wr, WS_OVERLAPPEDWINDOW, FALSE);
    g_window = CreateWindowW(wc.lpszClassName, L"Native D3D11 sharpening render probe", WS_OVERLAPPEDWINDOW,
        80, 80, wr.right - wr.left, wr.bottom - wr.top, nullptr, nullptr, wc.hInstance, nullptr);
    if (!g_window) { std::fprintf(stderr, "CreateWindow failed: %lu\n", GetLastError()); return 2; }
    ShowWindow(g_window, SW_SHOW); UpdateWindow(g_window); SetForegroundWindow(g_window);
    SetWindowPos(g_window, HWND_TOPMOST, 80, 80, wr.right - wr.left, wr.bottom - wr.top,
                 SWP_SHOWWINDOW | SWP_NOACTIVATE);

    ComPtr<IDXGIFactory1> factory; HRESULT hr = CreateDXGIFactory1(IID_PPV_ARGS(&factory)); if (FAILED(hr)) Fail("CreateDXGIFactory1", hr);
    ComPtr<IDXGIAdapter1> adapter; DXGI_ADAPTER_DESC1 adapterDesc{}; bool found = false;
    for (UINT i = 0; factory->EnumAdapters1(i, &adapter) != DXGI_ERROR_NOT_FOUND; ++i) {
        adapter->GetDesc1(&adapterDesc);
        if (!(adapterDesc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) && wcsstr(adapterDesc.Description, L"B580")) { found = true; break; }
        adapter.Reset();
    }
    if (!found) { std::fprintf(stderr, "Intel Arc B580 adapter not found; refusing to use another GPU\n"); return 3; }

    D3D_FEATURE_LEVEL feature{}; ComPtr<ID3D11Device> device; ComPtr<ID3D11DeviceContext> context;
    hr = D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, 0, nullptr, 0, D3D11_SDK_VERSION,
                           &device, &feature, &context); if (FAILED(hr)) Fail("D3D11CreateDevice", hr);
    DXGI_SWAP_CHAIN_DESC scd{}; scd.BufferDesc.Width = 960; scd.BufferDesc.Height = 640;
    scd.BufferDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; scd.SampleDesc.Count = 1;
    scd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT; scd.BufferCount = 2; scd.OutputWindow = g_window;
    scd.Windowed = TRUE; scd.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
    ComPtr<IDXGISwapChain> swap; hr = factory->CreateSwapChain(device.Get(), &scd, &swap); if (FAILED(hr)) Fail("CreateSwapChain", hr);
    ComPtr<ID3D11Texture2D> back; hr = swap->GetBuffer(0, IID_PPV_ARGS(&back)); if (FAILED(hr)) Fail("GetBuffer", hr);
    ComPtr<ID3D11RenderTargetView> rtv; hr = device->CreateRenderTargetView(back.Get(), nullptr, &rtv); if (FAILED(hr)) Fail("CreateRTV", hr);

    const char* vsSrc = "struct O{float4 p:SV_POSITION;float2 uv:TEXCOORD;}; O main(uint id:SV_VertexID){float2 p[3]={float2(-1,-1),float2(-1,3),float2(3,-1)};O o;o.p=float4(p[id],0,1);o.uv=(p[id]+1)*0.5;return o;}";
    const char* psSrc = "Texture2D t:register(t0);SamplerState s:register(s0);float4 main(float4 p:SV_POSITION,float2 uv:TEXCOORD):SV_TARGET{float2 d=1.0/512.0;float4 c=t.Sample(s,uv)*0.5;c+=(t.Sample(s,uv+float2(d.x,0))+t.Sample(s,uv-float2(d.x,0))+t.Sample(s,uv+float2(0,d.y))+t.Sample(s,uv-float2(0,d.y)))*0.125;return c;}";
    auto vsCode = Compile(vsSrc, "vs_5_0"), psCode = Compile(psSrc, "ps_5_0");
    ComPtr<ID3D11VertexShader> vs; ComPtr<ID3D11PixelShader> ps;
    hr = device->CreateVertexShader(vsCode->GetBufferPointer(), vsCode->GetBufferSize(), nullptr, &vs); if (FAILED(hr)) Fail("CreateVS", hr);
    hr = device->CreatePixelShader(psCode->GetBufferPointer(), psCode->GetBufferSize(), nullptr, &ps); if (FAILED(hr)) Fail("CreatePS", hr);
    constexpr int tw = 512, th = 512; std::vector<uint8_t> texels(tw * th * 4);
    for (int y = 0; y < th; ++y) for (int x = 0; x < tw; ++x) {
        const int i = (y * tw + x) * 4; int r = 30, g = 38, b = 52;
        if (x > 48 && x < 464 && y > 64 && y < 448) {
            const bool checker = ((x / 24 + y / 24) & 1) != 0;
            r = checker ? 202 : 106; g = checker ? 174 : 137; b = checker ? 76 : 188;
            if (x > 110 && x < 398 && (abs(y - (x * 3 / 4 + 70)) <= 2)) { r = 245; g = 238; b = 224; }
            if (x > 140 && x < 372 && y > 165 && y < 347) { r = 35; g = 72; b = 104; }
            if (x > 160 && x < 352 && y > 185 && y < 327 && (((x / 7 + y / 9) % 5) == 0)) { r = 132; g = 191; b = 213; }
        }
        texels[i] = static_cast<uint8_t>(b); texels[i+1] = static_cast<uint8_t>(g); texels[i+2] = static_cast<uint8_t>(r); texels[i+3] = 255;
    }
    D3D11_TEXTURE2D_DESC td{}; td.Width = tw; td.Height = th; td.MipLevels = td.ArraySize = 1; td.Format = DXGI_FORMAT_B8G8R8A8_UNORM; td.SampleDesc.Count = 1; td.Usage = D3D11_USAGE_IMMUTABLE; td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    D3D11_SUBRESOURCE_DATA init{texels.data(), tw * 4, 0}; ComPtr<ID3D11Texture2D> texture;
    hr = device->CreateTexture2D(&td, &init, &texture); if (FAILED(hr)) Fail("CreateTexture", hr);
    ComPtr<ID3D11ShaderResourceView> srv; hr = device->CreateShaderResourceView(texture.Get(), nullptr, &srv); if (FAILED(hr)) Fail("CreateSRV", hr);
    D3D11_SAMPLER_DESC sd{}; sd.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR; sd.AddressU = sd.AddressV = sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP; sd.MaxLOD = D3D11_FLOAT32_MAX;
    ComPtr<ID3D11SamplerState> sampler; hr = device->CreateSamplerState(&sd, &sampler); if (FAILED(hr)) Fail("CreateSampler", hr);
    D3D11_RASTERIZER_DESC rd{}; rd.FillMode = D3D11_FILL_SOLID; rd.CullMode = D3D11_CULL_NONE; rd.ScissorEnable = FALSE;
    ComPtr<ID3D11RasterizerState> raster; hr = device->CreateRasterizerState(&rd, &raster); if (FAILED(hr)) Fail("CreateRasterizer", hr);
    D3D11_VIEWPORT vp{0, 0, 960, 640, 0, 1}; context->RSSetViewports(1, &vp); context->RSSetState(raster.Get());
    context->OMSetRenderTargets(1, rtv.GetAddressOf(), nullptr); context->VSSetShader(vs.Get(), nullptr, 0); context->PSSetShader(ps.Get(), nullptr, 0);
    context->PSSetShaderResources(0, 1, srv.GetAddressOf()); context->PSSetSamplers(0, 1, sampler.GetAddressOf()); context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    for (int frame = 0; frame < frames; ++frame) {
        MSG msg{}; while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&msg); DispatchMessageW(&msg); }
        const float clear[4]{0.035f, 0.045f, 0.065f, 1.0f}; context->ClearRenderTargetView(rtv.Get(), clear);
        context->Draw(3, 0); hr = swap->Present(1, 0); if (FAILED(hr)) Fail("Present", hr);
    }
    DwmFlush(); Sleep(300);
    const int width = 960, height = 640;
    std::vector<uint8_t> pixels(static_cast<size_t>(width) * height * 4);
    DXGI_OUTDUPL_FRAME_INFO fi{};
    if (gpuCapture) {
        // Diagnostic mode: read the application's swapchain texture after Present.
        // This proves the rendered D3D11 image, not the monitor's post-driver pixels.
        D3D11_TEXTURE2D_DESC cap{}; cap.Width = width; cap.Height = height; cap.MipLevels = cap.ArraySize = 1;
        cap.Format = DXGI_FORMAT_B8G8R8A8_UNORM; cap.SampleDesc.Count = 1; cap.Usage = D3D11_USAGE_STAGING; cap.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        ComPtr<ID3D11Texture2D> staging; hr = device->CreateTexture2D(&cap, nullptr, &staging); if (FAILED(hr)) Fail("Create post-Present GPU staging texture", hr);
        context->CopyResource(staging.Get(), back.Get()); context->Flush();
        D3D11_MAPPED_SUBRESOURCE mapped{}; hr = context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped); if (FAILED(hr)) Fail("Map post-Present GPU backbuffer", hr);
        for (int y = 0; y < height; ++y) std::memcpy(pixels.data() + static_cast<size_t>(y) * width * 4, static_cast<uint8_t*>(mapped.pData) + static_cast<size_t>(y) * mapped.RowPitch, width * 4);
        context->Unmap(staging.Get(), 0);
    } else {
    ComPtr<IDXGIOutput> dxgiOutput; bool outputFound = false;
    for (UINT i = 0; adapter->EnumOutputs(i, &dxgiOutput) != DXGI_ERROR_NOT_FOUND; ++i) {
        DXGI_OUTPUT_DESC od{}; dxgiOutput->GetDesc(&od); if (od.AttachedToDesktop && od.Monitor == MonitorFromWindow(g_window, MONITOR_DEFAULTTONEAREST)) { outputFound = true; break; } dxgiOutput.Reset();
    }
    if (!outputFound) { std::fprintf(stderr, "No B580 desktop output for probe window\n"); return 4; }
    ComPtr<IDXGIOutput1> output1; hr = dxgiOutput.As(&output1); if (FAILED(hr)) Fail("Query IDXGIOutput1", hr);
    ComPtr<IDXGIOutputDuplication> duplication; hr = output1->DuplicateOutput(device.Get(), &duplication); if (FAILED(hr)) Fail("DuplicateOutput (desktop capture unavailable)", hr);
    RECT client{}; GetClientRect(g_window, &client); POINT origin{0, 0}; ClientToScreen(g_window, &origin);
    ComPtr<IDXGIResource> resource; hr = duplication->AcquireNextFrame(5000, &fi, &resource); if (FAILED(hr)) Fail("AcquireNextFrame after Present", hr);
    ComPtr<ID3D11Texture2D> desktop; hr = resource.As(&desktop); if (FAILED(hr)) Fail("Desktop texture", hr);
    DXGI_OUTDUPL_DESC dd{}; duplication->GetDesc(&dd); DXGI_OUTPUT_DESC od{}; dxgiOutput->GetDesc(&od);
    const int left = origin.x - od.DesktopCoordinates.left, top = origin.y - od.DesktopCoordinates.top;
    const int cropWidth = client.right - client.left, cropHeight = client.bottom - client.top;
    if (left < 0 || top < 0 || left + cropWidth > static_cast<int>(dd.ModeDesc.Width) || top + cropHeight > static_cast<int>(dd.ModeDesc.Height)) { duplication->ReleaseFrame(); std::fprintf(stderr, "Probe client rectangle is outside duplication surface\n"); return 5; }
    D3D11_TEXTURE2D_DESC cap{}; cap.Width = cropWidth; cap.Height = cropHeight; cap.MipLevels = cap.ArraySize = 1; cap.Format = dd.ModeDesc.Format; cap.SampleDesc.Count = 1; cap.Usage = D3D11_USAGE_STAGING; cap.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ComPtr<ID3D11Texture2D> staging; hr = device->CreateTexture2D(&cap, nullptr, &staging); if (FAILED(hr)) { duplication->ReleaseFrame(); Fail("Create capture staging texture", hr); }
    D3D11_BOX box{static_cast<UINT>(left), static_cast<UINT>(top), 0, static_cast<UINT>(left + width), static_cast<UINT>(top + height), 1};
    context->CopySubresourceRegion(staging.Get(), 0, 0, 0, 0, desktop.Get(), 0, &box); context->Flush();
    D3D11_MAPPED_SUBRESOURCE mapped{}; hr = context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped); if (FAILED(hr)) { duplication->ReleaseFrame(); Fail("Map captured desktop crop", hr); }
    for (int y = 0; y < cropHeight; ++y) std::memcpy(pixels.data() + static_cast<size_t>(y) * cropWidth * 4, static_cast<uint8_t*>(mapped.pData) + static_cast<size_t>(y) * mapped.RowPitch, cropWidth * 4);
    context->Unmap(staging.Get(), 0); duplication->ReleaseFrame();
    bool hasVisiblePixels = false;
    for (size_t i = 0; i < pixels.size(); i += 4) if (pixels[i] || pixels[i + 1] || pixels[i + 2]) { hasVisiblePixels = true; break; }
    if (!hasVisiblePixels) { std::fprintf(stderr, "Desktop Duplication returned an all-black client crop; refusing empty pixel proof (LastPresentTime=%lld, accumulatedFrames=%u)\n", static_cast<long long>(fi.LastPresentTime.QuadPart), fi.AccumulatedFrames); return 6; }
    }
    uint64_t checksum{}; uint8_t roi[4]{}; WriteBmp(output, pixels.data(), width, height, checksum, roi);
    std::wstring outputJson(output);
    for (auto &character : outputJson) if (character == L'\\') character = L'/';
    std::printf("{\"adapter\":\"Intel Arc B580\",\"vendorId\":%u,\"deviceId\":%u,\"api\":\"%s\",\"presentedFrames\":%d,\"captureWidth\":%d,\"captureHeight\":%d,\"checksumFnv1a64\":\"%016llx\",\"centerBGRA\":[%u,%u,%u,%u],\"capture\":\"%ls\",\"crop\":\"probe client window only\"}\n", adapterDesc.VendorId, adapterDesc.DeviceId, gpuCapture ? "D3D11 application backbuffer staging readback after Present (GPU proof only)" : "D3D11 + DXGI Desktop Duplication post-Present", frames, width, height, static_cast<unsigned long long>(checksum), roi[0], roi[1], roi[2], roi[3], outputJson.c_str());
    return 0;
}
