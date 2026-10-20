// Round-3 perf batch E scans: 27a (chat pfp img is lazy), 27c (emote cache is
// capped), 30 (home page reads chain off their own dependency, one merged
// signed-in query).
//
// Run: node --test app/lib/perfRound3.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("27a: the chat pfp <img> is lazy — a hidden avatar column must not fetch", () => {
  // The pfp toggle is CSS-only (`.chat-pfp-on` on the root; the span is
  // display:none otherwise), so the <img> stays mounted with the setting off —
  // and an eager display:none image still FETCHES. With loading="lazy" a
  // boxless element never intersects, so the browser skips it; flipping the
  // setting on gives it a box and it loads. One attribute, no architecture
  // change (settings stay CSS-driven — the phone-heat work depends on that).
  const src = readFileSync(new URL("../features/chat/ChatMessage.tsx", import.meta.url), "utf8");
  const span = src.slice(src.indexOf('className="chat-pfp'));
  assert.ok(span.length > 0, "vacuity anchor: the chat-pfp span is gone from ChatMessage");
  const img = span.slice(span.indexOf("<img"), span.indexOf("/>"));
  assert.ok(img.length > 0, "vacuity anchor: the pfp <img> is gone");
  assert.match(img, /loading="lazy"/,
    "the pfp img is eager — with avatars OFF, every message row still fetches its avatar");
});

test("27c: the emote cache sweeps to a cap — phone storage must not grow forever", () => {
  const src = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
  assert.match(src, /EMOTE_CACHE_MAX\s*=\s*\d+/,
    "no cap constant — jtvnw pfps land in emote-cache-v3 with zero eviction");
  const sweepAt = src.indexOf("async function sweepEmoteCache");
  assert.notEqual(sweepAt, -1, "the sweep is gone");
  const sweep = src.slice(sweepAt, src.indexOf("\n}", sweepAt));
  assert.match(sweep, /cache\.keys\(\)/);
  assert.match(sweep, /cache\.delete\(/, "the sweep never deletes anything");
  // The sweep must actually be wired into the put path, not just defined.
  const putAt = src.indexOf("cache.put(href");
  assert.notEqual(putAt, -1, "vacuity anchor: the cache.put is gone");
  assert.match(src.slice(putAt, putAt + 800), /sweepEmoteCache\(cache\)/,
    "the sweep exists but nothing calls it after a put");
});

test("30: home page — signed-in reads chain off auth(), not off Twitch/YouTube", () => {
  // The waterfall this replaces: [session,status,vods] → [twitch,yt,avatar] →
  // [userMeta,canonicalId]. Stage 3 depended only on `session` but paid for
  // stage 2's external API round-trips every signed-in load.
  const src = readFileSync(new URL("../(main)/page.tsx", import.meta.url), "utf8");
  const page = src.slice(src.indexOf("export default async function StreamPage("));
  assert.ok(page.length > 0, "vacuity anchor: StreamPage is gone");
  assert.match(page, /const sessionP = auth\(\)/, "the session read is not kicked off as a promise");
  assert.match(page, /sessionP\.then\(/, "the signed-in reads no longer chain off the session promise");
  assert.match(page, /statusP\.then\(/, "the platform-info reads no longer chain off the status promise");
  // One final barrier, not three sequential ones.
  const barriers = (page.match(/await Promise\.all\(/g) ?? []).length;
  assert.equal(barriers, 1, `expected ONE final await barrier, found ${barriers} — the waterfall is back`);
});

test("30: the two signed-in reads are one round-trip", () => {
  // getUserMeta (site.users) + getCanonicalId (stream.links) would be two
  // parallel queries per signed-in home load; both key on the same matrixId
  // and merge into one statement with identical semantics (independent
  // subselects — a JOIN would drop the canonical when the site.users row is
  // missing). The merged read lives in app/lib/userContext.ts so the
  // /terminal page shares it instead of growing a second copy.
  const page = readFileSync(new URL("../(main)/page.tsx", import.meta.url), "utf8");
  const src = readFileSync(new URL("./userContext.ts", import.meta.url), "utf8");
  const fnAt = src.indexOf("export async function getUserContext(");
  assert.notEqual(fnAt, -1, "getUserContext is gone — the merged read was split again?");
  const fn = src.slice(fnAt, src.indexOf("\n}", fnAt));
  assert.match(fn, /FROM site\.users/);
  assert.match(fn, /\$\{canonicalFromMatrixSql\("\$1"\)\} AS canonical/, "the canonical is read through the one tie-break");
  assert.match(page, /import \{ getUserContext, NO_USER \} from "@\/app\/lib\/userContext"/, "the home page reads the viewer through the shared module");
  assert.doesNotMatch(page, /FROM site\.users|FROM stream\.links/, "the page has grown a query of its own");
  for (const text of [src, page]) {
    assert.doesNotMatch(text, /async function getUserMeta\(/, "the split reads are still defined");
    assert.doesNotMatch(text, /async function getCanonicalId\(/, "the split reads are still defined");
  }
});

// ── Round-3 polish picks (33/34/35/36) — pinned here rather than a new file ──

test("33: the gift done copy branches on giftType — community gifts are not 'right away'", () => {
  const src = readFileSync(new URL("../components/SupportContent.tsx", import.meta.url), "utf8");
  assert.match(src, /giftType === "direct"\s*\n?\s*\? "Gift sent — thank you! The recipient gets Supporter right away\."/,
    "the direct-gift copy lost its branch");
  assert.match(src, /claim them when they sign in/,
    "community gifts claim from gift_pending (up to 90 days) — 'right away' sets up a 'my gift didn't work' report");
});

test("34: navigations fall back to the cached offline page when the network is GONE", () => {
  const sw = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
  assert.match(sw, /const OFFLINE_URL = "\/offline\.html"/, "no offline URL constant");
  const nav = sw.slice(sw.indexOf('req.mode === "navigate"'), sw.indexOf("return;", sw.indexOf('req.mode === "navigate"')));
  assert.match(nav, /fetch\(req\)\.catch/, "navigations must stay network-FIRST — the fallback is for a dead network only");
  assert.match(nav, /caches\.match\(OFFLINE_URL\)/, "the catch serves nothing — the fallback page is unreachable");
  // Pre-cached at install, or the fallback has nothing to fall back to.
  const install = sw.slice(sw.indexOf('addEventListener("install"'), sw.indexOf("});", sw.indexOf('addEventListener("install"')));
  assert.match(install, /addAll\(\[OFFLINE_URL\]\)/, "offline.html is never pre-cached");
  const page = readFileSync(new URL("../offline.html/route.ts", import.meta.url), "utf8");
  // Vacuity anchor on the END of the route (the negative check below goes green over a short read).
  assert.match(page, /return new Response\(body, \{ headers: \{ "Content-Type": "text\/html; charset=utf-8" \} \}\);\n\}\n$/, "the offline route scan lost its end");
  assert.doesNotMatch(page, /src=|href=/, "offline.html references external assets — they are gone exactly when it renders");
});

test("35: the tab title tracks live state, owned by the status poll", () => {
  const src = readFileSync(new URL("../lib/useStreamStatusPoll.ts", import.meta.url), "utf8");
  assert.match(src, /document\.title = live \? `🔴 LIVE — \$\{siteName\(\)\}` : siteName\(\);/,
    "no LIVE tab title — a backgrounded viewer can't see the stream came up");
  // The old hidden-tab poll skip would starve the title exactly when it is
  // the only visible surface.
  assert.doesNotMatch(src, /if \(!document\.hidden\) poll\(\)/,
    "the hidden-tab skip is back — the LIVE title never updates in the one state it exists for");
});

test("36: no window.confirm/prompt remains on the viewer-facing money surfaces", () => {
  for (const rel of ["../components/AccountLinkPanel.tsx"]) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    // Vacuity anchor for a negative scan: the file read is the real component.
    assert.match(src, /export default function AccountLinkPanel\(/, `${rel}: not the component this scan guards — moved? update the path`);
    assert.doesNotMatch(src, /window\.(confirm|prompt)\(/,
      `${rel}: a native dialog is back — unstyled, tab-blocking, and trivially mis-tapped on mobile`);
  }
});
