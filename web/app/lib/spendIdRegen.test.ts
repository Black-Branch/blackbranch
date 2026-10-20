// spendIdRef must be regenerated on a PRODUCT change, not just on confirmed
// success. Source scan, not a render test: ChatInput.tsx is a .tsx the test
// glob (`app/**/*.test.ts`) never picks up, same reason composerEscape.test.ts
// reads it as text.
//
// The failure this pins: a viewer arms Highlight and sends while stream-api is
// restarting. Delivery is `unconfirmed`, so the coins are kept and the ledger
// row is live (site.coin_ledger's unique index is (kind='spend', ref) — NOT
// scoped by sink/product). If spendIdRef were regenerated only on a CONFIRMED
// success, the ref would survive the failure untouched. Switching to Read
// aloud and sending would reuse that same ref: debitCoins hits the still-live
// ledger row, returns replay:true, and /api/chat/send answers `{ ok: true }`
// WITHOUT ever calling deliverChatEvent — a silent no-op reported as success,
// for a different product than the one already charged.
//
// So: track which product spendIdRef.current was minted for (spendProductRef)
// and mint a fresh one, via armSpendId(), the moment the product about to be
// sent differs from that — at BOTH sites that build a spend payload: the
// tools-menu chip and the `/highlight`/`/tts` commands, which share the same
// ref.
//
// Run: node --test app/lib/spendIdRegen.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const here = dirname(fileURLToPath(import.meta.url));

function chatInputSource(): string {
  const raw = readFileSync(join(here, "../features/chat/ChatInput.tsx"), "utf8");
  assert.ok(raw.length > 500, "ChatInput.tsx read suspiciously short — file may be truncated");
  return stripComments(raw);
}

test("armSpendId exists and only regenerates when the product actually changes", () => {
  const src = chatInputSource();
  const fnStart = src.indexOf("function armSpendId(");
  assert.notEqual(fnStart, -1, "armSpendId is gone from ChatInput — the mode-change regen guard was removed");

  const fnEnd = src.indexOf("\n  }", fnStart);
  assert.notEqual(fnEnd, -1, "armSpendId's closing brace could not be located");
  const body = src.slice(fnStart, fnEnd);

  assert.match(
    body,
    /spendProductRef\.current\s*!==\s*null\s*&&\s*spendProductRef\.current\s*!==\s*product/,
    "armSpendId no longer compares the tracked product against the incoming one — " +
    "it would either always regenerate (breaking same-product retry replay) or never regenerate " +
    "(the original bug)"
  );
  assert.match(
    body,
    /spendIdRef\.current\s*=\s*crypto\.randomUUID\(\)/,
    "armSpendId's regeneration branch no longer mints a new spendId"
  );
  assert.match(
    body,
    /spendProductRef\.current\s*=\s*product/,
    "armSpendId no longer records which product the (possibly fresh) ref belongs to"
  );
});

test("the chip-driven send captures its spendId through armSpendId, not the bare ref", () => {
  const src = chatInputSource();
  const idx = src.indexOf("const capturedSpend =");
  assert.notEqual(idx, -1, "capturedSpend construction moved or was renamed");
  const stmt = src.slice(idx, src.indexOf(";", idx) + 1);
  assert.match(
    stmt,
    /armSpendId\(spendMode\)/,
    "capturedSpend reads spendIdRef.current directly again — a product switch after an " +
    "unconfirmed send would silently replay onto the new product's debit"
  );
});

test("the /highlight and /tts command door captures its spendId through armSpendId too", () => {
  const src = chatInputSource();
  const idx = src.indexOf("const spend = outcome.spend");
  assert.notEqual(idx, -1, "the command-door spend construction moved or was renamed");
  const stmt = src.slice(idx, src.indexOf(": null;", idx) + ": null;".length);
  assert.match(
    stmt,
    /armSpendId\(outcome\.spend\)/,
    "the command door reads spendIdRef.current directly again — it shares the ref with the " +
    "chip, so a switch between /highlight and /tts (or between a command and the chip) hits " +
    "the same silent-replay hazard the chip fix addresses"
  );
});

test("the spendIdRef comment states the real regeneration condition", () => {
  const src = chatInputSource();
  const idx = src.indexOf("const spendIdRef = useRef");
  assert.notEqual(idx, -1, "spendIdRef declaration moved");
  // Comments are stripped from `src`, so read the raw file for this one check.
  const raw = readFileSync(join(here, "../features/chat/ChatInput.tsx"), "utf8");
  const rawIdx = raw.indexOf("spendId is the server-side idempotency key");
  assert.notEqual(rawIdx, -1, "the spendIdRef explanatory comment is gone");
  const comment = raw.slice(rawIdx, rawIdx + 400);
  assert.doesNotMatch(
    comment,
    /regenerated after a confirmed success or a mode change/,
    "the comment still claims mode-change regeneration happened all along — that was the " +
    "actual bug (the code only regenerated on success); it must describe what the code now does"
  );
  assert.match(
    comment,
    /product change/,
    "the comment no longer mentions a product change as a regeneration trigger"
  );
});
