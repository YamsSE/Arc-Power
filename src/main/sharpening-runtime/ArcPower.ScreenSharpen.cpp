#include <windows.h>
#include <windowsx.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <dwmapi.h>
#include <d3dcompiler.h>
#include <winrt/base.h>
#include <wrl/client.h>
#include <atomic>
#include <algorithm>
#include <climits>
#include <chrono>
#include <cstdio>
#include <iostream>
#include <mutex>
#include <condition_variable>
#include <deque>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
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

constexpr char kLanczosShader[] = R"(
Texture2D image : register(t0); SamplerState samp : register(s0);
cbuffer Params : register(b0) { float2 sourceSize; float2 destinationSize; uint axis; uint3 padding; };
struct VOut { float4 pos : SV_Position; float2 uv : TEXCOORD0; };
VOut VS(uint id : SV_VertexID) {
  VOut o; float2 p=float2((id<<1)&2,id&2); o.uv=p;
  o.pos=float4(p*float2(2,-2)+float2(-1,1),0,1); return o;
}
float sinc(float x) { if (abs(x) < 0.00001) return 1.0; x *= 3.14159265359; return sin(x) / x; }
float lanczos(float x) { x = abs(x); return x < 3.0 ? sinc(x) * sinc(x / 3.0) : 0.0; }
float4 ResizePS(VOut i) : SV_Target {
  float sourceLength = axis == 0 ? sourceSize.x : sourceSize.y;
  float destinationLength = axis == 0 ? destinationSize.x : destinationSize.y;
  float coordinate = (axis == 0 ? i.uv.x : i.uv.y) * sourceLength - 0.5;
  float scale = sourceLength / destinationLength;
  float support = max(1.0, scale) * 3.0;
  int first = (int)ceil(coordinate - support);
  int last = (int)floor(coordinate + support);
  float4 total = 0.0; float weightTotal = 0.0;
  [loop] for (int sampleIndex = first; sampleIndex <= last; ++sampleIndex) {
    float distance = (sampleIndex - coordinate) / max(1.0, scale);
    float weight = lanczos(distance);
    float2 uv = i.uv;
    if (axis == 0) uv.x = (sampleIndex + 0.5) / sourceSize.x;
    else uv.y = (sampleIndex + 0.5) / sourceSize.y;
    total += image.Sample(samp, uv) * weight;
    weightTotal += weight;
  }
  return weightTotal > 0.00001 ? total / weightTotal : image.Sample(samp, i.uv);
})";

struct Command { DWORD pid{}; int percent{}; bool asr{}; unsigned long long revision{}; unsigned long long expectedCreation{}; };
std::mutex g_commandMutex;
Command g_command;
std::atomic<bool> g_stop{false};
std::mutex g_outputMutex;
void warning(const std::string& text);
#include "ArcPower.ThumbnailAsr.h"

struct MouseForwardState {
  HWND game{};
  RECT viewport{};
  UINT sourceWidth{};
  UINT sourceHeight{};
  unsigned buttons{};
  LPARAM lastClientPoint{};
};
MouseForwardState g_mouse;
enum MouseButton : unsigned { kLeft = 1, kRight = 2, kMiddle = 4, kX1 = 8, kX2 = 16 };

struct MouseEvent { HWND target{}; UINT message{}; WPARAM wparam{}; LPARAM lparam{}; bool releaseAll{}; };
class MouseDispatcher {
 public:
  MouseDispatcher() : worker_([this] { dispatch(); }) {}
  ~MouseDispatcher() { stop(); }
  void enqueue(MouseEvent event) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (stopping_) return;
    if (event.message == WM_MOUSEMOVE && !events_.empty()) {
      const auto& last = events_.back();
      if (last.message == WM_MOUSEMOVE && last.target == event.target && last.wparam == event.wparam) {
        events_.back() = event;
        ready_.notify_one();
        return;
      }
    }
    events_.push_back(event);
    ready_.notify_one();
  }
  void clearAndRelease(HWND target, LPARAM point) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!stopping_ && target) {
      events_.erase(std::remove_if(events_.begin(), events_.end(), [&](const MouseEvent& event) { return event.target == target; }), events_.end());
      events_.push_back({target, 0, 0, point, true});
      ready_.notify_one();
    }
  }
  void stop() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      events_.erase(std::remove_if(events_.begin(), events_.end(), [](const MouseEvent& event) { return !event.releaseAll; }), events_.end());
      std::deque<MouseEvent> releases;
      for (auto it = events_.rbegin(); it != events_.rend(); ++it) {
        const bool alreadyQueued = std::any_of(releases.begin(), releases.end(), [&](const MouseEvent& candidate) { return candidate.target == it->target; });
        if (!alreadyQueued) releases.push_front(*it);
      }
      events_.swap(releases);
      stopping_ = true; ready_.notify_one();
    }
    if (worker_.joinable()) worker_.join();
  }
 private:
  void dispatch() {
    for (;;) {
      MouseEvent event;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        ready_.wait(lock, [&] { return stopping_ || !events_.empty(); });
        if (events_.empty() && stopping_) return;
        event = events_.front(); events_.pop_front();
      }
      if (!IsWindow(event.target)) continue;
      if (event.releaseAll) {
        unsigned held{};
        { std::lock_guard<std::mutex> lock(mutex_); held = heldButtons_[event.target]; }
        releaseButton(event.target, held, WM_LBUTTONUP, 0, event.lparam, kLeft);
        releaseButton(event.target, held, WM_RBUTTONUP, 0, event.lparam, kRight);
        releaseButton(event.target, held, WM_MBUTTONUP, 0, event.lparam, kMiddle);
        releaseButton(event.target, held, WM_XBUTTONUP, MAKEWPARAM(0, XBUTTON1), event.lparam, kX1);
        releaseButton(event.target, held, WM_XBUTTONUP, MAKEWPARAM(0, XBUTTON2), event.lparam, kX2);
        continue;
      }
      DWORD_PTR ignored{};
      const bool delivered = SendMessageTimeoutW(event.target, event.message, event.wparam, event.lparam,
          SMTO_ABORTIFHUNG | SMTO_BLOCK, 50, &ignored) != FALSE;
      const unsigned button = buttonFor(event.message, event.wparam);
      if (button) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (event.message == WM_LBUTTONDOWN || event.message == WM_RBUTTONDOWN || event.message == WM_MBUTTONDOWN || event.message == WM_XBUTTONDOWN)
          heldButtons_[event.target] |= button;
        else if (delivered) heldButtons_[event.target] &= ~button;
      }
      if (!delivered && GetLastError() == ERROR_ACCESS_DENIED) warning("game rejected forwarded mouse input; input compatibility is not guaranteed");
    }
  }
  static unsigned buttonFor(UINT message, WPARAM wparam) {
    if (message == WM_LBUTTONDOWN || message == WM_LBUTTONUP) return kLeft;
    if (message == WM_RBUTTONDOWN || message == WM_RBUTTONUP) return kRight;
    if (message == WM_MBUTTONDOWN || message == WM_MBUTTONUP) return kMiddle;
    if (message == WM_XBUTTONDOWN || message == WM_XBUTTONUP) return GET_XBUTTON_WPARAM(wparam) == XBUTTON1 ? kX1 : kX2;
    return 0;
  }
  void releaseButton(HWND target, unsigned held, UINT message, WPARAM keys, LPARAM point, unsigned button) {
    if (!(held & button)) return;
    DWORD_PTR ignored{};
    const bool delivered = SendMessageTimeoutW(target, message, keys, point, SMTO_ABORTIFHUNG | SMTO_BLOCK, 50, &ignored) != FALSE;
    if (delivered) { std::lock_guard<std::mutex> lock(mutex_); heldButtons_[target] &= ~button; }
  }
  std::mutex mutex_;
  std::condition_variable ready_;
  std::deque<MouseEvent> events_;
  std::unordered_map<HWND, unsigned> heldButtons_;
  bool stopping_{};
  std::thread worker_;
};
MouseDispatcher g_mouseDispatcher;

bool mapOverlayPoint(HWND hwnd, LPARAM lparam, LPARAM& mapped, bool clampPoint = false) {
  if (!g_mouse.game || g_mouse.viewport.right <= g_mouse.viewport.left || g_mouse.viewport.bottom <= g_mouse.viewport.top ||
      !g_mouse.sourceWidth || !g_mouse.sourceHeight) return false;
  POINT point{GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
  RECT client{};
  if (!GetClientRect(hwnd, &client)) return false;
  POINT origin{client.left, client.top};
  if (!ClientToScreen(hwnd, &origin)) return false;
  point.x += origin.x; point.y += origin.y;
  if (point.x < g_mouse.viewport.left || point.x >= g_mouse.viewport.right ||
      point.y < g_mouse.viewport.top || point.y >= g_mouse.viewport.bottom) {
    if (!clampPoint) return false;
    point.x = (std::clamp)(point.x, g_mouse.viewport.left, g_mouse.viewport.right - 1);
    point.y = (std::clamp)(point.y, g_mouse.viewport.top, g_mouse.viewport.bottom - 1);
  }
  const LONG x = point.x - g_mouse.viewport.left;
  const LONG y = point.y - g_mouse.viewport.top;
  LONG clientX = static_cast<LONG>((static_cast<long long>(x) * g_mouse.sourceWidth) / (g_mouse.viewport.right - g_mouse.viewport.left));
  LONG clientY = static_cast<LONG>((static_cast<long long>(y) * g_mouse.sourceHeight) / (g_mouse.viewport.bottom - g_mouse.viewport.top));
  mapped = MAKELPARAM(static_cast<SHORT>(clientX), static_cast<SHORT>(clientY));
  return true;
}

void forwardMouse(HWND overlay, UINT message, WPARAM wparam, LPARAM lparam, bool clampPoint = false) {
  if (!g_mouse.game || !IsWindow(g_mouse.game)) return;
  LPARAM mapped{};
  if (message == WM_MOUSEWHEEL || message == WM_MOUSEHWHEEL) {
    POINT p{GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
    ScreenToClient(overlay, &p);
    mapped = MAKELPARAM(static_cast<SHORT>(p.x), static_cast<SHORT>(p.y));
    if (!mapOverlayPoint(overlay, mapped, mapped, clampPoint)) return;
    POINT targetPoint{GET_X_LPARAM(mapped), GET_Y_LPARAM(mapped)};
    ClientToScreen(g_mouse.game, &targetPoint);
    mapped = MAKELPARAM(static_cast<SHORT>(targetPoint.x), static_cast<SHORT>(targetPoint.y));
  } else if (!mapOverlayPoint(overlay, lparam, mapped, clampPoint)) return;
  g_mouse.lastClientPoint = mapped;
  g_mouseDispatcher.enqueue({g_mouse.game, message, wparam, mapped});
}

void clearMouseForwarding(HWND overlay) {
  if (!overlay) return;
  g_mouse.buttons = 0;
  g_mouseDispatcher.clearAndRelease(g_mouse.game, g_mouse.lastClientPoint);
  if (GetCapture() == overlay) ReleaseCapture();
  g_mouse.game = nullptr; g_mouse.viewport = {}; g_mouse.sourceWidth = g_mouse.sourceHeight = 0;
}

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
  if (message == WM_MOUSEACTIVATE) return MA_NOACTIVATE;
  if (message == WM_CAPTURECHANGED && reinterpret_cast<HWND>(lparam) != hwnd) {
    if (g_mouse.buttons) clearMouseForwarding(hwnd);
    return 0;
  }
  if (message == WM_MOUSEMOVE) { forwardMouse(hwnd, message, wparam, lparam); return 0; }
  if (message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN || message == WM_MBUTTONDOWN || message == WM_XBUTTONDOWN) {
    LPARAM mapped{};
    if (mapOverlayPoint(hwnd, lparam, mapped)) {
      if (GetCapture() != hwnd) SetCapture(hwnd);
      unsigned button = message == WM_LBUTTONDOWN ? kLeft : message == WM_RBUTTONDOWN ? kRight :
          message == WM_MBUTTONDOWN ? kMiddle : (GET_XBUTTON_WPARAM(wparam) == XBUTTON1 ? kX1 : kX2);
      g_mouse.buttons |= button;
      forwardMouse(hwnd, message, wparam, lparam);
    }
    return message == WM_XBUTTONDOWN ? TRUE : 0;
  }
  if (message == WM_LBUTTONUP || message == WM_RBUTTONUP || message == WM_MBUTTONUP || message == WM_XBUTTONUP) {
    unsigned button = message == WM_LBUTTONUP ? kLeft : message == WM_RBUTTONUP ? kRight :
        message == WM_MBUTTONUP ? kMiddle : (GET_XBUTTON_WPARAM(wparam) == XBUTTON1 ? kX1 : kX2);
    if (g_mouse.buttons & button) {
      forwardMouse(hwnd, message, wparam, lparam, true);
      g_mouse.buttons &= ~button;
      if (!g_mouse.buttons && GetCapture() == hwnd) ReleaseCapture();
    }
    return message == WM_XBUTTONUP ? TRUE : 0;
  }
  if (message == WM_MOUSEWHEEL || message == WM_MOUSEHWHEEL) {
    forwardMouse(hwnd, message, wparam, lparam); return 0;
  }
  return DefWindowProcW(hwnd, message, wparam, lparam);
}

bool parseUnsignedDecimal(std::string_view text, unsigned long long maximum, unsigned long long& value) {
  if (text.empty()) return false;
  value = 0;
  for (char digit : text) {
    if (digit < '0' || digit > '9') return false;
    const unsigned part = static_cast<unsigned>(digit - '0');
    if (value > (maximum - part) / 10) return false;
    value = value * 10 + part;
  }
  return true;
}

bool parseAsrCommand(const std::string& line, DWORD& pid, unsigned long long& creation) {
  std::istringstream input(line);
  std::string verb, pidText, creationText, extra;
  unsigned long long parsedPid{};
  if (!(input >> verb >> pidText) || verb != "ASR" || !parseUnsignedDecimal(pidText, MAXDWORD, parsedPid)) return false;
  pid = static_cast<DWORD>(parsedPid);
  creation = 0;
  if (pid == 0) return !(input >> extra);
  if (!(input >> creationText) || !parseUnsignedDecimal(creationText, ULLONG_MAX, creation) || creation == 0) return false;
  return !(input >> extra);
}

bool parseStopCommand(const std::string& line) {
  std::istringstream input(line);
  std::string verb, extra;
  return (input >> verb) && verb == "STOP" && !(input >> extra);
}

bool nativeCommandParserProbe() {
  const auto accepts = [](const char* line, bool expected) {
    DWORD pid{}; unsigned long long creation{};
    return parseAsrCommand(line, pid, creation) == expected;
  };
  return accepts("ASR 0", true) && accepts("ASR 0 1", false) &&
      accepts("ASR 123 456", true) && accepts("ASR 123", false) &&
      accepts("ASR 123 ", false) && accepts("", false) &&
      accepts("ASR 123 -1", false) && accepts("ASR 123 18446744073709551616", false) &&
      accepts("ASR 123 0", false) && parseStopCommand("STOP") && !parseStopCommand("STOP extra");
}

void readCommands() {
  std::string line;
  while (std::getline(std::cin, line)) {
    std::istringstream input(line);
    std::string verb, extra;
    input >> verb;
    if (verb == "STOP" && parseStopCommand(line)) { g_stop.store(true); return; }
    if (verb == "SET") {
      unsigned long long pid = 0;
      int percent = -1;
      if ((input >> pid >> percent) && !(input >> extra) && pid <= MAXDWORD && (pid > 0 || percent == 0) && percent >= 0 && percent <= 100) {
        std::lock_guard<std::mutex> lock(g_commandMutex);
        g_command.pid = static_cast<DWORD>(pid);
        g_command.percent = percent;
        g_command.asr = false;
        g_command.expectedCreation = 0;
        ++g_command.revision;
      } else warning("ignored malformed command; expected SET <decimal-pid> <0-100> or STOP");
      continue;
    }
    if (verb == "ASR") {
      DWORD pid{}; unsigned long long creation{};
      if (parseAsrCommand(line, pid, creation)) {
        std::lock_guard<std::mutex> lock(g_commandMutex);
        g_command.pid = pid;
        g_command.percent = 0;
        g_command.asr = pid != 0;
        g_command.expectedCreation = creation;
        ++g_command.revision;
      } else warning("ignored malformed command; expected ASR 0, ASR <decimal-pid> <creation-filetime>, or STOP");
      continue;
    }
    warning("ignored malformed command; expected SET <decimal-pid> <0-100>, ASR <decimal-pid>, or STOP");
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

void waitForMessages(DWORD timeoutMs) {
  MsgWaitForMultipleObjects(0, nullptr, FALSE, (std::min<DWORD>)(timeoutMs, 2), QS_ALLINPUT);
}

void messageAwareDelay(DWORD durationMs) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(durationMs);
  while (!g_stop.load() && std::chrono::steady_clock::now() < deadline) {
    waitForMessages(2);
    pumpMessages();
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
  ComPtr<ID3D11PixelShader> lanczosPixelShader;
  ComPtr<ID3D11Buffer> constants;
  ComPtr<ID3D11SamplerState> sampler;
  ComPtr<ID3D11RasterizerState> rasterizer;
  ComPtr<IDXGIAdapter1> adapter;
  ComPtr<IDXGIOutput> output;
  ComPtr<IDXGIOutputDuplication> duplication;
  RECT outputBounds{};
  DXGI_MODE_ROTATION outputRotation{DXGI_MODE_ROTATION_UNSPECIFIED};
  HWND overlay{};
  bool overlayVisible{};
  ComPtr<IDXGISwapChain> swapChain;
  ComPtr<ID3D11RenderTargetView> backBufferRtv;
  ComPtr<ID3D11Texture2D> cropTexture;
  ComPtr<ID3D11ShaderResourceView> cropSrv;
  ComPtr<ID3D11Texture2D> horizontalTexture;
  ComPtr<ID3D11ShaderResourceView> horizontalSrv;
  ComPtr<ID3D11RenderTargetView> horizontalRtv;
  ComPtr<ID3D11Texture2D> scaledTexture;
  ComPtr<ID3D11ShaderResourceView> scaledSrv;
  ComPtr<ID3D11RenderTargetView> scaledRtv;
  DXGI_FORMAT cropFormat{DXGI_FORMAT_UNKNOWN};
  UINT width{};
  UINT height{};
  RECT viewport{};
  UINT sourceWidth{};
  UINT sourceHeight{};
  RECT sourceBounds{};
  bool hasSourceBounds{};
  bool sourceRefreshPending{};
  bool presentationPending{};
  bool asrMode{};
  RECT hitRegion{};
  bool hitRegionApplied{};

  void initializeDevice(HWND target) {
    ComPtr<IDXGIFactory1> factory;
    HRESULT hr = CreateDXGIFactory1(IID_PPV_ARGS(&factory));
    if (FAILED(hr)) throw hresult_error(hr, L"CreateDXGIFactory1 failed");
    const HMONITOR targetMonitor = MonitorFromWindow(target, MONITOR_DEFAULTTONEAREST);
    bool intelOutputFound = false;
    HRESULT deviceCreationError = S_OK;
    for (UINT index = 0; ; ++index) {
      ComPtr<IDXGIAdapter1> candidate;
      hr = factory->EnumAdapters1(index, &candidate);
      if (hr == DXGI_ERROR_NOT_FOUND) break;
      if (FAILED(hr)) throw hresult_error(hr, L"EnumAdapters1 failed");
      DXGI_ADAPTER_DESC1 desc{};
      candidate->GetDesc1(&desc);
      if (desc.VendorId != 0x8086) continue;
      ComPtr<IDXGIOutput> matchedOutput;
      for (UINT outputIndex = 0; ; ++outputIndex) {
        ComPtr<IDXGIOutput> candidateOutput;
        HRESULT outputHr = candidate->EnumOutputs(outputIndex, &candidateOutput);
        if (outputHr == DXGI_ERROR_NOT_FOUND) break;
        if (FAILED(outputHr)) throw hresult_error(outputHr, L"Enumerate adapter outputs failed");
        DXGI_OUTPUT_DESC outputDesc{};
        if (SUCCEEDED(candidateOutput->GetDesc(&outputDesc))
            && outputDesc.AttachedToDesktop && outputDesc.Monitor == targetMonitor) {
          matchedOutput = candidateOutput;
          outputBounds = outputDesc.DesktopCoordinates;
          outputRotation = outputDesc.Rotation;
          intelOutputFound = true;
          break;
        }
      }
      if (!matchedOutput) continue;
      D3D_FEATURE_LEVEL feature{};
      hr = D3D11CreateDevice(candidate.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
          D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
          &device, &feature, &context);
      if (SUCCEEDED(hr)) { adapter = candidate; output = matchedOutput; break; }
      deviceCreationError = hr;
      device.Reset(); context.Reset();
    }
    if (!device || !adapter || !output) {
      if (!intelOutputFound) throw hresult_error(E_NOINTERFACE, L"No attached Intel DXGI output matches the foreground window monitor");
      throw hresult_error(FAILED(deviceCreationError) ? deviceCreationError : E_FAIL,
          L"An Intel adapter owns the foreground monitor output, but D3D11CreateDevice failed");
    }
    ComPtr<IDXGIDevice1> latencyDevice;
    if (SUCCEEDED(device.As(&latencyDevice))) {
      const HRESULT latencyHr = latencyDevice->SetMaximumFrameLatency(1);
      if (FAILED(latencyHr)) warning("SetMaximumFrameLatency(1) failed (HRESULT " + std::to_string(static_cast<unsigned long>(latencyHr)) + ")");
    }
    ComPtr<IDXGIOutput1> output1;
    if (FAILED(hr = output.As(&output1))) throw hresult_error(hr, L"Query IDXGIOutput1 failed");
    if (FAILED(hr = output1->DuplicateOutput(device.Get(), &duplication)))
      throw hresult_error(hr, L"Create Desktop Duplication for the Intel output failed");
    DXGI_ADAPTER_DESC1 selectedAdapter{};
    DXGI_OUTPUT_DESC selectedOutput{};
    if (FAILED(hr = adapter->GetDesc1(&selectedAdapter))) throw hresult_error(hr, L"Read selected Intel adapter identity failed");
    if (FAILED(hr = output->GetDesc(&selectedOutput))) throw hresult_error(hr, L"Read selected Intel output identity failed");
    std::string outputName;
    for (const wchar_t character : selectedOutput.DeviceName) {
      if (character == L'\0') break;
      outputName.push_back(character >= 0 && character <= 0x7f ? static_cast<char>(character) : '?');
    }
    std::ostringstream outputInfo;
    outputInfo << "INFO Desktop Duplication active adapter=Intel device=0x" << std::hex << selectedAdapter.DeviceId
      << " output=" << outputName
      << " monitor=0x" << std::uppercase << reinterpret_cast<uintptr_t>(selectedOutput.Monitor);
    statusLine(outputInfo.str());

    ComPtr<ID3DBlob> vs, ps, resizePs, errors;
    hr = D3DCompile(kShader, sizeof(kShader)-1, "ArcPowerScreenSharpen", nullptr, nullptr,
        "VS", "vs_4_0", D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &vs, &errors);
    if (FAILED(hr)) throw hresult_error(hr, L"Compile vertex shader failed");
    hr = D3DCompile(kShader, sizeof(kShader)-1, "ArcPowerScreenSharpen", nullptr, nullptr,
        "PS", "ps_4_0", D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &ps, &errors);
    if (FAILED(hr)) throw hresult_error(hr, L"Compile pixel shader failed");
    hr = D3DCompile(kLanczosShader, sizeof(kLanczosShader)-1, "ArcPowerASR", nullptr, nullptr,
        "ResizePS", "ps_4_0", D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &resizePs, &errors);
    if (FAILED(hr)) throw hresult_error(hr, L"Compile Lanczos-3 pixel shader failed");
    if (FAILED(hr = device->CreateVertexShader(vs->GetBufferPointer(), vs->GetBufferSize(), nullptr, &vertexShader)))
      throw hresult_error(hr, L"CreateVertexShader failed");
    if (FAILED(hr = device->CreatePixelShader(ps->GetBufferPointer(), ps->GetBufferSize(), nullptr, &pixelShader)))
      throw hresult_error(hr, L"CreatePixelShader failed");
    if (FAILED(hr = device->CreatePixelShader(resizePs->GetBufferPointer(), resizePs->GetBufferSize(), nullptr, &lanczosPixelShader)))
      throw hresult_error(hr, L"Create Lanczos-3 pixel shader failed");
    D3D11_BUFFER_DESC cb{}; cb.ByteWidth = 32; cb.Usage = D3D11_USAGE_DEFAULT; cb.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
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
    horizontalSrv.Reset(); horizontalRtv.Reset(); horizontalTexture.Reset(); scaledSrv.Reset(); scaledRtv.Reset(); scaledTexture.Reset();
    sampler.Reset(); rasterizer.Reset(); constants.Reset(); lanczosPixelShader.Reset(); pixelShader.Reset(); vertexShader.Reset();
    context.Reset(); device.Reset(); outputBounds = {}; outputRotation = DXGI_MODE_ROTATION_UNSPECIFIED;
    sourceBounds = {}; hasSourceBounds = false;
    sourceRefreshPending = presentationPending = false;
  }

  bool updateSourceGeometry(const RECT& bounds) {
    if (hasSourceBounds && rectEqual(sourceBounds, bounds)) return false;
    sourceBounds = bounds; hasSourceBounds = true;
    sourceRefreshPending = true;
    presentationPending = false;
    cropSrv.Reset(); cropTexture.Reset(); cropFormat = DXGI_FORMAT_UNKNOWN;
    sourceWidth = sourceHeight = 0;
    horizontalSrv.Reset(); horizontalRtv.Reset(); horizontalTexture.Reset();
    scaledSrv.Reset(); scaledRtv.Reset(); scaledTexture.Reset();
    return true;
  }

  bool usesMonitor(HWND target) const {
    if (!output || !target) return false;
    DXGI_OUTPUT_DESC desc{};
    return SUCCEEDED(output->GetDesc(&desc)) && desc.Monitor == MonitorFromWindow(target, MONITOR_DEFAULTTONEAREST) &&
        rectEqual(desc.DesktopCoordinates, outputBounds) && desc.Rotation == outputRotation;
  }

  void createOverlay(const RECT& bounds, HWND target, bool asr) {
    if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) throw hresult_error(E_INVALIDARG, L"Invalid DWM window bounds");
    if (!usesMonitor(target)) throw hresult_error(E_NOINTERFACE, L"Foreground window is not on the duplicated Intel output");
    width = static_cast<UINT>(bounds.right - bounds.left);
    height = static_cast<UINT>(bounds.bottom - bounds.top);
    DWORD exStyle = WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_LAYERED | WS_EX_TOOLWINDOW;
    if (!asr) exStyle |= WS_EX_TRANSPARENT;
    overlay = CreateWindowExW(exStyle,
        kOverlayClass, L"", WS_POPUP, bounds.left, bounds.top, static_cast<int>(width), static_cast<int>(height),
        nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (!overlay) throw hresult_error(HRESULT_FROM_WIN32(GetLastError()), L"Create overlay window failed");
    // The legacy sharpener remains click-through. ASR owns pointer input and
    // forwards mapped ordinary mouse messages to the game without activation.
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

  bool presentOverlay() {
    if (!swapChain) return false;
    const HRESULT hr = swapChain->Present(0, DXGI_PRESENT_DO_NOT_WAIT);
    if (hr == DXGI_ERROR_WAS_STILL_DRAWING) return false;
    if (FAILED(hr)) throw hresult_error(hr, L"Present overlay failed");
    return true;
  }

  void destroyOverlay() noexcept {
    clearMouseForwarding(overlay);
    backBufferRtv.Reset(); cropSrv.Reset(); cropTexture.Reset(); cropFormat = DXGI_FORMAT_UNKNOWN;
    horizontalSrv.Reset(); horizontalRtv.Reset(); horizontalTexture.Reset(); scaledSrv.Reset(); scaledRtv.Reset(); scaledTexture.Reset();
    swapChain.Reset();
    if (overlay) DestroyWindow(overlay);
    overlay = nullptr; overlayVisible = false; width = height = sourceWidth = sourceHeight = 0; viewport = {}; hitRegion = {}; hitRegionApplied = false; asrMode = false;
    sourceRefreshPending = true; presentationPending = false;
  }

  // Keep side bars out of the window shape so desktop/taskbar hit testing passes through there.
  void setOverlayHitRegion(const RECT& region) {
    if (!overlay || (hitRegionApplied && rectEqual(hitRegion, region))) return;
    HRGN shape = CreateRectRgn(region.left, region.top, region.right, region.bottom);
    if (!shape) throw hresult_error(HRESULT_FROM_WIN32(GetLastError()), L"Create ASR overlay input region failed");
    if (!SetWindowRgn(overlay, shape, TRUE)) {
      DeleteObject(shape);
      throw hresult_error(HRESULT_FROM_WIN32(GetLastError()), L"Set ASR overlay input region failed");
    }
    hitRegion = region;
    hitRegionApplied = true;
  }

  bool render(ID3D11Texture2D* source, UINT sourceWidth, UINT sourceHeight, int percent) {
    if (!swapChain || !overlay || !backBufferRtv || !cropSrv) return false;
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
    return presentOverlay();
  }

  bool renderASR(ID3D11Texture2D* source, UINT inputWidth, UINT inputHeight) {
    if (!swapChain || !overlay || !backBufferRtv || !cropSrv || !inputWidth || !inputHeight) return false;
    const UINT targetWidth = static_cast<UINT>(viewport.right - viewport.left);
    const UINT targetHeight = static_cast<UINT>(viewport.bottom - viewport.top);
    if (!targetWidth || !targetHeight) return false;
    HRESULT hr;
    D3D11_TEXTURE2D_DESC textureDesc{};
    if (horizontalTexture) horizontalTexture->GetDesc(&textureDesc);
    D3D11_TEXTURE2D_DESC scaledDesc{};
    if (scaledTexture) scaledTexture->GetDesc(&scaledDesc);
    if (!horizontalTexture || textureDesc.Width != targetWidth || textureDesc.Height != inputHeight ||
        !scaledTexture || scaledDesc.Width != targetWidth || scaledDesc.Height != targetHeight || cropFormat == DXGI_FORMAT_UNKNOWN) {
      horizontalSrv.Reset(); horizontalRtv.Reset(); horizontalTexture.Reset(); scaledSrv.Reset(); scaledRtv.Reset(); scaledTexture.Reset();
      D3D11_TEXTURE2D_DESC desc{}; desc.Width = targetWidth; desc.Height = inputHeight; desc.MipLevels = 1; desc.ArraySize = 1;
      desc.Format = cropFormat; desc.SampleDesc.Count = 1; desc.Usage = D3D11_USAGE_DEFAULT;
      desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
      if (FAILED(hr = device->CreateTexture2D(&desc, nullptr, &horizontalTexture))) throw hresult_error(hr, L"Create Lanczos horizontal texture failed");
      if (FAILED(hr = device->CreateShaderResourceView(horizontalTexture.Get(), nullptr, &horizontalSrv))) throw hresult_error(hr, L"Create Lanczos horizontal SRV failed");
      if (FAILED(hr = device->CreateRenderTargetView(horizontalTexture.Get(), nullptr, &horizontalRtv))) throw hresult_error(hr, L"Create Lanczos horizontal RTV failed");
      desc.Height = targetHeight;
      if (FAILED(hr = device->CreateTexture2D(&desc, nullptr, &scaledTexture))) throw hresult_error(hr, L"Create Lanczos output texture failed");
      if (FAILED(hr = device->CreateShaderResourceView(scaledTexture.Get(), nullptr, &scaledSrv))) throw hresult_error(hr, L"Create Lanczos output SRV failed");
      if (FAILED(hr = device->CreateRenderTargetView(scaledTexture.Get(), nullptr, &scaledRtv))) throw hresult_error(hr, L"Create Lanczos output RTV failed");
    }
    context->RSSetState(rasterizer.Get());
    context->VSSetShader(vertexShader.Get(), nullptr, 0);
    context->PSSetShader(lanczosPixelShader.Get(), nullptr, 0);
    context->PSSetSamplers(0, 1, sampler.GetAddressOf());
    context->IASetInputLayout(nullptr); context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    float params[8]{static_cast<float>(inputWidth), static_cast<float>(inputHeight), static_cast<float>(targetWidth), static_cast<float>(targetHeight), 0,0,0,0};
    ID3D11ShaderResourceView* sourceView = cropSrv.Get();
    ID3D11RenderTargetView* targetView = horizontalRtv.Get();
    D3D11_VIEWPORT passViewport{0,0,static_cast<float>(targetWidth),static_cast<float>(inputHeight),0,1};
    context->RSSetViewports(1, &passViewport); context->OMSetRenderTargets(1, &targetView, nullptr);
    context->PSSetShaderResources(0, 1, &sourceView); params[4] = 0;
    context->UpdateSubresource(constants.Get(), 0, nullptr, params, 0, 0); context->PSSetConstantBuffers(0, 1, constants.GetAddressOf()); context->Draw(3, 0);
    ID3D11ShaderResourceView* nullView = nullptr; context->PSSetShaderResources(0, 1, &nullView);
    sourceView = horizontalSrv.Get(); targetView = scaledRtv.Get(); params[4] = 1;
    passViewport = D3D11_VIEWPORT{0,0,static_cast<float>(targetWidth),static_cast<float>(targetHeight),0,1};
    context->RSSetViewports(1, &passViewport); context->OMSetRenderTargets(1, &targetView, nullptr);
    context->PSSetShaderResources(0, 1, &sourceView);
    context->UpdateSubresource(constants.Get(), 0, nullptr, params, 0, 0); context->Draw(3, 0);
    context->PSSetShaderResources(0, 1, &nullView);

    const float black[4]{0,0,0,1}; context->OMSetRenderTargets(1, backBufferRtv.GetAddressOf(), nullptr);
    context->ClearRenderTargetView(backBufferRtv.Get(), black);
    D3D11_VIEWPORT outputViewport{static_cast<float>(viewport.left), static_cast<float>(viewport.top), static_cast<float>(targetWidth), static_cast<float>(targetHeight),0,1};
    context->RSSetViewports(1, &outputViewport); context->PSSetShader(pixelShader.Get(), nullptr, 0);
    context->PSSetShaderResources(0, 1, scaledSrv.GetAddressOf());
    const float sharpenParams[4]{1.0f / targetWidth, 1.0f / targetHeight, 0, 0};
    context->UpdateSubresource(constants.Get(), 0, nullptr, sharpenParams, 0, 0); context->Draw(3, 0);
    context->PSSetShaderResources(0, 1, &nullView);
    return presentOverlay();
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

RECT clientScreenBounds(HWND target) {
  RECT client{};
  if (!GetClientRect(target, &client)) throw hresult_error(HRESULT_FROM_WIN32(GetLastError()), L"GetClientRect failed");
  POINT topLeft{client.left, client.top}, bottomRight{client.right, client.bottom};
  if (!ClientToScreen(target, &topLeft) || !ClientToScreen(target, &bottomRight))
    throw hresult_error(HRESULT_FROM_WIN32(GetLastError()), L"ClientToScreen failed");
  return RECT{topLeft.x, topLeft.y, bottomRight.x, bottomRight.y};
}

void run(bool readCommandInput = true) {
  Runtime runtime;
  ThumbnailAsrRuntime thumbnailAsr;
  WNDCLASSW wc{}; wc.lpfnWndProc = overlayProc; wc.hInstance = GetModuleHandleW(nullptr); wc.lpszClassName = kOverlayClass;
  if (!RegisterClassW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS)
    throw hresult_error(HRESULT_FROM_WIN32(GetLastError()), L"RegisterClassW failed");
  statusLine("READY screen-sharpen-v1");
  if (readCommandInput) {
    std::thread inputThread(readCommands);
    inputThread.detach();
  }
  Command command{};
  unsigned long long seenRevision = 0;
  HWND activeWindow = nullptr;
  bool activeAnnounced = false;
  bool asrGraphicsReset = false;
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
      if (incoming.revision != seenRevision) { command = incoming; seenRevision = incoming.revision; resetActive(); thumbnailAsr.reset(); asrGraphicsReset = false; }
      if ((!command.asr && command.percent <= 0) || command.pid == 0) { resetActive(); thumbnailAsr.reset(); runtime.resetGraphics(); lastBounds = {}; messageAwareDelay(40); continue; }

      // The DWM thumbnail route must remain ahead of every D3D/DDA setup call.
      // It does not share the legacy overlay's window procedure or mouse state.
      if (command.asr) {
        if (!asrGraphicsReset) { runtime.resetGraphics(); lastBounds = {}; asrGraphicsReset = true; }
        if (thumbnailAsr.tick(command.pid, command.revision, command.expectedCreation)) {
          if (!activeAnnounced) { statusLine("ACTIVE " + std::to_string(command.pid) + " ASR"); activeAnnounced = true; }
          messageAwareDelay(10);
        } else {
          if (activeAnnounced) { statusLine("IDLE"); activeAnnounced = false; }
          messageAwareDelay(20);
        }
        continue;
      }
      asrGraphicsReset = false;

      auto now = std::chrono::steady_clock::now();
      if (now >= nextForegroundCheck) {
        nextForegroundCheck = now + std::chrono::milliseconds(100);
        HWND foreground = matchingForeground(command.pid);
        if (foreground != activeWindow) { resetActive(); activeWindow = foreground; }
      }
      if (!activeWindow) {
        hideOverlay();
        runtime.resetGraphics(); lastBounds = {};
        messageAwareDelay(100); continue;
      }
      try {
        if (!runtime.usesMonitor(activeWindow)) {
          hideOverlay();
          runtime.resetGraphics();
          runtime.initializeDevice(activeWindow);
          statusLine("INFO Desktop Duplication active on Intel Arc output; pointer shape may be composed by Windows separately");
        }
        RECT cropBounds = command.asr ? clientScreenBounds(activeWindow) : visibleBounds(activeWindow);
        RECT clipped{
          (std::max)(cropBounds.left, runtime.outputBounds.left),
          (std::max)(cropBounds.top, runtime.outputBounds.top),
          (std::min)(cropBounds.right, runtime.outputBounds.right),
          (std::min)(cropBounds.bottom, runtime.outputBounds.bottom)
        };
        const LONG outputWidth = runtime.outputBounds.right - runtime.outputBounds.left;
        const LONG outputHeight = runtime.outputBounds.bottom - runtime.outputBounds.top;
        const LONG requestedWidth = cropBounds.right - cropBounds.left;
        const LONG requestedHeight = cropBounds.bottom - cropBounds.top;
        if (command.asr && (requestedWidth <= 0 || requestedHeight <= 0 || requestedWidth >= outputWidth || requestedHeight >= outputHeight ||
            !rectEqual(clipped, cropBounds))) {
          hideOverlay(); lastBounds = {};
          warning("ASR requires a client area smaller than and fully contained within the output; waiting for an eligible windowed game");
          messageAwareDelay(250);
          continue;
        }
        if (clipped.right <= clipped.left || clipped.bottom <= clipped.top) {
          hideOverlay();
          messageAwareDelay(100);
          continue;
        }
        RECT overlayBounds = command.asr ? runtime.outputBounds : clipped;
        runtime.updateSourceGeometry(cropBounds);
        if (!runtime.overlay || !rectEqual(overlayBounds, lastBounds) || runtime.asrMode != command.asr) {
          hideOverlay();
          runtime.createOverlay(overlayBounds, activeWindow, command.asr);
          runtime.asrMode = command.asr;
          lastBounds = overlayBounds;
        }
        if (command.asr) {
          const float scale = (std::min)(static_cast<float>(outputWidth) / requestedWidth, static_cast<float>(outputHeight) / requestedHeight);
          const LONG scaledWidth = (std::max)(1L, static_cast<LONG>(requestedWidth * scale));
          const LONG scaledHeight = (std::max)(1L, static_cast<LONG>(requestedHeight * scale));
          runtime.viewport = RECT{(outputWidth - scaledWidth) / 2, (outputHeight - scaledHeight) / 2,
              (outputWidth - scaledWidth) / 2 + scaledWidth, (outputHeight - scaledHeight) / 2 + scaledHeight};
          runtime.setOverlayHitRegion(runtime.viewport);
          g_mouse.game = activeWindow; g_mouse.viewport = runtime.viewport;
          g_mouse.viewport.left += runtime.outputBounds.left; g_mouse.viewport.right += runtime.outputBounds.left;
          g_mouse.viewport.top += runtime.outputBounds.top; g_mouse.viewport.bottom += runtime.outputBounds.top;
          g_mouse.sourceWidth = static_cast<UINT>(requestedWidth); g_mouse.sourceHeight = static_cast<UINT>(requestedHeight);
        }
        DXGI_OUTDUPL_FRAME_INFO frameInfo{};
        ComPtr<IDXGIResource> resource;
        HRESULT acquireHr = runtime.duplication->AcquireNextFrame(0, &frameInfo, &resource);
        if (acquireHr == DXGI_ERROR_WAIT_TIMEOUT) {
          if (runtime.presentationPending) {
            const bool presented = runtime.presentOverlay();
            runtime.presentationPending = !presented;
            if (presented) {
              runtime.showOverlay();
              if (!activeAnnounced && runtime.overlayVisible) { statusLine("ACTIVE " + std::to_string(command.pid) + (command.asr ? " ASR" : "")); activeAnnounced = true; }
            }
          }
          waitForMessages(2); continue;
        }
        if (acquireHr == DXGI_ERROR_ACCESS_LOST) {
          warning("Desktop Duplication access was lost; releasing output and retrying shortly");
          hideOverlay(); runtime.resetGraphics(); lastBounds = {};
          messageAwareDelay(500);
          continue;
        }
        if (FAILED(acquireHr)) throw hresult_error(acquireHr, L"AcquireNextFrame failed");
        struct FrameRelease {
          IDXGIOutputDuplication* duplication;
          void release() { if (duplication) { duplication->ReleaseFrame(); duplication = nullptr; } }
          ~FrameRelease() { release(); }
        } frameRelease{runtime.duplication.Get()};
        if (frameInfo.LastPresentTime.QuadPart == 0 && !runtime.sourceRefreshPending) {
          if (runtime.presentationPending) {
            const bool presented = runtime.presentOverlay();
            runtime.presentationPending = !presented;
            if (presented) {
              runtime.showOverlay();
              if (!activeAnnounced && runtime.overlayVisible) { statusLine("ACTIVE " + std::to_string(command.pid) + (command.asr ? " ASR" : "")); activeAnnounced = true; }
            }
          }
          continue;
        }
        bool processingFailed = false;
        bool presented = false;
        try {
          ComPtr<ID3D11Texture2D> desktop;
          HRESULT hr = resource.As(&desktop);
          if (FAILED(hr)) throw hresult_error(hr, L"Query duplicated desktop texture failed");
          D3D11_TEXTURE2D_DESC desktopDesc{}; desktop->GetDesc(&desktopDesc);
          if (outputWidth <= 0 || outputHeight <= 0 || desktopDesc.Width != static_cast<UINT>(outputWidth) || desktopDesc.Height != static_cast<UINT>(outputHeight))
            throw hresult_error(E_INVALIDARG, L"Rotated or mismatched output dimensions are not supported; refusing to render a misaligned crop");
          const UINT left = static_cast<UINT>(clipped.left - runtime.outputBounds.left);
          const UINT top = static_cast<UINT>(clipped.top - runtime.outputBounds.top);
          const UINT cropWidth = static_cast<UINT>(clipped.right - clipped.left);
          const UINT cropHeight = static_cast<UINT>(clipped.bottom - clipped.top);
          if (!runtime.cropTexture || runtime.sourceWidth != cropWidth || runtime.sourceHeight != cropHeight || runtime.cropFormat != desktopDesc.Format) {
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
            runtime.sourceWidth = cropWidth; runtime.sourceHeight = cropHeight;
          }
          D3D11_BOX box{left, top, 0, left + cropWidth, top + cropHeight, 1};
          runtime.context->CopySubresourceRegion(runtime.cropTexture.Get(), 0, 0, 0, 0, desktop.Get(), 0, &box);
          runtime.sourceRefreshPending = false;
          if (command.asr) presented = runtime.renderASR(runtime.cropTexture.Get(), cropWidth, cropHeight);
          else presented = runtime.render(runtime.cropTexture.Get(), cropWidth, cropHeight, command.percent);
          runtime.presentationPending = !presented;
          if (presented) runtime.showOverlay();
          if (presented && !activeAnnounced && runtime.overlayVisible) { statusLine("ACTIVE " + std::to_string(command.pid) + (command.asr ? " ASR" : "")); activeAnnounced = true; }
        } catch (const hresult_error& e) {
          warning("desktop frame processing failed (HRESULT " + std::to_string(static_cast<unsigned long>(e.code().value)) + "): " + to_string(e.message()));
          hideOverlay(); lastBounds = {};
          processingFailed = true;
        }
        frameRelease.release();
        if (processingFailed) messageAwareDelay(500);
      } catch (const hresult_error& e) {
        warning("Desktop Duplication setup failed (HRESULT " + std::to_string(static_cast<unsigned long>(e.code().value)) + "): " + to_string(e.message()));
        hideOverlay(); runtime.resetGraphics(); lastBounds = {};
        messageAwareDelay(500);
      }
    }
  } catch (...) {
    resetActive();
    throw;
  }
  resetActive();
  g_mouseDispatcher.stop();
}

} // namespace

int wmain(int argc, wchar_t** argv) {
  try {
    if (argc == 2 && std::wstring_view(argv[1]) == L"--help") {
      std::wcout << L"ArcPower.ScreenSharpen: stdin commands SET <pid> <0-100>, ASR 0, ASR <pid> <creation-filetime>, or STOP; ASR uses guarded DWM thumbnail composition.\n";
      return 0;
    }
    if (argc == 2 && std::wstring_view(argv[1]) == L"--probe-command-parser") return nativeCommandParserProbe() ? 0 : 1;
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
