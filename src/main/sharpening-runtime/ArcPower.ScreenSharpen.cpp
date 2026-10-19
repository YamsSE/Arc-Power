#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <dwmapi.h>
#include <d3dcompiler.h>
#include <winrt/base.h>
#include <wrl/client.h>
#include <atomic>
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;
using namespace winrt;

namespace {

constexpr wchar_t kOverlayClass[] = L"ArcPowerScreenSharpenOverlayV1";
constexpr char kShader[] = R"(
Texture2D image : register(t0); SamplerState samp : register(s0);
cbuffer Params : register(b0) { float2 invSize; float amount; float pad; };
struct VOut { float4 pos : SV_Position; float2 uv : TEXCOORD0; };
VOut VS(uint id : SV_VertexID) {
  VOut o; float2 p=float2((id<<1)&2,id&2); o.uv=p;
  o.pos=float4(p*float2(2,-2)+float2(-1,1),0,1); return o;
}
float4 PS(VOut i) : SV_Target {
  float4 c=image.Sample(samp,i.uv);
  if(amount<=0.0) return c;
  float3 n=image.Sample(samp,i.uv+float2(0,-invSize.y)).rgb;
  float3 s=image.Sample(samp,i.uv+float2(0, invSize.y)).rgb;
  float3 e=image.Sample(samp,i.uv+float2(invSize.x,0)).rgb;
  float3 w=image.Sample(samp,i.uv+float2(-invSize.x,0)).rgb;
  float3 detail=clamp(c.rgb-(n+s+e+w)*0.25,-0.20,0.20);
  c.rgb=saturate(c.rgb+amount*detail); return c;
})";

struct Command { DWORD pid{}; int percent{}; unsigned long long revision{}; };
std::mutex g_commandMutex;
Command g_command;
std::atomic<bool> g_stop{false};
std::mutex g_outputMutex;

void error(const std::string& text) {
  std::lock_guard<std::mutex> lock(g_outputMutex);
  std::cerr << "ERROR " << text << std::endl;
}

void warning(const std::string& text) {
  std::lock_guard<std::mutex> lock(g_outputMutex);
  std::cerr << "WARN " << text << std::endl;
}

void statusLine(const std::string& text) {
  std::lock_guard<std::mutex> lock(g_outputMutex);
  std::cout << text << std::endl;
}

LRESULT CALLBACK overlayProc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
  return DefWindowProcW(hwnd, message, wparam, lparam);
}

void readCommands() {
  std::string line;
  while (std::getline(std::cin, line)) {
    std::istringstream input(line);
    std::string verb, extra;
    input >> verb;
    if (verb == "STOP" && !(input >> extra)) { g_stop.store(true); return; }
    if (verb == "SET") {
      unsigned long long pid = 0;
      int percent = -1;
      if ((input >> pid >> percent) && !(input >> extra) && pid <= MAXDWORD && (pid > 0 || percent == 0) && percent >= 0 && percent <= 100) {
        std::lock_guard<std::mutex> lock(g_commandMutex);
        g_command.pid = static_cast<DWORD>(pid);
        g_command.percent = percent;
        ++g_command.revision;
      } else warning("ignored malformed command; expected SET <decimal-pid> <0-100> or STOP");
      continue;
    }
    warning("ignored malformed command; expected SET <decimal-pid> <0-100> or STOP");
  }
  g_stop.store(true);
}

Command currentCommand() {
  std::lock_guard<std::mutex> lock(g_commandMutex);
  return g_command;
}

void pumpMessages() {
  MSG message{};
  while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
}

bool rectEqual(const RECT& a, const RECT& b) {
  return a.left == b.left && a.top == b.top && a.right == b.right && a.bottom == b.bottom;
}

struct Runtime {
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  ComPtr<ID3D11VertexShader> vertexShader;
  ComPtr<ID3D11PixelShader> pixelShader;
  ComPtr<ID3D11Buffer> constants;
  ComPtr<ID3D11SamplerState> sampler;
  ComPtr<ID3D11RasterizerState> rasterizer;
  ComPtr<IDXGIAdapter1> adapter;
  ComPtr<IDXGIOutput> output;
  ComPtr<IDXGIOutputDuplication> duplication;
  RECT outputBounds{};
  HWND overlay{};
  bool overlayVisible{};
  ComPtr<IDXGISwapChain> swapChain;
  ComPtr<ID3D11RenderTargetView> backBufferRtv;
  ComPtr<ID3D11Texture2D> cropTexture;
  ComPtr<ID3D11ShaderResourceView> cropSrv;
  DXGI_FORMAT cropFormat{DXGI_FORMAT_UNKNOWN};
  UINT width{};
  UINT height{};

  void initializeDevice(HWND target) {
    ComPtr<IDXGIFactory1> factory;
    HRESULT hr = CreateDXGIFactory1(IID_PPV_ARGS(&factory));
    if (FAILED(hr)) throw hresult_error(hr, L"CreateDXGIFactory1 failed");
    const HMONITOR targetMonitor = MonitorFromWindow(target, MONITOR_DEFAULTTONEAREST);
    for (UINT index = 0; ; ++index) {
      ComPtr<IDXGIAdapter1> candidate;
      hr = factory->EnumAdapters1(index, &candidate);
      if (hr == DXGI_ERROR_NOT_FOUND) break;
      if (FAILED(hr)) throw hresult_error(hr, L"EnumAdapters1 failed");
      DXGI_ADAPTER_DESC1 desc{};
      candidate->GetDesc1(&desc);
      if (desc.VendorId != 0x8086) continue;
      std::wstring adapterName(desc.Description);
      if (adapterName.find(L"Arc") == std::wstring::npos && adapterName.find(L"ARC") == std::wstring::npos) continue;
      ComPtr<IDXGIOutput> matchedOutput;
      for (UINT outputIndex = 0; ; ++outputIndex) {
        ComPtr<IDXGIOutput> candidateOutput;
        HRESULT outputHr = candidate->EnumOutputs(outputIndex, &candidateOutput);
        if (outputHr == DXGI_ERROR_NOT_FOUND) break;
        if (FAILED(outputHr)) throw hresult_error(outputHr, L"Enumerate adapter outputs failed");
        DXGI_OUTPUT_DESC outputDesc{};
        if (SUCCEEDED(candidateOutput->GetDesc(&outputDesc)) && outputDesc.Monitor == targetMonitor) {
          matchedOutput = candidateOutput;
          outputBounds = outputDesc.DesktopCoordinates;
          break;
        }
      }
      if (!matchedOutput) continue;
      D3D_FEATURE_LEVEL feature{};
      hr = D3D11CreateDevice(candidate.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
          D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
          &device, &feature, &context);
      if (SUCCEEDED(hr)) { adapter = candidate; output = matchedOutput; break; }
    }
    if (!device || !adapter || !output) throw hresult_error(E_NOINTERFACE, L"The foreground monitor is not connected to a usable Intel GPU output");
    ComPtr<IDXGIOutput1> output1;
    if (FAILED(hr = output.As(&output1))) throw hresult_error(hr, L"Query IDXGIOutput1 failed");
    if (FAILED(hr = output1->DuplicateOutput(device.Get(), &duplication)))
      throw hresult_error(hr, L"Create Desktop Duplication for the Intel output failed");

    ComPtr<ID3DBlob> vs, ps, errors;
    hr = D3DCompile(kShader, sizeof(kShader)-1, "ArcPowerScreenSharpen", nullptr, nullptr,
        "VS", "vs_4_0", D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &vs, &errors);
    if (FAILED(hr)) throw hresult_error(hr, L"Compile vertex shader failed");
    hr = D3DCompile(kShader, sizeof(kShader)-1, "ArcPowerScreenSharpen", nullptr, nullptr,
        "PS", "ps_4_0", D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &ps, &errors);
    if (FAILED(hr)) throw hresult_error(hr, L"Compile pixel shader failed");
    if (FAILED(hr = device->CreateVertexShader(vs->GetBufferPointer(), vs->GetBufferSize(), nullptr, &vertexShader)))
      throw hresult_error(hr, L"CreateVertexShader failed");
    if (FAILED(hr = device->CreatePixelShader(ps->GetBufferPointer(), ps->GetBufferSize(), nullptr, &pixelShader)))
      throw hresult_error(hr, L"CreatePixelShader failed");
    D3D11_BUFFER_DESC cb{}; cb.ByteWidth = 16; cb.Usage = D3D11_USAGE_DEFAULT; cb.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
    if (FAILED(hr = device->CreateBuffer(&cb, nullptr, &constants))) throw hresult_error(hr, L"CreateBuffer failed");
    D3D11_SAMPLER_DESC sm{}; sm.Filter = D3D11_FILTER_MIN_MAG_MIP_POINT;
    sm.AddressU = sm.AddressV = sm.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    if (FAILED(hr = device->CreateSamplerState(&sm, &sampler))) throw hresult_error(hr, L"CreateSamplerState failed");
    D3D11_RASTERIZER_DESC rs{}; rs.FillMode = D3D11_FILL_SOLID; rs.CullMode = D3D11_CULL_NONE; rs.DepthClipEnable = TRUE;
    if (FAILED(hr = device->CreateRasterizerState(&rs, &rasterizer))) throw hresult_error(hr, L"CreateRasterizerState failed");
  }

  void resetGraphics() noexcept {
    cropSrv.Reset(); cropTexture.Reset(); cropFormat = DXGI_FORMAT_UNKNOWN; backBufferRtv.Reset();
    duplication.Reset(); output.Reset(); adapter.Reset();
    sampler.Reset(); rasterizer.Reset(); constants.Reset(); pixelShader.Reset(); vertexShader.Reset();
    context.Reset(); device.Reset(); outputBounds = {};
  }

  bool usesMonitor(HWND target) const {
    if (!output || !target) return false;
    DXGI_OUTPUT_DESC desc{};
    return SUCCEEDED(output->GetDesc(&desc)) && desc.Monitor == MonitorFromWindow(target, MONITOR_DEFAULTTONEAREST);
  }

  void createOverlay(const RECT& bounds, HWND target) {
    if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) throw hresult_error(E_INVALIDARG, L"Invalid DWM window bounds");
    if (!usesMonitor(target)) throw hresult_error(E_NOINTERFACE, L"Foreground window is not on the duplicated Intel output");
    width = static_cast<UINT>(bounds.right - bounds.left);
    height = static_cast<UINT>(bounds.bottom - bounds.top);
    overlay = CreateWindowExW(WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_TOOLWINDOW,
        kOverlayClass, L"", WS_POPUP, bounds.left, bounds.top, static_cast<int>(width), static_cast<int>(height),
        nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (!overlay) throw hresult_error(HRESULT_FROM_WIN32(GetLastError()), L"Create overlay window failed");
    // WS_EX_TRANSPARENT is cross-process click-through only for layered
    // windows. Keep the rendered image fully opaque while letting game input
    // pass through this helper-owned top-level HWND.
    if (!SetLayeredWindowAttributes(overlay, 0, 255, LWA_ALPHA))
      throw hresult_error(HRESULT_FROM_WIN32(GetLastError()), L"SetLayeredWindowAttributes failed");
    if (!SetWindowDisplayAffinity(overlay, WDA_EXCLUDEFROMCAPTURE))
      throw hresult_error(HRESULT_FROM_WIN32(GetLastError()), L"SetWindowDisplayAffinity failed");
    DWORD affinity{};
    if (!GetWindowDisplayAffinity(overlay, &affinity) || affinity != WDA_EXCLUDEFROMCAPTURE)
      throw hresult_error(HRESULT_FROM_WIN32(GetLastError()), L"Overlay capture exclusion could not be verified");
    DXGI_SWAP_CHAIN_DESC sd{}; sd.BufferCount = 2; sd.BufferDesc.Width = width; sd.BufferDesc.Height = height;
    sd.BufferDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    sd.OutputWindow = overlay; sd.SampleDesc.Count = 1; sd.Windowed = TRUE; sd.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
    ComPtr<IDXGIDevice> dxgiDevice;
    HRESULT hr = device.As(&dxgiDevice);
    if (FAILED(hr)) throw hresult_error(hr, L"Query IDXGIDevice failed");
    ComPtr<IDXGIAdapter> baseAdapter;
    if (FAILED(hr = dxgiDevice->GetAdapter(&baseAdapter))) throw hresult_error(hr, L"GetAdapter failed");
    ComPtr<IDXGIFactory> parentFactory;
    if (FAILED(hr = baseAdapter->GetParent(IID_PPV_ARGS(&parentFactory)))) throw hresult_error(hr, L"GetParent factory failed");
    if (FAILED(hr = parentFactory->CreateSwapChain(device.Get(), &sd, &swapChain))) throw hresult_error(hr, L"CreateSwapChain failed");
    ComPtr<ID3D11Texture2D> backBuffer;
    if (FAILED(hr = swapChain->GetBuffer(0, IID_PPV_ARGS(&backBuffer)))) throw hresult_error(hr, L"GetBuffer failed");
    if (FAILED(hr = device->CreateRenderTargetView(backBuffer.Get(), nullptr, &backBufferRtv))) throw hresult_error(hr, L"CreateRenderTargetView failed");
    overlayVisible = false;
  }

  void showOverlay() {
    if (!overlay || overlayVisible) return;
    if (!SetWindowPos(overlay, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW))
      throw hresult_error(HRESULT_FROM_WIN32(GetLastError()), L"Show overlay without activation failed");
    overlayVisible = true;
  }

  void destroyOverlay() noexcept {
    backBufferRtv.Reset(); cropSrv.Reset(); cropTexture.Reset(); cropFormat = DXGI_FORMAT_UNKNOWN;
    swapChain.Reset();
    if (overlay) DestroyWindow(overlay);
    overlay = nullptr; overlayVisible = false; width = height = 0;
  }

  void render(ID3D11Texture2D* source, UINT sourceWidth, UINT sourceHeight, int percent) {
    if (!swapChain || !overlay || !backBufferRtv || !cropSrv) return;
    HRESULT hr;
    D3D11_TEXTURE2D_DESC sourceDesc{}; source->GetDesc(&sourceDesc);
    D3D11_VIEWPORT vp{0,0,static_cast<float>(width),static_cast<float>(height),0,1};
    context->RSSetState(rasterizer.Get()); context->RSSetViewports(1, &vp);
    context->OMSetRenderTargets(1, backBufferRtv.GetAddressOf(), nullptr);
    context->VSSetShader(vertexShader.Get(), nullptr, 0); context->PSSetShader(pixelShader.Get(), nullptr, 0);
    context->PSSetShaderResources(0, 1, cropSrv.GetAddressOf()); context->PSSetSamplers(0, 1, sampler.GetAddressOf());
    const float params[4]{1.0f / static_cast<float>(sourceWidth), 1.0f / static_cast<float>(sourceHeight), static_cast<float>(percent) / 100.0f, 0};
    context->UpdateSubresource(constants.Get(), 0, nullptr, params, 0, 0); context->PSSetConstantBuffers(0, 1, constants.GetAddressOf());
    context->IASetInputLayout(nullptr); context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST); context->Draw(3, 0);
    ID3D11ShaderResourceView* nullView = nullptr; context->PSSetShaderResources(0, 1, &nullView);
    hr = swapChain->Present(1, 0);
    if (FAILED(hr)) throw hresult_error(hr, L"Present overlay failed");
  }
};

HWND matchingForeground(DWORD pid) {
  HWND foreground = GetForegroundWindow();
  if (!foreground) return nullptr;
  HWND root = GetAncestor(foreground, GA_ROOT);
  if (!root) root = foreground;
  DWORD actualPid{}; GetWindowThreadProcessId(root, &actualPid);
  if (actualPid != pid || !IsWindowVisible(root) || IsIconic(root)) return nullptr;
  return root;
}

RECT visibleBounds(HWND target) {
  RECT bounds{};
  HRESULT hr = DwmGetWindowAttribute(target, DWMWA_EXTENDED_FRAME_BOUNDS, &bounds, sizeof(bounds));
  if (FAILED(hr)) {
    if (!GetWindowRect(target, &bounds)) throw hresult_error(HRESULT_FROM_WIN32(GetLastError()), L"GetWindowRect failed");
  }
  return bounds;
}

void run() {
  Runtime runtime;
  WNDCLASSW wc{}; wc.lpfnWndProc = overlayProc; wc.hInstance = GetModuleHandleW(nullptr); wc.lpszClassName = kOverlayClass;
  if (!RegisterClassW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS)
    throw hresult_error(HRESULT_FROM_WIN32(GetLastError()), L"RegisterClassW failed");
  statusLine("READY screen-sharpen-v1");
  std::thread inputThread(readCommands);
  inputThread.detach();
  Command command{};
  unsigned long long seenRevision = 0;
  HWND activeWindow = nullptr;
  bool activeAnnounced = false;
  auto nextForegroundCheck = std::chrono::steady_clock::time_point::min();
  RECT lastBounds{};

  auto hideOverlay = [&]() {
    runtime.destroyOverlay();
    if (activeAnnounced) { statusLine("IDLE"); activeAnnounced = false; }
  };
  auto resetActive = [&]() {
    hideOverlay(); activeWindow = nullptr;
  };

  try {
    while (!g_stop.load()) {
      pumpMessages();
      Command incoming = currentCommand();
      if (incoming.revision != seenRevision) { command = incoming; seenRevision = incoming.revision; resetActive(); }
      if (command.percent <= 0 || command.pid == 0) { resetActive(); runtime.resetGraphics(); lastBounds = {}; std::this_thread::sleep_for(std::chrono::milliseconds(40)); continue; }

      auto now = std::chrono::steady_clock::now();
      if (now >= nextForegroundCheck) {
        nextForegroundCheck = now + std::chrono::milliseconds(100);
        HWND foreground = matchingForeground(command.pid);
        if (foreground != activeWindow) { resetActive(); activeWindow = foreground; }
      }
      if (!activeWindow) {
        hideOverlay();
        runtime.resetGraphics(); lastBounds = {};
        std::this_thread::sleep_for(std::chrono::milliseconds(100)); continue;
      }
      try {
        if (!runtime.usesMonitor(activeWindow)) {
          hideOverlay();
          runtime.resetGraphics();
          runtime.initializeDevice(activeWindow);
          statusLine("INFO Desktop Duplication active on Intel Arc output; pointer shape may be composed by Windows separately");
        }
        RECT windowBounds = visibleBounds(activeWindow);
        RECT clipped{
          (std::max)(windowBounds.left, runtime.outputBounds.left),
          (std::max)(windowBounds.top, runtime.outputBounds.top),
          (std::min)(windowBounds.right, runtime.outputBounds.right),
          (std::min)(windowBounds.bottom, runtime.outputBounds.bottom)
        };
        if (clipped.right <= clipped.left || clipped.bottom <= clipped.top) {
          hideOverlay();
          std::this_thread::sleep_for(std::chrono::milliseconds(100));
          continue;
        }
        if (!runtime.overlay || !rectEqual(clipped, lastBounds)) {
          hideOverlay();
          runtime.createOverlay(clipped, activeWindow);
          lastBounds = clipped;
        }
        DXGI_OUTDUPL_FRAME_INFO frameInfo{};
        ComPtr<IDXGIResource> resource;
        HRESULT acquireHr = runtime.duplication->AcquireNextFrame(100, &frameInfo, &resource);
        if (acquireHr == DXGI_ERROR_WAIT_TIMEOUT) continue;
        if (acquireHr == DXGI_ERROR_ACCESS_LOST) {
          warning("Desktop Duplication access was lost; releasing output and retrying shortly");
          hideOverlay(); runtime.resetGraphics(); lastBounds = {};
          std::this_thread::sleep_for(std::chrono::milliseconds(500));
          continue;
        }
        if (FAILED(acquireHr)) throw hresult_error(acquireHr, L"AcquireNextFrame failed");
        bool processingFailed = false;
        try {
          ComPtr<ID3D11Texture2D> desktop;
          HRESULT hr = resource.As(&desktop);
          if (FAILED(hr)) throw hresult_error(hr, L"Query duplicated desktop texture failed");
          D3D11_TEXTURE2D_DESC desktopDesc{}; desktop->GetDesc(&desktopDesc);
          const LONG outputWidth = runtime.outputBounds.right - runtime.outputBounds.left;
          const LONG outputHeight = runtime.outputBounds.bottom - runtime.outputBounds.top;
          if (outputWidth <= 0 || outputHeight <= 0 || desktopDesc.Width != static_cast<UINT>(outputWidth) || desktopDesc.Height != static_cast<UINT>(outputHeight))
            throw hresult_error(E_INVALIDARG, L"Rotated or mismatched output dimensions are not supported; refusing to render a misaligned crop");
          const UINT left = static_cast<UINT>(clipped.left - runtime.outputBounds.left);
          const UINT top = static_cast<UINT>(clipped.top - runtime.outputBounds.top);
          const UINT cropWidth = static_cast<UINT>(clipped.right - clipped.left);
          const UINT cropHeight = static_cast<UINT>(clipped.bottom - clipped.top);
          if (!runtime.cropTexture || runtime.width != cropWidth || runtime.height != cropHeight || runtime.cropFormat != desktopDesc.Format) {
            runtime.cropSrv.Reset(); runtime.cropTexture.Reset();
            D3D11_TEXTURE2D_DESC cropDesc = desktopDesc;
            cropDesc.Width = cropWidth; cropDesc.Height = cropHeight; cropDesc.MipLevels = 1; cropDesc.ArraySize = 1;
            cropDesc.SampleDesc.Count = 1; cropDesc.SampleDesc.Quality = 0; cropDesc.Usage = D3D11_USAGE_DEFAULT;
            cropDesc.BindFlags = D3D11_BIND_SHADER_RESOURCE; cropDesc.MiscFlags = 0; cropDesc.CPUAccessFlags = 0;
            if (FAILED(hr = runtime.device->CreateTexture2D(&cropDesc, nullptr, &runtime.cropTexture))) throw hresult_error(hr, L"Create cropped desktop texture failed");
            D3D11_SHADER_RESOURCE_VIEW_DESC view{}; view.Format = desktopDesc.Format;
            view.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2D; view.Texture2D.MipLevels = 1;
            if (FAILED(hr = runtime.device->CreateShaderResourceView(runtime.cropTexture.Get(), &view, &runtime.cropSrv))) throw hresult_error(hr, L"CreateShaderResourceView failed");
            runtime.cropFormat = desktopDesc.Format;
          }
          D3D11_BOX box{left, top, 0, left + cropWidth, top + cropHeight, 1};
          runtime.context->CopySubresourceRegion(runtime.cropTexture.Get(), 0, 0, 0, 0, desktop.Get(), 0, &box);
          runtime.render(runtime.cropTexture.Get(), cropWidth, cropHeight, command.percent);
          runtime.showOverlay();
          if (!activeAnnounced && runtime.overlayVisible) { statusLine("ACTIVE " + std::to_string(command.pid)); activeAnnounced = true; }
        } catch (const hresult_error& e) {
          warning("desktop frame processing failed (HRESULT " + std::to_string(static_cast<unsigned long>(e.code().value)) + "): " + to_string(e.message()));
          hideOverlay(); lastBounds = {};
          processingFailed = true;
        }
        runtime.duplication->ReleaseFrame();
        if (processingFailed) std::this_thread::sleep_for(std::chrono::milliseconds(500));
      } catch (const hresult_error& e) {
        warning("Desktop Duplication setup failed (HRESULT " + std::to_string(static_cast<unsigned long>(e.code().value)) + "): " + to_string(e.message()));
        hideOverlay(); runtime.resetGraphics(); lastBounds = {};
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
      }
    }
  } catch (...) {
    resetActive();
    throw;
  }
  resetActive();
}

} // namespace

int wmain(int argc, wchar_t** argv) {
  try {
    if (!SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
      DWORD dpiError = GetLastError();
      DWORD failure = dpiError;
      DPI_AWARENESS_CONTEXT currentContext = GetThreadDpiAwarenessContext();
      const bool alreadyPerMonitorAware =
          AreDpiAwarenessContextsEqual(currentContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
          || AreDpiAwarenessContextsEqual(currentContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE);
      bool dpiReady = dpiError == ERROR_ACCESS_DENIED && alreadyPerMonitorAware;
      if (!dpiReady && dpiError == ERROR_INVALID_PARAMETER) {
        // Per-monitor V2 was added after the earliest Windows 10 release this
        // helper can run on. Fall back only to per-monitor awareness.
        dpiReady = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE) != FALSE;
        if (!dpiReady) {
          failure = GetLastError();
          if (failure == ERROR_ACCESS_DENIED) {
            currentContext = GetThreadDpiAwarenessContext();
            dpiReady = AreDpiAwarenessContextsEqual(currentContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE);
          }
        }
      }
      if (!dpiReady) {
        error("unable to enable per-monitor DPI awareness (Win32 " + std::to_string(failure) + ")");
        return 2;
      }
    }
    run();
    return 0;
  } catch (const hresult_error& e) {
    error("fatal HRESULT " + std::to_string(static_cast<unsigned long>(e.code().value)) + ": " + to_string(e.message()));
    return 2;
  } catch (const std::exception& e) {
    error(std::string("fatal: ") + e.what());
    return 2;
  } catch (...) {
    error("fatal: unknown native error");
    return 2;
  }
}
