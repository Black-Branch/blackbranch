// The Matrix client reports its lifecycle into the readiness registry —
// token → sdk → crypto → sync, every failure a marked stage — and
// retry is REAL. Source-scanned: the provider cannot be mounted in node (the
// SDK import is the thing being staged), so this pins the shape of the code
// that does it, with an END anchor so a truncated read cannot go green.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const here = dirname(fileURLToPath(import.meta.url));
function readWhole(rel: string, tail: RegExp): string {
  const src = readFileSync(join(here, rel), "utf8");
  assert.match(src.slice(-300), tail, `${rel} did not end as expected — the read is truncated, and every assertion below it is vacuous`);
  return stripComments(src);
}
const CTX = () => readWhole("MatrixClientContext.tsx", /<\/Ctx\.Provider>\s*\);\s*}\s*$/);

test("the four stages are reported in lifecycle order, and every failure marks its stage", () => {
  const src = CTX();
  assert.match(src, /registerReadiness\(MATRIX_READINESS_KEY, \[\s*\{ id: "token", label: "Checking your session" \},\s*\{ id: "sdk", label: "Loading Matrix" \},\s*\{ id: "crypto", label: "Preparing encryption" \},\s*\{ id: "sync", label: "Syncing the community" \},\s*\]\)/,
    "the literal stage sequence, registered once at module level");
  const order = [
    'matrixReadiness.reset()',
    'advance("token", "active")', 'advance("token", "done")',
    'advance("sdk", "active")', 'advance("sdk", "done")',
    'advance("crypto", "active")', 'advance("crypto", "done")',
    'advance("sync", "active")', 'advance("sync", "done")',
  ];
  const idx = order.map((s) => { const i = src.indexOf(s); assert.notEqual(i, -1, `missing: ${s}`); return i; });
  const onSyncIdx = src.indexOf("mxClient.on(ClientEvent.Sync");
  assert.notEqual(onSyncIdx, -1, "missing: mxClient.on(ClientEvent.Sync");
  for (let i = 1; i < idx.length; i++) {
    // The sync "done" call lives inside the mxClient.on(Sync) handler, which
    // must be REGISTERED before "sync" is marked active (so no event fired
    // during startClient() is missed) — so its source position precedes
    // "sync" active's, even though it necessarily fires after. Every other
    // stage's "done" call sits inline right after its own "active" call, so
    // textual order still matches lifecycle order everywhere else. Pin the
    // real invariant instead of a naive "comes after the previous line": the
    // done call must sit INSIDE the Sync handler, which is itself declared
    // before "sync" is marked active.
    if (order[i] === 'advance("sync", "done")') {
      assert.ok(idx[i]! > onSyncIdx, `${order[i]} must be inside the mxClient.on(ClientEvent.Sync, …) handler`);
      assert.ok(idx[i]! < idx[i - 1]!, `${order[i]} (inside the Sync handler) must come BEFORE ${order[i - 1]} — the handler is registered before the client starts`);
      continue;
    }
    assert.ok(idx[i]! > idx[i - 1]!, `${order[i]} must come after ${order[i - 1]} — the stages ARE the lifecycle's order`);
  }
  for (const id of ["token", "sdk", "crypto", "sync"]) {
    assert.match(src, new RegExp(`advance\\("${id}", "error", "`), `a failing ${id} stage must say so with a reason — a stage is never silently stuck`);
  }
  assert.match(src, /try \{\s*sdk = await Promise\.all\(\[\s*import\("matrix-js-sdk"\)/, "the dynamic SDK import is guarded — an uncaught rejection there reached no surface at all");
});

test("retry is real, and the old watchdog's dead guard is gone", () => {
  const src = CTX();
  assert.match(src, /retry: \(\) => void;/, "MxCtx exposes retry");
  assert.match(src, /startedRef\.current = false;\s*setStatus\("idle"\);\s*void startClient\(\);/,
    "retry resets the start latch and starts again — the thing the old watchdog reset FOR, which nothing then did");
  assert.doesNotMatch(src, /if \(clientRef\.current\) return;/,
    "the old watchdog guard was always true by the time the timer fired (clientRef is set before it is armed): dead code that read as a safety");
});

test("ONE boot-level timer, armed before the first await, fails whichever stage is still active", () => {
  const src = CTX();
  // A sync-only watchdog would cover the ONE stage that cannot hang without
  // the SDK already working. A token endpoint that never answers, an SDK chunk
  // that never arrives and a crypto setup that hangs would all leave the pane
  // on a silently active stage with no ceiling at all.
  assert.match(src, /bootTimer = setTimeout\(\(\) => \{\s*if \(stale\(\)\) return;/,
    "the boot timer's first statement is the generation guard — an abandoned run's timer must not mark a fresh run's stage");
  assert.match(src, /const active = readReadiness\(\[MATRIX_READINESS_KEY\]\)\.find\(\(s\) => s\.status === "active"\);\s*if \(!active\) return;/,
    "it reads the registry at FIRE time and marks whichever stage is still running — that is what makes it cover all four");
  assert.match(src, /matrixReadiness\.advance\(active\.id, "error", "Still connecting after 30 seconds"\)/,
    "the failed stage is the ACTIVE one, not a hardcoded 'sync'");
  const armed = src.indexOf("bootTimer = setTimeout(");
  // `const tokenData = …`, not a bare "await fetchFreshToken();" — scheduleRefresh
  // above startClient has one of those, and its index would pass this vacuously.
  const firstAwait = src.indexOf("const tokenData = await fetchFreshToken();");
  assert.ok(armed !== -1 && firstAwait !== -1 && armed < firstAwait,
    "armed BEFORE the first await, or the stages ahead of it are the ones with no ceiling — the exact defect it replaces");
  // The branch grew a third statement (the bot ignore-list sync, batch 2), so
  // the anchor is the two statements that disarm the timer, not the whole block.
  assert.match(src, /if \(!prepared\) \{\s*prepared = true;\s*clearTimeout\(bootTimer\);/,
    "disarmed by the first PREPARED/SYNCING — not by a Sync event of any state, which can be an ERROR");
  assert.doesNotMatch(src, /let watchdog/, "the sync-only watchdog variable is gone, not shadowed by a second timer");
});

test("the in-flight client is held from createClient onward, so retry and unmount can stop it", () => {
  const src = CTX();
  const created = src.indexOf("const mxClient = createClient({");
  const held = src.indexOf("bootingRef.current = mxClient;");
  const crypto = src.indexOf("await setupCrypto(");
  assert.ok(created !== -1 && held > created,
    "bootingRef takes the client the moment createClient returns");
  assert.ok(crypto !== -1 && held < crypto,
    "…and BEFORE crypto setup: that whole window is where clientRef is still null, so a retry from a stuck " +
    "'Preparing encryption' had nothing to stop and left a live client running under the new one");
  assert.match(src, /clientRef\.current = mxClient;\s*bootingRef\.current = null;/,
    "cleared where clientRef takes ownership — one ref holds the client, never both");
  assert.match(src, /const booting = bootingRef\.current;/, "retry reads the mid-boot client");
  assert.match(src, /try \{ booting\?\.stopClient\(\); \} catch \{[^}]*\}/, "…and stops it, guarded like the settled one");
  assert.match(src, /runRef\.current\+\+;\s*startedRef\.current = false;\s*clientRef\.current\?\.stopClient\(\);\s*bootingRef\.current\?\.stopClient\(\);/,
    "the unmount cleanup bumps the generation (an in-flight run cannot write to a provider that is gone), REOPENS the start latch " +
    "(a bump that leaves it shut means nothing can ever start again — StrictMode's dev mount runs exactly that sequence) and stops BOTH clients");
});

test("a retry's generation guard makes the abandoned run's continuation inert", () => {
  const src = CTX();
  assert.match(src, /const run = \+\+runRef\.current;/,
    "each startClient() run gets its own generation, bumped again by the next call (retry's included) and by unmount");
  // The two plain awaits at the head of the run. Their guard has to be the
  // statement DIRECTLY after the await: anything in between runs on a run that
  // has already been abandoned.
  assert.match(src, /const tokenData = await fetchFreshToken\(\);\s*if \(stale\(\)\) return;/,
    "the token fetch's guard is the first statement after it");
  assert.match(src, /const userId = await fetchMatrixId\(\);\s*if \(stale\(\)\) return;/,
    "the matrix-id fetch's guard is the first statement after it");
  // A COUNT is not the contract — round 1 passed with two holes at exactly
  // five occurrences. Every callback that can run after this function has
  // already moved on (a rejection handler settling before its own `await`
  // resumes, or an event handler firing later) must have `stale()` as its
  // OWN first statement — checking after the fact is too late, because the
  // handler's writes already ran.
  assert.match(src, /setupCrypto\([^)]*\)\.catch\(e => \{\s*if \(stale\(\)\) return;/,
    "setupCrypto's .catch callback settles BEFORE the awaiting line resumes — the stale check must be " +
    "its OWN first statement, not the one after the await, or a stale CryptoStoreResetError still " +
    "clobbers the fresh run's registry/status and reopens startedRef");
  assert.match(src, /await mxClient\.startClient\([^)]*\);\s*\} catch \(e\) \{\s*if \(stale\(\)\) return;/,
    "mxClient.startClient's catch settles BEFORE the awaiting line resumes — same shape as setupCrypto's " +
    "catch, and needs the same first-statement guard");
  assert.match(src, /ClientEvent\.Sync, \([^)]*\) => \{\s*if \(stale\(\)\) return;/,
    "the Sync handler's first statement must be the stale check — an old run's handler otherwise keeps " +
    "writing to the registry a new run owns");
  assert.match(src, /CryptoEvent\.VerificationRequestReceived, \([^)]*\) => \{\s*if \(stale\(\)\) return;/,
    "the verification-request handler's first statement must be the stale check — an abandoned run's " +
    "handler otherwise still sets pendingVerification for a client nobody is showing anymore");
  assert.match(src, /bootTimer = setTimeout\(\(\) => \{\s*if \(stale\(\)\) return;/,
    "the boot timer's first statement must be the stale check — a stale timer can fire well after a fresh " +
    "run has already reached PREPARED, and would then fail a stage that is running fine");
  const staleReturns = src.match(/if \(stale\(\)\) return;/g) ?? [];
  assert.ok(staleReturns.length >= 5,
    `only ${staleReturns.length} "if (stale()) return;" guards found — every await in startClient (token, ` +
    "matrixId, the SDK import success path AND its catch, setupCrypto, mxClient.startClient) must check it " +
    "before touching clientRef/status/the registry, or an abandoned run can clobber a fresh one");
});

test("the surfaces: the community pane and the encryption section boot through BootSequence with retry", () => {
  const view = readWhole("../features/community/MatrixView.tsx", /return <UnifiedLayout pageChrome \/>;\s*}\s*$/);
  assert.match(view, /const \{ client, status, retry \} = useMatrixClient\(\);/);
  assert.match(view, /const COMMUNITY_BOOT = \[MATRIX_READINESS_KEY, EMOTES_READINESS_KEY\] as const;/, "the pane composes matrix + emotes, in that order");
  assert.match(view, /<BootSequence keys=\{COMMUNITY_BOOT\} label="Joining the community" onRetry=\{retry\} \/>/);
  assert.doesNotMatch(view, /Joining community…|Refresh to try again/, "the old text states are gone — the stages say which step is running or failed, and the retry is a control, not a sentence");
  // TWO boots, not one. On a phone (mode 1) with nothing selected the centre
  // branch below never renders — `showTimeline` is false there — so without
  // the directory's own boot the whole boot would show an EMPTY directory.
  // `!showTimeline` is what keeps exactly ONE of them on screen.
  const boots = view.match(/<BootSequence keys=\{COMMUNITY_BOOT\} label="Joining the community" onRetry=\{retry\} \/>/g) ?? [];
  assert.equal(boots.length, 2, `the centre AND the directory boot — found ${boots.length}`);
  assert.match(view, /const directoryBooting = showDirectory && !showTimeline && status !== "ready" && status !== "notoken";/,
    "the directory's condition: only where the centre has nothing to show (`!showTimeline`), and never for a signed-out visitor (the centre's sign-in CTA is the funnel)");
  assert.match(view, /boot=\{directoryBooting \? <BootSequence keys=\{COMMUNITY_BOOT\} label="Joining the community" onRetry=\{retry\} \/> : null\}/,
    "…handed to ChannelColumn, which renders it in place of the room list");
  const column = readWhole("../features/community/ChannelColumn.tsx", /<\/div>\s*\);\s*}\s*$/);
  assert.match(column, /\{boot \?\? \(mode === "home" \?/, "the boot takes the LIST's slot — the header Bar and the rail beside it are untouched");
  const section = readWhole("../components/MatrixSettings/EncryptionSection.tsx", /<\/div>\s*\);\s*}\s*$/);
  assert.match(section, /<BootSequence keys=\{MATRIX_BOOT\} label="Connecting to Matrix" onRetry=\{p\.retry\} compact \/>/);
  assert.doesNotMatch(section, /"Not connected"/, "the one-line 'Not connected' is replaced by the staged sequence");
  const settings = readWhole("useMatrixSettings.ts", /\};\s*}\s*(export type MatrixSettingsState = ReturnType<typeof useMatrixSettings>;\s*)?$/);
  assert.match(settings, /const \{ client, status, pendingVerification, clearPendingVerification, retry \} = useMatrixClient\(\);/);
  assert.match(settings, /\n\s+retry,\n/, "retry is passed through the settings state to the section");
});
