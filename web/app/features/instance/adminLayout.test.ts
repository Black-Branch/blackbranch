// The Admin Panel holds every instance key: every key must land in exactly one section, every AI
// task must land in a tab, and the two old URLs (the Credentials and AI pages) must answer with a
// permanent redirect.
// Run: node --test app/features/instance/adminLayout.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTANCE_KEYS } from "../../lib/instanceSchema.generated.mjs";
import { ADMIN_SECTIONS, SUBS, KEY_GROUPS, aiSubOf, keyGroupsFor, isAdminSection, guidesFor, adminRail, adminSearch, adminItemFor, ADMIN_HOME, shownKeys, UNPLACED } from "./adminLayout.ts";
import { SETUP_GUIDES } from "../../lib/setup/setupGuideMap.ts";
import { stripComments } from "../../lib/sourceText.mjs";
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
  assert.deepEqual(per, { ai: 4, utility: 9, payments: 17, platforms: 19, site: 94, doctor: 0, updates: 0 }); // site: +6, the Mail card (A2-05); +5, the Auto-pin card (#189); +1, the Streamer highlight card (#250); +14, the Sign-in providers card (ADR 0154)
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
  // Site keeps every key it had but the extra staff accounts, which moved to Moderators as House accounts.
  assert.equal(keyGroupsFor("site", "general").flatMap((g) => g.keys).length, 70, "the Site cards (bug reports hidden until a sender exists; +6 the Mail card; +5 the Auto-pin card; +1 the Streamer highlight card; +14 the Sign-in providers card)");
  // Site › Community: federation and sign-up, and the rooms the server's setup made, under the channels.
  assert.deepEqual(keyGroupsFor("site", "community").map((g) => [g.title, g.keys]), [
    ["Federation and sign-up", ["matrix.federation", "matrix.registration"]], ["Community rooms", ["matrix.rooms.hub", "matrix.rooms.general"]],
    ["Bridge accounts", ["community.bridgeAccounts"]]]);
  assert.deepEqual(keyGroupsFor("site", "moderators").map((g) => [g.title, g.keys]), [["House accounts", ["staff.extraMatrixIds"]]]);
  // The federated sign-in policy is its own card on Site; federation is on Community.
  assert.deepEqual(keyGroupsFor("site", "general").find((g) => g.title === "Sign-in from other servers")?.keys, ["auth.federatedSignin", "auth.federatedAllow", "auth.federatedDeny"]);
  // Sign-up sits beside federation, and its description says it governs the BUNDLED homeserver
  // only: an install whose homeserver runs elsewhere must not think it closed anything.
  assert.deepEqual(keyGroupsFor("site", "community").find((g) => g.title === "Federation and sign-up")?.keys, ["matrix.federation", "matrix.registration"]);
  const signup = INSTANCE_KEYS.find((e) => e.key === "matrix.registration");
  assert.deepEqual(signup?.values, ["open", "closed"]);
  assert.equal(signup?.label, "Let people make accounts");
  assert.match(signup?.description ?? "", /Applies only to the homeserver this install's bundle runs/);
  assert.deepEqual([...(keyGroupsFor("site", "general").find((g) => g.title === "Backups")?.keys ?? [])].sort(),
    INSTANCE_KEYS.filter((e) => e.key.startsWith("backup.")).map((e) => e.key).sort(), "every backup setting is on the Backups card");
  assert.deepEqual([...(keyGroupsFor("site", "general").find((g) => g.title === "Mail")?.keys ?? [])].sort(),
    INSTANCE_KEYS.filter((e) => e.key.startsWith("mail.")).map((e) => e.key).sort(), "every mail setting is on the Mail card");
  const signin = keyGroupsFor("site", "general").find((g) => g.title === "Sign-in providers");
  assert.deepEqual([...(signin?.keys ?? [])].sort(), INSTANCE_KEYS.filter((e) => e.key.startsWith("signin.")).map((e) => e.key).sort(), "every sign-in provider setting is on its card");
  // A slot's fields show once its switch is on; the switch (and its redirect URL) always.
  for (const k of signin?.keys ?? []) {
    if (k.endsWith(".enabled")) assert.equal(signin?.onlyWhen?.[k], undefined, k);
    else assert.deepEqual(signin?.onlyWhen?.[k], { key: `${k.slice(0, k.lastIndexOf("."))}.enabled`, is: ["true"] }, k);
  }
  assert.deepEqual(INSTANCE_KEYS.filter((e) => e.surface === "setup").map((e) => e.key), ["community.setupChannels", "setup.completedAt", "setup.state"],
    "the setup pages' own records are never a card (the channels listed at setup are managed on the Community page)");
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
  assert.deepEqual(SUBS.ai.map((s) => s.label), ["Models", "Chat Bot", "Automod", "Help Desk", "Embeddings"]);
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
  const tabs = new Set<string>(SUBS.ai.map((s) => s.key));
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
  const community = keyGroupsFor("site", "community").find((g) => g.title === "Federation and sign-up");
  const signin = keyGroupsFor("site", "general").find((g) => g.title === "Sign-in from other servers");
  assert.ok(community?.keys.includes("matrix.federation") && signin?.keys.includes("auth.federatedSignin"), "vacuity: the two cards");
  assert.match(community!.blurb ?? "", /exchange messages/);
  assert.match(community!.blurb ?? "", /does not decide who may sign in here: the Sign-in from other servers card on the Site page does/);
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
  assert.match(last.blurb ?? "", /identity and never change/);
  // Every install-tier key the Site page holds, except the site's own words, is in that card.
  const words = ["site.name", "site.shortName", "site.description", "site.tagline", "site.homeHeading", "site.homeIntro", "site.iconSet"];
  const legal = ["legal.operator", "legal.contactEmail", "legal.governingLaw", "legal.effectiveDate"];
  // The community service account is the install's own account, not a value the site was made with:
  // its own read-only card, beside the rooms it runs.
  const service = ["community.serviceLocalpart", "community.reconciler"];
  const onSite = site.flatMap((g) => g.keys);
  const installTier = onSite.filter((k) => INSTANCE_KEYS.find((e) => e.key === k)?.tier === "install");
  assert.ok(installTier.length >= 15, `vacuity: ${installTier.length} install keys on Site`);
  for (const k of installTier) {
    if (words.includes(k) || legal.includes(k) || service.includes(k)) continue;
    assert.ok(last.keys.includes(k), `${k} is an install value outside the Install values card`);
  }
  // The sign-in client's secret is an install value too (the installer writes it to the env).
  assert.ok(last.keys.includes("matrix.oauth.clientSecret"));
  // The two room ids are NOT: the installer passes neither to any service; the server's community
  // bootstrap records them in the database. They are facts, in a card of their own that offers no
  // change at all.
  for (const k of ["matrix.rooms.hub", "matrix.rooms.general"]) assert.ok(!last.keys.includes(k), k);
  const rooms = keyGroupsFor("site", "community").find((g) => g.title === "Community rooms")!;
  assert.deepEqual(rooms.keys, ["matrix.rooms.hub", "matrix.rooms.general"]);
  assert.equal(rooms.readOnly, true);
  assert.doesNotMatch(rooms.blurb ?? "", /change it on the server/);
  assert.ok(rooms.readOnlyNote && !/set .* on the server/i.test(rooms.readOnlyNote), "no line telling anyone to set it on the server");
  assert.deepEqual(site.find((g) => g.title === "Site")?.keys, words);
  // No card says the values are set where the site is built.
  for (const g of KEY_GROUPS) assert.doesNotMatch(g.blurb ?? "", /where the site is built/, g.title);
  const svc = site.find((g) => g.title === "Community service")!;
  assert.deepEqual(svc.keys, service);
  assert.equal(svc.readOnly, true);
  assert.equal(svc.blurb, "The account this install uses to run the community. Nothing to change here.");
  for (const k of service) assert.ok(!last.keys.includes(k), k);
  // Plain words on what a streamer reads: no Matrix terms in the card or its rows.
  const said = [svc.title, svc.blurb, svc.readOnlyNote ?? "", ...service.flatMap((k) => { const e = INSTANCE_KEYS.find((x) => x.key === k)!; return [e.label, e.description]; })].join(" ");
  assert.doesNotMatch(said, /power level|join rule|state event|appservice|application service|localpart|reconcil/i);
  assert.deepEqual(site.map((g) => g.title), ["Streamer", "Site", "Legal", "Sign-in from other servers", "Community service", "Channels", "Auto-pin", "Streamer highlight", "Alerts to your phone", "Running the site", "Mail", "Sign-in providers", "Backups", "Install values"]);
  // The streamer's highlight switch (#250): one card beside Auto-pin.
  assert.deepEqual(site.find((g) => g.title === "Streamer highlight")?.keys, ["chat.spotlight.off"]);
  // The crowd auto-pin dials (ticket #189): the off switch first, then the curve, then how long.
  assert.deepEqual(site.find((g) => g.title === "Auto-pin")?.keys,
    ["chat.autoPin.off", "chat.autoPin.votes", "chat.autoPin.chattersPerVote", "chat.autoPin.maxVotes", "chat.autoPin.minutes"]);
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

test("with no owner plugin the AI rail has no Scoring place", () => {
  // ADR 0128: only the owner plugin has score.* tasks, so a public install shows no Scoring tab and
  // no search finds one. The plugin registers the place itself (app/(owner)/admin.ts).
  const ai = adminRail([]).filter((x) => x.section === "ai");
  assert.ok(ai.length >= 5, `vacuity: ${ai.length} AI places`);
  assert.ok(!ai.some((x) => x.sub === "scoring" || /scor/i.test(x.label)), "a Scoring place without the plugin");
  assert.deepEqual(adminSearch(adminRail([]), "scoring"), [], "search finds no Scoring place");
  assert.deepEqual(adminSearch(adminRail([]), "temperament"), [], "nor by the scoring words");
  // With the plugin's place, it is there, and its tasks still map to it.
  const withPlugin = adminRail([{ section: "ai", key: "scoring", label: "Scoring" }]);
  assert.ok(withPlugin.some((x) => x.id === "ai/scoring" && x.plugin));
  assert.ok(adminSearch(withPlugin, "scoring").some((x) => x.id === "ai/scoring"));
  assert.equal(aiSubOf("score.karma", "plugin"), "scoring");
});

// Cards a place renders itself, not from KEY_GROUPS (their <h2> titles), that copy may name.
const PANEL_CARDS: Record<string, readonly string[]> = {
  "utility/obs": ["The rig page", "Overlays"], // RigPanel.tsx, OverlaysPanel.tsx
  "site/moderators": ["Admins", "Moderators", "Staff"], // ModeratorList.tsx
};

/** Every "Admin Panel → …" place in a text, and every bare "<Group> → …" one, that is not a rail
 *  place or a card on one. A place is "<Group> → <Place>", a card on it ", card <title>"; a
 *  lowercase step ("the platform's tab") or a template hole is a generic pointer and not judged. */
function badPlaces(raw: string): string[] {
  const text = raw.replace(/\*/g, "").replace(/\s+/g, " ");
  const rail = adminRail([]);
  const groups = [...new Set(ADMIN_SECTIONS.map((s) => s.label))];
  const longest = (rest: string, words: readonly string[]) =>
    words.filter((w) => rest.startsWith(w) && !/[\w-]/.test(rest[w.length] ?? "")).sort((a, b) => b.length - a.length)[0];
  const generic = (rest: string) => /^([a-z]|\$\{)/.test(rest);
  const starts = [...text.matchAll(/Admin Panel → /g)].map((m) => m.index! + m[0].length);
  for (const m of text.matchAll(/(?<!→ )\b(AI|Utility|Payments|Platforms|Site) → /g)) starts.push(m.index!);
  const bad: string[] = [];
  for (const at of new Set(starts)) {
    let rest = text.slice(at);
    const quote = text.slice(Math.max(0, at - 14), at + 60);
    if (generic(rest)) continue;
    const g = longest(rest, groups);
    if (!g) { bad.push(`${quote} — not a section`); continue; }
    const section = ADMIN_SECTIONS.find((s) => s.label === g)!.key;
    rest = rest.slice(g.length);
    if (!rest.startsWith(" → ")) continue;
    rest = rest.slice(3);
    if (generic(rest)) continue;
    const places = rail.filter((x) => x.section === section);
    const p = longest(rest, places.map((x) => x.label));
    if (!p) { bad.push(`${quote} — not a ${g} place`); continue; }
    const sub = places.find((x) => x.label === p)!.sub;
    rest = rest.slice(p.length);
    if (rest.startsWith(" → ")) { bad.push(`${quote} — a card is named ", card <title>"`); continue; }
    if (!rest.startsWith(", card ")) continue;
    rest = rest.slice(7).replace(/^["“]/, "");
    const cards = [...keyGroupsFor(section, sub).map((c) => c.title), ...(PANEL_CARDS[`${section}/${sub}`] ?? [])];
    if (!longest(rest, cards)) bad.push(`${quote} — not a card on ${g} → ${p}`);
  }
  return bad;
}

test("every 'Admin Panel → …' place in product copy is a rail place, or a card on one", () => {
  const REPO = join(WEB, "..");
  const code = (dir: string) => readdirSync(join(REPO, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !/\.test\./.test(f)).map((f) => join(dir, f));
  const files = [
    "config/doctor.mjs", "config/modules.mjs", "config/setup-core.mjs",
    // Every shipped web source (components, lib, features, routes, the owner folder), the host
    // command's messages, and the env examples an operator reads (their comments are the copy).
    ...code("web/app"),
    "install/README.md", "install/blackbranch", "install/install.sh",
    "install/.env.example", "web/.env.example", "stream-api/.env.example", "stream-ingest/.env.example",
    // The changelog is left out: a release's notes describe the panel as it was at that release.
    ...readdirSync(join(REPO, "docs/public"), { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".md") && f !== "changelog.md").map((f) => join("docs/public", f)),
  ];
  let places = 0;
  const bad: string[] = [];
  for (const f of files) {
    const raw = readFileSync(join(REPO, f), "utf8");
    const text = /\.(ts|tsx|mjs)$/.test(f) ? stripComments(raw) : raw;
    places += (text.replace(/\s+/g, " ").match(/Admin Panel → /g) ?? []).length;
    for (const b of badPlaces(text)) bad.push(`${f}: ${b}`);
  }
  assert.ok(files.length > 400 && places > 35, `vacuity: ${files.length} files, ${places} places read`);
  assert.deepEqual(bad, []);
  // The scan itself: each wrong shape is caught, each right one passes.
  assert.equal(badPlaces("Admin Panel → Site → Backups").length, 1);
  assert.equal(badPlaces("(Site → Running the site)").length, 1);
  assert.equal(badPlaces("Admin Panel → Moderators → Admins").length, 1);
  assert.equal(badPlaces("Admin Panel → Payments → Connections → Stripe").length, 1);
  assert.equal(badPlaces("Admin Panel → Site → Site, card Rabbits").length, 1);
  assert.deepEqual(badPlaces("Admin Panel → Site → Site, card Backups: check it. Admin Panel → Platforms → the platform's tab. Admin Panel → Doctor."), []);
});
