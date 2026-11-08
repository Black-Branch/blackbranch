// The mods' one Timeout (spec 2026-10-23 §4.11): a timed site ban, the same row the Mod Panel's
// timeout writes. The community reconciler makes it level −1 in every community room until it ends;
// the chat path and the platforms get it as they get any site timeout. The route (app/api/mod/timeout)
// wires these handlers to the pool and the services.
import { TIMEOUT_CHOICES, TIMEOUT_REASON_MAX } from "./timeoutChoices.ts";
import { LIFT_TIMEOUT_SQL } from "./unbans.ts";
import { ACCOUNT_CANONICALS_SQL } from "../canonicalIdentity.ts";

type Queryable = { query: <R extends object>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> };

export type TimeoutDeps = {
  db: Queryable;
  /** The signed-in mod (requireMod). */
  mod: string;
  /** The moderation ceiling: a Response refuses (a mod never acts on an admin, another mod or staff). */
  ceiling: (actor: string, target: string) => Promise<Response | null>;
  log: (e: { action: "timeout" | "unban"; target: string; by: string; durationMinutes?: number; expiresAt?: string; reason?: string; batchId: string }) => Promise<void>;
  pushChat: (b: { matrixId: string; expiresAt: string | null; lift: boolean }) => Promise<void>;
  /** The platforms' own timeout, fire and forget; answers the platforms it reaches. */
  fanOut: (target: string, minutes: number, reason: string, batchId: string) => string[];
  fanOutLift: (target: string, batchId: string) => string[];
  /** Ask for a reconciler run (only while the install has one). Never throws. */
  reconcile: () => Promise<boolean>;
  batchId?: () => string;
  logError?: (message: string) => void;
};

const MINUTES: ReadonlySet<number> = new Set(TIMEOUT_CHOICES.map((c) => c.minutes));
const MATRIX_USER = /^@[^\s:]+:[^\s]+$/;

const fail = (status: number, error: string) => Response.json({ error }, { status });
const WHO = "Choose who to time out.";
const HOW_LONG = `Choose how long: ${TIMEOUT_CHOICES.slice(0, -1).map((c) => c.label).join(", ")} or ${TIMEOUT_CHOICES.at(-1)!.label}.`;
const REASON = `Write a reason, up to ${TIMEOUT_REASON_MAX} characters.`;
const BANNED = "That person is banned.";
const NOT_AN_ACCOUNT = "That isn't an account on this site.";
const UNSAVED = "The timeout could not be saved. Try again.";

async function bodyOf(req: Request): Promise<Record<string, unknown>> {
  try {
    const b: unknown = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const target = (b: Record<string, unknown>) => (typeof b.userId === "string" && MATRIX_USER.test(b.userId) ? b.userId : null);
const iso = (d: Date | string) => new Date(d).toISOString();

// One statement: a new row, or a replaced one only when it is a timeout ending SOONER. A ban
// (expires_at NULL) or a longer timeout is never shortened, however two mods race. When it applies,
// the same timeout is written on every canonical linked to the account now (their standing is their
// own mod_log rows — config/canonical-standing.mjs), so it holds in every reader.
// $1 who, $2 mod, $3 reason, $4 minutes, $5 batch id.
const TIMEOUT_SQL = `
  WITH up AS (
    INSERT INTO site.bans (matrix_id, banned_by, reason, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4::int))
    ON CONFLICT (matrix_id) DO UPDATE
      SET banned_by = EXCLUDED.banned_by, reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at, created_at = now()
      WHERE site.bans.expires_at IS NOT NULL AND site.bans.expires_at < EXCLUDED.expires_at
    RETURNING expires_at),
  canonicals AS (
    INSERT INTO site.mod_log (action, target_id, performed_by, duration_minutes, expires_at, reason, batch_id)
    SELECT 'timeout', linked.canonical, $2, $4::int, up.expires_at, 'timed out with ' || $1, $5::uuid
      FROM ${ACCOUNT_CANONICALS_SQL}, up)
  SELECT expires_at FROM up`;

/** POST {userId, minutes, reason}. */
export async function timeoutPostResponse(req: Request, deps: TimeoutDeps): Promise<Response> {
  const b = await bodyOf(req);
  const who = target(b);
  if (!who) return fail(400, WHO);
  if (typeof b.minutes !== "number" || !MINUTES.has(b.minutes)) return fail(400, HOW_LONG);
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (!reason || reason.length > TIMEOUT_REASON_MAX) return fail(400, REASON);
  if (who === deps.mod) return fail(400, "You cannot time yourself out.");
  const minutes = b.minutes;

  const denied = await deps.ceiling(deps.mod, who);
  if (denied) return denied;

  const batchId = (deps.batchId ?? (() => crypto.randomUUID()))();
  let until: string;
  try {
    const { rows } = await deps.db.query<{ expires_at: Date | string }>(TIMEOUT_SQL, [who, deps.mod, reason, minutes, batchId]);
    if (!rows[0]) {
      const { rows: held } = await deps.db.query<{ expires_at: Date | string | null }>(`SELECT expires_at FROM site.bans WHERE matrix_id = $1`, [who]);
      if (!held[0]) return fail(503, UNSAVED);
      if (held[0].expires_at === null) return fail(409, BANNED);
      return Response.json({ ok: true, applied: false, until: iso(held[0].expires_at) });
    }
    until = iso(rows[0].expires_at);
  } catch (e) {
    if ((e as { code?: unknown })?.code === "23503") return fail(404, NOT_AN_ACCOUNT);
    (deps.logError ?? console.error)(`[mod] timeout write failed: ${e instanceof Error ? e.message : String(e)}`);
    return fail(503, UNSAVED);
  }

  await deps.log({ action: "timeout", target: who, by: deps.mod, durationMinutes: minutes, expiresAt: until, reason, batchId });
  await deps.pushChat({ matrixId: who, expiresAt: until, lift: false });
  const platforms = deps.fanOut(who, minutes, reason, batchId);
  await deps.reconcile();
  return Response.json({ ok: true, applied: true, until, batchId, platforms });
}

/** DELETE {userId}: lift a running timeout (a ban is lifted by Unban, never here). */
export async function timeoutDeleteResponse(req: Request, deps: TimeoutDeps): Promise<Response> {
  const who = target(await bodyOf(req));
  if (!who) return fail(400, WHO);

  const denied = await deps.ceiling(deps.mod, who);
  if (denied) return denied;

  const batchId = (deps.batchId ?? (() => crypto.randomUUID()))();
  let lifted: number;
  try {
    const { rows } = await deps.db.query<{ lifted: number; banned: boolean }>(LIFT_TIMEOUT_SQL, [who, deps.mod, batchId]);
    if (rows[0]?.banned) return fail(409, BANNED);
    lifted = Number(rows[0]?.lifted ?? 0);
  } catch (e) {
    (deps.logError ?? console.error)(`[mod] timeout lift failed: ${e instanceof Error ? e.message : String(e)}`);
    return fail(503, "The timeout could not be lifted. Try again.");
  }
  if (!lifted) return Response.json({ ok: true, lifted: false });

  await deps.log({ action: "unban", target: who, by: deps.mod, batchId });
  await deps.pushChat({ matrixId: who, expiresAt: null, lift: true });
  const platforms = deps.fanOutLift(who, batchId);
  await deps.reconcile();
  return Response.json({ ok: true, lifted: true, batchId, platforms });
}
