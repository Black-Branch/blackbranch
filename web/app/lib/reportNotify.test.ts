// A new report tells the streamer (KG-18): one quiet push, count only — never the reporter, the
// reported person or the reason (the alert topics are not private).
//   • the request notifyNewReport sends, and that a failed push never throws;
//   • a scan: both of the report route's inserts are followed by the notice before their answer.
// Run: node --test app/lib/reportNotify.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { notifyNewReport } from "./reportNotify.ts";
import { stripComments } from "./testSource.ts";

const { at } = createRequire(import.meta.url)("../../../stream-api/testlib/source.js") as { at: (hay: string, needle: string) => number };

type Call = { path: string; init?: RequestInit };
const recorder = () => {
  const calls: Call[] = [];
  const fetch = async (path: string, init?: RequestInit) => { calls.push({ path, init }); return new Response(null, { status: 202 }); };
  return { calls, fetch };
};

test("payload has no name or reason", async () => {
  const { calls, fetch } = recorder();
  await notifyNewReport(fetch);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.path, "/ops/notify");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
    key: "web.report.new", title: "New report", message: "1 new report — Mod Panel › Reports",
  }, "exactly these three fields: a fixed key, title and count");
});

test("retry: a failed or throwing push never fails the report, and the next report sends again", async () => {
  await notifyNewReport(async () => { throw new Error("stream-api down"); });
  await notifyNewReport(() => { throw new Error("no STREAM_API_URL"); });
  await notifyNewReport(async () => new Response("bad", { status: 500 }));
  const { calls, fetch } = recorder();
  await notifyNewReport(fetch);
  await notifyNewReport(fetch);
  assert.equal(calls.length, 2, "one request per report; the 15-minute limit is stream-api's (notify.js)");
});

const SRC = stripComments(readFileSync(join(process.cwd(), "app/api/support/report/route.ts"), "utf8"));

test("both insert branches are followed by notifyNewReport before they answer", () => {
  const msgInsert = at(SRC, "INSERT INTO site.reports (reported_id, reported_canonical_id");
  const byMessage = SRC.slice(msgInsert, at(SRC, "const clamped = clampReport(raw)"));
  assert.ok(at(byMessage, "notifyNewReport()") < at(byMessage, "return Response.json({ ok: true })"), "a report from a chat line notifies");
  const nameInsert = at(SRC, "INSERT INTO site.reports (reported_id, reporter_id, reason)");
  const byName = SRC.slice(nameInsert);
  assert.ok(at(byName, "notifyNewReport()") < at(byName, "return Response.json({ ok: true })"), "a report by name notifies");
  assert.ok(msgInsert < nameInsert);
});

test("vacuity anchor: the route scan read to the end of the file", () => {
  assert.match(SRC, /return Response\.json\(\{ ok: true \}\);\s*\}\s*$/);
});
