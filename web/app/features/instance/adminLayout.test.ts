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
import { ADMIN_SECTIONS, SUBS, KEY_GROUPS, aiSubOf, keyGroupsFor, isAdminSection, guidesFor, adminRail, adminSearch, adminItemFor, ADMIN_HOME, shownKeys, UNPLACED } from "./adminLayout.ts";
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
  // Keys the layout deliberately leaves off every card (UNPLACED says why) are not listed here.
  const listed = INSTANCE_KEYS.filter((e) => !e.surface && !(e.key in UNPLACED)).map((e) => e.key);
  for (const [k, why] of Object.entries(UNPLACED)) {
    assert.ok(INSTANCE_KEYS.some((e) => e.key === k), `UNPLACED names ${k}, which the schema does not have`);
    assert.ok(why.length > 10, `${k}: say why it is on no card`);
  }
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
  assert.deepEqual(per, { ai: 4, utility: 9, payments: 17, platforms: 19, site: 63, doctor: 0, updates: 0 });
  // The Doctor and Updates sections hold checks and the box's files, not keys.
  assert.deepEqual(SUBS.doctor, []);
  assert.deepEqual(SUBS.updates, []);
  // No Modules tab: each product module's switch is on its own feature's page; the owner's never show.
  assert.ok(!SUBS.site.some((x) => x.key === "modules"), "no Site → Modules");
  const switches = INSTANCE_KEYS.filter((e) => e.key.startsWith("modules.")).map((e) => e.key);
  assert.ok(switches.length >= 7, `vacuity: only ${switches.length} module switches in the schema`);
  const home: Record<string, [string, string]> = {
    "modules.obs": ["utility", "obs"], "modules.youtube": ["platforms", "youtube"], "modules.stripe": ["payments", "connections"], "modules.paypal": ["payments", "connections"],
  };
  for (const k of switches) {
    const owner = (MODULES as { id: string; kind: string }[]).find((m) => `modules.${m.id}` === k)?.kind === "owner";
    if (owner) { assert.ok(k in UNPLACED, `${k}: an owner module never appears`); continue; }
    const [section, sub] = home[k] ?? ["?", "?"];
    assert.ok(keyGroupsFor(section as never, sub).some((g) => g.keys.includes(k)), `${k} is on ${section}/${sub}`);
  }
  // Stripe's and PayPal's switches head their own cards.
  assert.equal(keyGroupsFor("payments", "connections").find((g) => g.title === "Stripe")?.keys[0], "modules.stripe");
  assert.equal(keyGroupsFor("payments", "connections").find((g) => g.title === "PayPal")?.keys[0], "modules.paypal");
  // OBS: the switch and the pause scene; the WebSocket, scene-name and lights cards are gone.
  assert.deepEqual(keyGroupsFor("utility", "obs").flatMap((g) => g.keys), ["modules.obs", "timer.pauseScene"]);
  assert.deepEqual(keyGroupsFor("utility", "obs", false).flatMap((g) => g.keys), ["modules.obs", "timer.pauseScene"]);
  for (const k of ["obs.url", "obs.password", "obs.soundSource", "obs.botScene", "obs.botSource", "obs.botShowScene", "homeassistant.url", "homeassistant.token"]) {
    assert.ok(k in UNPLACED, `${k} is on no card`);
  }
  assert.deepEqual(INSTANCE_KEYS.filter((e) => e.surface === "rig").map((e) => e.key), ["obs.rigKeyVersion"], "the rig key's generation is the rig panel's, never a card");
  // Site keeps every key it had but the extra staff accounts, which moved to Moderators as Staff.
  assert.equal(keyGroupsFor("site", "general").flatMap((g) => g.keys).length, 44, "the Site cards (bug reports hidden until a sender exists)");
  assert.deepEqual(keyGroupsFor("site", "moderators").map((g) => [g.title, g.keys]), [["Staff", ["staff.extraMatrixIds"]]]);
  // The federated sign-in policy is its own card, right after the Community card.
  const titles = keyGroupsFor("site", "general").map((g) => g.title);
  assert.equal(titles[titles.indexOf("Community") + 1], "Sign-in from other servers");
  assert.deepEqual(keyGroupsFor("site", "general").find((g) => g.title === "Sign-in from other servers")?.keys, ["auth.federatedSignin", "auth.federatedAllow", "auth.federatedDeny"]);
  // Sign-up sits beside federation, and its description says it governs the BUNDLED homeserver
  // only: an install whose homeserver runs elsewhere must not think it closed anything.
  assert.deepEqual(keyGroupsFor("site", "general").find((g) => g.title === "Community")?.keys, ["matrix.federation", "matrix.registration"]);
  const signup = INSTANCE_KEYS.find((e) => e.key === "matrix.registration");
  assert.deepEqual(signup?.values, ["open", "closed"]);
  assert.equal(signup?.label, "Let people make accounts");
  assert.match(signup?.description ?? "", /Applies only to the homeserver this install's bundle runs/);
  assert.deepEqual([...(keyGroupsFor("site", "general").find((g) => g.title === "Backups")?.keys ?? [])].sort(),
    INSTANCE_KEYS.filter((e) => e.key.startsWith("backup.")).map((e) => e.key).sort(), "every backup setting is on the Backups card");
  assert.deepEqual(INSTANCE_KEYS.filter((e) => e.surface === "setup").map((e) => e.key), ["setup.completedAt", "setup.state"],
    "the setup pages' own progress is never a card");
  assert.deepEqual(keyGroupsFor("payments", "connections").find((g) => g.title === "Links")?.keys, ["money.subscribeUrl", "money.supportLine", "site.donateUrl"]);
  // The beta's switches sit beside what they switch: speech with its key and voices, the
  // subscription price with Stripe, the chatroom override with Kick.
  assert.deepEqual(keyGroupsFor("utility", "tts").find((g) => g.title === "Voice")?.keys, ["tts.enabled", "elevenlabs.apiKey", "tts.voiceCasual", "tts.voiceLoud"]);
  assert.ok(keyGroupsFor("payments", "connections").find((g) => g.title === "Stripe")?.keys.includes("stripe.supporterPriceId"));
  assert.deepEqual(keyGroupsFor("platforms", "kick").flatMap((g) => g.keys).slice(-2), ["kick.chatroomId", "kick.channelId"]);
  assert.deepEqual(keyGroupsFor("site", "general").find((g) => g.title === "Legal")?.keys,
    ["legal.operator", "legal.contactEmail", "legal.governingLaw", "legal.effectiveDate", "legal.liabilityCapUsd"]);
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

test("Site opens on the streamer's name: the Streamer card is the first one, its display name an editable row", () => {
  const site = keyGroupsFor("site", "general");
  assert.ok(site.length >= 5, "vacuity: the Site cards were not read");
  assert.equal(site[0]!.title, "Streamer");
  assert.equal(site[0]!.keys[0], "streamer.displayName");
  // Editable here = not an install key (those are set where the site is built).
  assert.equal(INSTANCE_KEYS.find((e) => e.key === "streamer.displayName")?.tier, "instance");
});

test("federation and sign-in from other servers are worded as two different things", () => {
  const site = keyGroupsFor("site", "general");
  const community = site.find((g) => g.title === "Community");
  const signin = site.find((g) => g.title === "Sign-in from other servers");
  assert.ok(community?.keys.includes("matrix.federation") && signin?.keys.includes("auth.federatedSignin"), "vacuity: the two cards");
  assert.match(community!.blurb ?? "", /exchange messages/);
  assert.match(community!.blurb ?? "", /does not decide who may sign in here/);
  assert.match(signin!.blurb ?? "", /^Who may sign in HERE/);
  assert.match(signin!.blurb ?? "", /not federation/);
});

test("the overlays live on Utility → OBS (no Overlays place), and the search finds them there", () => {
  const rail = adminRail();
  assert.ok(rail.some((x) => x.id === "utility/obs"), "vacuity: the OBS place");
  assert.ok(!rail.some((x) => x.id === "utility/overlays"));
  assert.ok(adminSearch(rail, "browser source").some((x) => x.id === "utility/obs"));
  assert.ok(adminSearch(rail, "support bar").some((x) => x.id === "utility/bar"));
  // An old link to the Overlays place opens OBS, the section's first place.
  assert.equal(adminItemFor(rail, "utility", "overlays").id, "utility/obs");
});

test("the panel opens on Site, not AI: the window's default place is the Site settings page", () => {
  assert.equal(ADMIN_HOME, "site");
  assert.equal(adminItemFor(adminRail(), ADMIN_HOME, undefined).id, "site/general");
  const src = readFileSync(join(here, "AdminWindow.tsx"), "utf8");
  assert.match(src, /section: sectionProp = ADMIN_HOME,/, "AdminWindow opened with no place uses ADMIN_HOME");
  // Vacuity: the whole file was read (it ends with the component's closing lines).
  assert.match(src, /<\/Window>\n {2}\);\n}\n$/);
});

test("Site › Site: every install value sits in ONE closed, read-only Install values card at the bottom; the words stay on top", () => {
  const site = keyGroupsFor("site", "general");
  const last = site.at(-1)!;
  assert.equal(last.title, "Install values");
  assert.equal(last.folded, true);
  assert.equal(last.readOnly, true);
  assert.match(last.blurb ?? "", /change it on the server/);
  // Every install-tier key the Site page holds, except the site's own words, is in that card.
  const words = ["site.name", "site.shortName", "site.description", "site.tagline", "site.homeHeading", "site.homeIntro", "site.iconSet"];
  const legal = ["legal.operator", "legal.contactEmail", "legal.governingLaw", "legal.effectiveDate"];
  const onSite = site.flatMap((g) => g.keys);
  const installTier = onSite.filter((k) => INSTANCE_KEYS.find((e) => e.key === k)?.tier === "install");
  assert.ok(installTier.length >= 15, `vacuity: ${installTier.length} install keys on Site`);
  for (const k of installTier) {
    if (words.includes(k) || legal.includes(k)) continue;
    assert.ok(last.keys.includes(k), `${k} is an install value outside the Install values card`);
  }
  // The sign-in client's secret is an install value too (the installer writes it to the env).
  assert.ok(last.keys.includes("matrix.oauth.clientSecret"));
  // The two room ids are NOT: the installer passes neither to any service; the server's community
  // bootstrap records them in the database. They are facts, in a card of their own that offers no
  // change at all.
  for (const k of ["matrix.rooms.hub", "matrix.rooms.general"]) assert.ok(!last.keys.includes(k), k);
  const rooms = site.find((g) => g.title === "Community rooms")!;
  assert.deepEqual(rooms.keys, ["matrix.rooms.hub", "matrix.rooms.general"]);
  assert.equal(rooms.readOnly, true);
  assert.doesNotMatch(rooms.blurb ?? "", /change it on the server/);
  assert.ok(rooms.readOnlyNote && !/set .* on the server/i.test(rooms.readOnlyNote), "no line telling anyone to set it on the server");
  assert.deepEqual(site.find((g) => g.title === "Site")?.keys, words);
  // No card says the values are set where the site is built.
  for (const g of KEY_GROUPS) assert.doesNotMatch(g.blurb ?? "", /where the site is built/, g.title);
  assert.deepEqual(site.map((g) => g.title), ["Streamer", "Site", "Legal", "Community", "Sign-in from other servers", "Community rooms", "Alerts to your phone", "Running the site", "Backups", "Install values"]);
});

type K = { key: string; packages: { package: string; display: unknown }[] };
const held = (key: string, display: unknown): K => ({ key, packages: [{ package: "web", display }] });

test("the legacy site id and the legacy Matrix prefix show only once set", () => {
  const card = keyGroupsFor("site", "general").find((g) => g.title === "Install values")!;
  const all = card.keys.map((k) => held(k, k.includes("legacy") ? null : "x"));
  const rows = shownKeys(card, all).map((k) => k.key);
  assert.equal(rows.length, card.keys.length - 2, "vacuity: every other row is shown");
  assert.ok(!rows.includes("site.legacyId") && !rows.includes("matrix.legacyNamespace"));
  const set = shownKeys(card, card.keys.map((k) => held(k, "x"))).map((k) => k.key);
  assert.ok(set.includes("site.legacyId") && set.includes("matrix.legacyNamespace"), "set: shown");
});

test("Backups: the bucket's region and keys show only while the target is a bucket", () => {
  const card = keyGroupsFor("site", "general").find((g) => g.title === "Backups")!;
  const bucket = ["backup.s3.region", "backup.s3.accessKeyId", "backup.s3.secretAccessKey"];
  const rows = (target: string) => shownKeys(card, card.keys.map((k) => held(k, k === "backup.target" ? target : "x"))).map((k) => k.key);
  for (const t of ["local", "sftp"]) {
    assert.equal(rows(t).length, card.keys.length - 3, `vacuity (${t})`);
    for (const k of bucket) assert.ok(!rows(t).includes(k), `${k} hidden for ${t}`);
  }
  assert.deepEqual(rows("s3"), [...card.keys], "a bucket: every row");
});

test("Platforms: the numeric ids are found from the channel and shown, never typed; YouTube posting's sign-in keys wait for posting", async () => {
  const { DERIVED_IDS } = await import("../../lib/derivedIds.ts");
  assert.deepEqual(Object.keys(DERIVED_IDS).sort(), ["platform.kick.userId", "platform.streamplace.did", "platform.twitch.broadcasterId"]);
  for (const [id, d] of Object.entries(DERIVED_IDS)) {
    const card = KEY_GROUPS.find((g) => g.keys.includes(id));
    assert.ok(card?.keys.includes(d.from), `${id} sits beside ${d.from}`);
  }
  assert.deepEqual(keyGroupsFor("platforms", "youtube").flatMap((g) => g.keys).filter((k) => k.startsWith("youtube.oauth")), []);
  // The setup pages no longer ask for a numeric id either: it is found when the channel is saved.
  for (const c of SETUP_CORE as { id: string; steps: { fields: string[] }[] }[]) {
    for (const s of c.steps) for (const f of s.fields) {
      assert.ok(!(f in DERIVED_IDS), `setup ${c.id} still asks for ${f}`);
    }
  }
});

test("Site › Leaderboard holds its on/off and its boards; Platforms › Emotes is a place, found by the set names", () => {
  assert.deepEqual(keyGroupsFor("site", "leaderboard").flatMap((g) => g.keys), ["leaderboard.off", "leaderboard.hidden"]);
  const rail = adminRail();
  assert.ok(rail.some((x) => x.id === "site/leaderboard" && x.label === "Leaderboard"));
  assert.ok(rail.some((x) => x.id === "platforms/emotes" && x.label === "Emotes"));
  assert.ok(adminSearch(rail, "7tv").some((x) => x.id === "platforms/emotes"));
});
