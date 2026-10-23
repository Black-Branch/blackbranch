// The About page's feature list — each item only when this install runs what it names: the radio
// and YouTube chat by the module rule (config/modules.mjs "ONE RULE"), the other chat platforms
// when they are set up (streamPlatformsServer.ts chatPlatformsSetUp), payments by the providers
// configured and subscriptions by either provider selling the tier (a Stripe price or a PayPal plan). aboutFeatures.render.test.ts and
// lib/moduleMentions.render.test.ts render it.

import type { ReactNode } from "react";

export type AboutFacts = {
  /** Modules shown on this install, by id (moduleRunningServer.ts modulesShown). */
  shown: Record<string, boolean>;
  /** Card payments (gifts are card-only) and PayPal, as configured. */
  stripe: boolean;
  /** A subscription can be bought: a Stripe price for the tier or a PayPal plan for it
   *  (supporterPrice.ts subscriptionsSetUp). */
  subscriptions: boolean;
  paypal: boolean;
  /** The chat platforms this install is set up to read (streamPlatformsServer.ts). */
  platforms: { twitch: boolean; kick: boolean; streamplace: boolean };
};

const list = (items: readonly string[]) => new Intl.ListFormat("en", { type: "conjunction" }).format(items);

export function AboutFeatures({ siteName, facts }: { siteName: string; facts: AboutFacts }) {
  const platforms = [
    ...(facts.platforms.twitch ? ["Twitch"] : []),
    ...(facts.shown.youtube ? ["YouTube"] : []),
    ...(facts.platforms.kick ? ["Kick"] : []),
    ...(facts.platforms.streamplace ? ["Streamplace"] : []),
  ];
  const processors = [...(facts.stripe ? ["Stripe"] : []), ...(facts.paypal ? ["PayPal"] : [])];
  // Gifts are card checkouts, so they come with Stripe only.
  const paid = facts.stripe
    ? facts.subscriptions ? "optional subscriptions, donations and gifts" : "optional donations and gifts"
    : facts.subscriptions ? "optional subscriptions and donations" : "optional donations";
  return (
    <ul className="my-3 ml-5 list-disc space-y-1.5 text-base leading-relaxed text-secondary marker:text-muted">
      <li>
        <strong className="text-body-dim">Live stream &amp; VODs</strong> — watch live
        {facts.shown.radio
          ? ", catch replays of past broadcasts, or tune into the 24/7 community radio station."
          : " or catch replays of past broadcasts."}
      </li>
      {platforms.length > 0 ? (
        <li>
          <strong className="text-body-dim">Unified chat</strong> — one chat that combines
          messages from {list([...platforms, `${siteName} itself`])}, so the whole audience talks in
          one room regardless of where they watch.
        </li>
      ) : (
        <li>
          <strong className="text-body-dim">Live chat</strong> — {siteName}’s own chat, beside the stream.
        </li>
      )}
      <li>
        <strong className="text-body-dim">Community spaces</strong> — persistent chat
        rooms, forums and direct messages (built on the open Matrix protocol).
      </li>
      {processors.length > 0 && (
        <li>
          <strong className="text-body-dim">Supporter features</strong> — {paid} (processed by{" "}
          {list(processors)}) that unlock badges and perks and support the stream.
        </li>
      )}
    </ul>
  );
}

/** The YouTube uses this install has, for the About page's Google section (shown only where viewers
 *  can link YouTube). Public channel data needs the API key (legalFactsServer.ts youtubeUse); the
 *  linking item is the page's own, passed in. */
export function YoutubeUses({ siteName, publicData, linking }: { siteName: string; publicData: boolean; linking: ReactNode }) {
  return (
    <>
      <p className="my-3 text-base leading-relaxed text-secondary">
        {siteName} uses YouTube API Services {publicData ? "in two ways:" : "for one thing:"}
      </p>
      <ul className="my-3 ml-5 list-disc space-y-1.5 text-base leading-relaxed text-secondary marker:text-muted">
        {publicData && (
          <li>
            <strong className="text-body-dim">Public channel info (no account access)</strong>{" "}
            — the site reads public data about the stream&apos;s own YouTube channel (live
            status, subscriber count, channel avatar) to show what&apos;s happening on the
            home page.
          </li>
        )}
        {linking}
      </ul>
    </>
  );
}
