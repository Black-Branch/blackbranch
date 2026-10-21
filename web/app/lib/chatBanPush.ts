// A ban or unban, pushed to stream-api the moment it is written. SERVER ONLY.
//
// stream-api's POST /chat/ban is what hides a banned PLATFORM chatter's lines from the
// site within a second: without a push, nothing carries a site ban to the chat path at all, so a
// banned Kick spammer's lines keep showing for seconds. Best-effort with a 2 s bound — the ban itself is
// already written; posting the same ban twice is harmless (stream-api treats it as a set).

import { streamApiFetch } from "./streamApi.ts";

export type ChatBanBody =
  | { canonicalId: string; expiresAt: string | null; lift?: true }
  | { matrixIds: string[]; canonicalId?: string; expiresAt: string | null; lift?: true };

/** The body for a ban/unban. `matrixIds` = the site accounts the action reached ([] = a
 *  platform-only chatter, named by `canonicalId`). null when there is nothing to name. Pure. */
export function chatBanBody(a: { matrixIds: string[]; canonicalId: string | null; expiresAt: string | null; lift: boolean }): ChatBanBody | null {
  const lift = a.lift ? { lift: true as const } : {};
  if (a.matrixIds.length > 0) {
    return { matrixIds: a.matrixIds, ...(a.canonicalId ? { canonicalId: a.canonicalId } : {}), expiresAt: a.lift ? null : a.expiresAt, ...lift };
  }
  if (a.canonicalId) return { canonicalId: a.canonicalId, expiresAt: a.lift ? null : a.expiresAt, ...lift };
  return null;
}

/** POST it to stream-api. Never throws; resolves either way within ~2 s. */
export async function pushChatBan(body: ChatBanBody | null): Promise<void> {
  if (!body) return;
  await streamApiFetch("/chat/ban", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2000),
  }).catch(() => null);
}
