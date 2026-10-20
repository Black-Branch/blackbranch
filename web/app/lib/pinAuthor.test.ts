// pinAuthor — the pinned message's author, resolved live: the matrix id the
// badge lookup keys on, and the colour + equipped style the username wears.
//
// Run: node --test app/lib/pinAuthor.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { pinAuthor, type PinAuthorQuery } from "./pinAuthor.ts";

type Row = { matrix_id: string | null; username_color: string | null; username_style: unknown; platform_color?: string | null };

const answering = (rows: Row[], seen: { sql: string; params: unknown[] }[] = []): PinAuthorQuery =>
  async (sql, params) => { seen.push({ sql, params }); return { rows }; };

test("a native pin resolves through site.chat_messages → site.users by the message id", async () => {
  const seen: { sql: string; params: unknown[] }[] = [];
  const q = answering([{ matrix_id: "@casey:site.test", username_color: "#ff8800", username_style: { font: "pixel" } }], seen);
  const a = await pinAuthor("native", 42, q);
  assert.deepEqual(a, { matrixId: "@casey:site.test", usernameColor: "#ff8800", usernameStyle: { font: "pixel" } });
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.sql, /FROM site\.chat_messages m/);
  // LEFT: the badge key is m.matrix_id and exists whether or not the author
  // still has a site.users row (the route's own snapshot query is LEFT too).
  assert.match(seen[0]!.sql, /SELECT m\.matrix_id, u\.username_color, u\.username_style/);
  assert.match(seen[0]!.sql, /LEFT JOIN site\.users u ON u\.matrix_id = m\.matrix_id/);
  assert.match(seen[0]!.sql, /WHERE m\.id = \$1/);
  assert.deepEqual(seen[0]!.params, [42]);
});

test("a platform pin resolves canonical → site.platform_links → site.users, and keeps the platform colour when unlinked", async () => {
  const seen: { sql: string; params: unknown[] }[] = [];
  // Linked: the site account's colour and style win.
  let a = await pinAuthor("twitch", 7, answering([{ matrix_id: "@casey:site.test", username_color: "#00ccff", username_style: null, platform_color: "#9147ff" }], seen));
  assert.deepEqual(a, { matrixId: "@casey:site.test", usernameColor: "#00ccff", usernameStyle: null });
  assert.match(seen[0]!.sql, /FROM stream\.chat_log cl/);
  assert.match(seen[0]!.sql, /LEFT JOIN site\.platform_links pl ON pl\.canonical_id = cl\.user_id/, "the canonical → matrix hop is the one the upvote award needed too");
  assert.match(seen[0]!.sql, /LEFT JOIN site\.users u ON u\.matrix_id = pl\.matrix_id AND u\.show_links/,
    "a platform pin wears its author's site badges and style only when they show their links");
  assert.match(seen[0]!.sql, /AND NOT EXISTS \(SELECT 1 FROM \(\s*SELECT matrix_id FROM site\.platform_links WHERE canonical_id = cl\.user_id\s+UNION SELECT platform_id FROM stream\.links WHERE platform IN \('native'[^)]*\) AND canonical = cl\.user_id/,
    "every account on the line's canonical must agree — another account's opt-in is not consent");
  assert.match(seen[0]!.sql, /WHERE cl\.id = \$1 AND cl\.platform = \$2/);
  assert.match(seen[0]!.sql, /LIMIT 1/, "one link row per canonical is enough — every row names the same account");
  assert.deepEqual(seen[0]!.params, [7, "twitch"]);
  // Unlinked: no account, so no badges and no style — but Twitch's own per-user
  // colour still applies, exactly as it does on the chat row.
  a = await pinAuthor("twitch", 8, answering([{ matrix_id: null, username_color: null, username_style: null, platform_color: "#9147ff" }]));
  assert.deepEqual(a, { matrixId: null, usernameColor: "#9147ff", usernameStyle: null });
});

test("a linked account with no colour of its own falls back to the platform colour; a missing row or a failing lookup is an empty author", async () => {
  let a = await pinAuthor("kick", 9, answering([{ matrix_id: "@quinn:site.test", username_color: null, username_style: { effect: "glow" }, platform_color: "#53fc18" }]));
  assert.deepEqual(a, { matrixId: "@quinn:site.test", usernameColor: "#53fc18", usernameStyle: { effect: "glow" } });
  a = await pinAuthor("native", 1, answering([]));
  assert.deepEqual(a, { matrixId: null, usernameColor: null, usernameStyle: null });
  const failing: PinAuthorQuery = async () => { throw new Error("pool down"); };
  a = await pinAuthor("native", 1, failing);
  assert.deepEqual(a, { matrixId: null, usernameColor: null, usernameStyle: null }, "never throws — a pin without its author's style is still a pin");
  // …including a query that throws SYNCHRONOUSLY, which a .catch on the
  // returned promise would let through.
  const throwing = (() => { throw new Error("sync"); }) as unknown as PinAuthorQuery;
  a = await pinAuthor("twitch", 1, throwing);
  assert.deepEqual(a, { matrixId: null, usernameColor: null, usernameStyle: null });
});
