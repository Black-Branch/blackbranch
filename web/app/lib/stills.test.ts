// web/app/lib/stills.test.ts
// Stickers and badges pause with "animated emotes" off. Stickers use the
// provider's still frame; site badges (uploaded images, no provider still) get
// a first frame drawn once in the browser.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/stills.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stickerStillUrl } from "./emoteRes.ts";
import { mayAnimate } from "./stillFrame.ts";
import { stripComments } from "./testSource.ts";

test("sticker stills per provider; unknown hosts have none", () => {
  assert.equal(stickerStillUrl("https://static-cdn.jtvnw.net/emoticons/v2/emotesv2_abc/default/dark/3.0"),
    "https://static-cdn.jtvnw.net/emoticons/v2/emotesv2_abc/static/dark/3.0");
  assert.equal(stickerStillUrl("https://cdn.7tv.app/emote/01ABC/4x.webp"), "https://cdn.7tv.app/emote/01ABC/4x_static.webp");
  assert.equal(stickerStillUrl("https://cdn.7tv.app/emote/01ABC/2x.gif"), "https://cdn.7tv.app/emote/01ABC/2x_static.webp");
  assert.equal(stickerStillUrl("https://cdn.betterttv.net/emote/5f1b/3x.gif"), "https://cdn.betterttv.net/emote/5f1b/static/3x.webp");
  assert.equal(stickerStillUrl("https://cdn.betterttv.net/emote/5f1b/3x"), "https://cdn.betterttv.net/emote/5f1b/static/3x.webp");
  assert.equal(stickerStillUrl("https://cdn.frankerfacez.com/emote/1/4"), undefined);
  assert.equal(stickerStillUrl(""), undefined);
});

test("only images that CAN animate get a drawn first frame", () => {
  assert.equal(mayAnimate("data:image/gif;base64,R0lG"), true);
  assert.equal(mayAnimate("data:image/webp;base64,UklG"), true);
  assert.equal(mayAnimate("data:image/avif;base64,AAAA"), true, "a real install has 5 animated AVIF badges");
  assert.equal(mayAnimate("https://x.example/b.avif"), true);
  assert.equal(mayAnimate("https://x.example/b.gif"), true);
  assert.equal(mayAnimate("data:image/png;base64,iVBOR"), false);
  assert.equal(mayAnimate("data:image/svg+xml;base64,PHN2"), false);
  assert.equal(mayAnimate("https://x.example/b.png"), false);
  // Site badges as served (badgeImage.ts): a same-origin path.
  assert.equal(mayAnimate("/api/badges/image/19/0123456789abcdef.gif"), true);
  assert.equal(mayAnimate("/api/badges/image/13/0123456789abcdef.webp"), true);
  assert.equal(mayAnimate("/api/badges/image/18/0123456789abcdef.png"), false);
});

test("the row uses both when stills are on", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const row = stripComments(readFileSync(path.join(here, "..", "features", "chat", "ChatMessage.tsx"), "utf8"));
  assert.match(row, /src=\{stillEmotes \? \(stickerStillUrl\(msg\.emoteUrl\) \?\? msg\.emoteUrl\) : msg\.emoteUrl\}/);
  assert.match(row, /if \(still && msg\.emoteUrl && e\.currentTarget\.src === still\) \{ e\.currentTarget\.src = msg\.emoteUrl; return; \}/, "only a failing STILL falls back to the animated image (cannot loop with the size ladder)");
  assert.match(row, /<BadgeImg key=\{b\.id\} badge=\{b\} still=\{stillEmotes\} \/>/);
  assert.match(row, /\}\);\s*$/, "vacuity anchor: the memo(...) call closes the file");
});
