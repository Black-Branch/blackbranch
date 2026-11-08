"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Room, RoomMember } from "matrix-js-sdk";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api/CryptoEvent.js";
import { ShieldCheck } from "@phosphor-icons/react/dist/ssr";
import { Avatar } from "@/app/components/Avatar";
import PlatformIcon from "@/app/components/PlatformIcon";
import { PresenceDot } from "@/app/components/PresenceDot";
import { memberName as displayName, memberAvatar } from "@/app/lib/matrixDisplay";
import {
  HISTORY_WINDOWS, banConfirmText, deleteConfirmText, deleteHistoryAfterBan, refusalOf,
  type HistoryRunDeps, type HistoryWindow,
} from "@/app/lib/banHistory";
import { redactHistory, type RedactClient } from "@/app/lib/matrixRedactHistory";
import { senderLabel } from "@/app/lib/discordSender";
import { clampToViewport } from "@/app/lib/userCardLayout";
import { useOutsideClick } from "@/app/lib/useOutsideClick";
import { copyText } from "@/app/lib/clipboard";
import { usePresence, presenceOf, matrixSnapshotOf } from "@/app/lib/usePresence";
import { deriveState, presenceLine } from "@/app/lib/presenceState";
import { powerTier, canKick, canBan, isBannedIn, moderationSummary, type RoomOutcome, type SiteOutcome } from "@/app/lib/matrixModeration";
import { moderateEverywhere, type ModAction } from "@/app/lib/matrixModerate";
import { useSiteMod } from "@/app/lib/useSiteMod";
import { TimeoutAction } from "@/app/components/TimeoutAction";
import { findDmRoom, roomForSending, NOT_PRIVATE } from "@/app/lib/matrixDm";
import { useMatrixClient } from "@/app/lib/MatrixClientContext";
import { getDmRoomIds } from "@/app/lib/matrixRooms";

// The one member card: opened from the members list AND from any
// message row / reply quote. It also carries kick/ban/unban.

export const memberName = (m: RoomMember) => senderLabel(displayName(m, m.userId), m.userId).label;
export const fromDiscord = (m: RoomMember) => senderLabel(displayName(m, m.userId), m.userId).fromDiscord;

export const usernameStyle: React.CSSProperties = {
  fontFamily: "var(--chat-username-font, inherit)",
  fontWeight: "var(--chat-username-weight, 600)" as React.CSSProperties["fontWeight"],
  filter: "saturate(var(--chat-username-sat, 1))",
};

type MemberCardProps = {
  member: RoomMember;
  room: Room;
  x: number;
  y: number;
  /** Which side of x the card opens on: the members panel hugs the right edge
   *  (open left); a message row's avatar sits at the left (open right). */
  side: "left" | "right";
  color: string;
  canMessage: boolean;
  onMessage: () => void;
  onClose: () => void;
  /** The channels one moderation action covers: every channel in the server
   *  the viewer is in, plus the server room itself. A DM is just itself. */
  scopeRooms: Room[];
  myUserId: string;
};

export function MemberCard({ member, room, x, y, side, color, canMessage, onMessage, onClose, scopeRooms, myUserId }: MemberCardProps) {
  const [copied, setCopied] = useState(false);
  const tier = powerTier(member.powerLevel);
  const cardRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  useOutsideClick(cardRef, onClose, { escape: true });
  const dir = usePresence();
  const site = presenceOf(dir, member.userId);
  // Captured once at mount, not a live tick — the card is ephemeral (opened on
  // click, unmounted on close), so "when this card was opened" is `now` for
  // its whole life. A bare `Date.now()` here trips react-hooks/purity; the
  // lazy useState initializer is the escape hatch this codebase already uses
  // for the same shape (DeviceSection.tsx, PollCard.tsx).
  const [now] = useState(() => Date.now());
  const { state, lastActive } = deriveState(site, matrixSnapshotOf(room, member.userId), now);

  // Kick/ban/unban. scopeRooms/myUserId thread the server-wide fan-out
  // in; ghost/mayKick/mayBan/banned all read plain props+room state so they are
  // safe above the early return below.
  const isSiteMod = useSiteMod();
  const ghost = fromDiscord(member);
  // A direct conversation is not moderated from its card (client polish Task 11, ruling 2): both
  // members hold power there, so Kick/Ban would let either one throw the other out of a 1:1 (and
  // a site mod's Ban would fan a site ban out from a DM row). Discord's DM profile offers Block,
  // which the DM window has; site mods ban from the Community card or the mod tools. The DM test
  // is Timeline's (matrixRooms.dmPartner): filed in m.direct, or a DM invite.
  const inDm = getDmRoomIds(room.client).has(room.roomId) || !!room.getDMInviter();
  const mayKick = !inDm && canKick(room, myUserId) && member.userId !== myUserId;
  const banned = isBannedIn(room, member.userId);
  const mayBan = !inDm && canBan(room, myUserId) && member.userId !== myUserId;
  // "history" = deleting the message history of someone already banned (the retry a ban made
  // outside the community points at).
  const [pending, setPending] = useState<ModAction | "history" | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string[] | null>(null);
  // Ban's two message choices (banHistory.ts): the community history (default none, ADR 0116) and
  // the site-chat purge every ban runs (ticket #228, on unless turned off for this one).
  const [historyWindow, setHistoryWindow] = useState<HistoryWindow>("none");
  const [sitePurge, setSitePurge] = useState(true);
  const [progress, setProgress] = useState<string | null>(null);
  const siteBanApplies = !ghost && isSiteMod;
  // The card's real height, so it is placed wholly on screen: the Ban choices make it taller than
  // a phone has room for below the row that opened it.
  const [cardH, setCardH] = useState(240);
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setCardH(el.offsetHeight || 240));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Person-to-person verification: "Verify <name>" while they are not verified, a shield once they
  // are. Only for someone with encryption set up (a request to anyone else is never answered), never
  // for yourself or a bridged Discord member. The request goes in a direct conversation; when there
  // is none, the card asks before one is opened. The prompt (UserVerificationPrompt) runs the emoji.
  const { offerVerification } = useMatrixClient();
  const [trust, setTrust] = useState<"verified" | "unverified" | null>(null);
  const [askDm, setAskDm] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const verifiable = member.userId !== myUserId && !ghost;
  useEffect(() => {
    const crypto = verifiable ? room.client.getCrypto?.() : undefined;
    if (!crypto) return;
    let live = true;
    const read = async () => {
      const has = await crypto.userHasCrossSigningKeys(member.userId, true).catch(() => false);
      const verified = has && (await crypto.getUserVerificationStatus(member.userId).catch(() => null))?.isCrossSigningVerified();
      if (live) setTrust(!has ? null : verified ? "verified" : "unverified");
    };
    const onTrust = (userId: string) => { if (userId === member.userId) void read(); };
    void read();
    room.client.on(CryptoEvent.UserTrustStatusChanged, onTrust);
    return () => { live = false; room.client.off(CryptoEvent.UserTrustStatusChanged, onTrust); };
  }, [verifiable, room.client, member.userId]);

  async function verify() {
    const crypto = room.client.getCrypto?.();
    if (!crypto || verifyBusy) return;
    setPending(null);
    setVerifyError(null);
    setVerifyBusy(true);
    try {
      // Members loaded first, so an existing conversation is found (and no needless question asked).
      const existing = await findDmRoom(room.client, member.userId);
      if (!existing && !askDm) { setAskDm(true); return; }
      // The DM gate every line goes through: that room or a new one, private, checked right before use.
      const dm = await roomForSending(room.client, member.userId, existing?.roomId);
      offerVerification(await crypto.requestVerificationDM(member.userId, dm.roomId));
      onClose();
    } catch (e) {
      setVerifyError(e instanceof Error && e.message === NOT_PRIVATE ? NOT_PRIVATE : "Couldn't start verification. Try again.");
    } finally {
      setVerifyBusy(false);
    }
  }

  /** The site half, and what a ban's own site-chat purge removed (null when it did not run). */
  async function siteBan(action: ModAction): Promise<SiteOutcome & { purged?: number | null; batchId?: string | null }> {
    // A kick has no site half at all — checked FIRST, because a bridged
    // (Discord) member is always a ghost too, and checking ghost first made
    // kicking one print "No site ban — they have no account here.", which
    // implies a site ban was ever in play for a kick. It never is (defect #6).
    if (action === "kick") return { attempted: false, ok: false };
    // A bridged member has no `site.users` row, and `site.bans.matrix_id` is a
    // foreign key into it — attempting the insert would fail with a FK error
    // that reads like a bug. Skip by construction and say so.
    if (ghost) return { attempted: false, ok: false, reason: "they have no account here" };
    if (!isSiteMod) return { attempted: false, ok: false, reason: "your account can't apply a site ban" };
    try {
      const res = await fetch("/api/mod/ban", {
        method: action === "ban" ? "POST" : "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "ban" ? { targetId: member.userId, purge: sitePurge } : { targetId: member.userId }),
      });
      if (res.ok) {
        const d = (await res.json().catch(() => ({}))) as { purged?: unknown; batchId?: unknown };
        return {
          attempted: true, ok: true,
          purged: typeof d.purged === "number" ? d.purged : null,
          batchId: typeof d.batchId === "string" ? d.batchId : null,
        };
      }
      const text = (await res.text().catch(() => "")).trim();
      return { attempted: true, ok: false, reason: text && text.length < 120 ? text : undefined };
    } catch {
      return { attempted: true, ok: false };
    }
  }

  const scope = () => scopeRooms.map((r) => ({ roomId: r.roomId, name: r.name || r.roomId }));

  // The community part of "Delete message history", in this card's own client and scope.
  const historyDeps = (): HistoryRunDeps => ({
    // The site's ceiling first: Matrix lets a power-50 mod redact anyone's lines, Staff and admins too.
    check: async (targetId) => refusalOf(await fetch(`/api/mod/ban-history?targetId=${encodeURIComponent(targetId)}`).catch(() => null)),
    redact: (since) => redactHistory(room.client as unknown as RedactClient, scope(), member.userId, since, undefined,
      (done, total) => setProgress(`Removing messages… ${done}/${total}`)),
    post: async (body) => {
      const res = await fetch("/api/mod/ban-history", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }).catch(() => null);
      return !!res?.ok;
    },
  });

  async function deleteHistory(window: HistoryWindow, siteRemoved: number | null, batchId: string | null): Promise<string | null> {
    try {
      return await deleteHistoryAfterBan(historyDeps(), { targetId: member.userId, window, now: Date.now(), siteRemoved, batchId });
    } catch {
      return "Community messages weren't removed — try again from their member card.";
    } finally {
      setProgress(null);
    }
  }

  async function run(action: ModAction | "history") {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setPending(null);
    try {
      if (action === "history") {
        const line = await deleteHistory(historyWindow, null, null);
        setResult(line ? [line] : null);
        return;
      }
      const rooms: RoomOutcome[] = await moderateEverywhere(room.client, action, scope(), member.userId);
      const site = await siteBan(action);
      const lines = moderationSummary(action, rooms, site);
      setResult(lines);
      // The ban first (no new lines while their history goes), then their community lines — only when
      // the ban took effect: the site ban for a site account (its ceiling said yes), the room bans
      // for a bridged member, who has no site half. A refused ban deletes nothing.
      const tookEffect = site.attempted ? site.ok : rooms.some((r) => r.status !== "failed");
      if (action === "ban" && historyWindow !== "none" && tookEffect) {
        const line = await deleteHistory(historyWindow, site.ok ? site.purged ?? null : null, site.ok ? site.batchId ?? null : null);
        if (line) setResult([...lines, line]);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const n = scopeRooms.length;
  const channels = `${n} ${n === 1 ? "channel" : "channels"}`;

  if (typeof document === "undefined") return null;
  const W = 232;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = clampToViewport(side === "left" ? x - W - 8 : x + 8, W, vw);
  const top = Math.max(8, Math.min(y, vh - cardH - 8));

  return createPortal(
    <div ref={cardRef} className="fixed z-(--z-menu) glass rounded-xl overflow-x-hidden overflow-y-auto overscroll-contain p-3"
      style={{ left, top, width: W, maxHeight: "calc(100dvh - 16px)" }}>
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          <Avatar mxcUrl={memberAvatar(member)} name={memberName(member)} size="xl" />
          <span className="absolute -bottom-0.5 -right-0.5"><PresenceDot state={state} size={14} /></span>
        </div>
        <div className="min-w-0">
          {/* The name truncates on its own; the marks sit beside it, so a long name's ellipsis
              never cuts them off. */}
          <p className="flex items-baseline min-w-0 text-shadow-chat" style={{ fontSize: "var(--text-chat-lg)", ...usernameStyle, color }}>
            <span className="truncate">{memberName(member)}</span>
            {fromDiscord(member) && (
              <PlatformIcon platform="discord" size="0.85em" className="ml-1 shrink-0 inline-block align-baseline opacity-70" />
            )}
            {trust === "verified" && (
              <ShieldCheck aria-label="Verified" role="img" weight="fill" size="0.85em" className="ml-1 shrink-0 inline-block self-center text-green-400" />
            )}
          </p>
          <p className="truncate text-muted" style={{ fontSize: "var(--chat-ts-size, 0.72rem)" }}>{member.userId}</p>
        </div>
      </div>

      <p className="mt-2 text-xs text-secondary">{presenceLine(state, lastActive, now)}</p>
      {site?.statusText && <p className="mt-0.5 text-xs italic text-body-dim truncate">{site.statusText}</p>}

      <div className="mt-2 flex items-center gap-1.5">
        <span className="text-2xs px-2 py-0.5 rounded-full bg-surface-2 text-body-dim">{tier.label}</span>
        {site?.supporter && (
          <span className="text-2xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300">Supporter</span>
        )}
        {tier.showNumber && <span className="text-2xs text-muted">power {member.powerLevel}</span>}
      </div>

      <div className="mt-3 flex flex-col gap-1">
        {canMessage && (
          // A press anywhere else on the card resets an armed two-step
          // confirm (defect #9) — arming Ban and then pressing Message must
          // not leave Ban still armed for whatever the card shows next.
          <button type="button" onClick={() => { setPending(null); onMessage(); }}
            className="w-full text-sm px-3 py-1.5 rounded-md text-on-accent font-semibold hover:brightness-110 transition-all"
            style={{ backgroundColor: "var(--accent)" }}>
            Message
          </button>
        )}
        {trust === "unverified" && !askDm && (
          <button type="button" disabled={verifyBusy} onClick={() => void verify()}
            className="w-full text-sm px-3 py-1.5 rounded-md text-body-dim hover:bg-surface-2 transition-colors">
            Verify {memberName(member)}
          </button>
        )}
        {trust === "unverified" && askDm && (
          <div className="rounded-md bg-surface-2 p-2 text-xs text-body-dim">
            <p>Verifying opens a direct conversation with {memberName(member)}. Continue?</p>
            <div className="mt-1.5 flex gap-1.5">
              <button type="button" disabled={verifyBusy} onClick={() => void verify()}
                className="flex-1 px-2 py-1 rounded-md text-on-accent font-semibold" style={{ backgroundColor: "var(--accent)" }}>
                Continue
              </button>
              <button type="button" onClick={() => setAskDm(false)}
                className="flex-1 px-2 py-1 rounded-md hover:bg-surface-3 transition-colors">
                Cancel
              </button>
            </div>
          </div>
        )}
        {verifyError && <p role="status" className="text-2xs text-red-300">{verifyError}</p>}
        <button type="button"
          onClick={() => { setPending(null); setAskDm(false); void copyText(member.userId); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
          className="w-full text-sm px-3 py-1.5 rounded-md text-body-dim hover:bg-surface-2 transition-colors">
          {copied ? "Copied!" : "Copy user ID"}
        </button>
        {/* The site's own timeout: a site mod's, whatever their power in this channel. */}
        {isSiteMod && !ghost && member.userId !== myUserId && (
          <TimeoutAction userId={member.userId} onOpen={() => setPending(null)} />
        )}
        {(mayKick || mayBan) && (
          <>
            <div className="mt-1 pt-2 border-t border-edge" />
            {ghost && (
              <p className="text-2xs text-body-dim">
                They are on Discord. This removes them here, not on Discord.
              </p>
            )}
            {mayKick && !banned && (
              <button type="button" disabled={busy}
                onClick={() => (pending === "kick" ? void run("kick") : setPending("kick"))}
                className="w-full text-sm px-3 py-1.5 rounded-md text-body-dim hover:bg-surface-2 transition-colors">
                {pending === "kick" ? `Confirm kick from ${channels}?` : "Kick"}
              </button>
            )}
            {mayBan && !banned && pending === "ban" && (
              <div className="flex flex-col gap-1 rounded-md bg-surface-2 p-2 text-2xs text-body-dim">
                {/* A site moderator's tool: the site's ceiling decides whose history they may delete. */}
                {isSiteMod && (
                  <label className="flex flex-col gap-0.5">
                    <span>Delete message history</span>
                    <select aria-label="Delete message history" value={historyWindow}
                      onChange={(e) => setHistoryWindow(e.target.value as HistoryWindow)}
                      className="rounded-md bg-surface-1 border border-edge px-1.5 py-1 text-xs text-body outline-none">
                      {HISTORY_WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                    </select>
                  </label>
                )}
                {siteBanApplies && (
                  <label className="flex items-center gap-1.5 select-none">
                    <input type="checkbox" data-site-purge="" checked={sitePurge} onChange={(e) => setSitePurge(e.target.checked)} />
                    Also remove their site chat from the last 24 hours
                  </label>
                )}
                <p data-ban-confirm-text="">{banConfirmText(memberName(member), historyWindow, siteBanApplies && sitePurge)}</p>
              </div>
            )}
            {mayBan && !banned && (
              <button type="button" disabled={busy}
                onClick={() => (pending === "ban" ? void run("ban") : setPending("ban"))}
                className="w-full text-sm px-3 py-1.5 rounded-md text-red-300 hover:bg-red-500/15 transition-colors">
                {/* The reach is undisclosed otherwise (defect #1): a site ban
                    AND a fan-out to Twitch/Kick/YouTube (not every platform —
                    stream.place has no ban call, so this never claims "all")
                    ride along with every Matrix ban. Neither happens for a
                    ghost (siteBan() short-circuits for them) or for a viewer
                    without site-mod rights (siteBan() refuses them too), so
                    the disclosure only applies when both hold. */}
                {pending === "ban"
                  ? `Confirm ban from ${channels}${ghost || !isSiteMod ? "" : ", the site and platforms"}?`
                  : "Ban"}
              </button>
            )}
            {mayBan && banned && (
              <button type="button" disabled={busy}
                onClick={() => (pending === "unban" ? void run("unban") : setPending("unban"))}
                className="w-full text-sm px-3 py-1.5 rounded-md text-body-dim hover:bg-surface-2 transition-colors">
                {pending === "unban" ? `Confirm unban in ${channels}?` : "Unban"}
              </button>
            )}
            {mayBan && banned && isSiteMod && pending === "history" && (
              <div className="flex flex-col gap-1 rounded-md bg-surface-2 p-2 text-2xs text-body-dim">
                <select aria-label="Delete message history" value={historyWindow}
                  onChange={(e) => setHistoryWindow(e.target.value as HistoryWindow)}
                  className="rounded-md bg-surface-1 border border-edge px-1.5 py-1 text-xs text-body outline-none">
                  {HISTORY_WINDOWS.filter((w) => w.value !== "none").map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                </select>
                <p data-ban-confirm-text="">{deleteConfirmText(memberName(member), historyWindow === "7d" ? "7d" : "1h")}</p>
              </div>
            )}
            {mayBan && banned && isSiteMod && (
              <button type="button" disabled={busy}
                onClick={() => {
                  if (pending === "history") { void run("history"); return; }
                  // Here the action IS the deletion: it opens on the shorter window.
                  if (historyWindow === "none") setHistoryWindow("1h");
                  setPending("history");
                }}
                className="w-full text-sm px-3 py-1.5 rounded-md text-red-300 hover:bg-red-500/15 transition-colors">
                {pending === "history" ? "Confirm delete" : "Delete message history"}
              </button>
            )}
            {progress && <p role="status" className="mt-1 text-2xs text-body-dim">{progress}</p>}
            {result && (
              <div role="status" className="mt-1 text-2xs text-body-dim space-y-0.5">
                {result.map((line) => <p key={line}>{line}</p>)}
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
