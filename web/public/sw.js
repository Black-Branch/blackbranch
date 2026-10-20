// Service worker: two jobs.
//
// 1) PWA install — a fetch handler for top-level navigations (passed straight to
//    the network) is what makes Chrome fire `beforeinstallprompt`. Navigations are
//    NEVER cached, so there's zero risk of serving a stale app shell.
//
// 2) Emote cache — a persistent, cache-first store for the emote CDNs ONLY. This
//    is what makes emotes truly instant: an HTTP-cache warmer alone cannot
//    reliably cover a 1000+ emote set (it stalls, and coverage doesn't survive
//    across sessions). A Cache-API store fixes both: every emote is cached the
//    first time it's seen and served from cache (~0ms) forever after,
//    persisting across sessions and reloads — the web equivalent of
//    Chatterino's on-disk emote cache. The background warmer's fetches flow
//    through here too, so it populates this cache as a side effect.
//
// Scope is deliberately narrow: ONLY the emote CDN hosts below are intercepted.
// Same-origin app assets, API calls, the chat WebSocket, and every other host
// fall through untouched — so a bug here can only ever affect emote images, never
// the app shell, navigation, money, or auth paths.

// v3: only genuinely-ok CORS responses are cached. A CDN error (404/5xx) comes
// back either as a CORS non-ok or, after falling through, as an OPAQUE response
// (which masks the status: res.ok === false, res.status === 0); caching opaque
// responses unconditionally would store a transient error and serve it
// cache-first FOREVER, leaving that emote permanently broken. Bumping the name
// purges anything an older version cached.
// The v3 NAME is kept across the size change on purpose: DPR2/3 viewers' entries
// are still the right size, and DPR1's unused 2x entries age out by LRU / max age
// below instead of a forced re-download for everyone.
const EMOTE_CACHE = "emote-cache-v3";
// The LRU index (url → last use, ms) — one JSON entry in its own cache, so it is
// swept/versioned with the same machinery and never mixed into the emote entries.
const META_CACHE = "emote-meta-v1";
const META_KEY = "/__emote-lru.json";
// The offline fallback page lives in its own versioned cache. Bump the name when offline.html changes shape — activate() sweeps
// stale versions, same as the emote cache.
const PAGE_CACHE = "page-cache-v1";
const OFFLINE_URL = "/offline.html";
// cdn.7tv.app · cdn.frankerfacez.com · static-cdn.jtvnw.net (its /emoticons/ only).
// BTTV is deliberately NOT here: its CDN sends no CORS header, so the worker
// could only ever store it OPAQUE — which Chrome pads to ~7 MB of quota per
// entry — and a CORS-then-no-cors dance fetches every BTTV emote twice and
// caches none. Untouched, the <img> goes straight to the browser's HTTP cache,
// where BTTV's `max-age=15552000, immutable` keeps it for 180 days (one entry:
// BTTV varies on accept-encoding only, so the warmer's no-cors fetch and the
// <img> share it).
const EMOTE_HOSTS = /(?:^|\.)(?:7tv\.app|frankerfacez\.com|jtvnw\.net)$/;

// Sized for the whole catalog at one display size (~1,200) + still frames + the
// picker's own rung where it differs + the foreign Twitch emotes that ride in on
// messages. Evicted by LEAST-RECENT USE: FIFO by insertion evicts the most-used
// emotes first, because the warm order puts them in first (measured: 28 of the
// top 50 missing from a 600-entry FIFO cache).
const EMOTE_CACHE_MAX = 3000;
// Not used for 30 days → gone, whatever the count (Workbox's maxAgeSeconds).
const EMOTE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
let putsSinceSweep = 0;

// ── LRU index ────────────────────────────────────────────────────────────────
// In memory while the worker lives; persisted debounced. A worker killed before a
// flush loses a few seconds of recency, which only makes those entries look older
// than they are — never evicts something used more recently than what it keeps.
let lru = null;
let lruLoading = null;
let lruDirty = false;
let flushTimer = null;

function loadLru() {
  if (lru) return Promise.resolve(lru);
  if (!lruLoading) {
    lruLoading = (async () => {
      try {
        const hit = await (await caches.open(META_CACHE)).match(META_KEY);
        lru = new Map(Object.entries(hit ? await hit.json() : {}));
      } catch {
        lru = new Map();
      }
      return lru;
    })();
  }
  return lruLoading;
}

async function flushLru() {
  flushTimer = null;
  if (!lruDirty || !lru) return;
  lruDirty = false;
  const body = JSON.stringify(Object.fromEntries(lru));
  await (await caches.open(META_CACHE)).put(META_KEY, new Response(body, { headers: { "content-type": "application/json" } }));
}

function touch(href) {
  lru.set(href, Date.now());
  lruDirty = true;
  if (!flushTimer) flushTimer = setTimeout(() => { flushLru().catch(() => {}); }, 5000);
}

// Drop entries unused for EMOTE_MAX_AGE_MS, then the least-recently-used beyond the
// cap. An entry with no record (cached before the index existed) counts as used
// NOW — it gets the full max age before it can expire.
async function sweepEmoteCache(cache) {
  await loadLru();
  const keys = await cache.keys();
  const now = Date.now();
  const live = [];
  const doomed = [];
  for (const k of keys) {
    let t = lru.get(k.url);
    if (t === undefined) { t = now; lru.set(k.url, t); lruDirty = true; }
    if (now - t > EMOTE_MAX_AGE_MS) doomed.push(k); else live.push([k, t]);
  }
  if (live.length > EMOTE_CACHE_MAX) {
    live.sort((a, b) => a[1] - b[1]);
    for (const [k] of live.slice(0, live.length - EMOTE_CACHE_MAX)) doomed.push(k);
  }
  await Promise.all(doomed.map((k) => cache.delete(k)));
  const present = new Set(keys.map((k) => k.url));
  for (const k of doomed) present.delete(k.url);
  for (const u of Array.from(lru.keys())) if (!present.has(u)) { lru.delete(u); lruDirty = true; }
  await flushLru();
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  // Pre-cache the offline page — it must already be here when the network is
  // gone, or the fallback below has nothing to fall back to.
  event.waitUntil(caches.open(PAGE_CACHE).then((c) => c.addAll([OFFLINE_URL])));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop any older-versioned emote caches so a bumped EMOTE_CACHE name
      // cleanly replaces its predecessor.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) =>
            (n.startsWith("emote-cache-") && n !== EMOTE_CACHE) ||
            (n.startsWith("emote-meta-") && n !== META_CACHE) ||
            (n.startsWith("page-cache-") && n !== PAGE_CACHE))
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
      // Apply the cap / max age now, not only after the next 20 puts.
      await sweepEmoteCache(await caches.open(EMOTE_CACHE)).catch(() => {});
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Top-level navigations: network-FIRST, always — pages are never cached.
  // The only change from network-only: when the network is
  // genuinely gone, an installed PWA now shows a branded offline page instead
  // of the browser's error screen. An HTTP error (4xx/5xx) is NOT the
  // fallback's business — fetch resolves on those, so they render as-is.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(async () =>
        (await caches.match(OFFLINE_URL)) ?? Response.error())
    );
    return;
  }

  // Only GET image requests to the emote CDNs are handled; everything else
  // (same-origin assets, API, other hosts) falls through to the network with no
  // respondWith, keeping the worker entirely out of those paths.
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (!EMOTE_HOSTS.test(url.host)) return;
  // jtvnw.net also serves Twitch PROFILE PICTURES; only emotes belong in this cache
  // (pfps churned it — every chatter ever seen, competing with the emotes).
  if (url.host.endsWith("jtvnw.net") && !url.pathname.startsWith("/emoticons/")) return;

  event.respondWith(emoteCacheFirst(url.href, req));
});

// Fetch an emote, preferring a CORS response so the status is VISIBLE — that lets
// the caller cache only genuine successes and never an error. CORS is returned
// as-is even when non-ok (a 404/5xx we can see and decline to cache). Only a
// thrown CORS fetch — a CDN with no `access-control-allow-origin` (e.g. BTTV) or a
// network error — falls back to an opaque no-cors fetch, which still lets the <img>
// render but is deliberately NOT cached (its status can't be seen, so caching it
// risks the poison this function exists to avoid). CORS-capable CDNs here:
// 7tv.app / jtvnw.net / frankerfacez.com.
//
// Priority: the worker's own fetch would otherwise run at the default priority
// for EVERY request, so a background warm and an on-screen emote would race as
// equals. An <img> (destination "image") — a chat row, a picker tile — goes high;
// the warmer's fetch() (destination "") goes low. A cold emote arriving in chat is
// never queued behind the warm.
async function fetchForCache(href, req) {
  const priority = req && req.destination === "image" ? "high" : "low";
  // The page already asks in CORS mode (emoteRes.ts emoteCrossOrigin): forward ITS request —
  // same mode, same credentials — so the copy the page put in the browser's HTTP cache is the
  // one found. A request of our own differs (credentials), misses it, and downloads again.
  if (req && req.mode === "cors") {
    try {
      return await fetch(req, { priority });
    } catch {
      /* fall through to the CORS-then-no-cors path below */
    }
  }
  try {
    return await fetch(href, { mode: "cors", credentials: "omit", priority });
  } catch {
    /* Network error (every host here sends CORS) — opaque, still renders, not cached. */
    return fetch(href, { mode: "no-cors", credentials: "omit", priority });
  }
}

// Cache-first: keyed by the bare URL string so a warmer's cross-origin fetch and
// a chat <img> (which send different Origin headers, and the CDN varies on Origin)
// resolve to the SAME entry — no Vary mismatch, no double-fetch.
async function emoteCacheFirst(href, req) {
  try {
    const [cache] = await Promise.all([caches.open(EMOTE_CACHE), loadLru()]);
    const hit = await cache.match(href);
    if (hit) { touch(href); return hit; }

    const res = await fetchForCache(href, req);
    // Cache ONLY genuinely-ok CORS responses. Emote URLs are immutable so there's
    // nothing to revalidate, which is exactly why an error must never be stored —
    // it would be served cache-first forever. Opaque responses mask their status
    // (a 404 looks identical to a 200), so they are returned to the <img> but not
    // cached. clone() because the body is one-use.
    if (res && res.ok && res.type !== "opaque") {
      cache.put(href, res.clone()).catch(() => {});
      touch(href);
      // Capped LRU sweep. Swept every 20th put, not every put — keys()
      // enumerates the whole cache.
      if (++putsSinceSweep >= 20) {
        putsSinceSweep = 0;
        sweepEmoteCache(cache).catch(() => {});
      }
    }
    return res;
  } catch {
    // Network failed and nothing cached — let the browser make its own attempt
    // with the original request so the <img> still has a chance (and can surface
    // its onError fallback if that fails too).
    return fetch(req);
  }
}
