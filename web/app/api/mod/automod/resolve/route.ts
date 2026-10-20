import pool from "@/lib/db";
import { requireMod } from "@/app/lib/admin";
import { getBroadcasterToken } from "@/app/lib/platformMod/shared";
import { twitchClientId } from "@/app/lib/twitch";
import { streamApiFetch } from "@/app/lib/streamApi";
import { deleteSiteMessageEverywhere } from "@/app/lib/siteMessageDelete";
import { NextRequest } from "next/server";
import { sameOriginRequest } from "@/app/lib/instanceAdminView";
import { isNativePlatform } from "@/app/lib/nativePlatform";

const SCOPE_AUTOMOD = "moderator:manage:automod";

// POST { id, action: "allow" | "deny" } — resolve a review row.
//
// Keyed on the ROW id, not the Twitch message id. Blocklist rows have no
// Twitch message — keying on `twitch_msg_id` would make them unresolvable,
// and give every one of them the same null React key.
//
// Sources and behaviours:
//   • twitch    — call Helix to actually allow/deny the held message. The call
//                 MUST run as the broadcaster (the API requires user_id ==
//                 token's user); resolved_by still records the mod who clicked.
//   • everything else — our own rows; no external service involved. PENDING
//                 rows are genuinely withheld messages, so Allow must DELIVER
//                 (see the release block below for the native/platform split);
//                 BLOCKED rows (severity-4 words, platform relays) were never
//                 deliverable and resolving just clears them. Requiring a
//                 Twitch token for any of this would make our own queue
//                 unusable whenever the broadcaster link lapsed.
export async function POST(req: NextRequest) {
  // A mutation by a mod's session: only from this site's own pages (defence in depth on top of
  // the SameSite cookie). Only staff resolve a hold — a sender can never release their own.
  if (!sameOriginRequest(req.headers)) return Response.json({ error: "cross-site request refused" }, { status: 403 });
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const body = await req.json().catch(() => null);
  const rowId = Number(body?.id);
  const action = body?.action;
  if (!Number.isInteger(rowId) || (action !== "allow" && action !== "deny")) {
    return new Response("Bad Request", { status: 400 });
  }

  const { rows: found } = await pool.query<{
    twitch_msg_id: string | null; source: string; status: string;
    platform: string | null; user_id: string | null; user_name: string | null; text: string;
    matrix_id: string | null; site_msg_id: number | null;
  }>(
    `SELECT twitch_msg_id, source, status, platform, user_id, user_name, text, matrix_id, site_msg_id
       FROM site.automod_held WHERE id = $1`,
    [rowId]
  );
  const row = found[0];
  if (!row) return new Response("Not Found", { status: 404 });
  const msgId = row.twitch_msg_id;

  // Our own rows: no external call, just close the row out.
  if (row.source !== "twitch" || !msgId) {
    // An age hold is the ONE source where Allow has to actually publish.
    //
    // Blocklist rows were never meant to be delivered, and Twitch rows live on
    // Twitch — for both, "resolve" legitimately just clears the queue. But an
    // age hold says nothing about the message; it says we could not vouch for
    // the ACCOUNT, and while the lever is armed that includes every Kick viewer.
    // If Allow merely marked the row, arming the lever would permanently DROP
    // those messages while the panel promised they were only held — the
    // difference between "withhold" and "block", quietly erased.
    //
    // Published BEFORE the row is marked: if the release fails, the row stays
    // actionable so the mod can retry, rather than reading as resolved with the
    // message gone.
    // The releasable set is the contract. A source that holds messages but
    // is missing here resolves the row WITHOUT delivering — the panel says
    // allowed, the message never appears, and "held" becomes a lie.
    //
    // Two delivery paths, split on where the message came FROM:
    //   • native  (the site's own platform, matrix_id present) → /chat/native, which
    //     writes the real site.chat_messages row and broadcasts. Releasing via
    //     /chat would re-run stream-api's word blocklist and re-hold the exact
    //     message the mod just allowed. Native rows were already judged by the
    //     web-side classify at send time; on a word hold, the mod's Allow IS
    //     the judgement (severity-4 rows are 'blocked' and never reach here).
    //   • platform (account_age / link_gate ingest holds) → /chat with
    //     releaseHold, which skips the age and link gates — re-running either
    //     would refuse the message again and make Allow a silent no-op. The
    //     word blocklist still applies there, so a release cannot smuggle a
    //     slur into a platform relay.
    //
    // Platform 'blocklist' rows are 'blocked', not 'pending' — a relayed
    // slur hit has nothing waiting to publish (the message is already public
    // on its own platform), so the status condition below excludes them.
    // 'flagged' rows (flag-mode measurements) are excluded the same
    // way: the message was already delivered.
    const isNative = isNativePlatform(row.platform) && !!row.matrix_id;
    // 'ai' (automod): a held site message — Allow must deliver it like the others.
    // Platform 'ai' rows are 'flagged' (already public on their platform), never released.
    const RELEASABLE = isNative
      ? ["account_age", "link_gate", "blocklist", "ai"]
      : ["account_age", "link_gate"];
    if (RELEASABLE.includes(row.source) && action === "allow" && row.status === "pending") {
      // Fresh IDENTITY, like a real send would carry — the name on the row was
      // frozen at hold time (and can be null if that lookup failed), and the
      // rest was never on the row at all.
      //
      // `usernameStyle` is why this reads three columns instead of one. A
      // released message is a NORMAL message: it must look exactly like the one
      // the sender typed. `/chat/native` resolves a missing `usernameColor` from
      // site.users itself, but it has NO such fallback for the style — the
      // equipped id-set rides the frame or it does not exist. Omitting it would
      // publish the message with the sender's colour and a bare, unstyled name.
      //
      // That is nearly invisible: chat HISTORY re-joins site.users
      // (`app/api/chat/history/route.ts`), so the styling comes back on the next
      // reload and only the live frame is wrong.
      //
      // Whatever a real send passes, this must pass. `app/api/chat/send/route.ts`
      // reads the same three columns in one query and is the thing to
      // diff against if a fourth is ever added there.
      const sender = isNative
        ? await pool
            .query<{
              display_name: string | null;
              username_color: string | null;
              username_style: object | null;
            }>(
              `SELECT display_name, username_color, username_style
                 FROM site.users WHERE matrix_id = $1`, [row.matrix_id]
            )
            .then((r) => r.rows[0] ?? null)
            .catch(() => null)
        : null;
      const released = isNative
        ? await streamApiFetch("/chat/native", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              matrixId: row.matrix_id,
              username: sender?.display_name ?? row.user_name ?? undefined,
              message: row.text,
              usernameColor: sender?.username_color ?? undefined,
              usernameStyle: sender?.username_style ?? undefined,
            }),
          }).catch(() => null)
        : await streamApiFetch("/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              platform: row.platform ?? "unknown",
              userId: "",            // canonical is passed via username resolution
              username: row.user_name ?? "unknown",
              message: row.text,
              releaseHold: true,
            }),
          }).catch(() => null);

      if (!released?.ok) {
        console.error("[automod/resolve] release failed for row", rowId);
        return Response.json({ error: "release_failed" }, { status: 502 });
      }
    }

    // A flagged automod row (a platform message, already public) is DISMISSED either way:
    // nothing to release, nothing to withhold — the mod has seen it.
    await pool.query(
      `UPDATE site.automod_held SET status = $2, resolved_by = $3, resolved_at = now()
       WHERE id = $1 AND (status IN ('pending','blocked') OR (status = 'flagged' AND source = 'ai'))`,
      [rowId, action === "allow" ? "allowed" : "denied", mod]
    );
    return Response.json({ ok: true, source: row.source });
  }

  // A resolved row is not actionable again. Without this, a stale second mod
  // panel could re-deny an already-denied row and re-run the origin delete's
  // side effects (duplicate mod-log entry, re-fired fan-out) — and, worse,
  // deny a row Twitch's own mod view already resolved as ALLOWED.
  if (row.status !== "pending") {
    return Response.json({ error: "already_resolved", status: row.status }, { status: 409 });
  }

  const cap = await getBroadcasterToken("twitch", SCOPE_AUTOMOD);
  if (!cap) {
    return Response.json({ error: "broadcaster_link_missing_scope" }, { status: 503 });
  }

  let status: number;
  let detail = "";
  try {
    const res = await fetch("https://api.twitch.tv/helix/moderation/automod/message", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cap.token}`,
        "Client-Id": twitchClientId(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: cap.actorPlatformId,
        msg_id: msgId,
        action: action === "allow" ? "ALLOW" : "DENY",
      }),
      signal: AbortSignal.timeout(8_000),
    });
    status = res.status;
    if (!res.ok) detail = (await res.text().catch(() => "")).slice(0, 300);
  } catch (e) {
    return Response.json({ error: "twitch_unreachable", detail: (e as Error).message }, { status: 502 });
  }

  // The held Twitch message can be the COPY of a cross-posted native send —
  // the site original (and any YouTube/Kick copies) already published before
  // Twitch held its copy. Denying only the copy resolves a message Twitch never
  // showed while it stays up where the community actually reads it. So a Deny
  // on a LINKED row removes the origin everywhere — but ONLY when the row
  // actually resolves. It must not run on a twitch_rejected failure (a 401
  // from an expired broadcaster token would delete the origin while the mod
  // sees a failure toast and the retry re-runs the side effects).
  // Allow needs nothing: the origin is already up, which is what Allow means.
  const denyOrigin = action === "deny" && row.site_msg_id != null;

  // 404 = the hold already expired on Twitch (~5 min window) or was resolved in
  // Twitch's own mod view moments ago — and those demand OPPOSITE treatment of
  // the origin: expiry dropped the copy (deny intent stands, origin goes), but
  // a concurrent external ALLOW published it (deleting the origin would remove
  // a message another mod just approved). Re-read the row: the EventSub update
  // for an external resolve lands near-instantly, so a row still 'pending' on
  // re-read is expiry. (Residual window: an external allow whose event hasn't
  // arrived yet — sub-second, and unknowable from here.)
  if (status === 404) {
    const fresh = await pool.query<{ status: string }>(
      `SELECT status FROM site.automod_held WHERE id = $1`, [rowId]
    ).then((r) => r.rows[0]?.status ?? "pending").catch(() => "pending");
    if (fresh !== "pending") {
      return Response.json({ error: "already_resolved", status: fresh }, { status: 409 });
    }
    if (denyOrigin) {
      await deleteSiteMessageEverywhere(mod, Number(row.site_msg_id));
    }
    await pool.query(
      `UPDATE site.automod_held SET status = 'expired', resolved_at = now()
       WHERE id = $1 AND status = 'pending'`,
      [rowId]
    ).catch(() => {});
    return Response.json({ error: "expired", ...(denyOrigin ? { originDeleted: true } : {}) }, { status: 410 });
  }
  if (status < 200 || status >= 300) {
    console.error("[automod/resolve]", status, detail);
    return Response.json({ error: "twitch_rejected", status }, { status: 502 });
  }

  // Success — Twitch accepted OUR resolve, so the deny is authoritative and the
  // origin goes with it.
  if (denyOrigin) {
    await deleteSiteMessageEverywhere(mod, Number(row.site_msg_id));
  }

  // Record the real resolver (the update event that follows only moves rows
  // still 'pending', so this write wins).
  await pool.query(
    `UPDATE site.automod_held SET status = $2, resolved_by = $3, resolved_at = now()
     WHERE id = $1`,
    [rowId, action === "allow" ? "allowed" : "denied", mod]
  ).catch(() => {});

  return Response.json({ ok: true, ...(denyOrigin ? { originDeleted: true } : {}) });
}
