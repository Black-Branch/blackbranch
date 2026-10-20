// Cross-component handoff for the feed's "Suggest" button → the Matrix New Post
// modal. The feed (which may be in the video column or the chat panel) stashes the
// item and dispatches an event; ChatSidebar switches to the Matrix tab and MatrixView
// opens the New Post modal in the Content forum room, pre-filled. The module-level
// holder survives the race where MatrixView mounts only after the event fires.
export type PendingSuggestion = { title: string; link: string };

export const SUGGEST_EVENT = "bb:suggest-content";

let pending: PendingSuggestion | null = null;

export function requestSuggestion(s: PendingSuggestion) {
  pending = s;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SUGGEST_EVENT));
}

// Read-and-clear: whichever consumer (MatrixView) gets here first takes it.
export function takePendingSuggestion(): PendingSuggestion | null {
  const p = pending;
  pending = null;
  return p;
}
