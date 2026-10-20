import { randomUUID } from "node:crypto";
import pool from "@/lib/db";
import { requireMod, assertCanModerate } from "@/app/lib/admin";
import { appendModLog } from "@/app/lib/modlog";
import { fanOutBan, fanOutUnban } from "@/app/lib/platformMod";
import { applyModRole } from "@/app/lib/modRole";
import { linkedMatrixIds } from "@/app/lib/canonicalIdentity";
import { NextRequest } from "next/server";

// GET ?targetId= — current ban/timeout status of a user (mod only)
export async function GET(req: NextRequest) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const targetId = req.nextUrl.searchParams.get("targetId");
  if (!targetId) return new Response("Bad Request", { status: 400 });

  const { rows } = await pool.query(
    `SELECT expires_at FROM site.bans WHERE matrix_id = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
    [targetId]
  );
  if (rows.length === 0) return Response.json({ banned: false });
  return Response.json({ banned: true, expiresAt: rows[0].expires_at });
}

// A canonical stream id (12-hex) names a platform-only chatter — or, when it is LINKED, the site
// account(s) behind it, and then the action is a full site ban/unban. EVERY linked account is acted
// on (round 5, M1): a canonical two site accounts share is one person (a link is proof), and the
// old unordered `LIMIT 1` banned an arbitrary one of them while the other chatted on. Enforcement
// needs every linked identity — the ceiling already checks every one. [] = platform-only.
// A failed read THROWS (the route answers 503): read as "unlinked", it would turn a site ban into a
// platform-only one.
async function linkedAccounts(canonicalId: string): Promise<string[]> {
  const ids = await linkedMatrixIds(canonicalId, (sql, params) => pool.query<{ matrix_id: string }>(sql, params));
  return [...ids].sort();
}

const unavailable = () =>
  new Response("Moderation check unavailable — try again shortly", { status: 503, headers: { "Retry-After": "5" } });

const CANONICAL_RE = /^[0-9a-f]{12}$/i;

function canonicalOf(body: { canonicalId?: unknown } | null): string | null {
  return typeof body?.canonicalId === "string" && CANONICAL_RE.test(body.canonicalId) ? body.canonicalId.toLowerCase() : null;
}

type BanAction = {
  mod: string; durationMinutes: number | null; expiresAt: string | null; reason: string | null;
  override: boolean; batchId: string;
};
type BanResult = { applied: boolean; previous: { expiresAt: string | null } | null; kept?: string; platforms: string[] };

/** The site ban of ONE account: its row, its mod-log line, a mod's role on a permanent ban, the
 *  platform fan-out. */
async function banAccount(targetId: string, a: BanAction): Promise<BanResult> {
  // The ban this one replaces, if any: the panel's Undo puts it back.
  const { rows: existing } = await pool.query<{ expires_at: Date | null }>(
    `SELECT expires_at FROM site.bans
     WHERE matrix_id = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
    [targetId]
  );
  const prior = existing[0];
  const previous = prior ? { expiresAt: prior.expires_at ? prior.expires_at.toISOString() : null } : null;

  // Downgrade guard: a permanent ban is never silently replaced, and a timeout
  // only ever extends — so two mods acting on the same troll seconds apart
  // can't accidentally shorten each other's action (the second click would
  // otherwise overwrite). Deliberate reductions pass override: true (mod panel).
  if (!a.override && prior) {
    const cur = prior.expires_at;
    const isDowngrade =
      (cur === null && a.expiresAt !== null) || // permanent → timeout
      (cur !== null && a.expiresAt !== null && new Date(a.expiresAt) <= cur); // shorter/equal timeout
    if (isDowngrade) return { applied: false, previous, kept: cur === null ? "permanent" : cur.toISOString(), platforms: [] };
  }

  await pool.query(
    `INSERT INTO site.bans (matrix_id, banned_by, reason, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (matrix_id) DO UPDATE
       SET banned_by = $2, reason = $3, expires_at = $4, created_at = NOW()`,
    [targetId, a.mod, a.reason, a.expiresAt]
  );

  await appendModLog({
    action: a.durationMinutes ? "timeout" : "ban",
    target: targetId,
    by: a.mod,
    durationMinutes: a.durationMinutes,
    expiresAt: a.expiresAt,
    reason: a.reason,
    batchId: a.batchId,
  });

  // A permanent ban ends a moderator's role (a timeout does not: requireMod already refuses a
  // banned mod while it runs). Only an admin gets here for a mod — the ceiling in POST.
  if (!a.durationMinutes && (await applyModRole((sql, p) => pool.query(sql, p), targetId, false)) === "changed") {
    await appendModLog({ action: "mod_revoked", target: targetId, by: a.mod, reason: "banned" });
  }

  // Best-effort fan-out to the platforms (Twitch). Fire-and-forget AFTER the
  // site ban has persisted — a platform failure never blocks or slows the
  // site action; every attempt is recorded in site.platform_mod_actions.
  const platforms = fanOutBan(a.mod, targetId, a.durationMinutes, a.reason, a.batchId);
  return { applied: true, previous, platforms };
}

export async function POST(req: NextRequest) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const body = await req.json().catch(() => null);
  if (!body) return new Response("Bad Request", { status: 400 });
  const durationMinutes: number | null = body.durationMinutes || null;
  const targetId = typeof body.targetId === "string" ? body.targetId : null;
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : null;

  const expiresAt = durationMinutes
    ? new Date(Date.now() + durationMinutes * 60 * 1000).toISOString()
    : null;

  // Canonical target (platform-origin message, no matrix id on the frame): if
  // the canonical is linked to site accounts, the normal site ban of each below;
  // otherwise there is no site.bans row to write (FK → site.users)
  // and this is a pure platform fan-out via the identity graph — the platforms
  // themselves are the source of truth for a platform-only chatter's ban state.
  const canonicalId = canonicalOf(body);

  // Privilege ceiling: a non-admin mod may not ban/timeout the owner or another mod,
  // whether named by matrix id or by a linked platform canonical. Checked on
  // the raw target before any state changes.
  const guardTarget = targetId ?? canonicalId;
  if (guardTarget) {
    const denied = await assertCanModerate(mod, guardTarget);
    if (denied) return denied;
  }

  // Groups this action's mod-log rows with its platform rows, so the mod who acted can read back
  // how each platform answered (the status line after the action, the ✗ on history rows).
  const batchId = randomUUID();

  let targets: string[] = targetId ? [targetId] : [];
  if (!targetId && canonicalId) {
    try { targets = await linkedAccounts(canonicalId); } catch { return unavailable(); }
    if (targets.length === 0) {
      await appendModLog({
        action: durationMinutes ? "timeout" : "ban",
        target: canonicalId,
        by: mod,
        durationMinutes,
        expiresAt,
        reason,
        batchId,
      });
      const platforms = fanOutBan(mod, canonicalId, durationMinutes, reason, batchId);
      // No site row to read: what the platforms held before is theirs to know (previous: null).
      return Response.json({ ok: true, applied: true, expiresAt, platformOnly: true, previous: null, batchId, platforms });
    }
  }
  if (targets.length === 0) {
    return new Response("Bad Request", { status: 400 });
  }

  const action: BanAction = { mod, durationMinutes, expiresAt, reason, override: body.override === true, batchId };
  const results: BanResult[] = [];
  for (const t of targets) results.push(await banAccount(t, action));
  // The panel's answer (Undo's previous ban, a kept longer ban) is the FIRST account's; any account
  // the action reached counts as applied.
  const first = results[0]!;
  if (!results.some((r) => r.applied)) return Response.json({ ok: true, applied: false, kept: first.kept });
  const platforms = [...new Set(results.flatMap((r) => r.platforms))];
  return Response.json({ ok: true, applied: true, expiresAt, previous: first.previous, batchId, platforms, accounts: targets.length });
}

export async function DELETE(req: NextRequest) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const body = await req.json().catch(() => null);
  const targetId = typeof body?.targetId === "string" ? body.targetId : null;

  // Canonical target — mirror of the POST branch: linked → the site unban of every linked
  // account; unlinked → pure platform fan-out (nothing site-side to lift).
  const canonicalId = canonicalOf(body);

  // Privilege ceiling, as POST: a mod must not lift an admin's ban or timeout of another mod
  // (or of the owner), named by matrix id or by a linked canonical.
  const guardTarget = targetId ?? canonicalId;
  if (guardTarget) {
    const denied = await assertCanModerate(mod, guardTarget);
    if (denied) return denied;
  }

  const batchId = randomUUID();
  let targets: string[] = targetId ? [targetId] : [];
  if (!targetId && canonicalId) {
    try { targets = await linkedAccounts(canonicalId); } catch { return unavailable(); }
    if (targets.length === 0) {
      await appendModLog({ action: "unban", target: canonicalId, by: mod, batchId });
      const platforms = fanOutUnban(mod, canonicalId, batchId);
      return Response.json({ ok: true, platformOnly: true, batchId, platforms });
    }
  }
  if (targets.length === 0) {
    return new Response("Bad Request", { status: 400 });
  }

  const platforms = new Set<string>();
  for (const t of targets) {
    await pool.query(`DELETE FROM site.bans WHERE matrix_id = $1`, [t]);
    await appendModLog({ action: "unban", target: t, by: mod, batchId });
    // Mirror the unban to the platforms so a site unban doesn't leave the
    // person platform-banned. Best-effort, fire-and-forget (see fanOutBan).
    for (const p of fanOutUnban(mod, t, batchId)) platforms.add(p);
  }

  return Response.json({ ok: true, batchId, platforms: [...platforms] });
}
