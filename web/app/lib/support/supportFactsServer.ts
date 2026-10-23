// What the help desk may promise on this install — the server half of setSupportFacts (flows.ts).
// SERVER ONLY. Read by the stream page on every render, so each stream-api read is cached for
// CACHE_MS, one request at a time, with a short timeout; a failed read keeps the last answer.
//
// The canned answers must not describe a setup (a coin store, read-aloud, a subscription) on an
// install that has none of it, nor send the free-text question to an AI that is not there — held
// 30 s, then "I can't reach my brain". Each fact below gates the answers that depend on it.
//
//   purchasable    points can be bought: the `currency.purchasable` switch AND a payment provider
//   subscriptions  a subscription is for sale through EITHER provider: a usable Stripe Supporter
//                  price or a PayPal plan PayPal prices (supporterPrice.ts subscriptionOffer)
//   tts            stream-api speaks: GET /tts/status (contract 2) → enabled && keySet && voiceSet;
//                  before that route exists (404), the saved `tts.enabled` switch
//   freeText       a typed question gets an AI answer: GET /bot/support/status → { aiFreeText }
//                  before that route exists, the saved
//                  `helpdesk.enabled` switch

import { streamApiFetch } from "../streamApi.ts";
import { instanceBool } from "../instanceConfigServer.ts";
import { stripeConfigured } from "../stripe.ts";
import { paypalConfigured } from "../paypalClient.ts";
import { subscriptionOffer } from "../supporterPrice.ts";
import type { SupportFacts } from "./flows.ts";

const CACHE_MS = 30_000;
const TIMEOUT_MS = 1_500;
/** stream-api's answer for the help desk (agent D). */
const SUPPORT_STATUS_PATH = "/bot/support/status";
const TTS_STATUS_PATH = "/tts/status";

type Probe = { ok: boolean; status: number; json: () => Promise<unknown> };
type Deps = {
  fetch: (path: string) => Promise<Probe>;
  bool: (key: string) => boolean;
  providerOn: () => boolean;
  subscriptions: () => Promise<boolean>;
  now: () => number;
};

const realDeps: Deps = {
  fetch: (path) => streamApiFetch(path, { cache: "no-store" }, TIMEOUT_MS),
  bool: instanceBool,
  providerOn: () => stripeConfigured() || paypalConfigured(),
  subscriptions: async () => (await subscriptionOffer()) !== null,
  now: () => Date.now(),
};

/** The flag from stream-api, or null when it has no such route yet / did not answer. */
async function readFlag(deps: Deps, path: string, pick: (j: Record<string, unknown>) => unknown): Promise<boolean | null> {
  try {
    const res = await deps.fetch(path);
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown> | null;
    const v = j && typeof j === "object" ? pick(j) : undefined;
    return typeof v === "boolean" ? v : null;
  } catch {
    return null;
  }
}

/** @test-only the factory takes stub deps; production uses supportFacts() below. */
export function createSupportFacts(deps: Deps = realDeps) {
  let remote: { at: number; tts: boolean | null; freeText: boolean | null } | null = null;
  let inflight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    const [tts, freeText] = await Promise.all([
      readFlag(deps, TTS_STATUS_PATH, (j) => (typeof j.enabled === "boolean" ? j.enabled === true && j.keySet === true && j.voiceSet === true : undefined)),
      readFlag(deps, SUPPORT_STATUS_PATH, (j) => j.aiFreeText),
    ]);
    // A failed read keeps the last answer; a first failure falls back to the saved switches.
    remote = { at: deps.now(), tts: tts ?? remote?.tts ?? null, freeText: freeText ?? remote?.freeText ?? null };
  }

  return async function supportFacts(): Promise<Omit<SupportFacts, "off">> {
    if (!remote || deps.now() - remote.at >= CACHE_MS) {
      inflight ??= refresh().finally(() => { inflight = null; });
      await inflight;
    }
    const subscriptions = await deps.subscriptions().catch(() => false);
    return {
      purchasable: deps.bool("currency.purchasable") && deps.providerOn(),
      subscriptions,
      tts: remote?.tts ?? deps.bool("tts.enabled"),
      freeText: remote?.freeText ?? deps.bool("helpdesk.enabled"),
    };
  };
}

const G = globalThis as typeof globalThis & { __supportFacts?: () => Promise<Omit<SupportFacts, "off">> };
/** The help desk's facts for this install (see the header). Never throws. */
export function supportFacts(): Promise<Omit<SupportFacts, "off">> {
  return (G.__supportFacts ??= createSupportFacts())();
}
