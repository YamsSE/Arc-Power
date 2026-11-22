// The runtime package is isolated under src-tauri/frontend-deps so the
// compatibility Electron build does not acquire a second application runtime.
declare module '@tauri-apps/api/core' {
  export function invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
}
declare module '@tauri-apps/api/event' {
  export type UnlistenFn = () => void;
  export function listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<UnlistenFn>;
}
