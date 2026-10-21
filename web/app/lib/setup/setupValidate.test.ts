// The "Your site" and "Points" forms' checks. Run: node --test app/lib/setup/setupValidate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSiteStep, validatePointsStep, SITE_FIELDS, POINTS_FIELDS, resolveTimeZone, timeZoneNames, installDay, communityWords } from "./setupValidate.ts";

test("W1: every way of typing one city finds its zone; a made-up or shared city is not guessed", () => {
  const zones = timeZoneNames();
  assert.ok(zones.length > 300, `vacuity: this runtime lists ${zones.length} zones`);
  for (const typed of ["New York", "new york", "America/New York", "america/new_york", "  America/New_York "]) {
    assert.equal(resolveTimeZone(typed, zones), "America/New_York", typed);
  }
  assert.equal(resolveTimeZone("berlin", zones), "Europe/Berlin");
  assert.equal(resolveTimeZone("UTC", zones), "UTC");
  assert.equal(resolveTimeZone("Mars/Olympus", zones), null);
  assert.equal(resolveTimeZone("", zones), null);
  // A city two zones share is refused rather than picked.
  assert.equal(resolveTimeZone("Springfield", ["America/Springfield", "Europe/Springfield"]), null);
  const v = validateSiteStep({ SITE_NAME: "x", SITE_TIME_ZONE: "new york" });
  assert.ok(v.ok && v.timeZone === "America/New_York", "the canonical name is what is saved");
  const bad = validateSiteStep({ SITE_NAME: "x", SITE_TIME_ZONE: "Pacific time" });
  assert.ok(!bad.ok && /pick it from the list/.test(bad.error));
});

test("W22: the streamer display name is on Your site, saved as a setting (never written into .env)", () => {
  assert.equal(SITE_FIELDS[1]!.name, "STREAMER_DISPLAY_NAME");
  assert.equal(SITE_FIELDS[1]!.label, "Streamer display name");
  const v = validateSiteStep({ SITE_NAME: "x", STREAMER_DISPLAY_NAME: " Casey " });
  assert.ok(v.ok);
  if (v.ok) { assert.equal(v.displayName, "Casey"); assert.equal("STREAMER_DISPLAY_NAME" in v.install, false); }
  const blank = validateSiteStep({ SITE_NAME: "x" });
  assert.ok(blank.ok && blank.displayName === null);
});

test("W24: the install day is today in the site's time zone (UTC without one)", () => {
  const late = new Date("2026-10-21T03:30:00Z"); // still the 20th in New York
  assert.equal(installDay(late, "America/New_York"), "2026-10-20");
  assert.equal(installDay(late, null), "2026-10-21");
  assert.equal(installDay(late, "Not/AZone"), "2026-10-21", "a bad zone falls back to the UTC day");
  assert.ok(validateSiteStep({ SITE_NAME: "x", SITE_DATA_SINCE: installDay(late, null) }).ok, "the shape the Data since field takes");
});

test("W12: the community step says what was made, from the bootstrap's own answer when it names a forum", () => {
  assert.equal(communityWords("Gadget", "community space !a:x · #general !b:x"),
    "Made: the space “Gadget” (your community's home) and #general for chat. They belong to your account, and you are in each.");
  const withForum = communityWords("Gadget", 'info line\n{"hub":"!a:x","general":"!b:x","forum":"!c:x","created":["space"]}');
  assert.match(withForum, /^Made: the space “Gadget” \(your community's home\), #general for chat and a Forums room/);
  assert.match(communityWords("Gadget", '{"hub":"!a:x","general":"!b:x","created":[]}'), /^Already there:/);
  assert.match(communityWords("Gadget", null), /^Made:/);
  assert.match(communityWords("Gadget", '{"hub": broken'), /^Made:/, "an unreadable line is the plain words, never an error");
});

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
