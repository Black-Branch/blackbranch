// The words of subscription sources (spec §3, §4.3), shared by the writer (state.ts), the
// entitlement readers (entitlement.ts) and the provider adapters (stripeRecords.ts). Types only.
import type { TierSlug } from "../tiers.ts";

export type Provider = "stripe" | "paypal" | "patreon" | "kofi" | "twitch" | "kick";
/** The spec's §3.3 status words. `active` and `past_due` entitle; the rest never do. */
export type NormalStatus = "pending" | "active" | "past_due" | "paused" | "ended";

/** One subscription's state as the provider holds it now, already mapped by its adapter. */
export type Observation = {
  provider: Provider;
  externalId: string;
  /** A product tier slug, already mapped; null = maps to no tier, which never entitles. */
  tier: TierSlug | null;
  status: NormalStatus;
  /** The service's own word, for display and support. */
  providerStatus: string;
  renews: boolean;
  periodEnd: Date | null;
  /** null = status alone decides; else access stops at this time (§3.4). */
  accessUntil: Date | null;
  accountRef?: string | null;
  /** The ordering stamp (§4.3): strictly older than the record's stamp → dropped as stale. */
  observedAt: Date;
  /** For a claim (S2/S4): the owner the caller read before taking the locks. When given and the
   *  record's owner is no longer that, the call throws OwnerChangedError (state.ts withClaimRetry). */
  expectOwner?: string | null;
};

/** A viewer's entitlement from their records alone (no gift, no staff). */
export type Entitlement = { supporter: boolean; tier: TierSlug | null };
