// What the reconciler's adopt mode writes: a space or room found in the community that no row knows,
// inserted as it is, and a row whose room was upgraded moved to the new room. The body is the core's
// op exactly as the CLI sends it (install/matrix/reconcile-core.mjs planAdopt: `adoptRow`,
// `followTombstone`). Behind POST /api/internal/community/adopt; internal secret only.
//
// One writer: the reconciler runs one pass at a time (the host's flock), and it sends parents
// before children, so a row's parent is already a row when it arrives.
import { orderKeyBetween } from "./desired.ts";
import { internalBearerOk } from "../internalSecret.ts";
import { setupChannelRows, type SetupChannel } from "./setupChannels.ts";

type Queryable = { query: <R extends object>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> };
/** `setup`: the channels the setup pages listed (community.setupChannels) and the install's cap.
 *  They become rows with the hub's own import: no channel row can exist before the hub's. */
type RouteDeps = { db: Queryable; secret: string | undefined; log?: Pick<Console, "error">;
  setup?: () => { channels: readonly SetupChannel[]; retentionCapDays: number } };

const MATRIX_ROOM_ID = /^![^\s/?#]{1,254}$/;
const MXC = /^mxc:\/\/[^/\s]+\/[^/\s]+$/;
const MAX_NAME = 255;
const MAX_TOPIC = 4000;
const MAX_BODY = 100_000;
const RETENTION_CEILING_DAYS = 3650; // the v165 CHECK
const ROOM_KINDS = ["text", "announcement", "forum"];
const SEE_RULES = ["everyone", "supporters", "mods", "staff", "invited"];
const POST_RULES = ["everyone", "supporters", "staff", "mods"];
const TABLES = { rooms: "site.community_rooms", spaces: "site.community_spaces" } as const;

type Profile = { name: string; topic: string | null; avatarMxc: string | null; orderKey: string | null };
type AdoptSpace = { op: "adoptRow"; table: "spaces"; matrixRoomId: string; parentRoomId: string | null;
  row: Profile & { kind: "hub" | "category" } };
type AdoptRoom = { op: "adoptRow"; table: "rooms"; matrixRoomId: string; parentRoomId: string;
  row: Profile & { kind: string; see: string; post: string; retentionDays: number | null; encrypted: boolean; published: boolean; archived: boolean } };
type Follow = { op: "followTombstone"; table: keyof typeof TABLES; rowId: number; from: string; to: string };
type AdoptOp = AdoptSpace | AdoptRoom | Follow;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const roomId = (v: unknown): v is string => typeof v === "string" && MATRIX_ROOM_ID.test(v);
const optText = (v: unknown, max: number): v is string | null => v === null || v === undefined || (typeof v === "string" && v.length <= max);

/** The op the reconciler posted, checked field by field; extra fields (label, roomId) are ignored.
 *  @test-only exported so the homeserver suite holds what the real reconciler posts to this parser */
export function parseAdopt(body: unknown): AdoptOp | { error: string } {
  if (!isObj(body)) return { error: "body must be an object" };
  if (body.op === "followTombstone") {
    if (body.table !== "rooms" && body.table !== "spaces") return { error: "table must be rooms or spaces" };
    if (typeof body.rowId !== "number" || !Number.isSafeInteger(body.rowId) || body.rowId < 1) return { error: "rowId must be a row id" };
    if (!roomId(body.roomId) || !roomId(body.to) || body.roomId === body.to) return { error: "roomId and to must be two Matrix room ids" };
    return { op: "followTombstone", table: body.table, rowId: body.rowId, from: body.roomId, to: body.to };
  }
  if (body.op !== "adoptRow") return { error: "op must be adoptRow or followTombstone" };
  const r = body.row;
  if (!isObj(r)) return { error: "row must be an object" };
  if (!roomId(body.matrixRoomId) || r.matrixRoomId !== body.matrixRoomId) return { error: "matrixRoomId must be a Matrix room id, the same on the op and its row" };
  if (body.parentRoomId !== null && !roomId(body.parentRoomId)) return { error: "parentRoomId must be a Matrix room id or null" };
  if (typeof r.name !== "string" || r.name.length > MAX_NAME) return { error: `name must be text of at most ${MAX_NAME} characters` };
  if (!optText(r.topic, MAX_TOPIC)) return { error: "topic must be text or null" };
  if (!(r.avatarMxc === null || r.avatarMxc === undefined || (typeof r.avatarMxc === "string" && MXC.test(r.avatarMxc)))) return { error: "avatarMxc must be an mxc:// address or null" };
  if (!(r.orderKey === null || r.orderKey === undefined || (typeof r.orderKey === "string" && r.orderKey.length <= 50))) return { error: "orderKey must be text or null" };
  const profile: Profile = { name: r.name, topic: (r.topic as string | null | undefined) ?? null, avatarMxc: (r.avatarMxc as string | null | undefined) ?? null,
    orderKey: (r.orderKey as string | null | undefined) ?? null };
  if (body.table === "spaces") {
    // The core adopts the hub (no parent) and categories; a gate is made by the panel, never adopted.
    if (r.kind === "hub" && body.parentRoomId !== null) return { error: "the hub has no parent" };
    if (r.kind === "category" && body.parentRoomId === null) return { error: "a category needs its parent" };
    if (r.kind !== "hub" && r.kind !== "category") return { error: "an adopted space is the hub or a category" };
    return { op: "adoptRow", table: "spaces", matrixRoomId: body.matrixRoomId, parentRoomId: body.parentRoomId as string | null, row: { ...profile, kind: r.kind } };
  }
  if (body.table !== "rooms") return { error: "table must be rooms or spaces" };
  if (body.parentRoomId === null) return { error: "a room needs its parent" };
  if (!ROOM_KINDS.includes(r.kind as string)) return { error: "kind must be text, announcement or forum" };
  if (!SEE_RULES.includes(r.see as string)) return { error: "see must be one of the panel's rules" };
  if (!POST_RULES.includes(r.post as string)) return { error: "post must be one of the panel's rules" };
  const days = r.retentionDays;
  if (!(days === null || (Number.isInteger(days) && (days as number) >= 1 && (days as number) <= RETENTION_CEILING_DAYS))) {
    return { error: `retentionDays must be null or 1 to ${RETENTION_CEILING_DAYS}` };
  }
  for (const k of ["encrypted", "published", "archived"] as const) if (typeof r[k] !== "boolean") return { error: `${k} must be true or false` };
  if (r.discordChannelId !== null && r.discordChannelId !== undefined) return { error: "an adopted room is not linked to Discord" };
  return {
    op: "adoptRow", table: "rooms", matrixRoomId: body.matrixRoomId, parentRoomId: body.parentRoomId as string,
    row: { ...profile, kind: r.kind as string, see: r.see as string, post: r.post as string, retentionDays: days as number | null,
      encrypted: r.encrypted as boolean, published: r.published as boolean, archived: r.archived as boolean },
  };
}

/** The room's own order when it is one of the panel's keys; else after every sibling that exists
 *  on the server, and before the first channel the panel has not made yet (setup's list waits
 *  there, so the community's first rooms keep their place at the top). Spaces and rooms share one
 *  order under a parent, as m.space.child does. */
function placeAfter(siblings: { order_key: string; made?: boolean }[], own: string | null): string {
  const valid = (k: string | null): k is string => {
    if (!k) return false;
    try { orderKeyBetween(k, null); return true; } catch { return false; }
  };
  if (valid(own)) return own;
  const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const last = siblings.filter((s) => s.made !== false && valid(s.order_key)).map((s) => s.order_key).sort(byKey).at(-1) ?? null;
  const next = siblings.filter((s) => s.made === false && valid(s.order_key) && (last === null || s.order_key > last))
    .map((s) => s.order_key).sort(byKey)[0] ?? null;
  return orderKeyBetween(last, next);
}

// The hub and setup's channels in ONE statement: a failure writes neither, and the reconciler's
// retry finds no hub and sends the whole import again.
const HUB_WITH_CHANNELS = `
  WITH hub AS (
    INSERT INTO site.community_spaces (parent_id, kind, name, topic, avatar_mxc, order_key, matrix_room_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id
  ), channels AS (
    INSERT INTO site.community_rooms (space_id, kind, name, order_key, see_rule, post_rule, retention_days, encrypted, published, archived)
    SELECT hub.id, c.kind, c.name, c."orderKey", c.see, c.post, c."retentionDays", false, c.published, false
      FROM hub, jsonb_to_recordset($8::jsonb) AS c(kind text, name text, "orderKey" text, see text, post text, "retentionDays" integer, published boolean)
  )
  SELECT id FROM hub`;

class Conflict extends Error {}

async function spaceIdOf(db: Queryable, matrixRoomId: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>(`SELECT id FROM site.community_spaces WHERE matrix_room_id = $1`, [matrixRoomId]);
  if (!rows.length) throw new Conflict(`the parent ${matrixRoomId} is not in the panel yet`);
  return Number(rows[0]!.id);
}

/** The id of the row now holding this room: inserted, or the one a retry of the same op made. */
async function adoptRow(db: Queryable, op: AdoptSpace | AdoptRoom, setup: RouteDeps["setup"]): Promise<number> {
  const other = op.table === "spaces" ? TABLES.rooms : TABLES.spaces;
  if ((await db.query(`SELECT 1 FROM ${other} WHERE matrix_room_id = $1`, [op.matrixRoomId])).rows.length) {
    throw new Conflict(`${op.matrixRoomId} is already a ${op.table === "spaces" ? "room" : "space"} in the panel`);
  }
  const existing = await db.query<{ id: number }>(`SELECT id FROM ${TABLES[op.table]} WHERE matrix_room_id = $1`, [op.matrixRoomId]);
  if (existing.rows.length) return Number(existing.rows[0]!.id);

  const parentId = op.parentRoomId === null ? null : await spaceIdOf(db, op.parentRoomId);
  if (op.table === "spaces" && op.row.kind === "hub") {
    const hub = await db.query<{ id: number }>(`SELECT id FROM site.community_spaces WHERE kind = 'hub'`);
    if (hub.rows.length) throw new Conflict("the panel already has a hub");
  }
  const siblings = await db.query<{ order_key: string; made: boolean }>(`
    SELECT order_key, matrix_room_id IS NOT NULL AS made FROM site.community_spaces WHERE parent_id IS NOT DISTINCT FROM $1
    UNION ALL
    SELECT order_key, matrix_room_id IS NOT NULL AS made FROM site.community_rooms WHERE space_id = $1`, [parentId]);
  const orderKey = placeAfter(siblings.rows, op.row.orderKey);
  const r = op.row;
  const listed = op.table === "spaces" && op.row.kind === "hub" && setup ? setup() : null;
  if (op.table === "spaces" && listed && listed.channels.length) {
    const rows = setupChannelRows(listed.channels, listed.retentionCapDays);
    const { rows: hub } = await db.query<{ id: number }>(HUB_WITH_CHANNELS,
      [parentId, r.kind, r.name, r.topic, r.avatarMxc, orderKey, op.matrixRoomId, JSON.stringify(rows)]);
    return Number(hub[0]!.id);
  }
  const inserted = op.table === "spaces"
    ? await db.query<{ id: number }>(`
        INSERT INTO site.community_spaces (parent_id, kind, name, topic, avatar_mxc, order_key, matrix_room_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id`, [parentId, r.kind, r.name, r.topic, r.avatarMxc, orderKey, op.matrixRoomId])
    : await db.query<{ id: number }>(`
        INSERT INTO site.community_rooms (space_id, kind, name, topic, avatar_mxc, order_key, see_rule, post_rule,
                                          retention_days, encrypted, published, archived, matrix_room_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING id`, [parentId, r.kind, r.name, r.topic, r.avatarMxc, orderKey, op.row.see, op.row.post,
          op.row.retentionDays, op.row.encrypted, op.row.published, op.row.archived, op.matrixRoomId]);
  return Number(inserted.rows[0]!.id);
}

/** The row moves to the upgraded room, only while it still names the old one (or already the new one: a retry). */
async function followTombstone(db: Queryable, op: Follow): Promise<number> {
  const { rows } = await db.query<{ id: number }>(`
    UPDATE ${TABLES[op.table]} SET matrix_room_id = $3, updated_at = now()
     WHERE id = $1 AND matrix_room_id = $2
     RETURNING id`, [op.rowId, op.from, op.to]);
  if (rows.length) return op.rowId;
  const now = await db.query<{ matrix_room_id: string | null }>(`SELECT matrix_room_id FROM ${TABLES[op.table]} WHERE id = $1`, [op.rowId]);
  if (now.rows[0]?.matrix_room_id === op.to) return op.rowId;
  throw new Conflict("the row is gone or names another room now");
}

/** POST /api/internal/community/adopt {the core's adoptRow or followTombstone op} → { ok: true, id }. */
export async function adoptPostResponse(req: Request, deps: RouteDeps): Promise<Response> {
  if (!internalBearerOk(req.headers.get("authorization"), deps.secret)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const text = await req.text();
  if (text.length > MAX_BODY) return Response.json({ error: "too large" }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return Response.json({ error: "body must be JSON" }, { status: 400 }); }
  const op = parseAdopt(body);
  if ("error" in op) return Response.json({ error: op.error }, { status: 400 });
  try {
    const id = op.op === "followTombstone" ? await followTombstone(deps.db, op) : await adoptRow(deps.db, op, deps.setup);
    return Response.json({ ok: true, id });
  } catch (e) {
    if (e instanceof Conflict) return Response.json({ error: e.message }, { status: 409 });
    if ((e as { code?: unknown })?.code === "23505") return Response.json({ error: "another row already names that room" }, { status: 409 });
    (deps.log ?? console).error("[community] adopt write failed:", e instanceof Error ? e.message : e);
    return Response.json({ error: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
