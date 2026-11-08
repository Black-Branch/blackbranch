// I01: before setup finishes, the site answers every API with 503 ("this site is being set up"),
// and `blackbranch doctor` printed every site row as "site unreachable (the site answered 503)" —
// the first thing a new installer read was that their site was broken. A 503 while setup has not
// finished is the site waiting; a 503 after setup is still a site that does not answer.
// Run: node --test app/lib/doctor/doctorSetup.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCTOR } from "../doctor.generated.mjs";

type Row = { id: string; status: string; detail: string };
type Group = { status: string; meaning: string; n: number };

const WAITING = "waiting for setup to finish";
const SITE_IDS = DOCTOR.CHECKS.filter((c: { side: string }) => c.side === "site" || c.side === "both").map((c: { id: string }) => c.id) as string[];

// What `blackbranch doctor` hands the evaluator: host facts with the setup state it read from the
// database (setup_facts_json), and the site's answer as an error line.
const input = (completed: boolean | null, siteError: string, extra: Record<string, unknown> = {}) => ({
  host: { setup: completed === null ? null : { visited: [], completed } },
  hostState: "ok" as const, site: null, siteError, ...extra,
});
const siteRows = (rows: Row[]) => rows.filter((r) => SITE_IDS.includes(r.id));

test("vacuity: there are site rows to judge", () => {
  assert.ok(SITE_IDS.length >= 10, `${SITE_IDS.length}`);
});

test("a 503 before setup finishes: every site row is grey 'waiting for setup to finish'", () => {
  const rows = DOCTOR.evaluate(input(false, "the site answered 503"));
  for (const r of siteRows(rows)) {
    assert.equal(r.status, "grey", r.id);
    assert.equal(r.detail, WAITING, r.id);
  }
  assert.ok(!rows.some((r) => /unreachable/.test(r.detail)), "no row calls the site unreachable");
});

test("the update's own signal (setupRunning) reads the same", () => {
  const rows = DOCTOR.evaluate(input(null, "the site answered 503", { setupRunning: true }));
  for (const r of siteRows(rows)) assert.equal(r.detail, WAITING, r.id);
});

test("the summary says it once, and the printout carries it once", () => {
  const rows = DOCTOR.evaluate(input(false, "the site answered 503"));
  const grey = (DOCTOR.summary(rows) as Group[]).find((g) => g.status === "grey")!;
  assert.match(grey.meaning, /the site is waiting for setup to finish/);
  const printed = DOCTOR.text(rows) as string;
  const header = printed.split("\n\n")[0]!;
  assert.equal(header.match(/waiting for setup to finish/g)?.length, 1, header);
  const plain = (DOCTOR.summary(DOCTOR.evaluate(input(true, "web is exited"))) as Group[]).find((g) => g.status === "grey")!;
  assert.doesNotMatch(plain.meaning, /setup/, "the note is only there while setup waits");
});

test("a 503 after setup finished is still 'site unreachable (the site answered 503)'", () => {
  const rows = DOCTOR.evaluate(input(true, "the site answered 503"));
  for (const r of siteRows(rows)) assert.equal(r.detail, "site unreachable (the site answered 503)", r.id);
});

test("before setup, a site that does not answer at all is still unreachable — only the 503 is the wait", () => {
  const rows = DOCTOR.evaluate(input(false, "web is exited"));
  for (const r of siteRows(rows)) assert.equal(r.detail, "site unreachable (web is exited)", r.id);
});

test("the update's health verdict is unchanged: a site still in setup does not fail it", () => {
  const i = input(false, "the site answered 503", { setupRunning: true });
  assert.deepEqual(DOCTOR.health(DOCTOR.evaluate(i), i).failed, []);
});

test("a step skipped in setup and set later in the panel is not listed; a step with nothing left to set is not listed", async () => {
  // setup.state.skipped is written only by setup, so the Doctor judges each record when it reads it:
  // a step whose values are all set now is done, and a step with no values can never be "done".
  const { openSkips, skipPages } = await import("./doctorSkipped.ts");
  const pages = skipPages(false);
  assert.ok(pages.length >= 5, `vacuity: ${pages.length} setup pages`);
  const none = () => false;
  const records = ["stripe:webhook", "paypal:webhook", "obs:rig", "stripe:portal", "twitch:channel", "nosuch:step"];
  // Nothing set yet: the steps with values are named by page and step, with the place to set them.
  assert.deepEqual(openSkips(records, pages, none), [
    "Card payments (Stripe): The webhook (Admin Panel → Payments → Connections)",
    "PayPal and Venmo: The webhook (Admin Panel → Payments → Connections)",
    "Twitch: Your Twitch channel (Admin Panel → Platforms → Twitch)",
  ]);
  // The Stripe webhook secret saved later in the Admin Panel: that step leaves the list.
  const set = new Set(["stripe.webhookSecret"]);
  assert.deepEqual(openSkips(records, pages, (k) => set.has(k)).filter((x) => x.startsWith("Card payments")), []);
  // Retry: a second read with nothing new set says the same.
  assert.deepEqual(openSkips(records, pages, (k) => set.has(k)), openSkips(records, pages, (k) => set.has(k)));
  // Everything set: nothing is left, and the Doctor's row is green.
  assert.deepEqual(openSkips(records, pages, () => true), []);
  const row = (skipped: string[]) => (DOCTOR.evaluate(input(true, "", { site: { skipped } })) as Row[]).find((r) => r.id === "modules.skipped")!;
  assert.equal(row([]).status, "ok");
  const amber = row(openSkips(records, pages, none));
  assert.equal(amber.status, "warn");
  assert.match(amber.detail, /Card payments \(Stripe\): The webhook/);
  assert.doesNotMatch(amber.detail, /stripe:webhook/, "no raw ids");
  // Every place named is a page the Admin Panel's rail has.
  const { adminRail, ADMIN_SECTIONS } = await import("../../features/instance/adminLayout.ts");
  const places = new Set(adminRail([]).map((x) => `${ADMIN_SECTIONS.find((s) => s.key === x.section)!.label} → ${x.label}`));
  for (const line of openSkips(pages.flatMap((p) => p.page.steps.map((s) => `${p.prefix}:${s.id}`)), pages, none)) {
    const place = /\(Admin Panel → (.+)\)$/.exec(line)?.[1];
    if (place) assert.ok(places.has(place), `${line}: ${place} is not a rail place`);
  }
});
