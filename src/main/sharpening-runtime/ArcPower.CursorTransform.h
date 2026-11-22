#pragma once

// ASR cursor coordinates are maintained in physical pixels on this helper's
// per-monitor-v2 thread. The OS pointer remains in the game's source client;
// a separate, click-through sprite marks its position in the enlarged view.
class CursorTransform {
  static constexpr wchar_t kSpriteClass[] = L"ArcPowerScaledCursorV1";
  static constexpr UINT kRedraw = WM_APP + 72;
  inline static CursorTransform* current_{};
  HWND overlay_{}, target_{}, sprite_{};
  DWORD pid_{};
  RECT source_{}, viewport_{};
  POINT visual_{}, mapped_{};
  double preciseX_{}, preciseY_{};
  HHOOK hook_{};
  HCURSOR shape_{};
  HCURSOR capturedShape_{};
  bool cursorCaptured_{};
  int width_{32}, height_{32}, hotspotX_{}, hotspotY_{};
  bool active_{}, redrawPending_{}, warping_{};

  static bool valid(const RECT& r) { return r.right > r.left && r.bottom > r.top; }
  static bool contains(const RECT& r, POINT p) { return p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom; }
  static bool shouldHandle(bool active, bool warping, bool injected, bool foreground) {
    return active && !warping && !injected && foreground;
  }
  static LONG transformAxis(LONG value, LONG origin, LONG extent, LONG destinationOrigin, LONG destinationExtent) {
    const auto clamped = (std::clamp)(value - origin, 0L, extent - 1);
    return destinationOrigin + static_cast<LONG>((static_cast<long long>(clamped) * destinationExtent) / extent);
  }
  static POINT mapPoint(POINT p, const RECT& from, const RECT& to) {
    return {transformAxis(p.x, from.left, from.right - from.left, to.left, to.right - to.left),
            transformAxis(p.y, from.top, from.bottom - from.top, to.top, to.bottom - to.top)};
  }
  // Black/white renders recover premultiplied color and alpha. Reject XOR pixels,
  // which cannot be represented by a background-independent alpha sprite.
  static bool alphaPixel(DWORD black, DWORD white, DWORD& output) {
    int alpha = -1;
    for (int shift = 0; shift <= 16; shift += 8) {
      const int b = (black >> shift) & 255, w = (white >> shift) & 255;
      const int a = 255 - (w - b);
      if (a < 0 || a > 255 || b > a) return false;
      if (alpha < 0) alpha = a;
      else if (std::abs(alpha - a) > 2) return false;
      else alpha = (std::max)(alpha, a);
    }
    output = (static_cast<DWORD>(alpha) << 24) | (black & 0x00ffffff);
    return true;
  }
  static LRESULT CALLBACK spriteProc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
    if (message == WM_NCHITTEST) return HTTRANSPARENT;
    return DefWindowProcW(hwnd, message, wparam, lparam);
  }
  bool updateSpriteImage() {
    if (!sprite_ || !shape_ || width_ < 1 || height_ < 1) return false;
    BITMAPINFO info{}; info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = width_; info.bmiHeader.biHeight = -height_;
    info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
    HDC screen = GetDC(nullptr); if (!screen) return false;
    HDC blackDC = CreateCompatibleDC(screen), whiteDC = CreateCompatibleDC(screen);
    void *blackBits = nullptr, *whiteBits = nullptr;
    HBITMAP blackBitmap = CreateDIBSection(screen, &info, DIB_RGB_COLORS, &blackBits, nullptr, 0);
    HBITMAP whiteBitmap = CreateDIBSection(screen, &info, DIB_RGB_COLORS, &whiteBits, nullptr, 0);
    bool ok = false;
    if (blackDC && whiteDC && blackBitmap && whiteBitmap && blackBits && whiteBits) {
      HGDIOBJ oldBlack = SelectObject(blackDC, blackBitmap), oldWhite = SelectObject(whiteDC, whiteBitmap);
      if (oldBlack && oldBlack != HGDI_ERROR && oldWhite && oldWhite != HGDI_ERROR) {
        RECT rect{0, 0, width_, height_};
        FillRect(blackDC, &rect, static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));
        FillRect(whiteDC, &rect, static_cast<HBRUSH>(GetStockObject(WHITE_BRUSH)));
        if (DrawIconEx(blackDC, 0, 0, shape_, width_, height_, 0, nullptr, DI_NORMAL) &&
            DrawIconEx(whiteDC, 0, 0, shape_, width_, height_, 0, nullptr, DI_NORMAL)) {
          GdiFlush(); auto* blacks = static_cast<DWORD*>(blackBits); auto* whites = static_cast<DWORD*>(whiteBits);
          ok = true;
          for (int i = 0; i < width_ * height_; ++i) {
            DWORD pixel{}; if (!alphaPixel(blacks[i], whites[i], pixel)) { ok = false; break; }
            blacks[i] = pixel;
          }
          if (ok) {
            POINT destination{visual_.x - hotspotX_, visual_.y - hotspotY_}, origin{0, 0};
            SIZE size{width_, height_}; BLENDFUNCTION blend{AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
            ok = UpdateLayeredWindow(sprite_, screen, &destination, &size, blackDC, &origin, 0, &blend, ULW_ALPHA) != FALSE;
          }
        }
      }
      if (oldBlack && oldBlack != HGDI_ERROR) SelectObject(blackDC, oldBlack);
      if (oldWhite && oldWhite != HGDI_ERROR) SelectObject(whiteDC, oldWhite);
    }
    if (blackBitmap) DeleteObject(blackBitmap); if (whiteBitmap) DeleteObject(whiteBitmap);
    if (blackDC) DeleteDC(blackDC); if (whiteDC) DeleteDC(whiteDC); ReleaseDC(nullptr, screen);
    return ok;
  }
  static LRESULT CALLBACK mouseProc(int code, WPARAM message, LPARAM data) {
    auto* state = current_;
    if (code == HC_ACTION && state &&
        (message == WM_MOUSEMOVE || message == WM_LBUTTONDOWN || message == WM_LBUTTONUP ||
         message == WM_RBUTTONDOWN || message == WM_RBUTTONUP || message == WM_MBUTTONDOWN ||
         message == WM_MBUTTONUP || message == WM_XBUTTONDOWN || message == WM_XBUTTONUP ||
         message == WM_MOUSEWHEEL || message == WM_MOUSEHWHEEL)) {
      const auto* event = reinterpret_cast<const MSLLHOOKSTRUCT*>(data);
      if (event && shouldHandle(state->active_, state->warping_, (event->flags & LLMHF_INJECTED) != 0, GetForegroundWindow() == state->target_)) {
        DWORD actualPid{};
        if (!state->active_ || !IsWindow(state->target_) || GetAncestor(state->target_, GA_ROOT) != state->target_ ||
            !GetWindowThreadProcessId(state->target_, &actualPid) || actualPid != state->pid_ ||
            GetForegroundWindow() != state->target_)
          return CallNextHookEx(state->hook_, code, message, data);
        const LONG dx = event->pt.x - state->mapped_.x;
        const LONG dy = event->pt.y - state->mapped_.y;
        // Keep real source motion proportional to physical mouse movement.
        const auto sw = state->source_.right - state->source_.left;
        const auto sh = state->source_.bottom - state->source_.top;
        const auto vw = state->viewport_.right - state->viewport_.left;
        const auto vh = state->viewport_.bottom - state->viewport_.top;
        state->preciseX_ = (std::clamp)(state->preciseX_ + static_cast<double>(dx) * vw / sw,
            static_cast<double>(state->viewport_.left), static_cast<double>(state->viewport_.right - 1));
        state->preciseY_ = (std::clamp)(state->preciseY_ + static_cast<double>(dy) * vh / sh,
            static_cast<double>(state->viewport_.top), static_cast<double>(state->viewport_.bottom - 1));
        state->visual_.x = static_cast<LONG>(state->preciseX_);
        state->visual_.y = static_cast<LONG>(state->preciseY_);
        state->mapped_ = mapPoint(state->visual_, state->viewport_, state->source_);
        if (event->pt.x != state->mapped_.x || event->pt.y != state->mapped_.y) {
          if (state->active_ && GetForegroundWindow() == state->target_) {
            state->warping_ = true; SetCursorPos(state->mapped_.x, state->mapped_.y); state->warping_ = false;
          }
        }
        if (state->overlay_ && !state->redrawPending_) {
          state->redrawPending_ = PostMessageW(state->overlay_, kRedraw, 0, 0) != FALSE;
        }
      }
    }
    return CallNextHookEx(state ? state->hook_ : nullptr, code, message, data);
  }
  void moveSprite() {
    if (!sprite_) return;
    SetWindowPos(sprite_, HWND_TOPMOST, visual_.x - hotspotX_, visual_.y - hotspotY_, width_, height_, SWP_NOACTIVATE | SWP_SHOWWINDOW);
  }
 public:
  ~CursorTransform() { stop(); }
  bool active() const { return active_; }
  // Capture before showing the overlay, whose cursor handler changes the cursor.
  bool captureCursor() {
    if (capturedShape_) { DestroyCursor(capturedShape_); capturedShape_ = nullptr; }
    cursorCaptured_ = false;
    CURSORINFO info{sizeof(info)};
    if (!GetCursorInfo(&info)) return false;
    if (info.flags & CURSOR_SHOWING) {
      if (!info.hCursor) return false;
      capturedShape_ = reinterpret_cast<HCURSOR>(CopyIcon(info.hCursor));
      if (!capturedShape_) return false;
    }
    cursorCaptured_ = true;
    return true;
  }
  bool matches(HWND overlay, HWND target, DWORD pid, const RECT& source, const RECT& viewport) const {
    return active_ && overlay_ == overlay && target_ == target && pid_ == pid &&
        EqualRect(&source_, &source) && EqualRect(&viewport_, &viewport);
  }
  bool handleRedraw(UINT message) {
    if (message != kRedraw) return false;
    redrawPending_ = false; if (active_) moveSprite(); return true;
  }
  bool arm(HWND overlay, HWND target, DWORD pid, const RECT& source, const RECT& viewport) {
    if (active_) return true;
    DWORD actual{}; if (!cursorCaptured_ || !overlay || !target || !pid || !valid(source) || !valid(viewport) ||
        GetForegroundWindow() != target || !GetWindowThreadProcessId(target, &actual) || actual != pid) return false;
    POINT original{}; if (!GetCursorPos(&original)) return false;
    overlay_ = overlay; target_ = target; pid_ = pid; source_ = source; viewport_ = viewport;
    visual_ = contains(source_, original) ? mapPoint(original, source_, viewport_)
        : contains(viewport_, original) ? original
        : POINT{viewport_.left + (viewport_.right - viewport_.left) / 2,
                viewport_.top + (viewport_.bottom - viewport_.top) / 2};
    mapped_ = mapPoint(visual_, viewport_, source_);
    preciseX_ = visual_.x; preciseY_ = visual_.y;
    shape_ = capturedShape_; capturedShape_ = nullptr; cursorCaptured_ = false;
    if (shape_) {
      ICONINFO icon{};
      if (!GetIconInfo(shape_, &icon)) { stop(); return false; }
      {
        BITMAP bitmap{}; const HBITMAP image = icon.hbmColor ? icon.hbmColor : icon.hbmMask;
        const bool bitmapValid = image && GetObjectW(image, sizeof(bitmap), &bitmap) && bitmap.bmWidth > 0 && bitmap.bmHeight > 0;
        if (bitmapValid) {
          const int sourceHeight = icon.hbmColor ? bitmap.bmHeight : bitmap.bmHeight / 2;
          const double sx = static_cast<double>(viewport.right - viewport.left) / (source.right - source.left);
          const double sy = static_cast<double>(viewport.bottom - viewport.top) / (source.bottom - source.top);
          width_ = (std::clamp)(static_cast<int>(bitmap.bmWidth * sx), 1, 128);
          height_ = (std::clamp)(static_cast<int>(sourceHeight * sy), 1, 128);
          hotspotX_ = static_cast<int>(icon.xHotspot * sx); hotspotY_ = static_cast<int>(icon.yHotspot * sy);
        }
        if (icon.hbmColor) DeleteObject(icon.hbmColor); if (icon.hbmMask) DeleteObject(icon.hbmMask);
        if (!bitmapValid) { stop(); return false; }
      }
      if (shape_) {
        WNDCLASSW wc{}; wc.lpfnWndProc = spriteProc; wc.hInstance = GetModuleHandleW(nullptr); wc.lpszClassName = kSpriteClass;
        if (!RegisterClassW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) { stop(); return false; }
        sprite_ = CreateWindowExW(WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
            kSpriteClass, L"", WS_POPUP, 0, 0, width_, height_, nullptr, nullptr, wc.hInstance, this);
        if (!sprite_ || !updateSpriteImage()) { stop(); return false; }
        SetWindowDisplayAffinity(sprite_, WDA_EXCLUDEFROMCAPTURE);
      }
    }
    current_ = this;
    hook_ = SetWindowsHookExW(WH_MOUSE_LL, mouseProc, GetModuleHandleW(nullptr), 0);
    if (!hook_) { current_ = nullptr; stop(); return false; }
    active_ = true;
    warping_ = true; const bool positioned = SetCursorPos(mapped_.x, mapped_.y) != FALSE; warping_ = false;
    if (!positioned) { active_ = false; stop(); return false; }
    moveSprite(); return true;
  }
  void stop() noexcept {
    const bool wasActive = active_; active_ = false;
    if (hook_) { UnhookWindowsHookEx(hook_); hook_ = nullptr; }
    if (current_ == this) current_ = nullptr;
    if (sprite_) { DestroyWindow(sprite_); sprite_ = nullptr; }
    if (shape_) { DestroyCursor(shape_); shape_ = nullptr; }
    if (capturedShape_) { DestroyCursor(capturedShape_); capturedShape_ = nullptr; }
    cursorCaptured_ = false;
    DWORD actualPid = 0;
    const bool targetValid = target_ && IsWindow(target_) && GetAncestor(target_, GA_ROOT) == target_ &&
        GetWindowThreadProcessId(target_, &actualPid) && actualPid == pid_;
    if (wasActive && targetValid && GetForegroundWindow() == target_) SetCursorPos(visual_.x, visual_.y);
    if (targetValid && GetForegroundWindow() == target_) PostMessageW(target_, WM_SETCURSOR, reinterpret_cast<WPARAM>(target_), MAKELPARAM(HTCLIENT, WM_MOUSEMOVE));
    overlay_ = nullptr; target_ = nullptr; pid_ = 0; redrawPending_ = false; warping_ = false;
  }
  static bool probe() {
    const RECT src{100, 200, 1380, 920}, dst{0, 0, 1920, 1080};
    const POINT mid = mapPoint(POINT{960, 540}, dst, src);
    const POINT corner = mapPoint(POINT{1919, 1079}, dst, src);
    const POINT reverse = mapPoint(mid, src, dst);
    const RECT letterbox{-1920, 200, 0, 1280};
    const POINT start = mapPoint(POINT{-1920, 200}, letterbox, src);
    const POINT outside = mapPoint(POINT{-2500, 1500}, letterbox, src);
    CursorTransform unarmed;
    DWORD transparent{}, opaque{}, translucent{}, invalid{};
    const bool alphaOk = alphaPixel(0x00000000, 0x00ffffff, transparent) && transparent == 0 &&
        alphaPixel(0x00123456, 0x00123456, opaque) && opaque == 0xff123456 &&
        alphaPixel(0x00402010, 0x00bf9f8f, translucent) && translucent == 0x80402010 &&
        !alphaPixel(0x00ffffff, 0x00000000, invalid);
    return alphaOk && mid.x == 740 && mid.y == 560 && corner.x == 1379 && corner.y == 919 && reverse.x == 960 && reverse.y == 540 &&
        start.x == 100 && start.y == 200 && outside.x == 100 && outside.y == 919 &&
        !unarmed.active() && !unarmed.matches(nullptr, nullptr, 0, src, dst) &&
        shouldHandle(true, false, false, true) && !shouldHandle(true, true, false, true) &&
        !shouldHandle(true, false, true, true) && !shouldHandle(true, false, false, false);
  }
};
CursorTransform g_cursorTransform;
