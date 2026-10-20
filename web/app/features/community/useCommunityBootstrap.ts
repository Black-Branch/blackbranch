"use client";

import { useState, useEffect, useRef } from "react";
import { ClientEvent, RoomEvent, RoomMemberEvent } from "matrix-js-sdk";
import type { Room, MatrixClient } from "matrix-js-sdk";
import { findRoomByAlias, COMMUNITY_HUB_ALIAS, GENERAL_ALIAS } from "@/app/lib/matrixRooms";
import { matrixServerName } from "@/app/lib/matrixConfig";

// Returns the PREVIOUS array when it holds exactly the same rooms in the same
// order, so React bails out instead of reconciling. Order-sensitive on purpose:
// if the SDK ever reorders getRooms() we rebuild rather than serve a stale order.
function keepIfUnchanged(prev: Room[], next: Room[]): Room[] {
  if (prev.length !== next.length) return next;
  for (let i = 0; i < prev.length; i++) if (prev[i] !== next[i]) return next;
  return prev;
}

// Joined-rooms subscription + one-shot community bootstrap for the shell.
// Returns the live list of joined rooms (drives the rail + channel column) and
// the pending invites (rooms in `invite` membership — DM invites especially,
// which are invisible without this: the recipient must accept before any
// encrypted message can flow).
// On first ready it silently joins the Community Hub space + its whole tree
// (membership, in the BACKGROUND) and — only when the caller has no remembered
// space to restore (`landDefaultRoom`) — lands the timeline on General via
// `onLandingRoom`. Landing is decoupled from the hierarchy join so the timeline
// appears as soon as General is reachable (usually already in local cache),
// instead of waiting on getRoomHierarchy + every child join. When a remembered
// space exists, the caller's restore effect owns landing, so we don't land
// General (no flash/no race).
export function useCommunityBootstrap({
  client,
  status,
  onLandingRoom,
  landDefaultRoom,
}: {
  client: MatrixClient | null;
  status: string;
  onLandingRoom: (room: Room) => void;
  landDefaultRoom: boolean;
}): { rooms: Room[]; invites: Room[] } {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [invites, setInvites] = useState<Room[]>([]);
  const membershipDoneRef = useRef(false);
  const landedRef = useRef(false);
  const onLandingRoomRef = useRef(onLandingRoom);
  // Latest-callback ref, written post-commit (not during render).
  useEffect(() => {
    onLandingRoomRef.current = onLandingRoom;
  });

  useEffect(() => {
    if (!client || status !== "ready") return;
    // Both lists are re-derived from scratch on every subscribed event, and
    // RoomEvent.Receipt is by far the noisiest of them: every read marker from
    // every member of every joined room fires it. Since the Community Hub
    // auto-joins the whole space tree, an idle client sees a steady drip of
    // them, and each one would hand React two brand-new arrays — so the entire
    // nav tree (spaces rail, channel columns, invite list) would reconcile for a
    // change that by definition never affects membership. Keeping the previous
    // array when the membership set is unchanged makes those events free.
    const refresh = () => {
      const all = client.getRooms();
      setRooms((prev) => keepIfUnchanged(prev, all.filter((r) => r.getMyMembership() === "join")));
      setInvites((prev) => keepIfUnchanged(prev, all.filter((r) => r.getMyMembership() === "invite")));
    };
    refresh();
    client.on(ClientEvent.Room, refresh);
    client.on(RoomEvent.Name, refresh);
    client.on(RoomMemberEvent.Membership, refresh);
    // Own membership transitions (invite→join on accept, →leave on decline)
    // emit MyMembership, NOT RoomMemberEvent.Membership — without this the
    // accepted invite lingers in the list until a full reload.
    client.on(RoomEvent.MyMembership, refresh);
    client.on(RoomEvent.Receipt, refresh);
    client.on(RoomEvent.Tags, refresh);
    return () => {
      client.off(ClientEvent.Room, refresh);
      client.off(RoomEvent.Name, refresh);
      client.off(RoomMemberEvent.Membership, refresh);
      client.off(RoomEvent.MyMembership, refresh);
      client.off(RoomEvent.Receipt, refresh);
      client.off(RoomEvent.Tags, refresh);
    };
  }, [client, status]);

  // Membership (BACKGROUND): ensure we're in the Community Hub space and auto-join
  // its whole tree (sub-spaces + channels, recursively) so every member sees the
  // full community — including the forum — without hunting for rooms. This is the
  // slow part (getRoomHierarchy + N joins) and is intentionally NOT awaited by the
  // landing effect below, so it never delays the timeline appearing.
  useEffect(() => {
    if (status !== "ready" || !client || membershipDoneRef.current) return;
    membershipDoneRef.current = true;
    void (async () => {
      let hub = findRoomByAlias(client.getRooms(), COMMUNITY_HUB_ALIAS);
      if (!hub) {
        try {
          const joined = await client.joinRoom(COMMUNITY_HUB_ALIAS);
          hub = typeof joined === "string" ? client.getRoom(joined) : joined;
        } catch (e) {
          console.warn("[Matrix] could not join community hub:", e);
        }
      }
      if (!hub) return;
      try {
        const hier = await client.getRoomHierarchy(hub.roomId, 100, 5);
        const entries: Array<{ room_id: string; children_state?: Array<{ state_key: string; content?: { via?: string[] } }> }> =
          hier?.rooms ?? [];
        // Map each child room id → its via servers (from parent m.space.child).
        const viaFor = new Map<string, string[]>();
        for (const e of entries) {
          for (const cs of e.children_state ?? []) {
            if (cs.state_key && cs.content?.via?.length) viaFor.set(cs.state_key, cs.content.via);
          }
        }
        await Promise.all(
          entries
            .filter((e) => e.room_id && e.room_id !== hub!.roomId)
            .filter((e) => client.getRoom(e.room_id)?.getMyMembership() !== "join")
            .map((e) =>
              client
                .joinRoom(e.room_id, { viaServers: viaFor.get(e.room_id) ?? [matrixServerName()] })
                .catch((err: unknown) => console.warn("[Matrix] auto-join failed", e.room_id, err))
            )
        );
      } catch (e) {
        console.warn("[Matrix] hub hierarchy auto-join failed:", e);
      }
    })();
  }, [status, client]);

  // Landing (FAST): put the timeline on General by default — but only when the
  // caller has no remembered space (it owns landing then). Decoupled from the
  // membership join above; General is normally already in cache so this lands
  // immediately. When `landDefaultRoom` flips true later (stale stored space),
  // this re-runs and lands General as the backstop.
  useEffect(() => {
    if (status !== "ready" || !client || !landDefaultRoom || landedRef.current) return;
    landedRef.current = true;
    const existingGeneral = findRoomByAlias(client.getRooms(), GENERAL_ALIAS);
    if (existingGeneral) {
      onLandingRoomRef.current(existingGeneral);
      return;
    }
    void (async () => {
      try {
        const general = await client.joinRoom(GENERAL_ALIAS);
        const generalRoom = typeof general === "string" ? client.getRoom(general) : general;
        if (generalRoom) onLandingRoomRef.current(generalRoom);
      } catch (e) {
        console.warn("[Matrix] could not join general:", e);
      }
    })();
  }, [status, client, landDefaultRoom]);

  return { rooms, invites };
}
