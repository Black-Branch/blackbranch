// GET /api/presence's disclosure rules, run on the real shaping functions.
// Run: node --test app/lib/presenceDirectory.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { shapePresenceDirectory, supporterSets, type DirRow } from "./presenceDirectory.ts";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms);
const row = (over: Partial<DirRow> & { matrix_id: string }): DirRow => ({
  last_beat: null, last_visible: null, last_community: null, last_login: null,
  status: "online", status_text: "", ...over,
});

const SUB_BADGE = 7, OTHER_BADGE = 9;
const snap = {
  cat: [
    { id: SUB_BADGE, name: "Sub", image_url: "", is_subscriber: true, is_mod: false, unlock_criteria: null },
    { id: OTHER_BADGE, name: "Other", image_url: "", is_subscriber: false, is_mod: false, unlock_criteria: null },
  ],
  slots: [
    { matrix_id: "@wears:site.test", base_slots: 0, equipped: [SUB_BADGE] },
    { matrix_id: "@hides:site.test", base_slots: 0, equipped: [OTHER_BADGE] },
    { matrix_id: "@lapsed:site.test", base_slots: 1, equipped: [SUB_BADGE] },
    { matrix_id: "@gifted:site.test", base_slots: 0, equipped: [null, SUB_BADGE] },
  ],
  subs: [{ matrix_id: "@wears:site.test" }, { matrix_id: "@hides:site.test" }, { matrix_id: "@casey:site.test" }],
  gifts: [{ matrix_id: "@gifted:site.test" }],
  mods: [] as { matrix_id: string }[],
};

test("supporterSets: entitled = staff + subscriptions + gifts; shown = only those wearing the subscriber badge", () => {
  const { entitled, badgeShown } = supporterSets(snap, new Set(["@staff:site.test"]));
  assert.deepEqual([...entitled].sort(), ["@casey:site.test", "@gifted:site.test", "@hides:site.test", "@staff:site.test", "@wears:site.test"]);
  // @gifted equips it in slot 2 but owns only one slot (base 0 + 1): chat shows slot 1 only.
  assert.deepEqual([...badgeShown], ["@wears:site.test"]);
});

function dir(me: string, rows: DirRow[]) {
  const { entitled, badgeShown } = supporterSets(snap, new Set());
  return shapePresenceDirectory(rows, { me, now: NOW, entitled, badgeShown });
}

test("supporter goes out for someone else only when they wear the subscriber badge; the caller learns their own", () => {
  const rows = ["@wears:site.test", "@hides:site.test", "@lapsed:site.test", "@casey:site.test"].map((id) => row({ matrix_id: id }));
  const seen = dir("@casey:site.test", rows).users;
  assert.equal(seen["@wears:site.test"]!.supporter, true);
  assert.equal(seen["@hides:site.test"]!.supporter, false, "an entitlement nobody displays is private");
  assert.equal(seen["@lapsed:site.test"]!.supporter, false, "a lapsed subscriber's stale equip is masked, as chat masks it");
  assert.equal(seen["@casey:site.test"]!.supporter, true, "the caller's own (undisplayed) subscription");
  assert.equal(dir("@wears:site.test", rows).users["@casey:site.test"]!.supporter, false);
});

test("lastLogin goes only to the caller, for their own row", () => {
  const login = new Date("2026-10-15T18:42:00Z");
  const rows = [row({ matrix_id: "@casey:site.test", last_login: login }), row({ matrix_id: "@kit:site.test", last_login: login })];
  const users = dir("@casey:site.test", rows).users;
  assert.equal(users["@casey:site.test"]!.lastLogin, "2026-10-15T00:00:00.000Z");
  assert.equal(users["@kit:site.test"]!.lastLogin, null, "even if a row carried one, another person's login never leaves");
});

test("an invisible person is the id and nothing else, and is not counted", () => {
  const rows = [row({
    matrix_id: "@wears:site.test", status: "invisible", status_text: "secret", last_login: ago(1000),
    last_beat: ago(1000), last_visible: ago(1000), last_community: ago(1000),
  })];
  const d = dir("@casey:site.test", rows);
  assert.deepEqual(d.users["@wears:site.test"], {
    lastBeat: null, lastVisible: null, lastCommunity: null, lastLogin: null, status: "online", statusText: "", supporter: false,
  });
  assert.deepEqual(d.counts, { onSite: 0, inCommunity: 0 });
  // Indistinguishable from a member who has never beaten.
  assert.deepEqual(d.users["@wears:site.test"], dir("@casey:site.test", [row({ matrix_id: "@kit:site.test" })]).users["@kit:site.test"]);
});

test("visible people: beats rounded down to 30 s, counted with the shared windows", () => {
  const rows = [row({ matrix_id: "@kit:site.test", last_beat: ago(10_000), last_visible: ago(10_000), last_community: ago(10_000), status: "dnd", status_text: "busy" })];
  const d = dir("@casey:site.test", rows);
  assert.deepEqual(d.counts, { onSite: 1, inCommunity: 1 });
  const u = d.users["@kit:site.test"]!;
  assert.equal(Date.parse(u.lastBeat!) % 30_000, 0);
  assert.equal(u.status, "dnd");
  assert.equal(u.statusText, "busy");
});
