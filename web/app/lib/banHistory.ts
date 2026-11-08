// "Delete message history" on a ban (client polish Task 21, Discord's ban dialog). Two parts, two
// controls on the form:
// - COMMUNITY channels: the new choice (Don't delete any / Previous hour / Previous 7 days),
//   redacted from the moderator's own client (matrixRedactHistory.ts). Default: none (ADR 0116).
// - SITE chat: the ban's own purge (ticket #228, modPurge.ts purgeWithBan) and its switch, on by
//   default, always the last 24 hours (PURGE_MAX_MINUTES, at most 250 lines). Never a second purge.
// After the community part, POST /api/mod/ban-history writes ONE `history_deleted` mod-log row
// naming both counts. Pure and dependency-free: the route and the forms share it; the route's
// handler takes its dependencies injected (the api/mod/timeout.test.ts pattern).

import type { ModLogEntry } from "./modlog.ts";

export type HistoryWindow = "none" | "1h" | "7d";

/** The choices, in the order the form lists them; the first is the default. */
export const HISTORY_WINDOWS: readonly { value: HistoryWindow; label: string }[] = [
  { value: "none", label: "Don't delete any" },
  { value: "1h", label: "Previous hour" },
  { value: "7d", label: "Previous 7 days" },
];

const HOUR_MS = 3_600_000;

/** Where the window starts, or null for "Don't delete any".
 *  @test-only deleteHistoryAfterBan below calls it; the test pins the two spans. */
export function historySince(w: HistoryWindow, now: number): number | null {
  return w === "1h" ? now - HOUR_MS : w === "7d" ? now - 7 * 24 * HOUR_MS : null;
}

const SPAN: Record<Exclude<HistoryWindow, "none">, string> = { "1h": "the last hour", "7d": "the last 7 days" };
const SITE_SPAN = "the last 24 hours";
const SITE_CAP = "at most 250 messages";

/** The confirm sentence: what disappears. `sitePurge` = the ban's site-chat purge will run. */
export function banConfirmText(name: string, w: HistoryWindow, sitePurge: boolean): string {
  if (w === "none") {
    return sitePurge
      ? `Ban ${name} and remove their site chat from ${SITE_SPAN} (${SITE_CAP})? Their community messages stay. This can't be undone.`
      : `Ban ${name}? Their messages stay.`;
  }
  return sitePurge
    ? `Ban ${name} and delete their messages from ${SPAN[w]} in every community channel, and from ${SITE_SPAN} in site chat (${SITE_CAP})? This can't be undone.`
    : `Ban ${name} and delete their messages from ${SPAN[w]} in every community channel? Their site chat stays. This can't be undone.`;
}

/** The sentence for deleting the history of someone already banned (the member card's retry). */
export function deleteConfirmText(name: string, w: Exclude<HistoryWindow, "none">): string {
  return `Delete ${name}'s messages from ${SPAN[w]} in every community channel? This can't be undone.`;
}

/** The mod-log row's reason: "1h · 3 community · 2 site chat".
 *  @test-only banHistoryResponse below writes it; the test pins the failed and no-site forms. */
export function historyReason(w: Exclude<HistoryWindow, "none">, community: number, failed: number, site: number | null): string {
  return [w, `${community} community`, ...(failed > 0 ? [`${failed} not removed`] : []), ...(site === null ? [] : [`${site} site chat`])].join(" · ");
}

export type BanHistoryBody = {
  targetId: string; window: Exclude<HistoryWindow, "none">;
  communityRedacted: number; communityFailed: number;
  /** The site lines the ban's own purge removed; null when no ban ran with it (the retry). */
  siteRemoved: number | null;
  /** The ban's batch, so the row sits with the ban's rows. */
  batchId: string | null;
};

const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100_000 ? v : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MXID = /^@[^:\s]+:\S+$/;

function parse(b: unknown): BanHistoryBody | null {
  if (!b || typeof b !== "object") return null;
  const o = b as Record<string, unknown>;
  const targetId = typeof o.targetId === "string" && o.targetId.length <= 255 && MXID.test(o.targetId) ? o.targetId : null;
  const window = o.window === "1h" || o.window === "7d" ? o.window : null;
  const communityRedacted = count(o.communityRedacted);
  const communityFailed = count(o.communityFailed);
  const siteRemoved = o.siteRemoved === undefined || o.siteRemoved === null ? null : count(o.siteRemoved);
  const batchId = o.batchId === undefined || o.batchId === null ? null : typeof o.batchId === "string" && UUID.test(o.batchId) ? o.batchId : undefined;
  if (!targetId || !window || communityRedacted === null || communityFailed === null || batchId === undefined) return null;
  if (siteRemoved === null && o.siteRemoved !== undefined && o.siteRemoved !== null) return null;
  return { targetId, window, communityRedacted, communityFailed, siteRemoved, batchId };
}

export type BanHistoryDeps = {
  mod: string;
  /** assertCanModerate: a refusal Response, or null. */
  ceiling: (actor: string, target: string) => Promise<Response | null>;
  log: (e: ModLogEntry) => Promise<unknown>;
};

/** POST /api/mod/ban-history: the ceiling on the target, then ONE `history_deleted` row. */
export async function banHistoryResponse(req: Request, deps: BanHistoryDeps): Promise<Response> {
  const body = parse(await req.json().catch(() => null));
  if (!body) return new Response("Bad Request", { status: 400 });
  const refused = await deps.ceiling(deps.mod, body.targetId);
  if (refused) return refused;
  await deps.log({
    action: "history_deleted", target: body.targetId, by: deps.mod,
    reason: historyReason(body.window, body.communityRedacted, body.communityFailed, body.siteRemoved),
    batchId: body.batchId,
  });
  return Response.json({ ok: true });
}

/** GET /api/mod/ban-history?targetId=: the ceiling ALONE, asked before a single line is redacted.
 *  Matrix judges a redaction on the redactor's power only, so a mod's client could delete the lines
 *  of someone the site says they may not moderate (Staff, an admin) — this answers first. */
export async function banHistoryCheck(req: Request, deps: Pick<BanHistoryDeps, "mod" | "ceiling">): Promise<Response> {
  const targetId = new URL(req.url).searchParams.get("targetId") ?? "";
  if (targetId.length > 255 || !MXID.test(targetId)) return new Response("Bad Request", { status: 400 });
  const refused = await deps.ceiling(deps.mod, targetId);
  return refused ?? Response.json({ ok: true });
}

export const COMMUNITY_UNREACHABLE = "Community messages weren't removed — the community isn't reachable; try again from their member card.";
const NOT_LOGGED = " The mod history couldn't record it.";

export type HistoryRunDeps = {
  /** The ceiling, asked first (GET /api/mod/ban-history): null = allowed, else the refusal's words. */
  check: (targetId: string) => Promise<string | null>;
  /** Redact from `since` in the ban's community scope; null when the community is not reachable. */
  redact: (since: number) => Promise<{ redacted: number; failed: number; rooms: number } | null>;
  post: (body: BanHistoryBody) => Promise<boolean>;
};

/** After the ban took effect (or alone, for someone already banned): the ceiling, the community
 *  part, then the ONE route call. Returns the status line, or null when nothing was asked
 *  ("Don't delete any"). Callers run it only once their own ban went through. */
export async function deleteHistoryAfterBan(
  deps: HistoryRunDeps,
  o: { targetId: string; window: HistoryWindow; now: number; siteRemoved: number | null; batchId: string | null },
): Promise<string | null> {
  const since = historySince(o.window, o.now);
  if (since === null || o.window === "none") return null;
  const refused = await deps.check(o.targetId);
  if (refused !== null) return `Community messages weren't removed: ${refused}`;
  const out = await deps.redact(since);
  if (!out) return COMMUNITY_UNREACHABLE;
  const logged = await deps.post({
    targetId: o.targetId, window: o.window, communityRedacted: out.redacted, communityFailed: out.failed,
    siteRemoved: o.siteRemoved, batchId: o.batchId,
  });
  const removed = `Removed ${out.redacted} community ${out.redacted === 1 ? "message" : "messages"}`;
  const line = out.failed > 0 ? `${removed}; ${out.failed} couldn't be removed — try again from their member card.` : `${removed}.`;
  return logged ? line : line + NOT_LOGGED;
}

/** The ceiling's answer as the check above wants it: null when allowed, else short words. */
export async function refusalOf(res: Response | null): Promise<string | null> {
  if (res?.ok) return null;
  if (!res) return "the check didn't answer — try again.";
  const t = (await res.text().catch(() => "")).trim();
  return t && t.length < 160 ? t : "you can't moderate this member.";
}
