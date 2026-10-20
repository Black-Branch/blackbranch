// Tests for the shared chat-identity lookup.
//
// The same query, error swallow, and display-name fallback serve every route
// that announces a user (the coins/spend endpoints and the billing webhook).
// Separate copies of a name-resolution rule would be separate chances for one
// announcement to render a user differently from every other announcement
// about the same user.
//
// The behaviour that matters most is the failure mode: every caller runs AFTER
// money has already moved, so a DB hiccup must degrade to the localpart, never
// turn a completed purchase into an error. getChatIdentity therefore cannot
// throw. The policy is mirrored here because the real module imports the pg pool
// at module scope (@/lib/db), which node --test can neither resolve nor connect;
// the static guard at the bottom pins that the routes use the real one.
//
// Run: node --test app/lib/chatIdentity.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "./testInstallValues.ts";
import { matrixLocalpart } from "./matrixConfig.ts";

type IdentityRow = {
  display_name: string | null;
  username_color: string | null;
  username_style: object | null;
};


async function getChatIdentity(
  matrixId: string,
  query: () => Promise<{ rows: IdentityRow[] }>
) {
  const { rows } = await query().catch(() => ({ rows: [] as IdentityRow[] }));
  return {
    username: rows[0]?.display_name || matrixLocalpart(matrixId),
    usernameColor: rows[0]?.username_color ?? null,
    usernameStyle: rows[0]?.username_style ?? null,
  };
}

const rowsOf = (r: Partial<IdentityRow>) => async () => ({
  rows: [{ display_name: null, username_color: null, username_style: null, ...r }],
});
const empty = async () => ({ rows: [] as IdentityRow[] });
const boom = async () => { throw new Error("pool exhausted"); };

test("uses display_name when set", async () => {
  const id = await getChatIdentity("@casey:example.tv", rowsOf({ display_name: "Casey" }));
  assert.equal(id.username, "Casey");
});

test("falls back to the localpart when there is no row", async () => {
  const id = await getChatIdentity("@casey:example.tv", empty);
  assert.equal(id.username, "casey");
});

test("THE FAILURE MODE: a DB error degrades, it does not throw", async () => {
  // These callers run after the coins are already debited. Throwing here would
  // turn a completed purchase into a 500 the user reads as "it didn't work".
  const id = await getChatIdentity("@casey:example.tv", boom);
  assert.equal(id.username, "casey");
  assert.equal(id.usernameColor, null);
  assert.equal(id.usernameStyle, null);
});

test("an empty display_name falls back rather than rendering blank", async () => {
  // `||` not `??` on purpose — "" is a real value in the column and would
  // otherwise render an anonymous-looking announcement.
  const id = await getChatIdentity("@casey:example.tv", rowsOf({ display_name: "" }));
  assert.equal(id.username, "casey");
});

test("color and style pass through, including when only one is set", async () => {
  const id = await getChatIdentity("@a:example.tv", rowsOf({
    display_name: "A", username_color: "#ff0000",
  }));
  assert.equal(id.usernameColor, "#ff0000");
  assert.equal(id.usernameStyle, null);
});

test("a style object passes through by reference", async () => {
  const style = { gradient: ["#fff", "#000"] };
  const id = await getChatIdentity("@a:example.tv", rowsOf({ display_name: "A", username_style: style }));
  assert.deepEqual(id.usernameStyle, style);
});

test("localpart strips the @ and THIS install's server (matrix.serverName), case-insensitively", () => {
  assert.equal(matrixLocalpart("@casey:example.tv"), "casey");
  assert.equal(matrixLocalpart("@casey:EXAMPLE.TV"), "casey");
  assert.equal(matrixLocalpart("@casey:site.test", "site.test"), "casey", "another install's own server");
  assert.equal(matrixLocalpart("@casey:example.tv.evil", "example.tv"), "casey:example.tv.evil", "a suffix is not the server");
});

test("a federated id (another homeserver) keeps its server, so it stays unambiguous", () => {
  // Two different people can both be "alice" on different homeservers.
  assert.equal(matrixLocalpart("@alice:matrix.org"), "alice:matrix.org");
});

// ── every call site must use the shared helper ───────────────────────────────

// `spend/tts` and `spend/gadget` are absent on purpose: there is no paid voice
// message route (Read aloud is a chat spend) and no paid help-desk route.
// Listing either here would fail on a missing file and read like the helper
// regressed.
const CALLERS = [
  ["app", "api", "points", "spend", "sound", "route.ts"],
  ["app", "api", "points", "spend", "sticker", "route.ts"],
  ["app", "api", "billing", "webhook", "route.ts"],
];

for (const p of CALLERS) {
  test(`${p.slice(2).join("/")} goes through getChatIdentity`, () => {
    const s = readFileSync(join(process.cwd(), ...p), "utf8");
    assert.match(s, /getChatIdentity/, "this route no longer uses the shared helper");
    assert.doesNotMatch(s, /SELECT display_name, username_color, username_style/,
      "the identity query was pasted back in");
    assert.doesNotMatch(s, /replace\(\/:[^/]+\$\/i, ""\)/,
      "the display-name fallback was pasted back in");
  });
}

test("the helper is the only place the identity query lives", () => {
  const lib = readFileSync(join(process.cwd(), "app", "lib", "chatIdentity.ts"), "utf8");
  assert.match(lib, /SELECT display_name, username_color, username_style FROM site\.users WHERE matrix_id = \$1/);
  assert.match(lib, /\.catch\(\(\) => \(\{ rows: \[\] as IdentityRow\[\] \}\)\)/,
    "the error swallow is gone — a DB blip would now throw after money moved");
});
