// The Admin Panel's rows say why and when: an install key's row carries
// the lock line and what to do instead; a module switch lists, per service, when it applies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dirname, "KeyCards.tsx"), "utf8");

test("read to the end (anchor)", () => {
  assert.match(src, /render=\{view\.render \?\? null\} \/>\)\}\s*<\/ul>\s*<\/section>\s*\);\s*\}\)\}\s*<\/>\s*\);\s*\}\s*$/);
});

test("an install key says, on the row, that it is set in the environment and how to change it", () => {
  assert.match(src, /🔒 Set in the website&apos;s environment, so it can&apos;t be changed here\. To change it: set/);
  assert.match(src, /then restart the website\./);
  assert.doesNotMatch(src, /rebuild/i, "nothing is built in");
  assert.match(src, /🔒 Set on the server only, so it can&apos;t be changed here\./);
  assert.match(src, /Not set on this install — the part that uses it stays off or uses its default\./);
});

test("a module switch says when it applies in each service, and offers a restart where the host can", () => {
  assert.match(src, /web: "at once \(the next page load\)"/);
  assert.match(src, /"stream-api": "at its next restart"/);
  assert.match(src, /"stream-ingest": "at its next restart"/);
  assert.match(src, /waiting for a restart/);
  assert.match(src, /postJson\("\/api\/admin\/restart", \{ service \}\)/);
});

test("the rest of a row waits behind Details; warnings and the pending-restart banner stay outside it", () => {
  assert.match(src, /<Fold id=\{k\.key\}>/);
  assert.match(src, /aria-label="Where each service gets it"[\s\S]*<\/Fold>/, "the per-service chips are inside the fold");
  assert.match(src, /The services do not hold the same value\.[\s\S]*<Fold id/, "the disagreement warning comes before the fold");
  assert.match(src, /Pending restart — saved settings are not in effect everywhere yet\./);
  assert.match(src, /<PendingRestart pending=\{pend\} canRestart=\{view\.canRestart === true\}/);
});
