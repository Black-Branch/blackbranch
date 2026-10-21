import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { crossSigningResetUrl, CROSS_SIGNING_RESET_STAGE } from "./matrixCrypto.ts";

// ── "Start fresh" = MSC4312 consent ──────────────────────────────────────────
//
// "Start fresh" must not depend on web and Synapse sharing a host: a mechanism
// that shells into the homeserver's database (`docker exec … psql`) fails
// silently the moment they live on different hosts — an exec-transport
// assumption is config that outlives its authority. The mechanism is MSC4312
// consent: the server refuses the cross-signing replacement with an approval
// URL on the user's MAS account page; approving there arms the retry. No
// credential, no host assumption, nothing to die silently.
//
// Pure units below hand-check the URL extraction; the source scans pin the
// flow shape and — the part that matters most — that the whole exec
// transport CLASS stays absent. Vacuity anchor at the end.

const LIB = join(process.cwd(), "app/lib");
const hookSrc = () => readFileSync(join(LIB, "useMatrixEncryptionSetup.ts"), "utf8");
const sectionSrc = () =>
  readFileSync(join(process.cwd(), "app/components/MatrixSettings/EncryptionSection.tsx"), "utf8");

// The last construct in the hook file — proves the scan read a whole file,
// not a truncated prefix (negative assertions below would go green over a hole).
function assertWholeHookRead(text: string) {
  assert.match(text, /copyKey,\s*\};\s*\}\s*$/,
    "vacuity anchor: the END of useMatrixEncryptionSetup.ts is gone — truncated read?");
}

// ── crossSigningResetUrl: the server's URL wins ──────────────────────────────

test("extracts the approval URL from an MSC4312 refusal", () => {
  const err = { data: { params: { [CROSS_SIGNING_RESET_STAGE]: {
    url: "https://matrix.site.test/auth/account?action=org.matrix.cross_signing_reset",
  } } } };
  assert.equal(
    crossSigningResetUrl(err, { account: null, deviceId: "DEV" }),
    "https://matrix.site.test/auth/account?action=org.matrix.cross_signing_reset",
    "the server-provided URL must be used verbatim",
  );
});

test("a non-http 'url' in the refusal is rejected, not opened", () => {
  // The URL is rendered as an <a href> — a javascript: value from a
  // compromised/misbehaving server must not become a click target.
  const err = { data: { params: { [CROSS_SIGNING_RESET_STAGE]: { url: "javascript:alert(1)" } } } };
  assert.equal(crossSigningResetUrl(err, { account: null, deviceId: null }), null);
});

test("falls back to the MSC4191 deep link built from the well-known account URL", () => {
  const url = crossSigningResetUrl(new Error("M_FORBIDDEN"), {
    account: "https://matrix.site.test/auth/account",
    deviceId: "ABCDEF",
  });
  assert.equal(url,
    `https://matrix.site.test/auth/account?action=${CROSS_SIGNING_RESET_STAGE}&device_id=ABCDEF`);
});

test("fallback without a device id still links; with nothing at all, null", () => {
  assert.equal(
    crossSigningResetUrl({}, { account: "https://a.example/account", deviceId: null }),
    `https://a.example/account?action=${CROSS_SIGNING_RESET_STAGE}`);
  assert.equal(crossSigningResetUrl({}, { account: null, deviceId: "X" }), null);
  assert.equal(crossSigningResetUrl({}, { account: "not a url", deviceId: "X" }), null);
});

// ── The dead transport stays dead ────────────────────────────────────────────

test("the docker-exec reset route is deleted, and nothing calls it", () => {
  assert.equal(existsSync(join(process.cwd(), "app/api/matrix/cross-signing/reset/route.ts")),
    false, "the host-coupled reset route is back from the dead");
  const text = stripComments(hookSrc());
  assertWholeHookRead(hookSrc());
  assert.doesNotMatch(text, /cross-signing\/reset/,
    "the hook still calls the deleted route — Start fresh would 404");
});

test("no exec transport anywhere under app/api/matrix (the CLASS, not the instance)", () => {
  // The bug was never "this route broke" — it was a web route assuming what
  // machine it runs on. Any child_process use under the matrix API surface
  // re-opens that class.
  const root = join(process.cwd(), "app/api/matrix");
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry.name) && readFileSync(p, "utf8").includes("child_process")) {
        hits.push(p);
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, [], "exec transport reintroduced under app/api/matrix");
});

// ── The consent flow's load-bearing shapes ───────────────────────────────────

test("Start fresh drives crypto.resetEncryption and routes the refusal through crossSigningResetUrl", () => {
  const text = stripComments(hookSrc());
  assertWholeHookRead(hookSrc());
  assert.match(text, /crypto\.resetEncryption\(/, "the reset no longer uses the SDK primitive");
  assert.match(text, /crossSigningResetUrl\(e, \{/, "the refusal's approval URL is not extracted");
  assert.match(text, /setResetApprovalUrl\(refusalUrl\)/, "the approval URL never reaches state");
  assert.match(text, /accountUrlFromWellKnown\(\)/, "the well-known fallback is unwired");
});

test("post-reset 4S mint must NOT create a second key backup (resetEncryption already did)", () => {
  const text = stripComments(hookSrc());
  assertWholeHookRead(hookSrc());
  assert.match(text, /setupNewKeyBackup: !forceNew/,
    "a second setupNewKeyBackup after resetEncryption invalidates the fresh backup");
  assert.match(text, /if \(!forceNew\) await crypto\.bootstrapCrossSigning\(\{ setupNewCrossSigning: true \}\)/,
    "first-time setup lost its identity upload, or reset gained a duplicate one");
});

test("the not-ready guards SPEAK — a click during warmup must never silently no-op", () => {
  const text = stripComments(hookSrc());
  assertWholeHookRead(hookSrc());
  const spoken = text.match(/setSetupError\("Matrix not connected yet\."\)/g) ?? [];
  assert.equal(spoken.length, 2,
    "rotateRecoveryKey and generateAndSetupEncryption must both refuse out loud");
  assert.doesNotMatch(text, /status !== "ready"\) return;/,
    "a silent not-ready return is back");
});

test("the approval UI links the account page and retries the SAME flow", () => {
  const text = stripComments(sectionSrc());
  assert.match(text, /p\.resetApprovalUrl \? \(/, "the approval branch is unreachable");
  assert.match(text, /href=\{p\.resetApprovalUrl\}/, "the approval URL is not a link");
  assert.match(text, /dismissResetApproval\(\); p\.generateAndSetupEncryption\(true\)/,
    "retry must clear the prompt and re-run the reset — approval armed the server");
});

test("the reset is reachable WITHOUT a recovery key (otherwise a lost key is a dead end)", () => {
  // A restore branch offering only "Enter recovery key", with Start
  // fresh appearing solely after a typed key failed with a mismatch error, is
  // unreachable for the person who LOST the key, which is who a reset is for.
  const text = stripComments(sectionSrc());
  assert.match(text, /Lost your recovery key\? Start fresh/,
    "the lost-key entry into the reset is gone from the restore branch");
  assert.match(text,
    /p\.setRestoreError\(null\); p\.setShowSetupFlow\(true\); \}\}[\s\S]{0,400}?Lost your recovery key\? Start fresh/,
    "the lost-key link must open the setup flow, not the key input");
  // And what that flow shows for a restore-state account is the reset confirm
  // (cost stated, Start fresh = forceNew), never the first-time "Set up
  // encryption" that would bounce off the second-identity guard.
  assert.match(text, /p\.flowState === "setup" \? \(/,
    "the setup flow no longer branches on flowState — restore-state users get the wrong offer");
  assert.match(text, /Starting fresh replaces your encryption keys/,
    "the reset confirm must state the cost before the button");
});
