#define wmain ArcPowerScreenSharpenProgramMain
#include "../src/main/sharpening-runtime/ArcPower.ScreenSharpen.cpp"
#undef wmain

#include <atomic>
#include <condition_variable>
#include <functional>
#include <iostream>
#include <mutex>

namespace {
constexpr wchar_t kProbeClass[] = L"ArcPowerNativeScreenRuntimeV2Probe";
struct ForwardedInput { UINT message{}; WPARAM keys{}; LPARAM point{}; };
std::mutex g_targetMutex;
std::condition_variable g_targetReady;
std::vector<ForwardedInput> g_targetInputs;
std::atomic<bool> g_slowNextDown{false};
std::atomic<bool> g_slowHandlerEntered{false};
std::atomic<bool> g_releaseSlowHandler{false};
std::atomic<DWORD> g_targetThreadId{};
std::atomic<bool> g_runtimeDone{false};
std::exception_ptr g_runtimeFailure;
HWND g_targetWindow{};
HWND g_previousForeground{};
bool g_targetReadyFlag{};

LRESULT CALLBACK targetProc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
  if (message == WM_LBUTTONDOWN && g_slowNextDown.exchange(false)) {
    g_slowHandlerEntered.store(true);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (!g_releaseSlowHandler.load() && std::chrono::steady_clock::now() < deadline)
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  if (message == WM_MOUSEMOVE || message == WM_LBUTTONDOWN || message == WM_LBUTTONUP) {
    std::lock_guard<std::mutex> lock(g_targetMutex);
    g_targetInputs.push_back({message, wparam, lparam});
    g_targetReady.notify_all();
  }
  if (message == WM_CLOSE) { DestroyWindow(hwnd); return 0; }
  if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
  return DefWindowProcW(hwnd, message, wparam, lparam);
}

void targetWindowThread() {
  g_targetThreadId.store(GetCurrentThreadId());
  WNDCLASSW wc{};
  wc.lpfnWndProc = targetProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = kProbeClass;
  RegisterClassW(&wc);
  g_targetWindow = CreateWindowExW(0, kProbeClass, L"Arc Power native ASR runtime probe",
      WS_OVERLAPPEDWINDOW, 100, 100, 640, 480, nullptr, nullptr, wc.hInstance, nullptr);
  if (g_targetWindow) {
    g_previousForeground = GetForegroundWindow();
    ShowWindow(g_targetWindow, SW_SHOW);
    UpdateWindow(g_targetWindow);
    HWND foreground = GetForegroundWindow();
    DWORD foregroundThread = foreground ? GetWindowThreadProcessId(foreground, nullptr) : 0;
    const DWORD ownThread = GetCurrentThreadId();
    const bool attached = foregroundThread && foregroundThread != ownThread && AttachThreadInput(ownThread, foregroundThread, TRUE);
    SetForegroundWindow(g_targetWindow);
    SetActiveWindow(g_targetWindow);
    SetFocus(g_targetWindow);
    if (attached) AttachThreadInput(ownThread, foregroundThread, FALSE);
  }
  {
    std::lock_guard<std::mutex> lock(g_targetMutex);
    g_targetReadyFlag = true;
    g_targetReady.notify_all();
  }
  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
}

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

void restorePreviousForeground() {
  if (!g_previousForeground || !IsWindow(g_previousForeground)) return;
  HWND foreground = GetForegroundWindow();
  const DWORD foregroundThread = foreground ? GetWindowThreadProcessId(foreground, nullptr) : 0;
  const DWORD ownThread = GetCurrentThreadId();
  const bool attached = foregroundThread && foregroundThread != ownThread && AttachThreadInput(ownThread, foregroundThread, TRUE);
  SetForegroundWindow(g_previousForeground);
  SetActiveWindow(g_previousForeground);
  SetFocus(g_previousForeground);
  if (attached) AttachThreadInput(ownThread, foregroundThread, FALSE);
}

bool waitUntil(const std::function<bool()>& predicate, DWORD timeoutMs) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
  while (std::chrono::steady_clock::now() < deadline) {
    if (predicate()) return true;
    if (g_runtimeDone.load()) return predicate();
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  return predicate();
}

RECT overlayInputBounds(HWND overlay) {
  HRGN region = CreateRectRgn(0, 0, 0, 0);
  require(region != nullptr, "CreateRectRgn failed for ASR input-region query");
  const int regionKind = GetWindowRgn(overlay, region);
  RECT bounds{};
  const bool valid = regionKind != ERROR && GetRgnBox(region, &bounds) != NULLREGION;
  DeleteObject(region);
  require(valid, "production ASR overlay has no active viewport input region");
  return bounds;
}

POINT viewportCenter(HWND overlay) {
  const RECT bounds = overlayInputBounds(overlay);
  return POINT{bounds.left + (bounds.right - bounds.left) / 2, bounds.top + (bounds.bottom - bounds.top) / 2};
}

void assertCenterMapping(HWND overlay, WPARAM marker, const char* step) {
  RECT client{};
  require(GetClientRect(g_targetWindow, &client) != FALSE, "GetClientRect failed for target mapping assertion");
  const LONG expectedX = (client.right - client.left) / 2;
  const LONG expectedY = (client.bottom - client.top) / 2;
  ForwardedInput latest{};
  bool mappedCorrectly = false;
  for (int attempt = 0; attempt < 50; ++attempt) {
    size_t previousCount{};
    { std::lock_guard<std::mutex> lock(g_targetMutex); previousCount = g_targetInputs.size(); }
    const POINT center = viewportCenter(overlay);
    SendMessageW(overlay, WM_MOUSEMOVE, marker, MAKELPARAM(center.x, center.y));
    std::unique_lock<std::mutex> lock(g_targetMutex);
    g_targetReady.wait_for(lock, std::chrono::milliseconds(100), [&] {
      return std::any_of(g_targetInputs.begin() + (std::min)(previousCount, g_targetInputs.size()), g_targetInputs.end(),
          [&](const ForwardedInput& input) { return input.message == WM_MOUSEMOVE && input.keys == marker; });
    });
    auto found = std::find_if(g_targetInputs.rbegin(), g_targetInputs.rend(), [&](const ForwardedInput& input) {
      return input.message == WM_MOUSEMOVE && input.keys == marker;
    });
    if (found != g_targetInputs.rend()) {
      latest = *found;
      mappedCorrectly = std::abs(GET_X_LPARAM(latest.point) - expectedX) <= 2 &&
          std::abs(GET_Y_LPARAM(latest.point) - expectedY) <= 2;
    }
    lock.unlock();
    if (mappedCorrectly) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(25));
  }
  if (!mappedCorrectly) {
    std::cerr << "FAIL " << step << " mapped=" << GET_X_LPARAM(latest.point) << ',' << GET_Y_LPARAM(latest.point)
        << " expected=" << expectedX << ',' << expectedY << "\n";
    throw std::runtime_error("production overlay center input did not map to current client center");
  }
  const LONG mappedX = GET_X_LPARAM(latest.point);
  const LONG mappedY = GET_Y_LPARAM(latest.point);
  std::cout << "PASS " << step << " center mapped to " << mappedX << ',' << mappedY << " of "
      << (client.right - client.left) << 'x' << (client.bottom - client.top) << " client\n";
}

void testProductionLoop() {
  RECT monitorBounds{};
  MONITORINFO monitor{sizeof(monitor)};
  HMONITOR monitorHandle = MonitorFromWindow(g_targetWindow, MONITOR_DEFAULTTONEAREST);
  require(GetMonitorInfoW(monitorHandle, &monitor) != FALSE, "GetMonitorInfoW failed");
  monitorBounds = monitor.rcMonitor;
  const int outputWidth = monitorBounds.right - monitorBounds.left;
  const int outputHeight = monitorBounds.bottom - monitorBounds.top;
  require(outputWidth > 0 && outputHeight > 0, "current monitor has invalid read-only bounds");

  RECT initialOuter{monitorBounds.left + outputWidth / 10, monitorBounds.top + outputHeight / 10,
      monitorBounds.left + outputWidth * 6 / 10, monitorBounds.top + outputHeight * 6 / 10};
  require(SetWindowPos(g_targetWindow, HWND_TOP, initialOuter.left, initialOuter.top,
      initialOuter.right - initialOuter.left, initialOuter.bottom - initialOuter.top, SWP_SHOWWINDOW | SWP_NOACTIVATE) != FALSE,
      "could not place owned source window within its current monitor");
  SetForegroundWindow(g_targetWindow);
  require(waitUntil([] { return GetForegroundWindow() == g_targetWindow; }, 1500), "owned source HWND could not become foreground");
  const RECT initialClient = clientScreenBounds(g_targetWindow);

  {
    std::lock_guard<std::mutex> lock(g_commandMutex);
    g_stop.store(false);
    g_command.pid = GetCurrentProcessId();
    g_command.percent = 0;
    g_command.asr = true;
    ++g_command.revision;
  }
  std::thread runtimeThread([] {
    try { run(false); }
    catch (...) { g_runtimeFailure = std::current_exception(); }
    g_runtimeDone.store(true);
  });
  auto stopRuntime = [&] {
    g_stop.store(true);
    if (runtimeThread.joinable()) runtimeThread.join();
  };
  try {
    require(waitUntil([] {
      HWND overlay = FindWindowW(kOverlayClass, nullptr);
      return overlay && IsWindowVisible(overlay) && GetForegroundWindow() == g_targetWindow;
    }, 15000), "production ASR loop did not present a visible overlay on the foreground target");
    HWND overlay = FindWindowW(kOverlayClass, nullptr);
    require(overlay != nullptr, "production ASR overlay HWND could not be found");
    RECT overlayRect{};
    require(GetWindowRect(overlay, &overlayRect) != FALSE, "could not query production overlay bounds");
    require(overlayRect.left == monitorBounds.left && overlayRect.top == monitorBounds.top &&
        overlayRect.right == monitorBounds.right && overlayRect.bottom == monitorBounds.bottom,
        "production overlay did not cover the current output bounds");
    assertCenterMapping(overlay, 0x151, "initial foreground mapping");

    // Change only this HWND's size and position. Do not reactivate another window or alter display modes.
    RECT resizedOuter{monitorBounds.left + outputWidth / 8, monitorBounds.top + outputHeight / 8,
        monitorBounds.left + outputWidth * 7 / 8, monitorBounds.top + outputHeight * 5 / 8};
    require(SetWindowPos(g_targetWindow, HWND_TOP, resizedOuter.left, resizedOuter.top,
        resizedOuter.right - resizedOuter.left, resizedOuter.bottom - resizedOuter.top, SWP_SHOWWINDOW | SWP_NOACTIVATE) != FALSE,
        "same-HWND resize/reposition failed");
    require(waitUntil([&] { return rectEqual(clientScreenBounds(g_targetWindow), initialClient) == false; }, 1000),
        "same-HWND resize/reposition did not alter client screen bounds");
    require(GetForegroundWindow() == g_targetWindow, "source HWND lost foreground during resize/reposition");
    require(waitUntil([&] {
      HWND current = FindWindowW(kOverlayClass, nullptr);
      return current == overlay && IsWindowVisible(current);
    }, 5000), "production overlay was destroyed or hidden while the same HWND remained foreground");
    assertCenterMapping(overlay, 0x152, "same-HWND resize/reposition mapping");

    // Reposition at the same client size and verify the loop keeps capturing the new location without an Alt+Tab.
    RECT resizedClient{};
    require(GetClientRect(g_targetWindow, &resizedClient) != FALSE, "GetClientRect failed after resize");
    const LONG outerWidth = resizedOuter.right - resizedOuter.left;
    const LONG outerHeight = resizedOuter.bottom - resizedOuter.top;
    RECT repositionedOuter{monitorBounds.left + outputWidth / 7, monitorBounds.top + outputHeight / 6,
        monitorBounds.left + outputWidth / 7 + outerWidth, monitorBounds.top + outputHeight / 6 + outerHeight};
    require(SetWindowPos(g_targetWindow, HWND_TOP, repositionedOuter.left, repositionedOuter.top,
        outerWidth, outerHeight, SWP_SHOWWINDOW | SWP_NOACTIVATE) != FALSE, "same-size HWND reposition failed");
    require(waitUntil([&] { return GetForegroundWindow() == g_targetWindow; }, 1000), "source HWND lost foreground during reposition");
    assertCenterMapping(overlay, 0x153, "same-HWND reposition mapping");

    // A slow target handler must not block the production overlay thread; capture loss must still deliver release.
    g_slowNextDown.store(true);
    g_slowHandlerEntered.store(false);
    g_releaseSlowHandler.store(false);
    POINT center = viewportCenter(overlay);
    const auto downStart = std::chrono::steady_clock::now();
    SendMessageW(overlay, WM_LBUTTONDOWN, 0, MAKELPARAM(center.x, center.y));
    const auto enqueueTime = std::chrono::steady_clock::now() - downStart;
    require(enqueueTime < std::chrono::milliseconds(35),
        "production overlay caller blocked behind target button handler");
    require(waitUntil([] { return g_slowHandlerEntered.load(); }, 1500), "slow target mouse handler was not invoked");
    DWORD_PTR ignored{};
    const auto tickStart = std::chrono::steady_clock::now();
    const BOOL overlayResponsive = SendMessageTimeoutW(overlay, WM_NULL, 0, 0,
        SMTO_ABORTIFHUNG | SMTO_BLOCK, 30, &ignored);
    const auto tickTime = std::chrono::steady_clock::now() - tickStart;
    require(overlayResponsive && tickTime < std::chrono::milliseconds(30),
        "production overlay/render thread stopped processing messages during the slow target handler");
    SendMessageW(overlay, WM_CAPTURECHANGED, 0, 0);
    g_releaseSlowHandler.store(true);
    require(waitUntil([] {
      std::lock_guard<std::mutex> lock(g_targetMutex);
      return std::any_of(g_targetInputs.begin(), g_targetInputs.end(), [](const ForwardedInput& input) { return input.message == WM_LBUTTONUP; });
    }, 3000), "held forwarded left button was not released after capture loss");
    require(GetForegroundWindow() == g_targetWindow, "target foreground changed during slow-handler recovery");
    std::cout << "PASS slow target callback enqueue="
        << std::chrono::duration_cast<std::chrono::microseconds>(enqueueTime).count() << "us, overlay tick="
        << std::chrono::duration_cast<std::chrono::microseconds>(tickTime).count()
        << "us; capture loss delivered button-up\n";

    require(rectEqual(monitorBounds, monitor.rcMonitor), "monitor bounds changed during probe (expected no display-mode changes)");
    std::cout << "PASS foreground HWND stayed constant; output bounds remained " << outputWidth << 'x' << outputHeight << "\n";
  } catch (...) {
    stopRuntime();
    throw;
  }
  stopRuntime();
  if (g_runtimeFailure) std::rethrow_exception(g_runtimeFailure);
  restorePreviousForeground();
}
}

int wmain() {
  std::thread targetThread;
  try {
    require(SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) != FALSE,
        "could not set per-monitor DPI awareness for probe");
    targetThread = std::thread(targetWindowThread);
    {
      std::unique_lock<std::mutex> lock(g_targetMutex);
      require(g_targetReady.wait_for(lock, std::chrono::seconds(3), [] { return g_targetReadyFlag; }), "target HWND thread startup timed out");
    }
    require(g_targetWindow != nullptr, "target HWND creation failed");
    testProductionLoop();
    PostThreadMessageW(g_targetThreadId.load(), WM_QUIT, 0, 0);
    targetThread.join();
    std::cout << "RESULT PASS native-screen-runtime-v2\n";
    return 0;
  } catch (const std::exception& e) {
    g_releaseSlowHandler.store(true);
    restorePreviousForeground();
    if (g_targetThreadId.load()) PostThreadMessageW(g_targetThreadId.load(), WM_QUIT, 0, 0);
    if (targetThread.joinable()) targetThread.join();
    std::cerr << "RESULT FAIL native-screen-runtime-v2: " << e.what() << "\n";
    return 1;
  } catch (...) {
    g_releaseSlowHandler.store(true);
    restorePreviousForeground();
    if (g_targetThreadId.load()) PostThreadMessageW(g_targetThreadId.load(), WM_QUIT, 0, 0);
    if (targetThread.joinable()) targetThread.join();
    std::cerr << "RESULT FAIL native-screen-runtime-v2: unknown failure\n";
    return 1;
  }
}
