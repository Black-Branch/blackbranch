"use client";

import { CHAT_FONT, chatFontVar, rowBasisCalc } from "@/app/lib/chatFont";
import { useState, useCallback, useMemo, memo, useRef } from "react";
import type { Room, RoomMember, MatrixEvent } from "matrix-js-sdk";
import { renderText } from "@/app/lib/renderText";
import { useLongPress } from "@/app/lib/useLongPress";
import { useOutsideClick } from "@/app/lib/useOutsideClick";
import { useExclusiveOpen, claimExclusive } from "@/app/lib/exclusiveOpen";
import { keepFocus, keepFocusCoarse } from "@/app/lib/keepFocus";
import { countThreadReplies, lastThreadReply } from "@/app/lib/matrixThreads";
import { usernameColor } from "@/app/lib/avatarColor";
import { memberContentColor } from "@/app/lib/matrixProfileColor";
import { copyText } from "@/app/lib/clipboard";
import type { EmoteMap } from "@/app/lib/useEmotes";
import { EMPTY_REACTIONS, type ReactionAgg, type ReactionExtra } from "@/app/lib/matrixReactions";
import { extractUrls, uniqueUrls, snippet } from "@/app/lib/textFormat";
import { formatChatTime, type TsFormat } from "@/app/lib/chatTime";
import { memberName } from "@/app/lib/matrixDisplay";
import { senderLabel as discordLabel } from "@/app/lib/discordSender";
import PlatformIcon from "@/app/components/PlatformIcon";
import { useBadges, badgesForMatrixId } from "@/app/lib/BadgesContext";
import { Smiley, Chats } from "@phosphor-icons/react/dist/ssr";
import { Avatar } from "./Avatar";
import { stripReplyFallback } from "@/app/lib/stripReplyFallback";
import { sanitizeMatrixHtml, treeHrefs, treeText, treeHasEmbed } from "@/app/lib/matrixHtml";
import { previewCandidates } from "@/app/lib/linkPreviewLimits";
import { MatrixHtml } from "./MatrixHtml";
import { LinkPreview } from "./LinkPreview";
import { ReactionKey, ReactionPicker, getRecentReactions, saveRecentReaction } from "./ReactionPicker";
import { MsgContextMenu } from "./MsgContextMenu";
import { MatrixImage, MatrixFile, MatrixVideo, MatrixAudio } from "./MatrixAttachments";
import { mediaKindLabel } from "@/app/lib/mediaKind";
import { ForumVoteControl } from "./ForumVoteControl";
import { MemberCard } from "./MemberCard";
import { PronounMark } from "./PronounMark";
import { usernameStyleCSS, usernameStyleAnimClass } from "@/app/lib/usernameStyles";
import { useAnimFence } from "@/app/lib/animFence";
import type { UserLooks } from "@/app/lib/useUserLooks";
import { useWantUserStyles } from "@/app/lib/useUserColors";

const NO_LOOKS: UserLooks = {};

// ─── Undecryptable message copy ──────────────────────────────────────────────
// When a message can't be decrypted the SDK replaces its content with a
// developer-facing body ("** Unable to decrypt: DecryptionError: ... **"). We must
// never render that — it's raw noise. Map the SDK's failure reason (a
// DecryptionFailureCode string) to short, human copy; the global "Session
// unverified / Secure your account" banner carries the actual remediation, so the
// row stays quiet. `reason` is `String(ev.decryptionFailureReason ?? "")`.
function decryptFailureText(reason: string): string {
  switch (reason) {
    case "HISTORICAL_MESSAGE_NO_KEY_BACKUP":
    case "HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED":
    case "HISTORICAL_MESSAGE_WORKING_BACKUP":
      return "sent before you signed in on this device";
    case "HISTORICAL_MESSAGE_USER_NOT_JOINED":
      return "sent before you joined";
    case "MEGOLM_KEY_WITHHELD":
    case "MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE":
    case "UNSIGNED_SENDER_DEVICE":
      return "waiting for the sender to share the key";
    default:
      return "can’t decrypt this message";
  }
}

// ─── Reply preview (quoted message) ──────────────────────────────────────────

function ReplyPreview({
  room,
  eventId,
  onOpenMember,
}: {
  room: Room;
  eventId: string;
  /** Opens the shared member card for the quoted sender (absent = deleted quote, no member found). */
  onOpenMember?: (member: RoomMember, e: React.MouseEvent) => void;
}) {
  const ev = room.findEventById(eventId);
  if (!ev) {
    return (
      <div className="mb-1 pl-2 border-l-2 border-control text-xs text-muted italic">
        Reply to deleted message
      </div>
    );
  }
  const senderId = ev.getSender() ?? "";
  const member = room.getMember(senderId);
  // The bridge writes its own "(Discord)" into the ghost's displayname;
  // senderLabel strips it and flags the sender so the platform shows as a
  // glyph, not prose inside a name.
  const { label: senderLabel, fromDiscord } = discordLabel(memberName(member, senderId), senderId);
  const content = ev.getContent() as Record<string, unknown>;
  const preview = mediaKindLabel(ev.getType(), content.msgtype) ?? snippet(stripReplyFallback((content.body as string) ?? ""));
  return (
    <div
      className="mb-1 flex gap-1.5 pl-2 border-l-2 border-control text-muted leading-snug"
      style={{ fontSize: "var(--text-chat-xs)" }}
    >
      {member && onOpenMember ? (
        <button
          type="button"
          aria-label={`Open member card for ${senderLabel}`}
          onClick={(e) => onOpenMember(member, e)}
          className="shrink-0 text-left"
          title={fromDiscord ? `${senderLabel} (via Discord)` : undefined}
          style={{ color: usernameColor(senderLabel), fontFamily: "var(--chat-username-font, inherit)", fontWeight: "var(--chat-username-weight, 600)" as React.CSSProperties["fontWeight"], filter: "saturate(var(--chat-username-sat, 1))" }}>
          {senderLabel}
          {fromDiscord && (
            <PlatformIcon platform="discord" size="0.85em" className="ml-1 inline-block align-baseline opacity-70" />
          )}
        </button>
      ) : (
        <span className="shrink-0" title={fromDiscord ? `${senderLabel} (via Discord)` : undefined} style={{ color: usernameColor(senderLabel), fontFamily: "var(--chat-username-font, inherit)", fontWeight: "var(--chat-username-weight, 600)" as React.CSSProperties["fontWeight"], filter: "saturate(var(--chat-username-sat, 1))" }}>
          {senderLabel}
          {fromDiscord && (
            <PlatformIcon platform="discord" size="0.85em" className="ml-1 inline-block align-baseline opacity-70" />
          )}
        </span>
      )}
      <span className="truncate">{preview}</span>
    </div>
  );
}

// ─── Shared message row ──────────────────────────────────────────────────────

function MatrixMessageRowImpl({
  ev,
  room,
  myUserId,
  emotes = {},
  ownColor,
  userColors = {},
  onReply,
  onMention,
  reactions = EMPTY_REACTIONS,
  onReact,
  onUnreact,
  onEdit,
  onDelete,
  onOpenThread,
  activeThreadRootId = null,
  hideThread = false,
  tsFormat = "standard" as TsFormat,
  tick,
  threadCount: threadCountProp,
  lastReply: lastReplyProp,
  editedContent = null,
  grouped = false,
  voteScore,
  myVote = null,
  onVote,
  bodyOverride,
  pinned,
  onTogglePin,
  highlighted,
  mentioned,
  onMessageUser,
  moderationScope,
  groupEnd = false,
  alt = false,
  looks = NO_LOOKS,
  avatarSize = 14,
  showEdited = true,
}: {
  ev: MatrixEvent;
  room: Room;
  myUserId: string;
  emotes?: EmoteMap;
  ownColor?: string | null;
  /** Platform-chosen name colors keyed by matrix_id (useUserColors). */
  userColors?: Record<string, string>;
  onReply?: (ev: MatrixEvent) => void;
  onMention?: (userId: string) => void;
  /** Aggregated reactions for this event (from aggregateReactions). */
  reactions?: ReactionAgg[];
  onReact?: (ev: MatrixEvent, key: string, extra?: ReactionExtra) => void;
  onUnreact?: (reactionEventId: string) => void;
  onEdit?: (ev: MatrixEvent) => void;
  onDelete?: (ev: MatrixEvent) => void;
  /** Open this message's thread (root or, if it's a reply, its thread root). */
  onOpenThread?: (ev: MatrixEvent) => void;
  /** Root id of the open thread — highlights this row's chip when it matches. */
  activeThreadRootId?: string | null;
  /** Inside the thread panel: suppress the thread chip + thread action. */
  hideThread?: boolean;
  /** Timestamp display format (settings → Text → Timestamp format). */
  tsFormat?: TsFormat;
  /** Bumped once a minute (only while a "rel" format is in play) so this
   *  memoized row re-renders and recomputes formatChatTime's "now". Read by
   *  rowPropsEqual only — nothing in the body reads its value. */
  tick?: number;
  /**
   * Precomputed thread summary for this row. The parent already scans the
   * timeline once per refresh, so deriving these here would make every
   * rendered row repeat that scan. Both are omitted by callers that don't
   * render thread chips; the row falls back to computing them itself.
   */
  threadCount?: number;
  lastReply?: MatrixEvent | null;
  /** Latest edited content (m.new_content) for this event, if edited. */
  editedContent?: Record<string, unknown> | null;
  /** Continuation of the previous message from the same sender (no avatar/header). */
  grouped?: boolean;
  /** Forum vote score for this event (renders the vote control when onVote set). */
  voteScore?: number;
  /** The caller's own vote on this event. */
  myVote?: -1 | 1 | null;
  /** Cast/clear a vote on this event (forum rooms only). */
  onVote?: (ev: MatrixEvent, direction: -1 | 1) => void;
  /** Forum post root: render this text as the body instead of the raw message
   *  body (which holds the duplicated title + #tags). Empty string = no body
   *  text. For image posts it renders below the image. */
  bodyOverride?: string;
  /** This event is in the room's m.room.pinned_events. */
  pinned?: boolean;
  /** Pin or unpin (`pinned` = its state now); absent when the reader may not. */
  onTogglePin?: (ev: MatrixEvent, pinned: boolean) => void;
  /** Briefly emphasised after a jump-to-message. */
  highlighted?: boolean;
  /** This message names the reader in m.mentions.user_ids (see matrixMentions.ts).
   *  Renders as a permanent amber left bar — painted whenever the message mentions
   *  the reader, jump-highlighted or not, since a mention is a lasting property of
   *  the message. The amber background wash paints only while the row is NOT also
   *  `highlighted`: both washes set `background-color` on the same element, the
   *  cascade can keep only one, so the transient jump-to wash wins while it lasts
   *  and the bar still marks the mention underneath it. */
  mentioned?: boolean;
  /** Message this user from the shared member card — reaches
   *  openOrCreateDM up in MatrixView. Absent = no Message button on the card. */
  onMessageUser?: (userId: string) => void;
  /** Which channels one moderation action from this row's card covers.
   *  A callback, not an array — see rowPropsEqual below. */
  moderationScope?: () => Room[];
  // ── Community settings ──
  /** The last row of its message group — the bubbles layout rounds it. */
  groupEnd?: boolean;
  /** Wears the alternating stripe (Chat rows › Alternating rows; mxRows.ts). */
  alt?: boolean;
  /** Name styles + pronouns by matrix id (useUserLooks) — Chat rows › Name styles / Pronoun symbols. */
  looks?: UserLooks;
  /** Avatar px at the default size (Avatar scales it by Chat rows › Avatar size): 14, 12 in Compact. */
  avatarSize?: number;
  /** Community › "(edited)" tag. */
  showEdited?: boolean;
}) {
  // `tick` is a pass-through: its only job is to change once a minute (while a
  // "rel" format is in play) so this memoized row re-renders and recomputes
  // formatChatTime's "now". Nothing here reads its value.
  void tick;
  const badgeState = useBadges();
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [reactAnchor, setReactAnchor] = useState<{ x: number; y: number } | null>(null);
  const [memberCard, setMemberCard] = useState<{ member: RoomMember; x: number; y: number } | null>(null);
  // Long press opens THIS ROW'S TOOLBAR, not the ⋯ menu behind it — see the
  // `(hover: hover)` gate in globals.css and ChatMessage's copy of this block.
  // The toolbar already carries a ⋯ to the fuller menu, so this side only has
  // to avoid jumping straight to the second tier.
  const [barOpen, setBarOpen] = useState(false);
  // "(edited)" tapped: the original text shows under the message.
  const [showOriginal, setShowOriginal] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const closeBar = useCallback(() => setBarOpen(false), []);
  // ONE menu open app-wide — see exclusiveOpen.ts. Dismissal events cannot
  // carry this: a long press swallows its own touchend, so the previously
  // open row never saw a mousedown to close on.
  const owner = useExclusiveOpen(barOpen, closeBar);
  // Claim BEFORE flipping open: any other open row is already closing, and
  // this row cannot tell itself to close because it has not subscribed yet.
  const handleLongPress = useCallback(() => { claimExclusive(owner); setBarOpen(true); }, [owner]);
  const longPress = useLongPress(handleLongPress);
  useOutsideClick(barRef, closeBar, { enabled: barOpen, escape: true, touch: false });

  // Toggle: if I already reacted with this key, redact it; otherwise add it.
  // A bridged custom-emoji pile is sent as its mxc (the only key the bridge
  // relays to Discord) with the shortcode alongside, so both spellings fold.
  const toggleReaction = (key: string) => {
    const existing = reactions.find((r) => r.key === key);
    if (existing?.mine) onUnreact?.(existing.mine);
    else if (existing?.mxc && /^:[A-Za-z0-9_~-]+:$/.test(key)) onReact?.(ev, key, { mxc: existing.mxc, shortcode: key });
    else onReact?.(ev, key);
  };
  const myKeys = new Set(reactions.filter((r) => r.mine).map((r) => r.key));
  // 3 most-recent reaction keys → quick-react buttons on the left of the bar.
  const recentReacts = onReact ? getRecentReactions().slice(0, 3) : [];

  const content = ev.getContent() as Record<string, unknown>;
  const senderId = ev.getSender() ?? "";
  // userColors/looks hold only the ids something asked for.
  useWantUserStyles([senderId]);
  const member = room.getMember(senderId);
  const avatarUrl = member?.getMxcAvatarUrl() ?? null;
  // The bridge writes its own "(Discord)" into the ghost's displayname;
  // senderLabel strips it and flags the sender so the platform shows as a
  // glyph, not prose inside a name.
  const { label: senderLabel, fromDiscord } = discordLabel(memberName(member, senderId), senderId);
  const isOwn = senderId === myUserId;
  // Custom username colour carried on the member event (either namespace).
  const memberColor = memberContentColor(member?.events?.member?.getContent() as Record<string, unknown> | undefined);

  // A sender who has left the room has no member object — no card would say
  // anything the row does not (no presence, no power, no Message button), so
  // opening one is a no-op rather than a blank shell.
  const openMemberCard = (e: React.MouseEvent) => {
    if (!member) return;
    const r = e.currentTarget.getBoundingClientRect();
    setMemberCard({ member, x: r.right, y: r.top });
  };

  const relatesTo = content["m.relates_to"] as Record<string, unknown> | undefined;
  // A thread reply's m.in_reply_to is just fallback context for plain clients —
  // Element doesn't render it as a visible quote, and neither do we.
  const isThreadFallback =
    relatesTo?.rel_type === "m.thread" && relatesTo?.is_falling_back === true;
  const replyToId = isThreadFallback
    ? undefined
    : ((relatesTo?.["m.in_reply_to"] as Record<string, unknown>)?.event_id as string | undefined);
  const isReply = !!replyToId;

  const evType = ev.getType();
  // Redaction: own message OR sufficient power level (one SDK check covers both).
  const canRedact =
    !ev.isRedacted() && room.currentState.maySendRedactionForEvent(ev, myUserId);
  // Edit only your own plain-text messages (not images/files/video/audio/stickers/redacted).
  const canEdit =
    isOwn &&
    !ev.isRedacted() &&
    evType === "m.room.message" &&
    content.msgtype !== "m.image" &&
    content.msgtype !== "m.file" &&
    content.msgtype !== "m.video" &&
    content.msgtype !== "m.audio";

  // Edited messages render their latest content; the reply fallback prefix only
  // lives on the original body, so don't strip it from edited content.
  const isEdited = !!editedContent;
  const dc = editedContent ?? content;
  const stripReply = isReply && !isEdited;

  // Bridged rich content (Discord forwards, embeds) lives in `formatted_body`;
  // `body` carries only a lossy markdown-ish FALLBACK — rendering it shows
  // literal `>` quotes and `[label](url)`.
  //
  // formatted_body is hostile input from an authenticated attacker, not trusted
  // bridge output: api/matrix/token hands the browser a raw homeserver access
  // token and there is no send proxy, so any logged-in user can set it to
  // anything. sanitizeMatrixHtml is what makes it safe to render — see its header.
  //
  // `bodyOverride` is a caller-supplied plain-text replacement (forum posts), so it
  // opts out of the HTML path entirely. For edits `dc` is m.new_content, whose
  // formatted_body is already free of the "* " fallback prefix.
  const formattedBody =
    bodyOverride === undefined &&
    dc.format === "org.matrix.custom.html" &&
    typeof dc.formatted_body === "string"
      ? (dc.formatted_body as string)
      : null;
  // Parsing is not free and rows re-render on reactions/edits/thread counts, so
  // memoize on the markup itself.
  const htmlTree = useMemo(
    () => (formattedBody === null ? null : sanitizeMatrixHtml(formattedBody)),
    [formattedBody],
  );

  let body: React.ReactNode;
  let previewUrls: string[] = [];
  let rawBodyText = "";
  // Community › Deleted messages › "Show a note" lets a deleted message through
  // (timelineRows.ts); it renders as the note alone — no toolbar, reactions,
  // thread chip or votes.
  const redacted = ev.isRedacted();

  if (redacted) {
    body = <span className="text-muted italic">Message deleted</span>;
  } else if (ev.isEncrypted() && (ev.isDecryptionFailure() || !content.body)) {
    // A real decryption failure carries an SDK-generated body (msgtype
    // m.bad.encrypted), so the old `!content.body` guard alone missed it and let
    // the raw "** Unable to decrypt: ... **" string fall through to renderText.
    // Detect it via isDecryptionFailure() and show friendly, reason-aware copy.
    const failText = ev.isDecryptionFailure()
      ? decryptFailureText(String(ev.decryptionFailureReason ?? ""))
      : "encrypted";
    body = <span className="text-muted italic">🔒 {failText}</span>;
  } else if (evType === "m.sticker" || content.msgtype === "m.image") {
    // Forum image post: show the image, then its description (bodyOverride) below
    // so the post's prose + links render in the thread view.
    const desc = bodyOverride?.trim() ?? "";
    body = (
      <>
        <MatrixImage content={content} />
        {desc && (
          <div className="mt-1.5">{renderText(desc, emotes)}</div>
        )}
      </>
    );
    previewUrls = desc ? extractUrls(desc) : [];
    rawBodyText = (content.body as string) ?? "";
  } else if (content.msgtype === "m.video") {
    body = <MatrixVideo content={content} />;
    rawBodyText = (content.body as string) ?? "";
  } else if (content.msgtype === "m.audio") {
    body = <MatrixAudio content={content} />;
    rawBodyText = (content.body as string) ?? "";
  } else if (content.msgtype === "m.file") {
    body = <MatrixFile content={content} />;
    rawBodyText = (content.body as string) ?? "";
  } else if (dc.msgtype === "m.emote") {
    const src = (dc.body as string) ?? "";
    const emoteBody = stripReply ? stripReplyFallback(src) : src;
    body = (
      <span className="text-secondary italic">
        <span title={fromDiscord ? `${senderLabel} (via Discord)` : undefined}>
          * {senderLabel}
          {fromDiscord && (
            <PlatformIcon platform="discord" size="0.85em" className="ml-1 inline-block align-baseline opacity-70" />
          )}
        </span>{" "}
        {renderText(emoteBody, emotes)}
      </span>
    );
    rawBodyText = emoteBody;
  } else if (htmlTree) {
    // The reply fallback is stripped STRUCTURALLY here — the sanitizer drops the
    // whole <mx-reply> element — so stripReplyFallback is not needed on this path.
    body = (
      <span>
        <MatrixHtml nodes={htmlTree.nodes} truncated={htmlTree.truncated} emotes={emotes} />
      </span>
    );
    // Preview candidates are the tree's real anchors PLUS bare URLs in the
    // rendered text, not just the anchors: wordsToHtml (buildMatrixMessage)
    // escapes a bare URL as plain text, never an <a>, so once a pill forces
    // formatted_body, treeHrefs alone would miss a bare URL sitting next to
    // it and the card would silently vanish. uniqueUrls dedupes the two lists.
    previewUrls = uniqueUrls([...treeHrefs(htmlTree.nodes), ...extractUrls(treeText(htmlTree.nodes))]);
    rawBodyText = treeText(htmlTree.nodes);
  } else {
    const src = bodyOverride !== undefined ? bodyOverride : (dc.body as string) ?? "";
    const rawBody = stripReply && bodyOverride === undefined ? stripReplyFallback(src) : src;
    body = <span>{renderText(rawBody, emotes)}</span>;
    previewUrls = extractUrls(rawBody);
    rawBodyText = rawBody;
  }

  // Cards come from the capped, embed-aware list — see linkPreviewLimits.ts. Only
  // a bridge ghost can truthfully carry Discord's own unfurl; a native user's
  // hand-written embed markup must not switch the site's own cards off.
  const cards = previewCandidates(previewUrls, fromDiscord && !!htmlTree && treeHasEmbed(htmlTree.nodes));

  const ts = new Date(ev.getTs());
  const badges = badgesForMatrixId(badgeState, senderId);
  const shortTime = formatChatTime(ts, tsFormat, "community-hover");
  const nameColor =
    (isOwn && ownColor) || userColors[senderId] || memberColor || usernameColor(senderLabel);
  // The chat's Name styles + Pronoun symbols (⑥): the same span classes live chat
  // uses, so its <html> switches (.chat-namestyles-off / .chat-pron-off) reach
  // these rows with no re-render. The ARRIVAL animation is left out: it plays as
  // a live line arrives, and a Community row mounts on every scroll and room switch.
  const look = looks[senderId];
  const nameStyle = look?.s ? { ...look.s, entrance: null } : null;
  const nameStyleCss = usernameStyleCSS(nameStyle, nameColor);
  const nameAnimClass = usernameStyleAnimClass(nameStyle);
  // An animated style pauses while its row is off screen — the same fence as a
  // live-chat row (animFence.ts).
  useAnimFence(rowRef, nameAnimClass !== "");
  const nameInner = (
    <>
      <span className={`chat-un-style ${nameAnimClass}`} style={nameStyleCss}>{senderLabel}</span>
      <PronounMark pronouns={look?.p} />
    </>
  );
  // The original text of an edited message ("(edited)" tapped). getOriginalContent,
  // NOT getContent: the SDK applies a replacement to getContent() itself, so that
  // already reads the edit (found on the throwaway — the "original" showed the new text).
  const originalText = isEdited
    ? stripReplyFallback(((ev.getOriginalContent() as Record<string, unknown>).body as string) ?? "")
    : "";

  // Thread activity — replies that hang off this message. Suppressed inside the
  // thread panel itself (hideThread) so the root/replies don't show nested chips.
  const evId = ev.getId() ?? "";
  const threadCount = hideThread
    ? 0
    : (threadCountProp ?? countThreadReplies(room, evId));
  // Last reply → the chip's Element-style preview (avatar · sender · snippet).
  const lastReply =
    threadCount > 0
      ? (lastReplyProp !== undefined ? lastReplyProp : lastThreadReply(room, evId))
      : null;
  const lrSenderId = lastReply ? (lastReply.getSender() ?? "") : "";
  const lrMember = lastReply ? room.getMember(lrSenderId) : null;
  // label only here, no glyph: this is a one-line thread preview, not a name.
  const lrSender = lastReply ? discordLabel(memberName(lrMember, lrSenderId), lrSenderId).label : null;
  const lrAvatar = lrMember?.getMxcAvatarUrl() ?? null;
  let lrPreview = "";
  if (lastReply) {
    const lc = lastReply.getContent() as Record<string, unknown>;
    lrPreview = mediaKindLabel(lastReply.getType(), lc.msgtype) ?? snippet(stripReplyFallback((lc.body as string) ?? ""), 42);
  }
  const isThreadReply =
    (relatesTo?.rel_type as string | undefined) === "m.thread" && !!relatesTo?.event_id;
  // A message can seed a thread if it isn't itself a thread reply (replies open
  // their parent thread instead) and isn't redacted.
  const canThread = !!onOpenThread && !hideThread && !isThreadReply && !ev.isRedacted();

  return (
    <div
      ref={rowRef}
      data-event-id={ev.getId()}
      // The mention mark (amber edge + tint) is globals.css `.chat-row-mention-mx`,
      // painted only while Behavior › Mentions of me is on; a highlighted
      // (jumped-to) row keeps its accent fill over it (data-hl).
      data-hl={highlighted ? "" : undefined}
      // ⑥: `mx-row` carries the Community layouts (globals.css — cozy is these
      // utilities; compact and bubbles override the spacing), data-head / data-gend
      // mark a group's first and last row, chat-msg-alt is the shared stripe.
      data-head={grouped ? undefined : ""}
      data-gend={groupEnd ? "" : undefined}
      className={`group relative mx-row px-4 hover:bg-surface-1 touch-no-select ${grouped ? "py-0.5" : "pt-3 pb-0.5"} ${
        alt ? "chat-msg-alt" : ""
      } ${mentioned ? "chat-row-mention-mx" : ""} ${highlighted ? "bg-accent/15 hover:bg-accent/15" : ""}`}
      // Same reason as ChatMessage's row: a tap on the message TEXT blurs the
      // composer and drops the keyboard, and the text is the biggest target on
      // screen. Coarse-only so desktop drag-selection survives.
      onMouseDown={keepFocusCoarse}
      {...longPress}
    >
      {/* Hover action bar (desktop) — touch gets the long-press menu. Shares
          `.row-actions` with ChatMessage: one definition of "the row toolbar",
          opaque rather than glass. This copy always had the cost right
          (`hidden group-hover:flex`); what it lacked was the fade, which the
          class now gives both. */}
      {(onReply || onReact) && !redacted && (
        <div
          ref={barRef}
          data-open={barOpen || undefined}
          // Reactions are repeatable/toggleable like votes, so the bar must
          // survive them — no blanket close on the container (see ChatMessage).
          // The container as well as its buttons — see ChatMessage's copy.
          onMouseDown={keepFocus}
          className="row-actions absolute right-3 -top-2.5 gap-0.5 rounded-lg px-1 py-1 z-10 glyph-text">
          {recentReacts.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => { toggleReaction(k); saveRecentReaction(k); }}
              // keepFocus on every button, as on ChatMessage's equivalents:
              // reacting or replying from the Matrix timeline must not drop the
              // soft keyboard (the rule covers the whole chat surface).
              onMouseDown={keepFocus}
              title={`React ${k}`}
              className="w-8 h-8 flex items-center justify-center rounded hover:bg-surface-3 transition-colors"
            >
              <ReactionKey k={k} emotes={emotes} size="1.15rem" />
            </button>
          ))}
          {recentReacts.length > 0 && <span className="w-px h-5 bg-surface-3 mx-0.5 shrink-0" />}
          {/* Safe under keepFocus carve-out 1: the picker's search box is not
              autofocused, so this press is not handing focus to an input. */}
          {onReact && (
            <button type="button" onClick={(e) => setReactAnchor({ x: e.clientX, y: e.clientY })} title="React"
              onMouseDown={keepFocus}
              className="w-8 h-8 flex items-center justify-center rounded text-body-dim hover:text-strong hover:bg-surface-3 transition-colors">
              <Smiley size={17} weight="bold" />
            </button>
          )}
          {onReply && (
            <button type="button" onClick={() => { onReply(ev); closeBar(); }} title="Reply"
              onMouseDown={keepFocus}
              className="w-8 h-8 flex items-center justify-center rounded text-base text-body-dim hover:text-strong hover:bg-surface-3 transition-colors">
              ↩
            </button>
          )}
          {canThread && (
            <button type="button" onClick={() => { onOpenThread?.(ev); closeBar(); }} title="Reply in thread"
              onMouseDown={keepFocus}
              className="w-8 h-8 flex items-center justify-center rounded text-body-dim hover:text-strong hover:bg-surface-3 transition-colors">
              <Chats size={16} weight="bold" />
            </button>
          )}
          <button type="button" onClick={(e) => {
              // A keyboard activation (click detail 0) carries clientX/Y 0,0 —
              // anchor to the button instead of the screen corner, and HOLD the
              // bar open so the menu's focus return has a visible target
              // (contextMenuKeyboard.test.ts).
              const r = e.currentTarget.getBoundingClientRect();
              setCtxMenu(e.detail === 0 ? { x: r.left, y: r.bottom } : { x: e.clientX, y: e.clientY });
              if (e.detail === 0) setBarOpen(true); else closeBar();
            }} title="More"
            onMouseDown={keepFocus}
            className="w-8 h-8 flex items-center justify-center rounded text-lg text-body-dim hover:text-strong hover:bg-surface-3 transition-colors">
            ⋯
          </button>
        </div>
      )}

      {/* Reply preview spans the full row, above the name line. */}
      {replyToId && (
        <div>
          <ReplyPreview room={room} eventId={replyToId} onOpenMember={(m, e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMemberCard({ member: m, x: r.right, y: r.top });
          }} />
        </div>
      )}

      <div>
        {/* Body column */}
        {/* Avatars stay in-line with the username: no
            gutter — the avatar is the first thing in the name line, one row
            tall like live chat's, and the text runs the full row width. */}
        <div className="min-w-0 pr-6">
        {!grouped && (
          <div className="flex items-baseline gap-1.5 flex-wrap leading-tight">
            {member ? (
              <button type="button" aria-label={`Open member card for ${senderLabel}`} onClick={openMemberCard} className="mx-avatar shrink-0 self-center rounded-full">
                <Avatar mxcUrl={avatarUrl} name={senderLabel} size={avatarSize} />
              </button>
            ) : (
              <span className="mx-avatar shrink-0 self-center"><Avatar mxcUrl={avatarUrl} name={senderLabel} size={avatarSize} /></span>
            )}
            {/* `contents` keeps the header's own flex gap between badges; the
                class is what the chat's Badges switch hides (.chat-badges-off). */}
            <span className="chat-badges contents">
              {badges.map((b) => (
                <img key={b.id} src={b.imageUrl} alt={b.name} title={b.name}
                  className="inline-block self-center img-shadow-chat"
                  style={{ height: rowBasisCalc('1.10 * var(--chat-badge-scale, 1)'), width: "auto" }} />
              ))}
            </span>
            {member ? (
              <button type="button" aria-label={`Open member card for ${senderLabel}`} onClick={openMemberCard}
                className="mx-text text-left hover:underline cursor-pointer"
                title={fromDiscord ? `${senderLabel} (via Discord)` : undefined}
                style={{ color: nameColor, fontSize: CHAT_FONT, fontFamily: "var(--chat-username-font, inherit)", fontWeight: "var(--chat-username-weight, 600)" as React.CSSProperties["fontWeight"], filter: "saturate(var(--chat-username-sat, 1))" }}>
                {nameInner}
                {fromDiscord && (
                  <PlatformIcon platform="discord" size="0.85em" className="ml-1 inline-block align-baseline opacity-70" />
                )}
              </button>
            ) : (
              <span className="mx-text"
                title={fromDiscord ? `${senderLabel} (via Discord)` : undefined}
                style={{ color: nameColor, fontSize: CHAT_FONT, fontFamily: "var(--chat-username-font, inherit)", fontWeight: "var(--chat-username-weight, 600)" as React.CSSProperties["fontWeight"], filter: "saturate(var(--chat-username-sat, 1))" }}>
                {nameInner}
                {fromDiscord && (
                  <PlatformIcon platform="discord" size="0.85em" className="ml-1 inline-block align-baseline opacity-70" />
                )}
              </span>
            )}
            <span className="mx-time tabular-nums" style={{ fontSize: chatFontVar("--chat-ts-size"), fontFamily: "var(--chat-ts-font, inherit)", color: "var(--chat-ts-color, #71717a)" }}>
              {formatChatTime(ts, tsFormat, "community-header")}
            </span>
          </div>
        )}
        {/* A grouped row's time is the text's tooltip: there is no gutter,
            and the row's right edge is the action bar's. */}
        {/* Text colour = Colours › Text colour. */}
        <div className="mx-text break-words" title={grouped ? shortTime : undefined} style={{ color: "var(--chat-text-color)", fontSize: CHAT_FONT, fontFamily: "var(--chat-font-family, inherit)", fontWeight: "var(--chat-font-weight, 400)" as React.CSSProperties["fontWeight"], lineHeight: "var(--chat-line-height, 1.4)" }}>
          {body}
          {isEdited && !redacted && showEdited && (
            // Community › "(edited)" tag: tap it for the original text.
            <button type="button" onClick={() => setShowOriginal((o) => !o)} onMouseDown={keepFocus}
              aria-expanded={showOriginal}
              className="text-muted hover:text-secondary ml-1 align-baseline cursor-pointer"
              style={{ fontSize: "var(--text-chat-xs)" }} title={showOriginal ? "Hide the original" : "Show the original"}>
              (edited)
            </button>
          )}
        </div>
        {isEdited && !redacted && showEdited && showOriginal && (
          <div className="mt-0.5 pl-2 border-l-2 border-control text-muted break-words" style={{ fontSize: "var(--text-chat-sm)" }}>
            <span className="text-faint">Original: </span>{originalText ? renderText(originalText, emotes) : <span className="italic">no text</span>}
          </div>
        )}
        {cards.map((url) => <LinkPreview key={url} url={url} />)}
        {threadCount > 0 && !redacted && (
          <button
            type="button"
            onClick={() => onOpenThread?.(ev)}
            disabled={!onOpenThread}
            title={onOpenThread ? "Open thread" : "Threads open in any Matrix client"}
            className={`mt-1 flex items-center gap-2 max-w-md rounded-md border px-2 py-1 transition-colors ${
              activeThreadRootId && activeThreadRootId === evId
                ? "bg-accent/15 border-accent/50 text-heading"
                : "bg-surface-1 border-edge text-body-dim hover:bg-surface-2"
            } ${onOpenThread ? "cursor-pointer" : "cursor-default"}`}
            style={{ fontSize: "var(--text-chat-sm)" }}
          >
            {lastReply ? (
              <Avatar mxcUrl={lrAvatar} name={lrSender ?? "?"} size={18} />
            ) : (
              <span>💬</span>
            )}
            <span className="font-medium shrink-0" style={{ color: "var(--accent)" }}>
              {threadCount} {threadCount === 1 ? "reply" : "replies"}
            </span>
            {lrPreview && (
              <span className="text-muted truncate min-w-0">
                <span className="text-secondary">{lrSender}</span> {lrPreview}
              </span>
            )}
            {onOpenThread && <span className="text-muted shrink-0 ml-auto pl-1">›</span>}
          </button>
        )}
        {reactions.length > 0 && !redacted && (
          <div className="flex flex-wrap gap-1 mt-1">
            {reactions.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => toggleReaction(r.key)}
                title={r.mine ? "Remove reaction" : "React"}
                className={`flex items-center gap-1 rounded-full border px-2 py-0.5 leading-none transition-colors ${
                  r.mine
                    ? "bg-accent/20 border-accent/50 text-heading"
                    : "bg-surface-1 border-edge text-body-dim hover:bg-surface-2"
                }`}
                // Community › Reaction size: × --mx-react-scale (normal = 1).
                style={{ fontSize: "calc(var(--text-chat-sm) * var(--mx-react-scale, 1))" }}
              >
                <ReactionKey k={r.key} emotes={emotes} size="1.05em" mxc={r.mxc} />
                <span className="tabular-nums">{r.count}</span>
              </button>
            ))}
          </div>
        )}
        {onVote && !ev.isRedacted() && (
          <div className="mt-1.5 flex">
            <ForumVoteControl
              score={voteScore ?? 0}
              myVote={myVote}
              onVote={(dir) => onVote(ev, dir)}
              disabled={isOwn}
              size="sm"
            />
          </div>
        )}
        </div>
      </div>

      {ctxMenu && (
        <MsgContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onReact={onReact ? () => setReactAnchor({ x: ctxMenu.x, y: ctxMenu.y }) : undefined}
          onReply={onReply ? () => onReply(ev) : undefined}
          onThread={canThread ? () => onOpenThread?.(ev) : undefined}
          onMention={onMention ? () => onMention(senderId) : undefined}
          onEdit={onEdit && canEdit ? () => onEdit(ev) : undefined}
          onCopy={() => void copyText(rawBodyText)}
          onCopyLink={() => void copyText(`https://matrix.to/#/${room.roomId}/${ev.getId()}`)}
          onPin={onTogglePin ? () => onTogglePin(ev, !!pinned) : undefined}
          pinned={pinned}
          onDelete={onDelete && canRedact ? () => onDelete(ev) : undefined}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {reactAnchor && onReact && (
        <ReactionPicker
          x={reactAnchor.x}
          y={reactAnchor.y}
          activeKeys={myKeys}
          emotes={emotes}
          onPick={(key) => toggleReaction(key)}
          onClose={() => setReactAnchor(null)}
        />
      )}

      {memberCard && (
        <MemberCard member={memberCard.member} room={room} x={memberCard.x} y={memberCard.y} side="right"
          color={nameColor}
          canMessage={!!onMessageUser && memberCard.member.userId !== myUserId}
          onMessage={() => { onMessageUser?.(memberCard.member.userId); setMemberCard(null); }}
          scopeRooms={moderationScope ? moderationScope() : [room]}
          myUserId={myUserId}
          onClose={() => setMemberCard(null)} />
      )}
    </div>
  );
}

// Memoized so a new event arriving (which re-renders the whole timeline) doesn't
// re-render every existing row. All props are referentially stable (callbacks are
// useCallback'd, emotes/userColors are cached hook values, MatrixEvent instances
// are reused by the SDK) except `reactions`, which aggregateReactions rebuilds
// each refresh — so we compare it by content signature.
type MatrixMessageRowProps = Parameters<typeof MatrixMessageRowImpl>[0];

function rowPropsEqual(a: MatrixMessageRowProps, b: MatrixMessageRowProps): boolean {
  if (
    a.ev !== b.ev ||
    a.room !== b.room ||
    a.myUserId !== b.myUserId ||
    a.emotes !== b.emotes ||
    a.ownColor !== b.ownColor ||
    a.userColors !== b.userColors ||
    a.onReply !== b.onReply ||
    a.onMention !== b.onMention ||
    a.onReact !== b.onReact ||
    a.onUnreact !== b.onUnreact ||
    a.onEdit !== b.onEdit ||
    a.onDelete !== b.onDelete ||
    a.onOpenThread !== b.onOpenThread ||
    a.onVote !== b.onVote ||
    a.activeThreadRootId !== b.activeThreadRootId ||
    a.hideThread !== b.hideThread ||
    a.tsFormat !== b.tsFormat ||
    a.tick !== b.tick ||
    a.threadCount !== b.threadCount ||
    a.lastReply !== b.lastReply ||
    a.editedContent !== b.editedContent ||
    a.grouped !== b.grouped ||
    a.voteScore !== b.voteScore ||
    a.myVote !== b.myVote ||
    a.bodyOverride !== b.bodyOverride ||
    a.pinned !== b.pinned ||
    a.onTogglePin !== b.onTogglePin ||
    a.highlighted !== b.highlighted ||
    a.mentioned !== b.mentioned ||
    a.onMessageUser !== b.onMessageUser ||
    a.moderationScope !== b.moderationScope ||
    a.groupEnd !== b.groupEnd ||
    a.alt !== b.alt ||
    a.looks !== b.looks ||
    a.avatarSize !== b.avatarSize ||
    a.showEdited !== b.showEdited
  ) {
    return false;
  }
  const ra = a.reactions ?? EMPTY_REACTIONS;
  const rb = b.reactions ?? EMPTY_REACTIONS;
  if (ra === rb) return true;
  if (ra.length !== rb.length) return false;
  for (let i = 0; i < ra.length; i++) {
    const x = ra[i], y = rb[i];
    if (!x || !y) return false;
    if (x.key !== y.key || x.count !== y.count || x.mine !== y.mine || x.mxc !== y.mxc) {
      return false;
    }
  }
  return true;
}

export const MatrixMessageRow = memo(MatrixMessageRowImpl, rowPropsEqual);

