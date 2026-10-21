// The legal page's facts for THIS install, gathered from where each one lives. SERVER ONLY.
//
// The page is public and rendered per request, so stream-api is asked at most once per
// ROUTES_MS (the /config snapshot is the module rule's, shared); a failed read keeps the last
// good answer, and before the first one each fact falls back to web's own reading.

import { headers } from "next/headers";
import pool from "@/lib/db";
import { streamApiFetch } from "@/app/lib/streamApi";
import { instanceBool, instanceResolve, instanceString } from "@/app/lib/instanceConfigServer";
import { servingSnapshot, modulesShown } from "@/app/lib/moduleRunningServer";
import { ownerPluginInstalled, pluginPrivacy } from "@/app/lib/plugins/installed";
import { viewerLinkAllowed } from "@/app/lib/viewerLinkPolicy";
import { stripeConfigured } from "@/app/lib/stripe";
import { paypalConfigured } from "@/app/lib/paypalClient";
import { TIERS } from "@/app/lib/tiers";
import { currencyName } from "@/app/lib/currency";
import { hostFile, hostRequestsAvailable } from "@/app/lib/hostRequests";
import { chatPlatformsSetUp } from "@/app/lib/streamPlatformsServer";
import { vodPlaylist } from "@/app/lib/vodPlaylist";
import { INSTANCE_KEYS } from "@/app/lib/instanceSchema.generated.mjs";
import type { AiRoutesSnapshot } from "@/app/lib/aiAdminView";
import { PRUNE_AFTER_DAYS } from "@/app/api/client-error/route";
import { HOMESERVER_DEFAULT_RETENTION_DAYS, HOMESERVER_GENERAL_RETENTION_DAYS } from "./homeserverRetention";
import { legalFactsFrom, type LegalFacts } from "./legalFacts";

const ROUTES_MS = 60_000;
const TIMEOUT_MS = 1_500;

type Cache = { routes: AiRoutesSnapshot | null; at: number; inflight: Promise<void> | null };
const g = globalThis as typeof globalThis & { __legalRoutes?: Cache };
const cache: Cache = (g.__legalRoutes ??= { routes: null, at: 0, inflight: null });

async function aiRoutes(): Promise<AiRoutesSnapshot | null> {
  if (Date.now() - cache.at >= ROUTES_MS) {
    cache.inflight ??= (async () => {
      try {
        const res = await streamApiFetch("/ai/routes", { cache: "no-store" }, TIMEOUT_MS);
        if (res.ok) cache.routes = (await res.json()) as AiRoutesSnapshot;
      } catch { /* keep the last good answer */ }
      cache.at = Date.now();
      cache.inflight = null;
    })();
    await cache.inflight;
  }
  return cache.routes;
}

/** The YouTube use the About page and the legal page describe. */
export async function youtubeUse(): Promise<LegalFacts["youtube"]> {
  const on = (await modulesShown()).youtube === true;
  const oauth = !!(instanceString("youtube.oauthClientId") && instanceString("youtube.oauthClientSecret"));
  return {
    publicData: on && !!instanceString("youtube.apiKey"),
    linking: oauth && viewerLinkAllowed("youtube", { ownerPlugin: ownerPluginInstalled(), youtubeOn: on }),
  };
}

/** Is this request reaching the site through Cloudflare? Its edge adds cf-ray to every request it
 *  forwards; on a bundled install the host also says when its front door is the tunnel. */
async function throughCloudflare(): Promise<boolean> {
  if ((await headers()).get("cf-ray")) return true;
  if (!hostRequestsAvailable()) return false;
  const host = (await hostFile("doctor-host.json").catch(() => null)) as { mode?: unknown } | null;
  return host?.mode === "tunnel";
}

/** Is a news feed switched on? Its items' pictures load from the publisher. A failed read says
 *  yes: naming a service the page does not use is the smaller error. */
async function newsFeedOn(): Promise<boolean> {
  return pool
    .query<{ on: boolean }>(`SELECT EXISTS (SELECT 1 FROM site.rss_feeds WHERE enabled) AS on`)
    .then((r) => r.rows[0]?.on === true, () => true);
}

/** legal.liabilityCapUsd as saved, else the schema's default (its bounds keep it whole dollars). */
function liabilityCapUsd(): number {
  const v = instanceResolve("legal.liabilityCapUsd").value;
  return typeof v === "number" && Number.isFinite(v) ? v : Number(INSTANCE_KEYS.find((k) => k.key === "legal.liabilityCapUsd")?.default);
}

export async function legalFacts(): Promise<LegalFacts> {
  const [cfg, routes, youtube, cloudflare, news] = await Promise.all([
    servingSnapshot(), aiRoutes(), youtubeUse(), throughCloudflare(), newsFeedOn(),
  ]);
  return legalFactsFrom({
    cfg, routes,
    saved: (key) => instanceResolve(key).value,
    botName: instanceString("bot.name"),
    youtube,
    stripe: stripeConfigured(),
    subscriptions: !!TIERS.supporter.priceId,
    paypal: paypalConfigured(),
    pointsPurchase: instanceBool("currency.purchasable"),
    currencyName: currencyName(),
    twitch: chatPlatformsSetUp().twitch,
    liabilityCapUsd: liabilityCapUsd(),
    thirdPartyImages: { vods: !!vodPlaylist(), news },
    cloudflare,
    homeserverRetention: hostRequestsAvailable()
      ? { dms: HOMESERVER_DEFAULT_RETENTION_DAYS, general: HOMESERVER_GENERAL_RETENTION_DAYS }
      : null,
    errorLogDays: PRUNE_AFTER_DAYS,
    plugin: pluginPrivacy(),
  });
}
