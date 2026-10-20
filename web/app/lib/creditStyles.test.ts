// The credit overlay's name lookup (GET /api/overlay/credit-styles) is public and keyed by display
// name: it answers with how chat draws the name, never the account's Matrix id. creditStyles is
// RUN; the route and the overlay (which import through the @/ alias) are scanned.
// Run: node --test app/lib/creditStyles.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { creditStyles } from "./creditStyles.ts";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

const snap = {
  cat: [{ id: 7, name: "Sub", image_url: "", is_subscriber: true, is_mod: false, unlock_criteria: null }],
  slots: [{ matrix_id: "@casey:site.test", base_slots: 0, equipped: [7] }],
  mods: [{ matrix_id: "@casey:site.test" }], subs: [{ matrix_id: "@casey:site.test" }], gifts: [],
};

test("creditStyles: colour, style and chat's public badge state — never the Matrix id", () => {
  const out = creditStyles([
    { key: "casey", matrix_id: "@casey:site.test", username_color: "#ff0000", username_style: { font: "x" } },
    { key: "kit", matrix_id: "@kit:site.test", username_color: null, username_style: null },
  ], snap, new Set());
  assert.deepEqual(out.casey, { usernameColor: "#ff0000", usernameStyle: { font: "x" }, badges: { slotCount: 1, equipped: [7], unlocked: [], isMod: true } });
  assert.deepEqual(out.kit, { usernameColor: null, usernameStyle: null, badges: null });
  assert.doesNotMatch(JSON.stringify(out), /@casey|@kit|matrixId/);
});

test("the credit-styles route answers through creditStyles and never sends matrixId", () => {
  const raw = read("app", "api", "overlay", "credit-styles", "route.ts");
  assert.match(raw, /return NextResponse\.json\(\{ styles \}, \{ headers: \{ "Cache-Control": "no-store" \} \}\);\n\}\n$/, "END not read");
  const src = stripComments(raw);
  assert.match(src, /const styles = creditStyles\(r\.rows, await getBadgeSnapshot\(\), staffMatrixIds\(\)\);/);
  assert.doesNotMatch(src, /matrixId/);
  const overlay = stripComments(read("app", "components", "CreditOverlay.tsx"));
  assert.doesNotMatch(overlay, /st\.matrixId|matrixId: string/);
  assert.match(overlay, /badgesForMatrixId\(\{ \.\.\.badgeState, perUser: \{ credit: st\.badges \} \}, "credit"\)/);
});

test("the name lookup is rate-limited per address before it reads anything", () => {
  // Unauthenticated and keyed by display name, it answers "does a site account with this name
  // exist?"; without a limit that is a member directory one guess at a time.
  const src = stripComments(read("app", "api", "overlay", "credit-styles", "route.ts"));
  assert.match(src, /const limited = createSlidingWindowLimiter\(60_000, LOOKUPS_PER_MIN\);/);
  const check = src.indexOf("if (limited(ipKey(req))) return NextResponse.json({ error: \"too_fast\" }, { status: 429, headers: { \"Retry-After\": \"10\" } });");
  assert.ok(check > 0, "no per-address limit");
  assert.ok(check < src.indexOf("await pool.query"), "the limit is checked after the read");
});
