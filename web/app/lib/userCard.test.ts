// User-card pure logic: tier pills, avatar resolution, popout URL, geometry.
//
// Run: node --test app/lib/userCard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { pillRole, pillClasses, tierChips } from "./tierPills.ts";
import { avatarSrc, userCardPopoutUrl, userLookupKey } from "./avatarSrc.ts";
import { centeredBox } from "./chrome/useDragResize.ts";

// ── tier pills ───────────────────────────────────────────────────────────────

test("no product tier is danger-coloured", () => {
  // The editorial call recorded in tierPills.ts: "Dumb" is a percentile bucket,
  // not an accusation, and colouring it red frames a statistic as a verdict.
  assert.equal(pillRole("Dumb"), "caution");
  assert.notEqual(pillRole("Dumb"), "danger");
});

test("every support tier shares one role", () => {
  const roles = ["Supporter", "Contributor", "Patron", "Blessing"].map(pillRole);
  assert.deepEqual(new Set(roles), new Set(["support"]), "support tiers must read as one idea");
});

test("the whole live vocabulary is mapped", () => {
  // These are exactly the strings stream-api's aggregate refresh can emit. A new
  // one appearing here unmapped would silently render neutral, so pin them.
  // (A plugin's pill is not here: it brings its own tone — profileExtras.descriptor.tone.)
  const vocabulary = [
    "Smart", "Average", "Dumb",
    "Constant", "Consistent", "Familiar", "Stranger",
    "Writer", "Chatter", "Reactor",
    "Blessing", "Patron", "Contributor", "Supporter",
  ];
  const unmapped = vocabulary.filter((v) => pillRole(v) === "neutral" &&
    !["Average", "Familiar", "Stranger", "Chatter", "Reactor"].includes(v));
  assert.deepEqual(unmapped, [], "these tiers fell through to the neutral default");
});

test("an unknown tier degrades to neutral instead of throwing", () => {
  // The labels come from a SQL CASE that has changed before.
  assert.equal(pillRole("Ascended"), "neutral");
  assert.ok(pillClasses(pillRole("Ascended")).length > 0);
});

test("chips keep their display order and omit an empty support tier", () => {
  const tiers = {
    regularityTier: "Constant",
    intelligenceTier: "Dumb",
    wordCountTier: "Chatter",
    supportTier: "Patron",
  };
  // The plugin's descriptor sits second, after regularity (app/lib/plugins/profile.ts), in the
  // plugin's own tone; every other pill takes its tone from the product's map.
  const text = (cs: { text: string }[]) => cs.map((c) => c.text);
  const chips = tierChips(tiers, { value: "Gadget", role: "info" });
  assert.deepEqual(text(chips), ["Constant", "Gadget", "Dumb", "Chatter", "Patron"]);
  assert.deepEqual(chips.map((c) => c.role), ["positive", "info", "caution", "neutral", "support"]);
  assert.deepEqual(tierChips({ supportTier: "None" }, null), [], '"None" support is not a pill');
});

test("without a plugin descriptor the card has only the stream's own tiers", () => {
  assert.deepEqual(tierChips({}, null), []);
  assert.deepEqual(tierChips({ regularityTier: "Familiar", wordCountTier: "Writer" }, null).map((c) => c.text), ["Familiar", "Writer"]);
});

// ── avatar resolution ────────────────────────────────────────────────────────

test("the platform avatar wins over the Matrix one", () => {
  // The bug this fixes: UserCard keyed off matrixId alone, so a Twitch chatter
  // got a coloured initial while their real avatar sat unused on the message.
  assert.equal(
    avatarSrc({ avatarUrl: "https://cdn.twitch/x.png", matrixId: "@a:site.test" }),
    "https://cdn.twitch/x.png"
  );
});

test("native users fall back to the Matrix avatar route, and ids are encoded", () => {
  assert.equal(
    avatarSrc({ matrixId: "@a:site.test" }),
    "/api/avatar/user/%40a%3Asite.test"
  );
  assert.equal(avatarSrc({}), null, "no avatar and no matrixId → caller draws the initial");
});

// ── profile lookup key ───────────────────────────────────────────────────────

test("the profile lookup key: a site line's Matrix id, else its public id — never a canonical", () => {
  // Chat lines carry per-platform public ids (owner decision 2026-10-17); /api/user/[id] answers a
  // raw canonical only for a moderator or the person. A site line keys by its own Matrix id.
  assert.equal(userLookupKey({ publicId: "pSITE", matrixId: "@a:site.test" }), "@a:site.test");
  assert.equal(userLookupKey({ publicId: "pTW", matrixId: null }), "pTW");
  assert.equal(userLookupKey({ matrixId: "@a:site.test" }), "@a:site.test");
  assert.equal(userLookupKey({ publicId: null, matrixId: null }), null, "no identity → the card skips the fetch");
  assert.equal(userLookupKey({}), null);
});

// ── popout URL ───────────────────────────────────────────────────────────────

test("the popout URL carries identity but never privilege", () => {
  const url = userCardPopoutUrl({
    id: 42, platform: "twitch", username: "bob",
    matrixId: "@bob:site.test", publicId: "pABC",
  });
  const q = new URLSearchParams(url.split("?")[1]);
  assert.equal(q.get("matrixId"), "@bob:site.test");
  assert.equal(q.get("publicId"), "pABC");
  assert.equal(q.get("canonicalId"), null, "a canonical id never rides a URL");
  assert.equal(q.get("mid"), "42");
  // A URL is attacker-controlled. Mod status must come from the session, or the
  // mod UI is handed to anyone who types one.
  for (const forbidden of ["isMod", "isAdmin", "mod", "admin"]) {
    assert.equal(q.get(forbidden), null, `popout URL must not carry ${forbidden}`);
  }
});

test("absent fields are omitted rather than sent as empty strings", () => {
  const q = new URLSearchParams(userCardPopoutUrl({ publicId: "pAbc" }).split("?")[1]);
  assert.equal(q.get("mid"), null);
  assert.equal(q.get("matrixId"), null);
  assert.equal(q.get("publicId"), "pAbc");
});

// ── geometry ─────────────────────────────────────────────────────────────────

const VP = { width: 1200, height: 800 };

test("the card centres over its host", () => {
  const host = { left: 800, top: 100, width: 400, height: 600 };
  const b = centeredBox(host, 300, 400, VP);
  assert.equal(b.x + b.w / 2, host.left + host.width / 2);
  assert.equal(b.y + b.h / 2, host.top + host.height / 2);
});

test("a card that would overflow is pulled back on screen", () => {
  // This is the actual reported bug — the card "got cut off". Anchoring to a
  // click near the edge is what caused it; centring + clamping removes it.
  const host = { left: 1150, top: 760, width: 40, height: 40 };
  const b = centeredBox(host, 300, 400, VP);
  assert.ok(b.x >= 0 && b.x + b.w <= VP.width, `x out of bounds: ${b.x}+${b.w}`);
  assert.ok(b.y >= 0 && b.y + b.h <= VP.height, `y out of bounds: ${b.y}+${b.h}`);
});

test("a card larger than the viewport shrinks to fit", () => {
  const b = centeredBox(null, 2000, 2000, VP);
  assert.ok(b.w <= VP.width && b.h <= VP.height);
  assert.ok(b.x >= 0 && b.y >= 0);
});

test("no host (popout / detached) centres on the viewport", () => {
  const b = centeredBox(null, 300, 400, VP);
  assert.equal(b.x + b.w / 2, VP.width / 2);
  assert.equal(b.y + b.h / 2, VP.height / 2);
});
