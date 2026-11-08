// The m.direct heal (client polish Task 20; dm-crypto-research B.4 "Migration"): once per client
// start, the signed-in account files in its OWN m.direct the private rooms it made or accepted that
// are missing from it — so another client (Element's "Message", findDMForUser) finds the same room
// instead of making a fourth, and the moderation fence (isOwnDmRoom) covers it. Type-only SDK.
import type { MatrixClient } from "matrix-js-sdk";
import { dmPartnerOf, mergeDirect, strictlyOurs } from "./matrixDm.ts";
import { directSet } from "./dmConversations.ts";

/**
 * For the signed-in account only: file in its own m.direct every private
 * room missing from it that it made or whose DM invite it accepted (the invite's mark, kept after
 * the join) — the rule Task 2 holds for every filing. Through mergeDirect (read at the write). Never
 * anyone else's data; no room is left. Returns how many rooms were added.
 * @test-only exported for its own tests; product code calls healOwnDirect (each time the rooms change).
 */
export async function mergeOwnDirect(client: MatrixClient, me: string): Promise<number> {
  const direct = directSet(client);
  const add: Record<string, string[]> = {};
  let count = 0;
  for (const room of client.getRooms()) {
    if (room.getMyMembership() !== "join" || room.isSpaceRoom() || direct.has(room.roomId)) continue;
    if (room.getJoinedMemberCount() + room.getInvitedMemberCount() > 2) continue;
    await room.loadMembersIfNeeded();
    const partner = dmPartnerOf(room, me, direct);
    if (!partner) continue;
    const accepted = room.getMember(me)?.getDMInviter?.() === partner;
    const made = room.currentState.getStateEvents("m.room.create", "")?.getSender() === me && room.getMember(partner)?.getDMInviter?.() === me;
    if (!(accepted || made) || !(await strictlyOurs(client, room, partner, true))) continue;
    (add[partner] ??= []).push(room.roomId);
    count++;
  }
  if (count) await mergeDirect(client, add);
  return count;
}

const running = new WeakMap<object, { again: boolean; done: Promise<void> }>();

/** mergeOwnDirect whenever the set of rooms changes (the list's caller asks on each change: the
 *  first answer can come before the rooms have synced, and a room accepted elsewhere arrives later).
 *  One pass per client at a time; a call during a pass runs one more pass after it, never two at
 *  once (two writes of m.direct from one snapshot are how entries went missing). A pass with nothing
 *  missing writes nothing. Errors are logged, never thrown — the list renders either way, and the
 *  next change tries again. */
export function healOwnDirect(client: MatrixClient, me: string): Promise<void> {
  const now = running.get(client);
  if (now) { now.again = true; return now.done; }
  const state = { again: false, done: Promise.resolve() };
  state.done = (async () => {
    do {
      state.again = false;
      try {
        await mergeOwnDirect(client, me);
      } catch (e) {
        console.warn("[dm] could not file the DM rooms in m.direct:", e);
      }
    } while (state.again);
    running.delete(client);
  })();
  running.set(client, state);
  return state.done;
}
