// Emote images from the CORS-capable CDNs are requested in one CORS mode everywhere (crossOrigin
// "anonymous" = credentials "same-origin"), and the service worker caches exactly those hosts and
// forwards the page's own request on a miss (swEmoteCache.test.ts).
//
// Measured on a local install (production build, a new tab per visit, three rounds each): the
// first return visit re-downloaded every 7TV emote the browser already held — the picker took
// 4204 / 1039 / 493 ms to show its visible tiles and chat's 7TV emotes p50 1347 / 356 / 211 ms,
// against 84–86 ms and 3–7 ms one visit later. 7TV answers `Vary: origin`: the <img> stored its
// copy with no Origin and the worker asked again in CORS mode, so the copy never matched. After:
// picker 70–97 ms and chat 7TV p50 10–12 ms on the first return visit in five rounds of six.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emoteCrossOrigin } from "./emoteRes.ts";
import { stripComments } from "./testSource.ts";

const ROOT = process.cwd();

test("CORS-capable emote hosts get crossOrigin=anonymous; BTTV (no CORS header) and others get none", () => {
  assert.equal(emoteCrossOrigin("https://cdn.7tv.app/emote/01ABC/2x.webp"), "anonymous");
  assert.equal(emoteCrossOrigin("https://cdn.frankerfacez.com/emote/9/2"), "anonymous");
  assert.equal(emoteCrossOrigin("https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0"), "anonymous");
  assert.equal(emoteCrossOrigin("https://cdn.betterttv.net/emote/54fa8fce01e468494b85b53c/2x.png"), undefined);
  assert.equal(emoteCrossOrigin("https://evil7tv.app.example/x.webp"), undefined, "a look-alike host is not one of ours");
  assert.equal(emoteCrossOrigin("/api/avatar/public/bot"), undefined);
  assert.equal(emoteCrossOrigin(""), undefined);
});

test("the service worker caches exactly the hosts the page requests in CORS mode", () => {
  const sw = readFileSync(join(ROOT, "public", "sw.js"), "utf8");
  const m = /const EMOTE_HOSTS = \/(.*)\/([a-z]*);/.exec(sw);
  assert.ok(m, "EMOTE_HOSTS is gone from sw.js");
  const swHosts = new RegExp(m![1]!, m![2]);
  for (const h of ["cdn.7tv.app", "cdn.frankerfacez.com", "static-cdn.jtvnw.net", "cdn.betterttv.net", "x.example"]) {
    assert.equal(swHosts.test(h), emoteCrossOrigin(`https://${h}/e`) === "anonymous", `host ${h}: worker and page disagree`);
  }
});

// Every place that requests a catalog emote image: the same CORS mode, or the image cache and the
// HTTP cache hold two copies and the worker cannot use the page's.
const SITES: Array<[string, RegExp]> = [
  ["app/lib/renderText.tsx", /crossOrigin=\{emoteCrossOrigin\(sizedSrc\)\}/],
  ["app/components/EmotePicker.tsx", /crossOrigin=\{emoteCrossOrigin\(src\)\}/],
  ["app/lib/emotePickerWarm.ts", /img\.crossOrigin = /],
  ["app/lib/emoteWarmer.ts", /emoteCrossOrigin\(url\)/],
  ["app/features/chat/ChatMessage.tsx", /crossOrigin=\{emoteCrossOrigin\(msg\.emoteUrl \?\? ""\)\}/],
  ["app/components/EmoteCompletionList.tsx", /crossOrigin=\{emoteCrossOrigin\(url\)\}/],
  ["app/components/ReactionPicker.tsx", /crossOrigin=\{emoteCrossOrigin\(e\.url\)\}[\s\S]*crossOrigin=\{emoteCrossOrigin\(info\.url\)\}/],
  ["app/features/home/widgets/BoardsWidget.tsx", /crossOrigin=\{emoteCrossOrigin\(r\.emoteUrl \?\? ""\)\}/],
];

test("the warmer's CORS request carries the image's credentials mode, not omit", () => {
  // <img crossOrigin="anonymous"> sends credentials "same-origin". The worker's own "omit" request
  // missed the copy the page had made (measured: the fix only worked once the worker forwarded the
  // page's request), so the warmer must not use "omit" either.
  const src = stripComments(readFileSync(join(ROOT, "app/lib/emoteWarmer.ts"), "utf8"));
  assert.match(src, /mode: "cors", credentials: "same-origin"/);
  assert.doesNotMatch(src, /credentials: "omit"/);
});

test("every emote image request site uses the same CORS mode", () => {
  for (const [file, re] of SITES) {
    const src = stripComments(readFileSync(join(ROOT, file), "utf8"));
    assert.match(src.trimEnd(), /\}\)?;?$/, `${file}: END anchor — the file was not read whole`);
    assert.match(src, re, `${file} requests emotes without the shared CORS mode`);
  }
});
