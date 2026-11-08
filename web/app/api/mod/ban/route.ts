import { randomUUID } from "node:crypto";
import pool from "@/lib/db";
import { requireMod, assertCanModerate, assertCanModerateAccount } from "@/app/lib/admin";
import { appendModLog } from "@/app/lib/modlog";
import { fanOutBan, fanOutUnban } from "@/app/lib/platformMod";
import { applyModRole } from "@/app/lib/modRole";
import { siteAccountsOf } from "@/app/lib/canonicalIdentity";
import { NextRequest } from "next/server";
import { chatBanBody, pushChatBan } from "@/app/lib/chatBanPush";
import { LIFT_BAN_SQL } from "@/app/lib/community/unbans";
import { BAN_ACCOUNT_SQL, CANONICAL_ACTION_SQL } from "@/app/lib/community/accountBans";
import { requestReconcile } from "@/app/lib/community/reconcileRequest";
import { purgeWithBan, NO_PURGE } from "@/app/lib/modPurge";
import { purgeDeps } from "@/app/lib/modPurgeServer";
import { banPurges, clickedLineOf, PURGE_MAX_MINUTES } from "@/app/lib/modRequests";
import { banLiftRefusal } from "@/app/lib/modUnban";

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
// on: a canonical two site accounts share is one person (a link is proof), and an unordered
// `LIMIT 1` would ban an arbitrary one of them while the other chatted on. Enforcement
// needs every linked identity — the ceiling already checks every one. [] = platform-only.
// A failed read THROWS (the route answers 503): read as "unlinked", it would turn a site ban into a
// platform-only one.
async function linkedAccounts(canonicalId: string): Promise<string[]> {
  return siteAccountsOf(canonicalId, (sql, params) => pool.query<{ matrix_id: string }>(sql, params));
}

const unavailable = () =>
  new Response("Moderation check unavailable — try again shortly", { status: 503, headers: { "Retry-After": "5" } });

const CANONICAL_RE = /^[0-9a-f]{12}$/i;

// A ban names a site ACCOUNT (site.bans → site.users). A target with no account row — the
// homeserver's own @system user, a typo, a room id — would reach the INSERT and answer 500 with
// no mod-log line. Refused first, in words.
const NOT_A_MEMBER = "That isn't an account on this site — there is nothing to ban.";
async function isSiteAccount(matrixId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM site.users WHERE matrix_id = $1`, [matrixId]);
  return rows.length > 0;
}

function canonicalOf(body: { canonicalId?: unknown } | null): string | null {
  return typeof body?.canonicalId === "string" && CANONICAL_RE.test(body.canonicalId) ? body.canonicalId.toLowerCase() : null;
}

type BanAction = {
  mod: string; durationMinutes: number | null; expiresAt: string | null; reason: string | null;
  override: boolean; batchId: string;
  /** Every account this action covers (a ban by a canonical covers each account linked to it): a
   *  reduction lifts what any of them placed on a shared canonical. */
  covered: string[];
};
type BanResult = {
  applied: boolean; previous: { expiresAt: string | null } | null; kept?: string; platforms: string[];
  /** Linked identities (canonical ids, server-side only) that keep a ban or timeout of their own
   *  through a reduction. */
  keptIdentities?: string[];
};

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
  // otherwise overwrite). Deliberate reductions pass override: true (mod panel, Undo);
  // BAN_ACCOUNT_SQL then reduces the linked canonicals too (an unban before the new action).
  if (!a.override && prior) {
    const cur = prior.expires_at;
    const isDowngrade =
      (cur === null && a.expiresAt !== null) || // permanent → timeout
      (cur !== null && a.expiresAt !== null && new Date(a.expiresAt) <= cur); // shorter/equal timeout
    if (isDowngrade) return { applied: false, previous, kept: cur === null ? "permanent" : cur.toISOString(), platforms: [] };
  }

  // The account's row and, in the same statement, the same action on every canonical linked to it now.
  // A reduction never lifts a linked identity's own ban: the count of those comes back.
  const { rows: written } = await pool.query<{ kept_identities: string[] }>(BAN_ACCOUNT_SQL,
    [targetId, a.mod, a.reason, a.expiresAt, a.durationMinutes ? "timeout" : "ban", a.durationMinutes, a.batchId, a.covered]);
  const keptIdentities = written[0]?.kept_identities ?? [];

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
  return { applied: true, previous, platforms, keptIdentities };
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
  // A ban or timeout also removes the person's lines of the last 24 hours, as the Purge button does
  // (modPurge.ts purgeWithBan), unless the mod turned the switch off. Run only after every ceiling
  // check; a purge that fails never fails the ban that already stands.
  const purge = banPurges(body);
  // The line the ban was clicked on goes by its id, whatever its age (if it is theirs). One that
  // cannot be removed never stops the ban: it is skipped, and the mod-log row and the answer say so.
  const clicked = clickedLineOf(body);
  const alongside = durationMinutes ? "timeout" : "ban";

  // Canonical target (platform-origin message, no matrix id on the frame): if
  // the canonical is linked to site accounts, the normal site ban of each below;
  // otherwise there is no site.bans row to write (FK → site.users): the
  // canonical's own mod_log row is its standing here (config/canonical-standing.mjs)
  // and the platforms get the same action through the fan-out.
  const canonicalId = canonicalOf(body);

  // Privilege ceiling: a non-admin mod may not ban/timeout the owner or another mod,
  // whether named by matrix id or by a linked platform canonical. Checked on
  // the raw target before any state changes.
  const guardTarget = targetId ?? canonicalId;
  if (guardTarget) {
    const denied = await assertCanModerate(mod, guardTarget);
    if (denied) return denied;
  }
  if (targetId) {
    // A failed read is not "no account": it answers 503 (try again), never a false refusal.
    const member = await isSiteAccount(targetId).catch(() => null);
    if (member === null) return unavailable();
    if (!member) return new Response(NOT_A_MEMBER, { status: 404 });
  }

  // Groups this action's mod-log rows with its platform rows, so the mod who acted can read back
  // how each platform answered (the status line after the action, the ✗ on history rows).
  const batchId = randomUUID();

  let targets: string[] = targetId ? [targetId] : [];
  if (!targetId && canonicalId) {
    try { targets = await linkedAccounts(canonicalId); } catch { return unavailable(); }
    if (targets.length === 0) {
      // This row IS the chatter's standing (config/canonical-standing.mjs): a failed write throws.
      await pool.query(CANONICAL_ACTION_SQL,
        [durationMinutes ? "timeout" : "ban", canonicalId, mod, durationMinutes, expiresAt, reason, batchId]);
      const platforms = fanOutBan(mod, canonicalId, durationMinutes, reason, batchId);
      // Their lines leave the site now, not when the platform's own ban echoes back.
      await pushChatBan(chatBanBody({ matrixIds: [], canonicalId, expiresAt, lift: false }));
      const noAccounts: string[] = [];
      const { purged, purgeFailed } = purge ? await purgeWithBan(purgeDeps(mod, canonicalId), { targetId: canonicalId, accounts: noAccounts, windowMinutes: PURGE_MAX_MINUTES, batchId, alongside, clicked: clicked === "invalid" ? null : clicked, clickedSkipped: clicked === "invalid" }) : NO_PURGE;
      // No site row to read: what the platforms held before is theirs to know (previous: null).
      return Response.json({ ok: true, applied: true, expiresAt, platformOnly: true, previous: null, batchId, platforms, purged, purgeFailed, clickedSkipped: clicked === "invalid" });
    }
  }
  if (targets.length === 0) {
    return new Response("Bad Request", { status: 400 });
  }

  // Each account's ban, timeout or unban is also written onto the canonicals linked to it: the
  // ceiling covers every one of them (a canonical shared with a moderator's account), before any write.
  for (const account of targets) {
    const denied = await assertCanModerateAccount(mod, account);
    if (denied) return denied;
  }
  // A permanent ban placed above this mod's rank (modUnban.ts) is not theirs to replace: writing
  // over it would make it theirs, and then theirs to lift.
  const above = await banLiftRefusal(mod, { kind: "replace", accounts: targets }, (sql, params) => pool.query(sql, params));
  if (above) return above;
  const action: BanAction = { mod, durationMinutes, expiresAt, reason, override: body.override === true, batchId, covered: targets };
  const results: BanResult[] = [];
  for (const t of targets) results.push(await banAccount(t, action));
  // The panel's answer (Undo's previous ban, a kept longer ban) is the FIRST account's; any account
  // the action reached counts as applied.
  const first = results[0]!;
  if (!results.some((r) => r.applied)) return Response.json({ ok: true, applied: false, kept: first.kept });
  // The accounts the ban reached, pushed to the chat path at once.
  await pushChatBan(chatBanBody({ matrixIds: targets.filter((_, i) => results[i]!.applied), canonicalId, expiresAt, lift: false }));
  // The community reconciler turns the row into a room ban or a timeout in every room.
  await requestReconcile();
  // The purge reaches every account the ban covers (the same expansion as the Purge button's).
  const purgeTarget = targetId ?? canonicalId!;
  const { purged, purgeFailed } = purge ? await purgeWithBan(purgeDeps(mod, purgeTarget), { targetId: purgeTarget, accounts: targets, windowMinutes: PURGE_MAX_MINUTES, batchId, alongside, clicked: clicked === "invalid" ? null : clicked, clickedSkipped: clicked === "invalid" }) : NO_PURGE;
  const platforms = [...new Set(results.flatMap((r) => r.platforms))];
  // A reduction leaves a linked identity's OWN ban standing (only a full Unban lifts it): say how many.
  // Counted once per identity: a canonical shared by two of the accounts is one identity.
  const identitiesKeepBan = new Set(results.flatMap((r) => r.keptIdentities ?? [])).size;
  return Response.json({ ok: true, applied: true, expiresAt, previous: first.previous, batchId, platforms, accounts: targets.length, identitiesKeepBan, purged, purgeFailed, clickedSkipped: clicked === "invalid" });
}

export async function DELETE(req: NextRequest) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const body = await req.json().catch(() => null);
  const targetId = typeof body?.targetId === "string" ? body.targetId : null;

  // Canonical target — mirror of the POST branch: linked → the site unban of every linked
  // account (each lift also unbans the canonicals linked to it); unlinked → an unban row on the
  // canonical and the platform fan-out.
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
      // The unlinked chatter's own standing ban, as an account's (modUnban.ts).
      const above = await banLiftRefusal(mod, { kind: "lift", accounts: [], canonicals: [canonicalId] }, (sql, params) => pool.query(sql, params));
      if (above) return above;
      await pool.query(CANONICAL_ACTION_SQL, ["unban", canonicalId, mod, null, null, null, batchId]);
      const platforms = fanOutUnban(mod, canonicalId, batchId);
      await pushChatBan(chatBanBody({ matrixIds: [], canonicalId, expiresAt: null, lift: true }));
      return Response.json({ ok: true, platformOnly: true, batchId, platforms });
    }
  }
  if (targets.length === 0) {
    return new Response("Bad Request", { status: 400 });
  }

  // Each account's ban, timeout or unban is also written onto the canonicals linked to it: the
  // ceiling covers every one of them (a canonical shared with a moderator's account), before any write.
  for (const account of targets) {
    const denied = await assertCanModerateAccount(mod, account);
    if (denied) return denied;
  }
  // A permanent ban placed above this mod's rank (an admin's, Staff's) needs that rank to lift — the
  // account's and every standing one on its linked canonicals, which the lift unbans too: the ban
  // took a mod's role away, so the ceiling above (the role NOW) would let any mod undo it.
  const above = await banLiftRefusal(mod, { kind: "lift", accounts: targets }, (sql, params) => pool.query(sql, params));
  if (above) return above;
  const platforms = new Set<string>();
  for (const t of targets) {
    // Lifted and recorded in one statement: the reconciler lifts only the room bans the site lifted,
    // and every canonical linked to the account now gets its unban.
    await pool.query(LIFT_BAN_SQL, [t, mod, batchId]);
    await appendModLog({ action: "unban", target: t, by: mod, batchId });
    // Mirror the unban to the platforms so a site unban doesn't leave the
    // person platform-banned. Best-effort, fire-and-forget (see fanOutBan).
    for (const p of fanOutUnban(mod, t, batchId)) platforms.add(p);
  }
  await pushChatBan(chatBanBody({ matrixIds: targets, canonicalId, expiresAt: null, lift: true }));

  await requestReconcile();
  return Response.json({ ok: true, batchId, platforms: [...platforms] });
}
