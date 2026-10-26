#pragma once

#include <windows.h>
#include <dwmapi.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <vector>
#include <utility>

// DWM owns composition for this path. It deliberately has no D3D device,
// duplication surface, input interception, or presentation loop.
class ThumbnailAsrRuntime {
  using Clock = std::chrono::steady_clock;
  HWND host_{};
  HTHUMBNAIL thumbnail_{};
  bool classRegistered_{};
  HANDLE process_{};
  DWORD pid_{};
  FILETIME created_{};
  unsigned long long expectedCreation_{};
  HWND source_{};
  HWND associatedSource_{};
  HMONITOR monitor_{};
  RECT window_{}, client_{};
  DXGI_ADAPTER_DESC1 adapter_{};
  DXGI_OUTPUT_DESC output_{};
  unsigned long long revision_{};
  Clock::time_point nextOutputCheck_{};
  Clock::time_point nextWarning_{};
  Clock::time_point nextHostAttempt_{};
  bool cleanupRetryPending_{};
  bool invalidRevision_{};
  static constexpr wchar_t className_[] = L"ArcPowerThumbnailAsrHostV1";
  static LRESULT CALLBACK windowProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_CLOSE) { ShowWindow(h, SW_HIDE); return 0; }
    return DefWindowProcW(h, m, w, l);
  }
  void warn(const char* message) {
    const auto now = Clock::now();
    if (now >= nextWarning_) { warning(message); nextWarning_ = now + std::chrono::seconds(5); }
  }
  bool destroyHost() {
    if (host_ && IsWindow(host_)) ShowWindow(host_, SW_HIDE);
    if (thumbnail_) {
      HRESULT hr = DwmUnregisterThumbnail(thumbnail_);
      if (FAILED(hr)) hr = DwmUnregisterThumbnail(thumbnail_);
      if (FAILED(hr)) { warn("ASR cleanup failed; retrying safely"); cleanupRetryPending_=true; nextHostAttempt_=Clock::now()+std::chrono::milliseconds(500); return false; }
      else thumbnail_ = nullptr;
    }
    if (host_) { if (!DestroyWindow(host_)) { warn("ASR cleanup failed; retrying safely"); cleanupRetryPending_=true; nextHostAttempt_=Clock::now()+std::chrono::milliseconds(500); return false; } host_ = nullptr; }
    if (classRegistered_) { if (!UnregisterClassW(className_, GetModuleHandleW(nullptr))) { warn("ASR cleanup failed; retrying safely"); cleanupRetryPending_=true; nextHostAttempt_=Clock::now()+std::chrono::milliseconds(500); return false; } classRegistered_ = false; }
    cleanupRetryPending_=false;
    return true;
  }
  void clearTarget() {
    const bool cleaned=destroyHost(); source_ = nullptr; monitor_ = nullptr; window_ = {}; client_ = {};
    ZeroMemory(&adapter_, sizeof(adapter_)); ZeroMemory(&output_, sizeof(output_));
  }
  void resetCommand() { clearTarget(); if(process_) { CloseHandle(process_); process_=nullptr; } pid_=0; associatedSource_=nullptr; expectedCreation_=0; }
  bool processAlive() const {
    if (!process_ || WaitForSingleObject(process_, 0) != WAIT_TIMEOUT) return false;
    FILETIME c{}, e{}, k{}, u{};
    return GetProcessTimes(process_, &c, &e, &k, &u) && c.dwLowDateTime == created_.dwLowDateTime && c.dwHighDateTime == created_.dwHighDateTime;
  }
  static BOOL CALLBACK findForeground(HWND h, LPARAM lp) {
    auto* pair = reinterpret_cast<std::pair<DWORD, HWND*>*>(lp);
    DWORD owner{}; GetWindowThreadProcessId(h, &owner);
    if (owner == pair->first && GetAncestor(h, GA_ROOT) == h && IsWindowVisible(h) && !IsIconic(h)) {
      *pair->second = h;
      return FALSE;
    }
    return TRUE;
  }
  bool findSource(DWORD pid, HWND& hwnd) {
    hwnd = nullptr;
    HWND fg = GetForegroundWindow(); DWORD owner{}; GetWindowThreadProcessId(fg, &owner);
    if (owner == pid && GetAncestor(fg, GA_ROOT) == fg) hwnd = fg;
    else { std::pair<DWORD, HWND*> p{pid, &hwnd}; EnumWindows(findForeground, reinterpret_cast<LPARAM>(&p)); }
    return hwnd && GetForegroundWindow() == hwnd;
  }
  static bool sameSession(DWORD pid) {
    DWORD a{}, b{}; return ProcessIdToSessionId(pid, &a) && ProcessIdToSessionId(GetCurrentProcessId(), &b) && a == b;
  }
  bool geometry(HWND source, RECT& wr, RECT& cr, HMONITOR& mon) {
    RECT c{}; POINT a{}, b{};
    if (!GetWindowRect(source, &wr) || !GetClientRect(source, &c)) return false;
    a = {c.left,c.top}; b = {c.right,c.bottom};
    if (!ClientToScreen(source,&a) || !ClientToScreen(source,&b)) return false;
    cr = {a.x,a.y,b.x,b.y};
    if (cr.right<=cr.left || cr.bottom<=cr.top) return false;
    mon = MonitorFromWindow(source, MONITOR_DEFAULTTONULL);
    MONITORINFO mi{sizeof(mi)};
    if (!mon || !GetMonitorInfoW(mon,&mi) || cr.left<mi.rcMonitor.left || cr.top<mi.rcMonitor.top || cr.right>mi.rcMonitor.right || cr.bottom>mi.rcMonitor.bottom) return false;
    if (cr.right-cr.left >= mi.rcMonitor.right-mi.rcMonitor.left || cr.bottom-cr.top >= mi.rcMonitor.bottom-mi.rcMonitor.top) return false;
    return true;
  }
  bool outputFor(HMONITOR mon, DXGI_OUTPUT_DESC& od, DXGI_ADAPTER_DESC1& ad) {
    Microsoft::WRL::ComPtr<IDXGIFactory1> f;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&f)))) return false;
    for (UINT ai=0;;++ai) {
      Microsoft::WRL::ComPtr<IDXGIAdapter1> a; HRESULT hr=f->EnumAdapters1(ai,&a); if(hr==DXGI_ERROR_NOT_FOUND) break; if(FAILED(hr)) return false;
      DXGI_ADAPTER_DESC1 d{}; if(FAILED(a->GetDesc1(&d))) return false; if(d.VendorId!=0x8086) continue;
      for(UINT oi=0;;++oi) {
        Microsoft::WRL::ComPtr<IDXGIOutput> o; hr=a->EnumOutputs(oi,&o); if(hr==DXGI_ERROR_NOT_FOUND) break; if(FAILED(hr)) return false;
        DXGI_OUTPUT_DESC x{}; if(FAILED(o->GetDesc(&x))) return false;
        if(x.Monitor==mon && x.AttachedToDesktop) { od=x; ad=d; return true; }
      }
    }
    return false;
  }
  bool outputEligible() {
    DXGI_OUTPUT_DESC od{}; DXGI_ADAPTER_DESC1 ad{};
    if(!outputFor(monitor_,od,ad) || ad.AdapterLuid.HighPart!=adapter_.AdapterLuid.HighPart || ad.AdapterLuid.LowPart!=adapter_.AdapterLuid.LowPart ||
       _wcsicmp(od.DeviceName,output_.DeviceName)!=0 || od.Rotation!=output_.Rotation || !EqualRect(&od.DesktopCoordinates,&output_.DesktopCoordinates)) return false;
    UINT32 pc{},mc{}; if(GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS,&pc,&mc)!=ERROR_SUCCESS || !pc) return false;
    std::vector<DISPLAYCONFIG_PATH_INFO> paths(pc); std::vector<DISPLAYCONFIG_MODE_INFO> modes(mc);
    if(QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS,&pc,paths.data(),&mc,modes.data(),nullptr)!=ERROR_SUCCESS) return false;
    for(UINT32 i=0;i<pc;i++) {
      auto& t=paths[i].targetInfo;
      if(t.adapterId.HighPart!=ad.AdapterLuid.HighPart || t.adapterId.LowPart!=ad.AdapterLuid.LowPart) continue;
      DISPLAYCONFIG_SOURCE_DEVICE_NAME n{}; n.header.type=DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME; n.header.size=sizeof(n); n.header.adapterId=paths[i].sourceInfo.adapterId; n.header.id=paths[i].sourceInfo.id;
      if(DisplayConfigGetDeviceInfo(&n.header)!=ERROR_SUCCESS) return false;
      if(_wcsicmp(n.viewGdiDeviceName,od.DeviceName)!=0) continue;
      DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO c{}; c.header.type=DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO; c.header.size=sizeof(c); c.header.adapterId=t.adapterId; c.header.id=t.id;
      return DisplayConfigGetDeviceInfo(&c.header)==ERROR_SUCCESS && !c.advancedColorEnabled;
    }
    return false;
  }
  bool makeHost(HWND source, HMONITOR mon, const RECT& client) {
    MONITORINFO mi{sizeof(mi)}; if(!GetMonitorInfoW(mon,&mi)) return false;
    WNDCLASSEXW wc{sizeof(wc)}; wc.lpfnWndProc=windowProc; wc.hInstance=GetModuleHandleW(nullptr); wc.hCursor=LoadCursorW(nullptr,MAKEINTRESOURCEW(32512)); wc.lpszClassName=className_;
    if(!RegisterClassExW(&wc)) { if(GetLastError()!=ERROR_CLASS_ALREADY_EXISTS) return false; }
    classRegistered_=true;
    DWORD ex=WS_EX_TOPMOST|WS_EX_NOACTIVATE|WS_EX_TRANSPARENT|WS_EX_TOOLWINDOW|WS_EX_LAYERED;
    host_=CreateWindowExW(ex,className_,L"",WS_POPUP,mi.rcMonitor.left,mi.rcMonitor.top,mi.rcMonitor.right-mi.rcMonitor.left,mi.rcMonitor.bottom-mi.rcMonitor.top,nullptr,nullptr,wc.hInstance,nullptr);
    if(!host_ || !SetLayeredWindowAttributes(host_,0,255,LWA_ALPHA) || !SetWindowDisplayAffinity(host_,WDA_NONE)) return false;
    DWORD aff=~0u; if(!GetWindowDisplayAffinity(host_,&aff) || aff!=WDA_NONE) return false;
    if(!SetWindowPos(host_,HWND_TOPMOST,mi.rcMonitor.left,mi.rcMonitor.top,mi.rcMonitor.right-mi.rcMonitor.left,mi.rcMonitor.bottom-mi.rcMonitor.top,SWP_NOACTIVATE|SWP_SHOWWINDOW) || GetForegroundWindow()!=source) return false;
    HRESULT hr=DwmRegisterThumbnail(host_,source,&thumbnail_); if(FAILED(hr)||!thumbnail_) return false;
    SIZE sz{}; if(FAILED(DwmQueryThumbnailSourceSize(thumbnail_,&sz)) || sz.cx<=0 || sz.cy<=0) return false;
    LONG w=mi.rcMonitor.right-mi.rcMonitor.left,h=mi.rcMonitor.bottom-mi.rcMonitor.top;
    const LONG sw=client.right-client.left, sh=client.bottom-client.top;
    double scale=(std::min)(double(w)/sw,double(h)/sh); LONG vw=LONG(sw*scale),vh=LONG(sh*scale);
    DWM_THUMBNAIL_PROPERTIES p{}; p.dwFlags=DWM_TNP_RECTDESTINATION|DWM_TNP_OPACITY|DWM_TNP_VISIBLE|DWM_TNP_SOURCECLIENTAREAONLY;
    p.rcDestination={(w-vw)/2,(h-vh)/2,(w-vw)/2+vw,(h-vh)/2+vh}; p.opacity=255;p.fVisible=TRUE;p.fSourceClientAreaOnly=TRUE;
    return SUCCEEDED(DwmUpdateThumbnailProperties(thumbnail_,&p)) && SUCCEEDED(DwmFlush()) && IsWindowVisible(host_);
  }
 public:
  ~ThumbnailAsrRuntime(){ resetCommand(); }
  void reset() { resetCommand(); revision_=0; invalidRevision_=false; }
  bool tick(DWORD pid, unsigned long long revision, unsigned long long expectedCreation) {
    if(revision!=revision_) { resetCommand(); revision_=revision; expectedCreation_=expectedCreation; invalidRevision_=false; }
    if(cleanupRetryPending_) {
      if(Clock::now()<nextHostAttempt_) return false;
      if(!destroyHost()) return false;
    }
    if(!pid || invalidRevision_) { clearTarget(); return false; }
    if(!expectedCreation || expectedCreation_!=expectedCreation) { clearTarget(); invalidRevision_=true; warn("ASR requires a valid bound process creation time"); return false; }
    HWND source{};
    if(!process_) {
      process_=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,pid); pid_=pid;
      FILETIME exit{},kernel{},user{};
      if(!process_ || !GetProcessTimes(process_,&created_,&exit,&kernel,&user)) { resetCommand(); invalidRevision_=true; warn("ASR could not bind process identity"); return false; }
      const unsigned long long actualCreation=(static_cast<unsigned long long>(created_.dwHighDateTime)<<32)|created_.dwLowDateTime;
      if(actualCreation!=expectedCreation_) { resetCommand(); invalidRevision_=true; warn("ASR process identity did not match the supplied creation time"); return false; }
    }
    if(pid_!=pid || !processAlive()) { clearTarget(); invalidRevision_=true; warn("ASR process identity ended; waiting for a new command"); return false; }
    if(!sameSession(pid) || !findSource(pid,source)) { destroyHost(); source_=nullptr; warn("ASR is waiting for the exact foreground window and eligible output"); return false; }
    if(associatedSource_ && associatedSource_!=source) {
      if(!destroyHost()) return false;
      source_=nullptr;
      associatedSource_=source;
      nextHostAttempt_=Clock::now()+std::chrono::milliseconds(500);
      warn("ASR foreground window changed; revalidating before reconnecting");
      return false;
    }
    if(!associatedSource_) associatedSource_=source;
    RECT wr{},cr{}; HMONITOR mon{};
    if(!geometry(source,wr,cr,mon)) { clearTarget(); warn("ASR source window is not fully eligible"); return false; }
    bool changed=source_!=source || monitor_!=mon || !EqualRect(&wr,&window_) || !EqualRect(&cr,&client_);
    if(changed && !destroyHost()) return false;
    if(!thumbnail_) {
      if(Clock::now()<nextHostAttempt_) return false;
      source_=source; monitor_=mon; window_=wr; client_=cr;
      if(!outputFor(mon,output_,adapter_) || !outputEligible()) { clearTarget(); nextHostAttempt_=Clock::now()+std::chrono::milliseconds(500); warn("ASR requires an attached Intel SDR output"); return false; }
      if(!makeHost(source,mon,cr)) { destroyHost(); nextHostAttempt_=Clock::now()+std::chrono::milliseconds(500); warn("ASR DWM thumbnail setup failed"); return false; }
      nextOutputCheck_=Clock::now()+std::chrono::milliseconds(250);
    } else if(Clock::now()>=nextOutputCheck_) {
      nextOutputCheck_=Clock::now()+std::chrono::milliseconds(250);
      if(!outputEligible()) { clearTarget(); nextHostAttempt_=Clock::now()+std::chrono::milliseconds(500); warn("ASR output eligibility changed"); return false; }
    }
    if(GetForegroundWindow()!=source || !IsWindowVisible(host_) || IsIconic(host_)) { clearTarget(); return false; }
    return true;
  }
};
