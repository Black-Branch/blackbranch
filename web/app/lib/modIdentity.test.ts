// A moderator's chat resolves the public ids on screen to canonical ids for the moderation tools
// (owner decision 2026-10-17: the public socket and history carry no canonical). One batched
// request per tick, cached for the page; the route is moderators only.
// Run: node --test app/lib/modIdentity.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

test("ids asked in one tick go in ONE request, and an answer is cached", async () => {
  const calls: string[][] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
    calls.push(ids);
    return new Response(JSON.stringify({ ids: Object.fromEntries(ids.map((id) => [id, { canonicalId: `c-${id}`, matrixId: null }])) }));
  }) as typeof fetch;
  try {
    const { modIdsNow } = await import("./modIdentity.ts");
    assert.equal(modIdsNow("pA"), null, "not resolved yet — it asks");
    assert.equal(modIdsNow("pB"), null);
    assert.equal(modIdsNow("pA"), null, "asked twice, queued once");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(calls, [["pA", "pB"]]);
    assert.deepEqual(modIdsNow("pA"), { canonicalId: "c-pA", matrixId: null });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.length, 1, "a cached id is never asked again");
  } finally {
    globalThis.fetch = realFetch;
  }
});

const route = stripComments(readFileSync(join(process.cwd(), "app", "api", "mod", "identity", "resolve", "route.ts"), "utf8"));

test("the resolve route is moderators only, bounded, and drops what does not read back", () => {
  assert.match(route, /const mod = await requireMod\(\);\s*if \(typeof mod !== "string"\) return mod;/);
  assert.match(route, /\.slice\(0, MAX_IDS\)/);
  assert.match(route, /const MAX_IDS = 200;/);
  assert.match(route, /if \(p && p\.canonical !== ERASED_CANONICAL\) parsed\.set\(id, p\.canonical\);/);
  assert.match(route, /return Response\.json\(\{ ids: out \}, \{ headers: \{ "Cache-Control": "private, no-store" \} \}\);\s*\}\s*$/, "END anchor");
});

const own = stripComments(readFileSync(join(process.cwd(), "app", "api", "me", "public-ids", "route.ts"), "utf8"));

test("a viewer's own public ids answer only for the session's own account", () => {
  assert.match(own, /const matrixId = await requireUser\(\);/);
  assert.match(own, /resolveIdentities\(\{ matrixId \}\)/);
  assert.doesNotMatch(own, /searchParams|req\.json/, "the route takes no id from the caller");
});

// The chat client keys every per-person feature on the line's public id (or a site line's Matrix
// id). The canonical id appears only in moderator code — this lists where, so a new reader of it
// is a decision, not an accident.
test("only moderator code reads a chat line's canonicalId", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const ALLOWED = new Set([
    "app/lib/modIdentity.ts", "app/lib/modQuickActions.ts", "app/lib/chatHistoryRows.ts", "app/lib/markedPeople.ts",
    "app/components/MessageDetails.tsx", "app/components/MessageContextMenu.tsx",
    "app/features/chat/ChatSidebar.tsx", // the automod queue (a moderator route's rows)
    "app/features/moderation/sections/ChatHistorySection.tsx", "app/features/moderation/sections/MarksSection.tsx",
  ]);
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(join(process.cwd(), dir))) {
      const rel = `${dir}/${f}`;
      if (statSync(join(process.cwd(), rel)).isDirectory()) { if (f !== "api" && f !== "node_modules") walk(rel); continue; }
      if (!/\.(ts|tsx)$/.test(f) || /\.test\./.test(f)) continue;
      const src = stripComments(readFileSync(join(process.cwd(), rel), "utf8"));
      if (/\b(?:msg|m|who|f)\.canonicalId\b/.test(src) && !ALLOWED.has(rel)) hits.push(rel);
    }
  };
  walk("app/components"); walk("app/features"); walk("app/lib");
  assert.deepEqual(hits, [], "a client file keys on a chat line's canonical id");
  assert.ok(ALLOWED.size > 5, "vacuity anchor");
});
