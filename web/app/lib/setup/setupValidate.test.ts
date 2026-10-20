// The "Your site" and "Points" forms' checks. Run: node --test app/lib/setup/setupValidate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSiteStep, validatePointsStep, SITE_FIELDS, POINTS_FIELDS } from "./setupValidate.ts";

test("site: the name is needed; values .env cannot hold are refused; the two settings rows are not staged", () => {
  assert.equal(validateSiteStep({}).ok, false);
  const ok = validateSiteStep({ SITE_NAME: "  My Stream ", SITE_TIME_ZONE: "Europe/Berlin", SITE_DATA_SINCE: "2026-01-31", LEGAL_CONTACT_EMAIL: "me@example.org" });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.install.SITE_NAME, "My Stream");
    assert.equal(ok.timeZone, "Europe/Berlin"); assert.equal(ok.dataSince, "2026-01-31");
    assert.equal("SITE_TIME_ZONE" in ok.install, false, "a settings row, never written into .env");
    assert.equal(ok.install.SITE_TAGLINE, "", "an empty field is staged as unset");
  }
  for (const bad of ['say "hi"', "a $HOME b", "back\\slash", "two\nlines"]) assert.equal(validateSiteStep({ SITE_NAME: bad }).ok, false, bad);
  assert.equal(validateSiteStep({ SITE_NAME: "x", SITE_SHORT_NAME: "y".repeat(25) }).ok, false, "the schema's 24-character short name");
  assert.equal(validateSiteStep({ SITE_NAME: "x", SITE_TIME_ZONE: "Mars/Olympus" }).ok, false);
  assert.equal(validateSiteStep({ SITE_NAME: "x", SITE_DATA_SINCE: "2026-02-30" }).ok, false);
  assert.equal(validateSiteStep({ SITE_NAME: "x", LEGAL_CONTACT_EMAIL: "nope" }).ok, false);
});

test("points: lengths from the schema; the icon is a site path or https", () => {
  assert.ok(validatePointsStep({ CURRENCY_NAME: "coin", CURRENCY_SYMBOL: "c", CURRENCY_ICON: "/coin.webp" }).ok);
  assert.equal(validatePointsStep({ CURRENCY_SYMBOL: "toolong" }).ok, false);
  assert.equal(validatePointsStep({ CURRENCY_ICON: "http://x.test/a.png" }).ok, false);
  assert.ok(validatePointsStep({}).ok, "every points field is optional (the built-in words)");
});

test("the forms show the schema's own labels", () => {
  assert.equal(SITE_FIELDS[0]!.label, "Site name");
  assert.ok(SITE_FIELDS.every((f) => f.label && f.description) && POINTS_FIELDS.every((f) => f.label && f.description));
  assert.ok(validateSiteStep({ SITE_NAME: "x", SITE_TIME_ZONE: "UTC", SITE_DATA_SINCE: "2024-02-29" }).ok, "a leap day, and UTC");
  assert.equal(validateSiteStep({ SITE_NAME: "x", SITE_DATA_SINCE: "2025-02-29" }).ok, false);
});
