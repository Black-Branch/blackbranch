import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";

// Pronouns on the site side. stream-api's /identity/pronoun-command is the ONE
// parser; every web path that sets pronouns — the chat box's `!` lines,
// `/pronouns`, Edit profile, a mod's card, `/pronouns @name she/her` — goes
// through askPronounCommand. Separate lists in web (the send route's regex,
// the command runner's map, the me route's allowlist) would disagree about
// what `!pronouns she/her` means.
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const code = (p: string) => stripComments(read(p));

test("the helper is the only caller of stream-api's parser, and holds the usage line", () => {
  const helper = read("./pronounCommand.ts");
  assert.match(helper, /streamApiFetch\("\/identity\/pronoun-command"/);
  assert.match(helper, /export const PRONOUN_USAGE = "Set them with !he, !she or !they \(or !pronouns she\/her\)\.";/);
  for (const p of ["../api/chat/send/route.ts", "../api/me/pronouns/route.ts", "../api/mod/pronouns/route.ts"]) {
    const src = code(p);
    assert.match(src, /askPronounCommand\(/, `${p} does not ask the one parser`);
    assert.doesNotMatch(src, /"\/identity\/pronoun|"he\/him"|!\(he\|she/, `${p} carries a pronoun list or call of its own`);
  }
  assert.doesNotMatch(code("./commands/run.ts"), /"she\/her": "she\/her"|"her": "she\/her"/, "the runner's own map is back");
});

test("Edit profile and /pronouns go through the parser as the person (self)", () => {
  const me = read("../api/me/pronouns/route.ts");
  assert.match(me, /askPronounCommand\(\{ text: `!pronouns \$\{[^}]+\}`, matrixId \}\)/);
  assert.match(me, /export async function POST\(/);
  assert.match(me, /export async function PATCH\(/);
  assert.match(me, /export async function DELETE\(/);
});

test("the mod route checks the role FIRST, writes as mod, logs it, and refuses an ambiguous name", () => {
  const src = read("../api/mod/pronouns/route.ts");
  const guard = src.indexOf("const mod = await requireMod();");
  assert.notEqual(guard, -1);
  assert.ok(guard < src.indexOf("askPronounCommand("), "the role check must run before anything is written");
  assert.match(src, /source: "mod"/);
  assert.match(src, /appendModLog\(\{ action: "pronouns_set", target: canonicalId, by: mod, reason: r\.pronouns \?\? "cleared" \}\)/);
  assert.doesNotMatch(code("../api/mod/pronouns/route.ts"), /nameidx/, "the name index holds only a name's FIRST owner");
  // A name is resolved first WITHOUT a write (resolveOnly), the ceiling judges that person, then the
  // write goes by canonicalId.
  assert.match(src, /askPronounCommand\(\{ text: `!pronouns \$\{value\}`, name, source: "mod", resolveOnly: true \}\)/);
  assert.match(src, /askPronounCommand\(\{ text: `!pronouns \$\{value\}`, canonicalId, source: "mod" \}\)/);
  assert.match(src, /if \(who\.ambiguous\) \{\s*return Response\.json\(\{ error: "More than one person[^"]*" \}, \{ status: 409 \}\);/);
  assert.match(src, /if \(who\.notFound\) return Response\.json\(\{ error: "[^"]*" \}, \{ status: 404 \}\);/);
  const ceiling = src.indexOf("assertCanModerate(mod, target)");
  assert.ok(ceiling > 0 && ceiling < src.indexOf("canonicalId, source: \"mod\" })"), "the ceiling must run before the write");
  assert.match(read("./modlog.ts"), /\| "pronouns_set"/);
  assert.match(src.trimEnd(), /\}$/, "END anchor");
});

test("/pronouns @name she/her is the mod form; /pronouns she stays the person's own", () => {
  const run = read("./commands/run.ts");
  assert.match(run, /if \(a\.startsWith\("@"\) && b\) \{[\s\S]{0,200}postJson\("\/api\/mod\/pronouns", \{ name: a\.slice\(1\), value: b \}\)/);
  assert.match(run, /postJson\("\/api\/me\/pronouns", \{ command: a \}\)/);
});

test("a mod's card offers the picker, keyed on the card's own identity", () => {
  const card = read("../components/UserCard.tsx");
  assert.match(card, /aria-label="Set their pronouns"/);
  assert.match(card, /postJson\("\/api\/mod\/pronouns", \{ \.\.\.pronounTarget, value \}\)/);
  // The canonical is the mod lookup's (useModIds) — a chat line carries only its public id.
  assert.match(card, /const pronounTarget = modIds\.canonicalId \? \{ canonicalId: modIds\.canonicalId \} : msg\.matrixId \? \{ matrixId: msg\.matrixId \} : null;/);
});

test("/legal names alejo.io among who we share with", () => {
  const legal = read("../legal/LegalDocument.tsx");
  const start = legal.indexOf("<H3>Who we share with</H3>");
  const block = legal.slice(start, legal.indexOf("</UL>", start));
  assert.match(block, /alejo\.io/);
  assert.match(block, /Twitch username/);
});

test("a site `!she` that worked says so under the chat box (decision 3: commands always answer)", async () => {
  await import("./testTsx.ts");
  const { useSendChatMessage } = await import("./useSendChatMessage.ts");
  const { onChatNotice } = await import("./chatNotice.ts");
  const seen: string[] = [];
  const off = onChatNotice((t) => seen.push(t));
  const realFetch = globalThis.fetch;
  const send = useSendChatMessage(() => {});
  try {
    for (const [pronouns, line] of [["she/her", "✓ Pronouns set to she/her"], [null, "✓ Pronouns cleared"]] as const) {
      globalThis.fetch = (async () => Response.json({ ok: true, pronouns })) as typeof fetch;
      assert.equal(await send("!she", null), null);
      assert.equal(seen.at(-1), line);
    }
    globalThis.fetch = (async () => Response.json({ ok: true, sentTo: "twitch" })) as typeof fetch;
    const before = seen.length;
    await send("hello", null);
    assert.equal(seen.length, before, "an ordinary message shows no pronoun line");
  } finally {
    globalThis.fetch = realFetch;
    off();
  }
});
