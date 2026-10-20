// A Chat history row as GET /api/mod/chat-history returns it. Pure types +
// the one fetch both the mod panel's Chat history and the user card's message details use.
import { getJson } from "./http.ts";

export type HistMsg = {
  id: number; platform: string; username: string; message: string;
  canonicalId: string | null; matrixId: string | null; deleted: boolean;
  ts: number; cts: string;
  /** A site message: the platforms it was also posted to. A platform message: its own platform. */
  destPlatforms: string[];
  replyTo: { username: string; text: string } | null;
  /** The product's per-message score columns; which ones are SHOWN is the plugin's to declare. */
  scores: { karma: number | null; intelligence: number | null };
  /** The platform's own emotes in this message, name → image (live chat's `msg.emotes`). */
  emotes?: Record<string, string> | null;
};

export type HistCursor = { beforeTs: string; beforePlatform: string; beforeId: string };

/** One message by its id + platform, or null (not found / not a mod / network). */
export async function fetchHistMessage(platform: string, id: string | number): Promise<HistMsg | null> {
  const qs = new URLSearchParams({ platform, id: String(id), limit: "1" });
  const d = await getJson<{ messages: HistMsg[] }>(`/api/mod/chat-history?${qs}`).catch(() => null);
  return d?.messages[0] ?? null;
}
