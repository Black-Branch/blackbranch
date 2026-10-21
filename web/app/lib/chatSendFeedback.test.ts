// What the sender is told when a send goes wrong: the error must scale with the
// chat font rather than a fixed rem size, it must stay long enough to be read
// after a slow failure, and a rejected command gives the typed line back.
//
// The classifier below is behavioural — it is a pure function, so its source is
// not scanned. The rendering assertions have to be source
// scans: the failure is visual and lives in a .tsx the runner cannot execute.
//
// Run: node --test app/lib/chatSendFeedback.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import { networkFailureKind, HttpError } from "./http.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(webRoot, p), "utf8");

/**
 * Every scan below reads a file and asserts about its CONTENTS, and several of
 * those assertions are NEGATIVE ("no `text-xs` on a status line"). A negative
 * assertion over a truncated read passes triumphantly, so each scanned file is
 * first proven to be whole — and proven at its END, because truncation eats the
 * tail while any earlier anchor stays happily green.
 */
function readWhole(path: string, tailAnchor: RegExp): string {
  const src = read(path);
  const tail = src.slice(-400);
  assert.match(
    tail, tailAnchor,
    `${path} did not end as expected — the read is truncated, and every assertion below it is vacuous`,
  );
  return stripComments(src);
}

const CHAT_INPUT = "app/features/chat/ChatInput.tsx";
const CHAT_INPUT_TAIL = /<\/form>\s*\)\s*;\s*}\s*$/;

// ── The classifier: a rejection with no Response behind it ───────────────────

test("a timed-out send is not reported as a send that did not happen", () => {
  // The distinction is the whole reason this returns a union rather than a
  // boolean. `unreachable` means the request never left the machine, so "not
  // sent" is a fact. `timeout` means the client stopped listening — the server may have
  // committed the message and only the reply was lost. Collapsing the two lets
  // the UI state a guess as a fact, and the guess is wrong exactly when it
  // matters: a cheer that debited.
  assert.equal(networkFailureKind(new DOMException("signal timed out", "TimeoutError")), "timeout");
  assert.equal(networkFailureKind(new DOMException("aborted", "AbortError")), "timeout");
  assert.equal(networkFailureKind(new TypeError("Failed to fetch")), "unreachable");
});

test("a server-side reset AFTER the body was sent is indeterminate, never 'unreachable'", () => {
  // Server-side undici rejects with the SAME TypeError for a connection reset
  // mid-request (keep-alive race, stream-api restarting with a spend in flight)
  // as for connection-refused — but a reset may land AFTER the server processed
  // the request. Classifying it "unreachable" makes the refund legal
  // (chatEventDelivery) while stream-api credited the bar: minted money.
  // The discriminator undici provides is `err.cause.code`.
  const withCause = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
  // Sent-then-severed: the request may have been processed → indeterminate,
  // same handling as a timeout (retry only when deduped; never claim "not sent").
  assert.equal(networkFailureKind(withCause("ECONNRESET")), "timeout");
  assert.equal(networkFailureKind(withCause("EPIPE")), "timeout");
  assert.equal(networkFailureKind(withCause("UND_ERR_SOCKET")), "timeout");
  // Provably never left the machine → "unreachable" stays true and refund-legal.
  assert.equal(networkFailureKind(withCause("ECONNREFUSED")), "unreachable");
  assert.equal(networkFailureKind(withCause("ENOTFOUND")), "unreachable");
  assert.equal(networkFailureKind(withCause("EAI_AGAIN")), "unreachable");
  assert.equal(networkFailureKind(withCause("EHOSTUNREACH")), "unreachable");
  assert.equal(networkFailureKind(withCause("UND_ERR_CONNECT_TIMEOUT")), "unreachable");
  // A code we don't recognize is EVIDENCE WITHHELD, not evidence of safety —
  // default to the indeterminate branch, never to the refund-legal one.
  assert.equal(networkFailureKind(withCause("SOME_FUTURE_CODE")), "timeout");
});

test("a happy-eyeballs AggregateError of refusals is still 'unreachable'", () => {
  // Node's dual-stack connect failure surfaces as cause = AggregateError whose
  // members carry the codes. All-refused means the request never left.
  const agg = new AggregateError([
    Object.assign(new Error("v4"), { code: "ECONNREFUSED" }),
    Object.assign(new Error("v6"), { code: "ECONNREFUSED" }),
  ], "connect failed");
  assert.equal(networkFailureKind(new TypeError("fetch failed", { cause: agg })), "unreachable");
  // But one indeterminate member poisons the set — nothing proves the request never left.
  const mixed = new AggregateError([
    Object.assign(new Error("v4"), { code: "ECONNREFUSED" }),
    Object.assign(new Error("v6"), { code: "ECONNRESET" }),
  ], "connect failed");
  assert.equal(networkFailureKind(new TypeError("fetch failed", { cause: mixed })), "timeout");
});

test("a browser TypeError (no cause code) keeps its 'unreachable' meaning", () => {
  // Browsers attach no cause; their fetch TypeError still means offline/refused
  // in the contexts this classifier serves client-side. Only forensic evidence
  // of a post-send failure moves the answer.
  assert.equal(networkFailureKind(new TypeError("Failed to fetch")), "unreachable");
  assert.equal(networkFailureKind(new TypeError("fetch failed", { cause: new Error("no code here") })), "unreachable");
});

test("a rejection that is NOT a network failure is passed through, not swallowed", () => {
  // The tempting wrong implementation is `return err instanceof Error` or a
  // catch-all `true`. Either would dress a genuine bug — a thrown HttpError, a
  // TypeError from the app's own response handling — as "you're offline", and
  // the real error would never surface.
  assert.equal(networkFailureKind(new HttpError(500, "boom")), null);
  assert.equal(networkFailureKind(new Error("plain")), null);
  assert.equal(networkFailureKind(null), null);
  assert.equal(networkFailureKind("offline"), null);
});

// ── The native send survives a stream-api restart as its DESIGNED 502 ────────

test("the plain native send catches its fetch — a restart must 502, not crash", () => {
  // Without a .catch on this streamApiFetch, a stream-api restart surfaces the
  // most common send shape as a raw 500 instead of the designed "Failed to
  // send" 502 (which the composer maps to draft-restore feedback).
  const src = readFileSync(join(process.cwd(), "app/api/chat/send/route.ts"), "utf8");
  const call = src.slice(src.lastIndexOf("streamApiFetch(`/chat/native`"));
  assert.ok(call.length > 30, "vacuity anchor: the native send call is gone from the route");
  const stmt = call.slice(0, call.indexOf(";"));
  assert.match(stmt, /\.catch\(/,
    "the native-send fetch rejects during a stream-api restart and nothing catches it — raw 500 instead of the designed 502");
});

// ── The send is bounded by the app, not by whatever the browser decides ──────

test("the chat send carries an explicit timeout", () => {
  // Without this the wait is however long the browser and the edge happen to
  // agree on — around ten seconds of silence, and on some networks unbounded.
  const src = readWhole("app/lib/useSendChatMessage.ts", /return handleSendMessage;\s*}\s*$/);
  assert.match(src, /timeoutMs:\s*SEND_TIMEOUT_MS/, "the send must pass a timeout to postJson");
  assert.match(src, /const SEND_TIMEOUT_MS = [\d_]+;/, "the timeout must be a named constant, not a literal at the call site");
  // Both classifier branches must be handled — mapping only one leaves the
  // other surfacing the platform's own wording ("signal timed out").
  assert.match(src, /kind === "unreachable"/);
  assert.match(src, /kind === "timeout"/);
});

test("postJson's timeout is opt-in — a blanket ceiling would abort media uploads", () => {
  const src = readWhole("app/lib/http.ts", /return res\.json\(\)\.catch\(\(\) => undefined\) as Promise<T>;\s*}\s*$/);
  // The parameter is optional and the signal is only attached when asked for.
  assert.match(src, /opts\?:\s*\{\s*timeoutMs\?:\s*number\s*\}/);
  assert.match(src, /if \(opts\?\.timeoutMs\) init\.signal = AbortSignal\.timeout\(opts\.timeoutMs\)/);
});

// ── The status lines sit on the chat axis, not the shell's fixed rem ─────────

test("no composer status line is left on the fixed-rem shell axis", () => {
  const src = readWhole(CHAT_INPUT, CHAT_INPUT_TAIL);

  // Pull the status-line block: the three <p> rows rendered above the composer.
  const lines = src.match(/\{sendError && <p[\s\S]*?\{slowActive && \([\s\S]*?\)\}/);
  assert.ok(lines, "could not locate the composer status lines — this scan is measuring nothing");

  // The defect, stated as the test: `text-xs` is Tailwind's fixed 0.75rem. A
  // line ABOUT the chat, sitting inside the chat panel, must scale with the
  // reader's chat size or it shrinks to illegibility the moment they enlarge
  // the thing it is describing.
  assert.doesNotMatch(lines[0], /text-xs/, "a composer status line is still on the fixed-rem axis");
  // A count, not a `match` — one styled line and three bare ones would satisfy
  // any presence check while looking exactly like the bug. Bump this when a
  // status line is added, which is the point: a new one must make the same
  // choice deliberately.
  const STATUS_LINES = 5; // error · failed-line retry · notice (the long box and the line) · slow mode
  assert.equal(
    (lines[0].match(/fontSize: CHAT_FONT_SM/g) ?? []).length, STATUS_LINES,
    "every composer status line must carry the chat-relative size",
  );
});

test("the error dwells longer than the command rejection, because it arrives later", () => {
  const src = readWhole(CHAT_INPUT, CHAT_INPUT_TAIL);
  const rejected = src.match(/const ERROR_MS_REJECTED = ([\d_]+);/);
  const failed = src.match(/const ERROR_MS_FAILED_SEND = ([\d_]+);/);
  assert.ok(rejected && failed, "both dwell times must be named constants");

  const ms = (m: RegExpMatchArray) => Number(m[1]!.replace(/_/g, ""));
  // `>` and not `>=`: equal values mean the two were collapsed back into one
  // number. A rejected command lands while the user is watching; a failed send
  // lands after they have looked away.
  assert.ok(ms(failed) > ms(rejected), "a failed send must outlast a rejected command on screen");
  // The floor: a failure that arrives after a ~10s wait needs time to be read.
  assert.ok(ms(failed) >= 15_000, `a failed send dwells ${ms(failed)}ms; too short to catch after a ~10s wait`);
});

test("a send in flight is SILENT — the Sending… line was removed on request", () => {
  // A mid-flight "Sending…" line is intrusive, so there is none. A FAILED send
  // still says so, via sendError with the long ERROR_MS_FAILED_SEND dwell
  // pinned above. Bringing the in-flight line back is a design decision, not a
  // helpful-looking default.
  const src = readWhole(CHAT_INPUT, CHAT_INPUT_TAIL);
  assert.doesNotMatch(src, /sendSlow|SEND_SLOW_MS|Sending…/,
    "the Sending… in-flight indicator is back — it was removed as intrusive");
});

test("a rejected command gives the typed line back", () => {
  // The composer clears optimistically (flushSync, before the runner decides).
  // The THROWN path restores the draft, and so must the rejected path, or a
  // typo'd `/ban` costs the whole typed line. Rejected means NOTHING ran: the full pre-send state comes back — text
  // and the cleared reply banner both.
  const src = readWhole(CHAT_INPUT, CHAT_INPUT_TAIL);
  const branch = src.slice(
    src.indexOf('outcome.kind === "rejected"'),
    src.indexOf("} else if"),
  );
  assert.ok(branch.length > 0, "the rejected branch is gone — rewritten? update this scan");
  assert.match(branch, /setInput\(text\)/, "a rejected command must restore the draft");
  assert.match(
    branch,
    /onRestoreReply\(capturedReply\)/,
    "…and the reply banner it cleared — a retry must stay pointed where the user aimed it",
  );
});
