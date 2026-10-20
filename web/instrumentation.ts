// Next.js runtime instrumentation. Runs once when the server starts.
// Hosts the process-lifetime singletons (Node runtime only — they touch the pg
// pool, which can't load on the edge runtime): the hourly gift-subscription
// expiry sweep, the Twitch automod EventSub client, and the blocklist override
// refresher.
//
// Anything started here is INVISIBLE to a dead-code scan scoped to `app/` —
// these are dynamic imports from the project root, so the whole layer reads as
// "exported but never referenced". Do not delete on that evidence alone.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // FIRST, before anything else boots: every request from here on carries its socket address,
    // written by the server, for the per-address rate limits (rateLimit.ts ipKey, ipKeyPeer.ts).
    const { installPeerStamp } = await import("@/app/lib/ipKeyPeer");
    installPeerStamp();
    // The install values FIRST: the site's name, origins, Matrix client and the rest are read from
    // this process's environment here, once, before any module that shows them runs —
    // app/lib/installValues.ts says why nothing is built in. A required one missing or a
    // malformed one is fatal.
    // There is no "built for another install" check, and that is not an omission: nothing is
    // inlined at build, so there is nothing for the environment to disagree with.
    const { publishInstallValues } = await import("@/app/lib/installValuesServer");
    const installProblems = publishInstallValues();
    if (installProblems.length) {
      for (const p of installProblems) console.error(`[boot] FATAL: ${p}`);
      process.exit(1);
    }
    // Boot-time check: STREAM_API_URL has no default (streamApi.ts), so a
    // server started without it would serve pages while every chat send,
    // sticker and celebration failed. Refuse to start instead — loudly.
    // An EXIT, not a throw: a throw here makes Next log "Failed to prepare
    // server" and keep the process alive — a unit systemd reports as active
    // while it serves nothing. Only an exit is a failed unit.
    const { streamApiBase } = await import("@/app/lib/streamApi");
    try {
      streamApiBase();
    } catch (e) {
      console.error(`[boot] FATAL: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    // The instance settings layer: the first load of the stored layer.
    const { startInstanceConfig } = await import("@/app/lib/instanceConfigServer");
    await startInstanceConfig();
    // F-AUTHURL: next-auth's own URL from the site's one origin when the env names none (it reads
    // process.env per request, so setting it here, before the first request, covers every route).
    const { applyAuthUrl } = await import("@/app/lib/authUrl");
    const authSource = applyAuthUrl(process.env);
    console.log(`[boot] sign-in URL ${process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? "(none)"} (from ${authSource === "env" ? "the env" : authSource})`);
    // The legal page's operator values are the operator's to supply (identity sweep): say which
    // are missing, once. Not fatal — the page shows a "not set" marker for each.
    const { legalMissing } = await import("@/app/lib/legal");
    const missing = legalMissing();
    if (missing.length) console.warn(`[boot] legal page: ${missing.join(", ")} not set — /legal and /about show "not set" in their place`);
    // The product's store for a fresh install: fills only what is missing — on an install that has
    // its prices it runs two SELECTs and writes nothing. Never fatal: a store that cannot price
    // answers 503 price_unavailable, which is loud on its own.
    const { storePricing } = await import("@/app/lib/storePricingServer");
    storePricing.seedIfEmpty()
      .then((r) => { if (r.e || r.items) console.log(`[store-prices] fresh install: seeded ${r.items} product item(s)${r.e ? " and E" : ""}`); })
      .catch((e) => console.error(`[store-prices] seed check failed: ${e instanceof Error ? e.message : String(e)}`));
    const { startGiftExpirySweep } = await import("@/app/lib/giftServer");
    startGiftExpirySweep();
    const { startAutomodEventSub } = await import("@/app/lib/automodEventSub");
    startAutomodEventSub();
    // Keeps the mod-curated blocklist re-grades (migrate-v87) current in this
    // process. Until its first successful load the SHIPPED list is in force,
    // which is the strict end — a filter that fails open is the bad outcome.
    const { startBlocklistOverrideRefresh } = await import("@/app/lib/blocklistOverrides");
    startBlocklistOverrideRefresh();
    // The lockdown's signups lever closes homeserver sign-up on a bundle install; this puts it back
    // when a lever lifts by its expiry or at the end of the stream (lockdownRegistration.ts).
    const { startLockdownRegistrationSync } = await import("@/app/lib/lockdownRegistration");
    startLockdownRegistrationSync();
    // Error reports go after their retention (the legal page says so) even on a quiet install,
    // whose reports never reach the route's every-50th prune: once a day, from a minute after boot.
    const { startClientErrorPrune } = await import("@/app/lib/clientErrorPrune");
    startClientErrorPrune();
  }
}
