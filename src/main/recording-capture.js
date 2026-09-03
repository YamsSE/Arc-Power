import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeRecordingCaptureTarget } from './recording-pure.js';

const execFileAsync = promisify(execFile);
const MAX_CAPTURE_TARGETS_BYTES = 2 * 1024 * 1024;

// The bundled monitor source expects the native HMONITOR value, not
// Electron's display.id. The small read-only query below gives us both the
// stable \SDD-style monitor name for persistence and the current native
// handle/dimensions for Ascent-OBS.
const WINDOWS_CAPTURE_QUERY = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class ArcPowerCaptureNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MONITORINFOEX {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
  }

  public sealed class DisplayTarget {
    public string id;
    public string label;
    public uint handle;
    public int x;
    public int y;
    public int width;
    public int height;
    public bool primary;
  }

  public sealed class WindowTarget {
    public uint handle;
    public string titleBase64;
    public string processName;
    public int x;
    public int y;
    public int width;
    public int height;
  }

  public sealed class CaptureTargets {
    public List<DisplayTarget> displays = new List<DisplayTarget>();
    public List<WindowTarget> windows = new List<WindowTarget>();
  }

  public delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, ref RECT rect, IntPtr data);
  public delegate bool WindowEnumProc(IntPtr hwnd, IntPtr data);

  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);
  [DllImport("user32.dll")] static extern bool EnumWindows(WindowEnumProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

  static string WindowTitle(IntPtr hwnd) {
    int length = GetWindowTextLength(hwnd);
    if (length <= 0) return string.Empty;
    var text = new StringBuilder(length + 1);
    GetWindowText(hwnd, text, text.Capacity);
    return text.ToString().Trim();
  }

  public static CaptureTargets GetTargets() {
    var result = new CaptureTargets();
    // The callback's RECT argument is passed by reference by Win32. Keep the
    // ref marker on the lambda as well; PowerShell's Add-Type compiler rejects
    // the otherwise implicit callback parameter on current .NET runtimes.
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr monitor, IntPtr hdc, ref RECT rect, IntPtr data) => {
      var info = new MONITORINFOEX();
      info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
      if (!GetMonitorInfo(monitor, ref info)) return true;
      int width = info.rcMonitor.Right - info.rcMonitor.Left;
      int height = info.rcMonitor.Bottom - info.rcMonitor.Top;
      if (width <= 1 || height <= 1 || string.IsNullOrWhiteSpace(info.szDevice)) return true;
      uint nativeHandle = unchecked((uint)monitor.ToInt64());
      result.displays.Add(new DisplayTarget {
        id = info.szDevice.Trim(),
        label = info.szDevice.Trim() + " " + width + "x" + height,
        handle = nativeHandle,
        x = info.rcMonitor.Left,
        y = info.rcMonitor.Top,
        width = width,
        height = height,
        primary = (info.dwFlags & 1u) != 0,
      });
      return true;
    }, IntPtr.Zero);

    EnumWindows((hwnd, data) => {
      if (!IsWindow(hwnd) || !IsWindowVisible(hwnd)) return true;
      string title = WindowTitle(hwnd);
      if (string.IsNullOrWhiteSpace(title)) return true;
      RECT rect;
      if (!GetWindowRect(hwnd, out rect)) return true;
      int width = rect.Right - rect.Left;
      int height = rect.Bottom - rect.Top;
      if (width <= 1 || height <= 1) return true;
      uint processId;
      GetWindowThreadProcessId(hwnd, out processId);
      string processName = string.Empty;
      try { processName = Process.GetProcessById((int)processId).ProcessName + ".exe"; } catch { }
      result.windows.Add(new WindowTarget {
        handle = unchecked((uint)hwnd.ToInt64()),
        // PowerShell 5's ConvertTo-Json can emit a quote in a reflected
        // Add-Type string without escaping it. Base64 keeps the native query
        // valid for every window title; the Node side decodes it for display.
        titleBase64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(title)),
        processName = processName,
        x = rect.Left,
        y = rect.Top,
        width = width,
        height = height,
      });
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
'@
[ArcPowerCaptureNative]::GetTargets() | ConvertTo-Json -Compress -Depth 5
`;

function boundedString(value, fallback = '', max = 512) {
  return typeof value === 'string' && value.length <= max ? value.trim() : fallback;
}

function safeHandle(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff ? value : 0;
}

function normalizeDisplayTarget(value) {
  const item = value && typeof value === 'object' ? value : {};
  const width = Number.isFinite(item.width) && item.width > 1 ? Math.round(item.width) : 0;
  const height = Number.isFinite(item.height) && item.height > 1 ? Math.round(item.height) : 0;
  const id = boundedString(item.id, '', 128);
  if (!id || !width || !height) return null;
  return {
    id,
    label: boundedString(item.label, `${id} ${width}×${height}`, 256),
    handle: safeHandle(item.handle),
    x: Number.isFinite(item.x) ? Math.round(item.x) : 0,
    y: Number.isFinite(item.y) ? Math.round(item.y) : 0,
    width,
    height,
    primary: item.primary === true,
    hdr: item.hdr === true,
  };
}

function normalizeWindowTarget(value) {
  const item = value && typeof value === 'object' ? value : {};
  const handle = safeHandle(item.handle);
  let title = boundedString(item.title, '', 512);
  if (!title && typeof item.titleBase64 === 'string') {
    try {
      title = boundedString(Buffer.from(item.titleBase64, 'base64').toString('utf8'), '', 512);
    } catch {
      title = '';
    }
  }
  const width = Number.isFinite(item.width) && item.width > 1 ? Math.round(item.width) : 0;
  const height = Number.isFinite(item.height) && item.height > 1 ? Math.round(item.height) : 0;
  if (!handle || !title || !width || !height) return null;
  return {
    handle,
    title,
    processName: boundedString(item.processName, '', 256),
    x: Number.isFinite(item.x) ? Math.round(item.x) : 0,
    y: Number.isFinite(item.y) ? Math.round(item.y) : 0,
    width,
    height,
  };
}

export function parseRecordingCaptureTargets(output) {
  const raw = output && typeof output === 'object' && !Buffer.isBuffer(output) && 'stdout' in output ? output.stdout : output;
  let parsed;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw.trim()) : raw; } catch { parsed = {}; }
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  return {
    displays: (Array.isArray(source.displays) ? source.displays : []).map(normalizeDisplayTarget).filter(Boolean),
    windows: (Array.isArray(source.windows) ? source.windows : []).map(normalizeWindowTarget).filter(Boolean),
  };
}

export function isHdrDisplay(display = {}) {
  const colorSpace = String(display.colorSpace ?? '').toLowerCase();
  if (/(scrgb|bt2020|2100|pq|hlg|hdr)/i.test(colorSpace)) return true;
  return Number(display.depthPerComponent) >= 10 && Number(display.colorDepth) >= 30;
}

export function mergeRecordingDisplayMetadata(targets, electronDisplays = []) {
  const displays = Array.isArray(electronDisplays) ? electronDisplays : [];
  if (!displays.length) return targets;
  const unused = new Set(displays);
  const match = (native) => {
    const exact = [...unused].find((display) => {
      const scale = Number.isFinite(display.scaleFactor) && display.scaleFactor > 0 ? display.scaleFactor : 1;
      const bounds = display.bounds ?? {};
      const size = display.size ?? {};
      return Math.round((bounds.x ?? 0) * scale) === native.x
        && Math.round((bounds.y ?? 0) * scale) === native.y
        && Math.round((size.width ?? 0) * scale) === native.width
        && Math.round((size.height ?? 0) * scale) === native.height;
    });
    const fallback = exact ?? [...unused].find((display) => {
      const scale = Number.isFinite(display.scaleFactor) && display.scaleFactor > 0 ? display.scaleFactor : 1;
      const size = display.size ?? {};
      return Math.round((size.width ?? 0) * scale) === native.width && Math.round((size.height ?? 0) * scale) === native.height;
    });
    if (fallback) unused.delete(fallback);
    return fallback;
  };
  return {
    displays: targets.displays.map((native) => {
      const display = match(native);
      return display ? { ...native, hdr: isHdrDisplay(display) } : native;
    }),
    windows: targets.windows,
  };
}

export async function listRecordingCaptureTargets({ execFileImpl = execFileAsync, platform = process.platform } = {}) {
  if (platform !== 'win32') return { displays: [], windows: [] };
  const result = await execFileImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_CAPTURE_QUERY], {
    windowsHide: true,
    maxBuffer: MAX_CAPTURE_TARGETS_BYTES,
  });
  return parseRecordingCaptureTargets(result);
}

function primaryDisplay(targets) {
  return targets.displays.find((display) => display.primary) ?? targets.displays[0] ?? null;
}

export function recordingCaptureSelection(rawTarget, targets = { displays: [], windows: [] }, fallbackDisplay = null) {
  const target = normalizeRecordingCaptureTarget(rawTarget);
  const displays = Array.isArray(targets.displays) ? targets.displays : [];
  const windows = Array.isArray(targets.windows) ? targets.windows : [];
  if (target.type === 'window') {
    const selectedWindow = windows.find((item) => item.handle === target.windowHandle);
    if (selectedWindow) {
      return {
        captureTarget: { ...target, windowHandle: selectedWindow.handle, processName: selectedWindow.processName, windowTitle: selectedWindow.title },
        captureWidth: selectedWindow.width,
        captureHeight: selectedWindow.height,
        captureSource: { type: 'window', windowHandle: selectedWindow.handle },
        captureHdr: false,
      };
    }
  }
  const selectedDisplay = target.type === 'display'
    ? (target.displayId === 'primary' ? primaryDisplay({ displays }) : displays.find((item) => item.id === target.displayId))
    : null;
  const display = selectedDisplay ?? primaryDisplay({ displays });
  if (display) {
    return {
      captureTarget: { type: 'display', displayId: display.id, windowHandle: 0, processName: '', windowTitle: '' },
      captureWidth: display.width,
      captureHeight: display.height,
      captureSource: { type: 'display', monitorHandle: display.handle },
      captureHdr: display.hdr === true,
    };
  }
  const width = Number.isFinite(fallbackDisplay?.size?.width) && fallbackDisplay.size.width > 1 ? Math.round(fallbackDisplay.size.width * (fallbackDisplay.scaleFactor || 1)) : 1920;
  const height = Number.isFinite(fallbackDisplay?.size?.height) && fallbackDisplay.size.height > 1 ? Math.round(fallbackDisplay.size.height * (fallbackDisplay.scaleFactor || 1)) : 1080;
  return {
    // A saved window handle can disappear between launches. Never send that
    // stale handle to ascent-obs: fall back to a real display source so a
    // missing window cannot produce a centered/blank capture.
    captureTarget: { type: 'display', displayId: 'primary', windowHandle: 0, processName: '', windowTitle: '' },
    captureWidth: width,
    captureHeight: height,
    captureSource: { type: 'display', monitorHandle: 0 },
    captureHdr: isHdrDisplay(fallbackDisplay ?? {}),
  };
}

export function recordingCaptureTargetLabel(target, targets = { displays: [], windows: [] }) {
  const normalized = normalizeRecordingCaptureTarget(target);
  if (normalized.type === 'window') {
    const window = (targets.windows ?? []).find((item) => item.handle === normalized.windowHandle);
    return window ? `${window.title} · ${window.processName || 'Window'}` : normalized.windowTitle || 'Selected window unavailable';
  }
  const display = normalized.displayId === 'primary'
    ? primaryDisplay(targets)
    : (targets.displays ?? []).find((item) => item.id === normalized.displayId);
  return display?.label ?? (normalized.displayId === 'primary' ? 'Primary display' : `${normalized.displayId} (saved)`);
}
