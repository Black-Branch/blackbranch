// Which site mods are missing power in which channels.
//
// A community channel's power list can be EMPTY with its kick/ban level at 50,
// so without this nobody but the room creator can moderate anything and the
// card's buttons are creator-only.
//
// No import: this loads under `node --test`, where the `@/` alias does not
// resolve, so it must stay dependency-free.

export const MOD_POWER = 50;
// Not exported: nothing outside this file needs the literal, and an unused
// export fails check-orphans.mjs.
const POWER_LEVELS_EVENT = "m.room.power_levels";

/** The slice of Room this reads; an SDK Room satisfies it. */
export type PlanRoom = {
  roomId: string;
  currentState: { maySendStateEvent(type: string, userId: string): boolean };
  getMember(userId: string): { powerLevel: number } | null;
};

/**
 * One entry per room that needs a write, naming only the users to raise.
 *
 * Never demotes: a mod already at or above the level is omitted, so a hand-set
 * 100 survives. Never includes the viewer: a room-version-12 creator holds
 * Infinity through the create event and has no `users` entry — writing one
 * would replace unlimited power with 50.
 */
export function modPowerPlan(
  rooms: PlanRoom[],
  modIds: string[],
  viewerId: string,
  level: number = MOD_POWER
): { roomId: string; userIds: string[] }[] {
  const targets = modIds.filter((id) => id && id !== viewerId);
  const plan: { roomId: string; userIds: string[] }[] = [];
  for (const room of rooms) {
    if (!room.currentState.maySendStateEvent(POWER_LEVELS_EVENT, viewerId)) continue;
    const userIds = targets.filter((id) => (room.getMember(id)?.powerLevel ?? 0) < level);
    if (userIds.length > 0) plan.push({ roomId: room.roomId, userIds });
  }
  return plan;
}

/** A room as the demote plan reads it: the power list itself too, because power is granted
 *  to mods who never joined (above), and a non-member has no member to ask. */
export type DemoteRoom = PlanRoom & {
  currentState: {
    /** With a key: that one event (the power list). Without: every event of the type (the SDK's
     *  overload) — a bridged room's bridge events. Read defensively either way. */
    getStateEvents(type: string, stateKey?: string): unknown;
  };
};

/** The state events a bridge writes into a room it bridges (MSC2346, and its older name); each
 *  names the bridge's bot account in `bridgebot`. */
const BRIDGE_EVENTS = ["m.bridge", "uk.half-shot.bridge"];

/** The bridge bots a room names — counted only from an event whose SENDER could not have got power
 *  by being a mod: someone above `level` in this room's power list (the bridge's own bot, an admin),
 *  a staff account (`trusted`), or the viewer running the reconcile (an admin; a room creator has no
 *  power-list entry). Anyone with state power can write a bridge event, so a mod about to lose the
 *  role could otherwise name themselves and keep it. */
function bridgeBots(room: DemoteRoom, listed: Record<string, unknown>, level: number, trusted: Set<string>): string[] {
  const out: string[] = [];
  for (const type of BRIDGE_EVENTS) {
    const events = room.currentState.getStateEvents(type);
    if (!Array.isArray(events)) continue;
    for (const e of events as { getContent?: () => { bridgebot?: unknown }; getSender?: () => unknown }[]) {
      const sender = e?.getSender?.();
      if (typeof sender !== "string") continue;
      const senderPower = listed[sender];
      if (!trusted.has(sender) && !(typeof senderPower === "number" && senderPower > level)) continue;
      const bot = e?.getContent?.()?.bridgebot;
      if (typeof bot === "string" && bot.startsWith("@")) out.push(bot);
    }
  }
  return out;
}

/**
 * The other direction: one entry per room where someone who is NOT a site mod (`modIds`, the
 * role's source of truth — however the role was lost: /unmod, a ban, a deleted account, a direct
 * edit) is listed with mod-level power, naming the users to take it from. Read from the power list
 * itself, because power is granted to mods who never joined (above). Only levels in (0, `level`]
 * are taken — the level the sync above grants; a higher level was set by hand and survives, as it
 * does there. Never the viewer.
 * Never an account that holds power for the install rather than as a mod (round 5): `keepIds`, the
 * install's staff accounts (streamer, bot, extra staff — /api/community/mods), and every bridge bot
 * the room itself names in its bridge state (a mautrix bridge's bot, say) — if the event came from
 * above mod level (bridgeBots). Taken from what the
 * install and the room say, never a name written here.
 */
export function modDemotePlan(
  rooms: DemoteRoom[],
  modIds: string[],
  viewerId: string,
  level: number = MOD_POWER,
  keepIds: string[] = []
): { roomId: string; userIds: string[] }[] {
  const plan: { roomId: string; userIds: string[] }[] = [];
  for (const room of rooms) {
    if (!room.currentState.maySendStateEvent(POWER_LEVELS_EVENT, viewerId)) continue;
    const power = room.currentState.getStateEvents(POWER_LEVELS_EVENT, "") as { getContent?: () => { users?: Record<string, unknown> } } | null;
    const listed = power?.getContent?.().users ?? {};
    const keep = new Set([...modIds, viewerId, ...keepIds, ...bridgeBots(room, listed, level, new Set([viewerId, ...keepIds]))]);
    const userIds = Object.entries(listed)
      .filter(([id, pl]) => !keep.has(id) && typeof pl === "number" && pl > 0 && pl <= level)
      .map(([id]) => id);
    if (userIds.length > 0) plan.push({ roomId: room.roomId, userIds });
  }
  return plan;
}
