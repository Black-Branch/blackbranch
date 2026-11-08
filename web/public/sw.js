// Service worker: three jobs.
//
// 1) PWA install — a fetch handler for top-level navigations (passed straight to
//    the network) is what makes Chrome fire `beforeinstallprompt`. Navigations are
//    NEVER cached, so there's zero risk of serving a stale app shell.
//
// 2) Picture cache — pictures kept on the device so a second sight is instant
//    (spec docs/superpowers/specs/2026-11-08-picture-cache-design.md):
//      emotes & stickers   the emote CDNs below           cache-first (immutable URLs)
//      profile pictures    Twitch pictures + /api/avatar   stale-while-revalidate
//      link previews       /api/og (the card data)         stale-while-revalidate
//    Each kind has its own capped LRU cache, and the viewer's switches (Settings ›
//    Storage on this device) arrive by postMessage and are kept in the meta cache:
//    a kind switched off is deleted and its requests pass straight to the network.
//    No record = everything on.
//
// 3) Offline page — an installed PWA shows a branded page when the network is gone.
//
// Everything else — same-origin assets, other API calls, Matrix media (it carries DM
// pictures; the media proxy's one-day private cache is the rule for those), the chat
// WebSocket, every other host — falls through untouched.

// v3: only genuinely-ok CORS responses are cached. An opaque response masks its status
// (res.ok === false, res.status === 0); storing one would serve a transient error
// cache-first FOREVER. Bumping a name purges what an older version cached.
const EMOTE_CACHE = "emote-cache-v3";
const AVATAR_CACHE = "avatar-cache-v1";
const PREVIEW_CACHE = "preview-cache-v1";
// The LRU indexes (url → last use) and the viewer's policy — small JSON entries in
// their own cache, never mixed into the picture entries.
const META_CACHE = "emote-meta-v1";
const POLICY_KEY = "/__picture-policy.json";
// The offline fallback page lives in its own versioned cache. Bump the name when offline.html changes shape — activate() sweeps
// stale versions, same as the emote cache.
const PAGE_CACHE = "page-cache-v1";
const OFFLINE_URL = "/offline.html";
// cdn.7tv.app · cdn.frankerfacez.com · static-cdn.jtvnw.net (/emoticons/ = emotes,
// /jtv_user_pictures/ = profile pictures).
// BTTV is deliberately NOT here: its CDN sends no CORS header, so the worker
// could only ever store it OPAQUE — which Chrome pads to ~7 MB of quota per
// entry. Untouched, the <img> goes to the browser's HTTP cache, where BTTV's
// `max-age=15552000, immutable` keeps it for 180 days.
const EMOTE_HOSTS = /(?:^|\.)(?:7tv\.app|frankerfacez\.com|jtvnw\.net)$/;

// Sized for the whole catalog at one display size (~1,200) + still frames + the
// sticker rung + the picker's own rung where it differs + foreign Twitch emotes.
// Evicted by LEAST-RECENT USE: FIFO by insertion evicts the most-used emotes first,
// because the warm order puts them in first.
const EMOTE_CACHE_MAX = 3000;
// Not used for 30 days → gone, whatever the count (Workbox's maxAgeSeconds).
const EMOTE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Every chatter seen, capped: a picture is small, and its own cache keeps it from
// competing with the emotes.
const AVATAR_CACHE_MAX = 1000;
const AVATAR_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// A changed profile picture shows on the next look after this.
const AVATAR_FRESH_MS = 10 * 60 * 1000;
const PREVIEW_CACHE_MAX = 500;
const PREVIEW_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PREVIEW_FRESH_MS = 60 * 60 * 1000;

function makeStore(kind, name, metaKey, max, maxAgeMs, freshMs) {
  return { kind, name, metaKey, max, maxAgeMs, freshMs, lru: null, loading: null, dirty: false, timer: null, puts: 0 };
}
// freshMs null = cache-first (the URL is immutable, there is nothing to revalidate).
const EMOTES = makeStore("emotes", EMOTE_CACHE, "/__emote-lru.json", EMOTE_CACHE_MAX, EMOTE_MAX_AGE_MS, null);
const AVATARS = makeStore("avatars", AVATAR_CACHE, "/__avatar-lru.json", AVATAR_CACHE_MAX, AVATAR_MAX_AGE_MS, AVATAR_FRESH_MS);
const PREVIEWS = makeStore("previews", PREVIEW_CACHE, "/__preview-lru.json", PREVIEW_CACHE_MAX, PREVIEW_MAX_AGE_MS, PREVIEW_FRESH_MS);
const STORES = [EMOTES, AVATARS, PREVIEWS];

// ── Policy ───────────────────────────────────────────────────────────────────
const DEFAULT_POLICY = { on: true, emotes: true, avatars: true, previews: true };
let policy = null;
let policyLoading = null;

function cleanPolicy(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const k of Object.keys(DEFAULT_POLICY)) out[k] = raw[k] !== false;
  return out;
}

function loadPolicy() {
  if (policy) return Promise.resolve(policy);
  if (!policyLoading) {
    policyLoading = (async () => {
      try {
        const hit = await (await caches.open(META_CACHE)).match(POLICY_KEY);
        policy = (hit && cleanPolicy(await hit.json())) || DEFAULT_POLICY;
      } catch {
        policy = DEFAULT_POLICY;
      }
      return policy;
    })();
  }
  return policyLoading;
}

const kindOn = (p, kind) => p.on && p[kind];

async function dropStore(store) {
  await caches.delete(store.name);
  store.lru = new Map();
  store.loading = null;
  store.dirty = true;
  await flushLru(store);
}

async function applyPolicy(next) {
  policy = next;
  policyLoading = null;
  await (await caches.open(META_CACHE)).put(POLICY_KEY, new Response(JSON.stringify(next), { headers: { "content-type": "application/json" } }));
  await Promise.all(STORES.filter((s) => !kindOn(next, s.kind)).map(dropStore));
}

self.addEventListener("message", (event) => {
  const d = event.data;
  if (!d || typeof d !== "object") return;
  if (d.type === "bb:picture-cache") {
    const next = cleanPolicy(d.policy);
    if (next) event.waitUntil(applyPolicy(next).catch(() => {}));
  } else if (d.type === "bb:picture-cache-clear") {
    event.waitUntil(Promise.all(STORES.map(dropStore)).catch(() => {}));
  }
});

// ── LRU index ────────────────────────────────────────────────────────────────
// In memory while the worker lives; persisted debounced. A worker killed before a
// flush loses a few seconds of recency, which only makes those entries look older
// than they are — never evicts something used more recently than what it keeps.
// Emote entries are `lastUse`; a revalidated kind's are `[lastUse, fetchedAt]`.
function loadLru(store) {
  if (store.lru) return Promise.resolve(store.lru);
  if (!store.loading) {
    store.loading = (async () => {
      let raw = {};
      try {
        const hit = await (await caches.open(META_CACHE)).match(store.metaKey);
        raw = hit ? await hit.json() : {};
      } catch {
        raw = {};
      }
      const m = new Map();
      for (const [k, v] of Object.entries(raw || {})) {
        if (store.freshMs) m.set(k, Array.isArray(v) ? v : [v, 0]);
        else m.set(k, Array.isArray(v) ? v[0] : v);
      }
      store.lru = m;
      return m;
    })();
  }
  return store.loading;
}

const lastUse = (v) => (Array.isArray(v) ? v[0] : v);

async function flushLru(store) {
  store.timer = null;
  if (!store.dirty || !store.lru) return;
  store.dirty = false;
  const body = JSON.stringify(Object.fromEntries(store.lru));
  await (await caches.open(META_CACHE)).put(store.metaKey, new Response(body, { headers: { "content-type": "application/json" } }));
}

// `fetched`: true when the bytes were just downloaded (a revalidated kind's clock).
function touch(store, href, fetched) {
  const now = Date.now();
  if (store.freshMs) {
    const prev = store.lru.get(href);
    store.lru.set(href, [now, fetched ? now : (prev ? prev[1] : 0)]);
  } else {
    store.lru.set(href, now);
  }
  store.dirty = true;
  if (!store.timer) store.timer = setTimeout(() => { flushLru(store).catch(() => {}); }, 5000);
}

// Drop entries unused for the max age, then the least-recently-used beyond the
// cap. An entry with no record (cached before the index existed) counts as used
// NOW — it gets the full max age before it can expire.
async function sweepCache(store, cache) {
  await loadLru(store);
  const lru = store.lru;
  const keys = await cache.keys();
  const now = Date.now();
  const live = [];
  const doomed = [];
  for (const k of keys) {
    let v = lru.get(k.url);
    if (v === undefined) { v = store.freshMs ? [now, 0] : now; lru.set(k.url, v); store.dirty = true; }
    const t = lastUse(v);
    if (now - t > store.maxAgeMs) doomed.push(k); else live.push([k, t]);
  }
  if (live.length > store.max) {
    live.sort((a, b) => a[1] - b[1]);
    for (const [k] of live.slice(0, live.length - store.max)) doomed.push(k);
  }
  await Promise.all(doomed.map((k) => cache.delete(k)));
  const present = new Set(keys.map((k) => k.url));
  for (const k of doomed) present.delete(k.url);
  for (const u of Array.from(lru.keys())) if (!present.has(u)) { lru.delete(u); store.dirty = true; }
  await flushLru(store);
}

// Store, then the capped LRU sweep — every 20th put, not every put: keys() enumerates
// the whole cache.
function putPicture(storeObj, cache, href, res) {
  cache.put(href, res.clone()).catch(() => {});
  touch(storeObj, href, true);
  if (++storeObj.puts >= 20) {
    storeObj.puts = 0;
    sweepCache(storeObj, cache).catch(() => {});
  }
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
      // Drop any older-versioned caches so a bumped name cleanly replaces its predecessor.
      const current = new Set([EMOTE_CACHE, AVATAR_CACHE, PREVIEW_CACHE, META_CACHE, PAGE_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => /^(?:emote-cache|emote-meta|avatar-cache|preview-cache|page-cache)-/.test(n) && !current.has(n))
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
      // Apply the caps / max ages now, not only after the next 20 puts.
      for (const s of STORES) await sweepCache(s, await caches.open(s.name)).catch(() => {});
    })()
  );
});

// Which picture cache a request belongs to, or null (not ours: fall through).
function classify(url) {
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith("/api/avatar/user/") || url.pathname.startsWith("/api/avatar/public/")) return AVATARS;
    if (url.pathname === "/api/og") return PREVIEWS;
    return null;
  }
  if (!EMOTE_HOSTS.test(url.host)) return null;
  if (/(?:^|\.)jtvnw\.net$/.test(url.hostname)) {
    if (url.pathname.startsWith("/emoticons/")) return EMOTES;
    if (url.pathname.startsWith("/jtv_user_pictures/")) return AVATARS;
    return null;
  }
  return EMOTES;
}

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

  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  const kind = classify(url);
  if (!kind) return;

  event.respondWith(picture(kind, url.href, req, event));
});

async function picture(kind, href, req, event) {
  const p = await loadPolicy();
  if (!kindOn(p, kind.kind)) return fetch(req);
  return kind.freshMs ? staleWhileRevalidate(kind, href, req, event) : emoteCacheFirst(href, req);
}

// Fetch a cross-origin picture, preferring a CORS response so the status is VISIBLE — that lets
// the caller cache only genuine successes and never an error. CORS is returned
// as-is even when non-ok (a 404/5xx we can see and decline to cache). Only a
// thrown CORS fetch — a CDN with no `access-control-allow-origin` or a
// network error — falls back to an opaque no-cors fetch, which still lets the <img>
// render but is deliberately NOT cached.
//
// Priority: an <img> (destination "image") — a chat row, a picker tile — goes high;
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
    const [cache] = await Promise.all([caches.open(EMOTE_CACHE), loadLru(EMOTES)]);
    const hit = await cache.match(href);
    if (hit) { touch(EMOTES, href, false); return hit; }

    const res = await fetchForCache(href, req);
    // Cache ONLY genuinely-ok CORS responses. Emote URLs are immutable so there's
    // nothing to revalidate, which is exactly why an error must never be stored.
    if (res && res.ok && res.type !== "opaque") putPicture(EMOTES, cache, href, res);
    return res;
  } catch {
    // Network failed and nothing cached — let the browser make its own attempt
    // with the original request so the <img> still has a chance (and can surface
    // its onError fallback if that fails too).
    return fetch(req);
  }
}

// A response worth keeping for a revalidated kind: ok, visible, and the type the kind serves
// (an HTML error page answered 200 by a portal must not become someone's profile picture).
// The avatar route's letter circle (SVG) is not kept: it stands in while signed out or before
// a picture is set, and a stored one would hide the real picture after sign-in.
function keepable(kind, res) {
  if (!res || !res.ok || res.type === "opaque") return false;
  const type = (res.headers && res.headers.get("content-type")) || "";
  if (kind === PREVIEWS) return type.startsWith("application/json");
  return type.startsWith("image/") && !type.startsWith("image/svg");
}

// Same-origin requests go as the page made them (the avatar route needs the viewer's session);
// cross-origin pictures take the CORS path above.
function fetchFresh(href, req) {
  return new URL(href).origin === self.location.origin ? fetch(req) : fetchForCache(href, req);
}

// The stored copy at once; past its fresh window, a new copy is fetched in the background and
// replaces it for the next look. A failed refresh keeps the old copy; an ok answer that is not
// kept (the picture was removed: the letter circle came back) drops it.
async function staleWhileRevalidate(kind, href, req, event) {
  try {
    const [cache, lru] = await Promise.all([caches.open(kind.name), loadLru(kind)]);
    const hit = await cache.match(href);
    if (hit) {
      // No record: the worker stopped before its index was saved. Counted as fetched now, like
      // the sweep counts it as used now — or every stored picture would be fetched again at once.
      const v = lru.get(href);
      const fetchedAt = v ? v[1] : Date.now();
      touch(kind, href, !v);
      if (Date.now() - fetchedAt > kind.freshMs) {
        event.waitUntil(
          fetchFresh(href, req)
            .then((res) => {
              if (keepable(kind, res)) putPicture(kind, cache, href, res);
              else if (res && res.ok) return cache.delete(href);
            })
            .catch(() => {})
        );
      }
      return hit;
    }
    const res = await fetchFresh(href, req);
    if (keepable(kind, res)) putPicture(kind, cache, href, res);
    return res;
  } catch {
    return fetch(req);
  }
}
