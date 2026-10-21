"use client";

import { useModIds } from "@/app/lib/modIdentity";
import { CHAT_FONT, chatFontVar, rowBasisCalc } from "@/app/lib/chatFont";
import { memo, useState, useCallback, useMemo, useRef } from "react";
import { renderText } from "@/app/lib/renderText";
import { RedactedText, RedactedQuote, redactedQuoteLabel } from "@/app/components/RedactedText";
import { emoteCrossOrigin, stepDownEmoteUrl, stickerStillUrl } from "@/app/lib/emoteRes";
import { BadgeImg } from "./BadgeImg";
import { useStickerGrow } from "@/app/lib/useStickerGrow";
import { useLongPress } from "@/app/lib/useLongPress";
import { useOutsideClick } from "@/app/lib/useOutsideClick";
import { useExclusiveOpen, claimExclusive } from "@/app/lib/exclusiveOpen";
import { keepFocus, keepFocusCoarse } from "@/app/lib/keepFocus";
import PlatformIcon, { PLATFORM_COLORS } from "@/app/components/PlatformIcon";
import { platformColorVar } from "@/app/lib/platformColors";
import { avatarBg } from "@/app/lib/avatarColor";
import { copyText } from "@/app/lib/clipboard";
import { VOTE_COOLING_TITLE } from "@/app/lib/votePolicy";
import { chatNameColor } from "@/app/lib/chatNameColor";
import type { ChatDirectory } from "@/app/lib/chatDirectory";
import { snippet } from "@/app/lib/textFormat";
import { formatChatTime, type TsFormat } from "@/app/lib/chatTime";
import { useBadges, badgesForMsg } from "@/app/lib/BadgesContext";
import { PronounMark } from "@/app/components/PronounMark";
import PollCard from "@/app/components/PollCard";
import { STICKER_BASE_EM } from "@/app/lib/coins";
import { usernameStyleCSS, usernameStyleAnimClass } from "@/app/lib/usernameStyles";
import { useNameInk } from "@/app/lib/nameInk";
import { useAnimFence } from "@/app/lib/animFence";
import type { EmoteMap } from "@/app/lib/useEmotes";
import { spotlightClickAllowed } from "@/app/lib/chatSpotlight";
import { chatKey } from "@/app/lib/chatSeed";
import { normalizeUsername, type ChatMsg } from "@/app/lib/chatMsg";
import { prefetchUserCard } from "@/app/lib/userCardData";
import { TimeAdded } from "@/app/components/TimeAdded";
import { MessageContextMenu } from "@/app/components/MessageContextMenu";
import { openReportDialog } from "@/app/components/ReportDialog";
import { emitChatNotice } from "@/app/lib/chatNotice";
import { SponsorClockBadge } from "@/app/components/SponsorClockBadge";
import { MarkedBadge } from "@/app/components/MarkedBadge";
import { StickerBoostPopover } from "./StickerBoostPopover";
import { eventBody } from "@/app/components/chatEventBody";
import { NATIVE_PLATFORM, isNativePlatform } from "@/app/lib/nativePlatform";
import { useUndelivered } from "@/app/lib/undeliveredLines";
import { undeliveredLabel } from "@/app/lib/sendDelivery";

// Memoized: list-level renders (appends, queue growth while paused) skip
// untouched rows. Vote/delete updates replace the msg object, so they still
// re-render. Callers must keep callback props referentially stable.
export default memo(function ChatMessage({
  msg,
  emotes,
  onUsernameClick,
  onReply,
  onVote,
  onPin,
  onModDelete,
  onReplyHover,
  onReplyJump,
  onReplyPreview,
  onBoost,
  compact = false,
  showTimestamps = false,
  tsFormat = "standard" as TsFormat,
  stillEmotes = false,
  tick = 0,
  showMatrixName = false,
  selected = false,
  highlight = false,
  own = false,
  maskSwears = false,
  quoteHidden = false,
  firstTag = true,
  directory,
  replyTargetHighlight = false,
  spotlight = false,
  onSpotlight,
}: {
  msg: ChatMsg;
  emotes: EmoteMap;
  onUsernameClick?: (msg: ChatMsg, el: HTMLElement) => void;
  onReply?: (msg: ChatMsg) => void;
  onVote?: (msg: ChatMsg, vote: 1 | -1 | 0) => void;
  /** Mod-only: pin this message to the banner. */
  onPin?: (msg: ChatMsg) => void;
  /** Mod-only: delete this message for everyone. */
  onModDelete?: (msg: ChatMsg) => void;
  /** Called with reply_to_id on hover, null on leave. */
  onReplyHover?: (id: string | number | null) => void;
  /** Click the reply line: jump to the message it answers. Hosts that cannot
   *  scroll to it (the OBS source) leave this out and the line stays text. */
  onReplyJump?: (msg: ChatMsg) => void;
  /** Hover/focus the reply line: show (element) or hide (null) the whole
   *  replied-to message. */
  onReplyPreview?: (msg: ChatMsg, anchor: HTMLElement | null) => void;
  /** Spend `amount` points boosting the sticker rooted at `originalMessageId`.
   *  Throws (HttpError) on failure — the boost popover surfaces the message. */
  onBoost?: (originalMessageId: number, amount: number) => Promise<void>;
  compact?: boolean;
  showTimestamps?: boolean;
  tsFormat?: TsFormat;
  /** "Animated emotes" off (chatStyle_animEmotes): render every emote (and
   *  overlay) at its still-frame URL where one exists. Read once at the list
   *  level (useSetting) and passed down — not subscribed per-row. */
  stillEmotes?: boolean;
  /** Bumped once a minute (only while a "rel" format is in play) so a memoized
   *  "2m ago" row re-renders as time passes. Otherwise unused in the body. */
  tick?: number;
  showMatrixName?: boolean;
  selected?: boolean;
  highlight?: boolean;
  /** Sent by the viewer (any of their identities) — Behavior › Tint my messages. */
  own?: boolean;
  /** Behavior › Hide swear words: mask them in this row's text (read once per list). */
  maskSwears?: boolean;
  /** A reply TO someone the viewer hid: the reply stays, their quoted words do not. */
  quoteHidden?: boolean;
  /** The first-time chatter tag. Off on the OBS overlay: it would go out on stream
   *  with no switch there to turn it off. */
  firstTag?: boolean;
  /** Chat directory, so @mentions render in the mentioned person's colour. */
  directory?: ChatDirectory;
  replyTargetHighlight?: boolean;
  /** The streamer's highlighted message (chatSpotlight.ts): this row wears the
   *  highlight card, for everyone. */
  spotlight?: boolean;
  /** Owner-only: a click on the row picks (or, on the picked row, clears)
   *  the highlight. Absent for everyone else — the row is then not clickable. */
  onSpotlight?: (msg: ChatMsg) => void;
}) {
  // `tick` is a pass-through: its only job is to change once a minute (while a
  // "rel" format is in play) so this memoized row re-renders and recomputes
  // formatChatTime's "now". Nothing here reads its value.
  void tick;
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [pfpFailed, setPfpFailed] = useState(false);
  const [boostPop, setBoostPop] = useState<{ x: number; y: number } | null>(null);

  // Sticker-boost FLIP slide + delayed grow (three interdependent layout effects) —
  // lives in useStickerGrow so it isn't inlined into this already-large component.
  const { rowRef, stickerImgRef, stickerScale } = useStickerGrow(msg);

  // One menu, reached by holding. A long press opens the toolbar — the one the
  // desktop shows on hover — never `ctxMenu` directly, which would stack a
  // second menu on the toolbar the same touch revealed. The toolbar's ⋯ is the
  // only way to the fuller menu on either pointer. The CSS half (the
  // `(hover: hover)` gate on the reveal) stops a plain tap opening anything.
  const [barOpen, setBarOpen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  // The ⋯ that opened the mod menu — its Details item opens the user card anchored there.
  const menuAnchorRef = useRef<HTMLElement | null>(null);
  const closeBar = useCallback(() => setBarOpen(false), []);
  // ONE menu open app-wide — see exclusiveOpen.ts. Dismissal events cannot
  // carry this: a long press swallows its own touchend, so the previously
  // open row never saw a mousedown to close on.
  const owner = useExclusiveOpen(barOpen, closeBar);
  // Claim BEFORE flipping open: any other open row is already closing, and
  // this row cannot tell itself to close because it has not subscribed yet.
  const handleLongPress = useCallback(() => { claimExclusive(owner); setBarOpen(true); }, [owner]);
  const longPress = useLongPress(handleLongPress);
  // Only while open, so 80 mounted rows do not each hold a document listener.
  // The press that OPENED it cannot close it: useLongPress cancels its own
  // touchend once fired, so no synthetic mousedown follows the release.
  //
  // `touch: false`: useOutsideClick's touchstart listener fires on the first
  // touch of a scroll gesture, before the browser knows it is a scroll, so
  // flicking the chat would dismiss the menu. mousedown alone is the right
  // signal on touch too: a tap synthesises one, a scroll does not.
  // (ComposerPopover and ComposerToolsPopover do the same.)
  useOutsideClick(barRef, closeBar, { enabled: barOpen, escape: true, touch: false });

  // Admin-assigned badges for this sender — rendered before the username.
  const badgeState = useBadges();
  const badges = useMemo(() => badgesForMsg(badgeState, msg), [badgeState, msg]);
  // Anyone signed in can report a real line that is not their own — a site account or a
  // platform-only chatter alike (the server finds the author from the message).
  const canReport = !!badgeState.myMatrixId && msg.id != null && /^\d+$/.test(String(msg.id)) && !msg.system && msg.matrixId !== badgeState.myMatrixId;

  // Color bar / dot / icon track the DESTINATION when a site message was routed to
  // a single platform (destPlatform), so it reads as "sent to Twitch" while still
  // being your site message; otherwise the sender's own platform. External-alert
  // events (Ko-fi/Patreon/Streamlabs/etc) are persisted under the site's own platform (like
  // any event card), so the indicator instead tracks the alert's SOURCE platform.
  const barPlatform = msg.system === "alert" ? (msg.alertPlatform ?? msg.platform) : (msg.destPlatform ?? msg.platform);
  const platformColor = platformColorVar(barPlatform);
  // Cross-post cue: the indicator cycles through the site's blue (the message IS
  // native) plus the colors of the platforms it went to — the "Send to: all"
  // set (destPlatforms) or a single routed destination (destPlatform), capped
  // at 5 total (the keyframe families in globals.css). When animations are off
  // (reduced motion or the piCycle toggle) the inline color below shows the
  // first cycle color (the site's blue) instead.
  const destList = (msg.destPlatforms?.length ?? 0) >= 2
    ? msg.destPlatforms!
    : msg.destPlatform && !isNativePlatform(msg.destPlatform) ? [msg.destPlatform] : null;
  const cycleList = destList
    ? [NATIVE_PLATFORM, ...destList.filter((p) => !isNativePlatform(p) && PLATFORM_COLORS[p])].slice(0, 5)
    : null;
  const cycling = cycleList !== null && cycleList.length >= 2;
  const indicatorColor = cycling ? platformColorVar(cycleList[0]!) : platformColor;
  const cycleClass = cycling ? ` chat-pi-cycle-${cycleList.length}` : "";
  const cycleVars = cycling
    ? (Object.fromEntries(
        cycleList.map((p, i) => [`--pi-c${i + 1}`, platformColorVar(p)])
      ) as React.CSSProperties)
    : undefined;
  // The two per-row INFINITE animations (indicator cycle, animated username
  // style) pause while the row is off-screen — see animFence.ts. Hoisted here
  // (not inline in the JSX) so the fence and the span share one derivation.
  const unAnimClass = usernameStyleAnimClass(msg.usernameStyle);
  useAnimFence(rowRef, cycling || unAnimClass !== "");

  // Username tint must follow the sender's OWN platform, never the routing cue; native users carry a
  // validated site colour or a member tint, platform names only their own per-user colour, clamped
  // readable (Twitch-style). One derivation, shared with the terminal's chat: app/lib/chatNameColor.ts.
  // No colour of their own → the viewer's fallback (settings → Colours). The literal equals
  // DEFAULT_NAME_COLOR, so an untouched account sees the default.
  // A moderator's controls act by canonical id; the line carries only its public id, resolved for
  // mods as the row renders (modIdentity.ts) so a control already holds its target when clicked.
  const modIds = useModIds(msg, !!onModDelete);
  // Site lines only: a platform line's id comes from another sequence.
  const undelivered = useUndelivered(isNativePlatform(msg.platform) && !msg.system ? msg.id : null);
  const ownOrMember = chatNameColor(msg);
  const usesFallback = ownOrMember == null;
  const usernameColor = usesFallback ? "var(--chat-fallback-name, #c3cddb)" : ownOrMember;
  const username = showMatrixName && msg.matrixId
    ? normalizeUsername(msg.matrixId)
    : normalizeUsername(msg.username);
  // The side room this name's own glyphs need (see nameInk.ts).
  const nameInkRef = useNameInk(msg.usernameStyle?.font, username);

  // Avatar source: platforms send avatarUrl on the message; native site users
  // don't, but carry a matrixId, so derive their pfp from the Matrix avatar route
  // (same one that powers the settings-button icon).
  const pfpSrc = msg.avatarUrl
    ?? (msg.matrixId ? `/api/avatar/user/${encodeURIComponent(msg.matrixId)}` : null);
  // Avatar fallback (no pfp, or the image 404s): a deterministic colored initial
  // keyed on the username — same scheme UserCard/StreamView use — so the avatar
  // column never collapses to nothing (broken row continuity).
  const avatarInitial = (msg.username || "?").trim().charAt(0).toUpperCase() || "?";
  const avatarFill = avatarBg(msg.username || username);

  // Parse message → segments once. Vote/score/selection/highlight updates change
  // the msg object (forcing a re-render) but not the text, so this skips the
  // emote/URL re-parse on those churny updates. A sticker (coin spend) renders
  // as an ordinary chat line whose body IS the enlarged emote — by decision:
  // no card, just a big emote message. Every other `system` kind (monetization
  // + coin-spend events) renders its generated description via eventBody —
  // see that function for why these no longer get a boxed card.
  // A boost always updates THIS row in place (see stream-api's `sticker_boost`
  // handler) — only meaningful when msg.id is numeric (true for any persisted
  // sticker card, see persistEventCard).
  const boostTargetId = typeof msg.id === "number" ? msg.id : null;

  const body = useMemo(
    () =>
      msg.system === "sticker" && msg.emoteUrl ? (
        <img
          ref={stickerImgRef}
          // Animated emotes off pauses stickers too: the provider's
          // still frame (Twitch / 7TV / BTTV); other hosts keep animating.
          src={stillEmotes ? (stickerStillUrl(msg.emoteUrl) ?? msg.emoteUrl) : msg.emoteUrl}
          crossOrigin={emoteCrossOrigin(msg.emoteUrl ?? "")}
          alt={msg.emoteName ?? "sticker"}
          title={msg.emoteName}
          className="sticker-grow"
          // The stored URL is force-upsized to /4x (stickerResEmoteUrl); not every
          // 7TV emote actually has a 4x render, so that can 404 into a permanently
          // broken sticker. Step the size tier down on error (shared emote ladder) so
          // the sticker still shows instead of a broken-image icon.
          onError={(e) => {
            // A missing STILL falls back to the animated image; any other
            // failure runs the size ladder. Keyed on the failing src being the
            // still, so it can never loop back to it.
            const still = stillEmotes ? stickerStillUrl(msg.emoteUrl ?? "") : undefined;
            if (still && msg.emoteUrl && e.currentTarget.src === still) { e.currentTarget.src = msg.emoteUrl; return; }
            const lower = stepDownEmoteUrl(e.currentTarget.src);
            if (lower) e.currentTarget.src = lower;
          }}
          style={{
            display: "inline-block",
            // EXPLICIT height (not max-height) — deterministic size that scales
            // with the boost, instead of collapsing to the emote's intrinsic 4x
            // pixels (which vary per emote and make max-height inert: it is
            // always larger than natural, so boost growth would do nothing and
            // sizes would be inconsistent). width:auto keeps the aspect ratio
            // from the intrinsic dimensions.
            height: `${STICKER_BASE_EM * stickerScale}em`,
            width: "auto",
            // No width cap (mirrors renderText's oversized-emote override,
            // which also sets maxWidth:none against Tailwind preflight's
            // default img max-width:100%): a heavily-
            // boosted sticker should be allowed to grow past the row's own
            // width rather than being squeezed narrower by an artificial cap.
            maxWidth: "none",
            // Graceful absolute ceiling so a max-boost sticker on a large chat
            // font can't swallow the viewport; width:auto follows it down,
            // preserving aspect ratio (better than the column's overflow clip).
            maxHeight: "min(70vh, 600px)",
            verticalAlign: "middle",
          }}
        />
      ) : msg.system && msg.system !== "poll" ? (
        eventBody(msg, emotes, indicatorColor, maskSwears)
      ) : msg.encrypted && typeof msg.id === "number" ? (
        // Supporter redacted message. `msg.message` carries placeholder glyphs
        // where the hidden parts are — whole or partial — and never the hidden
        // words. RedactedText renders the visible parts through renderText like
        // any message and draws the hidden ones as bars; opened, the plaintext
        // goes through renderText too, so emotes hide and unhide with the words
        // around them.
        //
        // The numeric-id guard is not decorative: an ephemeral card's id is a
        // string, and /api/chat/decrypt keys on the DB row.
        <RedactedText
          key={msg.id}
          text={msg.message}
          messageId={msg.id}
          emotes={emotes}
          msgEmotes={msg.emotes}
          directory={directory}
          stillEmotes={stillEmotes}
          mask={maskSwears}
        />
      ) : (
        renderText(msg.message, emotes, msg.emotes, directory, { still: stillEmotes, mask: maskSwears })
      ),
    [msg, emotes, indicatorColor, stickerScale, stickerImgRef, directory, stillEmotes, maskSwears]
  );

  // Interactive poll card only — every other `system` kind now falls through
  // to the normal row below (all hooks above run unconditionally, so this
  // early return is safe).
  if (msg.system === "poll" && msg.poll) {
    return <PollCard poll={msg.poll} canModerate={!!onModDelete} signedIn={!!badgeState.myMatrixId} />;
  }

  // Row background, one source so the classes never fight: reply-target
  // selection > reply-to-you tint > crowd verdict > event highlight. Negative
  // score fades. Support-type events get a subtle platform-accent tint — it's
  // an inline style since the color is
  // dynamic per-platform, so it only applies when no higher-priority state
  // (selected/reply-target/mod-highlight) is active.
  const score = msg.score ?? 0;
  const isEventRow = !!msg.system && msg.system !== "poll" && msg.system !== "sticker";
  // The highlight card — two ways onto it, one look:
  //   • the purchased highlight (the 50-point product, `system: "highlight"`)
  //   • the streamer's spotlight (chatSpotlight.ts): the message being
  //     answered on stream, picked by a click, shown to everyone
  // The row must VISIBLY stand out — including on the OBS chat overlay, where
  // the page background is fully transparent, so the alpha tint other event
  // rows get (eventBgColor below) composites over nothing and reads as
  // invisible on stream. It borrows the alert overlay's visual language (dark
  // glassy fill, accent ring, top bevel, drop shadow) as a rounded card inset
  // from the column edges. Everything else stays a normal chat message —
  // header, badges, votes, replies, mod tools all render as usual.
  const highlightLook = msg.system === "highlight" || spotlight;
  // The fill is an INLINE style (the accent is the platform color), so it must
  // yield to the class-based selection/reply-target states or a long-pressed
  // card would show no selection at all — same rule as eventBgColor below.
  const highlightCard = highlightLook && !selected && !barOpen && !replyTargetHighlight;
  // A long-pressed row reads as SELECTED and stays that way through scrolling,
  // until the viewer taps away or acts. It reuses the existing `selected`
  // treatment rather than a second "this row is picked" look. Persisting
  // through scroll needs no work — the flag is the row's own state and nothing
  // listens for scroll; what ends it is useOutsideClick (any press elsewhere,
  // or Escape) and the toolbar's own onClick.
  const rowBg = selected || barOpen
    ? "bg-[rgba(165,200,247,0.12)] ring-1 ring-inset ring-[rgba(165,200,247,0.30)]"
    : replyTargetHighlight
    ? "bg-surface-2 ring-1 ring-inset ring-edge-strong"
    // Behavior settings: every tint that applies is added; each is a globals.css
    // class painted only while its switch is on (Mentions of me · Upvoted
    // messages · Tint my messages), and CSS source order decides the winner
    // (mention > upvote > own) — so with Mentions of me off, the upvote/own tint
    // shows instead of nothing. They sit after the alternating stripe so it
    // cannot paint over them.
    : [highlight && "chat-row-mention", !isEventRow && score > 0 && "chat-row-up", own && "chat-row-own"].filter(Boolean).join(" ");
  // `barOpen` joins the higher-priority states here for the same reason they are
  // listed: this is an INLINE style, so it beats rowBg's class and an event row
  // would otherwise show no selection at all when long-pressed.
  const eventBgColor = isEventRow && !highlightLook && !selected && !barOpen && !replyTargetHighlight && !highlight
    ? `color-mix(in srgb, ${indicatorColor} 8%, transparent)`
    : undefined;
  // Downvote fade is gradual (not a hard opacity-60 cutoff) — each downvote
  // point dims a bit more, floored at 0.5 — and crosses the message out once
  // it hits -3, distinct from (and lighter than) a mod delete's strike+dim.
  const downvoteOpacity = score < 0 ? Math.max(0.5, 1 + score * 0.15) : 1;
  const crossedOut = score <= -3;
  const faded = crossedOut ? "line-through chat-msg-fade" : score < 0 ? "chat-msg-fade" : "";
  // Mod-only: a deleted message is struck out + muted (non-mods never receive it).
  const del = msg.deleted ? "line-through opacity-40" : "";
  const canVote = onVote && msg.id != null;

  // The owner's click picks the highlight (chatSpotlight.ts). Not a click on
  // a control inside the row, and not the click that ends a drag-select — the
  // row is full of both, and each keeps its own meaning.
  const onRowClick = onSpotlight
    ? (e: React.MouseEvent) => {
        if (!spotlightClickAllowed(e.target as Element, window.getSelection()?.toString() ?? "")) return;
        onSpotlight(msg);
      }
    : undefined;
  const rowTitle = msg.deleted
    ? "Deleted by a moderator"
    : onSpotlight
    ? (spotlight ? "Click again to clear the highlight" : "Click to highlight this message for everyone")
    : undefined;

  return (
    <div
      ref={rowRef}
      title={rowTitle}
      onClick={onRowClick}
      // The handle a reply jump finds its target by (useReplyJump) — the
      // buffer's own platform:id identity, because ids come from two sequences.
      data-chat-row-key={msg.id != null ? chatKey(msg) : undefined}
      // `compact && !highlightLook`: grouping would hide the header, and a
      // highlight card must always carry its author's name and badges — even
      // right under that user's own previous message.
      className={`group relative pl-3 chat-msg-row hover:bg-surface-1 ${msg.alt ? "chat-msg-alt " : ""}${msg._anim ? "chat-msg-in " : ""}${eventBgColor ? "chat-row-event " : ""}touch-no-select ${compact && !highlightLook ? "chat-compact" : ""} ${highlightLook ? "chat-hl-row " : ""}${onSpotlight ? "cursor-pointer " : ""}${rowBg} ${faded} ${del}`}
      // `--row-dim` + `data-dim`, NOT `opacity` on the row — opacity applies to
      // the whole subtree and dragged the toolbar down with the message. See the
      // `.chat-msg-row[data-dim]` rule in globals.css for the full reason.
      data-dim={!msg.deleted && downvoteOpacity < 1 ? "" : undefined}
      style={{
        paddingTop: "var(--chat-msg-gap, 1px)",
        ...(downvoteOpacity < 1 ? { "--row-dim": downvoteOpacity } as React.CSSProperties : null),
        // Drawn by `.chat-row-event` in globals.css, which Behavior › Support
        // events switches off (a class, so the stripe + hover survive it).
        ["--row-event-bg" as string]: eventBgColor,
        // The card itself is the .chat-hl-card child below — drawn slightly
        // LARGER than the row, over its neighbours, so a highlight never
        // changes the row's size and the chat never shifts.
        ...(highlightCard ? { "--hl-c": indicatorColor } as React.CSSProperties : null),
      }}
      // Only the streamer's spotlight can be hidden by a viewer (Chat rows →
      // Streamer spotlight); a paid /highlight has no such mark.
      data-spot={spotlight && msg.system !== "highlight" ? "" : undefined}
      onMouseEnter={onReplyHover && msg.reply_to_id != null ? () => onReplyHover(msg.reply_to_id!) : undefined}
      onMouseLeave={onReplyHover && msg.reply_to_id != null ? () => onReplyHover(null) : undefined}
      // The row is a plain div, so a tap on the message TEXT blurs the composer
      // and drops the keyboard just like a button press does — the commonest
      // version of the bug, because the text is the biggest target on screen.
      // Coarse-only: on a fine pointer this would take desktop drag-selection
      // with it (see keepFocus.ts). Handlers on the controls below are NOT
      // redundant with this — they must hold on their own, and the bubbling
      // order is not a thing to depend on.
      onMouseDown={keepFocusCoarse}
      {...longPress}
    >
      {highlightCard && <div aria-hidden className="chat-hl-card" />}
      <div
        className={`chat-pi-bar-el absolute left-0${cycleClass}`}
        style={{
          width: "var(--chat-pi-bar-w, 3px)",
          top: "var(--chat-pi-bar-inset, 4px)",
          bottom: "var(--chat-pi-bar-inset, 4px)",
          background: indicatorColor,
          ...cycleVars,
        }}
      />

      {msg.reply_to_username && (() => {
        const line = (
          <>
            <span>↩</span>
            <span
              className={`font-medium shrink-0 text-muted ${highlight ? "chat-reply-me" : ""}`}
            >
              {normalizeUsername(msg.reply_to_username)}
            </span>
            {msg.reply_to_text && !quoteHidden && (
              <span className="truncate">
                {/* A quoted redacted message keeps its bars. */}
                <RedactedQuote text={snippet(msg.reply_to_text)} mask={maskSwears} />
              </span>
            )}
          </>
        );
        const lineClass = "flex items-center gap-1 text-muted truncate mb-0.5 pr-3";
        const lineStyle = { fontSize: "var(--text-chat-xs)" };
        // A BUTTON where the host can jump. That is also what keeps the
        // streamer's click-to-highlight off this click: chatSpotlight's
        // NOT_A_PICK lists `button`. Its text-shadow is restored in globals.css
        // beside the username button's — form controls reset it.
        // A reply to a platform chatter carries no id; the host matches those
        // by author and quoted text (findReplyTarget), so every line is offered.
        // A reply TO someone the viewer hid is a plain line: no jump (their row is
        // not drawn), no hover preview and no spoken quote (both would show their
        // words).
        return onReplyJump && !quoteHidden ? (
          <button
            type="button"
            data-reply-jump
            className={`${lineClass} max-w-full text-left cursor-pointer hover:text-body focus-visible:text-body`}
            style={lineStyle}
            aria-label={`Jump to ${normalizeUsername(msg.reply_to_username)}’s message: ${redactedQuoteLabel(snippet(msg.reply_to_text ?? ""))}`}
            onClick={() => onReplyJump(msg)}
            onMouseEnter={onReplyPreview ? (e) => onReplyPreview(msg, e.currentTarget) : undefined}
            onMouseLeave={onReplyPreview ? () => onReplyPreview(msg, null) : undefined}
            onFocus={onReplyPreview ? (e) => onReplyPreview(msg, e.currentTarget) : undefined}
            onBlur={onReplyPreview ? () => onReplyPreview(msg, null) : undefined}
          >
            {line}
          </button>
        ) : (
          <div className={lineClass} style={lineStyle}>{line}</div>
        );
      })()}

      <div className="chat-msg-body break-words pr-3" style={{ fontSize: CHAT_FONT, lineHeight: "var(--chat-line-height, 1.4)", fontFamily: "var(--chat-font-family, inherit)", fontWeight: "var(--chat-font-weight, 400)" as React.CSSProperties["fontWeight"], paddingLeft: "var(--chat-wrap-padding, 0px)", textIndent: "calc(-1 * var(--chat-wrap-padding, 0px))" }}>
        {showTimestamps && msg.ts && (
          <span className="mr-1 shrink-0 tabular-nums" style={{ fontSize: chatFontVar("--chat-ts-size"), fontFamily: "var(--chat-ts-font, inherit)", color: "var(--chat-ts-color, #71717a)", display: "inline-block", minWidth: "var(--chat-ts-w, auto)", textIndent: 0 }}>
            {formatChatTime(new Date(Number(msg.ts)), tsFormat, "live")}
          </span>
        )}
        <span className="chat-msg-header">
        <span
          className={`chat-pi-dot-el${cycleClass}`}
          style={{ width: "calc(8px * var(--chat-dot-scale, 1))", height: "calc(8px * var(--chat-dot-scale, 1))", borderRadius: "50%", background: indicatorColor, verticalAlign: "middle", marginLeft: "3px", marginRight: "var(--chat-pi-gap, 11px)", flexShrink: 0, display: "inline-block", ...cycleVars }}
        />
        <span
          className="chat-pi-icon-el"
          style={{ verticalAlign: "middle", marginLeft: "3px", marginRight: "var(--chat-pi-gap, 11px)", alignItems: "center", fontSize: CHAT_FONT }}
        >
          {cycling ? (
            // One logo per platform the message went to, each in its own colour,
            // crossfading, with no box. First layer = the site's own, which is
            // what shows when cycling is off.
            <span className={`chat-pi-logos chat-pi-logos-${cycleList.length}`}>
              {cycleList.map((p, i) => (
                <span key={p} className="chat-pi-logo" style={{ color: platformColorVar(p), animationDelay: `${i * 0.6}s` }}>
                  <PlatformIcon platform={p} size="0.75em" />
                </span>
              ))}
            </span>
          ) : (
            <span style={{ color: indicatorColor, display: "inline-flex" }}>
              <PlatformIcon platform={barPlatform} size="0.75em" />
            </span>
          )}
        </span>
        {/* marginRight adds the ring width: the ring is a box-shadow (zero
            layout footprint), so without this it paints INTO the gap and the
            avatar sits visibly closer to the badges/username than the badges
            sit to the name. Ring off → var is unset → +0px. */}
        <span className="chat-pfp items-center" style={{ display: "none", verticalAlign: "middle", marginLeft: "3px", marginRight: "calc(var(--chat-pi-gap, 11px) + var(--chat-pfp-ring, 0px))" }}>
          {pfpSrc && !pfpFailed ? (
            <img
              src={pfpSrc}
              // The ring cycles the cross-post colours in ring mode: same
              // cycle class as the marker, its own keyframes (globals.css).
              className={`chat-pfp-ring-el rounded-full${cycleClass}`}
              // lazy is load-bearing, not a nicety: the pfp toggle is CSS-only
              // (.chat-pfp-on on the root; this span is display:none otherwise),
              // so the <img> stays mounted with avatars OFF — and an eager
              // hidden image still fetches. A boxless lazy image never
              // intersects, so the browser skips it until the setting gives it
              // a box. Pinned by perfRound3.test.ts.
              loading="lazy"
              decoding="async"
              style={{ width: rowBasisCalc('var(--chat-pfp-scale, 1)'), height: rowBasisCalc('var(--chat-pfp-scale, 1)'), display: "inline-block", verticalAlign: "middle", objectFit: "cover", boxShadow: "0 0 0 var(--chat-pfp-ring, 0px) var(--ring-c)", ["--ring-c" as string]: platformColor, ...cycleVars }}
              onError={() => setPfpFailed(true)}
              alt=""
            />
          ) : (
            <span className={`chat-pfp-ring-el rounded-full select-none${cycleClass}`} style={{ display: "inline-flex", width: rowBasisCalc('var(--chat-pfp-scale, 1)'), height: rowBasisCalc('var(--chat-pfp-scale, 1)'), alignItems: "center", justifyContent: "center", background: avatarFill, color: "#fff", fontWeight: 600, lineHeight: 1, fontSize: rowBasisCalc('var(--chat-pfp-scale, 1) * 0.6'), boxShadow: "0 0 0 var(--chat-pfp-ring, 0px) var(--ring-c)", ["--ring-c" as string]: platformColor, ...cycleVars }}>
              {avatarInitial}
            </span>
          )}
        </span>
        {badges.length > 0 && (
          // Before the username. Between badges and badges → name are both the
          // badge gap (--chat-badge-gap): its own setting, defaulting to the
          // indicator gap (globals.css).
          <span className="chat-badges" style={{ display: "inline-flex", alignItems: "center", gap: "var(--chat-badge-gap)", verticalAlign: "middle", marginRight: "var(--chat-badge-gap)" }}>
            {badges.map((b) => <BadgeImg key={b.id} badge={b} still={stillEmotes} />)}
          </span>
        )}
        {/* Behavior › Mark first-time chatters: their first message ever
            (the server's flag). CSS-only switch (.chat-first-off). */}
        {msg.isFirst && firstTag && <span className="chat-first-tag" title="First message here">new</span>}
        {/* Opens the user card, which is a small thing anchored NEXT to the
            press — the keyboard stays (keepFocus.ts's carve-out is for panels
            that replace the view, and for panels that focus an input of their
            own; the card does neither). */}
        <button
          type="button"
          onClick={(e) => onUsernameClick?.(msg, e.currentTarget)}
          // Data-before-visible: start the card's fetch the
          // instant the press LANDS — the press→click gap plus the host's
          // open gate (ChatSidebar) usually hides the whole round-trip, so
          // the card first-paints finished at its true height. Gated on the
          // click handler: a host that opens no card fetches nothing.
          onPointerDown={onUsernameClick ? () => { void prefetchUserCard(msg); } : undefined}
          onMouseDown={keepFocus}
          className={`${usesFallback ? "chat-name-fallback " : ""}hover:underline cursor-pointer align-baseline`}
          style={{
            color: usernameColor,
            filter: "saturate(var(--chat-username-sat, 1))",
            fontFamily: "var(--chat-username-font, inherit)",
            fontWeight: "var(--chat-username-weight, 600)" as React.CSSProperties["fontWeight"],
            fontSize: CHAT_FONT,
            // Same platform the indicator shows (barPlatform). A CSS var, so it
            // follows the palette setting — readableColor cannot clamp a var; every
            // platform colour clears 3:1 on the dark panel #141828 (lowest ~3.7:1).
            ["--row-pc" as string]: platformColorVar(barPlatform),
          }}
        >
          {/* Coin-store style set (font/effect/gradient) wraps ONLY the name —
              the colon must render plain (settings font, no glow/gradient/
              wobble/scale). Derivations are contrast-clamped inside; the
              button's chat-settings font is the default when no font is
              equipped, since the inner style spreads over the inherited one. */}
          <span>
            <span
              ref={nameInkRef}
              className={`chat-un-style ${unAnimClass}`}
              style={usernameStyleCSS(msg.usernameStyle, msg.usernameColor)}
            >
              {username}
            </span>
            {/* Pronouns: a small raised ♂ ♀ ⚲ in the name's upper-right corner,
                sized and lifted like the Fund-the-Night clock beside it.
                Inside the name button, so a tap opens the card. */}
            <PronounMark pronouns={msg.pronouns} />
            {/* Fund the Night: a small raised clock between the name and its
                colon (a leaf component — see SponsorClockBadge.tsx for why it
                doesn't re-render this row). */}
            <SponsorClockBadge username={msg.username} />
            {onModDelete && <MarkedBadge matrixId={msg.matrixId} canonicalId={modIds.canonicalId} />}
          </span>
          {/* The colon lives inside the username button so it can never wrap to
              the next line on its own — it reads as part of the name. */}
          <span className="text-muted mr-1.5">:</span>
        </button>
        </span>
        {/* Continuation spacer for grouped runs. Empty on purpose: it holds
            open the wrap-indent gutter so continuation text lines up with the
            wrapped lines above. Geometry lives in globals.css, including the
            flush-left variant, so no inline style fights it. Renders as a
            zero-cost display:none unless grouping is on. */}
        <span className="chat-continuation" aria-hidden="true" />
        <span style={{ color: "var(--chat-text-color, #e8e6e3)" }}>
          {body}
        </span>
        {undelivered && (
          // The sender's own line reached the site but missed a platform for a
          // passing reason (undeliveredLines.ts; a persistent refusal is the
          // composer's one note instead). INLINE and zero line-height: it never
          // adds a row or height to the line — a row under every refused line
          // would be noise.
          <span
            data-undelivered
            role="img"
            aria-label={undeliveredLabel(undelivered)}
            title={undeliveredLabel(undelivered)}
            className="text-muted ml-1 align-baseline"
            style={{ lineHeight: 0, fontSize: "var(--text-chat-xs)" }}
          >
            ⊘
          </span>
        )}
        <TimeAdded seconds={msg.addedSeconds} />
        {score !== 0 && (
          <span
            className="ml-1.5 tabular-nums align-baseline whitespace-nowrap font-bold"
            style={{
              // Bold and near body size, so the running score reads as a real
              // signal in the row rather than footnote text.
              fontSize: "calc(var(--text-chat-md) * 0.8)",
              color: score > 0 ? "var(--chat-vote-color, var(--chat-send-color, var(--accent)))" : "#f87171",
            }}
          >
            {score > 0 ? `+${score}` : score}
          </span>
        )}
      </div>

      {/* Hover action bar. `.row-actions` (globals.css) owns display, opacity,
          the fade and the surface — it is the shared definition
          MatrixMessageRow uses too, and it is deliberately not glass. Do NOT
          add display/transition utilities here: globals.css is unlayered, so
          the class beats them silently (check-layering). */}
      {(onReply || canVote || canReport || (onModDelete && msg.id != null)) && (
        <div
          ref={barRef}
          // Present only while open, so the CSS can key off its bare presence.
          data-open={barOpen || undefined}
          // No `onClick={closeBar}` on the container: that would dismiss on ANY
          // action, including a vote. Voting is repeatable and toggleable, so
          // the menu has to survive it; the one-shot actions (reply, pin,
          // delete, ⋯) close it themselves, below.
          // keepFocus on the CONTAINER too, not just its buttons: the padding
          // and gaps between the targets are tappable surface that belongs to
          // this div, and a press on a non-focusable element still blurs the
          // composer and drops the keyboard. ContextMenu has no such hole
          // because its MenuItems are full-width and each carries keepFocus.
          onMouseDown={keepFocus}
          className="row-actions absolute right-1 top-0 -translate-y-[75%] z-10 gap-0.5 rounded-md px-1.5 py-0.5">
          {/* A vote refused by the per-target clamp (429) reverts optimistically,
              so without this the arrow just bounces back and reads as a broken
              button. `_voteCooling` is set for a few seconds by useChatMessages
              and says WHY nothing happened. There is no toast system, and the
              app surfaces errors in place — same call AutomodHoldBar makes. */}
          {canVote && (
            <button
              type="button"
              onClick={() => onVote(msg, msg.myVote === 1 ? 0 : 1)}
              onMouseDown={keepFocus}
              // aria-disabled, not disabled: the clamp is a few seconds and a
              // real disabled would eject keyboard focus mid-interaction. This
              // says "present but won't act" — the styled-disabled state was
              // otherwise title-only (chatStateA11y.test.ts).
              aria-disabled={msg._voteCooling || undefined}
              className={`px-1 py-0.5 rounded transition-colors ${
                msg._voteCooling
                  ? "text-muted opacity-40 cursor-not-allowed"
                  : `hover:bg-surface-3 ${msg.myVote === 1 ? "text-[color:var(--chat-vote-color,var(--chat-send-color,var(--accent)))]" : "text-muted hover:text-strong"}`
              }`}
              style={{ fontSize: "var(--text-chat-md)" }}
              title={msg._voteCooling ? VOTE_COOLING_TITLE : msg.myVote === 1 ? "Remove upvote" : "Upvote"}
            >
              ▲
            </button>
          )}
          {canVote && (
            <button
              type="button"
              onClick={() => onVote(msg, msg.myVote === -1 ? 0 : -1)}
              onMouseDown={keepFocus}
              aria-disabled={msg._voteCooling || undefined}
              className={`px-1 py-0.5 rounded transition-colors ${
                msg._voteCooling
                  ? "text-muted opacity-40 cursor-not-allowed"
                  : `hover:bg-surface-3 ${msg.myVote === -1 ? "text-red-400" : "text-muted hover:text-strong"}`
              }`}
              style={{ fontSize: "var(--text-chat-md)" }}
              title={msg._voteCooling ? VOTE_COOLING_TITLE : msg.myVote === -1 ? "Remove downvote" : "Downvote"}
            >
              ▼
            </button>
          )}
          {onReply && (
            <button
              type="button"
              onClick={() => { onReply(msg); closeBar(); }}
              onMouseDown={keepFocus}
              className="px-1.5 py-0.5 rounded text-muted hover:text-strong hover:bg-surface-3 transition-colors"
              style={{ fontSize: "var(--text-chat-md)" }}
              title="Reply"
            >
              ↩
            </button>
          )}
          {/* Copy sits ON the bar: it is the one action every viewer has, so
              it does not hide behind a second step in the ⋯ menu. */}
          <button
            type="button"
            onClick={() => { void copyText(msg.message); closeBar(); }}
            onMouseDown={keepFocus}
            className="px-1 py-0.5 rounded text-muted hover:text-strong hover:bg-surface-3 transition-colors"
            style={{ fontSize: "var(--text-chat-md)" }}
            title="Copy text"
            aria-label="Copy message text"
          >
            ⎘
          </button>
          {/* Overflow — the same ⋯ the Matrix row carries, so one toolbar
              serves both pointer types. It holds ONLY the mod quick actions
              (pin + two-step delete; a delete arm on the bar would speak only
              through title=, invisible on touch) — hence gated to the mod
              handlers; a viewer's menu would be empty. Both handlers are
              mod-only at the call site (ChatSidebar). */}
          {(onPin || onModDelete || canReport) && msg.id != null && (
            <button
              type="button"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                menuAnchorRef.current = e.currentTarget;
                setCtxMenu({ x: r.left, y: r.bottom });
                // Keyboard activation (click detail 0) HOLDS the bar open: the
                // menu returns focus to this button on close, and a display:none
                // target silently refuses focus (contextMenuKeyboard.test.ts).
                // Pointer flows dismiss it.
                if (e.detail === 0) setBarOpen(true); else closeBar();
              }}
              onMouseDown={keepFocus}
              className="px-1 py-0.5 rounded text-muted hover:text-strong hover:bg-surface-3 transition-colors"
              style={{ fontSize: "var(--text-chat-md)" }}
              title="More"
            >
              ⋯
            </button>
          )}
        </div>
      )}

      {/* Sticker boost trigger — anchored to the WHOLE ROW's own bottom-right
          corner (not the sticker image's), so it stays put as the image grows
          instead of drifting away from the cursor. */}
      {msg.system === "sticker" && msg.emoteUrl && onBoost && boostTargetId != null && (
        <button
          type="button"
          /* No amount in this tooltip; the popover shows the live floor. This
             component renders once per message and is memoized — subscribing
             every row to the price store to label a tooltip would re-render
             the whole feed on a price change. */
          title="Boost this sticker"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            setBoostPop({ x: r.left, y: r.bottom + 4 });
          }}
          onMouseDown={keepFocus}
          // Touch devices have no hover, so the group-hover reveal never fires and
          // the boost button would be unreachable — on (hover:none) it's always shown +
          // tappable (softened opacity so it's not noisy on every sticker).
          className={`absolute bottom-1 right-1 w-7 h-7 rounded-full bg-scrim-heavy hover:bg-scrim-heavy border border-edge-strong text-strong text-base leading-none flex items-center justify-center transition-opacity duration-(--anim-fast) anim-ease pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto active:opacity-100 active:pointer-events-auto [@media(hover:none)]:opacity-70 [@media(hover:none)]:pointer-events-auto ${
            boostPop ? "opacity-100 pointer-events-auto" : "opacity-0"
          }`}
        >
          ⚡
        </button>
      )}
      {boostPop && msg.system === "sticker" && onBoost && boostTargetId != null && (
        <StickerBoostPopover
          x={boostPop.x}
          y={boostPop.y}
          onClose={() => setBoostPop(null)}
          onConfirm={(amount) => onBoost(boostTargetId, amount)}
        />
      )}

      {ctxMenu && (
        <MessageContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onPin={onPin && msg.id != null ? () => onPin(msg) : undefined}
          onDelete={onModDelete && msg.id != null ? () => onModDelete(msg) : undefined}
          // The sender actions ride with the mod handler (mods only at the call site), and only
          // on a real chat line — a system card has no sender to act on.
          msg={onModDelete && msg.id != null && !msg.system ? { id: msg.id, platform: msg.platform, matrixId: msg.matrixId, canonicalId: modIds.canonicalId } : undefined}
          onDetails={onModDelete && onUsernameClick && !msg.system ? () => { if (menuAnchorRef.current) onUsernameClick(msg, menuAnchorRef.current); } : undefined}
          onResult={emitChatNotice}
          onReport={canReport ? () => openReportDialog({ platform: msg.platform, messageId: msg.id!, name: msg.username }) : undefined}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
});
