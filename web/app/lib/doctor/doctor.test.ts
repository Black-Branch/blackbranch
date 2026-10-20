// The doctor page: the page and `blackbranch doctor` show
// ONE list — the same ids, verdicts and fix lines — and everything the site gathers only reads.
// The verdicts themselves are tested where the list lives (install/doctor.test.mjs).
// Run: node --test app/lib/doctor/doctor.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCTOR } from "../doctor.generated.mjs";
import { doctorKeyOk } from "./doctorKey.ts";
import { stripComments } from "../testSource.ts";

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, "../../..");
const REPO = join(WEB, "..");
const read = (rel: string) => readFileSync(join(WEB, rel), "utf8");
// The list's own file, loaded at run time: a static import of a file outside web/ breaks the web
// build on a box, whose builder holds web/ alone (tsc checks test files too).
const sourcePath = join(REPO, "config", "doctor.mjs");
const SOURCE = ((await import(sourcePath)) as { DOCTOR: typeof DOCTOR }).DOCTOR;

test("the page and the command evaluate the same list: same ids, same verdicts, same fix lines", () => {
  const input = { host: { mode: "tunnel", memTotalMiB: 1000 }, hostState: "ok" as const, site: null, siteError: "web is exited" };
  const page = DOCTOR.evaluate(input);
  const command = SOURCE.evaluate(input);
  assert.ok(page.length >= 28, `vacuity: ${page.length} rows`);
  assert.deepEqual(page, command);
  assert.deepEqual(page.map((r) => r.id), SOURCE.CHECKS.map((c) => c.id));
  // The command prints every one of them (install/doctor.mjs prints DOCTOR.text of these rows).
  const printed = SOURCE.text(command);
  for (const r of page) assert.ok(printed.includes(r.title), `${r.id} is on the page but not printed`);
  assert.match(readFileSync(join(REPO, "install/doctor.mjs"), "utf8"), /DOCTOR\.evaluate\(/);
});

test("the page renders the server's rows and keeps no list of its own", () => {
  const panel = stripComments(read("app/features/instance/DoctorPanel.tsx"));
  assert.match(panel, /view\.rows\.filter\(\(r\) => r\.area === a\)\.map\(\(r\) => <DoctorRowItem key=\{r\.id\} r=\{r\} \/>\)/);
  assert.match(panel, /data-check=\{r\.id\}/);
  for (const c of SOURCE.CHECKS) assert.ok(!panel.includes(`"${c.id}"`), `the panel names ${c.id} itself`);
  const server = stripComments(read("app/lib/doctor/doctorServer.ts"));
  assert.match(server, /import \{ DOCTOR \} from "\.\.\/doctor\.generated\.mjs";/);
  assert.match(server, /DOCTOR\.evaluate\(\{ host, hostState: !bundle \? "none" : host \? "ok" : "missing", site, siteError: null \}\)/);
  // The panel is the Admin Panel's Doctor section (/admin/doctor), admin-only like the rest.
  assert.match(read("app/features/instance/adminLayout.ts"), /\{ key: "doctor", label: "Doctor" \}/);
  assert.match(read("app/features/instance/AdminPanel.tsx"), /if \(section === "doctor"\) return <DoctorPanel \/>;/);
});

test("the routes: the page's is admin-only, the command's needs the secret, and both only read", () => {
  const admin = stripComments(read("app/api/admin/doctor/route.ts"));
  const get = admin.slice(admin.indexOf("export async function GET"), admin.indexOf("export async function POST"));
  const post = admin.slice(admin.indexOf("export async function POST"));
  assert.ok(get.indexOf("requireAdminResponse()") >= 0 && get.indexOf("requireAdminResponse()") < get.indexOf("doctorView()"));
  assert.ok(post.indexOf("requireAdminMutation(req)") >= 0 && post.indexOf("requireAdminMutation(req)") < post.indexOf("doctorRecheck()"));
  const facts = stripComments(read("app/api/doctor/facts/route.ts"));
  assert.match(facts, /if \(!doctorKeyOk\(req\.headers\.get\("x-doctor-key"\)\)\) return Response\.json\(\{ error: "not found" \}, \{ status: 404 \}\);\n {2}return Response\.json\(await gatherSiteFacts\(\)/);
  assert.match(readFileSync(join(REPO, "install/blackbranch"), "utf8"), /'x-doctor-key':process\.env\.STREAM_API_SECRET/);
});

test("the site's facts only read: SELECTs, GETs, and module Tests that record nothing", () => {
  const src = stripComments(read("app/lib/doctor/doctorFacts.ts"));
  assert.match(src, /skipped: Array\.isArray\(state\?\.skipped\)[^\n]*\n {2}\};\n\}\s*$/, "vacuity: the file was read to its end");
  const sql = [...src.matchAll(/"(SELECT[^"]*)"|`(\s*SELECT[\s\S]*?)`/g)].map((m) => m[1] ?? m[2] ?? "");
  assert.ok(sql.length >= 4, `vacuity: ${sql.length} statements found`);
  assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/);
  // Every outgoing fetch is a GET; the one POST is stream-api's Test with record:false, asked only
  // of a stream-api that says it can (an older one would store the result).
  assert.equal((src.match(/method: "POST"/g) ?? []).length, 1);
  assert.match(src, /streamApiFetch\(`\/config\/test\/\$\{encodeURIComponent\(key\)\}`, \{\n\s*method: "POST", headers: \{ "Content-Type": "application\/json" \}, body: JSON\.stringify\(\{ record: false \}\),/);
  assert.ok(src.indexOf('snap.features?.includes("test-unrecorded")') < src.indexOf("/config/test/"), "the feature is checked before the Test is asked for");
  assert.doesNotMatch(src, /runInstanceTest|\/config\/report|requestHost/, "nothing that records or asks the host");
  const server = stripComments(read("app/lib/doctor/doctorServer.ts"));
  assert.deepEqual([...server.matchAll(/requestHost\("([a-z-]+)"\)/g)].map((m) => m[1]), ["doctor"], "Check again asks the host for the doctor verb only");
});

test("the command's key: the secret itself, compared in constant time; nothing without one", () => {
  assert.equal(doctorKeyOk("s3cret-value", "s3cret-value"), true);
  assert.equal(doctorKeyOk("s3cret-valuf", "s3cret-value"), false);
  assert.equal(doctorKeyOk("", "s3cret-value"), false);
  assert.equal(doctorKeyOk(null, "s3cret-value"), false);
  assert.equal(doctorKeyOk("anything", ""), false, "no secret configured: the door is shut");
  assert.equal(doctorKeyOk("anything", undefined), false);
});
