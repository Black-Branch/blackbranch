"use client";

import { useState, useRef, useMemo, useEffect } from "react";
import { useOutsideClick } from "@/app/lib/useOutsideClick";
import { useEncryptionStatus } from "@/app/lib/useEncryptionStatus";
import { useUserMenuEvents } from "@/app/lib/useUserMenuEvents";
import { currentAvatarVersion } from "@/app/lib/profileCardPrefetch";
import { lsGetJSON, lsSetJSON } from "@/app/lib/safeLocalStorage";
import type { Room } from "matrix-js-sdk";
import { mxcToHttp } from "@/app/lib/matrixMedia";
import { Avatar } from "@/app/components/Avatar";
import { UnreadDot } from "./parts";
import { serverChannels, aggregateUnreads, roomLabel, type RailServer } from "@/app/lib/matrixRooms";
import { listThreads } from "@/app/lib/matrixThreads";
import { GearSix, Chats, House } from "@phosphor-icons/react/dist/ssr";

// Square space icon that fills the squircle tile (object-cover), not a circle
// avatar — so space images sit flush like Discord servers.
function RailIcon({ room, name }: { room: Room | null; name: string }) {
  const [err, setErr] = useState(false);
  const url = mxcToHttp(room?.getMxcAvatarUrl(), 96);
  if (url && !err) {
    return <img src={url} alt={name} draggable={false} onError={() => setErr(true)} className="w-full h-full object-cover" />;
  }
  return <span className="font-bold text-lg" style={{ color: "var(--accent)" }}>{name.slice(0, 1).toUpperCase()}</span>;
}

// The far-left icon rail (Discord "servers"). Home + one icon per top-level
// space + an add-space button. Active server shows a left pill + squared corners;
// hover shows a short pill. Unread → a dot in the indicator.

function Pill({ active, unread }: { active: boolean; unread: boolean }) {
  // Discord-style left indicator: tall when active, short on hover, dot on unread.
  const h = active ? "h-9" : unread ? "h-2" : "h-0 group-hover/r:h-4";
  return (
    <span
      aria-hidden
      className={`absolute -left-1.5 top-1/2 -translate-y-1/2 w-1 rounded-r-full bg-white transition-all duration-(--anim-fast) ${h}`}
    />
  );
}

// Bottom-of-rail user button (Discord-style): the user's avatar with the crypto
// traffic-light dot, opening the universal profile card. The dot is the shared
// cross-signing derivation (useEncryptionStatus — same as the chat avatar
// button); the thumbnail refreshes via the hub's avatar-changed entry.
function RailUserButton({ onOpenSettings }: { onOpenSettings: () => void }) {
  // Shared monotonic cache-buster (profileCardPrefetch) — the card bumps it
  // before announcing a change, so re-reading always lands the fresh URL.
  const [ver, setVer] = useState(currentAvatarVersion);
  const [ok, setOk] = useState(true);
  const { dotClass } = useEncryptionStatus();

  useUserMenuEvents({ onAvatarChanged: () => { setOk(true); setVer(currentAvatarVersion()); } });

  return (
    <button
      type="button"
      onClick={onOpenSettings}
      title="Your profile"
      className="relative w-9 h-9 rounded-full overflow-hidden ring-1 ring-edge hover:ring-edge-bright transition-all shrink-0"
    >
      {ok ? (
        <img
          src={`/api/avatar/me?v=${ver}`}
          alt="Your profile"
          onError={() => setOk(false)}
          className="w-full h-full object-cover"
        />
      ) : (
        <span className="w-full h-full flex items-center justify-center text-body-dim bg-control/80">
          <GearSix size={16} weight="bold" />
        </span>
      )}
      {dotClass && (
        <span className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-canvas ${dotClass}`} />
      )}
    </button>
  );
}


function Tile({
  active,
  onClick,
  title,
  unreads,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  unreads: { total: number; highlight: number };
  children: React.ReactNode;
}) {
  return (
    <div className="group/r relative w-full flex justify-center">
      <Pill active={active} unread={unreads.total > 0} />
      <button
        type="button"
        onClick={onClick}
        title={title}
        className={`relative w-10 h-10 flex items-center justify-center overflow-hidden transition-[border-radius,background] duration-(--anim-fast) ${
          active
            ? "rounded-2xl bg-accent/20 text-strong"
            : "rounded-[1.4rem] group-hover/r:rounded-2xl bg-surface-2 text-body-dim group-hover/r:bg-accent/20 group-hover/r:text-strong"
        }`}
      >
        {children}
        <UnreadDot total={unreads.total} highlight={unreads.highlight} className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 border-2 border-[var(--bg-body-end,#111827)]" />
      </button>
    </div>
  );
}

// Global "Threads activity" — every room (across spaces) that has live threads.
function ThreadsActivity({
  rooms,
  myUserId,
  onOpenRoomThreads,
}: {
  rooms: Room[];
  myUserId: string;
  onOpenRoomThreads: (room: Room) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useOutsideClick(wrapRef, () => setOpen(false), { enabled: open, escape: true });

  // Rooms with at least one thread, most-recently-active first.
  const active = useMemo(() => {
    if (!open) return [] as { room: Room; count: number; ts: number }[];
    return rooms
      .map((room) => {
        const t = listThreads(room);
        const ts = t.reduce((m, x) => Math.max(m, x.last?.getTs() ?? x.root.getTs()), 0);
        return { room, count: t.length, ts };
      })
      .filter((x) => x.count > 0)
      .sort((a, b) => b.ts - a.ts);
  }, [open, rooms]);

  return (
    <div ref={wrapRef} className="relative w-full flex justify-center">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Threads activity"
        className={`relative w-10 h-10 flex items-center justify-center rounded-[1.4rem] hover:rounded-2xl transition-[border-radius,background] duration-(--anim-fast) ${
          open ? "rounded-2xl bg-accent/20 text-strong" : "bg-surface-2 text-body-dim hover:bg-accent/20 hover:text-strong"
        }`}
      >
        <Chats size={20} weight="bold" />
      </button>

      {open && (
        <div className="absolute left-full bottom-0 ml-2 z-(--z-rail-menu) w-64 glass rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-edge text-sm font-semibold text-body">
            Threads activity
          </div>
          {active.length === 0 ? (
            <p className="px-3 py-3 text-muted text-xs">
              You don&rsquo;t have rooms with thread activity yet.
            </p>
          ) : (
            <div className="max-h-80 overflow-y-auto no-scrollbar py-1">
              {active.map(({ room, count }) => (
                <button
                  key={room.roomId}
                  type="button"
                  onClick={() => { onOpenRoomThreads(room); setOpen(false); }}
                  className="w-full text-left flex items-center gap-2 px-3 py-2 hover:bg-surface-2 transition-colors"
                >
                  <Avatar mxcUrl={room.getMxcAvatarUrl()} name={room.name || room.roomId} size={22} />
                  <span className="flex-1 min-w-0 truncate text-body" style={{ fontSize: "var(--text-chat-md)" }}>
                    {roomLabel(room, myUserId, new Set())}
                  </span>
                  <span className="shrink-0 font-medium" style={{ color: "var(--accent)", fontSize: "var(--text-chat-sm)" }}>
                    {count}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SpacesRail({
  servers,
  activeId,
  homeUnreads,
  canAddSpace,
  onSelectHome,
  onSelectServer,
  onAddSpace,
  rooms,
  myUserId,
  onOpenRoomThreads,
  onOpenSettings,
  hideUserButton,
}: {
  servers: RailServer[];
  activeId: string | "home";
  homeUnreads: { total: number; highlight: number };
  canAddSpace: boolean;
  onSelectHome: () => void;
  onSelectServer: (id: string) => void;
  onAddSpace: () => void;
  rooms: Room[];
  myUserId: string;
  onOpenRoomThreads: (room: Room) => void;
  onOpenSettings: () => void;
  /** A UserMenu is mounted beside this rail (split view, signed in), so the bottom avatar would be its duplicate. The standalone/mobile paths keep it — it is their only door to the account card. */
  hideUserButton?: boolean;
}) {
  // Persisted custom order of top-level spaces (drag to reorder). Saved ids sort
  // first in their saved order; any new/unsaved spaces fall in after, original order.
  const [order, setOrder] = useState<string[]>(() => {
    const a = lsGetJSON<string[]>("mx-space-order", []);
    return Array.isArray(a) ? a : [];
  });
  const orderedServers = useMemo(() => {
    const pos = new Map(order.map((id, i) => [id, i]));
    return [...servers].sort((a, b) => (pos.get(a.id) ?? Infinity) - (pos.get(b.id) ?? Infinity));
  }, [servers, order]);

  const [dragId, setDragId] = useState<string | null>(null);
  // Press tracking: the tile under the pointer, its start position, and whether
  // it has moved past the drag threshold. `armed` = drag is allowed yet (mouse:
  // immediately; touch: only after a 220ms hold, so a tap still selects).
  const pressRef = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const armedRef = useRef(false);
  const holdRef = useRef<number | undefined>(undefined);
  const tilesRef = useRef<HTMLDivElement>(null);

  const persist = (ids: string[]) => lsSetJSON("mx-space-order", ids);

  // The rail scrolls; a reorder drag does not scroll it. Both gestures are
  // vertical, so which one you get is decided by the 220ms hold:
  //
  //   move first → the browser pans (the tiles allow `touch-pan-y`, and moving
  //                cancels the hold timer, so no drag ever arms)
  //   hold first → the drag arms, and from then on we cancel touchmove so the
  //                pan never starts
  //
  // The tiles are not `touch-none`: that would mean the rail cannot be
  // scrolled by touch AT ALL — the tiles fill it, so there is nothing else to
  // put a finger on. Cancelling only after arming is what makes the swap safe:
  // the hold requires stillness, so there is never a pan already in flight to
  // fight with (a preventDefault after the browser owns the gesture is ignored).
  //
  // Attached by hand because React's onTouchMove is passive — preventDefault
  // there is a no-op with a console warning.
  useEffect(() => {
    const el = tilesRef.current;
    if (!el) return;
    const block = (e: TouchEvent) => { if (armedRef.current) e.preventDefault(); };
    el.addEventListener("touchmove", block, { passive: false });
    return () => el.removeEventListener("touchmove", block);
  }, []);

  function pointerDown(e: React.PointerEvent, id: string) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pressRef.current = { id, x: e.clientX, y: e.clientY, moved: false };
    armedRef.current = e.pointerType === "mouse"; // mouse can start dragging at once
    if (e.pointerType !== "mouse") {
      holdRef.current = window.setTimeout(() => { armedRef.current = true; setDragId(id); }, 220);
    }
  }
  function pointerMove(e: React.PointerEvent) {
    const p = pressRef.current;
    if (!p) return;
    if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6) {
      p.moved = true;
      // Moving before the hold completes means this was a slide, not a hold, so
      // the arm timer must not fire behind it — otherwise the drag engages
      // mid-slide, 220ms after a gesture the user already committed to
      // something else. (useLongPress cancels on movement for the same reason.)
      if (!armedRef.current && holdRef.current) {
        clearTimeout(holdRef.current);
        holdRef.current = undefined;
      }
    }
    if (!armedRef.current || !p.moved) return;
    if (dragId !== p.id) setDragId(p.id);
    const container = tilesRef.current;
    if (!container) return;
    const tiles = [...container.querySelectorAll("[data-sid]")] as HTMLElement[];
    let targetId: string | null = null;
    for (const t of tiles) {
      const r = t.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { targetId = t.dataset.sid ?? null; break; }
    }
    const ids = orderedServers.map((s) => s.id);
    const from = ids.indexOf(p.id);
    if (from < 0) return;
    ids.splice(from, 1);
    let to = targetId ? ids.indexOf(targetId) : ids.length;
    if (to < 0) to = ids.length;
    ids.splice(to, 0, p.id);
    setOrder(ids);
  }
  function pointerUp() {
    if (holdRef.current) { clearTimeout(holdRef.current); holdRef.current = undefined; }
    const p = pressRef.current;
    const wasDrag = armedRef.current && !!p?.moved;
    if (wasDrag) {
      persist(orderedServers.map((s) => s.id));
    } else if (p) {
      // A tap/click (no drag) — select the server here rather than relying on the
      // inner button's onClick: setPointerCapture retargets the click event to
      // this capturing wrapper, so the button's onClick never fires.
      onSelectServer(p.id);
    }
    pressRef.current = null;
    armedRef.current = false;
    setDragId(null);
  }
  // A CANCELLED pointer is not a tap. Routing cancel into pointerUp meant the
  // no-drag branch ran and selected the space under the finger — so an OS
  // edge-swipe, a browser gesture takeover or a call notification arriving over
  // a resting finger silently switched spaces. An in-flight reorder is still
  // persisted, since the user watched the tiles move.
  function pointerCancel() {
    if (holdRef.current) { clearTimeout(holdRef.current); holdRef.current = undefined; }
    if (armedRef.current && pressRef.current?.moved) persist(orderedServers.map((s) => s.id));
    pressRef.current = null;
    armedRef.current = false;
    setDragId(null);
  }

  return (
    <div className="shrink-0 w-[56px] h-full flex flex-col items-center border-r border-raised/80">
      <div className="flex-1 w-full flex flex-col items-center gap-2 py-3 overflow-y-auto no-scrollbar">
        {/* Home — DMs + pinned */}
        <Tile
          active={activeId === "home"}
          onClick={onSelectHome}
          title="Home — Direct Messages"
          unreads={homeUnreads}
        >
          <House size={22} weight="bold" />
        </Tile>

        <span aria-hidden className="w-8 h-px bg-control/80 my-0.5 shrink-0" />

        <div ref={tilesRef} className="w-full flex flex-col items-center gap-2">
          {orderedServers.map((s) => {
            const unreads = aggregateUnreads(serverChannels(s));
            return (
              <div
                key={s.id}
                data-sid={s.id}
                className={`w-full flex justify-center touch-pan-y select-none transition-opacity ${dragId === s.id ? "opacity-40" : ""}`}
                // Long-press on the space avatar must not raise the native image
                // copy/save callout — that would block touch reordering.
                style={{ WebkitTouchCallout: "none" } as React.CSSProperties}
                onContextMenu={(e) => e.preventDefault()}
                onPointerDown={(e) => pointerDown(e, s.id)}
                onPointerMove={pointerMove}
                onPointerUp={pointerUp}
                onPointerCancel={pointerCancel}
              >
                <Tile
                  active={activeId === s.id}
                  onClick={() => onSelectServer(s.id)}
                  title={s.name}
                  unreads={unreads}
                >
                  <RailIcon room={s.room} name={s.name} />
                </Tile>
              </div>
            );
          })}
        </div>

        {canAddSpace && (
          <Tile active={false} onClick={onAddSpace} title="Add a space" unreads={{ total: 0, highlight: 0 }}>
            <span className="text-2xl leading-none text-emerald-400 font-light">+</span>
          </Tile>
        )}
      </div>

      {/* Bottom: global threads activity + user/settings button */}
      <div className="w-full shrink-0 flex flex-col items-center gap-2 py-3 border-t border-raised/60">
        <ThreadsActivity rooms={rooms} myUserId={myUserId} onOpenRoomThreads={onOpenRoomThreads} />
        {!hideUserButton && <RailUserButton onOpenSettings={onOpenSettings} />}
      </div>
    </div>
  );
}
