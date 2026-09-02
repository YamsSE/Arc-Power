// Arc Power - M146 recording/replay status indicator renderer.

import { api } from './ipc.ts';
import { recordingPillView } from './pure/overlay.ts';
import type { RecordingEngineState } from './types.ts';

let recordingState: RecordingEngineState | null = null;
const root = document.getElementById('recording-status-pill') as HTMLElement;

function render(): void {
  const view = recordingPillView(recordingState);
  root.hidden = !view.visible;
  root.classList.toggle('recording', view.visible && view.kind === 'recording');
  root.classList.toggle('replay', view.visible && view.kind === 'replay');
}

// M143: capture transitions come from the main-owned engine event, not an
// action-result guess; this preserves simultaneous recording/replay state.
api.onRecordingStateUpdated((state) => {
  recordingState = state ?? null;
  render();
});

render();
