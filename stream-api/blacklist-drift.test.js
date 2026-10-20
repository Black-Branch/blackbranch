// The SHIPPED blocklist lives in TWO runtimes and must be edited in both.
//
// Same reasoning as cross-package-drift.test.js: web/ and stream-api/ are
// independently-deployed packages, so a shared module resolves in the repo and
// dies in production on whichever service deployed first. The list is therefore
// duplicated ON PURPOSE — and gated here, because drift is silent. A term added
// to one side only is simply unenforced on the other, with nothing to notice it.
//
// This gates the CODE-SHIPPED list only. The runtime override layer
// (`/blacklist`, `/whitelist`) is DB-backed and genuinely shared, so it cannot
// drift and is not checked here.
//
// Baseline when written: 183 terms each side, zero drift. This
// locks in a correct state rather than fixing a live bug — the two agreed then,
// and nothing was stopping them diverging tomorrow.
//
// Run: node --test blacklist-drift.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const WEB = readFileSync(join(__dirname, "..", "web", "app", "lib", "blacklist.ts"), "utf8");
const API = readFileSync(join(__dirname, "blacklist.js"), "utf8");

// One regex for both copies: web quotes with ", stream-api with ', so the quote
// is a character class. Anchored on `{ term:` so prose and comments cannot match.
function termsFrom(src, label) {
  const terms = [...src.matchAll(/\{\s*term:\s*["']([^"']+)["']\s*,\s*severity:\s*([1-4])/g)]
    .map((m) => `${m[1].toLowerCase()}:${m[2]}`);
  // Vacuity guard. A regex that stops matching would compare an empty set to an
  // empty set and pass forever — the exact failure mode cross-package-drift.js
  // carries its own guards against.
  assert.ok(terms.length > 100,
    `${label}: extracted only ${terms.length} terms (expected ~183) — the regex has ` +
    "stopped matching the real shape and this test is now vacuous");
  return new Set(terms);
}

test("both runtimes ship the same blocklist terms at the same severities", () => {
  const web = termsFrom(WEB, "web");
  const api = termsFrom(API, "stream-api");
  const onlyWeb = [...web].filter((t) => !api.has(t));
  const onlyApi = [...api].filter((t) => !web.has(t));
  assert.deepEqual(
    { onlyWeb, onlyApi }, { onlyWeb: [], onlyApi: [] },
    "the two shipped blocklists have drifted — edit BOTH copies " +
    "(web/app/lib/blacklist.ts and stream-api/blacklist.js)",
  );
});

test("the two lists are the same SIZE — a duplicate on one side is drift too", () => {
  // Set comparison above would not notice a term duplicated on one side only.
  const count = (src) => [...src.matchAll(/\{\s*term:\s*["'][^"']+["']\s*,\s*severity:\s*[1-4]/g)].length;
  assert.equal(count(WEB), count(API),
    "one runtime has more blocklist entries than the other");
});
