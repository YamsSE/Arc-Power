// User-facing recording messages stay independent of the bundled runtime's
// internal product name.

export function recordingMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/ascent(?:-obs)?/gi, 'recording engine');
}
