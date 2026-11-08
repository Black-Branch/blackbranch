// Admin Panel › Site › Discord, the Bot and Import steps, server side (community plan task 2.3). The
// route.ts files check is_admin + same-origin first and hand over to these.
//
// Bot: the streamer pastes the bot token; the site drops it for the host, which writes it into .env
// (the bridge reads it from there) and removes the drop; the site keeps no copy (decision 0144). Who
// the bot is, and the servers it is in, the host reads through the bridge.
// Import: the host reads one Discord server through the bridge (results/discord-guild.json); the
// page shows the proposal (discordImport.ts) and the streamer edits it; the confirm computes it again
// from that same read, against the rows as they are now, writes what is new (and the changes the
// streamer ticked) in one transaction, and asks the host for a reconciler run. A second import
// matches on discord_import_id, so it never makes a row twice.
import {
  diffImport, guildFrom, importPlan, proposeCommunity, TIERS,
  type DiscordGuild, type ImportChoices, type ImportedHere, type Tier,
} from "./discordImport.ts";
import { orderKeyBetween } from "./desired.ts";
import type { AskResult } from "./communityAdmin.ts";

type Rows<R> = Promise<{ rows: R[] }>;
type Queryable = { query: <R extends object>(sql: string, params?: unknown[]) => Rows<R> };
type Client = Queryable & { release: () => void };
type HostAnswer = { ok: boolean; at: string; message: string; request?: string } | null;
type ImportVerb = "discord-bot" | "discord-token" | `discord-read-${string}`;

export type ImportDeps = {
  pool: Queryable & { connect: () => Promise<Client> };
  canCall: boolean;
  askHost: (verb: ImportVerb) => Promise<AskResult>;
  hostAnswer: (verb: "discord-bot" | "discord-token" | "discord-read") => Promise<HostAnswer>;
  hostFile: (name: "discord-bot-info.json" | "discord-guild.json") => Promise<unknown>;
  dropToken: (token: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Ask for an apply run (null when the reconciler is off: the rows wait for it). */
  reconcile: (() => Promise<AskResult>) | null;
  retentionCapDays: () => number;
  sleep?: (ms: number) => Promise<void>;
  waits?: { hostMs: number; stepMs: number };
  now?: () => number;
  log?: Pick<Console, "log" | "error">;
  admin?: string;
};

const NO_STORE = { "Cache-Control": "no-store" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });
const refuse = (status: number, error: string) => reply({ error }, status);
const WAITS = { hostMs: 60_000, stepMs: 1_000 };
const NO_HOST = "This install cannot ask its server to reach Discord (it is not the bundle).";
/** A read older than this is read again before it is imported. */
const READ_FRESH_MS = 60 * 60_000;
const SNOWFLAKE = /^\d{17,20}$/;
/** A Discord bot token as Discord shows one (the host checks the same shape). */
const BOT_TOKEN = /^[A-Za-z0-9_-]{20,40}\.[A-Za-z0-9_-]{4,10}\.[A-Za-z0-9_-]{20,80}$/;

class Refusal extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function body(req: Request): Promise<Record<string, unknown> | null> {
  const b = (await req.json().catch(() => null)) as unknown;
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}

/** Ask the host for `verb` and wait for the answer to THAT request. */
async function hostDoes(deps: ImportDeps, verb: ImportVerb, answerName: "discord-bot" | "discord-token" | "discord-read"): Promise<{ ok: boolean; words: string }> {
  const asked = await deps.askHost(verb).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
  if (!asked.ok) return { ok: false, words: `The server could not be asked: ${asked.error}` };
  const step = deps.waits?.stepMs ?? WAITS.stepMs;
  const sleep = deps.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t)));
  for (let waited = 0; waited <= (deps.waits?.hostMs ?? WAITS.hostMs); waited += step) {
    const a = await deps.hostAnswer(answerName).catch(() => null);
    if (a && Date.parse(a.at) >= Date.parse(asked.requestedAt) && (!a.request || a.request === verb)) return { ok: a.ok, words: a.message };
    await sleep(step);
  }
  return { ok: false, words: "The server has not answered yet. Try again in a minute." };
}

const log = (deps: ImportDeps, what: string) => (deps.log ?? console).log(`[community] ${deps.admin ?? "an admin"}: ${what}`);

// ── Bot ───────────────────────────────────────────────────────────────────────────────────────────

export type BotView = {
  canCall: boolean;
  /** The last read of the bot: null = never read. */
  bot: null | { ok: true; name: string; intents: { members: boolean; content: boolean; presence: boolean }; invite: string | null; guilds: { id: string; name: string }[] }
    | { ok: false; status: number | null; error: string };
  /** The Discord server the community was imported from, and when. */
  imported: { guildId: string; guildName: string; importedAt: string } | null;
};

function botFrom(j: unknown): BotView["bot"] {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (o.ok !== true) {
    return { ok: false, status: typeof o.status === "number" ? o.status : null, error: typeof o.error === "string" ? o.error.slice(0, 200) : "Discord refused" };
  }
  const b = (o.bot ?? {}) as Record<string, unknown>, i = (o.intents ?? {}) as Record<string, unknown>;
  const invite = typeof o.invite === "string" && /^https:\/\/discord\.com\/oauth2\/authorize\?client_id=\d{17,20}&scope=bot&permissions=\d{1,30}$/.test(o.invite) ? o.invite : null;
  const guilds = (Array.isArray(o.guilds) ? o.guilds : []).slice(0, 200).flatMap((g) => {
    const x = (g ?? {}) as Record<string, unknown>;
    return typeof x.id === "string" && SNOWFLAKE.test(x.id) ? [{ id: x.id, name: typeof x.name === "string" ? x.name.slice(0, 100) : "" }] : [];
  });
  return { ok: true, name: typeof b.name === "string" ? b.name.slice(0, 100) : "", intents: { members: i.members === true, content: i.content === true, presence: i.presence === true }, invite, guilds };
}

async function importedRecord(db: Queryable): Promise<BotView["imported"]> {
  const { rows } = await db.query<{ guild_id: string; guild_name: string; imported_at: Date | string }>(
    `SELECT guild_id, guild_name, imported_at FROM site.community_discord_import ORDER BY imported_at DESC LIMIT 1`);
  const r = rows[0];
  return r ? { guildId: r.guild_id, guildName: r.guild_name, importedAt: new Date(r.imported_at).toISOString() } : null;
}

/** GET …/discord/bot — the bot as last read, and the server the community was imported from. */
export async function botViewResponse(deps: ImportDeps): Promise<Response> {
  try {
    const [file, imported] = await Promise.all([deps.hostFile("discord-bot-info.json"), importedRecord(deps.pool)]);
    const view: BotView = { canCall: deps.canCall, bot: botFrom(file), imported };
    return reply(view);
  } catch (e) {
    (deps.log ?? console).error("[community] discord bot view failed:", e instanceof Error ? e.message : e);
    return refuse(503, "Could not read the Discord bot: the database did not answer.");
  }
}

/** POST …/discord/bot {token} — hand the bot token to the server (into .env), then read the bot again. */
export async function setTokenResponse(req: Request, deps: ImportDeps): Promise<Response> {
  const token = (await body(req))?.token;
  const t = typeof token === "string" ? token.trim() : "";
  if (!BOT_TOKEN.test(t)) return refuse(400, "That is not a Discord bot token. In Discord's Developer Portal: your application, Bot, Reset Token, then copy the token it shows.");
  if (!deps.canCall) return refuse(409, NO_HOST);
  const dropped = await deps.dropToken(t);
  if (!dropped.ok) return refuse(409, `Not saved: ${dropped.error}`);
  const saved = await hostDoes(deps, "discord-token", "discord-token");
  if (!saved.ok) return refuse(409, `Not saved: ${saved.words}`);
  log(deps, "set the Discord bot token");
  // The bridge restarts with the new token: the read waits for it (best effort; Check again reads later).
  const read = await hostDoes(deps, "discord-bot", "discord-bot");
  return reply({ ok: true, words: read.ok ? `Saved. ${saved.words.replace(/^saved[.;]? ?/i, "")}`.trim() : `Saved (${saved.words}). The bot could not be read yet: ${read.words}` });
}

/** POST …/discord/bot/check — read the bot again. */
export async function checkBotResponse(deps: ImportDeps): Promise<Response> {
  if (!deps.canCall) return refuse(409, NO_HOST);
  const r = await hostDoes(deps, "discord-bot", "discord-bot");
  return r.ok ? reply({ ok: true, words: "Read again." }) : refuse(409, r.words);
}

// ── Import ────────────────────────────────────────────────────────────────────────────────────────

type HereRows = ImportedHere & { hubName: string | null };

async function readHere(db: Queryable): Promise<HereRows> {
  const spaces = (await db.query<{ id: number; kind: string; discordImportId: string | null; name: string }>(
    `SELECT id, kind, discord_import_id AS "discordImportId", name FROM site.community_spaces WHERE kind IN ('hub', 'category') ORDER BY id`)).rows;
  const rooms = (await db.query<ImportedHere["rooms"][number]>(
    `SELECT id, discord_import_id AS "discordImportId", space_id AS "spaceId", name, see_rule AS see, post_rule AS post, discord_channel_id AS "discordChannelId"
       FROM site.community_rooms ORDER BY id`)).rows;
  const hub = spaces.find((s) => s.kind === "hub") ?? null;
  return {
    hubId: hub ? Number(hub.id) : null, hubName: hub?.name ?? null,
    spaces: spaces.map((s) => ({ id: Number(s.id), discordImportId: s.discordImportId, name: s.name })),
    rooms: rooms.map((r) => ({ ...r, id: Number(r.id), spaceId: Number(r.spaceId) })),
  };
}

async function savedTiers(db: Queryable, guildId: string): Promise<Record<string, Tier>> {
  const { rows } = await db.query<{ role_id: string; rung: string }>(`SELECT role_id, rung FROM site.community_discord_roles WHERE guild_id = $1`, [guildId]);
  return Object.fromEntries(rows.filter((r) => TIERS.includes(r.rung as Tier)).map((r) => [r.role_id, r.rung as Tier]));
}

/** The host's copy of the last read, when it is of `guildId` and fresh enough. */
async function lastRead(deps: ImportDeps, guildId: string): Promise<DiscordGuild | null> {
  const g = guildFrom(await deps.hostFile("discord-guild.json"));
  if (!g || g.id !== guildId) return null;
  const at = g.readAt ? Date.parse(g.readAt) : NaN;
  return Number.isFinite(at) && (deps.now ?? Date.now)() - at < READ_FRESH_MS ? g : null;
}

export type ImportReadView = { guild: DiscordGuild; here: HereRows; savedTiers: Record<string, Tier>; retentionCapDays: number };

/** POST …/discord/import/read {guildId} — read the Discord server now; the page builds the proposal from it. */
export async function readImportResponse(req: Request, deps: ImportDeps): Promise<Response> {
  const guildId = (await body(req))?.guildId;
  if (typeof guildId !== "string" || !SNOWFLAKE.test(guildId)) return refuse(400, "A Discord server ID is 17 to 20 digits (or pick one of the bot's servers).");
  if (!deps.canCall) return refuse(409, NO_HOST);
  const r = await hostDoes(deps, `discord-read-${guildId}`, "discord-read");
  if (!r.ok) return refuse(409, `Not read: ${r.words}`);
  const guild = await lastRead(deps, guildId);
  if (!guild) return refuse(409, "The server's copy of what it read cannot be used. Press Read again.");
  try {
    const here = await readHere(deps.pool);
    if (here.hubId === null) return refuse(409, "The community has no main space yet: finish the community setup first.");
    const view: ImportReadView = { guild, here, savedTiers: await savedTiers(deps.pool, guildId), retentionCapDays: deps.retentionCapDays() };
    return reply(view);
  } catch (e) {
    (deps.log ?? console).error("[community] discord import read failed:", e instanceof Error ? e.message : e);
    return refuse(503, "Could not read the community: the database did not answer.");
  }
}

function tiersFrom(v: unknown): Record<string, Tier> | null {
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const e = Object.entries(v as Record<string, unknown>);
  if (e.length > 1000 || !e.every(([k, t]) => SNOWFLAKE.test(k) && TIERS.includes(t as Tier))) return null;
  return Object.fromEntries(e) as Record<string, Tier>;
}
function choicesFrom(v: unknown): ImportChoices | null {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  if (!o) return null;
  const map = (x: unknown) => (x === undefined ? {} : x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length <= 1000
    && Object.entries(x).every(([k, c]) => SNOWFLAKE.test(k) && c && typeof c === "object" && !Array.isArray(c)) ? x : null);
  const rooms = map(o.rooms), spaces = map(o.spaces);
  if (!rooms || !spaces) return null;
  for (const c of Object.values(rooms) as Record<string, unknown>[]) {
    if ("include" in c && typeof c.include !== "boolean") return null;
    if ("name" in c && typeof c.name !== "string") return null;
  }
  return { rooms, spaces } as ImportChoices;
}

/** The next order key after a list's last (renumbering a list whose keys are not of the panel's scheme). */
async function keyAfter(db: Queryable, table: "spaces" | "rooms", where: string, param: number): Promise<string> {
  const rows = (await db.query<{ id: number; order_key: string }>(
    `SELECT id, order_key FROM site.community_${table} WHERE ${where} = $1 ORDER BY order_key COLLATE "C", id`, [param])).rows;
  try {
    return orderKeyBetween(rows.at(-1)?.order_key ?? null, null);
  } catch {
    let key: string | null = null;
    for (const r of rows) {
      key = orderKeyBetween(key, null);
      await db.query(`UPDATE site.community_${table} SET order_key = $2 WHERE id = $1`, [r.id, key]);
    }
    return orderKeyBetween(key, null);
  }
}

const MAX_TOPIC = 1000;

/** POST …/discord/import {guildId, roleTiers, choices} — make the community as the streamer confirmed it. */
export async function confirmImportResponse(req: Request, deps: ImportDeps): Promise<Response> {
  const b = await body(req);
  const guildId = b?.guildId;
  if (typeof guildId !== "string" || !SNOWFLAKE.test(guildId)) return refuse(400, "A Discord server ID is 17 to 20 digits.");
  const roleTiers = tiersFrom(b?.roleTiers), choices = choicesFrom(b?.choices ?? {});
  if (!roleTiers || !choices) return refuse(400, "Not an import.");
  const guild = await lastRead(deps, guildId);
  if (!guild) return refuse(409, "The read of that Discord server is gone or more than an hour old. Press Read again, then confirm.");
  const proposal = proposeCommunity(guild, { roleTiers });
  let made: { spaces: number; rooms: number; updated: number };
  const db = await deps.pool.connect();
  try {
    await db.query("BEGIN");
    // One import at a time: the hub row is the lock (a second confirm waits, then finds the rows made).
    const hub = (await db.query<{ id: number }>(`SELECT id FROM site.community_spaces WHERE kind = 'hub' ORDER BY id LIMIT 1 FOR UPDATE`)).rows[0];
    if (!hub) throw new Refusal(409, "The community has no main space yet: finish the community setup first.");
    const here = await readHere(db);
    const plan = importPlan(proposal, diffImport(proposal, here), choices, { retentionCapDays: deps.retentionCapDays() });
    if ("error" in plan) throw new Refusal(400, plan.error);
    const spaceIds = new Map<string, number>();
    for (const s of plan.newSpaces) {
      const key = await keyAfter(db, "spaces", "parent_id", Number(hub.id));
      await db.query(`INSERT INTO site.community_spaces (parent_id, kind, name, order_key, discord_import_id) VALUES ($1, 'category', $2, $3, $4)
        ON CONFLICT (discord_import_id) DO NOTHING`, [hub.id, s.name, key, s.discordId]);
      const id = (await db.query<{ id: number }>(`SELECT id FROM site.community_spaces WHERE discord_import_id = $1`, [s.discordId])).rows[0]!.id;
      spaceIds.set(s.discordId, Number(id));
    }
    let rooms = 0;
    for (const r of plan.newRooms) {
      const spaceId = "hub" in r.spaceRef ? Number(hub.id) : "rowId" in r.spaceRef ? r.spaceRef.rowId : spaceIds.get(r.spaceRef.discordId)!;
      const key = await keyAfter(db, "rooms", "space_id", spaceId);
      const ins = await db.query<{ id: number }>(`INSERT INTO site.community_rooms (space_id, kind, name, topic, order_key, see_rule, post_rule,
          retention_days, encrypted, published, archived, discord_import_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, false, $10) ON CONFLICT (discord_import_id) DO NOTHING RETURNING id`,
        [spaceId, r.kind, r.name, r.topic ? r.topic.slice(0, MAX_TOPIC) : null, key, r.see, r.post, r.retentionDays, r.published, r.discordId]);
      rooms += ins.rows.length;
    }
    let updated = 0;
    for (const u of plan.updates) {
      const up = await db.query<{ id: number }>(`UPDATE site.community_rooms SET name = $3, see_rule = $4, post_rule = $5, published = $6, updated_at = now()
        WHERE id = $1 AND discord_import_id = $2 AND NOT (encrypted AND $4 = 'everyone') RETURNING id`, [u.rowId, u.discordId, u.name, u.see, u.post, u.published]);
      updated += up.rows.length;
    }
    for (const role of proposal.roleMap) {
      await db.query(`INSERT INTO site.community_discord_roles (role_id, guild_id, name, rung, source, updated_at) VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT (role_id) DO UPDATE SET guild_id = EXCLUDED.guild_id, name = EXCLUDED.name, rung = EXCLUDED.rung, source = EXCLUDED.source, updated_at = now()`,
        [role.id, guild.id, role.name, role.tier, role.source]);
    }
    await db.query(`INSERT INTO site.community_discord_import (guild_id, guild_name, imported_at, imported_by) VALUES ($1, $2, now(), $3)
      ON CONFLICT (guild_id) DO UPDATE SET guild_name = EXCLUDED.guild_name, imported_at = now(), imported_by = EXCLUDED.imported_by`, [guild.id, guild.name, deps.admin ?? null]);
    await db.query("COMMIT");
    made = { spaces: plan.newSpaces.length, rooms, updated };
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    if (e instanceof Refusal) return refuse(e.status, e.message);
    (deps.log ?? console).error("[community] discord import failed:", e instanceof Error ? e.message : e);
    return refuse(503, "Not imported: the database did not answer. Nothing was changed; try again.");
  } finally {
    db.release();
  }
  const asked = deps.reconcile ? await deps.reconcile().catch(() => ({ ok: false as const, error: "" })) : null;
  log(deps, `imported Discord server ${guild.id}: ${made.spaces} categories, ${made.rooms} channels, ${made.updated} changed`);
  const what = made.spaces + made.rooms + made.updated === 0 ? "Nothing new to import: the community already has every channel you chose."
    : `Imported ${made.rooms} channel${made.rooms === 1 ? "" : "s"}${made.spaces ? ` in ${made.spaces} new categor${made.spaces === 1 ? "y" : "ies"}` : ""}${made.updated ? `, ${made.updated} changed` : ""}.`;
  const next = !deps.reconcile ? " The community keeper is off on this install, so the server makes them once it is turned on (sudo blackbranch community on)."
    : asked && asked.ok ? " The server is making them now; then link each room to its Discord channel below." : " The server makes them on its next run (within 10 minutes).";
  return reply({ ok: true, ...made, words: what + (made.spaces + made.rooms + made.updated ? next : "") });
}
