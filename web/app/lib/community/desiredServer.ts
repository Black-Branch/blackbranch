// What the community reconciler reads from the site, and where it writes what it did: the feed
// behind GET /api/internal/community/desired and the run log behind POST
// /api/internal/community/runs. Both answer only the internal secret.
// Spec: docs/superpowers/specs/2026-10-23-community-management-discord-design.md §4.1-4.3, §4.11.
import { readDesired, type RoleRow, type RoomRow, type SpaceRow } from "./desired.ts";
import { columnEntitledSql, subscriptionSources } from "../subscriptions/entitlement.ts";
import type { Provider } from "../subscriptions/types.ts";
import { instanceBool, instanceList, instanceResolve, instanceString } from "../instanceConfigServer.ts";
import { matrixServerName } from "../matrixConfig.ts";
import { internalBearerOk } from "../internalSecret.ts";
import { SITE_BAN_REASON } from "../siteBanReason.ts";
import { instanceEntry } from "../instanceSchema.generated.mjs";
import { hostFile } from "../hostRequests.ts";
import { bridgeLinksFrom, linkedGuildOf, NO_LINKS, type BridgeLinks } from "./discordLinks.ts";

/** The reconciler's whole input (install/matrix reconcile reads this JSON as is). */
export type DesiredFeed = {
  serverName: string;
  hubRoomId: string | null;
  serviceUserId: string;
  /** The accounts no member list shows and the reconciler never levels: the service account, the forum reader. */
  hiddenUserIds: string[];
  spaces: SpaceRow[];
  rooms: RoomRow[];
  roles: RoleRow[];
  /** One entry per person, at the HIGHEST level a site role gives (spec §4.2). Banned people hold none; a timed-out
   *  person keeps theirs (the reconciler's −1 override decides posting; membership comes from this level). */
  people: { userId: string; level: number }[];
  /** Entitled now: a subscription record, an unexpired gift, or a staff account. Banned people are left out. */
  supporters: string[];
  banned: string[];
  timedOut: { userId: string; until: string }[];
  putBack: boolean;
  retentionCapDays: number;
  /** The reason on the site's own room bans (siteBanReason.ts): the reconciler writes it on each room ban it
   *  makes, and lifts a room ban only when its reason is exactly this and the site ban has ended. Without it,
   *  the reconciler refuses to apply. */
  siteBanReason: string;
  /** The site's bridge accounts (community.bridgeAccounts), and the Discord bridge's own bot while the host
   *  renders its registration: the only bridge bots the reconciler trusts. */
  bridgeBots: string[];
  /** The Discord bridge's user namespace, copied unchanged from its registration (whole-id regex sources; the
   *  reconciler anchors each): its puppets. Empty while the bridge is off. */
  bridgeUserPatterns: string[];
  /** The Discord bridge's own bot while its registration is rendered: the reconciler seats it at 100 in the hub
   *  and in every room linked to Discord (the bridge's link calls refuse a room where it is below that). */
  discordBot: string | null;
  /** The hub is linked to a Discord server (the bridge's guild_space names it): its name and picture then
   *  follow the Discord server's, which the bridge sets at every sync. */
  discordSpaceLinked: boolean;
};

/** What the host says about the Discord bridge's accounts (results/discord-bridge.json, written by its render
 *  while the bridge's registration is rendered; absent otherwise). */
export type BridgeAccounts = { bot: string | null; userPatterns: string[] };
const NO_BRIDGE: BridgeAccounts = { bot: null, userPatterns: [] };

/** Everything the feed takes from settings and the environment, gathered by feedEnv(). */
export type FeedEnv = {
  serverName: string;
  serviceUserId: string;
  readerUserId: string | null;
  /** The hub room the server's setup recorded (matrix.rooms.hub), for before the hub has a row. */
  hubRoomId: string | null;
  streamerId: string | null;
  /** Accounts at the Bot level: bot.matrixId and the extra staff accounts. */
  botIds: string[];
  sources: readonly Provider[];
  putBack: boolean;
  retentionCapDays: number;
  /** community.bridgeAccounts as saved. */
  bridgeAccounts: string[];
  now?: number;
};

type Queryable = { query: <R extends object>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> };

const ADMIN = 100;
const STAFF = 75;
const MOD = 50;
const BOT = 50;

/** The forum reader the install's host makes (install/blackbranch READER_LOCALPART).
 *  @test-only exported for the test that holds it equal to the host script's name */
export const FORUM_READER_LOCALPART = "forum-reader";

const PEOPLE_SQL = `
  SELECT matrix_id, is_admin, is_staff, is_mod, is_bot
    FROM site.users
   WHERE deleted_at IS NULL AND (is_admin OR is_staff OR is_mod OR is_bot)`;

// Supporter = an entitling subscription record (the one predicate) OR an unexpired gift, as the
// site's own entitlement reads it (entitlements.ts); the staff accounts are added from settings.
// The billing grace (spec §4.3 "removes after the billing grace on lapse") is already in that
// predicate: access_until = the reported period end + GRACE_DAYS (subscriptions/grace.ts). No second grace here.
const SUPPORTERS_SQL = `
  SELECT u.matrix_id
    FROM site.users u
   WHERE u.deleted_at IS NULL
     AND (${columnEntitledSql("u.matrix_id", "$1")}
          OR EXISTS (SELECT 1 FROM site.gift_subscriptions g
                      WHERE g.recipient_matrix_id = u.matrix_id AND g.expires_at > now()))
   ORDER BY u.matrix_id`;

// §4.11: a ban with no end is a room ban; one with an end is the one timeout (level −1 until then).
const BANS_SQL = `
  SELECT matrix_id, expires_at
    FROM site.bans
   WHERE expires_at IS NULL OR expires_at > now()`;

type PersonRow = { matrix_id: string; is_admin: boolean; is_staff: boolean; is_mod: boolean; is_bot: boolean };
type IdRow = { matrix_id: string };
type BanRow = { matrix_id: string; expires_at: Date | string | null };

const sorted = (ids: Iterable<string>) => [...new Set(ids)].sort();

/** The feed, read fresh on every call. Not inside a READ ONLY transaction: readDesired fills the
 *  default roles into an empty table on its first read.
 *  @test-only exported for the fixture and real-Postgres tests; the route reaches it through desiredFeedResponse */
export async function buildDesiredFeed(db: Queryable, env: FeedEnv, bridge: BridgeAccounts = NO_BRIDGE, links: BridgeLinks | null = NO_LINKS): Promise<DesiredFeed> {
  const desired = await readDesired(db);
  const [people, supporters, bans] = await Promise.all([
    db.query<PersonRow>(PEOPLE_SQL),
    db.query<IdRow>(SUPPORTERS_SQL, [env.sources]),
    db.query<BanRow>(BANS_SQL),
  ]);

  const now = env.now ?? Date.now();
  const banned: string[] = [];
  const latest = new Map<string, number>(); // one timeout per person: the latest end wins
  for (const b of bans.rows) {
    if (b.expires_at === null) { banned.push(b.matrix_id); continue; }
    const until = new Date(b.expires_at).getTime();
    if (until > now && until > (latest.get(b.matrix_id) ?? -Infinity)) latest.set(b.matrix_id, until);
  }
  const bannedSet = new Set(banned);
  banned.splice(0, banned.length, ...sorted(bannedSet));
  // A permanent ban outranks a timeout: the person is in `banned` only.
  const timedOut = sorted(latest.keys()).filter((id) => !bannedSet.has(id))
    .map((userId) => ({ userId, until: new Date(latest.get(userId)!).toISOString() }));

  const hiddenUserIds = hiddenUserIdsOf(env);
  const hidden = new Set(hiddenUserIds);
  const noLevel = new Set([...hidden, ...banned]);

  const levels = new Map<string, number>();
  const raise = (id: string | null, level: number) => {
    if (!id || noLevel.has(id)) return;
    levels.set(id, Math.max(levels.get(id) ?? -Infinity, level));
  };
  for (const u of people.rows) {
    if (u.is_admin) raise(u.matrix_id, ADMIN);
    if (u.is_staff) raise(u.matrix_id, STAFF);
    if (u.is_mod) raise(u.matrix_id, MOD);
    if (u.is_bot) raise(u.matrix_id, BOT);
  }
  raise(env.streamerId, ADMIN);
  for (const id of env.botIds) raise(id, BOT);

  const staff = [env.streamerId, ...env.botIds].filter((s): s is string => !!s);
  const supporterIds = [...supporters.rows.map((r) => r.matrix_id), ...staff].filter((id) => !hidden.has(id) && !bannedSet.has(id));

  const hubRoomId = hubRoomIdOf(desired.spaces, env);
  return {
    serverName: env.serverName,
    hubRoomId,
    serviceUserId: env.serviceUserId,
    hiddenUserIds,
    spaces: desired.spaces,
    rooms: desired.rooms,
    roles: desired.roles,
    people: sorted(levels.keys()).map((userId) => ({ userId, level: levels.get(userId)! })),
    supporters: sorted(supporterIds),
    banned,
    timedOut,
    putBack: env.putBack,
    retentionCapDays: env.retentionCapDays,
    siteBanReason: SITE_BAN_REASON,
    bridgeBots: sorted(new Set([...env.bridgeAccounts.map((s) => s.trim()), ...(bridge.bot ? [bridge.bot] : [])].filter((s) => MATRIX_USER_ID.test(s)))),
    bridgeUserPatterns: [...bridge.userPatterns],
    discordBot: bridge.bot,
    discordSpaceLinked: !!bridge.bot && !!links && !!linkedGuildOf(links, hubRoomId),
  };
}

/** The host's file read strictly: version 1, the bot a user id on this server, at most 4 patterns of at most
 *  300 characters. Anything else is no bridge (the reconciler then removes nobody in Discord-linked rooms).
 *  @test-only exported for the feed's tests; the route reaches it through readBridgeAccounts */
export function bridgeAccountsFrom(j: unknown, serverName: string): BridgeAccounts {
  if (!j || typeof j !== "object" || Array.isArray(j)) return NO_BRIDGE;
  const o = j as Record<string, unknown>;
  if (o.v !== 1 || !Array.isArray(o.userPatterns) || o.userPatterns.length > 4) return NO_BRIDGE;
  const patterns = o.userPatterns.filter((p): p is string => typeof p === "string" && p.length > 0 && p.length <= 300);
  if (patterns.length !== o.userPatterns.length) return NO_BRIDGE;
  const bot = typeof o.bot === "string" && MATRIX_USER_ID.test(o.bot) && o.bot.endsWith(`:${serverName}`) ? o.bot : null;
  return { bot, userPatterns: patterns };
}

/** The Discord bridge's accounts as the host last rendered them. */
async function readBridgeAccounts(serverName: string): Promise<BridgeAccounts> {
  return bridgeAccountsFrom(await hostFile("discord-bridge.json").catch(() => null), serverName);
}

/** What the Discord bridge has linked, as the host last read it; null when that cannot be read. */
export async function readBridgeLinks(): Promise<BridgeLinks | null> {
  return bridgeLinksFrom(await hostFile("discord-bridge-links.json").catch(() => null));
}

/** A full Matrix user id: @localpart:server. Anything else in the setting is not an account. */
const MATRIX_USER_ID = /^@[^\s:]{1,255}:[^\s]{1,255}$/;

/** The one rule for who no member list shows and the reconciler never levels. */
function hiddenUserIdsOf(env: Pick<FeedEnv, "serviceUserId" | "readerUserId">): string[] {
  return [env.serviceUserId, ...(env.readerUserId ? [env.readerUserId] : [])];
}

/** The hub space row's room when it has one, else the room the server's setup recorded. */
function hubRoomIdOf(spaces: SpaceRow[], env: Pick<FeedEnv, "hubRoomId">): string | null {
  return spaces.find((s) => s.kind === "hub" && s.matrixRoomId)?.matrixRoomId ?? env.hubRoomId;
}

/** What every member's client needs to draw the community the server's way: which space is the
 *  hub, who is never listed, the role ladder, and who sits on the Staff and Bot rungs (from the
 *  same rows and settings as the feed). Nothing here is private: the list shows all of it. */
export type CommunityLadder = {
  hubRoomId: string | null;
  hiddenIds: string[];
  roles: RoleRow[];
  /** The site's Staff role (site.users.is_staff). */
  staffIds: string[];
  /** The Bot rung: site.users.is_bot, bot.matrixId and the extra staff accounts. */
  botIds: string[];
};

export async function readCommunityLadder(db: Queryable, env: FeedEnv): Promise<CommunityLadder> {
  const desired = await readDesired(db);
  const people = (await db.query<PersonRow>(PEOPLE_SQL)).rows;
  const hiddenIds = hiddenUserIdsOf(env);
  const hidden = new Set(hiddenIds);
  const shown = (ids: Iterable<string>) => sorted(ids).filter((id) => !hidden.has(id));
  return {
    hubRoomId: hubRoomIdOf(desired.spaces, env),
    hiddenIds,
    roles: desired.roles,
    staffIds: shown(people.filter((u) => u.is_staff).map((u) => u.matrix_id)),
    botIds: shown([...people.filter((u) => u.is_bot).map((u) => u.matrix_id), ...env.botIds]),
  };
}

/** The forum reader's id: the one the site names, else the install's reader when web holds its
 *  token, else none.
 *  @test-only exported so the test can give it an environment; feedEnv is the caller */
export function readerUserIdFrom(env: Record<string, string | undefined>, serverName: string): string | null {
  if (env.MATRIX_READER_USER_ID) return env.MATRIX_READER_USER_ID;
  if (env.MATRIX_READER_TOKEN) return `@${FORUM_READER_LOCALPART}:${serverName}`;
  return null;
}

const CAP_KEY = "community.retentionCapDays";

/** The service account's name. Unset, the settings layer answers the schema's product default, so
 *  no second default lives here; an unresolvable value fails the request rather than name a stranger. */
function serviceLocalpart(): string {
  const v = instanceString("community.serviceLocalpart");
  if (!v) throw new Error("community.serviceLocalpart did not resolve");
  return v;
}

/** The feed's settings, read per request (instance settings apply without a restart). */
export function feedEnv(): FeedEnv {
  const serverName = matrixServerName();
  const cap = instanceResolve(CAP_KEY).value;
  return {
    serverName,
    serviceUserId: `@${serviceLocalpart()}:${serverName}`,
    readerUserId: readerUserIdFrom(process.env, serverName),
    hubRoomId: instanceString("matrix.rooms.hub"),
    streamerId: instanceString("streamer.matrixId"),
    botIds: [instanceString("bot.matrixId"), ...instanceList("staff.extraMatrixIds")].filter((s): s is string => !!s),
    sources: subscriptionSources(),
    putBack: !instanceBool("community.keepElementEdits"),
    // Unreadable: the schema's own default, the one source (no second copy here).
    retentionCapDays: typeof cap === "number" ? cap : Number(instanceEntry(CAP_KEY)?.default),
    bridgeAccounts: instanceList("community.bridgeAccounts"),
  };
}

// ── The run log ───────────────────────────────────────────────────────────────────────────────

const RUN_MODES = ["report", "adopt", "apply"] as const;
type RunMode = (typeof RUN_MODES)[number];
const KEEP_RUNS = 50;
const MAX_ERROR = 2000;
const MAX_BODY = 1_000_000;

export type RunRecord = {
  mode: RunMode;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  drift: unknown;
  applied: unknown;
  error: string | null;
};

function isoOrNull(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** A run as the reconciler posts it, checked field by field.
 *  @test-only exported for the validator's own tests; the route reaches it through runPostResponse */
export function parseRun(body: unknown): { ok: true; run: RunRecord } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  if (!RUN_MODES.includes(b.mode as RunMode)) return { ok: false, error: "mode must be report, adopt or apply" };
  const startedAt = isoOrNull(b.startedAt);
  if (!startedAt) return { ok: false, error: "startedAt must be a date" };
  const finishedAt = isoOrNull(b.finishedAt);
  if (finishedAt === undefined) return { ok: false, error: "finishedAt must be a date or null" };
  if (b.ok !== undefined && b.ok !== null && typeof b.ok !== "boolean") return { ok: false, error: "ok must be true, false or null" };
  if (b.error !== undefined && b.error !== null && typeof b.error !== "string") return { ok: false, error: "error must be text or null" };
  return {
    ok: true,
    run: {
      mode: b.mode as RunMode,
      startedAt,
      finishedAt,
      ok: typeof b.ok === "boolean" ? b.ok : null,
      drift: b.drift ?? null,
      applied: b.applied ?? null,
      error: typeof b.error === "string" ? b.error.slice(0, MAX_ERROR) : null,
    },
  };
}

// One statement: the new row, and every row but the newest KEEP_RUNS - 1 older ones gone. The
// DELETE sees the table as it was before the INSERT, so it keeps one fewer and the total is KEEP_RUNS.
const INSERT_RUN_SQL = `
  WITH ins AS (
    INSERT INTO site.community_runs (mode, started_at, finished_at, ok, drift, applied, error)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
    RETURNING id
  ), trimmed AS (
    DELETE FROM site.community_runs
     WHERE id NOT IN (SELECT id FROM site.community_runs ORDER BY id DESC LIMIT ${KEEP_RUNS - 1})
  )
  SELECT id FROM ins`;

/** Record a run; the log keeps the last KEEP_RUNS.
 *  @test-only exported for the real-Postgres test; the route reaches it through runPostResponse */
export async function insertRun(db: Queryable, run: RunRecord): Promise<number> {
  const json = (v: unknown) => (v === null ? null : JSON.stringify(v));
  const { rows } = await db.query<{ id: number }>(INSERT_RUN_SQL,
    [run.mode, run.startedAt, run.finishedAt, run.ok, json(run.drift), json(run.applied), run.error]);
  return Number(rows[0]!.id);
}

type RunFinish = { id: number; finishedAt: string; ok: boolean | null; drift: unknown; applied: unknown; error: string | null };

/** The end of a run whose start was posted: its row id, when it ended, and what it did. */
function parseFinish(b: Record<string, unknown>): { ok: true; finish: RunFinish } | { ok: false; error: string } {
  if (typeof b.id !== "number" || !Number.isSafeInteger(b.id) || b.id < 1) return { ok: false, error: "id must be a run's id" };
  const finishedAt = isoOrNull(b.finishedAt);
  if (!finishedAt) return { ok: false, error: "finishedAt must be a date" };
  if (b.ok !== undefined && b.ok !== null && typeof b.ok !== "boolean") return { ok: false, error: "ok must be true, false or null" };
  if (b.error !== undefined && b.error !== null && typeof b.error !== "string") return { ok: false, error: "error must be text or null" };
  return {
    ok: true,
    finish: {
      id: b.id, finishedAt, ok: typeof b.ok === "boolean" ? b.ok : null, drift: b.drift ?? null, applied: b.applied ?? null,
      error: typeof b.error === "string" ? b.error.slice(0, MAX_ERROR) : null,
    },
  };
}

// Only a row still unfinished: a retried finish, or one for a row already pruned, changes nothing.
const FINISH_RUN_SQL = `
  UPDATE site.community_runs SET finished_at = $2, ok = $3, drift = $4::jsonb, applied = $5::jsonb, error = $6
   WHERE id = $1 AND finished_at IS NULL
   RETURNING id`;

/** Fill in a started run's row → whether there was one to fill. */
async function finishRun(db: Queryable, f: RunFinish): Promise<boolean> {
  const json = (v: unknown) => (v === null ? null : JSON.stringify(v));
  const { rows } = await db.query<{ id: number }>(FINISH_RUN_SQL, [f.id, f.finishedAt, f.ok, json(f.drift), json(f.applied), f.error]);
  return rows.length > 0;
}

// ── The two routes' bodies (route.ts files are one line each over these) ──────────────────────

type RouteDeps = { db: Queryable; secret: string | undefined; log?: Pick<Console, "error"> };

const UNAUTHORIZED = () => Response.json({ error: "unauthorized" }, { status: 401 });
const UNAVAILABLE = () => Response.json({ error: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });

/** GET /api/internal/community/desired. */
export async function desiredFeedResponse(req: Request, deps: RouteDeps & { env: () => FeedEnv; bridge?: (serverName: string) => Promise<BridgeAccounts>; links?: () => Promise<BridgeLinks | null> }): Promise<Response> {
  if (!internalBearerOk(req.headers.get("authorization"), deps.secret)) return UNAUTHORIZED();
  try {
    const env = deps.env();
    const feed = await buildDesiredFeed(deps.db, env, await (deps.bridge ?? readBridgeAccounts)(env.serverName), await (deps.links ?? readBridgeLinks)());
    return Response.json(feed, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    (deps.log ?? console).error("[community] desired feed read failed:", e instanceof Error ? e.message : e);
    return UNAVAILABLE();
  }
}

// ── The rooms the reconciler made ────────────────────────────────────────────────────────────────
// A room the reconciler makes is recorded on its row at once, before it does anything else with it,
// so the next run never makes it twice. Only while the row still names what the room replaces (null
// for a new row, the old id for a room that was gone): a row that changed meanwhile is not overwritten.
const MADE_TABLES = { rooms: "site.community_rooms", spaces: "site.community_spaces" } as const;
const MATRIX_ROOM_ID = /^![^\s/?#]{1,254}$/;
type Made = { table: keyof typeof MADE_TABLES; id: number; matrixRoomId: string; replaces: string | null };

function parseMade(body: unknown): Made | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.table !== "rooms" && b.table !== "spaces") return null;
  if (typeof b.id !== "number" || !Number.isSafeInteger(b.id) || b.id < 1) return null;
  if (typeof b.matrixRoomId !== "string" || !MATRIX_ROOM_ID.test(b.matrixRoomId)) return null;
  const replaces = b.replaces ?? null;
  if (replaces !== null && (typeof replaces !== "string" || !MATRIX_ROOM_ID.test(replaces))) return null;
  return { table: b.table, id: b.id, matrixRoomId: b.matrixRoomId, replaces };
}

/** POST /api/internal/community/made {table, id, matrixRoomId, replaces} → { ok: true }. */
export async function madePostResponse(req: Request, deps: RouteDeps): Promise<Response> {
  if (!internalBearerOk(req.headers.get("authorization"), deps.secret)) return UNAUTHORIZED();
  let body: unknown;
  try { body = JSON.parse(await req.text()); } catch { return Response.json({ error: "body must be JSON" }, { status: 400 }); }
  const made = parseMade(body);
  if (!made) return Response.json({ error: "table must be rooms or spaces, id a row id, matrixRoomId and replaces Matrix room ids" }, { status: 400 });
  try {
    const { rows } = await deps.db.query<{ id: number }>(`
      UPDATE ${MADE_TABLES[made.table]} SET matrix_room_id = $2, updated_at = now()
       WHERE id = $1 AND matrix_room_id IS NOT DISTINCT FROM $3
       RETURNING id`, [made.id, made.matrixRoomId, made.replaces]);
    if (!rows.length) return Response.json({ error: "the row is gone or names another room now" }, { status: 409 });
    return Response.json({ ok: true });
  } catch (e) {
    if ((e as { code?: unknown })?.code === "23505") return Response.json({ error: "another row already names that room" }, { status: 409 });
    (deps.log ?? console).error("[community] made-room write failed:", e instanceof Error ? e.message : e);
    return UNAVAILABLE();
  }
}

/** POST /api/internal/community/runs → { id }. */
export async function runPostResponse(req: Request, deps: RouteDeps): Promise<Response> {
  if (!internalBearerOk(req.headers.get("authorization"), deps.secret)) return UNAUTHORIZED();
  const text = await req.text();
  if (text.length > MAX_BODY) return Response.json({ error: "too large" }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return Response.json({ error: "body must be JSON" }, { status: 400 }); }
  // Two phases: a run posts {mode, startedAt} when it starts (an unfinished row, so the panel sees a
  // run in progress) and {id, finishedAt, ok, …} when it ends. A body without an id is a whole run.
  if (body && typeof body === "object" && !Array.isArray(body) && "id" in body) {
    const fin = parseFinish(body as Record<string, unknown>);
    if (!fin.ok) return Response.json({ error: fin.error }, { status: 400 });
    try {
      if (!(await finishRun(deps.db, fin.finish))) return Response.json({ error: "no unfinished run with that id" }, { status: 409 });
      return Response.json({ id: fin.finish.id });
    } catch (e) {
      (deps.log ?? console).error("[community] run log write failed:", e instanceof Error ? e.message : e);
      return UNAVAILABLE();
    }
  }
  const parsed = parseRun(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  try {
    return Response.json({ id: await insertRun(deps.db, parsed.run) });
  } catch (e) {
    (deps.log ?? console).error("[community] run log write failed:", e instanceof Error ? e.message : e);
    return UNAVAILABLE();
  }
}
