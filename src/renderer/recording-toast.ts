import type { RecordingNotification } from './types.ts';
import { api } from './ipc.ts';

const root = document.getElementById('recording-toast') as HTMLElement | null;
const title = document.getElementById('recording-toast-title') as HTMLElement | null;
const message = document.getElementById('recording-toast-message') as HTMLElement | null;

api.onRecordingNotification((notification: RecordingNotification) => {
  if (!root || !title || !message) return;
  root.dataset.variant = notification.variant;
  title.textContent = notification.title;
  message.textContent = notification.message;
  root.hidden = false;
});
