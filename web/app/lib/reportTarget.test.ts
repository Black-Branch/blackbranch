// Reports from a chat message: anyone in chat can be reported — a site account or a platform-only
// chatter — and the author is the message's, never one the reporter names.
// Run: node --test app/lib/reportTarget.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clampMessageReport, reportedAuthor } from "./reportTarget.ts";
import { stripComments } from "./testSource.ts";

type Db = { native?: Record<number, string>; log?: Record<string, string>; links?: Record<string, string> };
function db(d: Db) {
  return async (sql: string, params: unknown[]) => {
    if (sql.includes("site.chat_messages")) {
      const m = d.native?.[Number(params[0])];
      return { rows: m ? [{ matrix_id: m }] : [] };
    }
    if (sql.includes("stream.chat_log")) {
      const u = d.log?.[`${params[1]}:${params[0]}`];
      return { rows: u ? [{ user_id: u }] : [] };
    }
    if (sql.includes("site.platform_links")) {
      const m = d.links?.[String(params[0])];
      return { rows: m ? [{ matrix_id: m }] : [] };
    }
    return { rows: [] };
  };
}

test("a site message's author is its account", async () => {
  assert.deepEqual(await reportedAuthor(db({ native: { 7: "@casey:site.test" } }), "native", 7), { matrixId: "@casey:site.test", canonicalId: null });
});

test("a platform-only chatter is reported by canonical id — they have no site account", async () => {
  const q = db({ log: { "kick:9": "0123456789ab" } });
  assert.deepEqual(await reportedAuthor(q, "kick", 9), { matrixId: null, canonicalId: "0123456789ab" });
});

test("a platform chatter linked to a site account is reported as that account", async () => {
  const q = db({ log: { "twitch:9": "0123456789ab" }, links: { "0123456789ab": "@sam:site.test" } });
  assert.deepEqual(await reportedAuthor(q, "twitch", 9), { matrixId: "@sam:site.test", canonicalId: null });
});

test("a message that does not exist names nobody", async () => {
  assert.equal(await reportedAuthor(db({}), "native", 1), null);
  assert.equal(await reportedAuthor(db({}), "kick", 1), null);
});

test("the body: a platform, a stored message id and a reason — nothing else is trusted", () => {
  assert.deepEqual(clampMessageReport({ platform: "Kick", messageId: "12", reason: " spam ", matrixId: "@x:y" }), { platform: "kick", messageId: 12, reason: "spam" });
  assert.equal(clampMessageReport({ platform: "kick", messageId: "local-1", reason: "x" }), null);
  assert.equal(clampMessageReport({ platform: "kick", messageId: 3, reason: "  " }), null);
  assert.equal(clampMessageReport({ username: "casey", reason: "x" }), null, "the help desk's by-name form is not this one");
});

const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), "utf8"));

test("the route stores the resolved author, the message, and refuses your own line", () => {
  const route = read("../api/support/report/route.ts");
  const at = route.indexOf("const byMessage = clampMessageReport(raw);");
  assert.ok(at > route.indexOf("isLimited(`support-write:${matrixId}`)"), "rate-limited first");
  const body = route.slice(at);
  assert.match(body, /const author = await reportedAuthor\(/);
  assert.match(body, /if \(author\.matrixId === matrixId\) return Response\.json\(\{ error: "self" \}, \{ status: 400 \}\);/);
  assert.match(body, /\[author\.matrixId, author\.canonicalId, matrixId, reason, byMessage\.platform, String\(byMessage\.messageId\)\]/);
  assert.match(route, /return Response\.json\(\{ ok: true \}\);\s*\}\s*$/, "vacuity anchor");
});

test("Reports are a Mod Panel place, read from the mod-scoped route; the menu and the card offer Report", () => {
  assert.match(read("../features/moderation/modLayout.ts"), /\{ key: "reports", label: "Reports",/);
  assert.match(read("../features/moderation/ModPanel.tsx"), /\{shown === "reports" && <ReportsSection /);
  const support = read("../api/mod/support/route.ts");
  assert.match(support, /export async function GET\(\) \{\s*const modId = await requireMod\(\);/, "mods, not only admins");
  assert.match(support, /COALESCE\(cm\.message, cl\.message\) AS message_text/);
  assert.match(read("../components/MessageContextMenu.tsx"), /\{onReport && \(\s*<MenuItem onClick=\{\(\) => \{ onClose\(\); onReport\(\); \}\}>/);
  const chat = read("../features/chat/ChatMessage.tsx");
  assert.match(chat, /const canReport = !!badgeState\.myMatrixId && msg\.id != null && \/\^\\d\+\$\/\.test\(String\(msg\.id\)\) && !msg\.system && msg\.matrixId !== badgeState\.myMatrixId;/);
  assert.match(chat, /\{\(onPin \|\| onModDelete \|\| canReport\) && msg\.id != null && \(/, "the ⋯ is there for a viewer who can report");
  assert.match(read("../components/UserCard.tsx"), /openReportDialog\(\{ platform: msg\.platform, messageId: msg\.id, name: displayName \}\)/);
});

test("an admin's user card makes or removes a moderator through the /mod route", () => {
  const card = read("../components/UserCard.tsx");
  assert.match(card, /const res = await postJson\("\/api\/mod\/setmod", \{ targetId: siteId, grant \}\)/);
  assert.match(card, /\{badges\.isAdmin && siteId && !isOwnMessage && targetIsMod !== null && \(/, "admins only, never on yourself");
  assert.match(card, /\{targetIsMod \? "Remove moderator" : "Make moderator"\}/);
});
