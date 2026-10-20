// A mod deletes one chat line (POST /api/mod/delete). SERVER ONLY; dependency-free so `node --test`
// can run it — the route hands it the pool, the ceiling and the side effects.
//
// The line's id is normalised ONCE (modTargets.ts normalizeMessageId) and that one value goes to the
// author lookup, the ceiling, the site flag, stream-api, the mod log and the platform fan-out. A
// malformed id is a 400 before anything is read or written.

import { isNativePlatform } from "./nativePlatform.ts";
import { messageAuthor, normalizeMessageId, type TargetQuery } from "./modTargets.ts";

export type ModDeleteDeps = {
  query: TargetQuery;
  /** The moderation ceiling (admin.ts assertCanModerate): a Response refuses. */
  ceiling: (mod: string, target: string) => Promise<Response | null>;
  deleteNative: (mod: string, id: number) => Promise<void>;
  streamDelete: (messageId: string, platform: string) => Promise<unknown>;
  log: (target: string) => Promise<unknown>;
  fanOut: (messageId: string, platform: string) => void;
};

export async function modDeleteMessage(mod: string, platform: unknown, rawId: unknown, deps: ModDeleteDeps): Promise<Response> {
  const id = normalizeMessageId(rawId);
  if (!id || typeof platform !== "string" || !platform) return new Response("Bad Request", { status: 400 });

  // Privilege ceiling on the line's AUTHOR: a mod never deletes an admin's or another mod's line
  // (their own is fine). Only a well-formed id that finds no line names nobody; a failed read
  // refuses (503).
  let author: string | null;
  try {
    author = await messageAuthor(platform, id, deps.query);
  } catch {
    return new Response("Moderation check unavailable — try again shortly", { status: 503, headers: { "Retry-After": "5" } });
  }
  if (author) {
    const denied = await deps.ceiling(mod, author);
    if (denied) return denied;
  }

  // Native site messages broadcast with the site's own platform id (their
  // site.chat_messages id) — full site-side delete: persistence flag, WS
  // broadcast, mod log, cross-posted copies. Shared with the automod resolve
  // route (deleteSiteMessageEverywhere).
  if (isNativePlatform(platform)) {
    await deps.deleteNative(mod, Number(id));
    return new Response("OK");
  }

  // Platform messages (twitch/kick/…) are flagged in stream.chat_log by stream-api's /chat/delete.
  await deps.streamDelete(id, platform);
  // Deletes were the one mod action missing from site.mod_log. Target is the message key.
  await deps.log(`${platform}:${id}`);
  // Best-effort fan-out: also remove the message on the originating platform (fire-and-forget).
  deps.fanOut(id, platform);
  return new Response("OK");
}
