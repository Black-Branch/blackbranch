import { ChatOverlay } from "@/app/features/chat";
import { historyViewer, latestChatHistory } from "@/app/api/chat/history/route";
import { CHAT_OVERLAY_CAP } from "@/app/lib/chatCaps";
import { manifestWithin } from "@/app/api/emotes/route";
import { emotesUsedBy } from "@/app/lib/emoteSubset";

// OBS browser source — transparent background, no nav, bottom-anchored chat
// that always follows the newest message. (/chat is the streamer's own chat
// window — see app/chat/page.tsx.)
// ?scale=1.5 (default) — multiply the base font size. Use in the OBS URL to resize.
// The newest rows and their emotes are read here, on the server, so the source
// paints with chat already on it (chatHistorySeed.test.ts, emotePreload.test.ts).
export default async function ChatOverlayPage({
  searchParams,
}: {
  searchParams: Promise<{ scale?: string }>;
}) {
  const [{ scale }, viewer] = await Promise.all([searchParams, historyViewer()]);
  const scaleFactor = Math.min(4, Math.max(0.5, parseFloat(scale ?? "1.5") || 1.5));
  const messages = await latestChatHistory(viewer, CHAT_OVERLAY_CAP).catch(() => []);
  const initialEmotes = emotesUsedBy(messages.map((m) => m.message), await manifestWithin().catch(() => ({})));
  return <ChatOverlay scaleFactor={scaleFactor} initialMessages={messages} initialEmotes={initialEmotes} />;
}
