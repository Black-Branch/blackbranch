// The setup pages generated from the module manifests.
// Run: node --test app/lib/setup/setupPages.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MODULES } from "../instanceSchema.generated.mjs";
import { productModules, moduleSetupPage, fillTemplate, placeholderValues, coreSetupLists, moduleSetupKeys, coreSetupPage, coreSetupKeys } from "./setupPages.ts";

const addr = { origin: "https://example.test", apiOrigin: "https://api.example.test", matrixOrigin: "https://matrix.example.test", serverName: "example.test" };

test("every product module with a `setup` field renders a page for this install; owner plugins are never offered", () => {
  const withSetup = (MODULES as { id: string; kind: string; setup?: unknown[] }[]).filter((m) => Array.isArray(m.setup));
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
  assert.deepEqual(core.map((c) => c.id), ["twitch", "kick", "streamplace", "donations"]);
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
  // Every page's Test is a field of its own step, and the keys a list may write are its fields.
  for (const c of core) {
    const page = coreSetupPage(c.id, bb)!;
    for (const s of page.steps) if (s.test) assert.ok(s.fields.some((f) => f.key === s.test), `${c.id}/${s.id}`);
    assert.deepEqual([...coreSetupKeys(c.id)].sort(), page.steps.flatMap((s) => s.fields.map((f) => f.key)).sort());
  }
  assert.equal(coreSetupPage("nope", bb), null);
  // An enum field carries its choices (PayPal's live / sandbox is a select, not free text).
  assert.deepEqual(moduleSetupPage("paypal", bb)!.steps[0]!.fields.find((f) => f.key === "paypal.env")?.values, ["live", "sandbox"]);
});

test("a public install's OBS page offers only the rig page (and the pause scene); the WebSocket steps are the owner's", () => {
  const pub = moduleSetupPage("obs", addr)!;
  assert.deepEqual(pub.steps.map((s) => s.id), ["rig", "pause"]);
  assert.deepEqual([...moduleSetupKeys("obs")], ["timer.pauseScene"], "a public install's step save accepts no WebSocket key");
  const own = moduleSetupPage("obs", addr, { ownerPlugin: true })!;
  assert.deepEqual(own.steps.map((s) => s.id), ["rig", "pause", "websocket", "names"]);
  assert.ok(moduleSetupKeys("obs", { ownerPlugin: true }).has("obs.password"));
  assert.ok(pub.steps.every((s) => !("ownerOnly" in s)), "the flag is not part of the page");
  assert.match(pub.steps[0]!.explain, /Control audio via OBS/);
  assert.match(pub.steps[0]!.explain, /Advanced access to OBS/);
});
