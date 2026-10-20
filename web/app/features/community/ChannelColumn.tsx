"use client";

import { CHAT_FONT } from "@/app/lib/chatFont";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import type { Room } from "matrix-js-sdk";
import { ClientEvent } from "matrix-js-sdk";
import { Bar } from "@/app/components/chrome";
import { Avatar } from "@/app/components/Avatar";
import { UnreadDot } from "./parts";
import { memberName } from "@/app/lib/matrixDisplay";
import { senderLabel } from "@/app/lib/discordSender";
import PlatformIcon from "@/app/components/PlatformIcon";
import { lsGet, lsSet } from "@/app/lib/safeLocalStorage";
import {
  roomUnreads,
  aggregateUnreads,
  allChannelsInNode,
  dmPartner,
  isForumRoom,
  type SpaceNode,
  type RailServer,
} from "@/app/lib/matrixRooms";
import { Chats, CaretDown } from "@phosphor-icons/react/dist/ssr";
import { useLongPress } from "@/app/lib/useLongPress";
import { NotificationMenu } from "./NotificationMenu";
import { siteName } from "@/app/lib/siteName";
import { useSetting } from "@/app/lib/useSetting";
import { useMatrixClient } from "@/app/lib/MatrixClientContext";
import { roomNotifySetting, type RuleSet } from "@/app/lib/pushRules";

// Community › Channel list, read once by the column and handed to every row:
// counts instead of dots, and whether a muted channel (bell = Off — the
// push-rule mute) is left out. The open channel is never hidden, so muting the
// one you are reading does not yank it away.
type ListPrefs = { counts: boolean; hideMuted: boolean; muted: (r: Room) => boolean };

// Discord-style channel column: header + channel rows + collapsible sub-space
// "channel-groups". Home mode swaps the body for DMs + pinned channels.

/** Right-click or long-press on a channel row: open the shared notification
 *  menu at this position, anchored on the element the gesture landed on. */
type OnMenu = (r: Room, x: number, y: number, anchor: HTMLElement | null) => void;


function ChannelRow({
  room,
  active,
  onSelect,
  onMenu,
  prefs,
}: {
  room: Room;
  active: boolean;
  onSelect: (r: Room) => void;
  /** Right-click or long-press: open the shared notification menu at this position. */
  onMenu: OnMenu;
  prefs: ListPrefs;
}) {
  const { total, highlight } = roomUnreads(room);
  const unread = total > 0;
  const forum = isForumRoom(room);
  // The row's own button, passed to onMenu as the menu's anchor — a repeat
  // right-click/long-press on this SAME row must not fire the menu's own
  // outside-click first and re-open it (same fix as the header bell).
  const rowRef = useRef<HTMLButtonElement>(null);
  const longPress = useLongPress((pos) => onMenu(room, pos.x, pos.y, rowRef.current));
  if (prefs.hideMuted && !active && prefs.muted(room)) return null;
  return (
    <button
      ref={rowRef}
      type="button"
      onClick={() => onSelect(room)}
      {...longPress}
      // On a coarse pointer this can call onMenu TWICE for one press — once
      // from useLongPress's own 350ms timer, once from the native
      // `contextmenu` Chrome/Android also raises past its long-press
      // threshold, which lands here too. Harmless: setMenu(room,x,y) is
      // idempotent and both calls carry the same room at nearly the same
      // position. Do not "fix" this by dropping the explicit handler below —
      // it is what makes a plain desktop right-click open the menu at all.
      onContextMenu={(e) => { e.preventDefault(); onMenu(room, e.clientX, e.clientY, rowRef.current); }}
      className={`group/c w-full text-left flex items-center gap-1.5 rounded-md pl-2 pr-2 py-1 mx-1 transition-colors ${
        active
          ? "bg-surface-2 text-strong"
          : unread
          ? "text-heading hover:bg-surface-1"
          : "text-secondary hover:bg-surface-1 hover:text-body"
      }`}
      style={{ width: "calc(100% - 0.5rem)" }}
    >
      {forum ? (
        <span className="text-muted group-hover/c:text-secondary shrink-0 flex items-center" title="Forum">
          <Chats size={13} weight="bold" />
        </span>
      ) : (
        <span className="text-muted group-hover/c:text-secondary shrink-0" style={{ fontSize: "var(--text-chat-lg)" }}>
          #
        </span>
      )}
      <span
        className={`truncate min-w-0 flex-1 text-shadow-chat ${unread && !active ? "font-medium" : ""}`}
        style={{ fontSize: CHAT_FONT }}
      >
        {room.name || room.roomId}
      </span>
      <UnreadDot total={total} highlight={highlight} counts={prefs.counts} className="w-1.5 h-1.5 shrink-0" />
    </button>
  );
}

function DMRow({
  room,
  myUserId,
  dmRoomIds,
  active,
  onSelect,
  counts,
}: {
  room: Room;
  myUserId: string;
  dmRoomIds: Set<string>;
  active: boolean;
  onSelect: (r: Room) => void;
  counts: boolean;
}) {
  const { total, highlight } = roomUnreads(room);
  const partner = dmPartner(room, myUserId, dmRoomIds);
  const partnerLabel = partner ? senderLabel(memberName(partner, partner.userId), partner.userId) : null;
  const label = partnerLabel ? partnerLabel.label : room.name || room.roomId;
  return (
    <button
      type="button"
      onClick={() => onSelect(room)}
      className={`w-full text-left flex items-center gap-2 rounded-md px-2 py-1 mx-1 transition-colors ${
        active ? "bg-surface-2 text-strong" : total > 0 ? "text-heading hover:bg-surface-1" : "text-secondary hover:bg-surface-1 hover:text-body"
      }`}
      style={{ width: "calc(100% - 0.5rem)" }}
    >
      <Avatar mxcUrl={partner?.getMxcAvatarUrl()} name={label} size={22} />
      <span
        className={`truncate min-w-0 flex-1 text-shadow-chat ${total > 0 && !active ? "font-medium" : ""}`}
        style={{ fontSize: CHAT_FONT }}
      >
        {label}
        {partnerLabel?.fromDiscord && (
          <PlatformIcon platform="discord" size="0.85em" className="ml-1 inline-block align-baseline opacity-70" />
        )}
      </span>
      <UnreadDot total={total} highlight={highlight} counts={counts} className="w-1.5 h-1.5 shrink-0" />
    </button>
  );
}

/** The user who invited us to `room` — DM inviter, else our member event's sender. */
function inviterOf(room: Room, myUserId: string): string | null {
  return room.getDMInviter() ?? room.getMember(myUserId)?.events.member?.getSender() ?? null;
}

function InviteRow({
  room,
  myUserId,
  onAccept,
  onReject,
}: {
  room: Room;
  myUserId: string;
  onAccept: (r: Room) => Promise<void>;
  onReject: (r: Room) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const inviterId = inviterOf(room, myUserId);
  const inviter = inviterId ? room.getMember(inviterId) : null;
  // DM invite → show the person; room/space invite → show the room.
  const isDm = !!room.getDMInviter();
  const label = isDm && inviter
    ? senderLabel(memberName(inviter, inviter.userId), inviter.userId).label
    : room.name || room.roomId;
  const sub = isDm
    ? "wants to message you"
    : inviter
    ? `invited by ${senderLabel(memberName(inviter, inviter.userId), inviter.userId).label}`
    : "invited you";

  const act = (fn: (r: Room) => Promise<void>) => {
    setBusy(true);
    void fn(room).finally(() => setBusy(false));
  };

  return (
    <div
      className="flex items-center gap-2 rounded-md px-2 py-1.5 mx-1 bg-surface-1"
      style={{ width: "calc(100% - 0.5rem)" }}
    >
      <Avatar
        mxcUrl={isDm ? inviter?.getMxcAvatarUrl() : room.getMxcAvatarUrl() ?? inviter?.getMxcAvatarUrl()}
        name={label}
        size={22}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-heading text-shadow-chat" style={{ fontSize: CHAT_FONT }}>
          {label}
        </span>
        <span className="block truncate text-muted" style={{ fontSize: "var(--text-chat-sm)" }}>
          {sub}
        </span>
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => act(onAccept)}
        className="shrink-0 rounded px-2 py-0.5 bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 transition-colors disabled:opacity-50"
        style={{ fontSize: "var(--text-chat-sm)" }}
      >
        Accept
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => act(onReject)}
        title="Decline invite"
        className="shrink-0 rounded px-1.5 py-0.5 text-muted hover:text-rose-400 hover:bg-surface-2 transition-colors disabled:opacity-50"
        style={{ fontSize: "var(--text-chat-sm)" }}
      >
        ✕
      </button>
    </div>
  );
}

function Group({
  node,
  selected,
  onSelect,
  onMenu,
  prefs,
  depth = 0,
}: {
  node: SpaceNode;
  selected: Room | null;
  onSelect: (r: Room) => void;
  onMenu: OnMenu;
  prefs: ListPrefs;
  depth?: number;
}) {
  const storageKey = `mx-space:${node.space.roomId}`;
  const [collapsed, setCollapsed] = useState(() => lsGet(storageKey) === "1");
  const unreads = aggregateUnreads(allChannelsInNode(node));

  function toggle() {
    setCollapsed((c) => {
      const next = !c;
      lsSet(storageKey, next ? "1" : "0");
      return next;
    });
  }

  return (
    <div className="mt-3" style={{ paddingLeft: depth * 8 }}>
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center gap-1 px-2.5 py-0.5 uppercase tracking-wider font-semibold text-muted hover:text-body-dim transition-colors"
        style={{ fontSize: "var(--text-chat-xs)" }}
      >
        <CaretDown
          size={10}
          weight="bold"
          className={`shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`}
        />
        <span className="truncate text-left">{node.space.name}</span>
        {collapsed && <UnreadDot total={unreads.total} highlight={unreads.highlight} counts={prefs.counts} className="w-1.5 h-1.5 shrink-0" />}
      </button>
      {!collapsed && (
        <div className="mt-0.5">
          {node.channels.map((room) => (
            <ChannelRow key={room.roomId} room={room} active={selected?.roomId === room.roomId} onSelect={onSelect} onMenu={onMenu} prefs={prefs} />
          ))}
          {node.subSpaces.map((sub) => (
            <Group key={sub.space.roomId} node={sub} selected={selected} onSelect={onSelect} onMenu={onMenu} prefs={prefs} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ChannelColumn({
  mode,
  server,
  dms,
  pinned,
  invites,
  selected,
  myUserId,
  dmRoomIds,
  onSelect,
  onAcceptInvite,
  onRejectInvite,
  boot,
  serverRooms,
}: {
  /** "home" → DMs + pinned; "space" → the active server's channels/groups. */
  mode: "home" | "space";
  server: RailServer | null;
  dms: Room[];
  pinned: Room[];
  invites: Room[];
  selected: Room | null;
  myUserId: string;
  dmRoomIds: Set<string>;
  onSelect: (r: Room) => void;
  onAcceptInvite: (r: Room) => Promise<void>;
  onRejectInvite: (r: Room) => Promise<void>;
  /** Rendered INSTEAD of the room list while the client is still starting —
   *  the host's boot sequence (MatrixView). Header and rail are unaffected. */
  boot?: ReactNode;
  /** Every channel in the active server — the notification menu's "Mark all as read". */
  serverRooms: Room[];
}) {
  const title = mode === "home" ? "Direct Messages" : server?.name ?? siteName();
  const [menu, setMenu] = useState<{ room: Room; x: number; y: number; anchor: HTMLElement | null } | null>(null);
  const onMenu: OnMenu = (room, x, y, anchor) => setMenu({ room, x, y, anchor });
  const counts = useSetting("chatStyle_mxUnread") === "counts";
  const hideMuted = useSetting("chatStyle_mxHideMuted") === "1";
  // A mute made here or in another client lands as an account-data echo of
  // m.push_rules; re-render on it so a muted channel leaves the list at once.
  const { client } = useMatrixClient();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!client || !hideMuted) return;
    const onAccountData = () => bump();
    client.on(ClientEvent.AccountData, onAccountData);
    return () => { client.off(ClientEvent.AccountData, onAccountData); };
  }, [client, hideMuted]);
  const rules = client?.pushRules as RuleSet | undefined;
  const prefs: ListPrefs = { counts, hideMuted, muted: (r) => roomNotifySetting(rules, r.roomId) === "none" };

  return (
    <div className="flex flex-col h-full overflow-hidden flex-1 min-w-0">
      <Bar slot="top" name="mx-header" center={
        <>
          <span className="font-bold text-heading truncate" style={{ fontSize: CHAT_FONT }}>
            {title}
          </span>
        </>
      } />

      <div className="flex-1 overflow-y-auto no-scrollbar py-2">
        {/* Before the client is ready there are no rooms to list, and an empty
            list reads as "this community is empty" — so when the host hands
            us a boot sequence it takes the list's slot outright. */}
        {boot ?? (mode === "home" ? (
          <>
            {invites.length > 0 && (
              <>
                <div className="px-2.5 py-0.5 uppercase tracking-wider font-semibold text-emerald-400/90" style={{ fontSize: "var(--text-chat-xs)" }}>
                  Invites
                </div>
                {invites.map((room) => (
                  <InviteRow
                    key={room.roomId}
                    room={room}
                    myUserId={myUserId}
                    onAccept={onAcceptInvite}
                    onReject={onRejectInvite}
                  />
                ))}
                <div className="h-2" aria-hidden />
              </>
            )}
            <div className="px-2.5 py-0.5 uppercase tracking-wider font-semibold text-muted" style={{ fontSize: "var(--text-chat-xs)" }}>
              Direct Messages
            </div>
            {dms.length > 0 ? (
              dms.map((room) => (
                <DMRow
                  key={room.roomId}
                  room={room}
                  myUserId={myUserId}
                  dmRoomIds={dmRoomIds}
                  active={selected?.roomId === room.roomId}
                  onSelect={onSelect}
                  counts={counts}
                />
              ))
            ) : (
              <p className="px-3 py-1 text-muted" style={{ fontSize: "var(--text-chat-md)" }}>
                No direct messages yet
              </p>
            )}

            {pinned.length > 0 && (
              <>
                <div className="mt-3 px-2.5 py-0.5 uppercase tracking-wider font-semibold text-muted" style={{ fontSize: "var(--text-chat-xs)" }}>
                  Pinned
                </div>
                {pinned.map((room) => (
                  <ChannelRow key={room.roomId} room={room} active={selected?.roomId === room.roomId} onSelect={onSelect} onMenu={onMenu} prefs={prefs} />
                ))}
              </>
            )}
          </>
        ) : server ? (
          <>
            {server.channels.map((room) => (
              <ChannelRow key={room.roomId} room={room} active={selected?.roomId === room.roomId} onSelect={onSelect} onMenu={onMenu} prefs={prefs} />
            ))}
            {server.subSpaces.map((sub) => (
              <Group key={sub.space.roomId} node={sub} selected={selected} onSelect={onSelect} onMenu={onMenu} prefs={prefs} />
            ))}
            {server.channels.length === 0 && server.subSpaces.length === 0 && (
              <p className="px-3 py-1 text-muted" style={{ fontSize: "var(--text-chat-md)" }}>
                No channels yet
              </p>
            )}
          </>
        ) : (
          <p className="px-3 py-1 text-muted" style={{ fontSize: "var(--text-chat-md)" }}>
            No spaces yet
          </p>
        ))}
      </div>
      {menu && (
        <NotificationMenu room={menu.room} serverRooms={serverRooms} x={menu.x} y={menu.y}
          onClose={() => setMenu(null)} anchorRef={{ current: menu.anchor }} />
      )}
    </div>
  );
}
