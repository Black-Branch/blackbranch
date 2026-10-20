import pool from "@/lib/db";
import { requireMod } from "@/app/lib/admin";
import { appendModLog } from "@/app/lib/modlog";
import { NextRequest } from "next/server";
import { INGEST_PLATFORMS } from "@/app/lib/lockdownLevers";
import { lockdownRegistrationState, syncLockdownRegistration } from "@/app/lib/lockdownRegistration";

// The raid panic switch. See app/lib/lockdown.ts for the gate
// this drives and why it never touches existing accounts.
//
// Mod-gated on BOTH verbs, read included. "Are signups currently closed?" is
// operational information a raider would like to have — it tells them whether
// their account-minting has been noticed yet, and therefore whether to burn
// the identities they still hold. The signin page learns the state the only
// way it needs to: by being refused.

export async function GET() {
  const actor = await requireMod();
  if (typeof actor !== "string") return actor;

  // site.lockdown_now (v147): every lever reads off once the expiry has passed — the same view
  // every gate reads, so the panel can never show a lever the gates no longer apply.
  const { rows } = await pool.query<{
    signups_disabled: boolean; crosspost_disabled: boolean; min_account_age_days: number;
    ingest_paused: string[]; sub_only: boolean; expires_at: string | null; expired: boolean;
    reason: string | null; updated_by: string | null; updated_at: string; until_stream: string | null; live: boolean;
  }>(
    `SELECT signups_disabled, crosspost_disabled, min_account_age_days, ingest_paused, sub_only,
            expires_at, expired, reason, updated_by, updated_at, until_stream,
            EXISTS (SELECT 1 FROM stream.sessions WHERE ended_at IS NULL) AS live
       FROM site.lockdown_now WHERE id = 1`
  );
  const r = rows[0];
  // Homeserver sign-up, which the signups lever also closes on a bundle (lockdownRegistration.ts).
  const homeserver = await lockdownRegistrationState().catch(() => null);
  return Response.json({
    signupsDisabled: r?.signups_disabled ?? false,
    crosspostDisabled: r?.crosspost_disabled ?? false,
    minAccountAgeDays: r?.min_account_age_days ?? 0,
    ingestPaused: r?.ingest_paused ?? [],
    subOnly: r?.sub_only ?? false,
    expiresAt: r?.expires_at ?? null,
    expired: r?.expired ?? false,
    // v148: the levers lift when the stream that was live ends; `live` says whether one is now.
    untilStreamEnd: !!r?.until_stream && !r?.expired,
    live: r?.live ?? false,
    reason: r?.reason ?? null,
    updatedBy: r?.updated_by ?? null,
    updatedAt: r?.updated_at ?? null,
    homeserver,
  });
}

type Logged = "signups_disabled" | "signups_enabled" | "crosspost_disabled" | "crosspost_enabled" | "min_account_age_set"
  | "ingest_paused_set" | "sub_only_enabled" | "sub_only_disabled" | "lockdown_expiry_set" | "lockdown_reason_set";

// POST { signupsDisabled?, crosspostDisabled?, minAccountAgeDays?, ingestPaused?: string[],
//        subOnly?, expiresInMinutes?: number | null, untilStreamEnd?: true, reason?: string | null }
//
// Each lever is OPTIONAL and only written when present, so the panel can flip one without having
// to restate the others — and so a stale client can never silently re-open a lever a mod just
// closed. `reason` alone is a valid request: the rule is act fast, explain later, so the panel
// throws a lever first and the reason line appears after. `expiresInMinutes` sets when
// EVERY lever lifts (null = no expiry). On a row whose expiry has already passed, the stored levers
// are stale: they are cleared in the same statement before the request's own levers apply.
export async function POST(req: NextRequest) {
  const actor = await requireMod();
  if (typeof actor !== "string") return actor;

  const body = await req.json().catch(() => ({}));
  const signups = typeof body.signupsDisabled === "boolean" ? body.signupsDisabled : null;
  const crosspost = typeof body.crosspostDisabled === "boolean" ? body.crosspostDisabled : null;
  const subOnly = typeof body.subOnly === "boolean" ? body.subOnly : null;

  // The age lever is a NUMBER, so "omitted" and "off" have to stay distinguishable — `0` is a
  // real, meaningful value (disarmed). Clamped rather than rejected: a nonsense value should
  // disarm, never arm harder than asked.
  let minAge: number | null = null;
  if (body.minAccountAgeDays !== undefined && body.minAccountAgeDays !== null) {
    const n = Number(body.minAccountAgeDays);
    if (!Number.isFinite(n) || n < 0) {
      return Response.json({ error: "minAccountAgeDays must be a non-negative number" }, { status: 400 });
    }
    minAge = Math.min(Math.floor(n), 3650);
  }

  let ingest: string[] | null = null;
  if (body.ingestPaused !== undefined) {
    if (!Array.isArray(body.ingestPaused) || body.ingestPaused.some((p: unknown) => !(INGEST_PLATFORMS as readonly string[]).includes(String(p)))) {
      return Response.json({ error: `ingestPaused must be a list of: ${INGEST_PLATFORMS.join(", ")}` }, { status: 400 });
    }
    ingest = [...new Set(body.ingestPaused.map(String))].sort() as string[];
  }

  // Expiry: minutes from now (1 min … 7 days), or null to clear it. Omitted = unchanged.
  const expirySet = "expiresInMinutes" in body;
  let expiresAt: string | null = null;
  if (expirySet && body.expiresInMinutes !== null) {
    const m = Number(body.expiresInMinutes);
    if (!Number.isFinite(m) || m < 1 || m > 7 * 24 * 60) {
      return Response.json({ error: "expiresInMinutes must be 1 … 10080, or null" }, { status: 400 });
    }
    expiresAt = new Date(Date.now() + Math.floor(m) * 60_000).toISOString();
  }
  // "Until the stream ends": ties the levers to the live stream —
  // refused when none is live. It replaces an expiry; an expiry (or null) replaces it.
  let untilStream: string | null = null;
  const untilSet = body.untilStreamEnd === true;
  if (untilSet) {
    if (expirySet) return Response.json({ error: "untilStreamEnd and expiresInMinutes are exclusive" }, { status: 400 });
    const { rows: live } = await pool.query<{ stream_id: string }>(
      `SELECT stream_id FROM stream.sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`
    );
    if (!live[0]) return Response.json({ error: "no stream is live" }, { status: 409 });
    untilStream = live[0].stream_id;
  }
  const reasonSet = "reason" in body;
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;

  if (signups === null && crosspost === null && minAge === null && ingest === null && subOnly === null && !expirySet && !untilSet && !reasonSet) {
    return Response.json({ error: "a lever, an expiry or a reason is required" }, { status: 400 });
  }

  // UPSERT, not UPDATE alone. An UPDATE against a missing singleton affects zero rows and returns
  // success — the switch would report "thrown" while the row the gates read stays absent, i.e.
  // signups still open during a raid, with the UI insisting otherwise.
  await pool.query(`INSERT INTO site.lockdown (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  // signups_disabled_at (v157): when the signups lever was switched ON — set in this same statement,
  // kept while it stays on (a repeated "on" is not a new lockdown), cleared when it goes off. The
  // homeserver sign-up reconcile (lockdownRegistration.ts) reads it as "this lockdown began",
  // owned by the lever itself rather than by the audit log below.
  await pool.query(
    `UPDATE site.lockdown l SET
       signups_disabled     = COALESCE($1, CASE WHEN x.expired THEN FALSE ELSE l.signups_disabled END),
       signups_disabled_at  = CASE WHEN $1 IS TRUE AND (x.expired OR NOT l.signups_disabled) THEN now()
                                   WHEN $1 IS TRUE THEN COALESCE(l.signups_disabled_at, now())
                                   WHEN $1 IS FALSE OR x.expired THEN NULL
                                   ELSE l.signups_disabled_at END,
       crosspost_disabled   = COALESCE($2, CASE WHEN x.expired THEN FALSE ELSE l.crosspost_disabled END),
       min_account_age_days = COALESCE($3, CASE WHEN x.expired THEN 0 ELSE l.min_account_age_days END),
       ingest_paused        = COALESCE($4::text[], CASE WHEN x.expired THEN '{}'::text[] ELSE l.ingest_paused END),
       sub_only             = COALESCE($5, CASE WHEN x.expired THEN FALSE ELSE l.sub_only END),
       expires_at           = CASE WHEN $6 THEN $7::timestamptz WHEN $11 OR x.expired THEN NULL ELSE l.expires_at END,
       until_stream         = CASE WHEN $11 THEN $12::text WHEN $6 OR x.expired THEN NULL ELSE l.until_stream END,
       reason               = CASE WHEN $8 THEN $9 WHEN x.expired THEN NULL ELSE l.reason END,
       updated_by           = $10,
       updated_at           = now()
     FROM (SELECT expired FROM site.lockdown_now WHERE id = 1) x
     WHERE l.id = 1`,
    [signups, crosspost, minAge, ingest, subOnly, expirySet, expiresAt, reasonSet, reason, actor, untilSet, untilStream]
  );

  // Audit trail: ONE ENTRY PER LEVER ACTUALLY CHANGED — a single "lockdown" row would lose which
  // pipe was closed, and during a post-raid review that is the whole question.
  const logged: { action: Logged; detail: string | null }[] = [];
  if (signups !== null) logged.push({ action: signups ? "signups_disabled" : "signups_enabled", detail: null });
  if (crosspost !== null) logged.push({ action: crosspost ? "crosspost_disabled" : "crosspost_enabled", detail: null });
  if (minAge !== null) logged.push({ action: "min_account_age_set", detail: minAge === 0 ? "min age off" : `min age ${minAge}d` });
  if (ingest !== null) logged.push({ action: "ingest_paused_set", detail: ingest.length ? `paused: ${ingest.join(", ")}` : "ingest open" });
  if (subOnly !== null) logged.push({ action: subOnly ? "sub_only_enabled" : "sub_only_disabled", detail: null });
  if (expirySet) logged.push({ action: "lockdown_expiry_set", detail: expiresAt ? `lifts at ${expiresAt}` : "no expiry" });
  if (untilSet) logged.push({ action: "lockdown_expiry_set", detail: "lifts when the stream ends" });
  if (reasonSet && logged.length === 0) logged.push({ action: "lockdown_reason_set", detail: null });
  for (const { action, detail } of logged) {
    await appendModLog({
      action,
      target: "site",   // site-wide, not a user — see the ModLogEntry union
      by: actor,
      reason: [detail, reason].filter(Boolean).join(" — ") || null,
    }).catch((e) => console.error("[lockdown] mod log failed", e));
  }

  console.warn(`[lockdown] ${logged.map((l) => l.action).join(" + ")} by ${actor}${reason ? ` — ${reason}` : ""}`);
  // The signups lever also closes homeserver sign-up (and puts it back when it lifts): reconciled
  // now, and every minute for a lever that lifts by itself.
  const homeserver = await syncLockdownRegistration();
  return Response.json({ ok: true, homeserver });
}
