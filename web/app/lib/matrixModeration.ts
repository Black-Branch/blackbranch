// Moderation vocabulary for the community: what a power level is CALLED, who
// may act, and how a fan-out across a server's channels reads back.
//
// Pure on purpose — the fan-out itself (matrixModerate.ts) and the member card
// both need these answers, and neither should own them.

export type PowerTier = { rank: number; label: string; showNumber: boolean };

/**
 * The label for a power level.
 *
 * `Infinity` is real, not a guard: these rooms are room version 12, where the
 * creator is excluded from the `users` map and matrix-js-sdk returns Infinity
 * for them (`powerLevelForUserId`, room-state.js) — printed raw, the creator's
 * own card would read "power Infinity".
 */
export function powerTier(pl: number): PowerTier {
  if (!Number.isFinite(pl)) return { rank: 0, label: "Owner", showNumber: false };
  if (pl >= 100) return { rank: 1, label: "Admin", showNumber: true };
  if (pl >= 50) return { rank: 2, label: "Moderator", showNumber: true };
  return { rank: 3, label: "Member", showNumber: true };
}

/** The slice of Room these read; an SDK Room satisfies it. */
export type ModRoom = {
  currentState: { hasSufficientPowerLevelFor(action: string, powerLevel: number): boolean };
  getMember(userId: string): { powerLevel: number; membership?: string } | null;
};

function may(room: ModRoom, userId: string, action: "kick" | "ban"): boolean {
  const me = room.getMember(userId);
  if (!me) return false;
  return room.currentState.hasSufficientPowerLevelFor(action, me.powerLevel);
}

/** The room's OWN kick level decides — never a literal 50, which is only this
 *  server's current setting and is room state anyone with 100 can change. */
export function canKick(room: ModRoom, myUserId: string): boolean {
  return may(room, myUserId, "kick");
}

export function canBan(room: ModRoom, myUserId: string): boolean {
  return may(room, myUserId, "ban");
}

export function isBannedIn(room: ModRoom, userId: string): boolean {
  return room.getMember(userId)?.membership === "ban";
}

export type RoomOutcome = {
  roomId: string;
  name: string;
  /** "noop" = the target was not in that room, which is the desired end state. */
  status: "ok" | "noop" | "failed";
  error?: string;
};

export type SiteOutcome = { attempted: boolean; ok: boolean; reason?: string };

/** Kick has no site half at all (MemberCard's siteBan short-circuits before it
 *  ever reaches the network); ban and unban both reach `site.bans` AND fan out
 *  to the platforms (Twitch, Kick, YouTube) via fanOutBan/fanOutUnban, so their
 *  site line must say so — "Site ban applied." alone would hide the three
 *  platforms it also banned the person from. */
const SITE_NOUN: Record<"kick" | "ban" | "unban", string> = { kick: "ban", ban: "ban", unban: "unban" };

/**
 * The lines the card shows after a fan-out. Never one cheerful sentence: the
 * Matrix half and the site half fail independently, and a partial Matrix result
 * must say how partial.
 *
 * `action` (not a pre-picked verb) is what lets this speak the right
 * vocabulary for BOTH halves at once — a caller-supplied Matrix verb with a
 * hardcoded site line would render "Unbanned from 20 channels." followed by
 * the OPPOSITE claim, "Site ban applied."
 */
export function moderationSummary(action: "kick" | "ban" | "unban", rooms: RoomOutcome[], site: SiteOutcome): string[] {
  const verb = action === "kick" ? "Kicked" : action === "ban" ? "Banned" : "Unbanned";
  const noun = SITE_NOUN[action];
  const done = rooms.filter((r) => r.status !== "failed");
  const failed = rooms.filter((r) => r.status === "failed");
  const lines: string[] = [];

  lines.push(
    failed.length === 0
      ? `${verb} from ${rooms.length} ${rooms.length === 1 ? "channel" : "channels"}.`
      : `${verb} from ${done.length} of ${rooms.length} channels.`
  );
  if (failed.length > 0) lines.push(`Failed: ${failed.map((r) => r.name).join(", ")}.`);

  if (!site.attempted) {
    if (site.reason) lines.push(`No site ${noun} — ${site.reason}.`);
  } else if (site.ok) {
    // `site.ok` is only the site's own response (route.ts's `res.ok`) — the
    // platform fan-out (fanOutBan/fanOutUnban) is fired AFTER that response
    // and deliberately never awaited, so a Twitch/Kick/YouTube failure (an
    // expired token, say) is invisible here. Say only what is actually
    // known: the site half is confirmed, the platform half is dispatched,
    // not confirmed — neither too little ("Site ban applied.") nor too much.
    lines.push(`Site ${noun} applied; platform ${noun}s sent.`);
  } else {
    lines.push(`Site and platform ${noun} failed${site.reason ? `: ${site.reason}` : ""}.`);
  }
  return lines;
}
