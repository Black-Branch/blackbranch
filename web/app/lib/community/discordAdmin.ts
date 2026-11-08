// Admin Panel › Site › Discord, server side: the Links table. The site links the community to a
// Discord server, and a room to a Discord channel, through the Discord bridge's own API, which the
// host calls for it inside the bridge (discordLink.ts: the bridge's token never reaches the site);
// the bridge's own database is the record of what is linked, which the host reads
// into results/ on request (discordLinks.ts). The route.ts files check is_admin + same-origin first.
//
// Order of a link, each step retried by pressing the button again:
//   1. a room's row is marked with its channel (the site's wish: the reconciler then treats the room
//      as the bridge's for what the bridge writes, and seats the bridge's bot there at 100);
//   2. the bridge is asked; when it says its bot is not seated yet, the server is asked for a run,
//      waited for, and the bridge asked once more;
//   3. a refusal that waiting cannot fix (another server's channel, a channel already linked) takes
//      the mark off again, so the table never shows a link the bridge does not hold.
// Only a channel everyone in the community can see and post in is linked: the bridge sets a linked
// room's join rule (open to the community) and its post level (from the Discord channel's @everyone),
// so a narrower one would quietly widen. Spec:
// docs/superpowers/plans/2026-10-23-community-management-discord.md task 2.4.
import { isDiscordId, linkRoom, linkSpace, setPrivacy, unlinkRoom, unlinkSpace, type BridgeCall, type Outcome } from "./discordLink.ts";
import { linkedGuildOf, type BridgeLinks } from "./discordLinks.ts";
import type { AskResult } from "./communityAdmin.ts";

type Rows<R> = Promise<{ rows: R[] }>;
type Queryable = { query: <R extends object>(sql: string, params?: unknown[]) => Rows<R> };

export type BridgeState = { state: "on" | "off" | "waiting"; words: string };

/** The doctor's Discord bridge row (config/doctor.mjs discord.bridge) in three words: on (green), off
 *  (grey: no token, not a bundle, not checked), waiting (anything else, and grey "on: starting"). */
export function bridgeStateFrom(row: { status: string; detail: string } | undefined): BridgeState {
  if (!row) return { state: "off", words: "not checked" };
  const words = row.detail || (row.status === "ok" ? "on and running" : "");
  if (row.status === "ok") return { state: "on", words };
  if (row.status === "grey" && !/starting/.test(words)) return { state: "off", words };
  return { state: "waiting", words };
}
type HostAnswer = { ok: boolean; at: string; message: string } | null;

export type DiscordDeps = {
  pool: Queryable;
  /** One call to the bridge's API, made by the host inside the bridge. */
  call: BridgeCall;
  /** This install can ask its host (the bundle's request folder exists). */
  canCall: boolean;
  hubRoomId: () => Promise<string | null>;
  /** What the bridge has linked, as the host last read it; null when that cannot be read. */
  links: () => Promise<BridgeLinks | null>;
  /** Ask the host for a verb (requestHost) and read its answer (hostResult). */
  askHost: (verb: "discord-links" | `discord-guild-${string}`) => Promise<AskResult>;
  hostAnswer: () => Promise<HostAnswer>;
  /** Ask for an apply run (null when the reconciler is off: nothing would seat the bot). */
  reconcile: (() => Promise<AskResult>) | null;
  /** Has an apply run that started at or after `iso` finished? */
  runFinishedSince: (iso: string) => Promise<boolean>;
  bridgeState: () => Promise<BridgeState>;
  sleep?: (ms: number) => Promise<void>;
  /** How long a press waits for the host, and for the run that seats the bot. */
  waits?: { hostMs: number; runMs: number; stepMs: number };
  log?: Pick<Console, "log" | "error">;
  admin?: string;
};

const NO_STORE = { "Cache-Control": "no-store" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });
const refuse = (status: number, error: string) => reply({ error }, status);
const WAITS = { hostMs: 20_000, runMs: 60_000, stepMs: 1_000 };

const NO_HOST = "This install cannot ask its server to reach the Discord bridge (it is not the bundle).";
const NO_HUB = "The community has no main space yet: finish the community setup first.";
const LINKS_UNKNOWN = "The site cannot read what the Discord bridge has linked right now, so nothing was changed. Press Check again, then try once more.";
const SEE_EVERYONE = "Only a channel everyone in the community can see can be linked: the bridge opens a linked room to the whole community.";
const POST_EVERYONE = "Only a channel everyone in the community can post in can be linked: who may post in a linked room follows the Discord channel.";

async function body(req: Request): Promise<Record<string, unknown> | null> {
  const b = (await req.json().catch(() => null)) as unknown;
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}

async function waitFor(deps: DiscordDeps, ms: number, done: () => Promise<boolean>): Promise<boolean> {
  const step = deps.waits?.stepMs ?? WAITS.stepMs;
  const sleep = deps.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t)));
  for (let waited = 0; ; waited += step) {
    if (await done().catch(() => false)) return true;
    if (waited >= ms) return false;
    await sleep(step);
  }
}

/** Ask the host for `verb` and wait for its answer. */
async function hostDoes(deps: DiscordDeps, verb: "discord-links" | `discord-guild-${string}`): Promise<{ ok: boolean; words: string }> {
  const asked = await deps.askHost(verb).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
  if (!asked.ok) return { ok: false, words: `The server could not be asked: ${asked.error}` };
  let answer: HostAnswer = null;
  const got = await waitFor(deps, deps.waits?.hostMs ?? WAITS.hostMs, async () => {
    answer = await deps.hostAnswer();
    return !!answer && Date.parse(answer.at) >= Date.parse(asked.requestedAt);
  });
  if (!got || !answer) return { ok: false, words: "The server has not answered yet. Try again in a minute." };
  const a = answer as { ok: boolean; message: string };
  return { ok: a.ok, words: a.message };
}

/** The bridge's refusals that a server run fixes (it invites the bot and seats it at 100). */
const SEAT_WORDS = /not been invited to the community yet|does not have full power there yet|could not join yet/;

/** A bridge call; if the bot is not seated yet, one server run, waited for, then the call again. */
async function seated(deps: DiscordDeps, call: () => Promise<Outcome>): Promise<Outcome & { waited?: boolean }> {
  const first = await call();
  if (first.ok || !SEAT_WORDS.test(first.words)) return first;
  if (!deps.reconcile) return { ok: false, status: first.status, words: `${first.words} The community keeper is off on this install, so nothing seats the bridge's bot: turn it on (sudo blackbranch community on).` };
  const asked = await deps.reconcile().catch(() => ({ ok: false as const, error: "" }));
  if (!asked.ok) return { ...first, waited: false };
  const ran = await waitFor(deps, deps.waits?.runMs ?? WAITS.runMs, () => deps.runFinishedSince(asked.requestedAt));
  if (!ran) return { ok: false, status: first.status, words: "The server is still seating the bridge's bot. Press the button again in a minute.", waited: true };
  return { ...(await call()), waited: true };
}

const log = (deps: DiscordDeps, what: string) => (deps.log ?? console).log(`[community] ${deps.admin ?? "an admin"}: ${what}`);

// ── The page ──────────────────────────────────────────────────────────────────────────────────

export type DiscordRoomView = {
  id: number; name: string; see: string; post: string; archived: boolean; made: boolean;
  /** The row's channel: the site's wish (may be waiting for the bridge). */
  channelId: string | null;
  /** The bridge's own record names this room for that channel. */
  bridged: boolean;
  /** The Discord channel the room was imported from (the import), offered when it is linked. */
  importedFrom: string | null;
};
export type DiscordView = {
  bridge: BridgeState;
  /** The site can ask its host to call the bridge. */
  canCall: boolean;
  guildId: string | null;
  rooms: DiscordRoomView[];
  /** When the host last read the bridge's links (its answer), or null. */
  linksAt: string | null;
  /** The bridge's links could be read: false = unknown (every room then shows its wish only). */
  linksKnown: boolean;
};

type RoomRowLite = { id: number; name: string; see_rule: string; post_rule: string; archived: boolean; matrix_room_id: string | null; discord_channel_id: string | null; encrypted: boolean; discord_import_id?: string | null };
const ROOMS_SQL = `SELECT id, name, see_rule, post_rule, archived, matrix_room_id, discord_channel_id, encrypted, discord_import_id
  FROM site.community_rooms WHERE kind <> 'forum' ORDER BY space_id, order_key COLLATE "C", id`;

export async function discordViewResponse(deps: DiscordDeps): Promise<Response> {
  try {
    const [bridge, hub, links, answer, rooms] = await Promise.all([
      deps.bridgeState(), deps.hubRoomId(), deps.links(), deps.hostAnswer().catch(() => null), deps.pool.query<RoomRowLite>(ROOMS_SQL),
    ]);
    const guild = links ? linkedGuildOf(links, hub) : null;
    const view: DiscordView = {
      bridge, canCall: deps.canCall, guildId: guild?.guildId ?? null, linksAt: answer?.at ?? null, linksKnown: !!links,
      rooms: rooms.rows.filter((r) => !r.encrypted).map((r) => ({
        id: Number(r.id), name: r.name, see: r.see_rule, post: r.post_rule, archived: r.archived, made: !!r.matrix_room_id,
        channelId: r.discord_channel_id,
        importedFrom: r.discord_import_id ?? null,
        bridged: !!r.discord_channel_id && !!links && links.links.some((l) => l.channelId === r.discord_channel_id && l.roomId === r.matrix_room_id),
      })),
    };
    return reply(view);
  } catch (e) {
    (deps.log ?? console).error("[community] discord view failed:", e instanceof Error ? e.message : e);
    return refuse(503, "Could not read the Discord links: the database did not answer.");
  }
}

/** POST …/discord/refresh — ask the host to read the bridge's links again. */
export async function discordRefreshResponse(deps: DiscordDeps): Promise<Response> {
  const r = await hostDoes(deps, "discord-links");
  return r.ok ? reply({ ok: true }) : refuse(409, r.words);
}

// ── The Discord server ────────────────────────────────────────────────────────────────────────

/** POST …/discord/server {guildId} — link the community's space to that Discord server. */
export async function linkServerResponse(req: Request, deps: DiscordDeps): Promise<Response> {
  const guildId = (await body(req))?.guildId;
  if (!isDiscordId(guildId)) return refuse(400, "A Discord server ID is 17 to 20 digits (Discord: right-click the server, Copy Server ID).");
  if (!deps.canCall) return refuse(409, NO_HOST);
  const hub = await deps.hubRoomId();
  if (!hub) return refuse(409, NO_HUB);
  const known = await deps.links();
  if (!known) return refuse(409, LINKS_UNKNOWN);
  const current = linkedGuildOf(known, hub);
  if (current && current.guildId !== guildId) return refuse(409, "The community is linked to another Discord server. Unlink that one first.");
  const bridge = deps.call;
  if (!current) {
    const marked = await hostDoes(deps, `discord-guild-${guildId}`);
    if (!marked.ok) return refuse(409, `Not linked: ${marked.words}`);
    const linked = await seated(deps, () => linkSpace(bridge, guildId));
    // Already linked (an earlier press whose answer was lost): go on to the privacy step.
    if (!linked.ok && !/already linked/.test(linked.words)) return refuse(409, `Not linked: ${linked.words}`);
  }
  // The bridge's default makes its space invite-only at its next sync of the Discord server.
  const open = await setPrivacy(bridge, guildId);
  await hostDoes(deps, "discord-links");
  log(deps, `linked the community to Discord server ${guildId}`);
  if (!open.ok) return reply({ ok: true, words: `Linked, but the bridge did not keep the community open to everyone: ${open.words} Press Link the server again.` });
  return reply({ ok: true, words: "Linked. Now link each room to its Discord channel." });
}

/** DELETE …/discord/server — unlink the Discord server: every room, the space, and the bot leaves the server. */
export async function unlinkServerResponse(deps: DiscordDeps): Promise<Response> {
  if (!deps.canCall) return refuse(409, NO_HOST);
  const hub = await deps.hubRoomId();
  // Decided on a fresh read of the bridge's record, never the last copy the host left.
  const known = await freshLinks(deps);
  if (!known) return refuse(409, LINKS_UNKNOWN);
  // Every Discord server the bridge holds a link of this community's for: the one linked to the
  // community's space, and any other that still holds one of its channels.
  const marked = new Set((await deps.pool.query<{ discord_channel_id: string }>(
    `SELECT discord_channel_id FROM site.community_rooms WHERE discord_channel_id IS NOT NULL`)).rows.map((r) => r.discord_channel_id));
  const guilds = new Set([linkedGuildOf(known, hub)?.guildId, ...known.links.filter((l) => marked.has(l.channelId)).map((l) => l.guildId)]
    .filter((g): g is string => !!g));
  if (!guilds.size) return refuse(409, "The bridge holds no Discord server for this community, so nothing was unlinked. A room still marked can be unlinked on its own row.");
  for (const g of guilds) {
    const o = await unlinkSpace(deps.call, g);
    if (!o.ok && !/not linked/.test(o.words)) return refuse(409, `Not unlinked: ${o.words}`);
  }
  // The rows go only once the bridge's own record, read again, says each server and channel is gone.
  const now = await freshLinks(deps);
  if (!now || linkedGuildOf(now, hub)) return refuse(409, UNCONFIRMED);
  const still = new Set(now.links.map((l) => l.channelId));
  const gone = [...marked].filter((c) => !still.has(c));
  if (gone.length) await deps.pool.query(`UPDATE site.community_rooms SET discord_channel_id = NULL, updated_at = now() WHERE discord_channel_id = ANY($1::text[])`, [gone]);
  await deps.reconcile?.().catch(() => null);
  log(deps, `unlinked Discord server${guilds.size === 1 ? "" : "s"} ${[...guilds].join(", ")}`);
  if (gone.length < marked.size) return refuse(409, UNCONFIRMED);
  return reply({ ok: true, words: "Unlinked. The bridge's bot has left the Discord server; add it again to link anything later." });
}

const UNCONFIRMED = "The bridge says it unlinked, but the site could not read that back yet, so the table still shows the link. Press Check again, then Unlink again.";

/** The bridge's links read again now (null: the host could not, or the copy cannot be read). */
async function freshLinks(deps: DiscordDeps): Promise<BridgeLinks | null> {
  const read = await hostDoes(deps, "discord-links");
  return read.ok ? deps.links() : null;
}

/** Ask the host to read the bridge's links again, and check them: true only on a fresh, readable copy that passes. */
async function confirmed(deps: DiscordDeps, gone: (l: BridgeLinks) => boolean): Promise<boolean> {
  const now = await freshLinks(deps);
  return !!now && gone(now);
}

// ── One room ──────────────────────────────────────────────────────────────────────────────────

async function roomRow(db: Queryable, id: unknown): Promise<RoomRowLite | null> {
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) return null;
  const { rows } = await db.query<RoomRowLite>(`SELECT id, name, see_rule, post_rule, archived, matrix_room_id, discord_channel_id, encrypted
    FROM site.community_rooms WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** POST …/discord/links {roomId, channelId} — link a room (its row id) to a Discord channel. */
export async function linkRoomResponse(req: Request, deps: DiscordDeps): Promise<Response> {
  const b = await body(req);
  const channelId = b?.channelId;
  if (!isDiscordId(channelId)) return refuse(400, "A Discord channel ID is 17 to 20 digits (Discord: right-click the channel, Copy Channel ID).");
  if (!deps.canCall) return refuse(409, NO_HOST);
  const row = await roomRow(deps.pool, b?.roomId);
  if (!row) return refuse(404, "That room is gone. Reload the page.");
  if (row.archived) return refuse(409, "An archived room cannot be linked.");
  if (row.encrypted) return refuse(409, "An encrypted room cannot be linked to Discord.");
  if (row.see_rule !== "everyone") return refuse(409, SEE_EVERYONE);
  if (row.post_rule !== "everyone") return refuse(409, POST_EVERYONE);
  if (!row.matrix_room_id) return refuse(409, "The server has not made this room yet. Try again after its next run.");
  if (row.discord_channel_id && row.discord_channel_id !== channelId) return refuse(409, "This room is linked to another channel. Unlink it first.");
  const links = await deps.links();
  if (!links) return refuse(409, LINKS_UNKNOWN);
  const guild = linkedGuildOf(links, await deps.hubRoomId());
  if (!guild) return refuse(409, "Link the Discord server first.");
  if (!row.discord_channel_id) {
    const taken = await deps.pool.query<{ id: number }>(`SELECT id FROM site.community_rooms WHERE discord_channel_id = $1 AND id <> $2`, [channelId, row.id]);
    if (taken.rows.length) return refuse(409, "That Discord channel is linked to another room.");
    await deps.pool.query(`UPDATE site.community_rooms SET discord_channel_id = $2, updated_at = now() WHERE id = $1 AND discord_channel_id IS NULL`, [row.id, channelId]);
  }
  const room = row.matrix_room_id;
  const o = await seated(deps, () => linkRoom(deps.call, guild.guildId, channelId));
  // The bridge already holds exactly this link (a press whose answer was lost): done.
  const holds = links.links.some((l) => l.channelId === channelId && l.roomId === room);
  if (o.ok || (holds && /already linked/.test(o.words))) {
    await hostDoes(deps, "discord-links");
    log(deps, `linked #${row.name} to Discord channel ${channelId}`);
    return reply({ ok: true, linked: true, words: `Linked #${row.name} to the Discord channel.` });
  }
  // Waiting fixes a refusal about the bot's seat, or no answer: keep the wish, so the next press retries.
  const transient = o.status === null || SEAT_WORDS.test(o.words) || /still seating/.test(o.words);
  if (!transient) await deps.pool.query(`UPDATE site.community_rooms SET discord_channel_id = NULL, updated_at = now() WHERE id = $1 AND discord_channel_id = $2`, [row.id, channelId]);
  return reply({ ok: false, linked: false, waiting: transient, words: o.words }, transient ? 202 : 409);
}

/** DELETE …/discord/links {roomId} — unlink a room. Its settings become the panel's again at the next run. */
export async function unlinkRoomResponse(req: Request, deps: DiscordDeps): Promise<Response> {
  const row = await roomRow(deps.pool, (await body(req))?.roomId);
  if (!row) return refuse(404, "That room is gone. Reload the page.");
  if (!row.discord_channel_id) return reply({ ok: true, words: "That room is not linked." });
  if (!deps.canCall) return refuse(409, NO_HOST);
  const channel = row.discord_channel_id;
  // Decided on a fresh read of the bridge's record, never the last copy the host left.
  const known = await freshLinks(deps);
  if (!known) return refuse(409, LINKS_UNKNOWN);
  // The bridge's own record says which Discord server holds the channel (whatever the hub is linked to
  // now). Not in it: the bridge is asked anyway for the hub's server, which answers "not linked" if so.
  const guildId = known.links.find((l) => l.channelId === channel)?.guildId ?? linkedGuildOf(known, await deps.hubRoomId())?.guildId ?? null;
  if (guildId) {
    const o = await unlinkRoom(deps.call, guildId, channel);
    if (!o.ok) return refuse(409, `Not unlinked: ${o.words}`);
    // The mark goes only once the bridge's record, read again, no longer holds the channel.
    if (!(await confirmed(deps, (l) => !l.links.some((x) => x.channelId === channel)))) return refuse(409, UNCONFIRMED);
  }
  await deps.pool.query(`UPDATE site.community_rooms SET discord_channel_id = NULL, updated_at = now() WHERE id = $1 AND discord_channel_id = $2`, [row.id, channel]);
  await deps.reconcile?.().catch(() => null);
  log(deps, `unlinked #${row.name} from Discord`);
  return reply({ ok: true, words: `Unlinked #${row.name}. The server gives it back its own settings on its next run.` });
}
