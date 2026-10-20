"use client";

import { CHAT_FONT } from "@/app/lib/chatFont";
import { useState, useEffect, useMemo } from "react";
import { RoomStateEvent } from "matrix-js-sdk";
import type { Room, RoomMember } from "matrix-js-sdk";
import { Avatar } from "@/app/components/Avatar";
import PlatformIcon from "@/app/components/PlatformIcon";
import { PresenceDot } from "@/app/components/PresenceDot";
import { useUserColors, useWantUserStyles } from "@/app/lib/useUserColors";
import { usernameColor } from "@/app/lib/avatarColor";
import { memberContentColor } from "@/app/lib/matrixProfileColor";
import { usePresence, presenceOf, matrixSnapshotOf } from "@/app/lib/usePresence";
import { deriveState, presenceLine } from "@/app/lib/presenceState";
import { groupMembers, type MemberView, type Category } from "@/app/lib/memberGroups";
import { MemberCard, memberName, fromDiscord, usernameStyle } from "@/app/components/MemberCard";
import { siteName } from "@/app/lib/siteName";

// The members list: Admin > Moderators > Supporters > Members >
// Discord, live people first inside each, a 14-day fold into "Inactive", the
// Discord group collapsed by default (ghosts carry no presence and no
// reachable "last active"), and the on-site counts in the heading.

const OPEN_KEY = "bb_members-open";
type GroupKey = Category | "inactive";
const DEFAULT_OPEN: Record<GroupKey, boolean> = { admin: true, mods: true, supporters: true, members: true, discord: false, inactive: false };

function readOpen(): Record<GroupKey, boolean> {
  try {
    const raw = sessionStorage.getItem(OPEN_KEY);
    return raw ? { ...DEFAULT_OPEN, ...(JSON.parse(raw) as Partial<Record<GroupKey, boolean>>) } : DEFAULT_OPEN;
  } catch { return DEFAULT_OPEN; }
}

// Username colour with the same precedence as the message row: explicit
// per-user colour → the member event's username-colour field → deterministic hash.
function memberColor(m: RoomMember, userColors: Record<string, string>): string {
  const fromMember = memberContentColor(m.events?.member?.getContent() as Record<string, unknown> | undefined);
  return userColors[m.userId] ?? fromMember ?? usernameColor(memberName(m));
}

export function MemberList({ room, myUserId, onMessage, moderationScope }: {
  room: Room;
  myUserId?: string;
  /** Open (or create) a DM with this user — shown as "Message" on the card. */
  onMessage?: (userId: string) => void;
  /** Which channels one moderation action from this list's card covers. */
  moderationScope?: () => Room[];
}) {
  const userColors = useUserColors();
  const [members, setMembers] = useState<RoomMember[]>(() => room.getJoinedMembers());
  useWantUserStyles(members.map((m) => m.userId));
  const [card, setCard] = useState<{ m: RoomMember; x: number; y: number } | null>(null);
  const [open, setOpen] = useState<Record<GroupKey, boolean>>(readOpen);
  const dir = usePresence();
  // `Date.now()` is impure and react-hooks/purity refuses it inside useMemo
  // (the brief's own form). This is the escape hatch MemberCard.tsx already
  // uses for the same rule, event-driven instead of a lazy one-shot: `now`
  // re-reads whenever the inputs the grouping depends on change, deferred a
  // microtask so the setState lands outside the effect pass.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { Promise.resolve().then(() => setNow(Date.now())); }, [dir, members]);

  useEffect(() => {
    const refresh = () => setMembers(room.getJoinedMembers());
    room.loadMembersIfNeeded().then(refresh).catch(() => {});
    // Room emits RoomState.members on join/leave/membership changes; a
    // RoomMember-level membership/powerLevel listener never fires here — Room
    // itself never emits those — so don't re-add one.
    room.on(RoomStateEvent.Members, refresh);
    return () => { room.off(RoomStateEvent.Members, refresh); };
  }, [room]);

  const toggle = (k: GroupKey) => setOpen((o) => {
    const next = { ...o, [k]: !o[k] };
    try { sessionStorage.setItem(OPEN_KEY, JSON.stringify(next)); } catch {}
    return next;
  });

  // The rule runs once per poll tick / membership change, not per render.
  const { groups, inactive, byId } = useMemo(() => {
    const byId = new Map<string, { m: RoomMember; view: MemberView; lastActive: number | null; site: ReturnType<typeof presenceOf> }>();
    // Not just `!!dir`: a directory answer with an empty users map is
    // indistinguishable from "no answer yet" (in practice it means the route
    // failed before it could 500 the poller into keeping the last good dir —
    // see loadPresenceDirectory's now-unswallowed error), so treat it the
    // same as unknown rather than as "confirmed, nobody's here".
    const known = !!dir && Object.keys(dir.users).length > 0;
    const views: MemberView[] = members.map((m) => {
      const site = presenceOf(dir, m.userId);
      const { state, lastActive, inactive } = deriveState(site, matrixSnapshotOf(room, m.userId), now);
      const view: MemberView = {
        userId: m.userId, label: memberName(m), powerLevel: m.powerLevel, fromDiscord: fromDiscord(m),
        // Before the directory's first real answer, `known` is false and every
        // site-only member reads back with no lastActive — that's "unknown",
        // not "unseen for 14 days", so the fold waits for a real answer
        // instead of folding (nearly) the whole list for the length of one
        // network round-trip or a directory error.
        supporter: site?.supporter ?? false, state, inactive: known ? inactive : false,
      };
      byId.set(m.userId, { m, view, lastActive, site });
      return view;
    });
    return { ...groupMembers(views), byId };
  }, [members, dir, room, now]);

  const rows = (list: MemberView[]) => list.map((v) => {
    const entry = byId.get(v.userId);
    if (!entry) return null;
    const { m, lastActive, site } = entry;
    return (
      <button key={v.userId} type="button" data-member={v.userId}
        onClick={(e) => setCard({ m, x: e.currentTarget.getBoundingClientRect().left, y: e.clientY })}
        className="w-full px-3 py-1 flex items-center gap-2 hover:bg-surface-1 rounded-md text-left transition-colors">
        <span className="relative shrink-0">
          <Avatar mxcUrl={m.getMxcAvatarUrl()} name={v.label} size={26} />
          <span className="absolute -bottom-0.5 -right-0.5">
            <PresenceDot state={v.state} title={presenceLine(v.state, lastActive, now)} />
          </span>
        </span>
        <span className="flex-1 min-w-0">
          <span className="block truncate text-shadow-chat" style={{ fontSize: CHAT_FONT, ...usernameStyle, color: memberColor(m, userColors) }}>
            {v.label}
            {v.fromDiscord && <PlatformIcon platform="discord" size="0.85em" className="ml-1 inline-block align-baseline opacity-70" />}
          </span>
          {site?.statusText && <span data-status-text className="block truncate text-3xs text-muted">{site.statusText}</span>}
        </span>
        {m.powerLevel >= 100 && <span className="shrink-0 text-3xs" title="Admin">👑</span>}
        {m.powerLevel >= 50 && m.powerLevel < 100 && <span className="shrink-0 text-3xs" title="Moderator">🛡️</span>}
      </button>
    );
  });

  // A heading that never collapses is not a control — rendering it as a
  // button gave keyboard/AT users a focus stop that does nothing on
  // activation. Only the two collapsible headings (Discord, Inactive) are
  // buttons, and they carry aria-expanded so their state is announced.
  const heading = (key: GroupKey, label: string, count: number, collapsible: boolean, shown?: boolean) =>
    collapsible ? (
      <button type="button" data-group={key} aria-expanded={!!shown} onClick={() => toggle(key)}
        className="w-full px-3 text-3xs uppercase tracking-wider text-muted mb-1 text-left hover:text-body">
        {label} — {count}
      </button>
    ) : (
      <p data-group={key} className="w-full px-3 text-3xs uppercase tracking-wider text-muted mb-1 text-left cursor-default">
        {label} — {count}
      </p>
    );

  return (
    <div className="h-full overflow-y-auto no-scrollbar py-2">
      {dir && (
        <p data-presence-counts className="px-3 pb-2 text-3xs text-muted">
          {dir.counts.onSite} on {siteName()} · {dir.counts.inCommunity} in the community
        </p>
      )}
      {groups.map((g) => {
        const collapsible = g.key === "discord";
        const shown = collapsible ? open[g.key] : true;
        return (
          <div key={g.key} className="mb-2">
            {heading(g.key, g.label, g.members.length, collapsible, shown)}
            <div data-group-rows={g.key}>{shown && rows(g.members)}</div>
          </div>
        );
      })}
      {inactive.length > 0 && (
        <div className="mb-2">
          {heading("inactive", "Inactive", inactive.length, true, open.inactive)}
          <div data-group-rows="inactive">{open.inactive && rows(inactive)}</div>
        </div>
      )}

      {card && (
        <MemberCard member={card.m} room={room} x={card.x} y={card.y} side="left"
          color={memberColor(card.m, userColors)}
          canMessage={!!onMessage && card.m.userId !== myUserId}
          onMessage={() => { onMessage?.(card.m.userId); setCard(null); }}
          scopeRooms={moderationScope ? moderationScope() : [room]}
          myUserId={myUserId ?? ""}
          onClose={() => setCard(null)} />
      )}
    </div>
  );
}
