// One mute rule for the three live sources.
//
// THE DEFECT THIS PINS. `narrow || autoMute` force-muted stream.place so muted
// autoplay — which is always permitted — would succeed on a phone. YouTube and
// Twitch got `autoMute` alone, attempted unmuted autoplay, were refused, and
// started nothing; recovery depended on the blocked-autoplay panel, which exists
// only when the platform's API script loaded.
//
// THE SECOND DEFECT THIS PINS. Once all three sources took `narrow || autoMute`,
// the viewport half became a live matchMedia subscription feeding ytSrc (which
// StreamPlayerArea uses as a React key), twSrc, and twStartMuted (part of the
// Twitch adapter's `create` identity). A desktop viewer dragging their window
// across the breakpoint therefore had the live stream torn down, rebuilt and
// silently muted — and again on the way back. The mobile clause is now LATCHED
// to its first post-hydration value; the SETTING stays live, because a settings
// toggle must still apply immediately.
//
// Run: node --test app/lib/playerStartMuted.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const here = dirname(fileURLToPath(import.meta.url));
const viewPath = join(here, "..", "components", "StreamView.tsx");
const src = stripComments(readFileSync(viewPath, "utf8"));

test("one value is derived, and it is the one with the mobile clause", () => {
  assert.match(src, /const startMuted = narrowAtStart \|\| autoMute;/);
});

test("the mobile clause is latched; the setting stays live", () => {
  // The latch reads the media query DIRECTLY, not the hook's value: during the
  // hydration render useNarrowViewport still serves its server snapshot
  // (`false`), so a mount effect closing over it would latch "desktop" on every
  // phone — silently undoing the mute this whole file exists to pin.
  assert.match(src, /setNarrowAtStart\(narrowViewportNow\(\)\)/,
    "the latch must take its value from the media query, not from the hook's hydration-render value");
  // Initial `false` is the hydration contract: it must equal useNarrowViewport's
  // server snapshot or the first client render disagrees with the server's markup.
  assert.match(src, /const \[narrowAtStart, setNarrowAtStart\] = useState\(false\);/,
    "the latch must start at the server snapshot value (false) or hydration mismatches");
  // Empty dep array = latched ONCE. With `narrow` in the deps it would track the
  // subscription again and the churn comes straight back.
  assert.match(src, /setNarrowAtStart\(narrowViewportNow\(\)\)\);?\s*\}, \[\]\);/,
    "the latch effect must run once (empty dependency array), not follow the viewport");
  // The regression itself, by name.
  assert.doesNotMatch(src, /const startMuted = narrow \|\| autoMute;/,
    "startMuted must not read the live viewport subscription — that rebuilds and mutes a playing desktop stream on resize");
  // …and the setting is still read live, from its own storage hook.
  assert.match(src, /const autoMute = autoMuteRaw === "1";/,
    "the auto-mute setting must stay a live read so a settings toggle applies immediately");
});

test("all three live sources take it", () => {
  assert.match(src, /youtubeLiveSrc\(\{[^}]*autoMute: startMuted[^}]*\}\)/,
    "the YouTube live embed must start muted on a phone");
  assert.match(src, /player\.twitch\.tv[\s\S]{0,160}?startMuted \? "&muted=true"/,
    "the Twitch live embed must start muted on a phone");
  assert.match(src, /twStartMuted=\{startMuted\}/,
    "the Twitch adapter path takes a constructor option, not a query param");
  assert.match(src, /spStartMuted=\{startMuted\}/,
    "the in-house player takes a prop");
});

test("no live source is left on the bare setting", () => {
  // Deliberately NOT a count of `autoMute` occurrences: the identifier is a
  // substring of `autoMuteRaw`, of the storage key, and of youtubeLiveSrc's own
  // option NAME, so a count is both fragile and satisfiable by the wrong
  // instances. Each site that was actually wrong is pinned instead.
  assert.doesNotMatch(src, /twStartMuted=\{autoMute\}/,
    "the Twitch adapter path must not take the bare setting");
  assert.doesNotMatch(src, /autoMute \? "&muted=true"/,
    "the Twitch embed URL must not take the bare setting");
  assert.doesNotMatch(src, /youtubeLiveSrc\(\{[^}]*\bautoMute\s*[,}]/,
    "the YouTube live embed must not take the bare setting (ES6 shorthand `autoMute` followed by `,` or `}`, not `autoMute: startMuted`) — formatting-tolerant: keys on autoMute's next token, not on whitespace or line breaks");
});

test("VACUITY ANCHOR: the scanned file was read to the END", () => {
  const raw = readFileSync(viewPath, "utf8");
  assert.match(raw.trimEnd().slice(-40), /\);?\s*$/,
    "StreamView.tsx did not end with a closing paren or brace — the read was truncated");
});
