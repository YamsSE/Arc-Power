// Arc Power - M144 recording/replay status pill renderer.

import { api } from './ipc.ts';
import { recordingPillView } from './pure/overlay.ts';
import type { RecordingEngineState } from './types.ts';

let recordingState: RecordingEngineState | null = null;
const root = document.getElementById('recording-status-pill') as HTMLElement;
const label = document.getElementById('status-label') as HTMLElement;
const elapsed = document.getElementById('status-elapsed') as HTMLElement;

function render(): void {
  const view = recordingPillView(recordingState);
  root.hidden = !view.visible;
  root.classList.toggle('recording', view.visible && view.kind === 'recording');
  root.classList.toggle('replay', view.visible && view.kind === 'replay');
  // The Arc Power mark carries the brand; keep the adjacent status chip
  // deliberately short so the indicator reads at a glance in a game.
  label.textContent = view.visible ? view.kind === 'recording' ? 'REC' : 'REPLAY' : '';
  elapsed.textContent = view.visible ? view.elapsed : '';
}

// M143: capture transitions come from the main-owned engine event, not an
// action-result guess; this preserves simultaneous recording/replay state.
api.onRecordingStateUpdated((state) => {
  recordingState = state ?? null;
  render();
});

// M143: only the displayed elapsed value is refreshed locally once per second.
window.setInterval(render, 1000);
render();
