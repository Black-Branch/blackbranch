// The Admin Panel's Updates section. Run: node --test app/lib/updates/updates.test.ts
// What it holds: the section's verdicts ARE the doctor's Updates rows on the box's own files (one
// list); a site that is not a bundle reads grey "not a bundle install"; the buttons only drop a
// request — `update-check`, or `update-v<version>` for the release on offer and no other; the routes
// check the admin first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../testSource.ts";
import { requestHost, RELEASE_VERSION } from "../hostRequests.ts";
import type { DOCTOR as DoctorList } from "../doctor.generated.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, "../../..");
const read = (rel: string) => readFileSync(join(WEB, rel), "utf8");
// The list's own file, loaded at run time (a static import from outside web/ breaks the box's build).
const SOURCE = ((await import(join(WEB, "..", "config", "doctor.mjs"))) as { DOCTOR: typeof DoctorList }).DOCTOR;

function box() {
  const home = mkdtempSync(join(tmpdir(), "bb-upd-web-"));
  const requests = join(home, "requests"), results = join(home, "results");
  mkdirSync(requests); mkdirSync(results);
  process.env.BB_REQUESTS_DIR = requests; process.env.BB_RESULTS_DIR = results;
  const put = (name: string, v: object) => writeFileSync(join(results, name), `${JSON.stringify({ v: 1, ...v })}\n`);
  return { home, requests, results, put, done: () => { delete process.env.BB_REQUESTS_DIR; delete process.env.BB_RESULTS_DIR; rmSync(home, { recursive: true, force: true }); } };
}
const recent = () => new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
const notLive = async () => false;
const offer = (over = {}) => ({ at: recent(), ok: true, readAt: recent(), channel: "stable", current: "1.1.0",
  available: { version: "1.2.0", security: false, published: recent(), notes: "Fixes." }, refused: null, error: null, ...over });

test("not a bundle install: the section's rows are grey, like the doctor's Box rows, and no button asks anything", async () => {
  process.env.BB_REQUESTS_DIR = "/nonexistent/requests"; process.env.BB_RESULTS_DIR = "/nonexistent/results";
  try {
    const { updatesView, updatesApply } = await import("./updatesServer.ts");
    const v = await updatesView();
    assert.equal(v.bundle, false);
    assert.deepEqual(v.rows.map((r) => r.id), ["updates.feed", "updates.last"]);
    for (const r of v.rows) { assert.equal(r.status, "grey"); assert.equal(r.detail, "not a bundle install"); }
    assert.equal((await updatesApply("1.2.0")).note, "this site is not a bundle install");
  } finally { delete process.env.BB_REQUESTS_DIR; delete process.env.BB_RESULTS_DIR; }
});

test("the verdicts are the doctor's own rows on the box's files — the page and the command say the same", async () => {
  const b = box();
  try {
    const { updatesView } = await import("./updatesServer.ts");
    const quiet = offer({ readAt: "2026-01-01T00:00:00Z", ok: false, error: "the feed did not answer" });
    b.put("update-feed.json", quiet);
    b.put("update-last.json", { at: recent(), from: "1.0.0", to: "1.1.0", result: "rolled-back", ok: false, message: "failed its health check; back on 1.0.0", snapshot: "abcd", health: { ok: false }, rollbackHealth: { ok: true } });
    const v = await updatesView();
    assert.equal(v.bundle, true);
    const command = SOURCE.evaluate({ host: { at: v.at, updates: { check: { v: 1, ...quiet }, last: v.last, state: null } }, hostState: "ok", site: {}, siteError: null })
      .filter((r: { area: string }) => r.area === "Updates");
    assert.deepEqual(v.rows, command);
    const [feed, lastRow] = v.rows;
    assert.ok(feed && lastRow, "both rows");
    assert.equal(feed.status, "fail"); assert.match(feed.detail, /not read for \d+ days \(the feed did not answer\)/);
    assert.equal(lastRow.status, "warn"); assert.match(lastRow.detail, /the box went back to 1\.0\.0/);
  } finally { b.done(); }
});

test("apply asks for the release on offer and nothing else; check asks for a read", async () => {
  const b = box();
  try {
    const { updatesApply, updatesCheckNow } = await import("./updatesServer.ts");
    b.put("update-feed.json", offer());
    for (const [v, note] of [["1.3.0", /not the one on offer any more/], ["1.2", /not a release version/], ["1.2.0;reboot", /not a release version/], [42, /not a release version/]] as const) {
      assert.match((await updatesApply(v, 10, notLive)).note ?? "", note, String(v));
      assert.deepEqual(readdirSync(b.requests), [], `${v}: nothing asked`);
    }
    b.put("update-state.json", { state: "running", from: "1.1.0", to: "1.2.0", step: 4, steps: 8, words: "building", since: recent(), at: recent() });
    assert.match((await updatesApply("1.2.0", 10, notLive)).note ?? "", /already running/);
    b.put("update-state.json", { state: "idle", from: "", to: "", step: 0, steps: 8, words: "", since: recent(), at: recent() });
    b.put("update-feed.json", offer({ refused: "it runs Postgres 19" }));
    assert.match((await updatesApply("1.2.0", 10, notLive)).note ?? "", /cannot be applied here: it runs Postgres 19/);
    b.put("update-feed.json", offer());
    const asked = await updatesApply("1.2.0", 10, notLive);
    assert.deepEqual(readdirSync(b.requests), ["update-v1.2.0.req"]);
    assert.equal(readFileSync(join(b.requests, "update-v1.2.0.req"), "utf8"), "", "the version travels in the name only");
    assert.match(asked.note ?? "", /did not answer in time/);
    rmSync(join(b.requests, "update-v1.2.0.req"));
    await updatesCheckNow(10);
    assert.deepEqual(readdirSync(b.requests), ["update-check.req"]);
  } finally { b.done(); }
});

test("apply is refused while the stream is live, and nothing is asked of the box", async () => {
  const b = box();
  try {
    const { updatesApply } = await import("./updatesServer.ts");
    b.put("update-feed.json", offer());
    const v = await updatesApply("1.2.0", 10, async () => true);
    assert.match(v.note ?? "", /the stream is live/);
    assert.equal(v.live, true);
    assert.deepEqual(readdirSync(b.requests), [], "no update request while live");
    await updatesApply("1.2.0", 10, notLive);
    assert.deepEqual(readdirSync(b.requests), ["update-v1.2.0.req"], "the same request goes once the stream is not live");
  } finally { b.done(); }
});

test("the request name: only a release version rides in it", async () => {
  assert.ok(RELEASE_VERSION.test("1.2.0") && RELEASE_VERSION.test("1.2.0-beta.1"));
  for (const bad of ["1.2", "01.2.0", "1.2.0+x", "1.2.0;rm", "1.2.0/../x", "1.2.0-"]) assert.equal(RELEASE_VERSION.test(bad), false, bad);
  const b = box();
  try {
    assert.deepEqual(await requestHost("update-v1.2.0;x" as `update-v${string}`), { ok: false, error: "bad verb" });
    assert.deepEqual(readdirSync(b.requests), []);
    assert.ok((await requestHost("update-v1.2.0-beta.1")).ok);
    assert.deepEqual(readdirSync(b.requests), ["update-v1.2.0-beta.1.req"]);
  } finally { b.done(); }
  // The host accepts the same shape (install/blackbranch VERSION_RE): the two patterns agree.
  const host = readFileSync(join(WEB, "..", "install", "blackbranch"), "utf8").match(/^VERSION_RE='(.*)'$/m)?.[1];
  assert.ok(host, "the host's pattern");
  const hostRe = new RegExp(host.replace(/\\\./g, "\\."));
  for (const v of ["1.2.0", "1.2.0-beta.1", "0.0.0", "1.2", "1.2.0+x", "01.2.0", "1.2.0-Beta"]) assert.equal(hostRe.test(v), RELEASE_VERSION.test(v), v);
});

test("the routes check the admin first; the panel draws the server's rows and keeps no list of its own", () => {
  const route = stripComments(read("app/api/admin/updates/route.ts"));
  const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  const post = route.slice(route.indexOf("export async function POST"));
  assert.ok(get.indexOf("requireAdminResponse()") >= 0 && get.indexOf("requireAdminResponse()") < get.indexOf("updatesView()"));
  assert.ok(post.indexOf("requireAdminMutation(req)") >= 0 && post.indexOf("requireAdminMutation(req)") < post.indexOf("req.json()"));
  const panel = stripComments(read("app/features/instance/UpdatesPanel.tsx"));
  assert.match(panel, /view\.rows\.map\(\(r\) => <DoctorRowItem key=\{r\.id\} r=\{r\} \/>\)/);
  for (const c of SOURCE.CHECKS) assert.ok(!panel.includes(`"${c.id}"`), `the panel names ${c.id} itself`);
  const server = stripComments(read("app/lib/updates/updatesServer.ts"));
  assert.match(server, /DOCTOR\.evaluate\(\{ host: bundle \? \{ at, updates \} : null, hostState: bundle \? "ok" : "none", site: \{\}, siteError: null \}\)/);
  assert.deepEqual([...server.matchAll(/requestHost\(([^)]*)\)/g)].map((m) => m[1]), ['"update-check"', "`update-v${version}`"]);
  assert.match(read("app/features/instance/adminLayout.ts"), /\{ key: "updates", label: "Updates" \}/);
  assert.match(read("app/features/instance/AdminPanel.tsx"), /if \(section === "updates"\) return <UpdatesPanel \/>;/);
});
