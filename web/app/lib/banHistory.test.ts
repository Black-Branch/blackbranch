// A ban that deletes message history (client polish Task 21): the window, the confirm sentence,
// the order of the steps, and the ONE mod-log row the route writes.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G npx tsx --test app/lib/banHistory.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./testTsx.ts";
import { stripComments } from "./testSource.ts";
import type { ModLogEntry } from "./modlog.ts";

const {
  historySince, banConfirmText, historyReason, banHistoryResponse, banHistoryCheck, deleteHistoryAfterBan, HISTORY_WINDOWS,
} = await import("./banHistory.ts");
const { PURGE_MAX_MINUTES } = await import("./modRequests.ts");

const NOW = 1_800_000_000_000;
const MOD = "@mod:site.test";
const TARGET = "@spam:site.test";

function post(body: unknown) {
  return new Request("http://x/api/mod/ban-history", { method: "POST", body: JSON.stringify(body) });
}
function deps(over: { refuse?: Response | null } = {}) {
  const logged: ModLogEntry[] = [];
  const ceilings: string[] = [];
  return {
    logged, ceilings,
    d: {
      mod: MOD,
      ceiling: async (_actor: string, target: string) => { ceilings.push(target); return over.refuse ?? null; },
      log: async (e: ModLogEntry) => { logged.push(e); },
    },
  };
}

test("the three choices, default 'Don't delete any'", () => {
  assert.deepEqual(HISTORY_WINDOWS.map((w) => [w.value, w.label]), [
    ["none", "Don't delete any"], ["1h", "Previous hour"], ["7d", "Previous 7 days"],
  ]);
  assert.equal(HISTORY_WINDOWS[0]!.value, "none");
});

test("historySince: none → null; 1h and 7d reach back from now", () => {
  assert.equal(historySince("none", NOW), null);
  assert.equal(historySince("1h", NOW), NOW - 3_600_000);
  assert.equal(historySince("7d", NOW), NOW - 7 * 24 * 3_600_000);
});

test("the three confirm texts, exactly as above", () => {
  // Site chat off (or no site ban: a Discord member, a viewer who is not a site mod).
  assert.equal(banConfirmText("Casey", "none", false), "Ban Casey? Their messages stay.");
  assert.equal(banConfirmText("Casey", "1h", false),
    "Ban Casey and delete their messages from the last hour in every community channel? Their site chat stays. This can't be undone.");
  assert.equal(banConfirmText("Casey", "7d", false),
    "Ban Casey and delete their messages from the last 7 days in every community channel? Their site chat stays. This can't be undone.");
  // Site chat on (the ban's own purge, ticket #228 — on by default): its 24 h are named.
  assert.equal(banConfirmText("Casey", "none", true),
    "Ban Casey and remove their site chat from the last 24 hours (at most 250 messages)? Their community messages stay. This can't be undone.");
  assert.equal(banConfirmText("Casey", "1h", true),
    "Ban Casey and delete their messages from the last hour in every community channel, and from the last 24 hours in site chat (at most 250 messages)? This can't be undone.");
  assert.equal(banConfirmText("Casey", "7d", true),
    "Ban Casey and delete their messages from the last 7 days in every community channel, and from the last 24 hours in site chat (at most 250 messages)? This can't be undone.");
});

test("7d site part capped at 24 h: site chat is the ban's own purge, never 7 days", () => {
  assert.equal(PURGE_MAX_MINUTES, 24 * 60);
  assert.match(banConfirmText("Casey", "7d", true), /last 24 hours in site chat/);
  assert.doesNotMatch(banConfirmText("Casey", "7d", true), /7 days in site chat/);
});

test("one mod-log row with both counts", async () => {
  const { d, logged, ceilings } = deps();
  const res = await banHistoryResponse(post({ targetId: TARGET, window: "1h", communityRedacted: 3, communityFailed: 0, siteRemoved: 2, batchId: "6f1c1f0e-8a8b-4c2e-9d3a-1b2c3d4e5f60" }), d);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(ceilings, [TARGET], "the ceiling is asked about the target before anything is written");
  assert.deepEqual(logged, [{
    action: "history_deleted", target: TARGET, by: MOD,
    reason: "1h · 3 community · 2 site chat", batchId: "6f1c1f0e-8a8b-4c2e-9d3a-1b2c3d4e5f60",
  }]);
  assert.equal(historyReason("7d", 10, 4, null), "7d · 10 community · 4 not removed");
  assert.equal(historyReason("7d", 0, 0, 0), "7d · 0 community · 0 site chat");
});

test("the route refuses what is not a request, and a refused ceiling writes nothing", async () => {
  for (const bad of [
    null, {}, { targetId: TARGET, window: "none", communityRedacted: 0, communityFailed: 0 },
    { targetId: TARGET, window: "30d", communityRedacted: 0, communityFailed: 0 },
    { targetId: "spam", window: "1h", communityRedacted: 0, communityFailed: 0 },
    { targetId: TARGET, window: "1h", communityRedacted: -1, communityFailed: 0 },
    { targetId: TARGET, window: "1h", communityRedacted: 1.5, communityFailed: 0 },
    { targetId: TARGET, window: "1h", communityRedacted: 0, communityFailed: 0, siteRemoved: "2" },
    { targetId: TARGET, window: "1h", communityRedacted: 0, communityFailed: 0, batchId: "x; drop" },
  ]) {
    const { d, logged } = deps();
    const res = await banHistoryResponse(post(bad), d);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(logged.length, 0);
  }
  const { d, logged } = deps({ refuse: new Response("no", { status: 403 }) });
  const res = await banHistoryResponse(post({ targetId: TARGET, window: "7d", communityRedacted: 1, communityFailed: 0 }), d);
  assert.equal(res.status, 403);
  assert.equal(logged.length, 0);
});

test("`none` → no route call, ban only", async () => {
  let redacted = 0;
  let posted = 0;
  const out = await deleteHistoryAfterBan({
    check: async () => null,
    redact: async () => { redacted++; return { redacted: 0, failed: 0, rooms: 0 }; },
    post: async () => { posted++; return true; },
  }, { targetId: TARGET, window: "none", now: NOW, siteRemoved: 2, batchId: null });
  assert.equal(out, null);
  assert.equal(redacted, 0);
  assert.equal(posted, 0);
});

test("1h: the redaction from since, then ONE route call with both counts; the line says what went", async () => {
  const order: string[] = [];
  const bodies: unknown[] = [];
  const out = await deleteHistoryAfterBan({
    check: async () => null,
    redact: async (since) => { order.push(`redact ${since}`); return { redacted: 3, failed: 0, rooms: 2 }; },
    post: async (b) => { order.push("post"); bodies.push(b); return true; },
  }, { targetId: TARGET, window: "1h", now: NOW, siteRemoved: 2, batchId: null });
  assert.deepEqual(order, [`redact ${NOW - 3_600_000}`, "post"]);
  assert.deepEqual(bodies, [{ targetId: TARGET, window: "1h", communityRedacted: 3, communityFailed: 0, siteRemoved: 2, batchId: null }]);
  assert.equal(out, "Removed 3 community messages.");
});

test("the community not reachable: the site part stands, the line says so, and it is still logged", async () => {
  const bodies: unknown[] = [];
  const out = await deleteHistoryAfterBan({
    check: async () => null,
    redact: async () => null,
    post: async (b) => { bodies.push(b); return true; },
  }, { targetId: TARGET, window: "7d", now: NOW, siteRemoved: 2, batchId: null });
  assert.equal(out, "Community messages weren't removed — the community isn't reachable; try again from their member card.");
  assert.equal(bodies.length, 0, "nothing was removed in the community: no history row claims it");
});

test("some lines failed: the line counts them and points at the retry", async () => {
  const out = await deleteHistoryAfterBan({
    check: async () => null,
    redact: async () => ({ redacted: 5, failed: 2, rooms: 3 }),
    post: async () => true,
  }, { targetId: TARGET, window: "7d", now: NOW, siteRemoved: null, batchId: null });
  assert.equal(out, "Removed 5 community messages; 2 couldn't be removed — try again from their member card.");
});

test("the ceiling refuses: nothing is redacted, nothing is posted, and the line says why (reviewer, round 1)", async () => {
  // Matrix judges a redaction on the redactor's power alone, so a power-50 mod's client could
  // delete a Staff member's or an admin's lines; the site's ceiling must answer FIRST.
  let redacted = 0;
  let posted = 0;
  const out = await deleteHistoryAfterBan({
    check: async () => "An admin can't be moderated by a mod.",
    redact: async () => { redacted++; return { redacted: 9, failed: 0, rooms: 3 }; },
    post: async () => { posted++; return true; },
  }, { targetId: TARGET, window: "7d", now: NOW, siteRemoved: null, batchId: null });
  assert.equal(redacted, 0, "not one line redacted");
  assert.equal(posted, 0);
  assert.equal(out, "Community messages weren't removed: An admin can't be moderated by a mod.");
});

test("a history row that could not be written is said, never reported as plain success", async () => {
  const out = await deleteHistoryAfterBan({
    check: async () => null,
    redact: async () => ({ redacted: 3, failed: 0, rooms: 1 }),
    post: async () => false,
  }, { targetId: TARGET, window: "1h", now: NOW, siteRemoved: 2, batchId: null });
  assert.equal(out, "Removed 3 community messages. The mod history couldn't record it.");
});

test("GET check: the ceiling alone, on a Matrix id, writing nothing", async () => {
  const get = (q: string) => new Request(`http://x/api/mod/ban-history${q}`);
  const { d, logged, ceilings } = deps();
  const ok = await banHistoryCheck(get(`?targetId=${encodeURIComponent(TARGET)}`), d);
  assert.equal(ok.status, 200);
  assert.deepEqual(ceilings, [TARGET]);
  for (const q of ["", "?targetId=spam", `?targetId=${"@x:" + "a".repeat(300)}`]) {
    assert.equal((await banHistoryCheck(get(q), d)).status, 400, q);
  }
  const refusing = deps({ refuse: new Response("no", { status: 403 }) });
  assert.equal((await banHistoryCheck(get(`?targetId=${encodeURIComponent(TARGET)}`), refusing.d)).status, 403);
  assert.equal(logged.length + refusing.logged.length, 0);
});

test("the route shell is the handler with requireMod and the ceiling (end anchor)", () => {
  const src = stripComments(readFileSync(new URL("../api/mod/ban-history/route.ts", import.meta.url), "utf8"));
  const at = (re: RegExp) => { const m = re.exec(src); assert.ok(m, String(re)); return m.index; };
  const auth = at(/await requireMod\(\)/);
  const ceiling = at(/assertCanModerate\(/);
  const handler = at(/return banHistoryResponse\(req,/);
  // Both verbs name the ceiling: the check (GET) and the row (POST).
  assert.equal((src.match(/assertCanModerate\(actor, target\)/g) ?? []).length, 2);
  assert.ok(src.indexOf("return banHistoryCheck(req,") > 0, "the GET runs the check handler");
  assert.ok(auth < handler && ceiling < src.length);
  // Vacuity anchor: the scan read the whole file — the handler's call is its last statement.
  assert.match(src.trimEnd(), /\}\);\s*\}$/);
});
