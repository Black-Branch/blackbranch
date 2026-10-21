"use client";

import { timeoutLabel, lastTimeoutMins, rememberTimeoutMins, modBanAtOnce, type ModTargetMsg } from "@/app/lib/modQuickActions";
import { purgeRequest, PURGE_MAX_MINUTES, type ModTarget } from "@/app/lib/modRequests";
import MessageDetails from "./MessageDetails";
import { openReportDialog } from "./ReportDialog";
import { MarkPanel } from "./MarkPanel";
import { useCallback, useEffect, useState } from "react";
import { siteName } from "@/app/lib/siteName";
import Link from "next/link";
import { useMatrixIdentity } from "@/app/lib/MatrixClientContext";
import type { ChatMsg } from "@/app/lib/chatMsg";
import { avatarBg, usernameColor } from "@/app/lib/avatarColor";
import { localpart } from "@/app/lib/matrixDisplay";
import { postJson, getJson } from "@/app/lib/http";
import PlatformIcon, { PLATFORM_COLORS } from "./PlatformIcon";
import { platformLabel } from "@/app/lib/platforms";
import { DEFAULT_NAME_COLOR } from "@/app/lib/colors";
import BadgeSlots from "./BadgeSlots";
import { LoadingState } from "./Spinner";
import EmptyState from "./EmptyState";
import { avatarSrc } from "@/app/lib/avatarSrc";
import { prefetchUserCard, type Lookup, type UserCardData } from "@/app/lib/userCardData";
import { dispatchClaimable } from "@/app/lib/claimableEvent";
import { pillClasses, tierChips } from "@/app/lib/tierPills";
import { profileDescriptor, profileRead } from "@/app/lib/plugins/profile";
import { useBadges, badgesForMatrixId } from "@/app/lib/BadgesContext";
import { CardBanner, StyledName, Pill } from "./profileCardParts";
import { ShieldStar } from "@phosphor-icons/react/dist/ssr";
import UserChatHistory from "./UserChatHistory";
import { personOfMessage } from "@/app/lib/hideTarget";
import { useBehaviorLists, hidePerson, unhidePerson } from "@/app/lib/behaviorStore";
import { useOwnPublicIds } from "@/app/lib/ownIdentity";
import { useModIds } from "@/app/lib/modIdentity";
import { scoreName } from "@/app/lib/currency";
import { normalizePlatform } from "@/app/lib/nativePlatform";
import { useBillingAvailability } from "@/app/lib/useStripe";

// The /api/user/[id] `Lookup` shape lives in app/lib/userCardData.ts now,
// beside the prefetch cache that fetches it — this file imports the type.

type PlatformAction = {
  id: number;
  action: string;     // ban | timeout | unban | delete
  platform: string;   // twitch | …
  ok: boolean;
  status: number | null;
  detail: string | null;
  at: number;
};

// Per-platform availability BEFORE acting (the propagation log is after-the-
// fact): is the target known there, and could a ban from this mod land.
type PlatformReach = {
  platform: string;
  targetKnown: boolean;
  canBan: "self" | "broadcaster" | null;
  canDelete: "self" | "broadcaster" | null;
  liveOnly?: boolean;
  unsupported?: boolean;
};

// Compact relative time for the platform-action log ("3m", "2h", "5d").
function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Vote score badge (community.scoreName): +n blue / −n red, hidden while loading. */
export function CreditBadge({ credit, className = "" }: { credit: number | null; className?: string }) {
  if (credit === null) return null;
  return (
    <span
      className={`tabular-nums font-semibold whitespace-nowrap ${className}`}
      style={{ color: credit >= 0 ? "var(--accent)" : "#f87171" }}
      title={scoreName()}
    >
      {credit >= 0 ? `+${credit}` : credit}
    </span>
  );
}



/**
 * One icon-sized mod action. Emoji rather than an icon set because these five
 * read instantly at 12px and carry their own colour; `title` + `aria-label` mean
 * nothing is icon-only to a screen reader or on hover.
 */
function ModIconButton({
  label, emoji, onClick, tone, disabled, onMouseLeave,
}: {
  label: string;
  emoji: string;
  onClick: () => void;
  tone: "danger" | "good" | "neutral" | "armed";
  disabled?: boolean;
  onMouseLeave?: () => void;
}) {
  const cls =
    tone === "armed" ? "bg-red-900/70 text-red-100"
    : tone === "danger" ? "bg-surface-2 hover:bg-red-900/60 text-body-dim hover:text-red-200"
    : tone === "good" ? "bg-surface-2 hover:bg-green-900/60 text-body-dim hover:text-green-200"
    : "bg-surface-2 hover:bg-surface-3 text-body-dim hover:text-strong";
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseLeave={onMouseLeave}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`px-1.5 py-1 rounded text-xs leading-none transition-colors disabled:opacity-40 ${cls}`}
    >
      {emoji}
    </button>
  );
}

export default function UserCard({
  msg,
  isMod,
  onClose,
  onStartDM,
  onOpenModPanel,
  inPanel = false,
  liveMessages,
  initialData,
  initialToolsOpen = false,
  stayOpenAfterAction = false,
}: {
  msg: ChatMsg;
  isMod: boolean;
  onClose: () => void;
  onStartDM?: (matrixId: string) => void;
  // Opens the mod-panel overlay prefilled with this user; hosts without the
  // modal (e.g. the OBS chat overlay) omit it and get the /mod page link.
  onOpenModPanel?: (targetId: string) => void;
  // When true, renders without its own background/border (parent panel provides it)
  inPanel?: boolean;
  // Live chat buffer, for the "recent chat" section. Omitted by hosts that have
  // no buffer to share (the mod panel's history rows), which simply hides the
  // section rather than showing an empty one.
  liveMessages?: ChatMsg[];
  // Data-before-visible: a host that gated its open on
  // userCardDataWithin passes the result here, so the card's FIRST frame is
  // the finished card at its true height — the content-fit panel then never
  // resizes after it becomes visible (which would read as an entry stutter).
  // Hosts that don't gate omit it and get the fetch-on-mount behavior.
  initialData?: UserCardData | null;
  /** Open the mod section at once (the mod panel's Chat history rows: the message details are
   *  what the mod opened the row for). */
  initialToolsOpen?: boolean;
  /** Keep the card open after a timeout or ban, so its Undo can be reached — the pop-out window,
   *  whose close would close the window itself. */
  stayOpenAfterAction?: boolean;
}) {
  // A gift is a month of Supporter: no usable Supporter price at Stripe = no Gift button.
  const billing = useBillingAvailability();
  const giftsOn = billing.stripe && billing.supporter !== null;
  const [data, setData] = useState<Lookup | null>(initialData ? initialData.lookup : null);
  const [credit, setCredit] = useState<number | null>(initialData ? initialData.credit : null);
  const [avatarOk, setAvatarOk] = useState(true);
  const [ban, setBan] = useState<{ banned: boolean; expiresAt?: string | null } | null>(null);
  const [purgeArmed, setPurgeArmed] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  // Timeout length, remembered across cards. A mod who times people out for 10m
  // does it over and over; re-picking from a preset row every time was the whole
  // reason the row existed.
  const [timeoutMins, setTimeoutMins] = useState<number>(() => (typeof window === "undefined" ? 10 : lastTimeoutMins()));
  // Recent cross-platform moderation outcomes for this target (Twitch &c.). The
  // fan-out is fire-and-forget, so this is how a mod sees whether it landed.
  const [platformActions, setPlatformActions] = useState<PlatformAction[]>([]);
  // Mods get a collapsed-by-default "🛡 History & tools" section that reveals the
  // scroll-back history AND the mod action strip together; non-mods never see it.
  const [toolsOpen, setToolsOpen] = useState(initialToolsOpen);
  const { matrixId: ownMatrixId } = useMatrixIdentity();
  const badges = useBadges();
  const color = PLATFORM_COLORS[String(normalizePlatform(msg.platform))] ?? DEFAULT_NAME_COLOR;

  const isOwnMessage = !!msg.matrixId && ownMatrixId === msg.matrixId;
  // ⑤ Behavior half B: who "Hide" means, and whether they already are.
  // Never yourself — your site account (isOwnMessage) or any of your platform
  // identities (your own public ids, ownIdentity.ts). Until those have loaded a
  // platform row cannot be told apart from your own Twitch line, so Hide is
  // offered then only for site messages, which isOwnMessage CAN check.
  const ownIds = useOwnPublicIds();
  const ownIdsKnown = ownIds.size > 0;
  const hideTarget = isOwnMessage || (!!msg.publicId && ownIds.has(msg.publicId))
    ? null
    : ownIdsKnown || (msg.matrixId && ownMatrixId) ? personOfMessage(msg) : null;
  // A moderator's controls act by canonical id and site account; the line carries only its
  // public id, resolved for mods as the card renders (modIdentity.ts).
  const modIds = useModIds(msg, isMod);
  const behaviorLists = useBehaviorLists();
  const isHiddenHere = !!hideTarget && behaviorLists.hidden.some((h) => h.id === hideTarget.id);

  // Cross-platform users resolve to their site identity.
  // A Twitch/Kick/YouTube message from someone with a linked site account shows
  // that account's name, avatar and badges — the platform handle is one of
  // their addresses, not who they are here. Falls back to the platform identity
  // when no link exists, which is every unlinked chatter.
  const siteId = msg.matrixId ?? data?.matrixId ?? null;
  const displayName = data?.siteName?.trim() || localpart(msg.username);
  // avatarUrl (the platform pfp) still wins for an unlinked chatter; a linked
  // one prefers their site avatar, since that is the identity being shown.
  const pfp = siteId && data?.siteName
    ? avatarSrc({ matrixId: siteId })
    : avatarSrc(msg);
  const linkedPlatforms = data?.linkedPlatforms ?? [];
  // A mod's pick (below) shows at once; otherwise the lookup, then the chat frame.
  const [pronounsSet, setPronounsSet] = useState<string | null | undefined>(undefined);
  const pronouns = pronounsSet !== undefined ? pronounsSet : data?.pronouns ?? msg.pronouns ?? null;
  // Per-platform handles + the matrix id, for mods.
  //
  // The SERVER decides who gets these — `platformHandles` is simply absent
  // for a non-mod. Do NOT re-derive them client-side or gate them on `isMod`
  // here and call it done: hiding data the client already holds publishes it to
  // anyone who opens devtools.
  const platformHandles = data?.platformHandles ?? [];
  const handleTitle = platformHandles.map((h) => `${h.platform}: ${h.username}`).join("\n");

  // Who mod actions target. Platform-origin messages carry no matrixId, but the
  // lookup resolves a LINKED chatter's site account (mods only) → full site-level
  // actions. An unlinked platform chatter falls back to their canonical stream
  // id, which the mod routes accept for platform-side ban/timeout/purge (there's
  // no site account to ban — the platforms are the source of truth for them).
  const modTargetId = msg.matrixId ?? (isMod ? data?.matrixId ?? null : null);
  const canonicalOnly = isMod && !modTargetId && !!modIds.canonicalId;
  // Key for reads (reach probe + platform-action outcomes): the audit rows for
  // canonical-target actions record the canonical id as target_id.
  const modLookupKey = modTargetId ?? (isMod ? modIds.canonicalId : null);

  // Profile lookup + social credit, through the shared prefetch cache
  // (userCardData.ts — the fetch bodies moved there). A seeded card skips
  // this entirely: the gate already delivered the same data, and refetching
  // it would race a settled truth with a fresh one. An UNSEEDED host (the
  // popout, the mod panel's history rows, a gate that hit its cap) still
  // benefits: a pointerdown prefetch that beat this mount resolves from the
  // cache instead of paying the round-trip again.
  useEffect(() => {
    if (initialData) return;
    let cancelled = false;
    prefetchUserCard(msg)
      .catch((): UserCardData => ({ lookup: { found: false }, credit: 0 }))
      .then((d) => {
        if (cancelled) return;
        setData(d.lookup);
        setCredit(d.credit);
      });
    return () => { cancelled = true; };
  }, [initialData, msg]);

  // Check the target's current ban/timeout state so we show the right control.
  // Site-account targets only: a platform-only chatter has no site.bans row —
  // the platforms themselves hold their ban state.
  useEffect(() => {
    if (!isMod || !modTargetId) return;
    getJson<{ banned: boolean; expiresAt?: string | null }>(`/api/mod/ban?targetId=${encodeURIComponent(modTargetId)}`)
      .then(setBan)
      .catch(() => setBan({ banned: false }));
  }, [isMod, modTargetId]);

  // Recent platform-moderation outcomes for this target, loaded when the card
  // opens — so a mod reopening a chatter's card sees whether a prior ban/timeout
  // actually landed on Twitch (the fan-out is fire-and-forget, recorded after).
  const loadPlatformActions = useCallback(() => {
    if (!isMod || !modLookupKey) return;
    getJson<{ actions?: PlatformAction[] }>(`/api/mod/platform-actions?targetId=${encodeURIComponent(modLookupKey)}&limit=3`)
      .then((d) => setPlatformActions(d?.actions ?? []))
      .catch(() => {});
  }, [isMod, modLookupKey]);
  useEffect(loadPlatformActions, [loadPlatformActions]);

  // Where a mod action on this target can actually reach, shown before acting.
  const [reach, setReach] = useState<PlatformReach[] | null>(null);
  useEffect(() => {
    if (!isMod || !modLookupKey) return;
    getJson<{ platforms?: PlatformReach[] }>(`/api/mod/platform-availability?targetId=${encodeURIComponent(modLookupKey)}`)
      .then((d) => setReach(d?.platforms ?? []))
      .catch(() => {});
  }, [isMod, modLookupKey]);
  const knownReach = (reach ?? []).filter((r) => r.targetKnown);

  // Run mod actions in sequence; only close the card if every call succeeds, so
  // a failed ban/delete (auth, validation, network) never looks like success.
  // Mods set someone's pronouns from here — keyed on the card's own
  // identity, so a platform-only chatter works too. Stays open: it is a picker,
  // not an action that ends the card's job.
  const pronounTarget = modIds.canonicalId ? { canonicalId: modIds.canonicalId } : msg.matrixId ? { matrixId: msg.matrixId } : null;
  async function setTheirPronouns(value: string) {
    if (!pronounTarget) return;
    const res = await postJson("/api/mod/pronouns", { ...pronounTarget, value }).catch(() => null);
    const d = (await res?.json().catch(() => null)) as { pronouns?: string | null; error?: string } | null;
    if (res?.ok) { setActionErr(null); setPronounsSet(d?.pronouns ?? null); }
    else setActionErr(d?.error ?? "Couldn't set their pronouns");
  }

  // Admin only: "Forget this person's AI memory" (stream-api memory.js) — how an
  // emailed request is answered. Two steps: the first click asks, the second acts.
  const forgetTarget = siteId ? { matrixId: siteId } : modIds.canonicalId ? { canonicalId: modIds.canonicalId } : null;
  const [forgetStep, setForgetStep] = useState<"idle" | "confirm" | "busy" | string>("idle");
  // The confirm states what will go, counted by a dry run — lore is shared memory, so
  // the admin sees how many saved facts naming this person are about to be removed.
  const [forgetPreview, setForgetPreview] = useState<{ deleted: number; lore: number } | null>(null);
  async function askForget() {
    if (!forgetTarget) return;
    setForgetPreview(null);
    setForgetStep("confirm");
    const res = await postJson("/api/mod/memory/forget", { ...forgetTarget, dryRun: true }).catch(() => null);
    const d = (await res?.json().catch(() => null)) as { deleted?: number; lore?: number } | null;
    if (res?.ok) setForgetPreview({ deleted: Number(d?.deleted) || 0, lore: Number(d?.lore) || 0 });
  }
  async function forgetMemory() {
    if (!forgetTarget) return;
    setForgetStep("busy");
    const res = await postJson("/api/mod/memory/forget", forgetTarget).catch(() => null);
    const d = (await res?.json().catch(() => null)) as { deleted?: number } | null;
    setForgetStep(res?.ok
      ? `AI memory forgotten — ${d?.deleted ?? 0} ${d?.deleted === 1 ? "entry" : "entries"} removed`
      : "Couldn't forget — nothing was removed");
  }

  // Admin only: the moderator role, from the card (the same route as /mod and /unmod).
  const [targetIsMod, setTargetIsMod] = useState<boolean | null>(null);
  useEffect(() => {
    if (!badges.isAdmin || !siteId || isOwnMessage) return;
    getJson<{ moderators?: { matrixId: string }[] }>("/api/mod/setmod")
      .then((d) => setTargetIsMod(!!d.moderators?.some((m) => m.matrixId === siteId)))
      .catch(() => setTargetIsMod(null));
  }, [badges.isAdmin, siteId, isOwnMessage]);
  async function setModRole(grant: boolean) {
    if (!siteId) return;
    const res = await postJson("/api/mod/setmod", { targetId: siteId, grant }).catch(() => null);
    if (res?.ok) { setActionErr(null); setTargetIsMod(grant); }
    else setActionErr(grant ? "Couldn't make them a moderator" : "Couldn't remove their moderator role");
  }

  // Anyone signed in reports a real line that is not their own (the server finds its author).
  const canReport = !!ownMatrixId && !isOwnMessage && !msg.system && msg.id != null && /^\d+$/.test(String(msg.id));

  async function runActions(label: string, ...calls: (() => Promise<Response>)[]) {
    try {
      for (const call of calls) {
        const res = await call();
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          setActionErr(t && t.length < 120 ? t : `${label} failed`);
          return;
        }
      }
      onClose();
    } catch {
      setActionErr(`${label} failed`);
    }
  }
  const deleteMsg = () =>
    runActions("Delete", () => postJson("/api/mod/delete", { messageId: msg.id, platform: msg.platform }));
  // Site-account targets go by matrix id; platform-only chatters by canonical
  // id (the ban/purge routes take either and fan out via the identity graph).
  const banTarget: ModTarget = modTargetId
    ? { targetId: modTargetId }
    : { canonicalId: modIds.canonicalId ?? "" };
  // Time out and ban go through the same quick action as the ⋯ menu (modQuickActions.ts): applied
  // at once with an Undo, the message removed only when the Undo window closes, and the platforms
  // it reached read back. A kept stronger ban comes back as an error, never as success.
  const cardMsg: ModTargetMsg = { id: msg.id, platform: msg.platform, matrixId: modTargetId, canonicalId: modIds.canonicalId };
  const [banArmed, setBanArmed] = useState(false);
  async function banAtOnce(minutes?: number) {
    const r = await modBanAtOnce(cardMsg, minutes);
    if (!r.ok) { setActionErr(r.error); return; }
    if (stayOpenAfterAction) setActionErr(null);
    else onClose();
  }
  const timeout = (minutes: number) => void banAtOnce(minutes);
  // A permanent ban asks once; a timeout does not.
  const banUser = () => {
    if (!banArmed) { setBanArmed(true); return; }
    setBanArmed(false);
    void banAtOnce();
  };
  const untimeout = () =>
    runActions("Unban", () => postJson("/api/mod/ban", banTarget, "DELETE"));
  const purgeUser = () =>
    runActions("Purge", () => postJson("/api/mod/purge", purgeRequest(banTarget, PURGE_MAX_MINUTES)));

  // Tier descriptors, order + tone in app/lib/tierPills.ts; the install's plugin
  // may add one descriptor and a read of the person (app/lib/plugins/profile.ts).
  const chips = data?.found ? tierChips(data, profileDescriptor(data)) : [];
  const read = data?.found ? profileRead(data) : null;

  // Mod-panel entry point. Shares one definition because it now appears in each
  // of the three mutually-exclusive action-row variants below.
  const modPanelButton = onOpenModPanel ? (
    <button
      type="button"
      onClick={() => { onOpenModPanel(modTargetId ?? modIds.canonicalId ?? ""); onClose(); }}
      title="Open mod panel"
      aria-label="Open mod panel"
      className="ml-auto px-1.5 py-1 rounded text-xs leading-none bg-surface-2 hover:bg-surface-3 text-body-dim hover:text-strong transition-colors"
    >
      🛡
    </button>
  ) : (
    <Link
      href="/mod"
      title="Open mod panel"
      aria-label="Open mod panel"
      className="ml-auto px-1.5 py-1 rounded text-xs leading-none bg-surface-2 hover:bg-surface-3 text-body-dim hover:text-strong transition-colors"
    >
      🛡
    </Link>
  );

  // When hosted in the floating Window the shell owns the frame and the scrolling, so
  // the card must not impose its own width or a second rounded/overflow layer.
  const panelCls = inPanel || liveMessages
    ? "text-strong"
    : "w-72 rounded-xl overflow-hidden text-strong glass";

  return (
    <div className={panelCls}>
      {/* ── Banner + avatar (shared card language) ── The message's platform pfp
          wins, falling back to the Matrix avatar for native users and to a
          coloured initial otherwise — the same resolution chat rows use. */}
      <CardBanner
        displayName={displayName}
        bannerMxc={data?.bannerMxc}
        topRight={
          !isOwnMessage && (msg.matrixId || hideTarget || canReport) ? (
            <>
              {msg.matrixId && (<>
                {onStartDM && (
                  <button
                    onClick={() => { onStartDM(msg.matrixId!); onClose(); }}
                    className="px-2 py-1 rounded-md bg-scrim hover:bg-scrim-strong text-2xs text-strong transition-colors"
                  >
                    Message
                  </button>
                )}
                {giftsOn && <button
                  onClick={() => {
                    // dispatchClaimable, not a bare CustomEvent: the hub's
                    // one-host guard reads defaultPrevented, which only a
                    // cancelable event carries (useUserMenuEvents.ts).
                    // Close ONLY if some window took it: in a
                    // pop-out there is no hub here, the gift panel lives in
                    // the opener, and onClose() is window.close().
                    if (dispatchClaimable("bb:open-support", { giftUsername: msg.matrixId }, { orOpener: true })) onClose();
                  }}
                  className="px-2 py-1 rounded-md bg-violet-500/30 hover:bg-violet-500/50 text-2xs text-violet-100 transition-colors"
                >
                  🎁 Gift
                </button>}
              </>)}
              {canReport && (
                <button
                  onClick={() => { openReportDialog({ platform: msg.platform, messageId: msg.id, name: displayName }); onClose(); }}
                  title="Report this message to the mods"
                  className="px-2 py-1 rounded-md bg-scrim hover:bg-scrim-strong text-2xs text-strong transition-colors"
                >
                  Report
                </button>
              )}
              {/* ⑤ Behavior: hide this person — only for you (behaviorStore). */}
              {hideTarget && (
                <button
                  onClick={() => {
                    if (isHiddenHere) void unhidePerson(hideTarget.id);
                    else void hidePerson(hideTarget, { matrixId: ownMatrixId, ownIds: [...ownIds] });
                    onClose();
                  }}
                  title={isHiddenHere ? "Show their messages again" : "Hide their messages — only for you"}
                  className="px-2 py-1 rounded-md bg-scrim hover:bg-scrim-strong text-2xs text-strong transition-colors"
                >
                  {isHiddenHere ? "Show again" : "Hide"}
                </button>
              )}
            </>
          ) : undefined
        }
        avatar={
          pfp && avatarOk ? (
            <img
              src={pfp}
              alt={displayName}
              onError={() => setAvatarOk(false)}
              className="w-16 h-16 rounded-full object-cover"
            />
          ) : (
            <span
              className="w-16 h-16 rounded-full flex items-center justify-center text-xl font-bold text-strong"
              style={{ backgroundColor: msg.matrixId ? avatarBg(displayName) : color }}
            >
              {displayName.charAt(0).toUpperCase()}
            </span>
          )
        }
      />

      {/* Name (as chat renders it) + credit, then platform + membership. */}
      <div className="px-4 pt-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <StyledName
            name={displayName}
            color={msg.usernameColor ?? usernameColor(displayName)}
            style={msg.usernameStyle ?? null}
            badges={badgesForMatrixId(badges, siteId)}
            fit={1}
          />
          {linkedPlatforms.length > 0 && (
            <span
              className="flex items-center gap-1 text-body-dim"
              aria-label="Linked platforms"
              // Mods get the handles on hover as well as the list below — the
              // icon row is often all that's on screen once the card is narrow.
              title={handleTitle || undefined}
            >
              {linkedPlatforms.map((p) => <PlatformIcon key={p} platform={p} size={13} />)}
            </span>
          )}
          <CreditBadge credit={credit} className="text-sm" />
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-2xs text-secondary">{platformLabel(msg.platform)}</span>
          {pronouns && <span className="text-2xs text-secondary">· {pronouns}</span>}
          {data?.isMember && (
            <span className="text-3xs px-1 rounded bg-surface-2 text-body-dim">
              {data.subTier ?? "member"}
            </span>
          )}
        </div>
      </div>

      {/* Tier pills + factual stat pills, then the plugin's read directly
          beneath — the read is a sentence-long gloss on the same judgement the
          pills summarise, so it belongs under them with no heading of its own. */}
      <div className="px-4 pt-2.5">
        {data === null ? (
          <LoadingState />
        ) : !data.found ? (
          <EmptyState>No stream record for this user.</EmptyState>
        ) : (
          <div className="flex items-center flex-wrap gap-1.5">
            {chips.map((c, i) => (
              <span key={`${c.text}-${i}`} className={`text-2xs px-1.5 py-0.5 rounded ${pillClasses(c.role)}`}>
                {c.text}
              </span>
            ))}
            {typeof data.activity === "number" && <Pill label="Msgs">{data.activity}</Pill>}
            {typeof data.streams === "number" && data.streams > 0 && (
              <Pill label="Streams">{data.streams}</Pill>
            )}
          </div>
        )}
        {read && (
          // Shown in FULL — the card is content-fit now, so short prose just
          // wraps instead of costing a "more" click. (A rare long read simply
          // makes the card a little taller.)
          <p className="text-xs text-body-dim italic mt-1.5 leading-snug">
            {read}
          </p>
        )}
      </div>

      {/* Badge slots — a user equips their own; everyone else sees them read-only.
          Admins no longer hand-assign; this is just a view of their slots + unlocks. */}
      {msg.matrixId && (
        <div className="px-3 py-2 border-t border-edge">
          <BadgeSlots matrixId={msg.matrixId} editable={!!isOwnMessage} />
        </div>
      )}

      {/* Mods only: recent-chat scroll-back + the mod action strip, revealed
          together behind one collapsed-by-default toggle. History is server-
          backed (real scroll-back + search across this person's whole record).
          Non-mods get NEITHER — the public card stays a clean identity surface. */}
      {isMod && (
        <div className="border-t border-edge">
          <button
            type="button"
            onClick={() => setToolsOpen((o) => !o)}
            aria-expanded={toolsOpen}
            className="w-full flex items-center gap-1.5 px-3 py-2 text-2xs text-secondary hover:text-strong hover:bg-surface-1 transition-colors"
          >
            <ShieldStar size={13} weight="bold" />
            Identity, history &amp; tools
            <span className="ml-auto text-muted">{toolsOpen ? "▾" : "▸"}</span>
          </button>
          {toolsOpen && (
            <>
              {/* The message this card was opened from, fully inspectable —
                  the same details the mod panel's Chat history shows. A real stored line only. */}
              {msg.id != null && /^\d+$/.test(String(msg.id)) && !msg.system && (
                <div className="px-3 py-2 border-b border-edge">
                  <MessageDetails platform={msg.platform} id={msg.id} />
                </div>
              )}
              {/* Automod's suspicious mark, if any: why, the evidence, Clear (mods only). */}
              <MarkPanel matrixId={siteId ?? null} canonicalId={modIds.canonicalId} />
              {/* WHO THIS IS, everywhere. First in the section on purpose: a mod
                  deciding whether to act needs the identity before the history,
                  and "is the Twitch account shouting at us the same person as
                  this polite site account" is the question the rest of the tools
                  can't answer. Mod-only, enforced server-side. */}
              {(platformHandles.length > 0 || data?.matrixId) && (
                <div className="px-3 py-2 border-b border-edge space-y-0.5">
                  {platformHandles.map((h) => (
                    <div key={h.platform} className="flex items-center gap-1.5 text-2xs">
                      <PlatformIcon platform={h.platform} size={11} />
                      <span className="text-secondary w-16 shrink-0">{platformLabel(h.platform)}</span>
                      <span className="text-body-dim font-mono truncate">{h.username}</span>
                    </div>
                  ))}
                  {data?.matrixId && (
                    <div className="flex items-center gap-1.5 text-2xs pt-0.5">
                      <span className="text-secondary w-16 shrink-0 pl-[1.15rem]">matrix</span>
                      <span className="text-body-dim font-mono truncate">{data.matrixId}</span>
                    </div>
                  )}
                </div>
              )}
              {pronounTarget && (
                <div role="group" aria-label="Set their pronouns" className="px-3 py-2 border-b border-edge flex items-center gap-1 text-2xs">
                  <span className="text-secondary w-16 shrink-0">Pronouns</span>
                  {(["he/him", "she/her", "they/them"] as const).map((v) => (
                    <button key={v} type="button" onClick={() => void setTheirPronouns(v)} aria-pressed={pronouns === v}
                      className={`px-1.5 py-0.5 rounded transition-colors ${pronouns === v ? "bg-surface-2 text-strong" : "text-body-dim hover:text-strong hover:bg-surface-1"}`}>
                      {v}
                    </button>
                  ))}
                  {pronouns && (
                    <button type="button" onClick={() => void setTheirPronouns("clear")}
                      className="px-1.5 py-0.5 rounded text-muted hover:text-strong hover:bg-surface-1 transition-colors">
                      clear
                    </button>
                  )}
                </div>
              )}
              {badges.isAdmin && siteId && !isOwnMessage && targetIsMod !== null && (
                <div className="px-3 py-2 border-b border-edge text-2xs flex items-center gap-1">
                  <span className="text-secondary w-16 shrink-0">Role</span>
                  <span className="text-body-dim">{targetIsMod ? "Moderator" : "Member"}</span>
                  <button type="button" onClick={() => void setModRole(!targetIsMod)}
                    className="ml-auto px-1.5 py-0.5 rounded text-body-dim hover:text-strong hover:bg-surface-1 transition-colors">
                    {targetIsMod ? "Remove moderator" : "Make moderator"}
                  </button>
                </div>
              )}
              {badges.isAdmin && forgetTarget && (
                <div className="px-3 py-2 border-b border-edge text-2xs space-y-1">
                  {forgetStep === "idle" ? (
                    <button type="button" onClick={() => void askForget()}
                      className="px-1.5 py-0.5 rounded text-body-dim hover:text-strong hover:bg-surface-1 transition-colors">
                      Forget this person&apos;s AI memory
                    </button>
                  ) : forgetStep === "confirm" || forgetStep === "busy" ? (
                    <>
                      <p className="text-secondary">
                        Delete everything the bot remembers about {displayName} (all linked accounts)? Their chat
                        messages stay. This can&apos;t be undone.
                      </p>
                      <p className="text-muted">
                        {forgetPreview
                          ? `${forgetPreview.deleted} ${forgetPreview.deleted === 1 ? "entry" : "entries"} will be removed` +
                            (forgetPreview.lore ? `, including ${forgetPreview.lore} shared saved ${forgetPreview.lore === 1 ? "fact" : "facts"} that ${forgetPreview.lore === 1 ? "names" : "name"} them.` : ".")
                          : "Counting…"}
                      </p>
                      <div className="flex items-center gap-1">
                        <button type="button" disabled={forgetStep === "busy"} onClick={() => void forgetMemory()}
                          className="px-1.5 py-0.5 rounded bg-red-900/50 text-red-200 hover:bg-red-900/70 transition-colors disabled:opacity-50">
                          {forgetStep === "busy" ? "Forgetting…" : "Forget"}
                        </button>
                        <button type="button" disabled={forgetStep === "busy"} onClick={() => setForgetStep("idle")}
                          className="px-1.5 py-0.5 rounded text-muted hover:text-strong hover:bg-surface-1 transition-colors">
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <p role="status" className="text-secondary">{forgetStep}</p>
                  )}
                </div>
              )}
              {liveMessages && (msg.matrixId || msg.publicId) && (
                <UserChatHistory
                  lookupKey={modLookupKey}
                  matrixId={msg.matrixId}
                  publicId={msg.publicId}
                  liveMessages={liveMessages}
                />
              )}
              {/* Mod action strip. Sticky at the card's bottom with an opaque
                  fill: when the opened history makes the card taller than its
                  clamp, the body scrolls UNDER this bar instead of pushing the
                  actions off-screen — the tools a mod opened the section for
                  stay reachable without scrolling. */}
              <div className="sticky bottom-0 bg-panel px-3 py-2 border-t border-edge space-y-1.5">
          {actionErr && (
            <p className="text-2xs text-red-300 text-center">{actionErr}</p>
          )}
          {/* Reach: which platforms a mod action on this person can propagate to,
              shown BEFORE acting (green = your token, amber = via broadcaster,
              red = known there but nobody's token can act, — = no mod API). */}
          {knownReach.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-3xs uppercase tracking-wide text-muted shrink-0 mr-1">Reach</span>
              {knownReach.map((r) => {
                const state = r.unsupported ? "none" : r.canBan ?? "blocked";
                const cls =
                  state === "self" ? "bg-emerald-500/15 text-emerald-300"
                  : state === "broadcaster" ? "bg-amber-500/15 text-amber-300"
                  : state === "blocked" ? "bg-red-500/15 text-red-300"
                  : "bg-surface-2 text-muted";
                const title = r.unsupported
                  ? `${platformLabel(r.platform)} has no moderation API`
                  : r.canBan === "self" ? `Acts with your linked ${platformLabel(r.platform)} account`
                  : r.canBan === "broadcaster" ? `Acts via the broadcaster's ${platformLabel(r.platform)} account`
                  : `Known on ${platformLabel(r.platform)}, but no capable token — actions will be recorded as skipped`;
                return (
                  <span key={r.platform} className={`text-3xs px-1.5 py-0.5 rounded ${cls}`}
                    title={`${title}${r.liveOnly ? " (only while live)" : ""}`}>
                    {platformLabel(r.platform)}{r.liveOnly ? "*" : ""}
                  </span>
                );
              })}
            </div>
          )}
          {/* One row of icon actions. Five labelled full-width buttons stacked
              vertically was most of the card's height for something a mod uses
              at a glance; every action keeps its title/aria-label, so nothing is
              icon-only to a screen reader. */}
          {!modTargetId && !canonicalOnly ? (
            <>
              <div className="flex items-center gap-1">
                <ModIconButton label="Delete message" emoji="🗑" onClick={deleteMsg} tone="danger" />
                {modPanelButton}
              </div>
              <p className="text-3xs text-muted text-center">
                Timeout/ban unavailable — this message has no resolvable identity
              </p>
            </>
          ) : ban?.banned ? (
            // Currently timed out / banned → offer to lift it
            <>
              <p className="text-2xs text-yellow-400 text-center">
                {ban.expiresAt ? "Currently timed out" : "Currently banned"}
              </p>
              <div className="flex items-center gap-1">
                <ModIconButton label="Delete message" emoji="🗑" onClick={deleteMsg} tone="danger" />
                <ModIconButton
                  label={ban.expiresAt ? "Remove timeout" : "Unban"}
                  emoji="✅"
                  onClick={untimeout}
                  tone="good"
                />
                {modPanelButton}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-1">
                <ModIconButton label="Delete message" emoji="🗑" onClick={deleteMsg} tone="danger" />
                {/* Timeout + its length, as one unit. The number persists across
                    cards (localStorage) because a mod picks one duration and
                    reuses it; re-choosing from a preset row every time was the
                    only reason that row existed. */}
                <div className="flex items-center rounded bg-surface-2 focus-within:ring-1 focus-within:ring-edge-strong">
                  <button
                    type="button"
                    onClick={() => timeout(timeoutMins)}
                    title={`Time out for ${timeoutLabel(timeoutMins)}`}
                    aria-label={`Time out for ${timeoutLabel(timeoutMins)}`}
                    className="px-1.5 py-1 rounded-l hover:bg-yellow-900/60 text-xs transition-colors"
                  >
                    ⏱
                  </button>
                  <input
                    type="number"
                    min={1}
                    value={timeoutMins}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (!Number.isFinite(n) || n <= 0) return;
                      setTimeoutMins(n);
                      rememberTimeoutMins(n);
                    }}
                    aria-label="Timeout length in minutes"
                    title="Timeout length (minutes)"
                    className="w-9 bg-transparent text-2xs text-body-dim text-center outline-none tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  <span className="pr-1.5 text-3xs text-muted">m</span>
                </div>
                <ModIconButton
                  label={purgeArmed ? "Confirm: purge last 24h?" : "Purge last 24h"}
                  emoji="🧹"
                  tone={purgeArmed ? "armed" : "danger"}
                  disabled={!modTargetId && !canonicalOnly}
                  onClick={() => {
                    if (!purgeArmed) { setPurgeArmed(true); return; }
                    setPurgeArmed(false);
                    purgeUser();
                  }}
                  onMouseLeave={() => setPurgeArmed(false)}
                />
                <ModIconButton
                  label={banArmed ? "Confirm: ban permanently?" : "Ban permanently"}
                  emoji="🔨"
                  onClick={banUser}
                  tone={banArmed ? "armed" : "danger"}
                  onMouseLeave={() => setBanArmed(false)}
                />
                {modPanelButton}
              </div>
              {canonicalOnly && (
                // No site account: the action lands on their platform account(s)
                // via the identity graph, and the platforms hold the ban state —
                // so no "currently banned" readout; offer the lift inline instead.
                <p className="text-3xs text-muted text-center">
                  No {siteName()} account — applies on their platform account(s)
                  {" · "}
                  <button onClick={untimeout} className="underline hover:text-body-dim">
                    lift platform ban
                  </button>
                </p>
              )}
            </>
          )}
          {platformActions.length > 0 && (
            <div className="pt-1 mt-0.5 border-t border-edge space-y-0.5">
              <span className="text-3xs uppercase tracking-wide text-muted">Platform actions</span>
              {platformActions.map((a) => (
                <div key={a.id} className="flex items-center gap-1.5 text-2xs" title={a.detail ?? undefined}>
                  <span className={a.ok ? "text-green-400" : "text-red-400"}>{a.ok ? "✓" : "✗"}</span>
                  <span className="text-secondary capitalize">{a.platform} {a.action}</span>
                  {!a.ok && a.status != null && <span className="text-muted">({a.status})</span>}
                  <span className="text-muted ml-auto">{timeAgo(a.at)}</span>
                </div>
              ))}
            </div>
          )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
