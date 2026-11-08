"use client";

// The DM list's live model for the Community view (client polish Task 20): dmConversations over the
// client, re-read when anything a row shows can change — a line arriving or decrypting, a read
// receipt (the unread count), a pin, a close or an m.direct change, members loading. `rooms` (the
// joined set, which useCommunityBootstrap keeps stable while membership is unchanged) re-reads too.
//
// Members are lazy-loaded: a small room's member list is loaded once so the strict DM test can see
// the partner (rooms with more than two people are never DMs and are never loaded). The account's
// own m.direct is healed whenever the set of rooms changes (dmDirectMerge.ts).

import { useEffect, useMemo, useReducer } from "react";
import { ClientEvent, MatrixEventEvent, RoomEvent, RoomStateEvent } from "matrix-js-sdk";
import type { MatrixClient, Room } from "matrix-js-sdk";
import { dmConversations, notClosed, readClosed, type DmConversation } from "@/app/lib/dmConversations";
import { healOwnDirect } from "@/app/lib/dmDirectMerge";

const EVENTS = [
  RoomEvent.Timeline, RoomEvent.Receipt, RoomEvent.UnreadNotifications, RoomEvent.Tags,
  RoomEvent.LocalEchoUpdated, ClientEvent.AccountData, MatrixEventEvent.Decrypted, RoomStateEvent.Members,
] as const;

/** Re-reads coalesce: a burst of events (a sync batch) is one re-read. */
const SETTLE_MS = 120;

/** The room an event's arguments are about (the client re-emits with the source appended: a Room,
 *  a member, an event), or null when none says — account data, which always re-reads. */
function roomOfArgs(client: MatrixClient, args: unknown[]): Room | null {
  for (const a of args) {
    if (!a || typeof a !== "object") continue;
    const id = (a as { roomId?: unknown }).roomId;
    if (typeof id === "string") return client.getRoom(id);
    const get = (a as { getRoomId?: unknown }).getRoomId;
    if (typeof get === "function") {
      const rid = (get as () => unknown).call(a);
      if (typeof rid === "string") return client.getRoom(rid);
    }
  }
  return null;
}

export function useDmConversations(client: MatrixClient | null, me: string, rooms: Room[]): { all: DmConversation[]; list: DmConversation[] } {
  const [tick, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!client || !me) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const later = (...args: unknown[]) => {
      // A busy channel's lines are not the DM list's business: an event of a room with more than
      // two people never re-reads it (the room is never a DM).
      const room = roomOfArgs(client, args);
      if (room && room.getJoinedMemberCount() + room.getInvitedMemberCount() > 2) return;
      if (!timer) timer = setTimeout(() => { timer = null; bump(); }, SETTLE_MS);
    };
    for (const e of EVENTS) client.on(e as never, later as never);
    return () => {
      if (timer) clearTimeout(timer);
      for (const e of EVENTS) client.off(e as never, later as never);
    };
  }, [client, me]);

  // Load the members of every room that could be a DM (two people at most), then heal m.direct.
  useEffect(() => {
    if (!client || !me) return;
    let alive = true;
    const small = rooms.filter((r) => !r.isSpaceRoom() && r.getJoinedMemberCount() + r.getInvitedMemberCount() <= 2);
    void Promise.all(small.map((r) => r.loadMembersIfNeeded().catch(() => false)))
      .then(() => healOwnDirect(client, me))
      .then(() => { if (alive) bump(); });
    return () => { alive = false; };
  }, [client, me, rooms]);

  return useMemo(() => {
    if (!client || !me) return { all: [], list: [] };
    const all = dmConversations(client, me, {});
    return { all, list: notClosed(all, readClosed(client)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `tick` and `rooms` are the change drivers: the conversations are read from mutable client state the rule cannot see
  }, [client, me, rooms, tick]);
}
