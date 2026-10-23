// Who is entitled, from the subscription records (subscription sources, spec §6; decision D18).
//
// ONE SQL fragment, entitledRecordsSql, used by every SQL reader of site.subscription_records
// outside the writer (state.ts), the viewer's own listing (/api/me) and account deletion's "still
// bills" check — subscriptions/wiring.test.ts finds every reader and holds it to that. A fragment
// with a parameter rather than a view, because the source switch is instance configuration (env OR
// database) and a view cannot see the env layer.
//
//   Supporter = staff, OR any record matching the fragment, OR an unexpired gift (entitlements.ts).
//   Tier      = the highest-ranked matching record's tier (tiers.ts highestTier); a gift gives
//               `supporter`.
//   Sources   = the services that count ∩ the services whose module is on. Turning a service off
//               ends its members' perks at once, and turning it back on restores them: records are
//               kept.
import { paypalModuleOn } from "../paypalClient.ts";
import { stripeModuleOn } from "../stripe.ts";
import { highestTier } from "../tiers.ts";
import type { Entitlement, Provider } from "./types.ts";

/** The services that count by default: the two the site sells itself (D26). The install key
 *  `subscriptions.sources` that narrows or widens this lands with S2, the first slice with a
 *  service that needs mapping before it means anything; until then only Stripe writes records. */
const DEFAULT_SOURCES: readonly Provider[] = ["stripe", "paypal"];

/** The module switch for each service that has one. A service with no switch here is never on. */
const MODULE_ON: Partial<Record<Provider, () => boolean>> = {
  stripe: stripeModuleOn,
  paypal: paypalModuleOn,
};

/** The sources that count right now: DEFAULT_SOURCES ∩ modules on. Read at call time, like every
 *  setting, so a module switched in the Admin Panel applies on the next read. */
export function subscriptionSources(): Provider[] {
  return DEFAULT_SOURCES.filter((p) => MODULE_ON[p]?.() === true);
}

/** The services the site is the merchant for: their records are payment records the deletion
 *  keeps, and a renewing one blocks a deletion (§9, D23). Every other service's records are erased. */
export const BILLED_PROVIDERS: readonly Provider[] = ["stripe", "paypal"];

const IDENT = /^[a-z_][a-z0-9_]*$/;
const PARAM = /^\$\d+$/;

/** The one entitlement predicate over a `site.subscription_records` alias. `sourcesParam` is the
 *  query parameter (`$2`) that carries the sources as a text[] — never a literal list, so the
 *  module switches are read where the query runs. */
export function entitledRecordsSql(alias: string, sourcesParam: string): string {
  if (!IDENT.test(alias) || !PARAM.test(sourcesParam)) throw new Error("entitledRecordsSql: alias and parameter only");
  return `(${alias}.matrix_id IS NOT NULL AND ${alias}.tier IS NOT NULL
    AND ${alias}.status IN ('active', 'past_due')
    AND (${alias}.access_until IS NULL OR ${alias}.access_until > now())
    AND ${alias}.provider = ANY(${sourcesParam}::text[]))`;
}

/** Every viewer a subscription record entitles right now — the badge map's and the badge
 *  re-point's set (gifts are unioned by the caller, as before). `$1` = the sources. */
export const ENTITLED_VIEWERS_SQL =
  `SELECT DISTINCT r.matrix_id FROM site.subscription_records r WHERE ${entitledRecordsSql("r", "$1")}`;

/** Does a subscription record entitle viewer `viewerParam` right now? An EXISTS for one viewer. */
export function viewerEntitledSql(viewerParam: string, sourcesParam: string): string {
  if (!PARAM.test(viewerParam)) throw new Error("viewerEntitledSql: parameter only");
  return `EXISTS (SELECT 1 FROM site.subscription_records r
    WHERE r.matrix_id = ${viewerParam} AND ${entitledRecordsSql("r", sourcesParam)})`;
}

const COLUMN = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

/** Does a subscription record entitle the viewer named by a COLUMN of an outer query
 *  (`u.matrix_id`) right now? The community gift's "not already a Supporter". */
export function columnEntitledSql(column: string, sourcesParam: string): string {
  if (!COLUMN.test(column) || !PARAM.test(sourcesParam)) throw new Error("columnEntitledSql: column and parameter only");
  return `EXISTS (SELECT 1 FROM site.subscription_records r
    WHERE r.matrix_id = ${column} AND ${entitledRecordsSql("r", sourcesParam)})`;
}

/** The end of the period the viewer has paid for, across every entitling record (NULL when none):
 *  a gift to a paying subscriber starts after it, not alongside it. The period end the service
 *  reported, else the record's access end. A Stripe `trialing` record is NOT a paid period (a card
 *  bought during a gift — checkout's trial_end): counted, a gift arriving during the trial would be
 *  parked until the first charge day (design review 2026-10-22). It still entitles. */
export function paidThroughSql(viewerParam: string, sourcesParam: string): string {
  if (!PARAM.test(viewerParam) || !PARAM.test(sourcesParam)) throw new Error("paidThroughSql: parameters only");
  return `(SELECT MAX(COALESCE(r.period_end, r.access_until)) FROM site.subscription_records r
    WHERE r.matrix_id = ${viewerParam} AND ${entitledRecordsSql("r", sourcesParam)}
      AND r.provider_status <> 'trialing')`;
}

/** The tiers a viewer's entitling records give, for highestTier. `$1` viewer, `$2` sources. */
export const VIEWER_TIERS_SQL =
  `SELECT r.tier FROM site.subscription_records r WHERE r.matrix_id = $1 AND ${entitledRecordsSql("r", "$2")}`;

type Queryable = { query: <R extends object>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> };

/** A viewer's entitlement from the records ALONE (no gift, no staff): what the transition function
 *  reports as before/after. Read in the caller's transaction. */
export async function entitlementOf(db: Queryable, viewer: string, sources: readonly Provider[]): Promise<Entitlement> {
  const { rows } = await db.query<{ tier: string | null }>(VIEWER_TIERS_SQL, [viewer, sources]);
  const tier = highestTier(rows.map((r) => r.tier));
  return { supporter: rows.length > 0, tier };
}

/** Is the viewer already a Supporter through a service OTHER than `except`? The record that
 *  makes them one (the latest-ending first), for the subscribe sheet's "you'd be paying twice"
 *  warning and the subscribe routes' 409 `subscribed_elsewhere` (spec §10.1, D24). Through the
 *  fragment, so a service switched off is not "elsewhere". `$1` viewer, `$2` sources. */
export async function entitledElsewhere(db: Queryable, viewer: string, except: Provider, sources: readonly Provider[]): Promise<{ provider: Provider; periodEnd: string | null } | null> {
  const others = sources.filter((p) => p !== except);
  if (!others.length) return null;
  const { rows } = await db.query<{ provider: Provider; period_end: Date | null }>(
    `SELECT r.provider, r.period_end FROM site.subscription_records r
      WHERE r.matrix_id = $1 AND ${entitledRecordsSql("r", "$2")}
      ORDER BY r.period_end DESC NULLS LAST LIMIT 1`,
    [viewer, others]);
  const r = rows[0];
  return r ? { provider: r.provider, periodEnd: r.period_end ? new Date(r.period_end).toISOString() : null } : null;
}

/** A viewer's own records, newest first — the account page's list (/api/me `subscriptions`). Every
 *  record they hold, entitling or not; the status words are the spec's. */
export type ViewerSubscription = {
  provider: Provider; tier: string | null; status: string; renews: boolean;
  periodEnd: string | null; accessUntil: string | null;
};

export async function listViewerSubscriptions(db: Queryable, viewer: string): Promise<ViewerSubscription[]> {
  const { rows } = await db.query<{ provider: Provider; tier: string | null; status: string; renews: boolean; period_end: Date | null; access_until: Date | null }>(
    `SELECT provider, tier, status, renews, period_end, access_until
       FROM site.subscription_records
      WHERE matrix_id = $1
      ORDER BY created_at DESC, id DESC`,
    [viewer]);
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return rows.map((r) => ({
    provider: r.provider, tier: r.tier, status: r.status, renews: r.renews,
    periodEnd: iso(r.period_end), accessUntil: iso(r.access_until),
  }));
}

/** Does a viewer hold a subscription the SITE bills that is still going to charge them? It blocks
 *  their account deletion (§9): a record of a billed service, not ended, still renewing. */
export async function stillBills(db: Queryable, viewer: string): Promise<boolean> {
  const { rows } = await db.query<{ bills: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM site.subscription_records
      WHERE matrix_id = $1 AND provider = ANY($2::text[])
        AND status IN ('pending', 'active', 'past_due', 'paused') AND renews) AS bills`,
    [viewer, BILLED_PROVIDERS]);
  return rows[0]?.bills === true;
}
