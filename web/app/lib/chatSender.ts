// The chat box's send path, offered to a terminal plugin so it can send chat
// messages. ChatInput provides it; the terminal's `say` calls it. One slot — the last chat box mounted is the one
// the page is showing. Pure: no React, no DOM.

/** `redact`: send as a whole-message redaction (the TUI's `/redact`). */
type Sender = (text: string, opts?: { redact?: boolean }) => Promise<void>;

let sender: Sender | null = null;

/** ChatInput offers its send path. Returns a release for THIS sender. */
export function provideChatSender(s: Sender): () => void {
  sender = s;
  return () => { if (sender === s) sender = null; };
}

/** Send a line as a chat message. Null when it went; otherwise why not. */
// @parked plugin API: a console beside the chat (the owner plugin's terminal, app/(owner)/_terminal) reads or drives the chat through it
export async function sendToChat(text: string, opts?: { redact?: boolean }): Promise<string | null> {
  if (!sender) return "there's no chat on this page to send to";
  try {
    await sender(text, opts);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Failed to send.";
  }
}

// Where the chat box sends right now — its Send-to destination (`forcedDest`; null = the site).
// The terminal's chat TUI shows it in its typing line and follows a click on the button:
// `say` and the TUI send through the box above, so this is where they go.
let dest: string | null = null;
const destListeners = new Set<() => void>();

/** ChatInput publishes its destination. */
export function setChatDest(d: string | null): void {
  if (dest === d) return;
  dest = d;
  for (const fn of destListeners) fn();
}

/** The chat box's destination now. */
// @parked plugin API: a console beside the chat (the owner plugin's terminal, app/(owner)/_terminal) reads or drives the chat through it
export const chatDest = (): string | null => dest;

/** Told when the destination changes. */
// @parked plugin API: a console beside the chat (the owner plugin's terminal, app/(owner)/_terminal) reads or drives the chat through it
export function onChatDest(fn: () => void): () => void {
  destListeners.add(fn);
  return () => { destListeners.delete(fn); };
}
