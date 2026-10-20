import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import {
  fetchServerDeviceKeys,
  ownDeviceKeyState,
  verifyFailureMessage,
  diagnoseVerifyFailure,
  FRESH_DEVICE_ACTION,
} from "./matrixDeviceKeys.ts";

const USER_ID = "@casey:site.test";
const DEVICE_ID = "web1d058e4152d9444f87";
const SSK_ID = "Xv6zOElMpFQ5G6RFsYiDSPTDfFZn1wYgO75qNWGCEs";
const USER = USER_ID, DEVICE = DEVICE_ID, SSK = SSK_ID;

// The signature lookup and the classifier are module-private (the orphan gate
// counts references from OTHER production files, and only diagnoseVerifyFailure
// has one), so they are exercised through it.
const diagnose = (local: string, server: Parameters<typeof diagnoseVerifyFailure>[0]["server"], ssk: string | null = SSK_ID) =>
  diagnoseVerifyFailure({ local: { ed25519: local }, server, userId: USER_ID, deviceId: DEVICE_ID, selfSigningKey: ssk });

// ── A restore that hangs at "Confirming verification…" ───────────────────────
//
// If a device re-uploads device keys under its LIVE device id (the one act the
// crypto invariants forbid), the cross-signing signature the server holds was
// made over the old keys, and Synapse SKIPS a self-signature upload for a
// device it already has one for — a 200 with no failure entry. So a
// recovery-key restore can never succeed, and nothing in the client says so.
//
// Three rules, each pinned below:
//   1. the pure classifiers name the failure from the server's state;
//   2. setupCrypto compares local keys to the server's copy BEFORE the first
//      sync (which would overwrite them) and discards a mismatched device;
//   3. the restore's 15 s wait ends in a spoken failure + the one remedy that
//      works, not silence.


const serverCopy = (ed25519: string, signedBy: string | null = null) => ({
  keys: { [`ed25519:${DEVICE}`]: ed25519, [`curve25519:${DEVICE}`]: "curve" },
  signatures: {
    [USER]: {
      [`ed25519:${DEVICE}`]: "self-sig",
      ...(signedBy ? { [`ed25519:${signedBy}`]: "ssk-sig" } : {}),
    },
  },
});

// ── ownDeviceKeyState ────────────────────────────────────────────────────────

test("no server entry → absent (a device that never uploaded is not a mismatch)", () => {
  assert.equal(ownDeviceKeyState({ ed25519: "A" }, null, DEVICE), "absent");
  assert.equal(ownDeviceKeyState({ ed25519: "A" }, { keys: {} }, DEVICE), "absent");
});

test("same ed25519 key → match; a different one → mismatch", () => {
  assert.equal(ownDeviceKeyState({ ed25519: "A" }, serverCopy("A"), DEVICE), "match");
  assert.equal(ownDeviceKeyState({ ed25519: "A" }, serverCopy("B"), DEVICE), "mismatch");
});

test("the comparison is keyed by THIS device id, not any ed25519 entry", () => {
  const other = { keys: { "ed25519:otherdevice": "A" } };
  assert.equal(ownDeviceKeyState({ ed25519: "A" }, other, DEVICE), "absent");
});

// ── classification (through diagnoseVerifyFailure) ───────────────────────────

test("keys differ from the server's copy → keys-replaced, whatever the signature says", () => {
  assert.equal(diagnose("A", serverCopy("B", SSK)), "keys-replaced");
  assert.equal(diagnose("A", serverCopy("B")), "keys-replaced");
});

test("keys match but the server already holds a signature we don't trust → stale-signature", () => {
  // The desktop's exact state: local == server keys, a signature row from
  // before the keys changed, Synapse refusing to replace it.
  assert.equal(diagnose("A", serverCopy("A", SSK)), "stale-signature");
});

test("keys match and no signature landed → not-signed", () => {
  assert.equal(diagnose("A", serverCopy("A")), "not-signed");
  assert.equal(diagnose("A", null), "not-signed", "no server entry at all");
});

test("the signature lookup is by ed25519:<self-signing key>, and needs a known key", () => {
  // A signature by some OTHER key is not ours.
  assert.equal(diagnose("A", serverCopy("A", "someOtherKey")), "not-signed");
  // No known SSK = nothing to look for → not-signed, never stale-signature.
  assert.equal(diagnose("A", serverCopy("A", SSK), null), "not-signed");
});

test("every failure message names the remedy the section's button carries", () => {
  for (const f of ["keys-replaced", "stale-signature", "not-signed"] as const) {
    const msg = verifyFailureMessage(f);
    assert.ok(msg.startsWith("Verification failed"), `${f}: must open by saying it failed — the hang's whole defect was never saying so`);
    assert.ok(msg.includes(FRESH_DEVICE_ACTION), `${f}: must name the remedy`);
  }
});

// ── fetchServerDeviceKeys ────────────────────────────────────────────────────

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  }) as typeof fetch;
  return { fn, calls };
}

const client = { baseUrl: "https://matrix.site.test", getAccessToken: () => "tok" };

test("asks /keys/query for exactly this device, with the bearer token", async () => {
  const { fn, calls } = fakeFetch(200, { device_keys: { [USER]: { [DEVICE]: serverCopy("A") } } });
  const got = await fetchServerDeviceKeys(client, USER, DEVICE, fn);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, "https://matrix.site.test/_matrix/client/v3/keys/query");
  assert.equal(call.init.method, "POST");
  assert.equal((call.init.headers as Record<string, string>).Authorization, "Bearer tok");
  assert.deepEqual(JSON.parse(String(call.init.body)), { device_keys: { [USER]: [DEVICE] } });
  assert.deepEqual(got, serverCopy("A"));
});

test("no entry for the device → null, not a throw (a new device has none yet)", async () => {
  const { fn } = fakeFetch(200, { device_keys: { [USER]: {} } });
  assert.equal(await fetchServerDeviceKeys(client, USER, DEVICE, fn), null);
  const { fn: empty } = fakeFetch(200, {});
  assert.equal(await fetchServerDeviceKeys(client, USER, DEVICE, empty), null);
});

test("a non-2xx or a missing token throws — an unanswered question is not 'absent'", async () => {
  const { fn } = fakeFetch(502, {});
  await assert.rejects(() => fetchServerDeviceKeys(client, USER, DEVICE, fn), /502/);
  await assert.rejects(
    () => fetchServerDeviceKeys({ ...client, getAccessToken: () => null }, USER, DEVICE, fn),
    /no access token/,
  );
});

// ── Integration sites (source scans, comments stripped) ──────────────────────

const LIB = join(process.cwd(), "app/lib");
const ctxSrc = () => stripComments(readFileSync(join(LIB, "MatrixClientContext.tsx"), "utf8"));
const hookSrc = () => stripComments(readFileSync(join(LIB, "useMatrixEncryptionSetup.ts"), "utf8"));
const sectionSrc = () =>
  stripComments(readFileSync(join(process.cwd(), "app/components/MatrixSettings/EncryptionSection.tsx"), "utf8"));

// Vacuity anchors: the LAST construct of each file, so a truncated read can't
// turn the negative assertions below green.
function anchorCtx(s: string) {
  assert.match(s, /<\/Ctx\.Provider>\s*\);\s*\}\s*$/, "END of MatrixClientContext.tsx not read");
}
function anchorHook(s: string) {
  assert.match(s, /copyKey,\s*\};\s*\}\s*$/, "END of useMatrixEncryptionSetup.ts not read");
}
function anchorSection(s: string) {
  assert.match(s, /<\/div>\s*\);\s*\}\s*$/, "END of EncryptionSection.tsx not read");
}

test("boot: setupCrypto checks the server's copy AFTER initRustCrypto and BEFORE any sync could overwrite it", () => {
  const s = ctxSrc();
  anchorCtx(s);
  const fnStart = s.indexOf("async function setupCrypto(");
  const fnEnd = s.indexOf("\n}\n", fnStart);
  assert.ok(fnStart > 0 && fnEnd > fnStart, "setupCrypto not found");
  const fn = s.slice(fnStart, fnEnd);
  const init = fn.indexOf("initRustCrypto(");
  const check = fn.indexOf("fetchServerDeviceKeys(");
  const state = fn.indexOf('ownDeviceKeyState(');
  const discard = fn.lastIndexOf("throw new CryptoStoreResetError(");
  assert.ok(init > 0, "initRustCrypto call missing");
  assert.ok(check > init, "the server copy must be fetched after the store is open (local keys exist only then)");
  assert.ok(state > check, "the comparison must follow the fetch");
  assert.ok(discard > state, "a mismatch must end in the same discard as a corrupt store");
  // The mismatch branch discards the STORE and the DEVICE, not just the run.
  const branch = fn.slice(state, fn.indexOf("}", discard));
  assert.match(branch, /deleteMatrixDatabases\(n => n\.startsWith\(userPrefix\)\)/, "mismatch must delete this user's stores");
  assert.match(branch, /clearDeviceId\(\)/, "mismatch must forget the device id");
  assert.match(branch, /\/api\/matrix\/logout/, "mismatch must revoke the device server-side");
  // The check is best-effort on transport: a failed fetch must NOT throw the reset.
  assert.match(fn, /fetchServerDeviceKeys\([\s\S]*?\.catch\(/, "a failed /keys/query must be caught, not treated as a mismatch");
  // And the sync that would overwrite the server's copy starts only in startClient, after setupCrypto.
  const setupCall = s.indexOf("await setupCrypto(mxClient, userId, deviceId)");
  const start = s.indexOf("mxClient.startClient(");
  assert.ok(setupCall > 0 && start > setupCall, "startClient must follow setupCrypto");
});

test("SDK: initRustCrypto does not itself flush outgoing requests — the boot check runs before the first upload", () => {
  // Pinned against node_modules on purpose: the boot check is only sound while
  // the SDK's first /keys/upload waits for a sync. If an upgrade moves it, this
  // is the test that must go red.
  const sdk = stripComments(readFileSync(join(process.cwd(), "node_modules/matrix-js-sdk/lib/rust-crypto/index.js"), "utf8"));
  assert.match(sdk, /export async function initRustCrypto\(/, "initRustCrypto not found in the SDK");
  assert.doesNotMatch(sdk, /doProcessOutgoingRequests|processOutgoingRequests/, "initRustCrypto now flushes requests — re-check the boot ordering");
  const rc = stripComments(readFileSync(join(process.cwd(), "node_modules/matrix-js-sdk/lib/rust-crypto/rust-crypto.js"), "utf8"));
  assert.match(rc, /onSyncCompleted\([\s\S]*?doProcessOutgoingRequests\(\)/, "the first flush must be sync-driven");
});

test("restore: the 15 s wait ends in a spoken failure, not silence", () => {
  const s = hookSrc();
  anchorHook(s);
  // The pending path schedules confirmVerification, which re-checks trust and
  // otherwise diagnoses + speaks.
  assert.match(s, /setVerifyPending\(true\);\s*schedule\(\(\) => \{ void confirmVerification\(/, "the 15 s timer must run confirmVerification");
  const fnStart = s.indexOf("async function confirmVerification(");
  const fnEnd = s.indexOf("\n  }\n", fnStart);
  assert.ok(fnStart > 0 && fnEnd > fnStart, "confirmVerification not found");
  const fn = s.slice(fnStart, fnEnd);
  assert.match(fn, /trustsOurOwnDevice\(\)/, "must re-check trust before declaring failure");
  assert.match(fn, /diagnoseVerifyFailure\(/, "must classify from the server's state");
  assert.match(fn, /setRestoreError\(verifyFailureMessage\(/, "must speak the failure");
  assert.match(fn, /setRestoreNeedsFreshDevice\(true\)/, "must offer the remedy");
  assert.match(fn, /setVerifyPending\(false\)/, "must end the spinner");
  // A new attempt clears the remedy offer.
  assert.match(s, /setRestoring\(true\);[\s\S]*?setRestoreNeedsFreshDevice\(false\)/, "applyRecoveryKey must reset the offer");
  // The remedy IS the existing sign-out-everything unit (session + stores + device id together).
  assert.match(s, /startDeviceOver: signOutEverything/, "the remedy must be signOutEverything, not a new partial teardown");
});

test("section: the failure is rendered outside the key-entry panel, with the remedy button", () => {
  const s = sectionSrc();
  anchorSection(s);
  const block = s.indexOf("p.restoreNeedsFreshDevice");
  assert.ok(block > 0, "the section must read restoreNeedsFreshDevice");
  // It sits in the 'Device not verified' branch, BEFORE the showRecoveryKey fork —
  // applyRecoveryKey hides the key panel on success, so an error rendered only
  // inside it would never be seen.
  const fork = s.indexOf("{!p.showRecoveryKey ? (");
  assert.ok(fork > 0 && block < fork, "failure block must precede the key-entry fork");
  assert.match(s, /onClick=\{p\.startDeviceOver\}/, "the remedy button must call startDeviceOver");
  assert.ok(s.includes(`{FRESH_DEVICE_ACTION}`), "the button's label is the same constant the messages use");
});
