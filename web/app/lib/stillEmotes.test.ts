// Animated emotes off — still frames. Run:
//   node --test app/lib/stillEmotes.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
const read = (...p: string[]) => { const r = readFileSync(join(process.cwd(), ...p), "utf8"); assert.ok(r.trimEnd().length > 500); return stripComments(r); };

test("the emote API fills a still URL for animated Twitch and 7TV emotes", () => {
  const api = read("app", "api", "emotes", "route.ts");
  assert.match(api, /\/static\/dark\/3\.0/, "Twitch static URL missing");
  assert.match(api, /static_name/, "7TV static file not used");
});

test("renderText swaps to the still URL only when asked, and only when one exists", () => {
  const rt = read("app", "lib", "renderText.tsx");
  assert.match(rt, /opts\?\.still && seg\.still \? seg\.still : seg\.url/);
  // Per-message (IRC-tag) Twitch emotes pause too — both the whole-word and the
  // split-word path.
  assert.equal((rt.match(/twitchStillUrl\((msgUrl|pMsgUrl)\)/g) ?? []).length, 2);
});

test("the switch defaults on and is read once at the list level", () => {
  const reg = read("app", "lib", "settingsRegistry.ts");
  assert.match(reg, /animEmotesOn:\s*true,/);
  for (const f of ["ChatSidebar.tsx", "ChatWindow.tsx", "ChatOverlay.tsx"])
    assert.match(read("app", "features", "chat", f), /useSetting\("chatStyle_animEmotes"\)/, `${f} does not read the switch`);
});

// Fix round 1 (controller ruling): a redacted/Supporter chat row is still a
// chat row — RedactedText.tsx's own renderText calls (visible-run text,
// misaligned-reveal plaintext, aligned per-word reveal) must not be the one
// place in the app where the switch is silently ignored. Every renderText
// call in the file must pass `still: stillEmotes` — counting occurrences (not
// just "at least one") is what catches a fourth call added later that forgets it.
test("RedactedText.tsx threads still: stillEmotes through every renderText call", () => {
  const rtx = read("app", "components", "RedactedText.tsx");
  const calls = rtx.match(/renderText\(/g) ?? [];
  const withStill = rtx.match(/still:\s*stillEmotes/g) ?? [];
  assert.ok(calls.length > 0, "no renderText calls found — has this file moved?");
  assert.equal(withStill.length, calls.length, "every renderText call in RedactedText.tsx must pass { still: stillEmotes }");
});
