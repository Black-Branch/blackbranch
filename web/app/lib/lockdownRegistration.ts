// The lockdown's "New signups" lever also closes sign-up on the homeserver. SERVER ONLY.
//
// The lever refuses new SITE accounts (lockdown.ts), but with homeserver sign-up open a raider can
// still make a Matrix account there and walk into the community's rooms and DMs, where a site ban
// does not reach. So while the lever is on, `matrix.registration` is forced closed through the
// host's render (the same path the Admin Panel's switch takes), and when the lever lifts — by a mod,
// by its expiry, or when the stream ends — the value from before is put back.
//
// ONE reconcile, run after every lockdown change and every minute (the lever can lift by itself):
//   • lever on, sign-up open, and THIS lockdown has not closed it yet → write "closed" as the
//     lockdown, ask for a render. "This lockdown" = a lockdown write of "closed" at or after the
//     lever was last switched on (site.lockdown.signups_disabled_at, v157 — set by the same UPDATE
//     that switches it on; never the audit log, which can be missing a row). Unknown (NULL) reads
//     as "not closed yet", so the close is re-asserted. Once it has closed it, a
//     later change by an admin — opening sign-up during the lockdown — is theirs and is kept: the
//     minute check never re-closes it;
//   • lever off, sign-up closed by the lockdown (the row's writer is still the lockdown) → put back
//     the value the lockdown replaced (from site.instance_history), ask for a render;
//   • anything else → nothing. A change an admin made meanwhile is theirs and is never undone.
// A render that did not land — the request could not be dropped, or the host answered it with a
// failure — is RETRIED with backoff (2, 4, 8 … 30 minutes) until the host reports a good render at
// or after the lockdown's last write, and until then the Lockdown screen says "not applied yet".
// Only on a bundle install: a homeserver the bundle does not run is managed outside Black Branch,
// and nothing here can reach it — the Lockdown screen says so.

import pool from "../../lib/db.ts";
import { hostRequestsAvailable, hostResult, requestRenderFor } from "./hostRequests.ts";
import { reloadInstanceConfig } from "./instanceConfigServer.ts";

/** The `updated_by` the lockdown writes under — how a later reconcile knows the value is its own. */
const LOCKDOWN_WRITER = "lockdown";

type Facts = {
  locked: boolean; registration: string | null; by: string | null; before: unknown;
  /** The lockdown has written "closed" since the lever was last switched on. */
  closedThisLockdown: boolean;
  /** When the lockdown last wrote the key (ISO), or null — what a render must be newer than. */
  lastWrite: string | null;
};
/** The pacing of render retries. In memory: the truth (did a render land?) is the host's result. */
type Retry = { attempts: number; nextAt: number };
type Deps = {
  bundle: () => boolean;
  read: () => Promise<Facts>;
  write: (value: "open" | "closed") => Promise<boolean>;
  clear: () => Promise<boolean>;
  render: () => Promise<boolean>;
  /** The host's last answer to a render: ok and when. */
  renderResult: () => Promise<{ ok: boolean; at: string } | null>;
  now: () => number;
  retry: Retry;
};

export type RegistrationState =
  | { managed: "outside" }
  | { managed: "bundle"; registration: "open" | "closed"; closedByLockdown: boolean; applied: boolean };

/** @test-only exported so lockdownRegistration.test.ts runs it against a real Postgres. */
export const READ_SQL = `
  SELECT COALESCE((SELECT signups_disabled FROM site.lockdown_now WHERE id = 1), false) AS locked,
         (SELECT value #>> '{}' FROM site.instance_config WHERE key = 'matrix.registration') AS registration,
         (SELECT updated_by FROM site.instance_config WHERE key = 'matrix.registration') AS by,
         (SELECT old_value FROM site.instance_history
           WHERE key = 'matrix.registration' AND updated_by = $1 AND action = 'set'
           ORDER BY id DESC LIMIT 1) AS before,
         EXISTS (SELECT 1 FROM site.instance_history
           WHERE key = 'matrix.registration' AND updated_by = $1 AND action = 'set' AND new_value #>> '{}' = 'closed'
             AND updated_at >= (SELECT signups_disabled_at FROM site.lockdown WHERE id = 1)) AS closed_this_lockdown,
         (SELECT max(updated_at) FROM site.instance_history
           WHERE key = 'matrix.registration' AND updated_by = $1) AS last_write`;

const G = globalThis as typeof globalThis & { __lockdownRegistrationSync?: boolean; __lockdownRenderRetry?: Retry };
G.__lockdownRenderRetry ??= { attempts: 0, nextAt: 0 };

const realDeps: Deps = {
  bundle: () => hostRequestsAvailable(),
  read: async () => {
    const { rows } = await pool.query(READ_SQL, [LOCKDOWN_WRITER]);
    const r = rows[0] as (Omit<Facts, "closedThisLockdown" | "lastWrite"> & { closed_this_lockdown?: boolean; last_write?: Date | string | null }) | undefined;
    const lw = r?.last_write ?? null;
    return {
      locked: r?.locked === true, registration: r?.registration ?? null, by: r?.by ?? null, before: r?.before ?? null,
      closedThisLockdown: r?.closed_this_lockdown === true,
      lastWrite: lw === null ? null : lw instanceof Date ? lw.toISOString() : String(lw),
    };
  },
  // Through the Admin Panel's own writer (stream-api writes the row and its history), loaded on
  // first use: it brings the sign-in layer with it.
  write: async (value) => {
    const { writeInstanceValue } = await import("./instanceAdminServer");
    if ((await writeInstanceValue("matrix.registration", value, LOCKDOWN_WRITER)).status !== 200) return false;
    await reloadInstanceConfig();
    return true;
  },
  clear: async () => {
    const { clearInstanceValue } = await import("./instanceAdminServer");
    if ((await clearInstanceValue("matrix.registration", LOCKDOWN_WRITER)).status !== 200) return false;
    await reloadInstanceConfig();
    return true;
  },
  render: () => requestRenderFor("matrix.registration"),
  renderResult: () => hostResult("render"),
  now: () => Date.now(),
  retry: G.__lockdownRenderRetry,
};

const closedByLockdown = (f: Facts) => f.by === LOCKDOWN_WRITER && f.registration === "closed";

/** Has the host rendered since the lockdown's last write? True when the lockdown never wrote. */
async function renderApplied(f: Facts, deps: Deps): Promise<boolean> {
  if (!f.lastWrite) return true;
  const r = await deps.renderResult();
  return !!r && r.ok && Date.parse(r.at) >= Date.parse(f.lastWrite);
}

const MINUTE = 60_000;
const MAX_BACKOFF_MIN = 30;

/** A render was just asked for (after a write): the first check is a couple of minutes on. */
function renderAsked(deps: Deps): void {
  deps.retry.attempts = 1;
  deps.retry.nextAt = deps.now() + 2 * MINUTE;
}

/** What the Lockdown screen shows about homeserver sign-up. Reads only. */
export async function lockdownRegistrationState(deps: Deps = realDeps): Promise<RegistrationState> {
  if (!deps.bundle()) return { managed: "outside" };
  const f = await deps.read();
  return {
    managed: "bundle", registration: f.registration === "open" ? "open" : "closed", closedByLockdown: closedByLockdown(f),
    applied: await renderApplied(f, deps).catch(() => false),
  };
}

/** The doctor's fact (config/doctor.mjs `matrix.lockdown`): the same reading as the Lockdown screen,
 *  as raw times, so the doctor judges "applied" itself and can tell "just written" from "stuck". */
export type LockdownDoctorFact =
  | { managed: "outside" }
  | { managed: "bundle"; registration: "open" | "closed"; closedByLockdown: boolean; lastWrite: string | null; render: { ok: boolean; at: string } | null };
export async function lockdownDoctorFact(deps: Deps = realDeps): Promise<LockdownDoctorFact> {
  if (!deps.bundle()) return { managed: "outside" };
  const f = await deps.read();
  const r = await deps.renderResult().catch(() => null);
  return {
    managed: "bundle", registration: f.registration === "open" ? "open" : "closed", closedByLockdown: closedByLockdown(f),
    lastWrite: f.lastWrite, render: r ? { ok: r.ok, at: r.at } : null,
  };
}

/** Bring homeserver sign-up in line with the lever (see the header). Never throws; returns what it did. */
export async function syncLockdownRegistration(deps: Deps = realDeps): Promise<"outside" | "none" | "closed" | "restored" | "retried" | "failed"> {
  try {
    if (!deps.bundle()) return "outside";
    const f = await deps.read();
    if (f.locked && f.registration === "open" && !f.closedThisLockdown) {
      if (!(await deps.write("closed"))) return "failed";
      await deps.render();
      renderAsked(deps);
      return "closed";
    }
    if (!f.locked && closedByLockdown(f)) {
      const before = f.before === "open" || f.before === "closed" ? f.before : null;
      if (!(await (before ? deps.write(before) : deps.clear()))) return "failed";
      await deps.render();
      renderAsked(deps);
      return "restored";
    }
    // Nothing to write. A render the lockdown asked for that never landed is asked for again, on a
    // backoff: 2, 4, 8 … up to 30 minutes apart.
    if (await renderApplied(f, deps)) {
      deps.retry.attempts = 0;
      deps.retry.nextAt = 0;
      return "none";
    }
    if (deps.now() < deps.retry.nextAt) return "none";
    await deps.render();
    deps.retry.attempts += 1;
    deps.retry.nextAt = deps.now() + Math.min(2 ** (deps.retry.attempts - 1), MAX_BACKOFF_MIN) * MINUTE;
    return "retried";
  } catch (e) {
    console.error("[lockdown] homeserver sign-up sync failed:", e instanceof Error ? e.message : e);
    return "failed";
  }
}

const SYNC_MS = 60_000;

/** Boot (instrumentation.ts): the minute reconcile — a lever that lifts by its expiry or at the end
 *  of the stream has nobody to call the route. A bundle install only. */
export function startLockdownRegistrationSync(): void {
  if (G.__lockdownRegistrationSync || !realDeps.bundle()) return;
  G.__lockdownRegistrationSync = true;
  setInterval(() => {
    void syncLockdownRegistration().then((r) => {
      if (r === "closed" || r === "restored") console.warn(`[lockdown] homeserver sign-up ${r === "closed" ? "closed for the lockdown" : "put back after the lockdown"}`);
      if (r === "retried") console.warn("[lockdown] homeserver sign-up: the last render did not land — asked again");
    });
  }, SYNC_MS).unref?.();
}
