// The setup pages generated from the module manifests.
// Run: node --test app/lib/setup/setupPages.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHECK_VIA } from "./setupExtras.ts";
import { MODULES } from "../instanceSchema.generated.mjs";
import { productModules, moduleSetupPage, fillTemplate, placeholderValues, coreSetupLists, moduleSetupKeys, coreSetupPage,
  wizardLists, wizardListPage, wizardListKeys, wizardSkipPrefix } from "./setupPages.ts";
import { TWITCH_SCOPES, KICK_SCOPES, expandChosen } from "./setupExtras.ts";

const addr = { origin: "https://example.test", apiOrigin: "https://api.example.test", matrixOrigin: "https://matrix.example.test", serverName: "example.test" };

test("every product module with a `setup` field renders a page for this install; owner plugins are never offered", () => {
  const withSetup = (MODULES as { id: string; kind: string; setup?: { id: string }[] }[]).filter((m) => Array.isArray(m.setup));
  assert.ok(withSetup.length >= 1, "vacuity: no manifest carries a setup list");
  for (const m of withSetup) {
    const page = moduleSetupPage(m.id, addr, { ownerPlugin: true });
    assert.ok(page, `${m.id}: no page`);
    assert.equal(page.steps.length, m.setup!.length);
    for (const s of page.steps) {
      for (const p of s.paste) assert.doesNotMatch(p.value, /[{}]/, `${m.id}/${s.id}: an unfilled placeholder`);
      for (const f of s.fields) assert.ok(f.label && f.description, `${m.id}/${s.id}: ${f.key} has no label`);
      if (s.test) assert.ok(s.fields.some((f) => f.key === s.test) || moduleSetupKeys(m.id).has(s.test), `${m.id}/${s.id}: tests a key not on the page`);
    }
  }
  const offered = productModules().map((m) => m.id);
  for (const m of MODULES as { id: string; kind: string }[]) assert.equal(offered.includes(m.id), m.kind === "module", m.id);
  assert.equal(moduleSetupPage("radio", addr), null, "an owner plugin has no setup page");
});

test("paste values are computed from this install's own addresses, and a hole is refused loudly", () => {
  const v = placeholderValues(addr);
  assert.equal(v.domain, "example.test");
  assert.equal(fillTemplate("{origin}/api/billing/webhook", v), "https://example.test/api/billing/webhook");
  assert.equal(fillTemplate("{apiOrigin}/x · {matrixOrigin} · {serverName}", v), "https://api.example.test/x · https://matrix.example.test · example.test");
  assert.throws(() => fillTemplate("{nope}/x", v), /no value for \{nope\}/);
  assert.throws(() => fillTemplate("{origin}", { ...v, origin: "" }), /no value for \{origin\}/);
});

test("the product's own lists are released, and every value to paste is THIS install's", () => {
  const core = coreSetupLists();
  assert.deepEqual(core.map((c) => c.id), ["twitch", "kick", "streamplace", "donations", "voice"]);
  assert.ok(core.every((c) => !c.later && c.label && c.description));
  const bb = { origin: "https://bb.test", apiOrigin: "https://api.bb.test", matrixOrigin: "https://matrix.bb.test", serverName: "bb.test" };
  const pastes = (page: ReturnType<typeof coreSetupPage>) => (page?.steps ?? []).flatMap((s) => s.paste.map((p) => [p.label, p.value]));
  assert.deepEqual(pastes(coreSetupPage("twitch", bb)), [["OAuth redirect URL", "https://bb.test/api/auth/link/twitch/callback"]]);
  assert.deepEqual(pastes(coreSetupPage("kick", bb)), [["Redirect URL", "https://bb.test/api/auth/link/kick/callback"]]);
  assert.deepEqual(pastes(coreSetupPage("streamplace", bb)), [
    ["Client id (nothing to paste anywhere)", "https://bb.test/oauth/client-metadata.json"],
    ["Redirect URL", "https://bb.test/api/auth/link/streamplace/callback"],
  ]);
  assert.deepEqual(pastes(coreSetupPage("donations", bb)).map(([, v]) => v), ["https://api.bb.test/webhook/kofi", "https://api.bb.test/webhook/patreon"]);
  const stripe = moduleSetupPage("stripe", bb)!;
  assert.equal(stripe.steps.find((s) => s.id === "webhook")?.paste.find((p) => p.label === "Endpoint URL")?.value, "https://bb.test/api/billing/webhook");
  assert.match(stripe.steps.find((s) => s.id === "keys")?.paste.map((p) => p.value).join(" ") ?? "", /Checkout Sessions .* Customer portal .*Subscriptions/);
  assert.equal(moduleSetupPage("paypal", bb)!.steps.find((s) => s.id === "webhook")?.paste[0]?.value, "https://bb.test/api/billing/paypal/webhook");
  // Every page's Check is a field of its own step, or the value found from one (CHECK_VIA: the
  // Streamplace handle's DID), and the keys a list may write are its fields.
  for (const c of core) {
    const page = coreSetupPage(c.id, bb)!;
    for (const s of page.steps) if (s.test) assert.ok(s.fields.some((f) => f.key === s.test || CHECK_VIA[f.key] === s.test), `${c.id}/${s.id}`);
    const wiz = c.id === "donations" ? ["kofi", "patreon", "streamlabs"] : [c.id];
    assert.deepEqual(wiz.flatMap((w) => [...wizardListKeys(w)]).filter((k) => page.steps.some((s) => s.fields.some((f) => f.key === k))).sort(),
      page.steps.flatMap((s) => s.fields.map((f) => f.key)).sort(), `${c.id}: the setup pages write every key of the list`);
  }
  assert.equal(coreSetupPage("nope", bb), null);
  // An enum field carries its choices (PayPal's live / sandbox is a select, not free text).
  assert.deepEqual(moduleSetupPage("paypal", bb)!.steps[0]!.fields.find((f) => f.key === "paypal.env")?.values, ["live", "sandbox"]);
});

test("the OBS guide is the rig page and the pause scene, on every install: the product has no OBS WebSocket steps", () => {
  const pub = moduleSetupPage("obs", addr)!;
  assert.deepEqual(pub.steps.map((s) => s.id), ["rig", "pause"]);
  assert.deepEqual([...moduleSetupKeys("obs")], ["timer.pauseScene"], "the step save accepts no WebSocket key");
  const own = moduleSetupPage("obs", addr, { ownerPlugin: true })!;
  assert.deepEqual(own.steps.map((s) => s.id), ["rig", "pause"], "nor on an install with a site plugin");
  assert.ok(!moduleSetupKeys("obs", { ownerPlugin: true }).has("obs.password"));
  assert.ok(pub.steps.every((s) => !("ownerOnly" in s)), "the flag is not part of the page");
  assert.match(pub.steps[0]!.explain, /Control audio via OBS/);
  assert.match(pub.steps[0]!.explain, /Advanced access to OBS/);
});

// ── What the setup pages show on top of the lists ──────────────────────────────────────────────

test("W5: the YouTube posting step (nothing to do) is drawn nowhere — not on the setup page, not in the Admin Panel guide; the channel step says it in one sentence", () => {
  const raw = (MODULES as { id: string; setup?: { id: string }[] }[]).find((m) => m.id === "youtube")!.setup!.map((s) => s.id);
  assert.deepEqual(raw, ["channel"], "the manifest itself no longer carries the posting step");
  for (const page of [moduleSetupPage("youtube", addr), moduleSetupPage("youtube", addr, { wizard: true })]) {
    assert.deepEqual(page!.steps.map((s) => s.id), ["channel"]);
    assert.match(page!.steps[0]!.help?.note ?? "", /Posting site chat into YouTube chat is not in this release/);
  }
});

test("W4: each platform's channel step says it can be added later in the Admin Panel, no restart", () => {
  for (const [page, where] of [[moduleSetupPage("youtube", addr, { wizard: true }), "Platforms → YouTube"], [wizardListPage("twitch", addr), "Platforms → Twitch"], [wizardListPage("kick", addr), "Platforms → Kick"]] as const) {
    const note = page!.steps.find((s) => s.id === "channel")?.help?.later ?? "";
    assert.ok(note.includes(`Admin Panel → ${where}`), `${where}: ${note}`);
    assert.match(note, /no restart/);
  }
  // In the Admin Panel's own guides that line would point at itself: it is the setup pages' alone.
  for (const page of [moduleSetupPage("youtube", addr), coreSetupPage("twitch", addr), coreSetupPage("kick", addr)]) {
    assert.equal(page!.steps.find((s) => s.id === "channel")?.help?.later, undefined, page!.id);
  }
});

test("contract 6: the Stripe list has the supporter price after the webhook, on the setup page AND in the Admin Panel guide and public docs (one list)", () => {
  const wiz = moduleSetupPage("stripe", addr, { wizard: true })!;
  const ids = wiz.steps.map((s) => s.id);
  assert.equal(ids[ids.indexOf("webhook") + 1], "price", ids.join(","));
  const price = wiz.steps.find((s) => s.id === "price")!;
  assert.deepEqual(price.fields.map((f) => f.key), ["stripe.supporterPriceId"]);
  assert.equal(price.test, "stripe.supporterPriceId");
  assert.ok(moduleSetupKeys("stripe", { wizard: true }).has("stripe.supporterPriceId"), "the step save accepts it");
  assert.ok(moduleSetupPage("stripe", addr)!.steps.some((s) => s.id === "price"), "the guide has it too");
  assert.equal(moduleSetupPage("stripe", addr)!.steps.find((s) => s.id === "price")!.test, "stripe.supporterPriceId", "its own Check (OWN_CHECKS)");
});

test("W11: Ko-fi, Patreon and Streamlabs are three separate choices, each a one-step page, skips still recorded under the list the Admin Panel shows", () => {
  assert.deepEqual(wizardLists().map((l) => l.id), ["twitch", "kick", "streamplace", "kofi", "patreon", "streamlabs", "voice"]);
  for (const [id, key] of [["kofi", "kofi.verificationToken"], ["patreon", "patreon.webhookSecret"], ["streamlabs", "streamlabs.socketToken"]] as const) {
    const page = wizardListPage(id, addr)!;
    assert.deepEqual(page.steps.map((s) => s.id), [id]);
    assert.deepEqual([...wizardListKeys(id)], [key]);
    assert.equal(wizardSkipPrefix(id), "donations");
  }
  assert.equal(wizardSkipPrefix("twitch"), "twitch");
  assert.equal(wizardListPage("kofi", addr)!.steps[0]!.paste[0]!.value, "https://api.example.test/webhook/kofi");
  // An older setup that chose the one combined page gets all three.
  assert.deepEqual(expandChosen(["twitch", "donations"]), ["twitch", "kofi", "patreon", "streamlabs"]);
  assert.deepEqual(expandChosen(["kofi", "donations"]), ["kofi", "patreon", "streamlabs"], "each once");
});

test("the read-aloud page takes the ElevenLabs key, both voices and the on switch (tts.enabled)", () => {
  const page = wizardListPage("voice", addr)!;
  assert.deepEqual(page.steps[0]!.fields.map((f) => f.key), ["elevenlabs.apiKey", "tts.voiceCasual", "tts.voiceLoud", "tts.enabled"]);
  assert.equal(page.steps[0]!.fields.find((f) => f.key === "tts.enabled")!.kind, "bool");
  assert.equal(page.steps[0]!.test, "elevenlabs.apiKey");
});

test("the Kick page gains the optional chatroom and channel ids, with words that say to leave them empty", () => {
  const ids = wizardListPage("kick", addr)!.steps.find((s) => s.id === "ids")!;
  assert.equal(ids.need, "optional");
  assert.deepEqual(ids.fields.map((f) => f.key), ["kick.chatroomId", "kick.channelId"]);
  assert.match(ids.explain, /^Leave these empty\. Only if/);
  assert.ok(coreSetupPage("kick", addr)!.steps.some((s) => s.id === "ids"), "the Admin Panel guide and the docs carry it too: one list");
});

test("W10: Streamplace's two addresses are shown for reference — no Copy, and no label that contradicts it", () => {
  const s = wizardListPage("streamplace", addr)!.steps[0]!;
  assert.equal(s.paste.length, 2, "vacuity anchor: the two addresses");
  for (const p of s.paste) assert.ok(s.help?.info?.[p.label], `${p.label} is reference-only`);
  assert.ok(Object.values(s.help!.info!).every((l) => !/client id/i.test(l)));
});

test("W8/W9: the Twitch and Kick pages print the scopes the site asks for, equal to platformOAuth.ts, and the redirect URLs with this install's origin", () => {
  const src = readFileSync(new URL("../platformOAuth.ts", import.meta.url), "utf8");
  assert.match(src, /export function missingScopes/, "vacuity anchor: the END of the file that requests the scopes was read");
  const lists = (name: string) => [...src.matchAll(new RegExp(`\\b${name}:\\s*\\[([^\\]]*)\\]`, "g"))].map((x) => [...x[1]!.matchAll(/"([^"]+)"/g)].map((y) => y[1]));
  const [twitch, , kick] = lists("scopes");
  const [twitchMod, kickMod] = lists("modScopes");
  assert.deepEqual([...TWITCH_SCOPES.everyone], twitch); assert.deepEqual([...TWITCH_SCOPES.moderators], twitchMod);
  assert.deepEqual([...KICK_SCOPES.everyone], kick); assert.deepEqual([...KICK_SCOPES.moderators], kickMod);
  const twitchApp = wizardListPage("twitch", addr)!.steps.find((s) => s.id === "app")!;
  assert.equal(twitchApp.paste[0]!.value, "https://example.test/api/auth/link/twitch/callback");
  assert.equal(twitchApp.help!.extraPaste![0]!.value, TWITCH_SCOPES.everyone.join(" "));
  assert.match(twitchApp.help!.note!, /7TV/);
  assert.equal(wizardListPage("kick", addr)!.steps.find((s) => s.id === "app")!.paste[0]!.value, "https://example.test/api/auth/link/kick/callback");
});

test("every setup page links its guide on blackbranch.app by slug; a page without one links the setup guide", async () => {
  const { PAGE_DOCS, SETUP_DOCS } = await import("./setupExtras.ts");
  const slug = /^https:\/\/blackbranch\.app\/docs\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/;
  for (const id of ["youtube", "stripe", "paypal"]) assert.match(moduleSetupPage(id, addr, { wizard: true })!.docs, slug, id);
  for (const id of ["twitch", "kick", "streamplace", "kofi", "patreon", "streamlabs"]) {
    const page = wizardListPage(id, addr)!;
    assert.equal(page.docs, `https://blackbranch.app/docs/${PAGE_DOCS[id]}/`, id);
  }
  assert.equal(SETUP_DOCS, "install/the-setup-wizard");
  assert.equal(moduleSetupPage("obs", addr)!.docs, "https://blackbranch.app/docs/install/the-setup-wizard/", "no page of its own: the setup guide");
});

test("PayPal: the Supporter subscription through PayPal is a step of its own, its plan checked by shape", async () => {
  const { formatProblem } = await import("./setupExtras.ts");
  const plans = moduleSetupPage("paypal", addr, { wizard: true })!.steps.find((s) => s.id === "plans")!;
  assert.equal(plans.need, "optional");
  assert.deepEqual(plans.fields.map((f) => f.key), ["paypal.plans"]);
  assert.equal(formatProblem("paypal.plans", '{"supporter":"P-5ML4271244454362WXNWU5NQ"}'), null);
  assert.match(formatProblem("paypal.plans", "P-5ML4271244454362WXNWU5NQ") ?? "", /supporter/);
});

test("the setup lists say Check, as the pages and the Admin Panel's button do, never Test", () => {
  const pages = [moduleSetupPage("stripe", addr)!, moduleSetupPage("paypal", addr)!, moduleSetupPage("youtube", addr)!, coreSetupPage("twitch", addr)!, coreSetupPage("kick", addr)!, coreSetupPage("streamplace", addr)!];
  const words = pages.flatMap((p) => p.steps.map((s) => s.explain)).join(" ");
  assert.ok(words.length > 2000, "vacuity: the lists' words were read");
  assert.doesNotMatch(words, /\bTests?\b/);
  assert.match(words, /\bCheck\b/);
});

test("Streamplace: the setup page asks for the handle only; the DID is found from it on save, and Check checks the found account", () => {
  const step = wizardListPage("streamplace", addr)!.steps.find((s) => s.id === "account")!;
  assert.deepEqual(step.fields.map((f) => f.key), ["platform.streamplace.channel"], "nothing to type but the handle");
  assert.equal(step.test, "platform.streamplace.did", "Check checks the account found from the handle");
  assert.doesNotMatch(step.explain, /Paste your account.s DID/);
  assert.match(step.explain, /handle/);
  assert.ok(!wizardListKeys("streamplace").has("platform.streamplace.did"), "the page save never writes a typed DID");
  // The setup test route accepts the DID's check for a page that fills the handle.
  const server = readFileSync(new URL("./setupServer.ts", import.meta.url), "utf8");
  assert.match(server, /CHECK_VIA/);
});
