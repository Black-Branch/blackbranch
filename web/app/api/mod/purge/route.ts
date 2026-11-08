import { randomUUID } from "node:crypto";
import pool from "@/lib/db";
import { requireMod, assertCanModerate, assertCanModerateAccount } from "@/app/lib/admin";
import { NextRequest } from "next/server";
import { runPurge } from "@/app/lib/modPurge";
import { purgeDeps } from "@/app/lib/modPurgeServer";
import { siteAccountsOf } from "@/app/lib/canonicalIdentity";
import { parsePurgeRequest } from "@/app/lib/modRequests";

// Bounded purge: flag a user's recent messages deleted everywhere at once.
// Native rows are flagged here (site.chat_messages is ours to write); the
// stream.chat_log flags + the single {type:'purge'} broadcast happen in
// stream-api via POST /chat/purge; platform-side removal fans out best-effort
// (Twitch 1s timeout, Kick/YouTube per-message deletes).
//
// Caps (modPurge.ts): window ≤ 24h (in minutes — `/purge x 10m` reaches back ten minutes), ≤250 native
// + ≤250 platform rows per purge — one WS frame, one pass. A prolific spammer may need a second purge.

export async function POST(req: NextRequest) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  // Target is a matrix id, OR a canonical stream id (12-hex): a platform-only chatter, or a linked
  // person named from one of their platform lines (app/lib/modPurge.ts handles both shapes).
  // The body's shape is shared with every client (modRequests.ts).
  const body = await req.json().catch(() => null);
  const parsed = parsePurgeRequest(body);
  if (!parsed) return new Response("Bad Request", { status: 400 });
  const { targetId, windowMinutes } = parsed;

  // Privilege ceiling: a non-admin mod may not purge the owner's messages,
  // whether named by matrix id or by the owner's linked platform canonical.
  const denied = await assertCanModerate(mod, targetId);
  if (denied) return denied;

  // A canonical is expanded into its site accounts exactly as the ban route does it
  // (canonicalIdentity.ts siteAccountsOf): a linked person's site lines go with their platform lines.
  // A failed read refuses (503) rather than purge less than the mod asked for.
  let accounts: string[];
  try {
    accounts = await siteAccountsOf(targetId, (sql, params) => pool.query<{ matrix_id: string }>(sql, params));
  } catch {
    return new Response("Moderation check unavailable — try again shortly", { status: 503, headers: { "Retry-After": "5" } });
  }

  // The purge reaches every identity of every one of those accounts (purgeLines): the ceiling covers
  // each account AND every canonical linked to it, so a canonical shared with a moderator's, Staff's or
  // the owner's account is refused (403) before anything is flagged; an undecidable check is 503.
  for (const account of accounts) {
    const refused = await assertCanModerateAccount(mod, account);
    if (refused) return refused;
  }

  const batchId = randomUUID();
  // The purge itself (modPurge.ts runPurge, shared with the ban route): the lines flagged, ONE
  // {type:'purge'} frame through stream-api, one mod-log row, then the platforms (Twitch 1s timeout,
  // Kick/YouTube per-message deletes, the purged site lines' cross-posted copies).
  const { purged } = await runPurge(purgeDeps(mod, targetId), { targetId, accounts, windowMinutes, batchId });
  return Response.json({ ok: true, batchId, purged });
}
