"use client";

// The per-channel notification menu. Opened from the bell in the
// channel header and from a right-click / long-press on a channel row; one
// component so the two can never drift.

import { useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Room } from "matrix-js-sdk";
import { useMatrixClient } from "@/app/lib/MatrixClientContext";
import { useOutsideClick } from "@/app/lib/useOutsideClick";
import { clampToViewport } from "@/app/lib/userCardLayout";
import { useNotificationSetting, type PushClient } from "@/app/lib/useNotificationSetting";
import type { NotifySetting } from "@/app/lib/pushRules";
import { sendsReadReceipts } from "@/app/lib/matrixPrivacy";

const CHOICES: { value: NotifySetting; label: string; hint: string }[] = [
  { value: "all", label: "All messages", hint: "Every message counts." },
  { value: "mentions", label: "Mentions only", hint: "Only when someone names you." },
  { value: "none", label: "Nothing", hint: "Silent, even for mentions." },
];

const W = 244;

type MarkerClient = { setRoomReadMarkers?(roomId: string, eventId: string, rr?: unknown, rp?: unknown): Promise<unknown> };

/** The newest event in a room that the server has actually stored — a local
 *  echo has no id to mark read. Mirrors readReceipts.ts's own guard. */
function newestSentEvent(room: Room): { getId(): string | undefined } | null {
  const events = room.getLiveTimeline().getEvents();
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev && (ev as unknown as { status: unknown }).status === null) return ev;
  }
  return null;
}

export function NotificationMenu({
  room, serverRooms, x, y, onClose, client: injected, anchorRef,
}: {
  room: Room;
  /** Every channel in the server this room belongs to — what "Mark all as read" covers. */
  serverRooms: Room[];
  x: number;
  y: number;
  onClose: () => void;
  /** @test-only the render test supplies a fake instead of mounting a provider. */
  client?: PushClient;
  /** The toggle that opened this menu (the header bell, or the channel row a
   *  right-click/long-press landed on). It sits outside the menu's own DOM, so
   *  without it a press on the toggle fires the outside-click first — closing
   *  the menu — and only then reads as the toggle's own click, which reopens
   *  it: the menu could never be closed from the control that opened it. */
  anchorRef?: RefObject<HTMLElement | null>;
}) {
  const ctx = useMatrixClient();
  const client = injected ?? (ctx?.client as unknown as PushClient | undefined);
  const ref = useRef<HTMLDivElement>(null);
  const [marked, setMarked] = useState<string | null>(null);
  useOutsideClick(anchorRef ? [ref, anchorRef] : ref, onClose, { escape: true });
  const { setting, accountOff, error, choose, turnAccountOn } = useNotificationSetting(client, room.roomId);

  if (typeof document === "undefined") return null;

  const markRead = (rooms: Room[], label: string) => {
    const marker = client as unknown as MarkerClient | undefined;
    if (!marker?.setRoomReadMarkers) return;
    void (async () => {
      for (const r of rooms) {
        const ev = newestSentEvent(r);
        const id = ev?.getId();
        if (!id) continue;
        // The public receipt only when Community › Privacy allows it (⑥).
        await marker.setRoomReadMarkers!(r.roomId, id, sendsReadReceipts() ? ev : undefined, ev).catch(() => {});
      }
      setMarked(label);
    })();
  };

  const left = clampToViewport(x, W, window.innerWidth);
  const top = Math.max(8, Math.min(y, window.innerHeight - 260));

  return createPortal(
    <div ref={ref} role="menu" aria-label={`Notification settings for ${room.name || room.roomId}`}
      className="fixed z-(--z-menu) glass rounded-xl overflow-hidden p-2"
      style={{ left, top, width: W }}>
      {accountOff && (
        <div className="mb-1 px-2 py-1.5 rounded-md bg-amber-500/15">
          <p className="text-2xs text-amber-300">Notifications are off for your whole account.</p>
          <button type="button" onClick={turnAccountOn}
            className="mt-1 text-2xs underline text-amber-300 hover:brightness-125">
            Turn them on
          </button>
        </div>
      )}

      {CHOICES.map((c) => (
        <button key={c.value} type="button" role="menuitemradio" aria-checked={setting === c.value}
          onClick={() => choose(c.value)}
          className={`w-full text-left px-2 py-1.5 rounded-md transition-colors ${
            setting === c.value ? "bg-surface-2 text-strong" : "text-body-dim hover:bg-surface-1"
          }`}>
          <span className="block text-sm">{c.label}</span>
          <span className="block text-2xs text-muted">{c.hint}</span>
        </button>
      ))}

      {error && (
        <p role="alert" className="mt-1 px-2 text-2xs text-red-300">Couldn&apos;t save that. Try again.</p>
      )}

      <div className="my-1 border-t border-edge" />

      <button type="button" role="menuitem" onClick={() => markRead([room], "channel")}
        className="w-full text-left px-2 py-1.5 rounded-md text-sm text-body-dim hover:bg-surface-1 transition-colors">
        Mark as read
      </button>
      <button type="button" role="menuitem"
        onClick={() => markRead(serverRooms.filter((r) => r.getUnreadNotificationCount() > 0), "server")}
        className="w-full text-left px-2 py-1.5 rounded-md text-sm text-body-dim hover:bg-surface-1 transition-colors">
        Mark all as read
      </button>
      {marked && <p role="status" className="px-2 pt-1 text-2xs text-muted">Marked read.</p>}
    </div>,
    document.body
  );
}
