// #250 (k, 2026-11-06): "toggle to turn on/off streamer focus highlight (on streamer side)".
// Admin Panel › Site › Site › Streamer highlight: one switch, `chat.spotlight.off` (default off =
// today's behaviour). Switched on, the streamer's click highlights nothing and NO viewer sees a
// highlight: the web route forwards a clear instead of the pick, saving the switch takes down the
// pick showing now (stream-api holds it in memory and replays it to every connecting client, so a
// pick left in place would keep reaching new viewers), and the streamer's rows stop offering the
// click at all.
//
// The decisions run here; the wiring around them is scanned (the routes import @/ aliases that
// node --test cannot resolve — app/api/badges/route.test.ts's header).
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G node --test app/lib/spotlightSwitch.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import { SPOTLIGHT_OFF_KEY, spotlightToForward, takesDownSpotlight } from "./spotlightSwitch.ts";
import { INSTANCE_KEYS } from "./instanceSchema.generated.mjs";
import { KEY_GROUPS } from "../features/instance/adminLayout.ts";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string, tail: RegExp) => {
  const raw = readFileSync(join(app, rel), "utf8");
  assert.match(raw.trimEnd().slice(-300), tail, `${rel} did not end as expected — truncated read`);
  return stripComments(raw);
};
const PICK = { platform: "twitch", messageId: "17" };

// ── the decisions ───────────────────────────────────────────────────────────

test("switch on: a click forwards a clear, never the pick", () => {
  assert.equal(spotlightToForward(PICK, true), null);
  assert.equal(spotlightToForward(null, true), null);
});

test("switch off (the default): the pick goes through exactly as today", () => {
  assert.deepEqual(spotlightToForward(PICK, false), PICK);
  assert.equal(spotlightToForward(null, false), null, "a second click still clears");
});

test("retry: clicking again and again while switched on keeps forwarding a clear", () => {
  for (let i = 0; i < 3; i++) assert.equal(spotlightToForward({ platform: "native", messageId: i + 1 }, true), null);
});

test("saving the switch on takes the current pick down; any other save, or switching it back, does not", () => {
  assert.equal(takesDownSpotlight(SPOTLIGHT_OFF_KEY, true), true);
  assert.equal(takesDownSpotlight(SPOTLIGHT_OFF_KEY, false), false, "switching the highlight back on leaves nothing to clear");
  assert.equal(takesDownSpotlight("chat.autoPin.off", true), false, "the Auto-pin switch is a different thing");
});

// ── the setting ─────────────────────────────────────────────────────────────

test("the key: a live server bool, default off, in the Auto-pin card's shape and section", () => {
  const e = INSTANCE_KEYS.find((k) => k.key === SPOTLIGHT_OFF_KEY);
  assert.ok(e, "chat.spotlight.off is in the instance schema");
  assert.equal(e.kind, "bool");
  assert.equal(e.default, false, "unset = the highlight works, as before");
  assert.equal(e.scope, "server");
  assert.equal(e.reload, "live");
  assert.equal(e.tier, "instance");
  assert.deepEqual(e.packages, ["web"]);
  const card = KEY_GROUPS.find((c) => c.keys.includes(SPOTLIGHT_OFF_KEY));
  assert.ok(card, "the switch has a card");
  assert.equal(card.section, "site");
  assert.equal(card.sub, "general", "beside Auto-pin, where the other stream dials are");
  assert.equal(card.title, "Streamer highlight");
});

// ── the wiring ──────────────────────────────────────────────────────────────

test("restart: the route reads the switch at every click (a restarted web reads the saved value; stream-api restarts empty)", () => {
  const src = read("api/chat/spotlight/route.ts", /return Response\.json\(\{ spotlight \}\);\s*}\s*$/);
  const post = src.slice(src.indexOf("export async function POST("));
  assert.match(post, /spotlight = spotlightToForward\(spotlight, spotlightOff\(\)\);/, "decided inside POST, never cached at module load");
  assert.ok(post.indexOf("spotlightToForward(") < post.indexOf('streamApiFetch("/chat/spotlight"'), "decided before anything is forwarded");
  assert.match(post, /body: JSON\.stringify\(\{ spotlight \}\)/, "what is forwarded is the decided value");
});

test("saving or clearing the switch takes down the pick showing now", () => {
  const src = read("api/admin/instance/[key]/route.ts", /\}\s*$/);
  const put = src.slice(src.indexOf("export async function PUT("), src.indexOf("export async function DELETE("));
  const del = src.slice(src.indexOf("export async function DELETE("));
  for (const [name, body] of [["PUT", put], ["DELETE", del]] as const) {
    assert.match(body, /await afterSpotlightSave\(name\);/, `${name} runs the take-down`);
    assert.ok(body.indexOf("reloadInstanceConfig()") < body.indexOf("afterSpotlightSave(name)"), `${name}: after the new value is loaded`);
  }
  const server = read("lib/spotlightServer.ts", /\}\s*$/);
  assert.match(server, /if \(takesDownSpotlight\(key, spotlightOff\(\)\)\)/);
  assert.match(server, /streamApiFetch\("\/chat\/spotlight", \{[\s\S]*JSON\.stringify\(\{ spotlight: null \}\)/);
  assert.match(server, /instanceBool\(SPOTLIGHT_OFF_KEY\)/);
});

test("the streamer's rows offer the click only while the highlight is on", () => {
  const hook = read("lib/useChatSpotlight.ts", /\}\s*$/);
  assert.match(hook, /export function useSpotlightSwitch\(isAdmin: boolean\): boolean/);
  assert.match(hook, /fetch\("\/api\/chat\/spotlight\/switch"/);
  assert.match(hook, /"bb:instance-changed"/, "a switch flipped in the Admin Panel reaches the open page");
  const sw = read("api/chat/spotlight/switch/route.ts", /\}\s*$/);
  assert.match(sw, /const me = await requireAdmin\(\);\s*if \(!me\) return new Response\("Forbidden", \{ status: 403 \}\);/);
  assert.match(sw, /Response\.json\(\{ on: !spotlightOff\(\) \}/);
  const sb = read("features/chat/ChatSidebar.tsx", /\);\s*}\s*$/);
  assert.match(sb, /const canSpotlight = useSpotlightSwitch\(isAdmin\);/);
  assert.match(sb, /onSpotlight=\{canSpotlight \? handleSpotlight : undefined\}/);
  const cw = read("features/chat/ChatWindow.tsx", /\);\s*}\s*$/);
  assert.match(cw, /const canSpotlight = useSpotlightSwitch\(me\.isAdmin\);/);
  assert.match(cw, /onSpotlight=\{canSpotlight \? handleSpotlight : undefined\}/);
  const cards = read("features/instance/KeyCards.tsx", /\}\s*$/);
  assert.match(cards, /dispatchEvent\(new CustomEvent\("bb:instance-changed", \{ detail: k\.key \}\)\)/);
});
