// Renderer-side GPU memory presentation shared by the Dashboard, Monitoring,
// and overlay surfaces. Byte values remain bytes at the IPC boundary; only
// this layer turns them into the user's one-decimal decimal-GB display.

export type GpuMemorySource = 'dedicated' | 'shared' | null | undefined;

/** A usable GPU-memory byte count. Zero is kept as an unavailable reading. */
export function isUsableGpuMemoryBytes(bytes: unknown): bytes is number {
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0;
}

/** Format bytes as exactly one decimal decimal-GB value, or '-' when absent. */
export function formatGpuMemoryGb(bytes: number | null | undefined): string {
  return isUsableGpuMemoryBytes(bytes) ? (bytes / 1e9).toFixed(1) : '-';
}

/** The user-facing label for a GPU-memory reading's source. */
export function gpuMemoryLabel(source: GpuMemorySource): 'VRAM' | 'Shared GPU Memory' {
  return source === 'shared' ? 'Shared GPU Memory' : 'VRAM';
}
