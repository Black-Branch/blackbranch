"use client";

import { useEffect, useRef, useState } from "react";
import { MatrixEvent } from "matrix-js-sdk";
import type { MatrixClient, Room } from "matrix-js-sdk";
import { getMemberDisplayName } from "@/app/lib/matrixDisplay";
import { senderLabel } from "@/app/lib/discordSender";
import { formatDiscordTime, snippet } from "@/app/lib/textFormat";
import { stripReplyFallback } from "@/app/lib/stripReplyFallback";
import { mediaKindLabel } from "@/app/lib/mediaKind";

// Discord's pins popover for a Matrix room: opened from the pin button in
// the room's top bar (Timeline's header), a panel over the timeline listing
// the pinned messages, newest pin first. A pinned event is often older than the loaded window, so each id
// that isn't in the timeline is fetched on its own (and decrypted — DMs are
// E2EE) the first time the panel opens for this room.

function pinText(ev: MatrixEvent): string {
  if (ev.isDecryptionFailure() || ev.getType() === "m.room.encrypted") return "🔒 Message unavailable";
  if (ev.isRedacted()) return "Deleted message";
  const c = ev.getContent() as Record<string, unknown>;
  return mediaKindLabel(ev.getType(), c.msgtype) ?? snippet(stripReplyFallback((c.body as string) ?? ""), 160);
}

export function PinnedMessages({
  client,
  room,
  ids,
  canPin,
  onJump,
  onUnpin,
  open,
  onClose,
}: {
  client: MatrixClient | null;
  room: Room;
  ids: string[];
  canPin: boolean;
  /** Resolves true when the row is on screen; false when it is too far back. */
  onJump: (eventId: string) => Promise<boolean>;
  onUnpin: (eventId: string) => void;
  /** Owned by the header's pin button. */
  open: boolean;
  onClose: () => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  // Fetched copies of pins that aren't in the timeline (null = unavailable).
  const [fetched, setFetched] = useState<Map<string, MatrixEvent | null>>(() => new Map());
  const inFlightRef = useRef(new Set<string>());
  const [roomKey, setRoomKey] = useState(room.roomId);
  if (roomKey !== room.roomId) {
    setRoomKey(room.roomId);
    setNotice(null);
    setFetched(new Map());
  }

  // A ref cannot be written during render (react-hooks/refs) — the room-key
  // block above resets STATE render-time, but the in-flight set is reset here,
  // in an effect keyed on the room, ordered before the fetch effect below so
  // it never sees a stale entry from the previous room.
  useEffect(() => {
    inFlightRef.current = new Set();
  }, [room.roomId]);

  // No `cancelled` guard: a fetch started for one `ids` list must still land
  // when it resolves after `ids` (or the room) has since changed — otherwise
  // that pin is stuck reading "Loading…" until the panel is reopened. A
  // result for a since-abandoned room/id is harmless: the room-change branch
  // above resets `fetched` to a fresh Map, and rendering only ever reads the
  // CURRENT `ids`, so a stale entry landing in the map is simply never read.
  useEffect(() => {
    if (!open || !client) return;
    for (const id of ids) {
      if (room.findEventById(id) || fetched.has(id) || inFlightRef.current.has(id)) continue;
      inFlightRef.current.add(id);
      client.fetchRoomEvent(room.roomId, id)
        .then(async (raw) => {
          const ev = new MatrixEvent(raw);
          await client.decryptEventIfNeeded(ev).catch(() => {});
          return ev;
        })
        .catch(() => null)
        .then((ev) => {
          inFlightRef.current.delete(id);
          setFetched((m) => new Map(m).set(id, ev));
        });
    }
  }, [open, client, room, ids, fetched]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Stop here so an enclosing window does not also close on the same key.
      e.stopPropagation();
      setNotice(null);
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const jump = async (id: string) => {
    setNotice(null);
    const ok = await onJump(id);
    if (ok) onClose();
    else setNotice("That message is deleted or too far back to jump to.");
  };

  return (
    <div className="absolute top-1 right-2 left-2 sm:left-auto sm:w-96 max-h-[60%] overflow-y-auto z-20 rounded-lg bg-raised border border-edge-strong shadow-lg">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-edge">
            <span className="text-xs font-medium text-body">Pinned messages</span>
            <button type="button" onClick={() => { setNotice(null); onClose(); }} aria-label="Close pinned messages" className="ml-auto text-muted hover:text-strong text-xs">
              ✕
            </button>
          </div>
          {notice && <p className="px-3 py-1.5 text-2xs text-muted">{notice}</p>}
          {ids.length === 0 && <p className="px-3 py-2 text-2xs text-muted">No pinned messages yet.</p>}
          {[...ids].reverse().map((id) => {
            const ev = room.findEventById(id) ?? fetched.get(id) ?? null;
            const sender = ev?.getSender() ?? "";
            return (
              <div key={id} className="flex items-start gap-2 px-3 py-2 hover:bg-surface-2 border-b border-edge last:border-b-0">
                <button type="button" onClick={() => void jump(id)} className="flex-1 min-w-0 text-left">
                  {ev ? (
                    <>
                      <div className="text-2xs text-muted truncate">
                        <span className="text-body-dim font-medium">{senderLabel(getMemberDisplayName(room, sender), sender).label}</span>{" "}
                        {formatDiscordTime(new Date(ev.getTs()))}
                      </div>
                      <div className="text-xs text-body line-clamp-3 [overflow-wrap:anywhere]">{pinText(ev)}</div>
                    </>
                  ) : (
                    <div className="text-2xs text-muted">{fetched.has(id) ? "🔒 Message unavailable" : "Loading…"}</div>
                  )}
                </button>
                {canPin && (
                  <button type="button" onClick={() => onUnpin(id)} className="shrink-0 text-2xs text-muted hover:text-strong">
                    Unpin
                  </button>
                )}
              </div>
            );
          })}
    </div>
  );
}
