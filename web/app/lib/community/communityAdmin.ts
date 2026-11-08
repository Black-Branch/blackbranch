// Admin Panel › Site › Community, server side: every save writes the community's desired state in
// one transaction, then asks the host to make the server match (spec 2026-10-23 §4.1, §4.7). The
// route.ts files check is_admin + same-origin first and hand over to these; `deps` is the pool, the
// host request and the install's retention cap, so the tests can give their own.
//
// Rules held here by the data's shape, not by a prohibition in the panel:
//   • a channel everyone can see is never encrypted; only such a channel is published (it always is);
//   • encryption is chosen when a channel is made and never changed (spec §4.4);
//   • a row whose room is already on the server is never deleted: the reconciler never touches a
//     room no row knows, so the room would stay open and adopt would import it again. Archive it.
import { orderKeyBetween, readDesired, validateRoomInput, type DesiredState, type RoomRow } from "./desired.ts";
import { RUN_LIMIT_MS } from "./runLimit.ts";

type Rows<R> = Promise<{ rows: R[] }>;
type Queryable = { query: <R extends object>(sql: string, params?: unknown[]) => Rows<R> };
type Client = Queryable & { release: () => void };

export type AskResult = { ok: true; requestedAt: string } | { ok: false; error: string };

export type CommunityDeps = {
  pool: Queryable & { connect: () => Promise<Client> };
  /** Ask the host for an apply run (requestHost("community-reconcile")), or say why not. */
  ask: () => Promise<AskResult>;
  /** The install's longest per-channel retention (community.retentionCapDays; 0 = no limit). */
  retentionCapDays: () => number;
  /** The host's last answer to an apply request (a run it started may still be going). */
  hostAnswer?: () => Promise<{ ok: boolean; at: string; message: string } | null>;
  now?: () => number;
  log?: Pick<Console, "log" | "error">;
  /** Who saved, for the log line. */
  admin?: string;
};

const NO_STORE = { "Cache-Control": "no-store" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });
const refuse = (status: number, error: string) => reply({ error }, status);

class Refusal extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function body(req: Request): Promise<Record<string, unknown> | null> {
  const b = (await req.json().catch(() => null)) as unknown;
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}

/** The cap as validateRoomInput reads it: 0 (no limit) is null, the ten-year ceiling. */
const capFor = (days: number): number | null => (days > 0 ? days : null);

/** A reconciler run is going: the newest row has not finished (a run writes its row when it starts
 *  and fills it when it ends) and is younger than the run limit, or the host started one that has
 *  not logged yet. It may be making the very room in question. */
async function runInProgress(db: Queryable, deps: CommunityDeps): Promise<boolean> {
  const now = (deps.now ?? Date.now)();
  const last = (await db.query<{ started_at: Date | string; finished_at: Date | string | null }>(
    `SELECT started_at, finished_at FROM site.community_runs ORDER BY id DESC LIMIT 1`)).rows[0];
  if (last && last.finished_at === null && now - new Date(last.started_at).getTime() < RUN_LIMIT_MS) return true;
  const host = deps.hostAnswer ? await deps.hostAnswer().catch(() => null) : null;
  if (!host?.ok || host.message !== "started") return false;
  const at = Date.parse(host.at);
  if (!((now - at) < RUN_LIMIT_MS)) return false;
  // The run that answer started has logged once a row began at or after it (a few seconds' slack).
  return !(last && new Date(last.started_at).getTime() >= at - 5_000);
}

function rowId(id: string): number | null {
  return /^[1-9]\d{0,9}$/.test(id) ? Number(id) : null;
}

/** One transaction on one client; a Refusal or any throw rolls it back. */
async function inTransaction<T>(deps: CommunityDeps, fn: (db: Queryable) => Promise<T>): Promise<T> {
  const db = await deps.pool.connect();
  try {
    await db.query("BEGIN");
    const out = await fn(db);
    await db.query("COMMIT");
    return out;
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

/** Run a save: its transaction, then the host request. The answer carries when the host was asked
 *  (null: it could not be, and the change waits for the next run). */
async function save(deps: CommunityDeps, what: string, fn: (db: Queryable) => Promise<Record<string, unknown> | void>): Promise<Response> {
  let extra: Record<string, unknown> | void;
  try {
    extra = await inTransaction(deps, fn);
  } catch (e) {
    if (e instanceof Refusal) return refuse(e.status, e.message);
    (deps.log ?? console).error(`[community] ${what} failed:`, e instanceof Error ? e.message : e);
    return refuse(503, "Not saved: the database did not answer. Try again.");
  }
  const asked = await deps.ask().catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
  (deps.log ?? console).log(`[community] ${deps.admin ?? "an admin"}: ${what}${asked.ok ? "" : ` (host not asked: ${asked.error})`}`);
  return reply({ ok: true, ...(extra ?? {}), requestedAt: asked.ok ? asked.requestedAt : null });
}

// ── Order keys ───────────────────────────────────────────────────────────────────────────────
// Rows imported from the server may carry an order string that is not of the panel's scheme; a
// list holding one is renumbered in its current order before a key is added after its last.

async function keyAfterLast(db: Queryable, table: "rooms" | "spaces" | "roles", rows: { id: number | string; order_key: string }[]): Promise<string> {
  const last = rows.at(-1)?.order_key ?? null;
  try {
    return orderKeyBetween(last, null);
  } catch {
    let key: string | null = null;
    for (const r of rows) {
      key = orderKeyBetween(key, null);
      const idCol = table === "roles" ? "key" : "id";
      await db.query(`UPDATE site.community_${table} SET order_key = $2 WHERE ${idCol} = $1`, [r.id, key]);
    }
    return orderKeyBetween(key, null);
  }
}

// ── Channels ─────────────────────────────────────────────────────────────────────────────────

const CHANNEL_SPACES = new Set(["hub", "category"]);

async function lockSpace(db: Queryable, id: number): Promise<{ id: number; kind: string; name?: string; matrix_room_id?: string | null }> {
  const { rows } = await db.query<{ id: number; kind: string; name?: string; matrix_room_id?: string | null }>(
    `SELECT id, kind, name, matrix_room_id FROM site.community_spaces WHERE id = $1 FOR UPDATE`, [id]);
  if (!rows[0]) throw new Refusal(404, "That category is gone. Reload the page.");
  return rows[0];
}

async function roomKeys(db: Queryable, spaceId: number) {
  return (await db.query<{ id: number; order_key: string }>(
    `SELECT id, order_key FROM site.community_rooms WHERE space_id = $1 ORDER BY order_key COLLATE "C", id`, [spaceId])).rows;
}

const ROOM_INSERT = `
  INSERT INTO site.community_rooms (space_id, kind, name, topic, avatar_mxc, order_key, see_rule, post_rule,
                                    retention_days, encrypted, published, archived)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  RETURNING id`;

/** The channel a POST or PATCH asks for, as validateRoomInput reads it. `published` always follows
 *  who can see (spec §4.7: every channel everyone can see is listed). */
function asInput(r: Partial<RoomRow> & Record<string, unknown>): Record<string, unknown> {
  const name = typeof r.name === "string" ? r.name.trim().replace(/^#+/, "") : r.name;
  const topic = typeof r.topic === "string" ? (r.topic.trim() || null) : (r.topic ?? null);
  return {
    id: r.id ?? 0, spaceId: r.spaceId, kind: r.kind, name, topic, avatarMxc: r.avatarMxc ?? null, orderKey: r.orderKey ?? "a0",
    see: r.see, post: r.post, retentionDays: r.retentionDays === undefined ? null : r.retentionDays,
    encrypted: r.encrypted ?? false, published: r.see === "everyone", archived: r.archived ?? false,
    matrixRoomId: r.matrixRoomId ?? null, discordChannelId: r.discordChannelId ?? null,
  };
}

const MAX_TOPIC = 1000;

/** POST /api/admin/community/rooms {spaceId, kind, name, see, post, retentionDays, encrypted, topic?} */
export async function createRoomResponse(req: Request, deps: CommunityDeps): Promise<Response> {
  const b = await body(req);
  if (!b) return refuse(400, "Not a channel.");
  if (typeof b.topic === "string" && b.topic.length > MAX_TOPIC) return refuse(400, `A topic is at most ${MAX_TOPIC} characters.`);
  // A new row has no id yet (validateRoomInput reads 0 as unsaved); its place comes from the list.
  const checked = validateRoomInput(asInput({ ...b, id: 0, orderKey: "a0", archived: false, matrixRoomId: null, discordChannelId: null }),
    { retentionCapDays: capFor(deps.retentionCapDays()) });
  if ("error" in checked) return refuse(400, checked.error);
  return save(deps, `made #${checked.name}`, async (db) => {
    const space = await lockSpace(db, checked.spaceId);
    if (!CHANNEL_SPACES.has(space.kind)) throw new Refusal(400, "A channel goes in a category or the community itself.");
    const orderKey = await keyAfterLast(db, "rooms", await roomKeys(db, space.id));
    const { rows } = await db.query<{ id: number }>(ROOM_INSERT, [
      checked.spaceId, checked.kind, checked.name, checked.topic, checked.avatarMxc, orderKey, checked.see, checked.post,
      checked.retentionDays, checked.encrypted, checked.published, false,
    ]);
    return { id: Number(rows[0]!.id) };
  });
}

const ROOM_ROW_SQL = `
  SELECT id, space_id AS "spaceId", kind, name, topic, avatar_mxc AS "avatarMxc", order_key AS "orderKey",
         see_rule AS see, post_rule AS post, retention_days AS "retentionDays", encrypted, published, archived,
         matrix_room_id AS "matrixRoomId", discord_channel_id AS "discordChannelId"
    FROM site.community_rooms WHERE id = $1 FOR UPDATE`;

async function lockRoom(db: Queryable, id: number): Promise<RoomRow> {
  const { rows } = await db.query<RoomRow>(ROOM_ROW_SQL, [id]);
  if (!rows[0]) throw new Refusal(404, "That channel is gone. Reload the page.");
  return rows[0];
}

const PATCHABLE = ["name", "topic", "avatarMxc", "orderKey", "spaceId", "see", "post", "retentionDays"] as const;

/** PATCH /api/admin/community/rooms/:id — any of name, topic, avatarMxc, orderKey, spaceId, see,
 *  post, retentionDays. Encryption and the kind are set when a channel is made. */
export async function patchRoomResponse(req: Request, id: string, deps: CommunityDeps): Promise<Response> {
  const b = await body(req);
  if (b && "encrypted" in b) return refuse(409, "Encryption is set when a channel is made and cannot be changed.");
  const rid = rowId(id);
  if (rid === null) return refuse(400, "Not a channel.");
  if (!b) return refuse(400, "Nothing to change.");
  if ("kind" in b) return refuse(409, "The kind of channel is set when it is made.");
  const patch = Object.fromEntries(PATCHABLE.filter((k) => k in b).map((k) => [k, b[k]]));
  if (!Object.keys(patch).length) return refuse(400, "Nothing to change.");
  if (typeof patch.topic === "string" && patch.topic.length > MAX_TOPIC) return refuse(400, `A topic is at most ${MAX_TOPIC} characters.`);
  return save(deps, `changed channel ${rid}`, async (db) => {
    const row = await lockRoom(db, rid);
    // A lowered cap does not stop a rename: the cap is checked only when the days change.
    const cap = "retentionDays" in patch ? capFor(deps.retentionCapDays()) : null;
    const checked = validateRoomInput(asInput({ ...row, ...patch, id: row.id }), { retentionCapDays: cap });
    if ("error" in checked) throw new Refusal(400, checked.error);
    // The Discord bridge keeps a linked room open to the whole community (its join rule), whatever
    // the panel says: a narrower rule would read as kept while it is not.
    if (row.discordChannelId && checked.see !== "everyone") {
      throw new Refusal(409, "This channel is linked to Discord, which keeps it open to everyone in the community. Unlink it on the Discord page first.");
    }
    // …and its post level follows the Discord channel's @everyone (the reconciler keeps the bridge's).
    if (row.discordChannelId && checked.post !== "everyone") {
      throw new Refusal(409, "This channel is linked to Discord, where who may post follows the Discord channel. Unlink it on the Discord page first.");
    }
    if (checked.spaceId !== row.spaceId) {
      const space = await lockSpace(db, checked.spaceId);
      if (!CHANNEL_SPACES.has(space.kind)) throw new Refusal(400, "A channel goes in a category or the community itself.");
    }
    await db.query(`
      UPDATE site.community_rooms
         SET name = $2, topic = $3, avatar_mxc = $4, order_key = $5, space_id = $6, see_rule = $7, post_rule = $8,
             retention_days = $9, published = $10, updated_at = now()
       WHERE id = $1`,
    [rid, checked.name, checked.topic, checked.avatarMxc, checked.orderKey, checked.spaceId, checked.see, checked.post,
      checked.retentionDays, checked.published]);
  });
}

/** POST /api/admin/community/rooms/:id/archive and /unarchive. Archived: hidden from the channel
 *  list, nobody can post, the messages stay (the reconciler unlinks it and closes posting). */
export async function archiveRoomResponse(id: string, archived: boolean, deps: CommunityDeps): Promise<Response> {
  const rid = rowId(id);
  if (rid === null) return refuse(400, "Not a channel.");
  return save(deps, `${archived ? "archived" : "brought back"} channel ${rid}`, async (db) => {
    const { rows } = await db.query<{ id: number }>(
      `UPDATE site.community_rooms SET archived = $2, updated_at = now() WHERE id = $1 RETURNING id`, [rid, archived]);
    if (!rows[0]) throw new Refusal(404, "That channel is gone. Reload the page.");
  });
}

/** DELETE /api/admin/community/rooms/:id {confirm: the channel's name}. */
export async function deleteRoomResponse(req: Request, id: string, deps: CommunityDeps): Promise<Response> {
  const rid = rowId(id);
  if (rid === null) return refuse(400, "Not a channel.");
  const b = await body(req);
  const confirm = typeof b?.confirm === "string" ? b.confirm : "";
  return save(deps, `deleted channel ${rid}`, async (db) => {
    const row = await lockRoom(db, rid);
    if (confirm !== row.name) throw new Refusal(400, "Type the channel name to confirm.");
    if (await runInProgress(db, deps)) throw new Refusal(409, "Wait for the current run to finish, then try again.");
    if (row.matrixRoomId) {
      throw new Refusal(409, `#${row.name} is already on the chat server, and deleting a channel there is not available yet. Archive it instead: it leaves the channel list and nobody can post in it.`);
    }
    await db.query(`DELETE FROM site.community_rooms WHERE id = $1`, [rid]);
  });
}

// ── Categories ───────────────────────────────────────────────────────────────────────────────

const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
function nameOf(v: unknown, what: string): string {
  const name = typeof v === "string" ? v.trim() : "";
  if (name.length < 1 || name.length > 100) throw new Refusal(400, `A ${what} name is 1 to 100 characters.`);
  if (CONTROL.test(name)) throw new Refusal(400, `A ${what} name cannot hold control characters.`);
  return name;
}

/** POST /api/admin/community/spaces {name, parentId} — a category, in the community (parentId null
 *  or the hub's row) or inside another category. */
export async function createSpaceResponse(req: Request, deps: CommunityDeps): Promise<Response> {
  const b = await body(req);
  let name: string;
  try { name = nameOf(b?.name, "category"); } catch (e) { return refuse(400, (e as Error).message); }
  const parentId = b?.parentId ?? null;
  if (parentId !== null && rowId(String(parentId)) === null) return refuse(400, "Not a category.");
  return save(deps, `made the category ${name}`, async (db) => {
    if (parentId !== null) {
      const parent = await lockSpace(db, Number(parentId));
      if (!CHANNEL_SPACES.has(parent.kind)) throw new Refusal(400, "A category goes in the community or another category.");
    }
    const siblings = (await db.query<{ id: number; order_key: string }>(`
      SELECT id, order_key FROM site.community_spaces
       WHERE kind = 'category' AND parent_id IS NOT DISTINCT FROM $1
       ORDER BY order_key COLLATE "C", id`, [parentId])).rows;
    const orderKey = await keyAfterLast(db, "spaces", siblings);
    const { rows } = await db.query<{ id: number }>(`
      INSERT INTO site.community_spaces (parent_id, kind, name, order_key)
      VALUES ($1, 'category', $2, $3) RETURNING id`, [parentId, name, orderKey]);
    return { id: Number(rows[0]!.id) };
  });
}

/** PATCH /api/admin/community/spaces/:id {name?, topic?, avatarMxc?, orderKey?} — categories only:
 *  the community itself and the hidden supporters space are the server's. */
export async function patchSpaceResponse(req: Request, id: string, deps: CommunityDeps): Promise<Response> {
  const sid = rowId(id);
  if (sid === null) return refuse(400, "Not a category.");
  const b = await body(req);
  if (!b) return refuse(400, "Nothing to change.");
  const sets: string[] = [];
  const params: unknown[] = [sid];
  const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  try {
    if ("name" in b) set("name", nameOf(b.name, "category"));
    if ("topic" in b) {
      if (b.topic !== null && typeof b.topic !== "string") throw new Refusal(400, "A topic is text.");
      if (typeof b.topic === "string" && b.topic.length > MAX_TOPIC) throw new Refusal(400, `A topic is at most ${MAX_TOPIC} characters.`);
      set("topic", typeof b.topic === "string" ? (b.topic.trim() || null) : null);
    }
    if ("avatarMxc" in b) {
      if (b.avatarMxc !== null && !(typeof b.avatarMxc === "string" && /^mxc:\/\/[^/\s]+\/[^/\s]+$/.test(b.avatarMxc))) throw new Refusal(400, "An icon is an mxc:// address.");
      set("avatar_mxc", b.avatarMxc);
    }
    if ("orderKey" in b) {
      if (typeof b.orderKey !== "string") throw new Refusal(400, "Invalid position.");
      try { orderKeyBetween(b.orderKey, null); } catch { throw new Refusal(400, "Invalid position."); }
      set("order_key", b.orderKey);
    }
  } catch (e) {
    return refuse(400, (e as Error).message);
  }
  if (!sets.length) return refuse(400, "Nothing to change.");
  return save(deps, `changed category ${sid}`, async (db) => {
    const space = await lockSpace(db, sid);
    if (space.kind !== "category") throw new Refusal(409, "Only a category is changed here.");
    await db.query(`UPDATE site.community_spaces SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);
  });
}

/** DELETE /api/admin/community/spaces/:id — an empty category the server never made. */
export async function deleteSpaceResponse(id: string, deps: CommunityDeps): Promise<Response> {
  const sid = rowId(id);
  if (sid === null) return refuse(400, "Not a category.");
  return save(deps, `deleted category ${sid}`, async (db) => {
    const space = await lockSpace(db, sid);
    if (space.kind !== "category") throw new Refusal(409, "Only a category is deleted here.");
    const rooms = await db.query(`SELECT 1 FROM site.community_rooms WHERE space_id = $1 LIMIT 1`, [sid]);
    const spaces = await db.query(`SELECT 1 FROM site.community_spaces WHERE parent_id = $1 LIMIT 1`, [sid]);
    if (rooms.rows.length || spaces.rows.length) throw new Refusal(409, "This category still holds channels. Move or delete its channels first.");
    if (space.matrix_room_id) {
      throw new Refusal(409, "This category is already on the chat server, and deleting one there is not available yet. Rename it or leave it empty.");
    }
    await db.query(`DELETE FROM site.community_spaces WHERE id = $1`, [sid]);
  });
}

// ── The community's banner ──────────────────────────────────────────────────────────────────
// The wide picture over the channel list. It belongs to the community itself (the hub's row); the
// reconciler writes it on the space as its own state event, so the hub's icon stays its icon.

/** What the route's upload gives: the stored image's mxc, or the answer that refused it. */
export type BannerUpload = () => Promise<{ ok: true; contentUri: string } | { ok: false; response: Response }>;

function saveBanner(deps: CommunityDeps, mxc: string | null): Promise<Response> {
  return save(deps, mxc ? "set the community's banner" : "removed the community's banner", async (db) => {
    const { rows } = await db.query<{ id: number }>(
      `UPDATE site.community_spaces SET banner_mxc = $1, updated_at = now() WHERE kind = 'hub' RETURNING id`, [mxc]);
    if (!rows.length) throw new Refusal(409, "There is no community yet. Finish the community setup first.");
    return { bannerMxc: mxc };
  });
}

/** POST /api/admin/community/banner (multipart, field banner): upload, then save on the hub's row. */
export async function putBannerResponse(upload: BannerUpload, deps: CommunityDeps): Promise<Response> {
  const up = await upload();
  if (!up.ok) return up.response;
  return saveBanner(deps, up.contentUri);
}

/** DELETE /api/admin/community/banner: the community has no banner (the plain header). */
export function clearBannerResponse(deps: CommunityDeps): Promise<Response> {
  return saveBanner(deps, null);
}

// ── Roles ────────────────────────────────────────────────────────────────────────────────────

const COLOUR = /^#[0-9a-fA-F]{6}$/;

function roleFields(b: Record<string, unknown>): { cols: [string, unknown][] } {
  const cols: [string, unknown][] = [];
  if ("label" in b) {
    const label = typeof b.label === "string" ? b.label.trim() : "";
    if (label.length < 1 || label.length > 40 || CONTROL.test(label)) throw new Refusal(400, "A role name is 1 to 40 characters.");
    cols.push(["label", label]);
  }
  if ("colour" in b) {
    if (b.colour !== null && !(typeof b.colour === "string" && COLOUR.test(b.colour))) throw new Refusal(400, "A colour is like #33aa55.");
    cols.push(["colour", typeof b.colour === "string" ? b.colour.toLowerCase() : null]);
  }
  if ("hoist" in b) {
    if (typeof b.hoist !== "boolean") throw new Refusal(400, "Shown apart is on or off.");
    cols.push(["hoist", b.hoist]);
  }
  return { cols };
}

/** PATCH /api/admin/community/roles/:key {label?, colour?, hoist?} — a built-in role's level is fixed. */
export async function patchRoleResponse(req: Request, key: string, deps: CommunityDeps): Promise<Response> {
  const b = await body(req);
  if (!b) return refuse(400, "Nothing to change.");
  if (!/^[a-z0-9_-]{1,40}$/.test(key)) return refuse(400, "Not a role.");
  let cols: [string, unknown][];
  try { cols = roleFields(b).cols; } catch (e) { return refuse(400, (e as Error).message); }
  return save(deps, `changed the role ${key}`, async (db) => {
    const { rows } = await db.query<{ key: string; level: number; builtin: boolean }>(
      `SELECT key, level, builtin FROM site.community_roles WHERE key = $1 FOR UPDATE`, [key]);
    const role = rows[0];
    if (!role) throw new Refusal(404, "That role is gone. Reload the page.");
    if ("level" in b) {
      if (role.builtin) throw new Refusal(409, "The level of a built-in role is fixed.");
      throw new Refusal(409, "A role's level is set when it is made.");
    }
    if (!cols.length) throw new Refusal(400, "Nothing to change.");
    const params: unknown[] = [key, ...cols.map(([, v]) => v)];
    await db.query(`UPDATE site.community_roles SET ${cols.map(([c], i) => `${c} = $${i + 2}`).join(", ")} WHERE key = $1`, params);
  });
}

/** POST /api/admin/community/roles {label, level} — a level between Member (0) and Admin (100) that
 *  no built-in role holds; one role per level. */
export async function createRoleResponse(req: Request, deps: CommunityDeps): Promise<Response> {
  const b = await body(req);
  if (!b) return refuse(400, "Not a role.");
  const level = b.level;
  if (!(Number.isInteger(level) && (level as number) > 0 && (level as number) < 100)) return refuse(400, "A role's level is a whole number from 1 to 99.");
  let cols: [string, unknown][];
  try { cols = roleFields({ label: b.label, ...("colour" in b ? { colour: b.colour } : {}), ...("hoist" in b ? { hoist: b.hoist } : {}) }).cols; }
  catch (e) { return refuse(400, (e as Error).message); }
  const key = `level${level as number}`;
  return save(deps, `made the role ${key}`, async (db) => {
    const roles = (await db.query<{ key: string; level: number; builtin?: boolean }>(`SELECT key, level, builtin FROM site.community_roles`)).rows;
    const taken = roles.find((r) => r.level === level);
    if (taken) throw new Refusal(taken.builtin === false ? 409 : 400, taken.builtin === false ? "There is already a role at that level." : "That level belongs to a built-in role.");
    const keys = (await db.query<{ id: string; order_key: string }>(`SELECT key AS id, order_key FROM site.community_roles ORDER BY order_key COLLATE "C", key`)).rows;
    const orderKey = await keyAfterLast(db, "roles", keys);
    const v = Object.fromEntries(cols);
    await db.query(`INSERT INTO site.community_roles (key, label, level, colour, hoist, order_key, builtin)
                    VALUES ($1, $2, $3, $4, $5, $6, false)`, [key, v.label, level, v.colour ?? null, v.hoist ?? true, orderKey]);
    return { key };
  });
}

// ── Runs ─────────────────────────────────────────────────────────────────────────────────────

/** POST /api/admin/community/reconcile {mode: "report"|"apply"} — ask the host for one run now. */
export async function reconcileResponse(req: Request, deps: CommunityDeps & { askMode: (mode: "report" | "apply") => Promise<AskResult> }): Promise<Response> {
  const b = await body(req);
  const mode = b?.mode;
  if (mode !== "report" && mode !== "apply") return refuse(400, "A run is report or apply.");
  const asked = await deps.askMode(mode).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
  if (!asked.ok) return refuse(409, asked.error);
  (deps.log ?? console).log(`[community] ${deps.admin ?? "an admin"}: asked for a ${mode} run`);
  return reply({ ok: true, requestedAt: asked.requestedAt });
}

/** A run as the panel reads it (site.community_runs). */
export type RunView = {
  id: number; mode: string; startedAt: string; finishedAt: string | null; ok: boolean | null;
  drift: unknown[]; applied: unknown[]; error: string | null;
};

/** What the Community page reads in one request. */
export type CommunityView = DesiredState & {
  /** The last apply and the last report, each or null. */
  lastApply: RunView | null;
  lastReport: RunView | null;
  /** The newest run of any mode started at or after this, for "Applying…" (ISO). */
  latestStartedAt: string | null;
  /** community.reconciler: the server keeps the rooms as the panel sets them. */
  reconciler: boolean;
  /** This install can ask its host for a run (the bundle's request folder exists). */
  canAsk: boolean;
  /** The host's last answer to an apply request, and to a check (report) request. */
  host: { ok: boolean; at: string; message: string } | null;
  hostReport: { ok: boolean; at: string; message: string } | null;
  retentionCapDays: number;
};

/** Entries kept per list in the view: a run that changed a whole community is summarised. */
const MAX_LINES = 200;
const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, MAX_LINES) : []);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null);

type RunRow = { id: number; mode: string; started_at: Date | string; finished_at: Date | string | null; ok: boolean | null; drift: unknown; applied: unknown; error: string | null };

/** GET /api/admin/community. A normal read, not READ ONLY: readDesired fills the default roles
 *  into an empty table on its first read. */
export async function communityViewResponse(deps: Pick<CommunityDeps, "pool" | "retentionCapDays" | "log"> & {
  reconciler: boolean; canAsk: boolean; host: () => Promise<CommunityView["host"]>; hostReport?: () => Promise<CommunityView["hostReport"]>;
}): Promise<Response> {
  try {
    const desired = await readDesired(deps.pool);
    const runs = (await deps.pool.query<RunRow>(`
      SELECT DISTINCT ON (mode) id, mode, started_at, finished_at, ok, drift, applied, error
        FROM site.community_runs WHERE mode IN ('apply', 'report')
       ORDER BY mode, id DESC`)).rows;
    const latest = (await deps.pool.query<{ started_at: Date | string | null }>(`SELECT max(started_at) AS started_at FROM site.community_runs`)).rows[0];
    const view = (mode: string): RunView | null => {
      const r = runs.find((x) => x.mode === mode);
      return r ? { id: Number(r.id), mode: r.mode, startedAt: iso(r.started_at)!, finishedAt: iso(r.finished_at), ok: r.ok, drift: list(r.drift), applied: list(r.applied), error: r.error } : null;
    };
    const out: CommunityView = {
      ...desired, lastApply: view("apply"), lastReport: view("report"), latestStartedAt: iso(latest?.started_at ?? null),
      reconciler: deps.reconciler, canAsk: deps.canAsk, host: await deps.host(), hostReport: deps.hostReport ? await deps.hostReport() : null, retentionCapDays: deps.retentionCapDays(),
    };
    return reply(out);
  } catch (e) {
    (deps.log ?? console).error("[community] panel read failed:", e instanceof Error ? e.message : e);
    return refuse(503, "The community could not be read. Try again.");
  }
}
