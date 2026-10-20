"use client";

import { useEffect, useRef, useState } from "react";
import { RoomMemberEvent } from "matrix-js-sdk";
import type { MatrixClient, MatrixEvent, Room, RoomMember } from "matrix-js-sdk";
import { typingUserIds } from "@/app/lib/typing";
import { isIgnoredUser } from "@/app/lib/ignoredBots";
import { getMemberDisplayName } from "@/app/lib/matrixDisplay";
import { senderLabel } from "@/app/lib/discordSender";
import { sendsTyping } from "@/app/lib/matrixPrivacy";

// Typing notifications for the Matrix client — Discord's rule: typing is
// announced while the composer holds text that was edited within the last
// 10 s. The bridge forwards our announcement to Discord ("… is typing") and
// a Discord user's typing arrives as their ghost's — the same m.typing event
// the site shows for anyone else.
//
// The server expires an announcement after TYPING_TIMEOUT_MS on its own;
// re-announcing every TYPING_RESEND_MS keeps a long draft alive, and the idle
// timer withdraws it when the keys go quiet. Every send is best-effort.

// Not exported: nothing outside this file needs them, and check-orphans
// counts a same-file use as no use at all.
const TYPING_TIMEOUT_MS = 30_000;
const TYPING_RESEND_MS = 20_000;
const TYPING_IDLE_MS = 10_000;

export function useTypingSender({
  client,
  room,
  text,
  enabled,
}: {
  client: MatrixClient | null | undefined;
  room: Room;
  text: string;
  /** False while editing — Discord shows no typing for an edit. */
  enabled: boolean;
}): void {
  const announcedRef = useRef(false);
  const lastSentRef = useRef(0);
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!client) return;
    const roomId = room.roomId;
    // Community › Privacy › Send typing OFF: never announce — read at send
    // time, so turning it off mid-draft withdraws what was already announced.
    const typing = enabled && sendsTyping() && text.trim() !== "";
    const stop = () => {
      if (idleRef.current) {
        clearTimeout(idleRef.current);
        idleRef.current = null;
      }
      if (!announcedRef.current) return;
      announcedRef.current = false;
      client.sendTyping(roomId, false, 0).catch(() => {});
    };
    if (!typing) {
      stop();
      return;
    }
    const now = Date.now();
    if (!announcedRef.current || now - lastSentRef.current > TYPING_RESEND_MS) {
      announcedRef.current = true;
      lastSentRef.current = now;
      client.sendTyping(roomId, true, TYPING_TIMEOUT_MS).catch(() => {});
    }
    if (idleRef.current) clearTimeout(idleRef.current);
    idleRef.current = setTimeout(stop, TYPING_IDLE_MS);
  }, [client, room.roomId, text, enabled]);

  // Leaving the room (or the page) withdraws a live announcement.
  useEffect(() => {
    return () => {
      if (idleRef.current) {
        clearTimeout(idleRef.current);
        idleRef.current = null;
      }
      if (announcedRef.current && client) {
        announcedRef.current = false;
        client.sendTyping(room.roomId, false, 0).catch(() => {});
      }
    };
  }, [client, room.roomId]);
}

/** Labels of everyone typing in `room` except the reader and ignored senders. */
export function useTypingUsers({
  client,
  room,
  myUserId,
}: {
  client: MatrixClient | null | undefined;
  room: Room;
  myUserId: string;
}): string[] {
  const [key, setKey] = useState<string | null>(null);
  const [ids, setIds] = useState<string[]>([]);
  // Room switch: seed from the members the SDK already flags as typing.
  if (key !== room.roomId) {
    setKey(room.roomId);
    setIds(typingUserIds(room, myUserId));
  }

  useEffect(() => {
    if (!client) return;
    // m.typing arrives with no room_id, so the ephemeral event itself cannot be
    // room-scoped; the SDK folds it into each member's `.typing` and re-emits
    // the member event on the client, and the member knows its room.
    const onTyping = (_ev: MatrixEvent, member: RoomMember) => {
      if (member.roomId !== room.roomId) return;
      setIds(typingUserIds(room, myUserId));
    };
    client.on(RoomMemberEvent.Typing, onTyping);
    return () => {
      client.off(RoomMemberEvent.Typing, onTyping);
    };
  }, [client, room, myUserId]);

  return ids
    .filter((id) => !isIgnoredUser(room, id))
    .map((id) => senderLabel(getMemberDisplayName(room, id), id).label);
}
