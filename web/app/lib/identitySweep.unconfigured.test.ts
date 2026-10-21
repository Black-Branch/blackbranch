// A fresh install with NONE of the identity keys set: only the site's name. Its own file because
// installValues.ts reads the build values once per process — identitySweep.configured.test.ts is
// the install that HAS them.
// Run: node --test app/lib/identitySweep.unconfigured.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import "./testTsx.ts";
process.env.INSTALL_VALUES = JSON.stringify({ "site.name": "Example Stream", "site.origin": "https://example.tv" });
const legal = await import("./legal.ts");
const { LegalDocument } = await import("../legal/LegalDocument.tsx");

// What a fresh install runs: nothing optional (legalFacts.ts; the page's own test covers the rest).
const NOTHING = {
  botName: null,
  ai: { bot: false, memory: false, automod: false, helpdesk: false, plugin: false, providers: [], memoryRetentionDays: null },
  youtube: { publicData: false, linking: false },
  payments: { stripe: false, paypal: false, kofi: false, patreon: false, streamlabs: false, subscriptions: false, points: false },
  currencyName: "points", twitch: false, liabilityCapUsd: 50, thirdPartyImages: { vods: false, news: false },
  cloudflare: false, homeserverRetention: null, errorLogDays: 30, plugin: null,
};
const manifest = (await import("../manifest.ts")).default;
const { siteIcon, productFavicon, PRODUCT_MARK } = await import("./siteIcons.ts");
const offline = await import("../offline.html/route.ts");

// Every owner pattern the ratchet knows, read from its own config: a fresh install's pages must
// match none of them.
// Loaded at run time: the box's site build typechecks tests, and tools/ is not in a release.
// A RATCHET pattern (one the tree is known to hold, each file to a ceiling that only goes down) is
// left out: the owner's own plugin, present in the private tree, may say its own word — the
// manifest's owner shortcut does — and the public tree holds it at its ceilings through --tree.
const { loadConfig } = (await import(new URL("../../../tools/check-owner-literals.mjs", import.meta.url).href)) as { loadConfig: () => { patterns: { name: string; re: string; ratchet?: Record<string, number> }[] } };
const OWNER = loadConfig().patterns.filter((p) => !p.ratchet);
function assertNoOwner(text: string, where: string) {
  assert.ok(OWNER.length >= 3, "the literal pattern list did not load");
  for (const p of OWNER) assert.doesNotMatch(text, new RegExp(p.re, "i"), `${where} carries the owner's ${p.name}`);
}

test("legal values unset: every one shows a 'not set' marker, and the boot line names all four", () => {
  assert.equal(legal.OPERATOR, "[operator not set]");
  assert.equal(legal.CONTACT_EMAIL, null);
  assert.equal(legal.GOVERNING_LAW, "[governing law not set]");
  assert.equal(legal.EFFECTIVE_DATE, "[date not set]");
  assert.deepEqual(legal.legalMissing(), ["legal.operator", "legal.contactEmail", "legal.governingLaw", "legal.effectiveDate"]);
});

test("the legal page of a fresh install names no operator, no address and no bot it does not have", () => {
  const html = renderToString(createElement(LegalDocument, { facts: NOTHING }));
  assert.match(html, /Last updated (<!-- -->)?\[date not set\]/);
  assert.match(html, /\[operator not set\]/);
  assert.match(html, /the laws of (<!-- -->)?\[governing law not set\]/);
  assert.match(html, /\[contact e-mail not set\]/);
  assert.doesNotMatch(html, /mailto:/, "a mail link with no address");
  assert.match(html, /5\. AI features</, "the AI heading without a name");
  assert.match(html, /<!-- -->\[contact e-mail not set\]<\/div><\/div><\/div>$/, "the footer — the END of the document — must be in the render");
  assertNoOwner(html, "/legal");
});

test("the legal page names the install's bot when it has one", () => {
  const html = renderToString(createElement(LegalDocument, { facts: { ...NOTHING, botName: "Robo", ai: { ...NOTHING.ai, bot: true } } }));
  assert.match(html, /5\. AI features \(Robo\)/);
  assert.match(html, /a chat participant \(“Robo”\) that answers in chat/);
  assert.match(html, /to run the AI features \(Robo\);/);
});

test("manifest of a fresh install: the site name, a neutral description, the product's icons", () => {
  const m = manifest();
  assert.equal(m.name, "Example Stream");
  assert.equal(m.short_name, "Example Stream", "unset short name = the site name");
  assert.match(String(m.description), /^Example Stream — /);
  assert.equal(siteIcon("icon.png"), "/brand/icon.png", "unset = the neutral set");
  for (const i of m.icons ?? []) {
    assert.match(i.src, /^\/brand\//, `${i.src} is not the neutral set`);
    assert.ok(readFileSync(new URL(`../../public${i.src}`, import.meta.url)).length > 0, `${i.src} missing from public/`);
  }
  assertNoOwner(JSON.stringify(m), "the manifest");
});

test("site.iconSet: a plain folder path, else the neutral set", () => {
  assert.equal(siteIcon("icon-192.png", "/"), "/icon-192.png");
  assert.equal(siteIcon("icon-192.png", "/brand/mine/"), "/brand/mine/icon-192.png");
  for (const bad of ["https://cdn.example/x", "../x", "/a/../b", "//cdn.example", "/x?y=1", "relative"]) {
    assert.equal(siteIcon("icon-192.png", bad), "/brand/icon-192.png", `${bad} should fall back`);
  }
  for (const f of ["icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"] as const) {
    assert.ok(readFileSync(new URL(`../../public${siteIcon(f)}`, import.meta.url)).length > 0, `public/brand/${f} is missing`);
  }
});

test("the product's favicon.ico is linked for the product's set only; its mark is always the product's", () => {
  assert.equal(productFavicon(""), "/brand/favicon.ico", "unset = the product's set, which has one");
  assert.equal(productFavicon("https://cdn.example/x"), "/brand/favicon.ico", "a refused folder falls back to the product's set");
  assert.equal(productFavicon("/"), null, "a site whose icons are at the root keeps its head as it was");
  assert.equal(productFavicon("/brand/mine"), null, "an operator's folder is never asked for a favicon.ico");
  for (const f of ["/brand/favicon.ico", PRODUCT_MARK]) {
    const b = readFileSync(new URL(`../../public${f}`, import.meta.url));
    assert.ok(b.length > 0 && b.length < 20_000, `${f} is missing or heavy (${b.length} bytes)`);
  }
  // An .ico starts 00 00 01 00 (type 1 = icon) and holds the three tab sizes.
  const ico = readFileSync(new URL("../../public/brand/favicon.ico", import.meta.url));
  assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0]);
  assert.equal(ico.readUInt16LE(4), 3);
});

test("the offline page names this site, and nothing of the owner's", async () => {
  const page = await offline.GET().text();
  assert.match(page, /<title>Offline — Example Stream<\/title>/);
  assert.match(page, /<p>Example Stream needs a connection/);
  assert.doesNotMatch(page, /src=|href=/, "the offline page may load nothing");
  assertNoOwner(page, "the offline page");
});
