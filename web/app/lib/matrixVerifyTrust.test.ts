import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { refreshOwnIdentityFromServer } from "./matrixCrypto.ts";

// ── Verification must work both ways ─────────────────────────────────────────
//
// Three client rules:
//
//   A. A recovery-key restore must not end in the "stale signature" verdict and
//      the "Start this device over" button on a device the server has ALREADY
//      signed. Mechanism: createClient runs on the default MemoryStore, so
//      every page load is an initial sync with no device_lists history; a
//      signature added to our device while the tab was closed is never fetched,
//      and Synapse silently skips the duplicate self-signature the restore
//      uploads (no device-update notify → nothing dirties our own user). The
//      OlmMachine's copy of our identity stays stale, `trustsOurOwnDevice()`
//      stays false, and the 15 s wait would end in a verdict built on a local
//      snapshot. The lever: CryptoApi.userHasCrossSigningKeys(ownUserId) makes
//      the rust layer re-query our own keys ("make sure we have an up-to-date
//      idea of the user's cross-signing keys") — pinned against the SDK below.
//   D. The "Secure your account" nudge runs its own useMatrixSettings, and its
//      verification effect must not CONSUME the incoming request (and ack the
//      provider) while rendering no verification UI — a request sent from
//      another device would vanish. Pinned by useMatrixVerification.render.test.ts
//      (behaviour) and the nudge scan here (wiring).
//   E. The per-device Verify button is not gated on `crossSigningOk`: an
//      unverified device must be able to START a verification, as the copy
//      beside it promises ("or verify from one of your other devices"). No
//      recovery key is required first: a verified peer vouches for us and the
//      SDK gossips the secrets.

// ── A: the refresh helper ────────────────────────────────────────────────────

test("refreshOwnIdentityFromServer asks the SDK about OUR user id, and waits for the answer", async () => {
  const calls: string[] = [];
  let settled = false;
  const crypto = {
    userHasCrossSigningKeys: (userId: string) => {
      calls.push(userId);
      return new Promise<boolean>((r) => setTimeout(() => { settled = true; r(true); }, 5));
    },
  };
  await refreshOwnIdentityFromServer(crypto, "@glitch:site.test");
  assert.deepEqual(calls, ["@glitch:site.test"]);
  assert.equal(settled, true, "the key query must be awaited — a re-read of trust before it lands is the same stale read");
});

test("refreshOwnIdentityFromServer swallows a rejection and a missing method — a failed refresh falls through to the existing diagnosis", async () => {
  await refreshOwnIdentityFromServer({ userHasCrossSigningKeys: () => Promise.reject(new Error("offline")) }, "@u:x");
  await refreshOwnIdentityFromServer({}, "@u:x");
  await refreshOwnIdentityFromServer(null, "@u:x");
});

test("SDK: userHasCrossSigningKeys re-queries the keys of a TRACKED own user before reading the identity", () => {
  // Pinned against node_modules on purpose: the refresh is only a refresh
  // while the SDK issues /keys/query for our own tracked user inside this
  // method. If an upgrade drops that, the helper becomes a no-op and A is back.
  const rc = stripComments(readFileSync(join(process.cwd(), "node_modules/matrix-js-sdk/lib/rust-crypto/rust-crypto.js"), "utf8"));
  const start = rc.indexOf("async userHasCrossSigningKeys(");
  assert.ok(start > 0, "userHasCrossSigningKeys not found in the SDK");
  const end = rc.indexOf("\n  }\n", start);
  const fn = rc.slice(start, end);
  const ownUser = fn.indexOf("userId === this.userId");
  const query = fn.indexOf("queryKeysForUsers(");
  const send = fn.indexOf("makeOutgoingRequest(request)");
  const read = fn.indexOf("getIdentity(rustTrackedUser)");
  assert.ok(ownUser > 0, "the own-user branch is gone");
  assert.ok(query > ownUser && send > query, "the own-user branch must issue and SEND a key query");
  assert.ok(read > send, "the identity must be read AFTER the query lands");
});

// ── Integration sites (source scans, comments stripped) ──────────────────────

const LIB = join(process.cwd(), "app/lib");
const COMPONENTS = join(process.cwd(), "app/components");
const read = (p: string) => stripComments(readFileSync(p, "utf8"));
const setupSrc = () => read(join(LIB, "useMatrixEncryptionSetup.ts"));
const settingsSrc = () => read(join(LIB, "useMatrixSettings.ts"));
const verificationSrc = () => read(join(LIB, "useMatrixVerification.ts"));
const nudgeSrc = () => read(join(COMPONENTS, "SecureAccountPromptInner.tsx"));
const deviceSrc = () => read(join(COMPONENTS, "MatrixSettings/DeviceSection.tsx"));
const verifySectionSrc = () => read(join(COMPONENTS, "MatrixSettings/VerificationSection.tsx"));
const encryptionSectionSrc = () => read(join(COMPONENTS, "MatrixSettings/EncryptionSection.tsx"));

// Vacuity anchors: the LAST construct of each file, so a truncated read can't
// turn the negative assertions below green.
const anchorSetup = (s: string) => assert.match(s, /copyKey,\s*\};\s*\}\s*$/, "END of useMatrixEncryptionSetup.ts not read");
const anchorSettings = (s: string) =>
  assert.match(s, /export type MatrixSettingsState = ReturnType<typeof useMatrixSettings>;\s*$/, "END of useMatrixSettings.ts not read");
const anchorVerification = (s: string) => assert.match(s, /mismatchSas,\s*\};\s*\}\s*$/, "END of useMatrixVerification.ts not read");
const anchorNudge = (s: string) => assert.match(s, /<\/div>\s*\);\s*\}\s*$/, "END of SecureAccountPromptInner.tsx not read");
const anchorDevice = (s: string) => assert.match(s, /<\/div>\s*\);\s*\}\s*$/, "END of DeviceSection.tsx not read");
const anchorVerifySection = (s: string) => assert.match(s, /<\/div>\s*\);\s*\}\s*$/, "END of VerificationSection.tsx not read");
const anchorEncryptionSection = (s: string) => assert.match(s, /<\/div>\s*\);\s*\}\s*$/, "END of EncryptionSection.tsx not read");

test("A: the restore's 15 s wait refreshes our identity from the server and re-reads trust BEFORE any verdict", () => {
  const s = setupSrc();
  anchorSetup(s);
  const fnStart = s.indexOf("async function confirmVerification(");
  const fnEnd = s.indexOf("\n  }\n", fnStart);
  assert.ok(fnStart > 0 && fnEnd > fnStart, "confirmVerification not found");
  const fn = s.slice(fnStart, fnEnd);
  const firstTrust = fn.indexOf("trustsOurOwnDevice()");
  const refresh = fn.indexOf("refreshOwnIdentityFromServer(");
  const diagnose = fn.indexOf("diagnoseVerifyFailure(");
  assert.ok(firstTrust > 0, "must read local trust first (the cheap, usual success)");
  assert.ok(refresh > firstTrust, "the refresh runs only after a local miss");
  assert.ok(diagnose > refresh, "the diagnosis must come AFTER the refresh — a verdict on the stale snapshot is a false 'stale-signature'");
  // The refresh is pointless unless trust is read AGAIN afterwards, and that
  // second read must be able to end in the success branch.
  const after = fn.slice(refresh, diagnose);
  assert.match(after, /trustsOurOwnDevice\(\)/, "trust must be re-read after the refresh");
  assert.match(after, /Device verified/, "a refreshed trust must reach the success message, not the failure path");
});

test("A: the settings status check refreshes ONCE per mount when the server has an identity that doesn't trust us yet", () => {
  const s = settingsSrc();
  anchorSettings(s);
  const start = s.indexOf("const checkCrossSigningStatus = useCallback(");
  const end = s.indexOf("}, [status, client]);", start);
  assert.ok(start > 0 && end > start, "checkCrossSigningStatus not found");
  const fn = s.slice(start, end);
  const refresh = fn.indexOf("refreshOwnIdentityFromServer(");
  assert.ok(refresh > 0, "the status check must refresh from the server");
  assert.ok(refresh > fn.indexOf("trustsOurOwnDevice()"), "…only after a local miss");
  assert.ok(refresh < fn.indexOf("setCrossSigningOk(trusted)"), "…and BEFORE the verdict is published (the Verify button, the traffic light and the flow state all read it)");
  // Once per mount: a ref latch, so a genuinely untrusted device doesn't fire
  // a /keys/query on every UserTrustStatusChanged re-check.
  assert.match(s, /const refreshedOwnIdentityRef = useRef\(false\);/, "the once-per-mount latch is a ref");
  const before = fn.slice(0, refresh);
  assert.match(before, /!refreshedOwnIdentityRef\.current/, "the refresh is gated on the latch");
  assert.match(before, /refreshedOwnIdentityRef\.current = true;/, "…and sets it before awaiting, so a re-entrant check can't double-fire");
  assert.match(fn.slice(refresh), /trustsOurOwnDevice\(\)/, "trust must be re-read after the refresh");
});

test("D: the nudge's settings hook does NOT consume the incoming verification request", () => {
  const nudge = nudgeSrc();
  anchorNudge(nudge);
  assert.match(nudge, /useMatrixSettings\(\{ consumeVerification: false \}\)/, "the nudge renders no verification UI, so it must leave the request to Devices & Security");
  const settings = settingsSrc();
  anchorSettings(settings);
  assert.match(settings, /consumeVerification = true,/, "the option defaults to consuming (Devices & Security is the one consumer)");
  assert.match(settings, /useMatrixVerification\(\{[\s\S]*?consume: consumeVerification,[\s\S]*?\}\)/, "…and is handed to the verification hook");
  const verification = verificationSrc();
  anchorVerification(verification);
  assert.match(verification, /if \(!consume \|\| !pendingVerification \|\| verifyPhase !== "idle"\) return;/, "a non-consuming mount returns before touching the request");
});

test("E: the per-device Verify button no longer waits for this device to be trusted", () => {
  const s = deviceSrc();
  anchorDevice(s);
  assert.match(s, /d\.verified === false && p\.verifyPhase === "idle" \? \(/, "the button shows for any unverified device while no flow is running");
  assert.doesNotMatch(s, /crossSigningOk/, "DeviceSection must not read crossSigningOk anywhere — the gate is what made the promised path unreachable");
  const enc = encryptionSectionSrc();
  anchorEncryptionSection(enc);
  assert.match(enc, /or verify from one of your other devices/, "the copy that promises the path must still be there — the fix makes it TRUE, not gone");
});

test("E: the incoming-request branch no longer claims a recovery key is required first", () => {
  const s = verifySectionSrc();
  anchorVerifySection(s);
  assert.doesNotMatch(s, /Enter your recovery key first/, "a verified peer vouches for this device; the SDK gossips the secrets");
  assert.doesNotMatch(s, /crossSigningOk/, "nothing in the section reads crossSigningOk once that line is gone");
  assert.match(s, /wants to verify this session\./, "the incoming prompt itself stays");
});
