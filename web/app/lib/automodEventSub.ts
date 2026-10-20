// Twitch automod-held queue — process-lifetime EventSub WebSocket singleton,
// started from instrumentation.ts (the web app is the only holder of
// TOKEN_ENC_KEY, so this can't live in stream-api/stream-ingest).
//
// Subscribes to automod.message.hold + automod.message.update (both v2) as the
// BROADCASTER (Helix requires the websocket transport's token user == the
// subscription's moderator_user_id, and resolves happen as him too). Held
// messages land in site.automod_held; the mod panel polls GET /api/mod/automod
// (mod-only data must NOT ride the public stream-api WS bus).
//
// Dormant until the broadcaster's stored Twitch link carries
// `moderator:manage:automod` — rechecked hourly, so his relink activates the
// queue without a redeploy. Held messages expire on Twitch's side after ~5 min;
// messages held while this socket is down (e.g. during a web deploy) are missed
// here but stay visible in Twitch's own mod view.

import pool from "@/lib/db";
import { getBroadcasterToken } from "@/app/lib/platformMod/shared";
import { twitchClientId } from "@/app/lib/twitch";

const SCOPE_AUTOMOD = "moderator:manage:automod";
const WS_URL = "wss://eventsub.wss.twitch.tv/ws";

let started = false;
let ws: WebSocket | null = null;
let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
let keepaliveMs = 30_000;
let backoffMs = 1_000;
let dormantLogged = false;

type EventSubFrame = {
  metadata?: { message_type?: string };
  payload?: {
    session?: { id?: string; keepalive_timeout_seconds?: number; reconnect_url?: string };
    subscription?: { type?: string };
    event?: AutomodEvent;
  };
};

type AutomodEvent = {
  message_id?: string;
  user_id?: string;
  user_login?: string;
  user_name?: string;
  message?: { text?: string };
  reason?: string;                                   // v2: "automod" | "blocked_term"
  automod?: { category?: string; level?: number };
  status?: string;                                   // update event: approved | denied | expired
};

export function startAutomodEventSub(): void {
  if (started) return;
  started = true;
  if (typeof WebSocket === "undefined") {
    console.error("[automod] global WebSocket unavailable on this Node — automod queue disabled");
    return;
  }
  void ensure();
  // Hourly: dormant → active once the relink lands; also a safety net if a
  // failed reconnect chain ever gave up.
  setInterval(() => void ensure(), 60 * 60 * 1000);
}

async function ensure(): Promise<void> {
  if (ws) return;
  const cap = await getBroadcasterToken("twitch", SCOPE_AUTOMOD).catch(() => null);
  if (!cap) {
    if (!dormantLogged) {
      console.log("[automod] dormant — broadcaster Twitch link lacks moderator:manage:automod (relink activates it)");
      dormantLogged = true;
    }
    return;
  }
  dormantLogged = false;
  connect(WS_URL, false);
}

function connect(url: string, isReconnect: boolean): void {
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch (e) {
    console.error("[automod] WebSocket construction failed:", e);
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.addEventListener("message", (ev) => {
    armKeepalive(socket);
    let frame: EventSubFrame;
    try {
      frame = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const type = frame.metadata?.message_type;

    if (type === "session_welcome") {
      backoffMs = 1_000;
      const s = frame.payload?.session;
      if (s?.keepalive_timeout_seconds) keepaliveMs = (s.keepalive_timeout_seconds + 10) * 1000;
      armKeepalive(socket);
      // Subscriptions carry over across a session_reconnect handoff; only a
      // fresh session needs them created.
      if (!isReconnect && s?.id) void subscribe(s.id, socket);
    } else if (type === "session_reconnect") {
      const next = frame.payload?.session?.reconnect_url;
      if (next) {
        // Twitch keeps delivering on the old socket until the new one gets its
        // welcome; it then closes the old one — our close handler ignores
        // sockets that are no longer current.
        connect(next, true);
      }
    } else if (type === "notification") {
      void handleNotification(frame);
    } else if (type === "revocation") {
      console.warn("[automod] subscription revoked — going dormant until the hourly recheck");
      try { socket.close(); } catch { /* already closing */ }
    }
    // session_keepalive needs no handling beyond the watchdog reset above.
  });

  socket.addEventListener("close", () => {
    if (ws !== socket) return; // superseded by a session_reconnect handoff
    ws = null;
    clearKeepalive();
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    // close always follows error; reconnect is handled there.
  });
}

function armKeepalive(socket: WebSocket): void {
  if (ws !== socket) return;
  clearKeepalive();
  keepaliveTimer = setTimeout(() => {
    console.warn("[automod] keepalive timeout — recycling EventSub socket");
    try { socket.close(); } catch { /* already closed */ }
  }, keepaliveMs);
}

function clearKeepalive(): void {
  if (keepaliveTimer) { clearTimeout(keepaliveTimer); keepaliveTimer = null; }
}

function scheduleReconnect(): void {
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, 60_000);
  setTimeout(() => void ensure(), delay);
}

async function subscribe(sessionId: string, socket: WebSocket): Promise<void> {
  const cap = await getBroadcasterToken("twitch", SCOPE_AUTOMOD).catch(() => null);
  if (!cap) { try { socket.close(); } catch { /* noop */ } return; }

  for (const type of ["automod.message.hold", "automod.message.update"]) {
    try {
      const res = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cap.token}`,
          "Client-Id": twitchClientId(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type,
          version: "2",
          condition: {
            broadcaster_user_id: cap.actorPlatformId,
            moderator_user_id: cap.actorPlatformId,
          },
          transport: { method: "websocket", session_id: sessionId },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      // 409 = already subscribed on this session — fine.
      if (!res.ok && res.status !== 409) {
        console.error(`[automod] subscribe ${type} failed:`, res.status, (await res.text().catch(() => "")).slice(0, 300));
      }
    } catch (e) {
      console.error(`[automod] subscribe ${type} threw:`, e);
    }
  }
  console.log("[automod] EventSub connected — automod queue live");
}

async function handleNotification(frame: EventSubFrame): Promise<void> {
  const subType = frame.payload?.subscription?.type;
  const ev = frame.payload?.event;
  if (!ev?.message_id) return;

  if (subType === "automod.message.hold") {
    await pool.query(
      `INSERT INTO site.automod_held (twitch_msg_id, user_id, user_login, user_name, text, category, level)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (twitch_msg_id) DO NOTHING`,
      [
        ev.message_id,
        ev.user_id ?? "",
        ev.user_login ?? null,
        ev.user_name ?? null,
        ev.message?.text ?? "",
        ev.automod?.category ?? ev.reason ?? null,
        ev.automod?.level ?? null,
      ]
    ).catch((e) => console.error("[automod] hold insert failed:", e));

    // The held message can be the TWITCH COPY of a cross-posted native send —
    // published on the site (and other platforms) before Twitch held its copy.
    // Without a link back to the origin, a mod's Deny resolves a copy Twitch
    // never showed while the message stays up where the community reads it
    // (ticket #4). Helix returns NO message id for a dropped send, so the link
    // can't be captured at send time; match here instead: the held Twitch user's
    // linked site account, most recent identical still-visible message. The site
    // row always exists first (native insert precedes the fan-out), so there is
    // no arrival race. A fallback reply cross-post ("@name …") won't text-match
    // its origin — that row stays unlinked and Deny behaves as before.
    if (ev.user_id && ev.message?.text) {
      await pool.query(
        `UPDATE site.automod_held h
            SET site_msg_id = m.id, matrix_id = m.matrix_id
           FROM (SELECT cm.id, cm.matrix_id
                   FROM site.chat_messages cm
                   JOIN site.accounts a
                     ON a.matrix_id = cm.matrix_id
                    AND a.provider = 'twitch' AND a.type = 'oauth'
                    AND a.provider_account_id = $2
                  WHERE cm.message = $3
                    AND cm.created_at > now() - interval '2 minutes'
                    AND NOT cm.is_deleted
                  ORDER BY cm.id DESC LIMIT 1) m
          WHERE h.twitch_msg_id = $1 AND h.site_msg_id IS NULL`,
        [ev.message_id, ev.user_id, ev.message.text]
      ).catch((e) => console.error("[automod] origin link failed:", e));
    }
  } else if (subType === "automod.message.update") {
    // Resolved — by our own resolve route (it triggers this event too; its row
    // update overwrites with the real resolver), in Twitch's own mod view, or
    // by expiry. Only pending rows move; resolved_by stays NULL for external.
    const status =
      ev.status === "approved" ? "allowed"
      : ev.status === "denied" ? "denied"
      : ev.status === "expired" ? "expired"
      : "external";
    await pool.query(
      `UPDATE site.automod_held SET status = $2, resolved_at = now()
       WHERE twitch_msg_id = $1 AND status = 'pending'`,
      [ev.message_id, status]
    ).catch((e) => console.error("[automod] update failed:", e));
  }
}
