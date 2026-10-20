// In-process request throttles for API routes (single web process on VM 112
// one server — no cross-instance coordination needed). Two shapes, previously copy-pasted
// with drift across six routes (chat/send, chat/vote, forum/vote, rss/article,
// avatar/upload, coins/spend/sticker):
//
//  - createSlidingWindowLimiter — N hits per rolling window per key
//  - createCooldown             — one hit per fixed gap per key
//
// Both evict opportunistically once the map outgrows EVICT_ABOVE so a
// long-lived process can't accumulate every key it has ever seen.

const EVICT_ABOVE = 5000;

/** The request header the server writes the socket's address into (ipKeyPeer.ts) — over any value
 *  a client sent, so it is the one address here a client cannot choose. */
export const PEER_HEADER = "x-blackbranch-peer";

/** "::ffff:192.0.2.1" and "192.0.2.1" are the same IPv4 peer. */
function normAddr(a: string): string {
  const s = a.trim();
  return s.toLowerCase().startsWith("::ffff:") && s.includes(".") ? s.slice(7) : s;
}

/** An IPv6 client controls its whole /64, so it is counted per /64 (as stream-api's ws-hub does);
 *  IPv4 per address. */
function bucketOf(addr: string): string {
  const a = normAddr(addr).toLowerCase();
  if (!a.includes(":")) return a;
  const [head = "", tail = ""] = a.split("%")[0]!.split("::");
  const h = head ? head.split(":") : [];
  const t = a.includes("::") && tail ? tail.split(":") : [];
  const groups = a.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return a;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

let warnedUnstamped = false;

/** Per-request rate-limit key for signed-out callers.
 *
 * The socket's own address (the server's peer stamp, ipKeyPeer.ts) — unless that peer is a TRUSTED
 * proxy (WEB_TRUSTED_PROXIES: comma-separated addresses, empty = trust nobody), whose
 * CF-Connecting-IP then names the client. The same rule stream-api's ws-hub applies with
 * WS_TRUSTED_PROXIES. A header from anyone else is ignored: believing it let a direct-mode
 * install's every per-address limit be bypassed by sending a new value per request.
 * X-Forwarded-For is never read: its leftmost entry is whatever the client put there.
 * On a bundle the proxy is caddy, which SETS CF-Connecting-IP to the connecting client (tunnel mode:
 * believed from cloudflared alone) — so web trusts caddy's fixed address, as stream-api does.
 * Authenticated routes should still key on the user id instead. `env` is injectable for tests. */
export function ipKey(req: Request, env: Record<string, string | undefined> = process.env): string {
  const peer = normAddr(req.headers.get(PEER_HEADER) ?? "");
  if (!peer) {
    if (!warnedUnstamped) {
      warnedUnstamped = true;
      console.warn("[rate-limit] a request without the peer stamp — counted under one shared key (is ipKeyPeer installed?)");
    }
    return "ip:unknown";
  }
  const trusted = new Set((env.WEB_TRUSTED_PROXIES ?? "").split(",").map(normAddr).filter(Boolean));
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf && trusted.has(peer)) return `ip:${bucketOf(cf.slice(0, 64))}`;
  return `ip:${bucketOf(peer)}`;
}

/** Sliding-window limiter: at most `limit` hits per `windowMs` per key.
 * The returned function is check-AND-arm — a call that returns false counts
 * as a hit; a call that returns true (over the limit) records nothing. */
export function createSlidingWindowLimiter(windowMs: number, defaultLimit: number) {
  const map = new Map<string, number[]>();
  return function isLimited(key: string, limit: number = defaultLimit): boolean {
    const now = Date.now();
    if (map.size > EVICT_ABOVE) {
      for (const [k, ts] of map) {
        const last = ts[ts.length - 1];
        if (last === undefined || now - last >= windowMs) map.delete(k);
      }
    }
    const timestamps = (map.get(key) ?? []).filter((t) => now - t < windowMs);
    if (timestamps.length >= limit) {
      map.set(key, timestamps);
      return true;
    }
    timestamps.push(now);
    map.set(key, timestamps);
    return false;
  };
}

/** Fixed-gap cooldown: one hit per `gapMs` per key. `hit()` is check-and-arm
 * for the common case; routes that must only start the gap after the guarded
 * action succeeds (e.g. a coin spend) use `remainingMs()` + `arm()`. */
export function createCooldown(gapMs: number) {
  const map = new Map<string, number>();
  function remainingMs(key: string): number {
    const now = Date.now();
    if (map.size > EVICT_ABOVE) {
      for (const [k, ts] of map) if (now - ts >= gapMs) map.delete(k);
    }
    return Math.max(0, gapMs - (now - (map.get(key) ?? 0)));
  }
  return {
    remainingMs,
    arm(key: string): void {
      map.set(key, Date.now());
    },
    hit(key: string): boolean {
      if (remainingMs(key) > 0) return true;
      map.set(key, Date.now());
      return false;
    },
  };
}
