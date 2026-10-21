// The ONE writer of subscription state (subscription sources, spec §4; decision D2).
//
// site.subscription_records is written by writeTransition below and by nothing else, and
// writeTransition is reached only from a provider-verified path:
//   (a) a provider event handler, after that provider's verification — in S1, the Stripe webhook
//       through its reconciler (subscriptionSync.ts), which reads the state from Stripe under the
//       viewer's lock;
//   (b) a re-check job, with state just read from the provider (S2, S3);
//   (c) a link callback, with state read from the provider (Patreon OAuth, S2);
//   (d) the owner's manual actions, owner-authenticated and logged (S4);
//   (e) a viewer's own Unlink, which can only detach and so only remove access (S2).
// Nothing a viewer's own request drives grants access. subscriptions/wiring.test.ts pins the
// importers of this file to an allowlist and finds no other writer of the table.
//
// Account deletion (accountDeletion.ts) DELETES the records of services the site does not bill;
// that is the person's data going, not a transition, and it is the one other statement the wiring
// test allows.
//
// TWO entry points, one writer:
//   writeTransition(client, input) — the work, inside a transaction the CALLER holds. The Stripe
//     reconciler opens its own (it already takes the webhook's connection budget, the connection
//     and the viewer's lock before it reads Stripe, and its tests pin that order).
//   applyTransition(input)         — budget, connection, BEGIN, writeTransition, COMMIT, for every
//     later caller that does not already hold a transaction (the S2 drain, link callbacks).
//
// Lock order (stripeCustomer.ts's rule, "a second billing lock takes the viewer lock FIRST"):
// `billing:viewer:<matrixId>` first, then each `billing:record:<provider>:<externalId>` in sorted
// order. Advisory locks are re-entrant within a session, so taking the viewer lock again inside a
// transaction that holds it costs nothing and makes writeTransition safe to call either way.
//
// Injectable-pool factory, the shape and reason of subscriptionSync.ts: a test drives it against a
// real database with its own pool and budget.
import type { Pool, PoolClient } from "pg";
import pool from "../../../lib/db.ts";
import type { createConcurrencyGate } from "../concurrencyGate.ts";
import { entitlementOf, subscriptionSources } from "./entitlement.ts";
import type { Entitlement, NormalStatus, Observation, Provider } from "./types.ts";

export type TransitionInput = {
  via: "webhook" | "recheck" | "link" | "owner";
  /** The verified provider event behind this call, for the audit log. Never a gate: a redelivery
   *  after a committed first attempt still re-runs (step 4 of §4.3). */
  event?: { provider: Provider; id: string; type: string; occurredAt: Date };
  /** Resolved BEFORE the call, from provider-held data. null = one unclaimed record. */
  viewer: string | null;
  /** One or more records of ONE viewer (or exactly one unclaimed record). */
  observations: Observation[];
  /** The sources that count (subscriptions.sources ∩ modules on); a test passes its own. */
  sources?: readonly Provider[];
};

export type RecordRow = {
  id: string; provider: Provider; external_id: string; matrix_id: string | null; account_ref: string | null;
  tier: string | null; status: NormalStatus; provider_status: string; renews: boolean;
  period_end: Date | null; access_until: Date | null; source_event_at: Date;
};

export type TransitionResult = {
  wrote: RecordRow[];
  /** Strictly older than what the record already holds. */
  dropped: Observation[];
  /** Belongs to another viewer — never moved by a transition (unlink + claim only). */
  refused: Observation[];
  /** The viewer's entitlement from the records, computed inside the transaction. */
  before: Entitlement;
  after: Entitlement;
  /** Records that became active (or past_due) for the first time: no row before, or pending. */
  firstActive: RecordRow[];
};

/** A claim found the record's owner changed between its unlocked read and the locks.
 *  @parked withClaimRetry (below) catches it; exported for the S2 Patreon link callback and the
 *  S4 Ko-fi claim, which will tell a lost race from any other failure by it. */
export class OwnerChangedError extends Error {
  readonly provider: Provider;
  readonly externalId: string;
  constructor(provider: Provider, externalId: string) {
    super(`subscription record ${provider}:${externalId} changed owner while it was being claimed`);
    this.name = "OwnerChangedError";
    this.provider = provider;
    this.externalId = externalId;
  }
}

/** A claim whose record changed owner under it retries ONCE, then fails loudly — the bounded
 *  retry of coinsServer.ts's transfer (§4.5). `attempt` re-reads the owner each time.
 *  @parked the S2 Patreon link callback and the S4 Ko-fi claim are its callers; S1 has no claim. */
export async function withClaimRetry<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (e) {
    if (!(e instanceof OwnerChangedError)) throw e;
    console.warn("[subscriptions] claim raced another claim for %s:%s — retrying once", e.provider, e.externalId);
    return attempt();
  }
}

const NONE: Entitlement = { supporter: false, tier: null };
const ENTITLING = new Set<NormalStatus>(["active", "past_due"]);

const COLUMNS = `id::text AS id, provider, external_id, matrix_id, account_ref, tier, status, provider_status, renews,
  period_end, access_until, source_event_at`;

/** The work of one transition, inside the caller's transaction (see the header). Every write to
 *  site.subscription_records in the product is in this function. */
export async function writeTransition(client: PoolClient, input: TransitionInput): Promise<TransitionResult> {
  const { viewer, observations } = input;
  if (viewer === null && observations.length !== 1) {
    throw new Error("an unclaimed transition carries exactly one record");
  }
  const sources = input.sources ?? subscriptionSources();

  // 2. The viewer lock (re-entrant: a caller that holds it already pays nothing).
  if (viewer) await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`billing:viewer:${viewer}`]);
  // 3. Each record lock, sorted, after the viewer's.
  const keys = [...new Set(observations.map((o) => `billing:record:${o.provider}:${o.externalId}`))].sort();
  for (const k of keys) await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [k]);

  // 6 (before). The viewer's entitlement before anything is written.
  const before = viewer ? await entitlementOf(client, viewer, sources) : NONE;

  const wrote: RecordRow[] = [];
  const dropped: Observation[] = [];
  const refused: Observation[] = [];
  const firstActive: RecordRow[] = [];
  for (const o of observations) {
    // 5. The record as it stands, locked for this transaction.
    const cur = (await client.query<RecordRow>(
      `SELECT ${COLUMNS} FROM site.subscription_records WHERE provider = $1 AND external_id = $2 FOR UPDATE`,
      [o.provider, o.externalId])).rows[0];
    if (o.expectOwner !== undefined && (cur?.matrix_id ?? null) !== o.expectOwner) {
      throw new OwnerChangedError(o.provider, o.externalId);
    }
    // Ownership: a record never moves between viewers by a transition. Unclaimed → a viewer is a
    // claim, and is allowed; a viewer → another viewer, or → nobody, is refused here.
    if (cur?.matrix_id && cur.matrix_id !== viewer) {
      console.error("[subscriptions] REFUSED: %s:%s belongs to another viewer; not written (via=%s)", o.provider, o.externalId, input.via);
      refused.push(o);
      continue;
    }
    // Stale: strictly older than the last write. An EQUAL stamp passes — the state was read from
    // the provider under the lock, so it is never older than what the last writer wrote.
    if (cur && new Date(cur.source_event_at).getTime() > o.observedAt.getTime()) {
      console.warn("[subscriptions] dropped out-of-order observation for %s:%s (status=%s stamp=%s)",
        o.provider, o.externalId, o.providerStatus, o.observedAt.toISOString());
      dropped.push(o);
      continue;
    }
    const row = (await client.query<RecordRow>(
      `INSERT INTO site.subscription_records
         (provider, external_id, matrix_id, account_ref, tier, status, provider_status, renews,
          period_end, access_until, source_event_at, last_checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $12::boolean THEN now() END)
       ON CONFLICT (provider, external_id) DO UPDATE SET
         matrix_id       = COALESCE(site.subscription_records.matrix_id, EXCLUDED.matrix_id),
         account_ref     = COALESCE(EXCLUDED.account_ref, site.subscription_records.account_ref),
         tier            = EXCLUDED.tier,
         status          = EXCLUDED.status,
         provider_status = EXCLUDED.provider_status,
         renews          = EXCLUDED.renews,
         period_end      = EXCLUDED.period_end,
         access_until    = EXCLUDED.access_until,
         source_event_at = EXCLUDED.source_event_at,
         last_checked_at = COALESCE(EXCLUDED.last_checked_at, site.subscription_records.last_checked_at),
         updated_at      = now()
       RETURNING ${COLUMNS}`,
      [o.provider, o.externalId, viewer, o.accountRef ?? null, o.tier, o.status, o.providerStatus, o.renews,
        o.periodEnd, o.accessUntil, o.observedAt, input.via === "recheck" || input.via === "link"]
    )).rows[0];
    if (!row) continue; // a mock pool (billingConnections.test.ts) answers nothing
    wrote.push(row);
    if (ENTITLING.has(o.status) && (!cur || cur.status === "pending")) firstActive.push(row);
  }

  // 4. The audit row: never a gate. ON CONFLICT keeps the first receipt and records the latest
  // outcome, so a redelivery re-runs everything above and the log still shows one event.
  if (input.event) {
    const outcome = wrote.length ? "applied" : dropped.length ? "stale" : viewer ? "ignored" : "unclaimed";
    await client.query(
      `INSERT INTO site.subscription_events (provider, event_id, event_type, occurred_at, external_id, applied_at, outcome)
       VALUES ($1, $2, $3, $4, $5, now(), $6)
       ON CONFLICT (provider, event_id) DO UPDATE SET applied_at = now(), outcome = EXCLUDED.outcome`,
      [input.event.provider, input.event.id, input.event.type, input.event.occurredAt,
        observations.length === 1 ? observations[0]!.externalId : null, outcome]);
  }

  // 6 (after).
  const after = viewer ? await entitlementOf(client, viewer, sources) : NONE;
  return { wrote, dropped, refused, before, after, firstActive };
}

/** The external ids of every record of `provider` the viewer holds. A provider adapter re-reads
 *  each one under the viewer's lock, so a record is never left out of an observation just because
 *  the adapter's own listing no longer reaches it (a Stripe customer deleted or unmapped): left out,
 *  it would keep its last state — entitling — for ever. State must never fail open. */
export async function heldRecordIds(client: PoolClient, viewer: string, provider: Provider): Promise<string[]> {
  const { rows } = await client.query<{ external_id: string }>(
    `SELECT external_id FROM site.subscription_records WHERE matrix_id = $1 AND provider = $2`, [viewer, provider]);
  return rows.map((r) => r.external_id);
}

/** @parked consumed by the production binding below and by subscriptions/state.test.ts; exported
 *  so the test can drive a real throwaway pool and its own budget. */
export function createSubscriptionState(deps: { pool: Pool }) {
  /** A whole transition in a transaction of its own (§4.3 steps 1–8). The caller's budget is taken
   *  BEFORE the pool is asked and given back in the same `finally`; a refusal throws holding
   *  nothing. Effects (badge, tier cache, cards) are the caller's, after this resolves, and each is
   *  idempotent (step 9). */
  async function applyTransition(input: TransitionInput & { budget: ReturnType<typeof createConcurrencyGate> }): Promise<TransitionResult> {
    const release = await input.budget.acquire();
    if (!release) throw new Error("subscription connection budget full; the caller retries");
    let client: PoolClient | null = null;
    try {
      client = await deps.pool.connect();
      await client.query("BEGIN");
      const r = await writeTransition(client, input);
      await client.query("COMMIT");
      return r;
    } catch (e) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client?.release();
      release();
    }
  }
  return { applyTransition };
}

const bound = createSubscriptionState({ pool });
/** @parked its callers are S2's (the Patreon inbox drain and link callback); S1's only caller,
 *  the Stripe reconciler, runs writeTransition inside its own transaction. */
export const applyTransition = bound.applyTransition;
