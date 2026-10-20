// `blackbranch doctor`'s evaluator. The box has no Node of its own, so blackbranch runs
// this with node inside the stream-api image, the release's config/ and install/ mounted read-only.
// Reads two lines on stdin: { host, hostState, siteError, release, at }, then the site's facts as
// the site sent them (empty when it did not answer; unreadable ones count as "did not answer").
// Prints the list (default), the shareable report (--report), or the update's health verdict
// (--health: the failing UPDATE_CHECKS rows, then `BBDOCTOR [ids]`). Exit 1 when a check fails.
// The checks themselves are config/doctor.mjs: the same list the Admin Panel's page evaluates.
import { DOCTOR } from "../config/doctor.mjs";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const [head = "", ...rest] = Buffer.concat(chunks).toString("utf8").split("\n");
let input;
try {
  input = JSON.parse(head);
} catch {
  process.stderr.write("doctor: the host's facts were not JSON\n");
  process.exit(2);
}
let site = null;
let siteError = typeof input.siteError === "string" ? input.siteError : null;
const siteText = rest.join("\n").trim();
if (siteText) {
  try { site = JSON.parse(siteText); } catch { siteError = "its answer was not readable"; }
} else if (!siteError) siteError = "no answer";
const hostState = ["ok", "none", "missing"].includes(input.hostState) ? input.hostState : "missing";
const rows = DOCTOR.evaluate({ host: input.host ?? null, hostState, site, siteError: site ? null : siteError });
if (process.argv.includes("--health")) {
  const v = DOCTOR.health(rows, { site, setupRunning: input.setupRunning === true });
  for (const r of v.rows) process.stdout.write(`[FAIL] ${r.title}${r.detail ? ` — ${r.detail}` : ""}\n`);
  if (v.ok) process.stdout.write(`ok: ${DOCTOR.UPDATE_CHECKS.length} checks${site ? "" : " (the site's own facts are not served while setup runs; the box's checks only)"}\n`);
  process.stdout.write(`BBDOCTOR ${JSON.stringify(v.failed)}\n`);
  process.exit(v.ok ? 0 : 1);
}
if (process.argv.includes("--report")) {
  process.stdout.write(DOCTOR.report({ rows, release: input.release, modules: site?.modules ?? null, at: input.at }));
} else {
  process.stdout.write(`${DOCTOR.text(rows)}\n`);
}
process.exit(rows.some((r) => r.status === "fail") ? 1 : 0);
