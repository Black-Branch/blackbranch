// The Admin Panel holds every instance key: every key must land in exactly one section, every AI
// task must land in a tab, and the two old URLs (the Credentials and AI pages) must answer with a
// permanent redirect.
// Run: node --test app/features/instance/adminLayout.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTANCE_KEYS } from "../../lib/instanceSchema.generated.mjs";
import { ADMIN_SECTIONS, SUBS, KEY_GROUPS, aiSubOf, keyGroupsFor, isAdminSection, guidesFor } from "./adminLayout.ts";
import { SETUP_GUIDES } from "../../lib/setup/setupGuideMap.ts";
import { MODULES, SETUP_CORE } from "../../lib/instanceSchema.generated.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, "../../..");

/** Every card in the panel, walked the way the panel renders them. */
function allGroups() {
  return ADMIN_SECTIONS.flatMap((s) => (SUBS[s.key].length ? SUBS[s.key].map((x) => x.key) : [null]).flatMap((sub) => keyGroupsFor(s.key, sub)));
}

test("every key the Credentials page listed sits in exactly one card, and no card names an unknown key", () => {
  // The AI page's keys and the setup pages' own progress are not cards (instanceAdminView.ts).
  const listed = INSTANCE_KEYS.filter((e) => !e.surface).map((e) => e.key);
  assert.ok(listed.length >= 50, `vacuity: only ${listed.length} keys read from the schema`);
  const placed = allGroups().flatMap((g) => g.keys);
  const seen = new Map<string, number>();
  for (const k of placed) seen.set(k, (seen.get(k) ?? 0) + 1);
  for (const k of listed) assert.equal(seen.get(k), 1, `${k} is placed ${seen.get(k) ?? 0} times`);
  const known = new Set(INSTANCE_KEYS.map((e) => e.key));
  for (const k of placed) assert.ok(known.has(k), `the layout names ${k}, which the schema does not have`);
  assert.equal(placed.length, listed.length, "a card holds a key the Credentials page did not list");
});

test("each admin section holds the number of keys the move table places in it", () => {
  const per = Object.fromEntries(ADMIN_SECTIONS.map((s) => [s.key, allGroups().filter((g) => g.section === s.key).flatMap((g) => g.keys).length]));
  assert.deepEqual(per, { ai: 4, utility: 13, payments: 12, platforms: 18, site: 68, doctor: 0, updates: 0 });
  // The Doctor and Updates sections hold checks and the box's files, not keys.
  assert.deepEqual(SUBS.doctor, []);
  assert.deepEqual(SUBS.updates, []);
  // Every module switch is on Site → Modules, and nothing else is.
  const switches = INSTANCE_KEYS.filter((e) => e.key.startsWith("modules.")).map((e) => e.key);
  assert.ok(switches.length >= 4, `vacuity: only ${switches.length} module switches in the schema`);
  assert.deepEqual(keyGroupsFor("site", "modules").flatMap((g) => g.keys).sort(), [...switches].sort());
  assert.deepEqual(keyGroupsFor("utility", "obs").flatMap((g) => g.keys), ["timer.pauseScene", "obs.url", "obs.password", "obs.soundSource", "obs.botScene", "obs.botSource", "obs.botShowScene", "homeassistant.url", "homeassistant.token"]);
  // A public install's OBS tab shows the rig page and the pause scene, never the WebSocket cards.
  assert.deepEqual(keyGroupsFor("utility", "obs", false).flatMap((g) => g.keys), ["timer.pauseScene", "homeassistant.url", "homeassistant.token"]);
  assert.deepEqual(INSTANCE_KEYS.filter((e) => e.surface === "rig").map((e) => e.key), ["obs.rigKeyVersion"], "the rig key's generation is the rig panel's, never a card");
  // The shell's 18 + the identity sweep's 7 (short name, share line, icon folder, the four legal.*)
  // + the legacy Matrix prefix + the federation and sign-up switches and the two bootstrap room ids
  // + running the site: time zone, data since, quiet hour, bug reports
  // + backups: target, address, region, the bucket's two keys, daily and weekly kept
  // + the legacy site id
  // + who may sign in from other servers: mode, allow list, deny list.
  assert.equal(keyGroupsFor("site", "general").flatMap((g) => g.keys).length, 45, "the Site cards");
  // The federated sign-in policy is its own card, right after the Community server card.
  const titles = keyGroupsFor("site", "general").map((g) => g.title);
  assert.equal(titles[titles.indexOf("Community server") + 1], "Sign-in from other servers");
  assert.deepEqual(keyGroupsFor("site", "general").find((g) => g.title === "Sign-in from other servers")?.keys, ["auth.federatedSignin", "auth.federatedAllow", "auth.federatedDeny"]);
  // Sign-up sits beside federation, and says it governs the BUNDLED homeserver only: an install
  // whose homeserver runs elsewhere shows the same card and must not think it closed anything.
  const community = keyGroupsFor("site", "general").find((g) => g.title === "Community server")?.keys ?? [];
  assert.equal(community.indexOf("matrix.registration"), community.indexOf("matrix.federation") + 1);
  const signup = INSTANCE_KEYS.find((e) => e.key === "matrix.registration");
  assert.deepEqual(signup?.values, ["open", "closed"]);
  assert.match(signup?.label ?? "", /bundled homeserver/);
  assert.match(signup?.description ?? "", /Applies only to the homeserver this install's bundle runs/);
  assert.deepEqual([...(keyGroupsFor("site", "general").find((g) => g.title === "Backups")?.keys ?? [])].sort(),
    INSTANCE_KEYS.filter((e) => e.key.startsWith("backup.")).map((e) => e.key).sort(), "every backup setting is on the Backups card");
  assert.deepEqual(INSTANCE_KEYS.filter((e) => e.surface === "setup").map((e) => e.key), ["setup.completedAt", "setup.state"],
    "the setup pages' own progress is never a card");
  assert.deepEqual(keyGroupsFor("payments", "connections").find((g) => g.title === "Links")?.keys, ["money.subscribeUrl", "money.supportLine"]);
  assert.deepEqual(keyGroupsFor("site", "general").find((g) => g.title === "Legal")?.keys,
    ["legal.operator", "legal.contactEmail", "legal.governingLaw", "legal.effectiveDate"]);
  const points = keyGroupsFor("site", "points").flatMap((g) => g.keys);
  assert.equal(points.length, 16);
  assert.deepEqual(INSTANCE_KEYS.filter((e) => e.module === "currency").map((e) => e.key).sort(), [...points].sort(),
    "every currency setting is on the Points screen, and nothing else is");
});

test("every card sits in a sub-tab its section has (or none, for a section without sub-tabs), so the panel walks it", () => {
  assert.ok(KEY_GROUPS.length >= 10, "vacuity: the layout's cards were not read");
  for (const g of KEY_GROUPS) {
    const subs = SUBS[g.section].map((x) => x.key);
    if (subs.length) assert.ok(g.sub !== null && subs.includes(g.sub), `${g.title} is in ${g.sub}, not a ${g.section} sub-tab`);
    else assert.equal(g.sub, null, `${g.title}: ${g.section} has no sub-tabs`);
  }
  assert.equal(allGroups().length, KEY_GROUPS.length, "a card the panel never renders");
  assert.deepEqual(ADMIN_SECTIONS.map((s) => s.label), ["AI", "Utility", "Payments", "Platforms", "Site", "Doctor", "Updates"]);
  assert.deepEqual(SUBS.ai.map((s) => s.label), ["Models", "Chat Bot", "Scoring", "Automod", "Help Desk", "Embeddings"]);
  assert.equal(isAdminSection("site"), true);
  assert.equal(isAdminSection("credentials"), false);
});

test("AI tasks and prompts: each lands in its tab; nothing falls out of the panel", () => {
  assert.equal(aiSubOf("bot.reply", "product"), "bot");
  assert.equal(aiSubOf("automod.classify", "product"), "automod");
  assert.equal(aiSubOf("helpdesk.answer", "product"), "helpdesk");
  assert.equal(aiSubOf("embeddings", "product"), "embeddings");
  assert.equal(aiSubOf("score.karma", "plugin"), "scoring");
  assert.equal(aiSubOf("someplugin.brain", "plugin"), "bot", "a plugin's other tasks go with the chat bot");
  assert.equal(aiSubOf("radio.dj", "plugin"), "models", "the radio DJ is not a chat-bot task");
  assert.equal(aiSubOf("search.rank", "product"), "models", "a product task with no tab of its own shows under Models");
  const tabs = new Set(SUBS.ai.map((s) => s.key));
  for (const id of ["x", "a.b.c", ""]) for (const g of ["product", "plugin"] as const) assert.ok(tabs.has(aiSubOf(id, g)));
});

test("the two old pages are gone and answer 308 to their section", () => {
  assert.equal(existsSync(join(WEB, "app/(main)/mod/ai/page.tsx")), false);
  assert.equal(existsSync(join(WEB, "app/(main)/mod/credentials/page.tsx")), false);
  const cfg = readFileSync(join(WEB, "next.config.ts"), "utf8");
  assert.match(cfg, /\{ source: "\/mod\/ai", destination: "\/admin\/ai", permanent: true \}/);
  assert.match(cfg, /\{ source: "\/mod\/credentials", destination: "\/admin\/site", permanent: true \}/);
});

test("ONE source — every setup list is a guide on exactly one tab, and every field its steps fill is a card on that tab", () => {
  type Step = { id: string; fields: string[] };
  const lists: [string, Step[]][] = [
    ...(MODULES as { id: string; kind: string; setup?: Step[] }[]).filter((m) => m.kind === "module" && m.setup?.length).map((m) => [`module:${m.id}`, m.setup!] as [string, Step[]]),
    ...(SETUP_CORE as { id: string; release: string; steps: Step[] }[]).filter((c) => c.release === "now").map((c) => [`core:${c.id}`, c.steps] as [string, Step[]]),
  ];
  assert.ok(lists.length >= 8, `vacuity: ${lists.length} setup lists read`);
  assert.deepEqual(SETUP_GUIDES.map((g) => g.list).sort(), lists.map(([l]) => l).sort(), "each list has exactly one guide, and no guide names an unknown list");
  for (const g of SETUP_GUIDES) {
    assert.ok(isAdminSection(g.section) && SUBS[g.section].some((x) => x.key === g.sub), `${g.list}: ${g.section}/${g.sub} is not a tab`);
    const onTab = new Set(keyGroupsFor(g.section as never, g.sub).flatMap((c) => c.keys));
    for (const step of lists.find(([l]) => l === g.list)![1]) {
      for (const f of step.fields) assert.ok(onTab.has(f), `${g.list}/${step.id}: ${f} is not on ${g.section}/${g.sub}`);
    }
    assert.ok(guidesFor(g.section as never, g.sub).includes(g.list));
  }
  assert.deepEqual(guidesFor("platforms", "twitch"), ["core:twitch"]);
  assert.deepEqual(guidesFor("payments", "connections"), ["module:stripe", "module:paypal", "core:donations"]);
});
