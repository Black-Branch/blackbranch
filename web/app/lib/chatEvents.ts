// New chat lines, offered to whoever listens — the terminal's hooks (on_say,
// on_mention) and its live files (/srv/chat, /var/mail). The
// chat list publishes each live line it would show (never history, never a
// hidden person), with its own verdict on whether the line tags the viewer, so
// chat and terminal always agree; it also publishes the buffer it holds. Like
// chatSender.ts: pure, no React.
import type { ChatMsg } from "./chatMsg";

type Listener = (m: ChatMsg, mentionsMe: boolean) => void;
const listeners = new Set<Listener>();

/** How many published lines are kept for /var/mail since the page loaded. */
const RING = 300;
const recent: { m: ChatMsg; mentionsMe: boolean }[] = [];
let buffer: readonly ChatMsg[] = [];

/** The chat list saw a new live line it shows. */
export function publishChatMessage(m: ChatMsg, mentionsMe: boolean): void {
  recent.push({ m, mentionsMe });
  while (recent.length > RING) recent.shift();
  for (const l of listeners) l(m, mentionsMe);
}

/** Hear every new line while subscribed. Returns the unsubscribe. */
// @parked plugin API: a site plugin's console beside the chat reads or drives the chat through it
export function onChatMessage(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** The last 300 lines published since the page loaded, oldest first, each with its verdict. */
// @parked plugin API: a site plugin's console beside the chat reads or drives the chat through it
export const chatLog = (): readonly { m: ChatMsg; mentionsMe: boolean }[] => recent;

/** The chat list's buffer as it shows it to the viewer (hidden people already left out). */
export function publishChatBuffer(msgs: readonly ChatMsg[]): void { buffer = msgs; }
// @parked plugin API: a site plugin's console beside the chat reads or drives the chat through it
export const liveChatBuffer = (): readonly ChatMsg[] => buffer;

// Your OWN sends from the chat box: published after the send went, with where it went as the
// chat TUI's typing line names it — the terminal's on_send hook hears them. `say` and the chat TUI
// never come this way (the TUI tells the terminal itself; `say` is no send that fires on_send).
type SendListener = (text: string, where: string) => void;
const sendListeners = new Set<SendListener>();

/** The chat box sent a line (it went). */
export function publishOwnSend(text: string, where: string): void {
  for (const l of sendListeners) l(text, where);
}

/** Hear your own chat-box sends while subscribed. Returns the unsubscribe. */
// @parked plugin API: a site plugin's console beside the chat reads or drives the chat through it
export function onOwnSend(l: SendListener): () => void {
  sendListeners.add(l);
  return () => { sendListeners.delete(l); };
}
