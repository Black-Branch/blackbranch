"use client";

import { useRouter } from "next/navigation";
import { dispatchClaimable } from "@/app/lib/claimableEvent";
import { CurrencyDollar, Gift, Bell, SealCheck } from "@phosphor-icons/react/dist/ssr";
import PlatformIcon, { PLATFORM_COLORS } from "./PlatformIcon";
import PointsIcon from "./PointsIcon";
import { initials, formatCount, type CommunityStatus } from "@/app/lib/streamView";
import { currencyTitle } from "@/app/lib/currency";
import { type Vod } from "@/app/lib/vods";
import { Bar } from "@/app/components/chrome";
import { siteName } from "@/app/lib/siteName";
import { usePlayerFallbacks } from "@/app/lib/plugins/player";
import type { PlayerState } from "@/app/lib/playerSource";

/** Three 30px circles in flow, 6px gaps (the actions row's own `gap-1.5`); a
 *  hovered or focused one grows IN FLOW to its labelled pill, the others
 *  shift left, the title truncates to pay for it — the buttons never overlap.
 *  Resting geometry: `pad` + 13 (the icon every caller renders) + `pad` = 28
 *  wide, 28 tall, icon centred — 7.5 + 13 + 7.5 for every circle (no gloss,
 *  no border anywhere). No `gap-`
 *  inside this template: a gap sits
 *  between the icon and the label span, which is a real flex item even at
 *  zero width, so `gap-1.5` here would add 6px to every RESTING circle. The
 *  icon-to-label spacing lives inside the label's own clip instead
 *  (moneyLabel). */
// One flat shape for all four — 28px, no gloss, no border, the shared press
// dip; `money-hit` gives touch a 44px-tall tap area that reaches only half-way
// into the 6px gap (globals.css), so two neighbours' areas meet but never
// overlap.
const moneyCircle = (skin: string) =>
  `group/money relative inline-flex items-center justify-center h-[28px] min-w-[28px] rounded-full font-semibold text-xs whitespace-nowrap shrink-0 money-hit transition-[filter,transform] duration-(--anim-fast) active:scale-[.92] ${skin}`;
/** The clip: zero-width at rest, and the hovered/focused circle's label unrolls
 *  out of it as the circle itself grows in flow. `max-w-[7rem]` (112px) is the
 *  cap the label unrolls into — it must clear the widest label ("Subscribe",
 *  9 chars) at `text-xs font-semibold` plus the label's own `pl-1.5` (6px);
 *  112px comfortably clears that against every 30px circle's icon-plus-pad. */
const moneyClip =
  "max-w-0 overflow-hidden opacity-0 transition-[max-width,opacity] duration-(--anim-default) group-hover/money:max-w-[7rem] group-hover/money:opacity-100 group-focus-visible/money:max-w-[7rem] group-focus-visible/money:opacity-100";
/** The word, INSIDE that clip — which is where its `pl-1.5` spacing has to be.
 *  Padding on the clip itself would survive `max-w-0` (border-box floors the
 *  CONTENT box at zero, never the padding) and put those 6px back into every
 *  resting circle; clipped, it contributes nothing until the label unrolls. */
const moneyLabel = "block pl-1.5";

/** The YouTube glyph on the featured "Visit channel" circle — unchanged path data, just no longer inline. */
function YoutubeGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor">
      <path d="M12.7 3.8a1.6 1.6 0 0 0-1.1-1.1C10.5 2.4 6.5 2.4 6.5 2.4s-4 0-5.1.3A1.6 1.6 0 0 0 .3 3.8C0 4.9 0 6.5 0 6.5s0 1.6.3 2.7a1.6 1.6 0 0 0 1.1 1.1c1.1.3 5.1.3 5.1.3s4 0 5.1-.3a1.6 1.6 0 0 0 1.1-1.1c.3-1.1.3-2.7.3-2.7s0-1.6-.3-2.7zM5.2 8.4V4.6l3.4 1.9-3.4 1.9z" />
    </svg>
  );
}

type StreamMetaBarProps = {
  /** Desktop auto-hide (theatre / compact): parked past the bottom edge, revealed on proximity. */
  overlay: boolean;
  /** Out of the flow (mobile compact). Never the keyboard — see barVisibility.ts. */
  hidden: boolean;
  live: boolean;
  community: CommunityStatus | null;
  tab: PlayerState["tab"];
  streamerAvatar: string | null;
  /** The streamer's display name (instance key streamer.displayName, from the server render);
   *  "" when the install has none, and the bar then shows the site's name alone. */
  streamerName: string;
  pfpFailed: boolean;
  setPfpFailed: (v: boolean) => void;
  streamTitle: string;
  selectedVod: Vod | null;
  followerCount: number | null;
  liveViewers: number | null;
  subscribed: boolean;
  openSupport: (section: "donation" | "subscribe", fallbackUrl: string) => void;
  /** null = this install has nowhere to donate (no provider, no outside link): no button. */
  donateUrl: string | null;
  /** null = this install has nowhere to subscribe (no Stripe, no outside link): no button. */
  subscribeUrl: string | null;
};

// The player's bottom Bar — ONE ROW, always: avatar · title (truncates) · meta
// line (truncates) · the currency / Donate / Gift actions. A second row would be
// dead space, and would keep the two panels' bottom bars from lining up.
//
// The support meter is not on this bar: `stream-api/meter.js` broadcasts
// `meterState` for OBS `meter.html`; this bar does not consume the frame.
//
// Width behaviour: the money actions are three 30px circles in a
// normal in-flow flex row (gap-1.5, shrink-0) — there is no fixed box and no
// absolute positioning. The title block gets every other pixel in the row
// (flex-1, min-w-0) and truncates. A hovered or focused circle grows IN FLOW
// into its labelled pill: the circles to its left shift left to make room,
// and the title yields the space by truncating further — a grown circle
// never overlays its neighbour.
//
// Colours come from the viewer (settingsRegistry donateColor/giftColor), with
// inkOn() picking a readable label: --color-on-accent is a fixed near-black, so
// a viewer choosing a dark fill would otherwise get an unreadable button.
export function StreamMetaBar({
  overlay, hidden, live, community, tab, streamerAvatar, streamerName, pfpFailed, setPfpFailed, streamTitle,
  selectedVod, followerCount, liveViewers, subscribed, openSupport, donateUrl, subscribeUrl,
}: StreamMetaBarProps) {
  const router = useRouter();

  // The community block keys on the SELECTED source, not on the streamer being offline:
  // the status endpoint never supplies a community while they are live, so for that
  // case the two are the same — but gating on `!live` put the featured
  // streamer's avatar and "Visit Channel" under a fallback's title.
  const onCommunity = tab === "community";
  const { fallbackFor } = usePlayerFallbacks();
  const fallback = fallbackFor(tab);
  const featured = onCommunity && community ? community : null;
  // The fallback playlist: Community is selected and nobody is live.
  const playlist = onCommunity && !community;

  const homeTitle = streamerName ? `${streamerName} · ${siteName()}` : siteName();
  const title =
    fallback ? fallback.title
    : tab === "replay" ? (selectedVod?.title ?? homeTitle)
    : featured ? (featured.stream_title || featured.display_name)
    : playlist ? "Community playlist"
    : live && streamTitle ? streamTitle
    : homeTitle;

  return (
    <Bar
      slot="bottom"
      name="video-bottom"
      overlay={overlay}
      hidden={hidden}
      background={overlay ? "var(--glass-bg)" : "var(--panel-bar-bg)"}
      center={
        <div className="flex items-center gap-3 min-w-0 w-full h-full">
          {featured ? (
            featured.avatar_url ? (
              <img src={featured.avatar_url} alt={featured.display_name} className="w-8 h-8 rounded-full shrink-0 object-cover" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-red-900/60 flex items-center justify-center text-xs font-bold shrink-0 select-none text-red-200">
                {initials(featured.display_name)}
              </div>
            )
          ) : playlist ? (
            <div className="w-8 h-8 rounded-full bg-surface-2 flex items-center justify-center shrink-0 text-body-dim" aria-hidden="true">
              <PlatformIcon platform="community" size={16} />
            </div>
          ) : streamerAvatar && !pfpFailed ? (
            <img src={streamerAvatar} alt={streamerName} className="w-8 h-8 rounded-full shrink-0 object-cover" onError={() => setPfpFailed(true)} />
          ) : (
            <div className="w-8 h-8 rounded-full bg-blue-700 flex items-center justify-center text-xs font-bold shrink-0 select-none">
              {initials(streamerName || siteName())}
            </div>
          )}

          {/* The block that GIVES: every pixel the fixed-width actions box
              doesn't take. min-w-0 lets it shrink below its content. */}
          <div className="flex-1 min-w-0">
            <div
              className="font-semibold leading-tight truncate text-heading"
              style={{ fontFamily: "var(--shell-font, inherit)", fontSize: "var(--title-size, 0.875rem)" }}
            >
              {title}
            </div>
            {/* A BLOCK box with inline children, not a flex row. `truncate` is
                overflow+text-overflow+nowrap, and `text-overflow: ellipsis` only
                acts on a block container's OWN inline content — on a flex box it
                is inert, and the line would hard-clip mid-glyph. The spacing is
                `mr-1.5` on each child but the last, and the seal renders
                inline-block (align-[-2px] puts it back on the text baseline). */}
            <div className="mt-0.5 text-xs text-secondary whitespace-nowrap truncate">
              {featured ? (
                <span className="font-semibold text-body mr-1.5">{featured.display_name}</span>
              ) : playlist ? (
                <span className="font-semibold text-body mr-1.5">Community</span>
              ) : (
                <>
                  <span className="font-semibold text-body mr-1.5">{streamerName || siteName()}</span>
                  <SealCheck size={13} weight="fill" color="#7dd9a8" className="inline-block align-[-2px] mr-1.5" />
                  <span className="mr-1.5">· {followerCount !== null ? formatCount(followerCount) : "—"} followers</span>
                  {live && liveViewers !== null && <span className="mr-1.5">· {formatCount(liveViewers)} watching</span>}
                </>
              )}
            </div>
          </div>

          {/* The money actions: three 30px circles in
              a normal in-flow flex row. Hover or keyboard focus grows ONE
              circle in flow into its labelled pill — the circles to its left
              shift left, and the title block above yields the space by
              truncating further. Phones have no hover: circles only, which is
              the compact form. */}
          <div className="flex items-center gap-1.5 shrink-0 h-[28px]">
            {featured ? (
              // A featured entry from Twitch alone has no YouTube channel to visit: its Twitch one.
              <a
                href={featured.youtube_channel_id
                  ? `https://youtube.com/channel/${featured.youtube_channel_id}`
                  : `https://twitch.tv/${encodeURIComponent(featured.twitch_login ?? "")}`}
                target="_blank"
                rel="noopener noreferrer"
                className={moneyCircle("px-[7.5px] text-on-accent hover:brightness-110")}
                style={{ backgroundColor: featured.youtube_channel_id ? PLATFORM_COLORS.youtube : PLATFORM_COLORS.twitch }}
                title="Visit channel"
                aria-label="Visit channel"
              >
                {featured.youtube_channel_id ? <YoutubeGlyph /> : <PlatformIcon platform="twitch" size="13px" />}
                <span className={moneyClip}><span className={moneyLabel}>Visit channel</span></span>
              </a>
            ) : (
              <>
                <button
                  type="button"
                  // Claimable: signed out there is no store host
                  // (UserMenu withholds the handler without a matrixId), and the
                  // plain dispatch this replaces went to nobody — a dead click on
                  // a money surface. Unclaimed → sign in first; `push`, so Back
                  // returns to the stream.
                  onClick={() => { if (!dispatchClaimable("bb:open-store", { tab: "topup" })) router.push("/auth/signin"); }}
                  title={`${currencyTitle()} store`}
                  aria-label={`${currencyTitle()} store`}
                  className={moneyCircle("px-[7.5px] bg-surface-2 text-body-dim hover:text-strong hover:bg-surface-3")}
                >
                  <PointsIcon size={13} />
                  <span className={moneyClip}><span className={moneyLabel}>{currencyTitle()}</span></span>
                </button>
                {donateUrl !== null && <button
                  type="button"
                  onClick={() => openSupport("donation", donateUrl)}
                  title="Donate"
                  aria-label="Donate"
                  className={moneyCircle("px-[7.5px] hover:brightness-110")}
                  style={{ backgroundColor: "var(--donate-color)", color: "var(--donate-ink, var(--color-on-accent))" }}
                >
                  <CurrencyDollar size={13} weight="bold" />
                  <span className={moneyClip}><span className={moneyLabel}>Donate</span></span>
                </button>}
                {subscribeUrl !== null && <button
                  type="button"
                  onClick={() => openSupport("subscribe", subscribeUrl)}
                  title={subscribed ? "Gift Supporter to someone" : "Become a Supporter"}
                  aria-label={subscribed ? "Gift" : "Subscribe"}
                  className={moneyCircle("px-[7.5px] hover:brightness-110")}
                  // The LABEL tracks subscription; the COLOUR does not (a hue
                  // readout the viewer couldn't theme, in Twitch's brand purple).
                  style={{ backgroundColor: "var(--gift-color)", color: "var(--gift-ink, var(--color-on-accent))" }}
                >
                  {subscribed ? <Gift size={13} weight="bold" /> : <Bell size={13} weight="bold" />}
                  <span className={moneyClip}><span className={moneyLabel}>{subscribed ? "Gift" : "Subscribe"}</span></span>
                </button>}
              </>
            )}
          </div>
        </div>
      }
    />
  );
}
