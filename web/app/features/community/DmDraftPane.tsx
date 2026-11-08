"use client";

// A conversation with someone who has no DM with you yet, in Community (the member card's Message
// on a page with no chat column, so no DM window to hand it to). Nothing exists on the server and
// the other person sees nothing until the first line is sent: that send makes the private room
// (roomForSending — one per person, the strict rule) and then opens it like any conversation.

import { useRef, useState } from "react";
import { EventType } from "matrix-js-sdk";
import type { MatrixClient, Room, TimelineEvents } from "matrix-js-sdk";
import { Bar, BarButton } from "@/app/components/chrome";
import { MatrixInput } from "@/app/components/MatrixInput";
import { buildMatrixMessage } from "@/app/lib/buildMatrixMessage";
import { localEchoOf } from "@/app/lib/localEcho";
import { roomForSending, SEND_FAILED } from "@/app/lib/matrixDm";
import { useEmotes } from "@/app/lib/useEmotes";
import { dmPlaceholder } from "@/app/lib/dm/dmPlaceholder";

export function DmDraftPane({ client, userId, name, onOpened, onBack }: {
  client: MatrixClient;
  userId: string;
  name: string;
  /** The first line made the room (sent, or kept as Not sent with Retry): open it. */
  onOpened: (room: Room) => void;
  onBack?: () => void;
}) {
  const emotes = useEmotes();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const send = async () => {
    const body = input.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const room = await roomForSending(client, userId);
      const txnId = client.makeTxnId();
      setInput("");
      try {
        await client.sendEvent(room.roomId, EventType.RoomMessage, buildMatrixMessage(body, emotes) as TimelineEvents[EventType.RoomMessage], txnId);
      } catch (e) {
        console.error("[dm] first line failed", e);
        // No line made at all: keep the text here. Otherwise the room shows it as Not sent.
        if (!localEchoOf(room, txnId)) { setInput(body); setError(SEND_FAILED); return; }
      }
      onOpened(room);
    } catch (e) {
      setError(e instanceof Error ? e.message : SEND_FAILED);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0" data-dm-draft-pane="">
      <Bar slot="top" name="mx-header" center={
        <>
          {onBack && (
            <BarButton size="touch" icon={<span className="text-sm">←</span>} label="Back" onClick={onBack} />
          )}
          <div className="flex-1 min-w-0 text-sm font-medium text-body leading-tight truncate">{name}</div>
        </>
      } />
      <div className="flex-1 min-h-0 flex flex-col justify-end gap-1 px-4 py-3">
        <p className="text-sm text-body">This is the start of your conversation with {name}.</p>
        <p className="text-xs text-muted">Nothing is sent until you write — your first line goes to them as a message request.</p>
        {error && <p className="text-xs text-red-400" role="alert">{error}</p>}
      </div>
      <Bar slot="bottom" name="mx-composer" center={
        <form onSubmit={(e) => { e.preventDefault(); void send(); }} className="flex flex-col min-w-0 w-full">
          <MatrixInput
            value={input}
            onChange={setInput}
            onSubmit={() => { void send(); }}
            placeholder={dmPlaceholder(name)}
            disabled={sending}
            inputRef={inputRef}
            isSignedIn
            hideUserMenu
          />
        </form>
      } />
    </div>
  );
}
