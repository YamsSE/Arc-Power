#include <windows.h>
#include <windowsx.h>
#include <d3d11.h>
#include <dxgi1_3.h>
#include <dcomp.h>
#include <dwmapi.h>
#include <d3dcompiler.h>
#include <winrt/base.h>
#include "ArcPower.WindowCapture.h"
#include <wrl/client.h>
#include <atomic>
#include <algorithm>
#include <bit>
#include <climits>
#include <chrono>
#include <cstdio>
#include <iterator>
#include <iostream>
#include <mutex>
#include <condition_variable>
#include <deque>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <utility>
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

struct Command { DWORD pid{}; int percent{}; bool asr{}; bool scale{}; unsigned long long revision{}; unsigned long long expectedCreation{}; };
std::mutex g_commandMutex;
Command g_command;
std::atomic<bool> g_stop{false};
std::mutex g_outputMutex;
void warning(const std::string& text);
#include "ArcPower.ThumbnailAsr.h"

struct MouseForwardState {
  HWND game{};
  HWND inputTarget{};
  RECT viewport{};
  UINT sourceWidth{};
  UINT sourceHeight{};
  unsigned buttons{};
  DWORD gamePid{};
};
MouseForwardState g_mouse;
enum MouseButton : unsigned { kLeft = 1, kRight = 2, kMiddle = 4, kX1 = 8, kX2 = 16 };

struct MouseEvent {
  HWND target{}; UINT message{}; WPARAM wparam{}; LPARAM lparam{}; bool releaseAll{};
  HWND gameRoot{}; DWORD processId{};
};
struct HeldButtonsState { HWND gameRoot{}; DWORD processId{}; unsigned buttons{}; LPARAM lastClientPoint{}; };
constexpr size_t kMaxQueuedMouseMoves = 8;

void enqueueBoundedMouseMove(std::deque<MouseEvent>& events, MouseEvent event, size_t maxMoves,
    size_t& droppedMoves, size_t& coalescedMoves) {
  if (event.message == WM_MOUSEMOVE && !event.releaseAll) {
    if (!events.empty()) {
      auto& last = events.back();
      if (last.message == WM_MOUSEMOVE && !last.releaseAll && last.target == event.target && last.wparam == event.wparam) {
        last = event;
        ++coalescedMoves;
        return;
      }
    }
    maxMoves = (std::max)(size_t{1}, maxMoves);
    const size_t pendingMoves = static_cast<size_t>(std::count_if(events.begin(), events.end(), [](const MouseEvent& queued) {
      return queued.message == WM_MOUSEMOVE && !queued.releaseAll;
    }));
    if (pendingMoves >= maxMoves) {
      const auto oldestMove = std::find_if(events.begin(), events.end(), [](const MouseEvent& queued) {
        return queued.message == WM_MOUSEMOVE && !queued.releaseAll;
      });
      if (oldestMove != events.end()) { events.erase(oldestMove); ++droppedMoves; }
    }
  }
  events.push_back(event);
}

void eraseQueuedGameEvents(std::deque<MouseEvent>& events, HWND gameRoot, DWORD processId) {
  events.erase(std::remove_if(events.begin(), events.end(), [&](const MouseEvent& event) {
    return !event.releaseAll && event.gameRoot == gameRoot && event.processId == processId;
  }), events.end());
}

std::vector<HWND> heldTargetsForGame(const std::unordered_map<HWND, HeldButtonsState>& held,
    HWND gameRoot, DWORD processId) {
  std::vector<HWND> targets;
  for (const auto& [target, state] : held)
    if (state.buttons && state.gameRoot == gameRoot && state.processId == processId) targets.push_back(target);
  return targets;
}

LPARAM heldClientPointForTarget(const std::unordered_map<HWND, HeldButtonsState>& held, HWND target,
    HWND gameRoot, DWORD processId) {
  const auto found = held.find(target);
  if (found == held.end() || found->second.gameRoot != gameRoot || found->second.processId != processId) return 0;
  return found->second.lastClientPoint;
}

bool windowIdentityMatches(bool isWindow, DWORD actualPid, HWND actualRoot, HWND expectedRoot, DWORD expectedPid) {
  return isWindow && expectedRoot && expectedPid && actualRoot == expectedRoot && actualPid == expectedPid;
}

bool windowBelongsToGame(HWND target, HWND gameRoot, DWORD processId) {
  if (!target || !gameRoot || !processId || !IsWindow(target)) return false;
  DWORD actualPid{}; GetWindowThreadProcessId(target, &actualPid);
  HWND actualRoot = GetAncestor(target, GA_ROOT);
  return windowIdentityMatches(true, actualPid, actualRoot, gameRoot, processId);
}

using SteadyTime = std::chrono::steady_clock::time_point;
SteadyTime selectCleanupDeadline(SteadyTime normalDeadline, bool shutdownStarted, SteadyTime sharedShutdownDeadline) {
  return shutdownStarted ? sharedShutdownDeadline : normalDeadline;
}

bool releaseAlreadyScheduled(const std::deque<MouseEvent>& events, bool activeRelease,
    HWND activeRoot, DWORD activePid, HWND requestedRoot, DWORD requestedPid) {
  if (activeRelease && activeRoot == requestedRoot && activePid == requestedPid) return true;
  return std::any_of(events.begin(), events.end(), [&](const MouseEvent& event) {
    return event.releaseAll && event.gameRoot == requestedRoot && event.processId == requestedPid;
  });
}

void forgetGameWithoutHeldButtons(std::vector<std::pair<HWND, DWORD>>& games,
    const std::unordered_map<HWND, HeldButtonsState>& held, HWND gameRoot, DWORD processId) {
  const bool stillHeld = std::any_of(held.begin(), held.end(), [&](const auto& entry) {
    return entry.second.buttons && entry.second.gameRoot == gameRoot && entry.second.processId == processId;
  });
  if (stillHeld) return;
  games.erase(std::remove(games.begin(), games.end(), std::make_pair(gameRoot, processId)), games.end());
}

class MouseDispatcher {
 public:
  MouseDispatcher() : worker_([this] { dispatch(); }) {}
  ~MouseDispatcher() { stop(); }
  void enqueue(MouseEvent event) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (stopping_) return;
    pruneInvalidHeldTargetsLocked();
    if (!windowBelongsToGame(event.target, event.gameRoot, event.processId)) {
      if (!invalidIdentityWarned_) {
        invalidIdentityWarned_ = true;
        warning("rejected forwarded mouse event without a valid bound game HWND/PID identity");
      }
      return;
    }
    rememberGameLocked(event.gameRoot, event.processId);
    size_t dropped{};
    enqueueBoundedMouseMove(events_, event, kMaxQueuedMouseMoves, dropped, coalescedMoves_);
    if (dropped) {
      droppedMoves_ += dropped;
      if (!moveOverflowReported_) {
        moveOverflowReported_ = true;
        warning("mouse forwarding queue discarded stale WM_MOUSEMOVE samples to preserve responsiveness");
      }
    }
    ready_.notify_one();
  }
  void clearAndRelease(HWND gameRoot, DWORD processId) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!stopping_ && windowBelongsToGame(gameRoot, gameRoot, processId)) {
      rememberGameLocked(gameRoot, processId);
      eraseQueuedGameEvents(events_, gameRoot, processId);
      // The single dispatcher can currently be inside a synchronous send.
      // This root sentinel runs after it returns and then reads the updated
      // per-child held-button map, covering a down that was in flight here.
      events_.push_back({gameRoot, 0, 0, 0, true, gameRoot, processId});
      ready_.notify_one();
    }
  }
  void stop() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!stopping_) {
        shutdownDeadline_ = std::chrono::steady_clock::now() + std::chrono::milliseconds(500);
        shutdownDeadlineSet_ = true;
        events_.erase(std::remove_if(events_.begin(), events_.end(), [](const MouseEvent& event) { return !event.releaseAll; }), events_.end());
        for (const auto& [gameRoot, processId] : knownGames_) {
          const bool alreadyQueued = releaseAlreadyScheduled(events_, activeRelease_, activeReleaseRoot_, activeReleasePid_, gameRoot, processId);
          if (!alreadyQueued) events_.push_back({gameRoot, 0, 0, 0, true, gameRoot, processId});
        }
      }
      std::deque<MouseEvent> releases;
      for (auto it = events_.rbegin(); it != events_.rend(); ++it) {
        const bool alreadyQueued = std::any_of(releases.begin(), releases.end(), [&](const MouseEvent& candidate) {
          return candidate.gameRoot == it->gameRoot && candidate.processId == it->processId;
        });
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
        if (event.releaseAll) {
          activeRelease_ = true; activeReleaseRoot_ = event.gameRoot; activeReleasePid_ = event.processId;
        }
      }
      if (event.releaseAll) {
        releaseGameTree(event.gameRoot, event.processId);
        {
          std::lock_guard<std::mutex> lock(mutex_);
          activeRelease_ = false; activeReleaseRoot_ = nullptr; activeReleasePid_ = 0;
        }
        continue;
      }
      if (!windowBelongsToGame(event.target, event.gameRoot, event.processId)) continue;
      DWORD_PTR ignored{};
      const bool delivered = SendMessageTimeoutW(event.target, event.message, event.wparam, event.lparam,
          SMTO_ABORTIFHUNG | SMTO_BLOCK, 50, &ignored) != FALSE;
      const unsigned button = buttonFor(event.message, event.wparam);
      const bool isDown = event.message == WM_LBUTTONDOWN || event.message == WM_RBUTTONDOWN ||
          event.message == WM_MBUTTONDOWN || event.message == WM_XBUTTONDOWN;
      if (button || event.message == WM_MOUSEMOVE) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (isDown) {
          auto& held = heldButtons_[event.target];
          held.gameRoot = event.gameRoot; held.processId = event.processId;
          held.buttons |= button;
          held.lastClientPoint = event.lparam;
        } else {
          const auto found = heldButtons_.find(event.target);
          if (found != heldButtons_.end() && found->second.gameRoot == event.gameRoot && found->second.processId == event.processId) {
            // WM_MOUSEMOVE/button lParams are client coordinates for this exact
            // recipient HWND; never replace this with wheel screen coordinates.
            found->second.lastClientPoint = event.lparam;
            if (button && delivered) {
              found->second.buttons &= ~button;
              if (!found->second.buttons) heldButtons_.erase(found);
            }
          }
        }
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
  void rememberGameLocked(HWND gameRoot, DWORD processId) {
    const auto found = std::find_if(knownGames_.begin(), knownGames_.end(), [&](const auto& identity) {
      return identity.first == gameRoot && identity.second == processId;
    });
    if (found == knownGames_.end()) knownGames_.emplace_back(gameRoot, processId);
  }
  void pruneInvalidHeldTargetsLocked() {
    for (auto it = heldButtons_.begin(); it != heldButtons_.end();) {
      if (!windowBelongsToGame(it->first, it->second.gameRoot, it->second.processId))
        it = heldButtons_.erase(it);
      else ++it;
    }
  }
  void releaseGameTree(HWND gameRoot, DWORD processId) {
    const auto normalDeadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(500);
    const auto cleanupDeadline = [&] {
      std::lock_guard<std::mutex> lock(mutex_);
      return selectCleanupDeadline(normalDeadline, shutdownDeadlineSet_, shutdownDeadline_);
    };
    auto targets = [&] {
      std::lock_guard<std::mutex> lock(mutex_);
      return heldTargetsForGame(heldButtons_, gameRoot, processId);
    }();
    for (HWND target : targets) {
      if (std::chrono::steady_clock::now() >= cleanupDeadline()) break;
      unsigned held{};
      LPARAM point{};
      {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto found = heldButtons_.find(target);
        if (found == heldButtons_.end() || found->second.gameRoot != gameRoot || found->second.processId != processId) continue;
        held = found->second.buttons;
        point = heldClientPointForTarget(heldButtons_, target, gameRoot, processId);
      }
      if (!held) continue;
      if (!windowBelongsToGame(target, gameRoot, processId)) {
        std::lock_guard<std::mutex> lock(mutex_); heldButtons_.erase(target); continue;
      }
      // Cleanup gets a short bounded synchronous attempt and then a queued
      // release fallback. This avoids holding overlay teardown on a hung game.
      auto releaseWithinDeadline = [&](UINT message, WPARAM keys, unsigned button) {
        const auto currentDeadline = cleanupDeadline();
        const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(currentDeadline - std::chrono::steady_clock::now()).count();
        if (remaining <= 0) return;
        const UINT timeout = static_cast<UINT>((std::min)(20LL, remaining));
        releaseButton(target, gameRoot, processId, held, message, keys, point, button, timeout, true);
      };
      releaseWithinDeadline(WM_LBUTTONUP, 0, kLeft);
      releaseWithinDeadline(WM_RBUTTONUP, 0, kRight);
      releaseWithinDeadline(WM_MBUTTONUP, 0, kMiddle);
      releaseWithinDeadline(WM_XBUTTONUP, MAKEWPARAM(0, XBUTTON1), kX1);
      releaseWithinDeadline(WM_XBUTTONUP, MAKEWPARAM(0, XBUTTON2), kX2);
      if (std::chrono::steady_clock::now() >= cleanupDeadline()) break;
    }
    {
      std::lock_guard<std::mutex> lock(mutex_);
      const bool stillHeld = std::any_of(heldButtons_.begin(), heldButtons_.end(), [&](const auto& entry) {
        return entry.second.buttons && entry.second.gameRoot == gameRoot && entry.second.processId == processId;
      });
      if (stillHeld) warning("one or more mouse-button releases remain pending after bounded game-window cleanup");
      forgetGameWithoutHeldButtons(knownGames_, heldButtons_, gameRoot, processId);
    }
  }
  void releaseButton(HWND target, HWND gameRoot, DWORD processId, unsigned held, UINT message, WPARAM keys, LPARAM point,
      unsigned button, UINT timeoutMs = 50, bool postOnTimeout = false) {
    if (!(held & button) || !windowBelongsToGame(target, gameRoot, processId)) return;
    DWORD_PTR ignored{};
    bool accepted = SendMessageTimeoutW(target, message, keys, point, SMTO_ABORTIFHUNG | SMTO_BLOCK, timeoutMs, &ignored) != FALSE;
    if (!accepted && postOnTimeout && windowBelongsToGame(target, gameRoot, processId))
      accepted = PostMessageW(target, message, keys, point) != FALSE;
    if (accepted) {
      std::lock_guard<std::mutex> lock(mutex_);
      const auto found = heldButtons_.find(target);
      if (found != heldButtons_.end() && found->second.gameRoot == gameRoot && found->second.processId == processId) {
        found->second.buttons &= ~button;
        if (!found->second.buttons) heldButtons_.erase(found);
      }
    }
  }
  std::mutex mutex_;
  std::condition_variable ready_;
  std::deque<MouseEvent> events_;
  std::unordered_map<HWND, HeldButtonsState> heldButtons_;
  std::vector<std::pair<HWND, DWORD>> knownGames_;
  SteadyTime shutdownDeadline_{};
  HWND activeReleaseRoot_{};
  DWORD activeReleasePid_{};
  size_t droppedMoves_{};
  size_t coalescedMoves_{};
  bool shutdownDeadlineSet_{};
  bool activeRelease_{};
  bool invalidIdentityWarned_{};
  bool moveOverflowReported_{};
  bool stopping_{};
  std::thread worker_;
};
MouseDispatcher g_mouseDispatcher;
#include "ArcPower.CursorTransform.h"

LONG mapInputAxis(LONG coordinate, UINT sourceExtent, LONG viewportExtent, UINT targetDpi, UINT outputDpi) {
  if (!sourceExtent || viewportExtent <= 0) return 0;
  const UINT safeOutputDpi = outputDpi ? outputDpi : 96;
  const UINT safeTargetDpi = targetDpi ? targetDpi : safeOutputDpi;
  const long long sourcePixel = (static_cast<long long>(coordinate) * sourceExtent) / viewportExtent;
  const long long targetExtent = (static_cast<long long>(sourceExtent) * safeTargetDpi) / safeOutputDpi;
  const long long targetPixel = (sourcePixel * safeTargetDpi) / safeOutputDpi;
  return static_cast<LONG>((std::clamp)(targetPixel, 0LL, (std::max)(0LL, targetExtent - 1)));
}

HWND childInputTarget(HWND root, LPARAM rootClientPoint, LPARAM& childClientPoint) {
  POINT point{GET_X_LPARAM(rootClientPoint), GET_Y_LPARAM(rootClientPoint)};
  HWND target = root;
  for (;;) {
    HWND child = ChildWindowFromPointEx(target, point,
        CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT);
    if (!child || child == target) break;
    POINT childPoint = point;
    SetLastError(ERROR_SUCCESS);
    if (MapWindowPoints(target, child, &childPoint, 1) == 0 && GetLastError() != ERROR_SUCCESS) break;
    target = child;
    point = childPoint;
  }
  childClientPoint = MAKELPARAM(static_cast<SHORT>(point.x), static_cast<SHORT>(point.y));
  return target;
}

bool mapOverlayPoint(HWND hwnd, LPARAM lparam, LPARAM& mapped, bool clampPoint = false, HWND* inputTarget = nullptr) {
  if (!g_mouse.game || g_mouse.viewport.right <= g_mouse.viewport.left || g_mouse.viewport.bottom <= g_mouse.viewport.top ||
      !g_mouse.sourceWidth || !g_mouse.sourceHeight) return false;
  POINT point{GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
  RECT client{};
  if (!GetClientRect(hwnd, &client)) return false;
  POINT origin{client.left, client.top};
  if (!ClientToScreen(hwnd, &origin)) return false;
  point.x += origin.x; point.y += origin.y;
  if (!g_cursorTransform.active() && (point.x < g_mouse.viewport.left || point.x >= g_mouse.viewport.right ||
      point.y < g_mouse.viewport.top || point.y >= g_mouse.viewport.bottom)) {
    if (!clampPoint) return false;
    point.x = (std::clamp)(point.x, g_mouse.viewport.left, g_mouse.viewport.right - 1);
    point.y = (std::clamp)(point.y, g_mouse.viewport.top, g_mouse.viewport.bottom - 1);
  }
  const LONG x = point.x - g_mouse.viewport.left;
  const LONG y = point.y - g_mouse.viewport.top;
  const UINT outputDpi = GetDpiForWindow(hwnd);
  const UINT targetDpi = GetDpiForWindow(g_mouse.game);
  POINT actual{};
  const bool mappedCursor = g_cursorTransform.active() && GetCursorPos(&actual) && ScreenToClient(g_mouse.game, &actual);
  if (g_cursorTransform.active() && !mappedCursor) return false;
  const LONG clientX = mappedCursor ? actual.x : mapInputAxis(x, g_mouse.sourceWidth, g_mouse.viewport.right - g_mouse.viewport.left, targetDpi, outputDpi);
  const LONG clientY = mappedCursor ? actual.y : mapInputAxis(y, g_mouse.sourceHeight, g_mouse.viewport.bottom - g_mouse.viewport.top, targetDpi, outputDpi);
  mapped = MAKELPARAM(static_cast<SHORT>(clientX), static_cast<SHORT>(clientY));
  if (inputTarget) {
    LPARAM childPoint{};
    HWND target = childInputTarget(g_mouse.game, mapped, childPoint);
    // Keep a pressed gesture on its original recipient, matching normal
    // mouse capture when the pointer moves across child-window boundaries.
    if (g_mouse.buttons && g_mouse.inputTarget && IsWindow(g_mouse.inputTarget)) {
      POINT screenPoint{clientX, clientY};
      ClientToScreen(g_mouse.game, &screenPoint);
      ScreenToClient(g_mouse.inputTarget, &screenPoint);
      childPoint = MAKELPARAM(static_cast<SHORT>(screenPoint.x), static_cast<SHORT>(screenPoint.y));
      target = g_mouse.inputTarget;
    }
    *inputTarget = target;
    mapped = childPoint;
  }
  return true;
}

void forwardMouse(HWND overlay, UINT message, WPARAM wparam, LPARAM lparam, bool clampPoint = false) {
  if (!g_mouse.game || !IsWindow(g_mouse.game)) return;
  LPARAM mapped{};
  HWND target = g_mouse.game;
  if (message == WM_MOUSEWHEEL || message == WM_MOUSEHWHEEL) {
    POINT p{GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
    ScreenToClient(overlay, &p);
    mapped = MAKELPARAM(static_cast<SHORT>(p.x), static_cast<SHORT>(p.y));
    if (!mapOverlayPoint(overlay, mapped, mapped, clampPoint, &target)) return;
    POINT targetPoint{GET_X_LPARAM(mapped), GET_Y_LPARAM(mapped)};
    ClientToScreen(target, &targetPoint);
    mapped = MAKELPARAM(static_cast<SHORT>(targetPoint.x), static_cast<SHORT>(targetPoint.y));
  } else if (!mapOverlayPoint(overlay, lparam, mapped, clampPoint, &target)) return;
  g_mouseDispatcher.enqueue({target, message, wparam, mapped, false, g_mouse.game, g_mouse.gamePid});
}

void clearMouseForwarding(HWND overlay) {
  if (!overlay) return;
  g_mouse.buttons = 0;
  g_mouseDispatcher.clearAndRelease(g_mouse.game, g_mouse.gamePid);
  g_mouse.inputTarget = nullptr;
  if (GetCapture() == overlay) ReleaseCapture();
  g_mouse.game = nullptr; g_mouse.viewport = {}; g_mouse.sourceWidth = g_mouse.sourceHeight = 0;
  g_mouse.gamePid = 0;
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
  if (g_cursorTransform.handleRedraw(message)) return 0;
  if (message == WM_MOUSEACTIVATE) return MA_NOACTIVATE;
  if (message == WM_SETCURSOR && LOWORD(lparam) == HTCLIENT) {
    // The overlay does not own the game's cursor. Explicitly reset it to the
    // normal pointer so a wait cursor set by the background game cannot stick
    // over the scaled output while the overlay is the hit-test window.
    SetCursor(g_cursorTransform.active() ? nullptr : LoadCursorW(nullptr, MAKEINTRESOURCEW(32512)));
    return TRUE;
  }
  if (message == WM_CAPTURECHANGED && reinterpret_cast<HWND>(lparam) != hwnd) {
    if (g_mouse.buttons) clearMouseForwarding(hwnd);
    return 0;
  }
  if (message == WM_MOUSEMOVE) { forwardMouse(hwnd, message, wparam, lparam); return 0; }
  if (message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN || message == WM_MBUTTONDOWN || message == WM_XBUTTONDOWN) {
    LPARAM mapped{};
    HWND target{};
    if (mapOverlayPoint(hwnd, lparam, mapped, false, &target)) {
      if (GetCapture() != hwnd) SetCapture(hwnd);
      unsigned button = message == WM_LBUTTONDOWN ? kLeft : message == WM_RBUTTONDOWN ? kRight :
          message == WM_MBUTTONDOWN ? kMiddle : (GET_XBUTTON_WPARAM(wparam) == XBUTTON1 ? kX1 : kX2);
      g_mouse.buttons |= button;
      g_mouse.inputTarget = target;
      g_mouseDispatcher.enqueue({target, message, wparam, mapped, false, g_mouse.game, g_mouse.gamePid});
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
    if (part > maximum) return false;
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

bool parseScaleCommand(const std::string& line, DWORD& pid, unsigned long long& creation, bool& upscale, int& percent) {
  std::istringstream input(line);
  std::string verb, pidText, creationText, upscaleText, percentText, extra;
  unsigned long long parsedPid{}, parsedCreation{}, parsedUpscale{}, parsedPercent{};
  if (!(input >> verb >> pidText >> creationText >> upscaleText >> percentText) || verb != "SCALE"
      || (input >> extra) || !parseUnsignedDecimal(pidText, MAXDWORD, parsedPid)
      || !parseUnsignedDecimal(creationText, ULLONG_MAX, parsedCreation)
      || !parseUnsignedDecimal(upscaleText, 1, parsedUpscale)
      || !parseUnsignedDecimal(percentText, 100, parsedPercent)) return false;
  if (parsedPid == 0) {
    if (parsedCreation || parsedUpscale || parsedPercent) return false;
  } else if (parsedCreation == 0 || (parsedUpscale == 0 && parsedPercent == 0)) return false;
  pid = static_cast<DWORD>(parsedPid);
  creation = parsedCreation;
  upscale = parsedUpscale != 0;
  percent = static_cast<int>(parsedPercent);
  return true;
}

bool nativeCommandParserProbe() {
  const auto accepts = [](const char* line, bool expected) {
    DWORD pid{}; unsigned long long creation{};
    const bool actual = parseAsrCommand(line, pid, creation);
    if (actual != expected) error(std::string("ASR parser probe mismatch for: ") + line);
    return actual == expected;
  };
  const auto acceptsScale = [](const char* line, bool expected) {
    DWORD pid{}; unsigned long long creation{}; bool upscale{}; int percent{};
    const bool actual = parseScaleCommand(line, pid, creation, upscale, percent);
    if (actual != expected) error(std::string("Scale parser probe mismatch for: ") + line);
    return actual == expected;
  };
  return accepts("ASR 0", true) && accepts("ASR 0 1", false) &&
      accepts("ASR 123 456", true) && accepts("ASR 123", false) &&
      accepts("ASR 123 ", false) && accepts("", false) &&
      accepts("ASR 123 -1", false) && accepts("ASR 123 18446744073709551616", false) &&
      accepts("ASR 123 0", false) && parseStopCommand("STOP") && !parseStopCommand("STOP extra") &&
      acceptsScale("SCALE 0 0 0 0", true) && acceptsScale("SCALE 123 456 1 50", true) &&
      acceptsScale("SCALE 123 456 0 50", true) && acceptsScale("SCALE 123 456 0 0", false) &&
      acceptsScale("SCALE 0 0 1 50", false) && acceptsScale("SCALE 123 0 1 50", false) &&
      acceptsScale("SCALE 123 456 2 50", false) && acceptsScale("SCALE 123 456 1 101", false);
}

bool nativeMouseMappingProbe() {
  const bool passed = mapInputAxis(960, 1280, 1920, 96, 144) == 426
      && mapInputAxis(1919, 1280, 1920, 96, 144) == 852
      && mapInputAxis(960, 1280, 1920, 144, 144) == 640
      && mapInputAxis(0, 1280, 1920, 96, 144) == 0
      && mapInputAxis(1919, 1280, 1920, 96, 0) == 1279
      && mapInputAxis(0, 1280, 0, 96, 144) == 0;
  if (!passed) error("DPI-aware mouse mapping probe failed");
  return passed;
}

bool nativeMouseDispatcherProbe() {
  const HWND target = reinterpret_cast<HWND>(static_cast<uintptr_t>(0x1234));
  std::deque<MouseEvent> queue;
  size_t dropped{}, coalesced{};
  enqueueBoundedMouseMove(queue, {target, WM_MOUSEMOVE, 0, 1, false}, 2, dropped, coalesced);
  enqueueBoundedMouseMove(queue, {target, WM_MOUSEMOVE, 0, 2, false}, 2, dropped, coalesced);
  if (queue.size() != 1 || queue.front().lparam != 2 || coalesced != 1) {
    error("mouse dispatcher probe failed: adjacent move was not coalesced to latest position");
    return false;
  }

  enqueueBoundedMouseMove(queue, {target, WM_LBUTTONDOWN, MK_LBUTTON, 3, false}, 2, dropped, coalesced);
  enqueueBoundedMouseMove(queue, {target, WM_MOUSEMOVE, MK_LBUTTON, 4, false}, 2, dropped, coalesced);
  enqueueBoundedMouseMove(queue, {target, WM_LBUTTONUP, 0, 5, false}, 2, dropped, coalesced);
  enqueueBoundedMouseMove(queue, {target, WM_MOUSEWHEEL, MAKEWPARAM(0, WHEEL_DELTA), 6, false}, 2, dropped, coalesced);
  enqueueBoundedMouseMove(queue, {target, WM_MOUSEMOVE, 0, 7, false}, 2, dropped, coalesced);
  const std::vector<MouseEvent> transitions = [&] {
    std::vector<MouseEvent> result;
    for (const auto& event : queue)
      if (event.message == WM_LBUTTONDOWN || event.message == WM_LBUTTONUP || event.message == WM_MOUSEWHEEL)
        result.push_back(event);
    return result;
  }();
  const bool transitionsPreserved = transitions.size() == 3
      && transitions[0].message == WM_LBUTTONDOWN && transitions[0].wparam == MK_LBUTTON && transitions[0].lparam == 3
      && transitions[1].message == WM_LBUTTONUP && transitions[1].wparam == 0 && transitions[1].lparam == 5
      && transitions[2].message == WM_MOUSEWHEEL && transitions[2].wparam == MAKEWPARAM(0, WHEEL_DELTA) && transitions[2].lparam == 6;
  const bool bounded = static_cast<size_t>(std::count_if(queue.begin(), queue.end(), [](const MouseEvent& event) {
    return event.message == WM_MOUSEMOVE && !event.releaseAll;
  })) <= 2;
  const bool releasePreserved = [&] {
    std::deque<MouseEvent> releaseQueue{{target, 0, 0, 8, true}};
    enqueueBoundedMouseMove(releaseQueue, {target, WM_MOUSEMOVE, 0, 9, false}, 1, dropped, coalesced);
    return releaseQueue.size() == 2 && releaseQueue.front().releaseAll;
  }();
  const HWND gameRoot = reinterpret_cast<HWND>(static_cast<uintptr_t>(0x2000));
  const HWND childOne = reinterpret_cast<HWND>(static_cast<uintptr_t>(0x2001));
  const HWND childTwo = reinterpret_cast<HWND>(static_cast<uintptr_t>(0x2002));
  const HWND otherRoot = reinterpret_cast<HWND>(static_cast<uintptr_t>(0x3000));
  const HWND otherChild = reinterpret_cast<HWND>(static_cast<uintptr_t>(0x3001));
  constexpr DWORD gamePid = 4242, otherPid = 8484;
  const bool identityValidation = windowIdentityMatches(true, gamePid, gameRoot, gameRoot, gamePid)
      && !windowIdentityMatches(true, 0, gameRoot, gameRoot, gamePid)
      && !windowIdentityMatches(true, gamePid, gameRoot, nullptr, gamePid)
      && !windowIdentityMatches(true, otherPid, gameRoot, gameRoot, gamePid)
      && !windowIdentityMatches(true, gamePid, otherRoot, gameRoot, gamePid)
      && !windowIdentityMatches(false, gamePid, gameRoot, gameRoot, gamePid);
  const SteadyTime sharedDeadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(500);
  const bool sharedDeadlineSelected = selectCleanupDeadline(sharedDeadline - std::chrono::milliseconds(80), true, sharedDeadline) == sharedDeadline
      && selectCleanupDeadline(sharedDeadline - std::chrono::milliseconds(20), true, sharedDeadline) == sharedDeadline
      && selectCleanupDeadline(sharedDeadline - std::chrono::milliseconds(80), false, sharedDeadline) == sharedDeadline - std::chrono::milliseconds(80);
  const std::deque<MouseEvent> queuedRelease{{gameRoot, 0, 0, 0, true, gameRoot, gamePid}};
  const bool releaseDeduped = releaseAlreadyScheduled(queuedRelease, false, nullptr, 0, gameRoot, gamePid)
      && releaseAlreadyScheduled({}, true, gameRoot, gamePid, gameRoot, gamePid)
      && !releaseAlreadyScheduled({}, false, nullptr, 0, gameRoot, gamePid);
  std::deque<MouseEvent> treeQueue{
      {childOne, WM_MOUSEMOVE, 0, 10, false, gameRoot, gamePid},
      {childOne, WM_LBUTTONDOWN, MK_LBUTTON, 11, false, gameRoot, gamePid},
      {otherChild, WM_MOUSEWHEEL, 12, 13, false, otherRoot, otherPid},
      {gameRoot, 0, 0, 14, true, gameRoot, gamePid},
      {childTwo, WM_RBUTTONUP, 0, 15, false, gameRoot, gamePid}};
  eraseQueuedGameEvents(treeQueue, gameRoot, gamePid);
  const bool gameEventsCleared = treeQueue.size() == 2 && treeQueue[0].target == otherChild
      && treeQueue[1].releaseAll && treeQueue[1].gameRoot == gameRoot && treeQueue[1].processId == gamePid;
  const std::unordered_map<HWND, HeldButtonsState> held{
      {childOne, {gameRoot, gamePid, kLeft | kX1, 111}},
      {childTwo, {gameRoot, gamePid, kRight, 222}},
      {otherChild, {otherRoot, otherPid, kMiddle, 333}}};
  const auto releaseTargets = heldTargetsForGame(held, gameRoot, gamePid);
  const bool allChildrenReleased = releaseTargets.size() == 2
      && std::find(releaseTargets.begin(), releaseTargets.end(), childOne) != releaseTargets.end()
      && std::find(releaseTargets.begin(), releaseTargets.end(), childTwo) != releaseTargets.end();
  const bool perTargetReleaseCoordinates = heldClientPointForTarget(held, childOne, gameRoot, gamePid) == 111
      && heldClientPointForTarget(held, childTwo, gameRoot, gamePid) == 222
      && heldClientPointForTarget(held, otherChild, gameRoot, gamePid) == 0;
  std::vector<std::pair<HWND, DWORD>> knownGames{{gameRoot, gamePid}, {otherRoot, otherPid}};
  forgetGameWithoutHeldButtons(knownGames, held, gameRoot, gamePid);
  const bool retainedUntilReleased = knownGames.size() == 2;
  forgetGameWithoutHeldButtons(knownGames, {}, gameRoot, gamePid);
  const bool prunedAfterRelease = knownGames.size() == 1 && knownGames.front() == std::make_pair(otherRoot, otherPid);
  if (dropped != 1 || !transitionsPreserved || !bounded || !releasePreserved
      || !gameEventsCleared || !allChildrenReleased || !retainedUntilReleased || !prunedAfterRelease
      || !identityValidation || !sharedDeadlineSelected || !releaseDeduped || !perTargetReleaseCoordinates) {
    error("mouse dispatcher probe failed: bounded backlog changed a button/wheel/release event");
    return false;
  }
  std::cout << "Mouse dispatcher probe passed: bounded moves; transition order; tree clear; multi-child release coordinates; identity/deadline safety.\n";
  return true;
}

bool fsrShaderCompileProbe() {
  wchar_t modulePath[MAX_PATH * 4]{};
  const DWORD moduleLength = GetModuleFileNameW(nullptr, modulePath, static_cast<DWORD>(std::size(modulePath)));
  if (!moduleLength || moduleLength >= std::size(modulePath)) {
    error("FSR shader probe could not resolve its executable path");
    return false;
  }
  std::wstring fsrPath(modulePath, moduleLength);
  const size_t separator = fsrPath.find_last_of(L"\\/");
  if (separator == std::wstring::npos) { error("FSR shader probe could not resolve its executable directory"); return false; }
  fsrPath.resize(separator + 1);
  fsrPath += L"fsr1\\ArcPower.Fsr1.hlsl";
  const UINT flags = D3DCOMPILE_OPTIMIZATION_LEVEL3 | D3DCOMPILE_ENABLE_STRICTNESS;
  const auto compile = [&](const char* entry, const char* profile) {
    ComPtr<ID3DBlob> shader, diagnostics;
    const HRESULT hr = D3DCompileFromFile(fsrPath.c_str(), nullptr, D3D_COMPILE_STANDARD_FILE_INCLUDE,
        entry, profile, flags, 0, &shader, &diagnostics);
    if (SUCCEEDED(hr)) return true;
    std::string detail;
    if (diagnostics && diagnostics->GetBufferPointer() && diagnostics->GetBufferSize()) {
      detail.assign(static_cast<const char*>(diagnostics->GetBufferPointer()), diagnostics->GetBufferSize());
    }
    error("FSR shader probe failed for " + std::string(entry) + (detail.empty() ? "" : ": " + detail));
    return false;
  };
  return compile("VS", "vs_5_0") && compile("EasuPS", "ps_5_0") && compile("RcasPS", "ps_5_0");
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
      g_command.scale = false;
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
      g_command.scale = false;
        g_command.expectedCreation = creation;
        ++g_command.revision;
      } else warning("ignored malformed command; expected ASR 0, ASR <decimal-pid> <creation-filetime>, or STOP");
      continue;
    }
    if (verb == "SCALE") {
      DWORD pid{}; unsigned long long creation{}; bool upscale{}; int percent{};
      if (parseScaleCommand(line, pid, creation, upscale, percent)) {
        std::lock_guard<std::mutex> lock(g_commandMutex);
        g_command.pid = pid;
        g_command.percent = percent;
        g_command.asr = upscale;
        g_command.scale = pid != 0;
        g_command.expectedCreation = creation;
        ++g_command.revision;
      } else warning("ignored malformed command; expected SCALE <pid> <creation-filetime> <upscale-0-or-1> <sharpness-0-100>, or SCALE 0 0 0 0");
      continue;
    }
    warning("ignored malformed command; expected SET <decimal-pid> <0-100>, ASR <decimal-pid>, SCALE <pid> <creation-filetime> <upscale> <sharpness>, or STOP");
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
  ComPtr<ID3D11PixelShader> easuPixelShader;
  ComPtr<ID3D11PixelShader> rcasPixelShader;
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
  ComPtr<IDCompositionDevice> compositionDevice;
  ComPtr<IDCompositionTarget> compositionTarget;
  ComPtr<IDCompositionVisual> compositionVisual;
  HANDLE frameLatencyHandle{};
  bool frameAdmitted{};
  bool captureStatsEnabled{};
  unsigned long long captureRenders{}, capturePresents{}, captureBusy{}, captureRetries{};
  struct CaptureTiming { double sourceGap{}, age{}, renderCpu{}; };
  std::vector<CaptureTiming> captureTimings;
  std::vector<double> captureSubmissionGaps;
  long long lastCaptureTimestamp{}, lastSubmissionQpc{};
  static long long qpc() { LARGE_INTEGER value{}; QueryPerformanceCounter(&value); return value.QuadPart; }
  static double qpcMs(long long ticks) {
    static const double frequency = [] { LARGE_INTEGER value{}; QueryPerformanceFrequency(&value); return static_cast<double>(value.QuadPart); }();
    return static_cast<double>(ticks) * 1000.0 / frequency;
  }
  void recordCaptureTiming(long long timestamp, long long before, long long after) {
    if (!captureStatsEnabled) return;
    // Diagnostic only. Bound memory and print only after scaling has stopped.
    if (captureTimings.size() < 4096) {
      captureTimings.push_back({lastCaptureTimestamp ? (timestamp - lastCaptureTimestamp) / 10000.0 : 0,
          timestamp > 0 ? qpcMs(before) - timestamp / 10000.0 : -1,
          qpcMs(after - before)});
    }
    lastCaptureTimestamp = timestamp;
  }
  void reportCaptureTimings() {
    if (captureTimings.empty()) return;
    const auto reportValues = [&](const char* name, std::vector<double> values) {
      if (values.empty()) return;
      std::sort(values.begin(), values.end());
      const auto percentile = [&](double p) { return values[static_cast<size_t>((values.size() - 1) * p)]; };
      statusLine(std::string("INFO CAPTURE_TIMING metric=") + name + " count=" + std::to_string(values.size())
          + " medianMs=" + std::to_string(percentile(0.50)) + " p95Ms=" + std::to_string(percentile(0.95))
          + " p99Ms=" + std::to_string(percentile(0.99)) + " maxMs=" + std::to_string(values.back()));
    };
    const auto report = [&](const char* name, double CaptureTiming::* field) {
      std::vector<double> values; values.reserve(captureTimings.size());
      for (const auto& sample : captureTimings) if (sample.*field > 0) values.push_back(sample.*field);
      const auto excluded = captureTimings.size() - values.size();
      reportValues(name, std::move(values));
      if (excluded) statusLine(std::string("INFO CAPTURE_TIMING_EXCLUDED metric=") + name
          + " nonpositiveOrUnavailable=" + std::to_string(excluded));
    };
    report("selectedSourceTimestampGap", &CaptureTiming::sourceGap);
    report("captureAgeAtRender", &CaptureTiming::age);
    report("renderAndPresentCpu", &CaptureTiming::renderCpu);
    reportValues("acceptedSubmissionGap", captureSubmissionGaps);
    statusLine("INFO CAPTURE_TIMING_LIMIT capacity=4096 renderSamples=" + std::to_string(captureTimings.size())
        + " renderSamplesOmitted=" + std::to_string(captureRenders > captureTimings.size() ? captureRenders - captureTimings.size() : 0)
        + " submissionGaps=" + std::to_string(captureSubmissionGaps.size()));
  }
  ComPtr<ID3D11RenderTargetView> backBufferRtv;
  ComPtr<ID3D11Texture2D> cropTexture;
  ComPtr<ID3D11ShaderResourceView> cropSrv;
  ComPtr<ID3D11Texture2D> horizontalTexture;
  ComPtr<ID3D11ShaderResourceView> horizontalSrv;
  ComPtr<ID3D11RenderTargetView> horizontalRtv;
  ComPtr<ID3D11Texture2D> scaledTexture;
  ComPtr<ID3D11ShaderResourceView> scaledSrv;
  ComPtr<ID3D11RenderTargetView> scaledRtv;
  ComPtr<ID3D11SamplerState> fsrSampler;
  ComPtr<ID3D11Texture2D> rcasTexture;
  ComPtr<ID3D11ShaderResourceView> rcasSrv;
  ComPtr<ID3D11RenderTargetView> rcasRtv;
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

  void initializeDevice(HWND target, bool duplicateDesktop = true) {
    ComPtr<IDXGIFactory1> factory;
    HRESULT hr = CreateDXGIFactory1(IID_PPV_ARGS(&factory));
    if (FAILED(hr)) throw hresult_error(hr, L"CreateDXGIFactory1 failed");
    const HMONITOR targetMonitor = MonitorFromWindow(target, MONITOR_DEFAULTTONEAREST);
    bool matchingOutputFound = false;
    HRESULT deviceCreationError = S_OK;
    for (UINT index = 0; ; ++index) {
      ComPtr<IDXGIAdapter1> candidate;
      hr = factory->EnumAdapters1(index, &candidate);
      if (hr == DXGI_ERROR_NOT_FOUND) break;
      if (FAILED(hr)) throw hresult_error(hr, L"EnumAdapters1 failed");
      DXGI_ADAPTER_DESC1 desc{};
      candidate->GetDesc1(&desc);
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
          matchingOutputFound = true;
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
      if (!matchingOutputFound) throw hresult_error(E_NOINTERFACE, L"No attached DXGI output matches the foreground window monitor");
      throw hresult_error(FAILED(deviceCreationError) ? deviceCreationError : E_FAIL,
          L"The adapter owning the foreground monitor output could not create a D3D11 device");
    }
    ComPtr<IDXGIDevice1> latencyDevice;
    if (duplicateDesktop && SUCCEEDED(device.As(&latencyDevice))) {
      const HRESULT latencyHr = latencyDevice->SetMaximumFrameLatency(1);
      if (FAILED(latencyHr)) warning("SetMaximumFrameLatency(1) failed (HRESULT " + std::to_string(static_cast<unsigned long>(latencyHr)) + ")");
    }
    if (duplicateDesktop) {
      ComPtr<IDXGIOutput1> output1;
      if (FAILED(hr = output.As(&output1))) throw hresult_error(hr, L"Query IDXGIOutput1 failed");
      if (FAILED(hr = output1->DuplicateOutput(device.Get(), &duplication)))
        throw hresult_error(hr, L"Create Desktop Duplication for the output failed");
    }
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
    outputInfo << "INFO Window capture render adapter=0x" << std::hex << selectedAdapter.VendorId << ":0x" << selectedAdapter.DeviceId
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

    wchar_t modulePath[MAX_PATH * 4]{};
    const DWORD moduleLength = GetModuleFileNameW(nullptr, modulePath, static_cast<DWORD>(std::size(modulePath)));
    if (!moduleLength || moduleLength >= std::size(modulePath)) throw hresult_error(HRESULT_FROM_WIN32(GetLastError()), L"Resolve FSR shader location failed");
    std::wstring fsrPath(modulePath, moduleLength);
    const size_t separator = fsrPath.find_last_of(L"\\/");
    if (separator == std::wstring::npos) throw hresult_error(E_INVALIDARG, L"Resolve FSR shader directory failed");
    fsrPath.resize(separator + 1);
    fsrPath += L"fsr1\\ArcPower.Fsr1.hlsl";
    ComPtr<ID3DBlob> fsrVs, easuPs, rcasPs;
    const UINT shaderFlags = D3DCOMPILE_OPTIMIZATION_LEVEL3 | D3DCOMPILE_ENABLE_STRICTNESS;
    hr = D3DCompileFromFile(fsrPath.c_str(), nullptr, D3D_COMPILE_STANDARD_FILE_INCLUDE, "VS", "vs_5_0", shaderFlags, 0, &fsrVs, &errors);
    if (FAILED(hr)) throw hresult_error(hr, L"Compile FSR vertex shader failed");
    hr = D3DCompileFromFile(fsrPath.c_str(), nullptr, D3D_COMPILE_STANDARD_FILE_INCLUDE, "EasuPS", "ps_5_0", shaderFlags, 0, &easuPs, &errors);
    if (FAILED(hr)) throw hresult_error(hr, L"Compile FSR EASU shader failed");
    hr = D3DCompileFromFile(fsrPath.c_str(), nullptr, D3D_COMPILE_STANDARD_FILE_INCLUDE, "RcasPS", "ps_5_0", shaderFlags, 0, &rcasPs, &errors);
    if (FAILED(hr)) throw hresult_error(hr, L"Compile FSR RCAS shader failed");
    if (FAILED(hr = device->CreateVertexShader(fsrVs->GetBufferPointer(), fsrVs->GetBufferSize(), nullptr, &vertexShader)))
      throw hresult_error(hr, L"Create FSR vertex shader failed");
    if (FAILED(hr = device->CreatePixelShader(easuPs->GetBufferPointer(), easuPs->GetBufferSize(), nullptr, &easuPixelShader)))
      throw hresult_error(hr, L"Create FSR EASU pixel shader failed");
    if (FAILED(hr = device->CreatePixelShader(rcasPs->GetBufferPointer(), rcasPs->GetBufferSize(), nullptr, &rcasPixelShader)))
      throw hresult_error(hr, L"Create FSR RCAS pixel shader failed");
    D3D11_BUFFER_DESC cb{}; cb.ByteWidth = 96; cb.Usage = D3D11_USAGE_DEFAULT; cb.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
    if (FAILED(hr = device->CreateBuffer(&cb, nullptr, &constants))) throw hresult_error(hr, L"CreateBuffer failed");
    D3D11_SAMPLER_DESC sm{}; sm.Filter = D3D11_FILTER_MIN_MAG_MIP_POINT;
    sm.AddressU = sm.AddressV = sm.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    if (FAILED(hr = device->CreateSamplerState(&sm, &sampler))) throw hresult_error(hr, L"CreateSamplerState failed");
    sm.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    if (FAILED(hr = device->CreateSamplerState(&sm, &fsrSampler))) throw hresult_error(hr, L"Create FSR sampler failed");
    D3D11_RASTERIZER_DESC rs{}; rs.FillMode = D3D11_FILL_SOLID; rs.CullMode = D3D11_CULL_NONE; rs.DepthClipEnable = TRUE;
    if (FAILED(hr = device->CreateRasterizerState(&rs, &rasterizer))) throw hresult_error(hr, L"CreateRasterizerState failed");
  }

  void resetGraphics() noexcept {
    cropSrv.Reset(); cropTexture.Reset(); cropFormat = DXGI_FORMAT_UNKNOWN; backBufferRtv.Reset();
    duplication.Reset(); output.Reset(); adapter.Reset();
    horizontalSrv.Reset(); horizontalRtv.Reset(); horizontalTexture.Reset(); scaledSrv.Reset(); scaledRtv.Reset(); scaledTexture.Reset();
    rcasSrv.Reset(); rcasRtv.Reset(); rcasTexture.Reset();
    fsrSampler.Reset(); sampler.Reset(); rasterizer.Reset(); constants.Reset(); rcasPixelShader.Reset(); easuPixelShader.Reset(); lanczosPixelShader.Reset(); pixelShader.Reset(); vertexShader.Reset();
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
    scaledSrv.Reset(); scaledRtv.Reset(); scaledTexture.Reset(); rcasSrv.Reset(); rcasRtv.Reset(); rcasTexture.Reset();
    return true;
  }

  void copyCapturedWindowFrame(ID3D11Texture2D* frame, UINT sourceX, UINT sourceY, UINT frameWidth, UINT frameHeight) {
    if (!device || !frame || !frameWidth || !frameHeight) throw hresult_error(E_INVALIDARG, L"Invalid captured window frame");
    D3D11_TEXTURE2D_DESC sourceDesc{}; frame->GetDesc(&sourceDesc);
    if (sourceDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM || sourceX > sourceDesc.Width || sourceY > sourceDesc.Height
        || frameWidth > sourceDesc.Width - sourceX || frameHeight > sourceDesc.Height - sourceY)
      throw hresult_error(E_INVALIDARG, L"Captured window format or dimensions are unsupported");
    if (!cropTexture || sourceWidth != frameWidth || sourceHeight != frameHeight || cropFormat != sourceDesc.Format) {
      cropSrv.Reset(); cropTexture.Reset();
      D3D11_TEXTURE2D_DESC desc{}; desc.Width = frameWidth; desc.Height = frameHeight;
      desc.MipLevels = 1; desc.ArraySize = 1; desc.Format = sourceDesc.Format;
      desc.SampleDesc.Count = 1; desc.Usage = D3D11_USAGE_DEFAULT; desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
      HRESULT hr = device->CreateTexture2D(&desc, nullptr, &cropTexture);
      if (FAILED(hr)) throw hresult_error(hr, L"Create captured window texture failed");
      D3D11_SHADER_RESOURCE_VIEW_DESC view{}; view.Format = sourceDesc.Format;
      view.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2D; view.Texture2D.MipLevels = 1;
      if (FAILED(hr = device->CreateShaderResourceView(cropTexture.Get(), &view, &cropSrv)))
        throw hresult_error(hr, L"Create captured window shader resource failed");
      sourceWidth = frameWidth; sourceHeight = frameHeight; cropFormat = sourceDesc.Format;
    }
    D3D11_BOX box{sourceX, sourceY, 0, sourceX + frameWidth, sourceY + frameHeight, 1};
    context->CopySubresourceRegion(cropTexture.Get(), 0, 0, 0, 0, frame, 0, &box);
  }

  void ensureFsrTarget(ComPtr<ID3D11Texture2D>& texture, ComPtr<ID3D11ShaderResourceView>& srv,
      ComPtr<ID3D11RenderTargetView>& rtv, UINT targetWidth, UINT targetHeight) {
    D3D11_TEXTURE2D_DESC current{};
    if (texture) texture->GetDesc(&current);
    if (texture && current.Width == targetWidth && current.Height == targetHeight && current.Format == DXGI_FORMAT_B8G8R8A8_UNORM) return;
    srv.Reset(); rtv.Reset(); texture.Reset();
    D3D11_TEXTURE2D_DESC desc{}; desc.Width = targetWidth; desc.Height = targetHeight;
    desc.MipLevels = 1; desc.ArraySize = 1; desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1; desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    HRESULT hr = device->CreateTexture2D(&desc, nullptr, &texture);
    if (FAILED(hr)) throw hresult_error(hr, L"Create FSR intermediate texture failed");
    if (FAILED(hr = device->CreateShaderResourceView(texture.Get(), nullptr, &srv)))
      throw hresult_error(hr, L"Create FSR intermediate shader resource failed");
    if (FAILED(hr = device->CreateRenderTargetView(texture.Get(), nullptr, &rtv)))
      throw hresult_error(hr, L"Create FSR intermediate render target failed");
  }

  bool renderCapturedWindow(ID3D11Texture2D* frame, UINT sourceX, UINT sourceY, UINT inputWidth, UINT inputHeight, bool upscale, int sharpness) {
    if (!swapChain || !overlay || !backBufferRtv || !frame || !inputWidth || !inputHeight || sharpness < 0 || sharpness > 100)
      return false;
    ++captureRenders;
    copyCapturedWindowFrame(frame, sourceX, sourceY, inputWidth, inputHeight);
    const UINT targetWidth = upscale ? static_cast<UINT>(viewport.right - viewport.left) : inputWidth;
    const UINT targetHeight = upscale ? static_cast<UINT>(viewport.bottom - viewport.top) : inputHeight;
    if (!targetWidth || !targetHeight) return false;

    uint32_t params[24]{};
    const auto setFloat = [&](size_t index, float value) { params[index] = std::bit_cast<uint32_t>(value); };
    if (upscale) {
      const float invInputWidth = 1.0f / inputWidth, invInputHeight = 1.0f / inputHeight;
      setFloat(0, static_cast<float>(inputWidth) / targetWidth);
      setFloat(1, static_cast<float>(inputHeight) / targetHeight);
      setFloat(2, 0.5f * static_cast<float>(inputWidth) / targetWidth - 0.5f);
      setFloat(3, 0.5f * static_cast<float>(inputHeight) / targetHeight - 0.5f);
      setFloat(4, invInputWidth); setFloat(5, invInputHeight); setFloat(6, invInputWidth); setFloat(7, -invInputHeight);
      setFloat(8, -invInputWidth); setFloat(9, 2.0f * invInputHeight); setFloat(10, invInputWidth); setFloat(11, 2.0f * invInputHeight);
      setFloat(13, 4.0f * invInputHeight);
      const bool easuDirectToBackBuffer = sharpness == 0;
      if (!easuDirectToBackBuffer) ensureFsrTarget(scaledTexture, scaledSrv, scaledRtv, targetWidth, targetHeight);
      params[20] = static_cast<uint32_t>(easuDirectToBackBuffer ? viewport.left : 0);
      params[21] = static_cast<uint32_t>(easuDirectToBackBuffer ? viewport.top : 0);
      if (easuDirectToBackBuffer) {
        const float black[4]{0, 0, 0, 1};
        context->OMSetRenderTargets(1, backBufferRtv.GetAddressOf(), nullptr);
        context->ClearRenderTargetView(backBufferRtv.Get(), black);
      }
      D3D11_VIEWPORT passViewport{static_cast<float>(easuDirectToBackBuffer ? viewport.left : 0),
          static_cast<float>(easuDirectToBackBuffer ? viewport.top : 0), static_cast<float>(targetWidth), static_cast<float>(targetHeight), 0, 1};
      context->RSSetState(rasterizer.Get()); context->RSSetViewports(1, &passViewport);
      ID3D11RenderTargetView* easuTarget = easuDirectToBackBuffer ? backBufferRtv.Get() : scaledRtv.Get();
      context->OMSetRenderTargets(1, &easuTarget, nullptr);
      context->VSSetShader(vertexShader.Get(), nullptr, 0); context->PSSetShader(easuPixelShader.Get(), nullptr, 0);
      context->PSSetSamplers(0, 1, fsrSampler.GetAddressOf()); context->PSSetShaderResources(0, 1, cropSrv.GetAddressOf());
      context->PSSetConstantBuffers(0, 1, constants.GetAddressOf());
      context->UpdateSubresource(constants.Get(), 0, nullptr, params, 0, 0);
      context->IASetInputLayout(nullptr); context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST); context->Draw(3, 0);
      ID3D11ShaderResourceView* nullView = nullptr; context->PSSetShaderResources(0, 1, &nullView);
      if (easuDirectToBackBuffer) return presentOverlay();
    }

    ID3D11ShaderResourceView* outputView = upscale ? scaledSrv.Get() : cropSrv.Get();
    if (sharpness > 0) {
      const bool sharpenDirectlyToBackBuffer = true;
      const float stops = static_cast<float>(100 - sharpness) * 0.02f;
      params[16] = std::bit_cast<uint32_t>(std::exp2(-stops));
      params[20] = static_cast<uint32_t>(upscale ? viewport.left : 0);
      params[21] = static_cast<uint32_t>(upscale ? viewport.top : 0);
      if (upscale) {
        const float black[4]{0, 0, 0, 1};
        context->OMSetRenderTargets(1, backBufferRtv.GetAddressOf(), nullptr);
        context->ClearRenderTargetView(backBufferRtv.Get(), black);
      }
      D3D11_VIEWPORT passViewport{static_cast<float>(upscale ? viewport.left : 0), static_cast<float>(upscale ? viewport.top : 0),
          static_cast<float>(targetWidth), static_cast<float>(targetHeight), 0, 1};
      context->RSSetState(rasterizer.Get()); context->RSSetViewports(1, &passViewport);
      ID3D11RenderTargetView* targetRtv = sharpenDirectlyToBackBuffer ? backBufferRtv.Get() : rcasRtv.Get();
      context->OMSetRenderTargets(1, &targetRtv, nullptr);
      context->VSSetShader(vertexShader.Get(), nullptr, 0); context->PSSetShader(rcasPixelShader.Get(), nullptr, 0);
      context->PSSetShaderResources(0, 1, &outputView); context->PSSetSamplers(0, 1, fsrSampler.GetAddressOf());
      context->PSSetConstantBuffers(0, 1, constants.GetAddressOf());
      context->UpdateSubresource(constants.Get(), 0, nullptr, params, 0, 0);
      context->IASetInputLayout(nullptr); context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST); context->Draw(3, 0);
      ID3D11ShaderResourceView* nullView = nullptr; context->PSSetShaderResources(0, 1, &nullView);
      if (sharpenDirectlyToBackBuffer) return presentOverlay();
      outputView = rcasSrv.Get();
    }

    D3D11_VIEWPORT outputViewport{static_cast<float>(viewport.left), static_cast<float>(viewport.top),
        static_cast<float>(targetWidth), static_cast<float>(targetHeight), 0, 1};
    context->RSSetState(rasterizer.Get()); context->RSSetViewports(1, &outputViewport);
    context->OMSetRenderTargets(1, backBufferRtv.GetAddressOf(), nullptr);
    context->VSSetShader(vertexShader.Get(), nullptr, 0); context->PSSetShader(pixelShader.Get(), nullptr, 0);
    context->PSSetShaderResources(0, 1, &outputView); context->PSSetSamplers(0, 1, sampler.GetAddressOf());
    const float blitParams[24]{1.0f / targetWidth, 1.0f / targetHeight, 0, 0};
    context->UpdateSubresource(constants.Get(), 0, nullptr, blitParams, 0, 0); context->PSSetConstantBuffers(0, 1, constants.GetAddressOf());
    context->IASetInputLayout(nullptr); context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST); context->Draw(3, 0);
    ID3D11ShaderResourceView* nullView = nullptr; context->PSSetShaderResources(0, 1, &nullView);
    return presentOverlay();
  }

  bool usesMonitor(HWND target) const {
    if (!output || !target) return false;
    DXGI_OUTPUT_DESC desc{};
    return SUCCEEDED(output->GetDesc(&desc)) && desc.Monitor == MonitorFromWindow(target, MONITOR_DEFAULTTONEAREST) &&
        rectEqual(desc.DesktopCoordinates, outputBounds) && desc.Rotation == outputRotation;
  }

  void createOverlay(const RECT& bounds, HWND target, bool asr, bool pacedCapture = false) {
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
    if (pacedCapture) {
      wchar_t statsSetting[2]{};
      captureStatsEnabled = GetEnvironmentVariableW(L"ARC_POWER_CAPTURE_STATS", statsSetting, 2) == 1 && statsSetting[0] == L'1';
      if (captureStatsEnabled) { captureTimings.reserve(4096); captureSubmissionGaps.reserve(4096); }
      // Keep the layered HWND's existing hit-testing behavior. DirectComposition
      // explicitly supports layered targets, while its flip chain avoids the
      // legacy blt copy and exposes admission BEFORE touching the backbuffer.
      ComPtr<IDXGIFactory2> factory2;
      if (FAILED(hr = parentFactory.As(&factory2))) throw hresult_error(hr, L"Query capture swap-chain factory failed");
      DXGI_SWAP_CHAIN_DESC1 desc{};
      desc.Width = width; desc.Height = height; desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
      desc.SampleDesc.Count = 1; desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
      desc.BufferCount = 2; desc.Scaling = DXGI_SCALING_STRETCH;
      desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL; desc.AlphaMode = DXGI_ALPHA_MODE_IGNORE;
      desc.Flags = DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT;
      ComPtr<IDXGISwapChain1> captureSwapChain;
      if (FAILED(hr = factory2->CreateSwapChainForComposition(device.Get(), &desc, nullptr, &captureSwapChain)))
        throw hresult_error(hr, L"Create paced capture swap chain failed");
      if (FAILED(hr = captureSwapChain.As(&swapChain))) throw hresult_error(hr, L"Query capture swap chain failed");
      ComPtr<IDXGISwapChain2> pacedSwapChain;
      if (FAILED(hr = captureSwapChain.As(&pacedSwapChain))) throw hresult_error(hr, L"Query capture frame latency failed");
      if (FAILED(hr = pacedSwapChain->SetMaximumFrameLatency(2))) throw hresult_error(hr, L"Set capture frame latency failed");
      UINT appliedLatency{};
      if (FAILED(hr = pacedSwapChain->GetMaximumFrameLatency(&appliedLatency)) || appliedLatency != 2)
        throw hresult_error(FAILED(hr) ? hr : E_FAIL, L"Verify capture frame latency failed");
      frameLatencyHandle = pacedSwapChain->GetFrameLatencyWaitableObject();
      if (!frameLatencyHandle) throw hresult_error(E_HANDLE, L"Capture frame-latency handle is unavailable");
      frameAdmitted = false;
      if (FAILED(hr = DCompositionCreateDevice(dxgiDevice.Get(), IID_PPV_ARGS(&compositionDevice))))
        throw hresult_error(hr, L"Create capture composition device failed");
      if (FAILED(hr = compositionDevice->CreateTargetForHwnd(overlay, TRUE, &compositionTarget)))
        throw hresult_error(hr, L"Create capture composition target failed");
      if (FAILED(hr = compositionDevice->CreateVisual(&compositionVisual))) throw hresult_error(hr, L"Create capture visual failed");
      if (FAILED(hr = compositionVisual->SetContent(captureSwapChain.Get()))) throw hresult_error(hr, L"Set capture visual content failed");
      if (FAILED(hr = compositionTarget->SetRoot(compositionVisual.Get()))) throw hresult_error(hr, L"Set capture visual root failed");
      if (FAILED(hr = compositionDevice->Commit())) throw hresult_error(hr, L"Commit capture composition failed");
      statusLine("INFO CAPTURE_PRESENT flip-sequential waitable=true maximumFrameLatency=2");
    } else if (FAILED(hr = parentFactory->CreateSwapChain(device.Get(), &sd, &swapChain))) {
      throw hresult_error(hr, L"CreateSwapChain failed");
    }
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
    return completePresentation(swapChain->Present(0, DXGI_PRESENT_DO_NOT_WAIT));
  }

  bool completePresentation(HRESULT hr) {
    if (hr == DXGI_ERROR_WAS_STILL_DRAWING) {
      if (frameLatencyHandle) { ++captureBusy; presentationPending = true; }
      return false;
    }
    if (FAILED(hr)) throw hresult_error(hr, L"Present overlay failed");
    if (frameLatencyHandle) {
      ++capturePresents; frameAdmitted = false; presentationPending = false;
      if (captureStatsEnabled) {
        const auto now = qpc();
        if (lastSubmissionQpc && captureSubmissionGaps.size() < 4096)
          captureSubmissionGaps.push_back(qpcMs(now - lastSubmissionQpc));
        lastSubmissionQpc = now;
      }
    }
    return true;
  }

  bool admitCapturedFrame(DWORD timeoutMs) {
    if (!frameLatencyHandle || frameAdmitted) return true;
    const DWORD result = MsgWaitForMultipleObjectsEx(1, &frameLatencyHandle, timeoutMs,
        QS_ALLINPUT, MWMO_INPUTAVAILABLE);
    if (result == WAIT_FAILED) throw hresult_error(HRESULT_FROM_WIN32(GetLastError()), L"Wait for capture presentation slot failed");
    if (result != WAIT_OBJECT_0) return false;
    // A ready slot remains ours if WGC has no new frame. Do not wait again and
    // consume a second signal until this frame has actually been presented.
    frameAdmitted = true;
    return true;
  }

  void destroyOverlay() noexcept {
    if (captureStatsEnabled && frameLatencyHandle) {
      try {
        statusLine("INFO CAPTURE_SUMMARY renders=" + std::to_string(captureRenders)
            + " presents=" + std::to_string(capturePresents) + " busy=" + std::to_string(captureBusy)
            + " retryAttempts=" + std::to_string(captureRetries));
        reportCaptureTimings();
      } catch (...) {}
    }
    captureStatsEnabled = false;
    captureTimings.clear(); captureSubmissionGaps.clear(); lastCaptureTimestamp = lastSubmissionQpc = 0;
    captureRenders = capturePresents = captureBusy = captureRetries = 0;
    clearMouseForwarding(overlay);
    backBufferRtv.Reset(); cropSrv.Reset(); cropTexture.Reset(); cropFormat = DXGI_FORMAT_UNKNOWN;
    horizontalSrv.Reset(); horizontalRtv.Reset(); horizontalTexture.Reset(); scaledSrv.Reset(); scaledRtv.Reset(); scaledTexture.Reset(); rcasSrv.Reset(); rcasRtv.Reset(); rcasTexture.Reset();
    if (context) context->OMSetRenderTargets(0, nullptr, nullptr);
    compositionVisual.Reset(); compositionTarget.Reset(); compositionDevice.Reset();
    if (frameLatencyHandle) CloseHandle(frameLatencyHandle);
    frameLatencyHandle = nullptr; frameAdmitted = false;
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
    const float params[24]{1.0f / static_cast<float>(sourceWidth), 1.0f / static_cast<float>(sourceHeight), static_cast<float>(percent) / 100.0f, 0};
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
    float params[24]{static_cast<float>(inputWidth), static_cast<float>(inputHeight), static_cast<float>(targetWidth), static_cast<float>(targetHeight), 0,0,0,0};
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
    const float sharpenParams[24]{1.0f / targetWidth, 1.0f / targetHeight, 0, 0};
    context->UpdateSubresource(constants.Get(), 0, nullptr, sharpenParams, 0, 0); context->Draw(3, 0);
    context->PSSetShaderResources(0, 1, &nullView);
    return presentOverlay();
  }
};

// CPU-only regression probe: no device, capture session, window or input hook.
bool nativeCapturePacingProbe() {
  Runtime runtime;
  runtime.frameLatencyHandle = CreateEventW(nullptr, FALSE, TRUE, nullptr);
  if (!runtime.frameLatencyHandle) return false;
  bool valid = runtime.admitCapturedFrame(0) && runtime.frameAdmitted;
  // No source frame arrived: the consumed auto-reset signal must stay latched.
  valid = valid && WaitForSingleObject(runtime.frameLatencyHandle, 0) == WAIT_TIMEOUT
      && runtime.admitCapturedFrame(0);
  valid = valid && !runtime.completePresentation(DXGI_ERROR_WAS_STILL_DRAWING)
      && runtime.presentationPending && runtime.frameAdmitted && runtime.admitCapturedFrame(0);
  valid = valid && runtime.completePresentation(S_OK) && !runtime.presentationPending
      && !runtime.frameAdmitted && !runtime.admitCapturedFrame(0);
  // Successful output cannot be replayed while waiting for a new source frame.
  SetEvent(runtime.frameLatencyHandle);
  valid = valid && runtime.admitCapturedFrame(0) && !runtime.presentationPending;
  runtime.presentationPending = true;
  runtime.destroyOverlay();
  valid = valid && !runtime.frameLatencyHandle && !runtime.frameAdmitted && !runtime.presentationPending;
  valid = valid && !WindowCapture::configureMinUpdateInterval(nullptr, nullptr);
  std::cout << "capture-pacing-probe " << (valid ? "PASS" : "FAIL") << std::endl;
  return valid;
}

HWND matchingForeground(DWORD pid) {
  HWND foreground = GetForegroundWindow();
  if (!foreground) return nullptr;
  HWND root = GetAncestor(foreground, GA_ROOT);
  if (!root) root = foreground;
  DWORD actualPid{}; GetWindowThreadProcessId(root, &actualPid);
  if (actualPid != pid || !IsWindowVisible(root) || IsIconic(root)) return nullptr;
  return root;
}

bool processCreationMatches(DWORD pid, unsigned long long expectedCreation) {
  if (!pid || !expectedCreation) return false;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
  if (!process) return false;
  FILETIME created{}, exited{}, kernel{}, user{};
  const bool read = GetProcessTimes(process, &created, &exited, &kernel, &user) != FALSE;
  const bool alive = WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
  CloseHandle(process);
  const unsigned long long actual = (static_cast<unsigned long long>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
  return read && alive && actual == expectedCreation;
}

bool sameProcessSession(DWORD pid) {
  DWORD targetSession{}, currentSession{};
  return ProcessIdToSessionId(pid, &targetSession) && ProcessIdToSessionId(GetCurrentProcessId(), &currentSession)
      && targetSession == currentSession;
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

bool resolveWindowCaptureClientCrop(HWND target, UINT frameWidth, UINT frameHeight,
    const RECT& clientBounds, UINT& sourceX, UINT& sourceY) {
  const LONG clientWidth = clientBounds.right - clientBounds.left;
  const LONG clientHeight = clientBounds.bottom - clientBounds.top;
  if (!target || clientWidth <= 0 || clientHeight <= 0) return false;
  const auto exactSize = [&](LONG width, LONG height) {
    return width > 0 && height > 0 && frameWidth == static_cast<UINT>(width) && frameHeight == static_cast<UINT>(height);
  };
  if (exactSize(clientWidth, clientHeight)) { sourceX = sourceY = 0; return true; }

  RECT windowBounds{};
  if (GetWindowRect(target, &windowBounds) && exactSize(windowBounds.right - windowBounds.left, windowBounds.bottom - windowBounds.top)) {
    const LONG x = clientBounds.left - windowBounds.left;
    const LONG y = clientBounds.top - windowBounds.top;
    if (x >= 0 && y >= 0 && x + clientWidth <= static_cast<LONG>(frameWidth) && y + clientHeight <= static_cast<LONG>(frameHeight)) {
      sourceX = static_cast<UINT>(x); sourceY = static_cast<UINT>(y); return true;
    }
  }

  RECT visibleBounds{};
  if (SUCCEEDED(DwmGetWindowAttribute(target, DWMWA_EXTENDED_FRAME_BOUNDS, &visibleBounds, sizeof(visibleBounds)))
      && exactSize(visibleBounds.right - visibleBounds.left, visibleBounds.bottom - visibleBounds.top)) {
    const LONG x = clientBounds.left - visibleBounds.left;
    const LONG y = clientBounds.top - visibleBounds.top;
    if (x >= 0 && y >= 0 && x + clientWidth <= static_cast<LONG>(frameWidth) && y + clientHeight <= static_cast<LONG>(frameHeight)) {
      sourceX = static_cast<UINT>(x); sourceY = static_cast<UINT>(y); return true;
    }
  }
  return false;
}

void run(bool readCommandInput = true) {
  Runtime runtime;
  ThumbnailAsrRuntime thumbnailAsr;
  WindowCapture windowCapture;
  HANDLE captureFrameEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!captureFrameEvent) throw hresult_error(HRESULT_FROM_WIN32(GetLastError()), L"Create window-capture frame event failed");
  WNDCLASSW wc{}; wc.lpfnWndProc = overlayProc; wc.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32512)); wc.hInstance = GetModuleHandleW(nullptr); wc.lpszClassName = kOverlayClass;
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
  bool captureGeometryRejected = false;
  auto nextForegroundCheck = std::chrono::steady_clock::time_point::min();
  RECT lastBounds{};
  RECT validatedClientBounds{};
  bool hasValidatedClientBounds = false;

  auto hideOverlay = [&]() {
    hasValidatedClientBounds = false;
    g_cursorTransform.stop();
    runtime.destroyOverlay();
    if (activeAnnounced) { statusLine("IDLE"); activeAnnounced = false; }
  };
  auto resetActive = [&]() {
    windowCapture.stop();
    hideOverlay(); activeWindow = nullptr;
  };

  try {
    while (!g_stop.load()) {
      pumpMessages();
      Command incoming = currentCommand();
      if (incoming.revision != seenRevision) { command = incoming; seenRevision = incoming.revision; resetActive(); thumbnailAsr.reset(); asrGraphicsReset = false; captureGeometryRejected = false; ResetEvent(captureFrameEvent); }
      if ((!command.asr && command.percent <= 0) || command.pid == 0) { resetActive(); thumbnailAsr.reset(); runtime.resetGraphics(); lastBounds = {}; messageAwareDelay(40); continue; }

      if (command.scale) {
        try {
          if (!processCreationMatches(command.pid, command.expectedCreation) || !sameProcessSession(command.pid)) {
            resetActive(); runtime.resetGraphics(); lastBounds = {};
            warning("window scaling target identity ended or changed; waiting for a fresh target selection");
            messageAwareDelay(200); continue;
          }
          HWND foreground = matchingForeground(command.pid);
          if (!foreground) {
            windowCapture.stop();
            hideOverlay(); activeWindow = nullptr;
            messageAwareDelay(40); continue;
          }
          if (foreground != activeWindow || !runtime.usesMonitor(foreground)) {
            windowCapture.stop();
            hideOverlay(); runtime.resetGraphics(); lastBounds = {};
            captureGeometryRejected = false;
            activeWindow = foreground;
            runtime.initializeDevice(foreground, false);
            statusLine("INFO Windows.Graphics.Capture active for selected window; output composition is window-scoped");
          }
          const RECT clientBounds = clientScreenBounds(activeWindow);
          const LONG outputWidth = runtime.outputBounds.right - runtime.outputBounds.left;
          const LONG outputHeight = runtime.outputBounds.bottom - runtime.outputBounds.top;
          const LONG sourceWidth = clientBounds.right - clientBounds.left;
          const LONG sourceHeight = clientBounds.bottom - clientBounds.top;
          RECT clipped{
            (std::max)(clientBounds.left, runtime.outputBounds.left), (std::max)(clientBounds.top, runtime.outputBounds.top),
            (std::min)(clientBounds.right, runtime.outputBounds.right), (std::min)(clientBounds.bottom, runtime.outputBounds.bottom)
          };
          if (sourceWidth <= 0 || sourceHeight <= 0 || clipped.right <= clipped.left || clipped.bottom <= clipped.top
              || !rectEqual(clipped, clientBounds)) {
            windowCapture.stop(); hideOverlay(); lastBounds = {};
            warning("selected window must be fully visible on one display");
            messageAwareDelay(150); continue;
          }
          if (command.asr && (sourceWidth >= outputWidth || sourceHeight >= outputHeight)) {
            windowCapture.stop(); hideOverlay(); lastBounds = {};
            warning("upscaling requires a window smaller than the output display");
            messageAwareDelay(150); continue;
          }
          const RECT overlayBounds = command.asr ? runtime.outputBounds : clientBounds;
          // Stop presenting old geometry immediately, but wait for a valid capture
          // frame before creating a replacement overlay.
          if (runtime.overlay && (!rectEqual(overlayBounds, lastBounds) || runtime.asrMode != command.asr
              || (hasValidatedClientBounds && !rectEqual(clientBounds, validatedClientBounds)))) {
            hideOverlay(); lastBounds = {};
          }
          if (!windowCapture.active()) {
            if (!windowCapture.start(activeWindow, runtime.device.Get(), captureFrameEvent, statusLine))
              throw hresult_error(E_FAIL, L"Windows.Graphics.Capture could not start for the selected window");
            ResetEvent(captureFrameEvent);
          }
          if (runtime.overlay && !runtime.frameAdmitted) {
            runtime.admitCapturedFrame(16);
            // Recheck command, foreground, identity and geometry after waiting.
            // No WGC frame is checked out while the output queue is occupied.
            continue;
          }
          ResetEvent(captureFrameEvent);
          // A busy Present did not consume our admission or backbuffer. Retry
          // that image before submitting any more GPU work; drain to the latest
          // capture only after it is accepted. Otherwise high-rate captures can
          // repeatedly run both shaders while the output remains backpressured.
          WindowCapture::Frame frame;
          if (!runtime.presentationPending) frame = windowCapture.nextFrame(runtime.device.Get());
          bool presented = false;
          if (frame.texture && frame.width && frame.height) {
            UINT sourceX = 0, sourceY = 0;
            if (!resolveWindowCaptureClientCrop(activeWindow, frame.width, frame.height, clientBounds, sourceX, sourceY)) {
              if (!captureGeometryRejected) warning("Windows.Graphics.Capture frame geometry does not match the selected window client area; refusing to scale a misaligned image");
              captureGeometryRejected = true;
              hideOverlay(); lastBounds = {};
              frame.close();
              messageAwareDelay(100);
              continue;
            }
            captureGeometryRejected = false;
            if (!runtime.overlay || !rectEqual(overlayBounds, lastBounds) || runtime.asrMode != command.asr) {
              hideOverlay();
              runtime.createOverlay(overlayBounds, activeWindow, command.asr, true);
              runtime.asrMode = command.asr;
              lastBounds = overlayBounds;
            }
            // The first frame also needs admission, but never retain its WGC
            // surface across a wait. The next iteration acquires a fresh frame.
            if (!runtime.admitCapturedFrame(0)) continue;
            if (command.asr) {
              const float fit = (std::min)(static_cast<float>(outputWidth) / sourceWidth, static_cast<float>(outputHeight) / sourceHeight);
              const LONG scaledWidth = (std::max)(1L, static_cast<LONG>(sourceWidth * fit));
              const LONG scaledHeight = (std::max)(1L, static_cast<LONG>(sourceHeight * fit));
              runtime.viewport = RECT{(outputWidth - scaledWidth) / 2, (outputHeight - scaledHeight) / 2,
                  (outputWidth - scaledWidth) / 2 + scaledWidth, (outputHeight - scaledHeight) / 2 + scaledHeight};
              // The transformed physical pointer resides inside the original
              // source window, which can lie outside the enlarged viewport.
              runtime.setOverlayHitRegion(RECT{0, 0, outputWidth, outputHeight});
              g_mouse.game = activeWindow; g_mouse.gamePid = command.pid; g_mouse.viewport = runtime.viewport;
              g_mouse.viewport.left += runtime.outputBounds.left; g_mouse.viewport.right += runtime.outputBounds.left;
              g_mouse.viewport.top += runtime.outputBounds.top; g_mouse.viewport.bottom += runtime.outputBounds.top;
              g_mouse.sourceWidth = static_cast<UINT>(sourceWidth); g_mouse.sourceHeight = static_cast<UINT>(sourceHeight);
              if (g_cursorTransform.active() && !g_cursorTransform.matches(runtime.overlay, activeWindow, command.pid, clientBounds, g_mouse.viewport)) {
                g_cursorTransform.stop();
              }
            } else {
              runtime.viewport = RECT{0, 0, static_cast<LONG>(runtime.width), static_cast<LONG>(runtime.height)};
              g_mouse.game = nullptr; g_mouse.gamePid = 0; g_mouse.viewport = {}; g_mouse.sourceWidth = g_mouse.sourceHeight = 0;
            }
            validatedClientBounds = clientBounds;
            hasValidatedClientBounds = true;
            const auto beforeRender = runtime.captureStatsEnabled ? Runtime::qpc() : 0;
            presented = runtime.renderCapturedWindow(frame.texture.Get(), sourceX, sourceY,
                static_cast<UINT>(sourceWidth), static_cast<UINT>(sourceHeight), command.asr, command.percent);
            if (runtime.captureStatsEnabled) runtime.recordCaptureTiming(frame.timestamp100ns, beforeRender, Runtime::qpc());
            runtime.presentationPending = !presented;
            frame.close();
          } else if (runtime.presentationPending) {
            // Retry only a rejected present, never a previously displayed frame.
            ++runtime.captureRetries;
            presented = runtime.presentOverlay();
            runtime.presentationPending = !presented;
          }
          if (presented) {
              const bool needsCursorArm = command.asr && !g_cursorTransform.active();
              if (needsCursorArm && !g_cursorTransform.captureCursor()) {
                warning("could not capture the game cursor; stopping the selected window overlay");
                hideOverlay(); messageAwareDelay(500); continue;
              }
              runtime.showOverlay();
              if (needsCursorArm &&
                  !g_cursorTransform.arm(runtime.overlay, activeWindow, command.pid, clientBounds, g_mouse.viewport)) {
                warning("scaled cursor transform could not start; stopping the selected window overlay");
                hideOverlay(); messageAwareDelay(500); continue;
              }
            if (!activeAnnounced && runtime.overlayVisible) {
              statusLine("ACTIVE " + std::to_string(command.pid) + " SCALE"); activeAnnounced = true;
            }
          } else if (!frame.texture) {
            MsgWaitForMultipleObjectsEx(1, &captureFrameEvent, runtime.presentationPending ? 2 : 16,
                QS_ALLINPUT, MWMO_INPUTAVAILABLE);
            pumpMessages();
          }
        } catch (const hresult_error& e) {
          warning("window capture/scaling failed (HRESULT " + std::to_string(static_cast<unsigned long>(e.code().value)) + "): " + to_string(e.message()));
          windowCapture.stop(); hideOverlay(); runtime.resetGraphics(); activeWindow = nullptr; lastBounds = {};
          messageAwareDelay(500);
        }
        continue;
      }

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
          g_mouse.game = activeWindow; g_mouse.gamePid = command.pid; g_mouse.viewport = runtime.viewport;
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
  CloseHandle(captureFrameEvent);
}

} // namespace

int wmain(int argc, wchar_t** argv) {
  try {
    if (argc == 2 && std::wstring_view(argv[1]) == L"--help") {
      std::wcout << L"ArcPower.ScreenSharpen: stdin commands SCALE <pid> <creation-filetime> <0|1> <0-100>, SET <pid> <0-100>, ASR <...>, or STOP. Test probes: --probe-command-parser, --probe-mouse-mapping, --probe-mouse-dispatcher, --probe-fsr-shader.\n";
      return 0;
    }
    if (argc == 2 && std::wstring_view(argv[1]) == L"--probe-command-parser") return nativeCommandParserProbe() ? 0 : 1;
    if (argc == 2 && std::wstring_view(argv[1]) == L"--probe-capture-pacing") return nativeCapturePacingProbe() ? 0 : 1;
    if (argc == 2 && std::wstring_view(argv[1]) == L"--probe-mouse-mapping") return nativeMouseMappingProbe() ? 0 : 1;
    if (argc == 2 && std::wstring_view(argv[1]) == L"--probe-cursor-transform") return CursorTransform::probe() ? 0 : 1;
    if (argc == 2 && std::wstring_view(argv[1]) == L"--probe-mouse-dispatcher") return nativeMouseDispatcherProbe() ? 0 : 1;
    if (argc == 2 && std::wstring_view(argv[1]) == L"--probe-fsr-shader") return fsrShaderCompileProbe() ? 0 : 1;
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
