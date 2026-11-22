#pragma once

#include <d3d11.h>
#include <memory>
#include <sstream>
#include <string>
#include <utility>
#include <windows.graphics.capture.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <wrl/client.h>

using Microsoft::WRL::ComPtr;

// Captures one selected HWND through Windows.Graphics.Capture. This keeps the
// capture window-scoped (rather than duplicating the whole desktop) and makes
// the frame texture available to Arc Power's scaler/sharpening render pass.
class WindowCapture {
  struct SignalEvent {
    HANDLE handle{};
    ~SignalEvent() { if (handle) CloseHandle(handle); }
  };

  winrt::Windows::Graphics::Capture::GraphicsCaptureItem item_{nullptr};
  winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice captureDevice_{nullptr};
  winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool framePool_{nullptr};
  winrt::Windows::Graphics::Capture::GraphicsCaptureSession session_{nullptr};
  winrt::event_token frameArrived_{};
  SIZE lastSize_{};
  bool started_{};

 public:
  struct Frame {
    // Keep the WGC frame checked out for as long as the caller may consume its
    // surface. The texture's COM reference alone does not release the frame-pool
    // slot or guarantee the frame's documented lifetime.
    winrt::Windows::Graphics::Capture::Direct3D11CaptureFrame captureFrame{nullptr};
    ComPtr<ID3D11Texture2D> texture;
    UINT width{};
    UINT height{};
    long long timestamp100ns{};

    Frame() = default;
    Frame(const Frame&) = delete;
    Frame& operator=(const Frame&) = delete;
    Frame(Frame&& other) noexcept { *this = std::move(other); }
    Frame& operator=(Frame&& other) noexcept {
      if (this != &other) {
        close();
        captureFrame = std::move(other.captureFrame);
        texture = std::move(other.texture);
        width = std::exchange(other.width, 0);
        height = std::exchange(other.height, 0);
        timestamp100ns = std::exchange(other.timestamp100ns, 0);
      }
      return *this;
    }
    void close() noexcept {
      texture.Reset();
      try { if (captureFrame) captureFrame.Close(); } catch (...) {}
      captureFrame = nullptr;
      width = height = 0;
      timestamp100ns = 0;
    }
    ~Frame() { close(); }
  };

  WindowCapture() = default;
  WindowCapture(const WindowCapture&) = delete;
  WindowCapture& operator=(const WindowCapture&) = delete;
  ~WindowCapture() { stop(); }

  // Optional on older Windows versions. Failure keeps capture available with
  // the OS default; report actual setter/getter results rather than claiming
  // that the requested cadence was applied.
  static bool configureMinUpdateInterval(IUnknown* session, void (*log)(const std::string&)) {
    using Session5 = ABI::Windows::Graphics::Capture::IGraphicsCaptureSession5;
    ComPtr<Session5> session5;
    const HRESULT queryHr = session ? session->QueryInterface(IID_PPV_ARGS(&session5)) : E_POINTER;
    bool applied = false;
    std::ostringstream info;
    info << "INFO CAPTURE_INTERVAL requested100ns=0 queryHRESULT=0x" << std::hex
         << static_cast<unsigned long>(queryHr);
    if (SUCCEEDED(queryHr) && session5) {
      const ABI::Windows::Foundation::TimeSpan desired{};
      const HRESULT setHr = session5->put_MinUpdateInterval(desired);
      ABI::Windows::Foundation::TimeSpan readback{};
      const HRESULT getHr = session5->get_MinUpdateInterval(&readback);
      info << " setHRESULT=0x" << static_cast<unsigned long>(setHr)
           << " getHRESULT=0x" << static_cast<unsigned long>(getHr);
      if (SUCCEEDED(getHr)) info << " readback100ns=" << std::dec << readback.Duration;
      applied = SUCCEEDED(setHr) && SUCCEEDED(getHr) && readback.Duration == 0;
    }
    info << " settingValidated=" << (applied ? "true" : "false");
    if (log) log(info.str());
    return applied;
  }

  bool start(HWND target, ID3D11Device* device, HANDLE frameEvent, void (*log)(const std::string&) = nullptr) {
    stop();
    if (!target || !IsWindow(target) || !device || !frameEvent) return false;
    if (!winrt::Windows::Graphics::Capture::GraphicsCaptureSession::IsSupported()) return false;

    Microsoft::WRL::ComPtr<IDXGIDevice> dxgiDevice;
    winrt::check_hresult(device->QueryInterface(IID_PPV_ARGS(&dxgiDevice)));
    winrt::check_hresult(CreateDirect3D11DeviceFromDXGIDevice(
        dxgiDevice.Get(), reinterpret_cast<::IInspectable**>(winrt::put_abi(captureDevice_))));

    auto factory = winrt::get_activation_factory<winrt::Windows::Graphics::Capture::GraphicsCaptureItem>();
    auto interop = factory.as<IGraphicsCaptureItemInterop>();
    winrt::check_hresult(interop->CreateForWindow(target,
        winrt::guid_of<winrt::Windows::Graphics::Capture::GraphicsCaptureItem>(),
        winrt::put_abi(item_)));

    const auto size = item_.Size();
    if (size.Width <= 0 || size.Height <= 0) { stop(); return false; }
    lastSize_ = SIZE{size.Width, size.Height};
    auto signal = std::make_shared<SignalEvent>();
    if (!DuplicateHandle(GetCurrentProcess(), frameEvent, GetCurrentProcess(), &signal->handle,
            0, FALSE, DUPLICATE_SAME_ACCESS)) {
      winrt::check_hresult(HRESULT_FROM_WIN32(GetLastError()));
    }
    framePool_ = winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool::CreateFreeThreaded(
        captureDevice_, winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized,
        2, size);
    frameArrived_ = framePool_.FrameArrived([signal](const auto&, const auto&) {
      if (signal->handle) SetEvent(signal->handle);
    });
    session_ = framePool_.CreateCaptureSession(item_);
    session_.IsCursorCaptureEnabled(false);
    configureMinUpdateInterval(reinterpret_cast<IUnknown*>(winrt::get_abi(session_)), log);
    session_.StartCapture();
    started_ = true;
    return true;
  }

  Frame nextFrame(ID3D11Device* device) {
    Frame latest;
    if (!started_ || !device) return latest;
    // The pool has capacity two. Bound each drain so a continuously arriving
    // stream cannot keep this worker from returning to message processing.
    constexpr UINT kMaxFramesPerDrain = 2;
    for (UINT drained = 0; drained < kMaxFramesPerDrain; ++drained) {
      Frame candidate;
      candidate.captureFrame = framePool_.TryGetNextFrame();
      auto& frame = candidate.captureFrame;
      if (!frame) break;
      const auto contentSize = frame.ContentSize();
      if (contentSize.Width <= 0 || contentSize.Height <= 0) continue;
      const SIZE current{contentSize.Width, contentSize.Height};
      if (current.cx != lastSize_.cx || current.cy != lastSize_.cy) {
        lastSize_ = current;
        latest.close();
        candidate.close();
        framePool_.Recreate(captureDevice_, winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2, winrt::Windows::Graphics::SizeInt32{current.cx, current.cy});
        break;
      }
      auto surface = frame.Surface();
      auto access = surface.as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
      ComPtr<ID3D11Texture2D> texture;
      winrt::check_hresult(access->GetInterface(IID_PPV_ARGS(&texture)));
      D3D11_TEXTURE2D_DESC desc{};
      texture->GetDesc(&desc);
      if (desc.Width < static_cast<UINT>(contentSize.Width) || desc.Height < static_cast<UINT>(contentSize.Height)
          || desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM) continue;
      candidate.texture = std::move(texture);
      candidate.width = static_cast<UINT>(contentSize.Width);
      candidate.height = static_cast<UINT>(contentSize.Height);
      candidate.timestamp100ns = frame.SystemRelativeTime().count();
      latest = std::move(candidate);
    }
    return latest;
  }

  bool active() const noexcept { return started_; }

  void stop() noexcept {
    started_ = false;
    try {
      if (framePool_ && frameArrived_.value) framePool_.FrameArrived(frameArrived_);
    } catch (...) {}
    frameArrived_ = {};
    try { if (session_) session_.Close(); } catch (...) {}
    try { if (framePool_) framePool_.Close(); } catch (...) {}
    session_ = nullptr;
    framePool_ = nullptr;
    item_ = nullptr;
    captureDevice_ = nullptr;
    lastSize_ = {};
  }
};
