// An install that HAS set the identity keys, with neutral placeholder values. Its own file:
// installValues.ts reads the build once per process.
// Run: node --test app/lib/identitySweep.configured.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import "./testTsx.ts";
process.env.INSTALL_VALUES = JSON.stringify({
  "site.name": "Test Site", "site.origin": "https://example.tv",
  "site.shortName": "Test", "site.description": "A test stream and its community.", "site.iconSet": "/",
  "legal.operator": "Test Operator", "legal.contactEmail": "operator@example.test",
  "legal.governingLaw": "the State of Testing", "legal.effectiveDate": "January 1, 2026",
});
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
const offline = await import("../offline.html/route.ts");

test("the legal page shows the operator's own values, with mail links", () => {
  assert.deepEqual(legal.legalMissing(), []);
  const html = renderToString(createElement(LegalDocument, { facts: NOTHING }));
  assert.match(html, /operated by <!-- -->Test Operator<!-- --> /);
  assert.match(html, /the laws of <!-- -->the State of Testing/);
  assert.match(html, /Last updated <!-- -->January 1, 2026/);
  assert.match(html, /<a href="mailto:operator@example.test" class="text-sky-400 hover:text-sky-300">operator@example.test<\/a>/);
  assert.match(html, /<a href="mailto:operator@example.test" class="hover:text-secondary">operator@example.test<\/a><\/div>/, "the footer link");
  assert.doesNotMatch(html, /not set\]/);
});

test("manifest: short name, description and the install's icon folder", () => {
  const m = manifest();
  assert.equal(m.short_name, "Test");
  assert.equal(m.description, "A test stream and its community.");
  assert.deepEqual((m.icons ?? []).map((i) => i.src), ["/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"]);
});

test("the offline page names the configured site", async () => {
  const page = await offline.GET().text();
  assert.match(page, /<title>Offline — Test Site<\/title>/);
});
