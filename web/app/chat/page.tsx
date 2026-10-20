import type { Metadata } from "next";
import { siteName } from "@/app/lib/siteName";
import { ChatWindow } from "@/app/features/chat";
import { historyViewer, latestChatHistory } from "@/app/api/chat/history/route";
import { CHAT_LIVE_CAP } from "@/app/lib/chatCaps";
import { manifestWithin } from "@/app/api/emotes/route";
import { emotesUsedBy } from "@/app/lib/emoteSubset";

export const metadata: Metadata = { title: `Chat · ${siteName()}`, robots: { index: false, follow: false } };

// The broadcaster's own chat WINDOW — not an OBS source; that is /overlay/chat.
// Pauses when scrolled up, loads earlier history, behaves like the site chat.
// ?scale=1.5 (default) — multiply the base font size to size the whole window.
// The newest page of history is read here, on the server, so the window opens
// with its rows already on the page (chatHistorySeed.test.ts).
export default async function ChatWindowPage({
  searchParams,
}: {
  searchParams: Promise<{ scale?: string }>;
}) {
  const [{ scale }, viewer] = await Promise.all([searchParams, historyViewer()]);
  const scaleFactor = Math.min(4, Math.max(0.5, parseFloat(scale ?? "1.5") || 1.5));
  const messages = await latestChatHistory(viewer, CHAT_LIVE_CAP).catch(() => []);
  // The emotes those rows use, so they render as <img>s in the HTML and the
  // browser fetches them before any script runs (emoteSubset.ts).
  const initialEmotes = emotesUsedBy(messages.map((m) => m.message), await manifestWithin().catch(() => ({})));
  return <ChatWindow scaleFactor={scaleFactor} initialMessages={messages} initialEmotes={initialEmotes} />;
}
