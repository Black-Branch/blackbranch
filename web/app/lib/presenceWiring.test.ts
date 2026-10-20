// Wiring for presence + people. The rules are unit-tested in
// presenceState.test.ts / memberGroups.test.ts; this file pins the plumbing.
// Every scan reads with comments stripped and anchors on the END of the file.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/presenceWiring.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

// The migration history (migrations/schema.sql + migrate-vN.sql) is the private repo's; a public
// tree starts from migrations/baseline/. A test of what one migration wrote runs where the history is.
const CHAIN = existsSync(join(process.cwd(), "..", "migrations", "schema.sql"));
const HISTORY = CHAIN ? false : "reads the migration history, which this tree does not carry";

const web = process.cwd();
const read = (p: string) => readFileSync(join(web, p), "utf8");
const endsWithBrace = (src: string, name: string) => assert.match(src, /\}\s*$/, `END of ${name} not read`);

test("T3: migrate-v120 creates site.presence with a nullable last_beat and registers itself", { skip: HISTORY }, () => {
  const sql = read("../migrations/migrate-v120.sql");
  assert.match(sql, /ON CONFLICT DO NOTHING;\s*$/, "END of migrate-v120.sql not read / tracking insert missing");
  const s = sql.replace(/^\s*--.*$/gm, "");
  assert.match(s, /CREATE TABLE IF NOT EXISTS site\.presence \(/);
  assert.match(s, /last_beat\s+TIMESTAMPTZ,/, "last_beat must be nullable — a status-only write must not read as a beat");
  assert.match(s, /CHECK \(status IN \('online', 'idle', 'dnd', 'invisible'\)\)/);
  assert.match(s, /VALUES \(120,/);
  assert.doesNotMatch(s, /DROP |kick/i, "v120 must not fold in the parked v118 drop");
});

test("T3: the beat route upserts timestamps only — never status — and answers with the stored status", () => {
  const src = read("app/api/presence/beat/route.ts");
  endsWithBrace(src, "beat route");
  const s = stripComments(src);
  assert.match(s, /export async function POST\(/);
  assert.match(s, /const matrixId = await requireUser\(\);\s*if \(typeof matrixId !== "string"\) return matrixId;/);
  assert.match(s, /pageFromPath\(/, "the page is re-derived server-side from what the client sent, never trusted raw");
  const upsert = s.slice(s.indexOf("INSERT INTO site.presence"), s.indexOf("updated_at     = now()"));
  assert.ok(upsert.length > 0, "upsert not found");
  assert.match(upsert, /\(matrix_id, last_beat, last_visible, last_community, page, updated_at\)/);
  assert.match(upsert, /last_visible   = CASE WHEN \$2 THEN now\(\) ELSE site\.presence\.last_visible END/);
  assert.match(upsert, /last_community = CASE WHEN \$3 THEN now\(\) ELSE site\.presence\.last_community END/);
  assert.doesNotMatch(upsert, /status/, "the beat never touches status/status_text");
  assert.match(s, /readPresenceStatus\(matrixId\)/, "the response carries the stored status for the community client's sync presence");
});

test("T3: the status route validates, sanitizes to 80 chars, upserts with last_beat NULL on create, and mirrors to Matrix", () => {
  const src = read("app/api/presence/status/route.ts");
  endsWithBrace(src, "status route");
  const s = stripComments(src);
  assert.match(s, /export async function PUT\(/);
  assert.match(s, /if \(!isSelfStatus\(status\)\) return new Response\("Bad status", \{ status: 400 \}\);/);
  assert.match(s, /sanitizeChatMessage\(String\(body\?\.text \?\? ""\), 80\)/);
  assert.match(s, /INSERT INTO site\.presence \(matrix_id, status, status_text, updated_at\)\s*VALUES \(\$1, \$2, \$3, now\(\)\)/, "the create path sets no last_beat");
  assert.match(s, /ON CONFLICT \(matrix_id\) DO UPDATE SET status = EXCLUDED\.status, status_text = EXCLUDED\.status_text, updated_at = now\(\)/);
  assert.match(s, /await mirrorStatusToMatrix\(status, text\);/, "the mirror runs after the row is written");
});

test("T3: the mirror uses the caller's own session token, PUTs the mapped presence, never logs the token, never throws", () => {
  const src = read("app/lib/presenceServer.ts");
  endsWithBrace(src, "presenceServer.ts");
  const s = stripComments(src);
  const fn = s.slice(s.indexOf("export async function mirrorStatusToMatrix("), s.indexOf("\n}\n", s.indexOf("export async function mirrorStatusToMatrix(")));
  assert.match(fn, /const mx = await getMatrixSession\(\)/);
  assert.match(fn, /\/_matrix\/client\/v3\/presence\/\$\{encodeURIComponent\(mx\.matrixId\)\}\/status/);
  assert.match(fn, /method: "PUT"/);
  assert.match(fn, /Authorization: `Bearer \$\{mx\.accessToken\}`/);
  assert.match(fn, /JSON\.stringify\(statusToMatrix\(status, text\)\)/);
  assert.match(fn, /console\.error\("\[presence\] matrix mirror failed"/);
  assert.doesNotMatch(fn, /console\.[a-z]+\([^)]*accessToken/, "the token must never reach a log line");
  assert.match(fn, /catch \(e\)/, "best-effort: a failed mirror is logged, not thrown");
});

test("T3: the directory query covers every live account (invisible included), never selects page, reads a last login for the caller only, and leaves disclosure to presenceDirectory.ts", () => {
  const src = read("app/lib/presenceServer.ts");
  endsWithBrace(src, "presenceServer.ts");
  const s = stripComments(src);
  const fn = s.slice(s.indexOf("export async function loadPresenceDirectory("));
  assert.match(fn, /export async function loadPresenceDirectory\(me: string, nowDate: Date = new Date\(\)\)/);
  assert.match(fn, /FROM site\.users u\s+LEFT JOIN site\.presence p ON p\.matrix_id = u\.matrix_id\s+WHERE u\.deleted_at IS NULL`/, "a deleted account is not listed");
  assert.doesNotMatch(fn, /WHERE COALESCE\(p\.status, 'online'\) <> 'invisible'/, "invisible people are not omitted — an omitted row was itself a tell (it fell into Inactive)");
  assert.doesNotMatch(fn.slice(0, fn.indexOf("FROM site.users")), /p\.page/, "the page column is never selected");
  assert.match(fn, /CASE WHEN u\.matrix_id = \$1\s+THEN \(SELECT MAX\(s\.last_seen\) FROM site\.user_sessions s WHERE s\.matrix_id = u\.matrix_id\)\s+END AS last_login/, "another person's last login is never read");
  assert.match(fn, /\[me\]\s*\);/);
  assert.doesNotMatch(fn, /site\.subscriptions|site\.gift_subscriptions|AS supporter/, "supporter comes from the badge decision, not a per-row entitlement");
  assert.match(fn, /supporterSets\(await getBadgeSnapshot\(\), staffMatrixIds\(\)\)/);
  assert.match(fn, /return shapePresenceDirectory\(rows, \{ me, now: nowDate\.getTime\(\), entitled, badgeShown \}\);/);
  const shape = stripComments(read("app/lib/presenceDirectory.ts"));
  endsWithBrace(shape, "presenceDirectory.ts");
  assert.match(shape, /import \{ HERE_MS, AWAY_AFTER_MS,[^}]*\} from "\.\/presenceState\.ts";/);
  assert.doesNotMatch(shape, /150000|150_000|300000|300_000/, "the windows are imported, never re-typed");
});

test("T3: GET /api/presence is auth-gated and a thin read; /api/matrix/token and /api/me carry the stored status", () => {
  const r = stripComments(read("app/api/presence/route.ts"));
  endsWithBrace(r, "presence route");
  assert.match(r, /export async function GET\(/);
  assert.match(r, /const matrixId = await requireUser\(\);\s*if \(typeof matrixId !== "string"\) return matrixId;/);
  assert.match(r, /return Response\.json\(await loadPresenceDirectory\(matrixId\)\);/);
  assert.doesNotMatch(r, /INSERT|UPDATE|DELETE|pool\./);
  const tok = stripComments(read("app/api/matrix/token/route.ts"));
  endsWithBrace(tok, "token route");
  assert.match(tok, /presenceStatus: \(await readPresenceStatus\(mx\.matrixId\)\)\.status,/);
  const me = read("app/api/me/route.ts");
  assert.match(me, /return raw\.startsWith\("@"\) \? matrixLocalpart\(raw\) : raw;\s*\}\s*$/, "END of /api/me not read");
  const ms = stripComments(me);
  assert.match(ms, /const presence = await readPresenceStatus\(session\.user\.id\);/);
  assert.match(ms, /presenceStatus: presence\.status,\s*presenceStatusText: presence\.statusText,/);
});

test("T4: the beat is mounted once under the provider, and the community client sets its sync presence from the stored status AFTER startClient resolves (before the first /sync is built)", () => {
  const layout = stripComments(read("app/(main)/layout.tsx"));
  assert.match(layout, /<\/MatrixClientProvider>\s*\);\s*\}\s*$/, "END of the main layout not read");
  assert.match(layout, /<PresenceBeat \/>/);
  assert.ok(layout.indexOf("<PresenceBeat />") < layout.indexOf("</MatrixClientProvider>"), "the beat needs the provider (community flag)");
  const pb = stripComments(read("app/components/PresenceBeat.tsx"));
  endsWithBrace(pb, "PresenceBeat.tsx");
  assert.match(pb, /usePresenceBeat\(\{ community: status === "ready", pathname \}\)/);
  const ctx = stripComments(read("app/lib/MatrixClientContext.tsx"));
  endsWithBrace(ctx, "MatrixClientContext.tsx");
  const start = ctx.indexOf("await mxClient.startClient({");
  const set = ctx.indexOf("mxClient.setSyncPresence(", start);
  assert.ok(start > 0 && set > start, "setSyncPresence must run AFTER startClient — before it, syncApi does not exist and the call is a no-op");
  // Exclude the `await` that belongs to `await mxClient.setSyncPresence(...)`
  // itself — that one is fine (setSyncPresence resolves synchronously via
  // `this.syncApi?.setPresence(...)`); this checks for any OTHER await
  // sitting between the two calls, which would be a round-trip the first
  // /sync could slip past.
  const between = ctx.slice(ctx.indexOf(";", start) + 1, ctx.lastIndexOf("await", set));
  assert.doesNotMatch(between, /\bawait\b/, "…and before any other await, so it lands before the first /sync is built (sync() awaits push rules first)");
  assert.match(ctx, /window\.addEventListener\("bb:presence-status", onStatus\)/, "a live client follows the picker");
  const hook = stripComments(read("app/lib/usePresenceBeat.ts"));
  endsWithBrace(hook, "usePresenceBeat.ts");
  assert.match(hook, /timer = sched\(beat, beatIntervalMs\(visible\)\)/, "the cadence comes from the rule module");
  assert.match(hook, /if \(r\.status === 401\) \{ stoodDown = true; return; \}/);
  assert.match(hook, /bb:presence-status/, "the beat reads its own response and tells this tab when the status changed elsewhere");
  assert.match(hook, /\}, \[community, pathname, schedule, fetchImpl\]\);/, "a page or community change re-arms the effect, so the next beat reports the new values");
});

test("T5: one shared card, opened to the left from the list; the dot mapping owns every state; the poller is shared", () => {
  const card = stripComments(read("app/components/MemberCard.tsx"));
  endsWithBrace(card, "MemberCard.tsx");
  assert.match(card, /export function MemberCard\(/);
  assert.match(card, /presenceLine\(state, lastActive, now\)/);
  assert.match(card, /side === "left" \? x - W - 8 : x \+ 8/);
  assert.match(card, /site\?\.supporter && \(/, "the Supporter chip");
  const list = stripComments(read("app/features/community/MemberList.tsx"));
  endsWithBrace(list, "MemberList.tsx");
  assert.match(list, /import \{ MemberCard[^}]*\} from "@\/app\/components\/MemberCard";/);
  assert.doesNotMatch(list, /function MemberCard\(/, "the list no longer defines its own card");
  assert.match(list, /<MemberCard[\s\S]*?side="left"/);
  const dot = stripComments(read("app/components/PresenceDot.tsx"));
  endsWithBrace(dot, "PresenceDot.tsx");
  for (const st of ["community", "site", "elsewhere", "away", "dnd", "offline"]) assert.match(dot, new RegExp(`\\b${st}: "`), `dot for ${st}`);
  assert.match(dot, /data-presence=\{state\}/);
  const poll = stripComments(read("app/lib/usePresence.ts"));
  endsWithBrace(poll, "usePresence.ts");
  assert.match(poll, /const POLL_MS = 30_000;/);
  assert.match(poll, /if \(listeners\.size === 0 && timer !== null\) \{ clearInterval\(timer\); timer = null; \}/, "the poll stops with the last consumer");
  assert.match(poll, /u\.lastPresenceTs - \(u\.lastActiveAgo \|\| 0\)/, "Matrix last-active is derived from the SDK's two fields");
  const server = stripComments(read("app/lib/presenceServer.ts"));
  assert.match(server, /type PresenceDirectory[^;]*from "\.\/presenceState"/, "the directory type lives in the pure module — the client never imports the pool-backed one");
});

test("T6: the list groups through memberGroups, derives through deriveState, and collapses Discord + Inactive by default", () => {
  const s = stripComments(read("app/features/community/MemberList.tsx"));
  endsWithBrace(s, "MemberList.tsx");
  assert.match(s, /groupMembers\(views\)/);
  assert.match(s, /deriveState\(site, matrixSnapshotOf\(room, m\.userId\), now\)/);
  assert.match(s, /discord: false, inactive: false \}/, "Discord and Inactive start collapsed");
  assert.match(s, /data-presence-counts/);
  assert.doesNotMatch(s, /function powerTier\(/, "power tiers live in MemberCard.tsx now");
});

test("T7: a message's avatar, name and reply-quote name open the shared card to the RIGHT; Message reaches openOrCreateDM", () => {
  const row = stripComments(read("app/components/MatrixMessageRow.tsx"));
  assert.match(
    row, /export const MatrixMessageRow = memo\(MatrixMessageRowImpl, rowPropsEqual\);\s*$/,
    "MatrixMessageRow.tsx did not end as expected — the read is truncated, and every assertion below it is vacuous",
  );
  assert.equal((row.match(/aria-label=\{`Open member card for \$\{/g) ?? []).length >= 2, true, "avatar + sender name are buttons, and the label carries the sender's name (a bare \"Open member card\" erases it for screen-reader users)");
  assert.match(row, /<MemberCard[\s\S]*?side="right"/);
  assert.match(row, /onMessageUser\?\.\(memberCard\.member\.userId\)/);
  assert.match(row, /onOpenMember/, "the reply quote opens it too");
  assert.match(row, /member \? \(/, "no member → no button (a departed sender is not a focus stop)");
  for (const f of ["app/features/community/Timeline.tsx", "app/features/community/ThreadPanel.tsx"]) {
    const s = stripComments(read(f)); endsWithBrace(s, f);
    assert.match(s, /onMessageUser=\{onMessageUser\}/, `${f} threads the prop`);
  }
  const view = stripComments(read("app/features/community/MatrixView.tsx"));
  endsWithBrace(view, "MatrixView.tsx");
  assert.ok((view.match(/onMessageUser=\{openOrCreateDM\}/g) ?? []).length >= 2, "Timeline AND ThreadPanel get openOrCreateDM");
});

test("T7: the picker saves through PUT /api/presence/status and announces the change; it sits on the profile page", () => {
  const p = stripComments(read("app/components/PresenceStatusPicker.tsx"));
  endsWithBrace(p, "PresenceStatusPicker.tsx");
  assert.match(p, /fetch\("\/api\/presence\/status", \{\s*method: "PUT"/);
  assert.match(p, /new CustomEvent\("bb:presence-status", \{ detail: \{ status: next \} \}\)/);
  assert.match(p, /maxLength=\{80\}/);
  assert.match(p, /onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/, "an option click must not let the input blur into it first");
  assert.match(p, /onBlur=\{\(\) => \{ if \(text !== saved\.text\) void save\(status, text\); \}\}/, "blur only saves when the text actually changed");
  assert.doesNotMatch(p, /disabled=\{saving\}/, "the option buttons no longer disable mid-save (that swallowed the click)");
  assert.match(p, /onClick=\{\(\) => \{ if \(inFlight\.current\) return; setStatus\(o\.value\);/, "a click while a save is in flight is ignored WHOLESALE — no setStatus, so no unsaved selection shows");
  for (const v of ["online", "idle", "dnd", "invisible"]) assert.match(p, new RegExp(`value: "${v}"`));
  assert.match(p, /Couldn.t save your status\. Try again\./);
  assert.match(p, /role="alert"/);
  const body = stripComments(read("app/components/ProfileCardBody.tsx"));
  endsWithBrace(body, "ProfileCardBody.tsx");
  assert.match(body, /<PresenceStatusPicker \/>/);
});
