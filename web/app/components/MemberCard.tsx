"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Room, RoomMember } from "matrix-js-sdk";
import { Avatar } from "@/app/components/Avatar";
import PlatformIcon from "@/app/components/PlatformIcon";
import { PresenceDot } from "@/app/components/PresenceDot";
import { memberName as displayName } from "@/app/lib/matrixDisplay";
import { senderLabel } from "@/app/lib/discordSender";
import { clampToViewport } from "@/app/lib/userCardLayout";
import { useOutsideClick } from "@/app/lib/useOutsideClick";
import { copyText } from "@/app/lib/clipboard";
import { usePresence, presenceOf, matrixSnapshotOf } from "@/app/lib/usePresence";
import { deriveState, presenceLine } from "@/app/lib/presenceState";
import { powerTier, canKick, canBan, isBannedIn, moderationSummary, type RoomOutcome, type SiteOutcome } from "@/app/lib/matrixModeration";
import { moderateEverywhere, type ModAction } from "@/app/lib/matrixModerate";
import { useSiteMod } from "@/app/lib/useSiteMod";

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
  const mayKick = canKick(room, myUserId) && member.userId !== myUserId;
  const banned = isBannedIn(room, member.userId);
  const mayBan = canBan(room, myUserId) && member.userId !== myUserId;
  const [pending, setPending] = useState<ModAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string[] | null>(null);

  async function siteBan(action: ModAction): Promise<SiteOutcome> {
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
        body: JSON.stringify({ targetId: member.userId }),
      });
      if (res.ok) return { attempted: true, ok: true };
      const text = (await res.text().catch(() => "")).trim();
      return { attempted: true, ok: false, reason: text && text.length < 120 ? text : undefined };
    } catch {
      return { attempted: true, ok: false };
    }
  }

  async function run(action: ModAction) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setPending(null);
    try {
      const scope = scopeRooms.map((r) => ({ roomId: r.roomId, name: r.name || r.roomId }));
      const rooms: RoomOutcome[] = await moderateEverywhere(room.client, action, scope, member.userId);
      const site = await siteBan(action);
      setResult(moderationSummary(action, rooms, site));
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
  const top = Math.max(8, Math.min(y, vh - 240));

  return createPortal(
    <div ref={cardRef} className="fixed z-(--z-menu) glass rounded-xl overflow-hidden p-3" style={{ left, top, width: W }}>
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          <Avatar mxcUrl={member.getMxcAvatarUrl()} name={memberName(member)} size={44} />
          <span className="absolute -bottom-0.5 -right-0.5"><PresenceDot state={state} size={14} /></span>
        </div>
        <div className="min-w-0">
          <p className="truncate text-shadow-chat" style={{ fontSize: "var(--text-chat-lg)", ...usernameStyle, color }}>
            {memberName(member)}
            {fromDiscord(member) && (
              <PlatformIcon platform="discord" size="0.85em" className="ml-1 inline-block align-baseline opacity-70" />
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
        <button type="button"
          onClick={() => { setPending(null); void copyText(member.userId); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
          className="w-full text-sm px-3 py-1.5 rounded-md text-body-dim hover:bg-surface-2 transition-colors">
          {copied ? "Copied!" : "Copy user ID"}
        </button>
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
