// The community's desired state: what the streamer wants the spaces, channels and roles to be
// (tables from v165). The reconciler makes Matrix match it; the panel edits it through
// validateRoomInput. Spec: docs/superpowers/specs/2026-10-23-community-management-discord-design.md §4.

/** Who can see a channel (spec §4.3). @parked consumed by the reconciler feed and the panel (community plan tasks 2.x, 3.x) */
export type SeeRule = "everyone" | "supporters" | "mods" | "staff" | "invited";
/** Who can post in a channel (spec §4.3). @parked consumed by the reconciler feed and the panel (community plan tasks 2.x, 3.x) */
export type PostRule = "everyone" | "supporters" | "staff" | "mods";
/** @parked consumed by the reconciler feed and the panel (community plan tasks 2.x, 3.x) */
export type RoomKind = "text" | "announcement" | "forum";
/** @parked consumed by the reconciler feed and the panel (community plan tasks 2.x, 3.x) */
export type SpaceKind = "hub" | "category" | "gate";

/** @parked consumed by the reconciler feed and the panel (community plan tasks 2.x, 3.x) */
export type SpaceRow = {
  id: number;
  parentId: number | null;
  kind: SpaceKind;
  name: string;
  topic: string | null;
  avatarMxc: string | null;
  /** The banner over the channel list (the reconciler writes it as app.blackbranch.banner); the hub's only, from the panel. */
  bannerMxc: string | null;
  orderKey: string;
  matrixRoomId: string | null;
  gateTier: string | null;
};

/** @parked consumed by the reconciler feed and the panel (community plan tasks 2.x, 3.x) */
export type RoomRow = {
  id: number;
  spaceId: number;
  kind: RoomKind;
  name: string;
  topic: string | null;
  avatarMxc: string | null;
  orderKey: string;
  see: SeeRule;
  post: PostRule;
  retentionDays: number | null;
  encrypted: boolean;
  published: boolean;
  archived: boolean;
  matrixRoomId: string | null;
  discordChannelId: string | null;
};

/** @parked consumed by the reconciler feed and the panel (community plan tasks 2.x, 3.x) */
export type RoleRow = {
  key: string;
  label: string;
  level: number;
  colour: string | null;
  hoist: boolean;
  orderKey: string;
  builtin: boolean;
};

/** @parked consumed by the reconciler feed and the panel (community plan tasks 2.x, 3.x) */
export type DesiredState = { spaces: SpaceRow[]; rooms: RoomRow[]; roles: RoleRow[] };

type Queryable = { query: <R extends object>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> };

const SEE_RULES: readonly SeeRule[] = ["everyone", "supporters", "mods", "staff", "invited"];
const POST_RULES: readonly PostRule[] = ["everyone", "supporters", "staff", "mods"];
const ROOM_KINDS: readonly RoomKind[] = ["text", "announcement", "forum"];

// The default ladder (spec §4.2), top down. migrate-v165.sql seeds the same rows; desired.db.test.ts
// holds the two equal (the seeded read and the filled read must give the same ladder).
const DEFAULT_ROLES: readonly RoleRow[] = [
  { key: "admin", label: "Admin", level: 100, colour: null, hoist: true, orderKey: "a0", builtin: true },
  { key: "staff", label: "Staff", level: 75, colour: null, hoist: true, orderKey: "a1", builtin: true },
  { key: "mod", label: "Mod", level: 50, colour: null, hoist: true, orderKey: "a2", builtin: true },
  { key: "bot", label: "Bot", level: 50, colour: null, hoist: true, orderKey: "a3", builtin: true },
  { key: "supporter", label: "Supporter", level: 10, colour: null, hoist: true, orderKey: "a4", builtin: true },
  { key: "member", label: "Member", level: 0, colour: null, hoist: false, orderKey: "a5", builtin: true },
  { key: "timeout", label: "Timed out", level: -1, colour: null, hoist: false, orderKey: "a6", builtin: true },
];

// ── Order keys ──────────────────────────────────────────────────────────────────────────────────
// Fractional indexing (the public-domain scheme of rocicorp's `fractional-indexing`): a key is an
// integer part whose length its head letter encodes ('a' = 1 digit, 'b' = 2, … ; 'Z', 'Y', … the
// negatives), then an optional fraction with no trailing zero. Appends increment the integer, so a
// thousand appends stay a few characters long; inserts between neighbours extend the fraction.
// Every character is base-62 ASCII and keys compare by code point, as m.space.child `order` does.

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = DIGITS.charAt(0);
const TOP = DIGITS.charAt(DIGITS.length - 1);
const MAX_ORDER_LENGTH = 50; // m.space.child `order`
const SMALLEST_INTEGER = "A" + ZERO.repeat(26);

function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 97 + 2;
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
  throw new Error(`invalid order key head: ${head}`);
}

function integerPart(key: string): string {
  const len = integerLength(key.charAt(0));
  if (len > key.length) throw new Error(`invalid order key: ${key}`);
  return key.slice(0, len);
}

function assertOrderKey(key: string): void {
  if (key === SMALLEST_INTEGER) throw new Error(`invalid order key: ${key}`);
  for (const c of key) if (!DIGITS.includes(c)) throw new Error(`invalid order key: ${key}`);
  const i = integerPart(key);
  if (key.slice(i.length).endsWith(ZERO)) throw new Error(`invalid order key: ${key}`);
}

/** A fraction strictly between a and b (b null = 1); neither has a trailing zero. */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while (n < b.length && (a.charAt(n) || ZERO) === b.charAt(n)) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a.charAt(0)) : 0;
  const db = b !== null ? DIGITS.indexOf(b.charAt(0)) : DIGITS.length;
  if (db - da > 1) return DIGITS.charAt(Math.round((da + db) / 2));
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS.charAt(da) + midpoint(a.slice(1), null);
}

/** The next (+1) or previous (−1) integer part; null past either end of the scheme. */
function stepInteger(x: string, step: 1 | -1): string | null {
  const head = x.charAt(0);
  const digs = x.slice(1);
  const wrap = step === 1 ? ZERO : TOP;
  for (let i = digs.length - 1; i >= 0; i--) {
    const d = DIGITS.indexOf(digs.charAt(i)) + step;
    if (d >= 0 && d < DIGITS.length) return head + digs.slice(0, i) + DIGITS.charAt(d) + wrap.repeat(digs.length - 1 - i);
  }
  // Every digit carried: the integer part gains (or loses) a digit, crossing zero between Z and a.
  if (step === 1 && head === "Z") return "a" + ZERO;
  if (step === -1 && head === "a") return "Z" + TOP;
  if ((step === 1 && head === "z") || (step === -1 && head === "A")) return null;
  const h = String.fromCharCode(head.charCodeAt(0) + step);
  const longer = step === 1 ? h > "a" : h < "Z";
  return h + wrap.repeat(longer ? digs.length + 1 : digs.length - 1);
}

function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) assertOrderKey(a);
  if (b !== null) assertOrderKey(b);
  if (a !== null && b !== null && a >= b) throw new Error(`order keys out of order: ${a} >= ${b}`);
  if (a === null) {
    if (b === null) return "a" + ZERO;
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INTEGER) return ib + midpoint("", fb);
    if (ib < b) return ib;
    const down = stepInteger(ib, -1);
    if (down === null) throw new Error("no order key below the smallest");
    return down;
  }
  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  if (b === null) return stepInteger(ia, 1) ?? ia + midpoint(fa, null);
  const ib = integerPart(b);
  if (ia === ib) return ia + midpoint(fa, b.slice(ib.length));
  const up = stepInteger(ia, 1);
  if (up === null) throw new Error("no order key above the largest");
  return up < b ? up : ia + midpoint(fa, null);
}

/**
 * A key that sorts strictly between two neighbours (null = the list's start or end):
 * "a0" < "a0V" < "a1" < "b00". Throws on neighbours out of order, not of this scheme, or when the
 * key would exceed m.space.child's 50 characters (renumber the list then).
 * @parked consumed by the reconciler feed and the panel's drag-to-reorder (community plan tasks 2.x, 3.x)
 */
export function orderKeyBetween(before: string | null, after: string | null): string {
  const key = keyBetween(before, after);
  if (key.length > MAX_ORDER_LENGTH) throw new Error("order key would exceed 50 characters: renumber the list");
  return key;
}

function isOrderKey(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_ORDER_LENGTH) return false;
  try {
    assertOrderKey(v);
    return true;
  } catch {
    return false;
  }
}

// ── Validation ──────────────────────────────────────────────────────────────────────────────────

// Spec §4.5: the install's retention cap defaults to one year; "forever" turns the cap off, leaving
// the database's ten-year ceiling (the v165 CHECK).
const DEFAULT_RETENTION_CAP_DAYS = 365;
const RETENTION_CEILING_DAYS = 3650;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

const isId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isNullableString = (v: unknown): v is string | null => v === null || typeof v === "string";
const isNullableNumberish = (v: unknown, re: RegExp): v is string | null => v === null || (typeof v === "string" && re.test(v));

/**
 * A room as the panel submits it, checked before it is saved. Names are 1–100 characters with no
 * control characters; retention is null or whole days from 1 to the install's cap; a channel
 * everyone can see is never encrypted, and only such a channel can be published.
 * @parked consumed by the panel's channel editor and the import (community plan tasks 3.x, 4.x)
 */
export function validateRoomInput(
  input: unknown,
  opts: { retentionCapDays?: number | null } = {},
): RoomRow | { error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { error: "Not a channel." };
  const r = input as Record<string, unknown>;
  if (!isId(r.id) || !isId(r.spaceId)) return { error: "A channel needs an id and a space." };
  if (!ROOM_KINDS.includes(r.kind as RoomKind)) return { error: "Unknown channel kind." };
  if (typeof r.name !== "string" || r.name.length < 1 || r.name.length > 100) {
    return { error: "A channel name is 1 to 100 characters." };
  }
  if (CONTROL.test(r.name)) return { error: "A channel name cannot hold control characters." };
  if (!isNullableString(r.topic)) return { error: "A topic is text." };
  if (!isNullableNumberish(r.avatarMxc, /^mxc:\/\/[^/\s]+\/[^/\s]+$/)) return { error: "An icon is an mxc:// address." };
  if (!isOrderKey(r.orderKey)) return { error: "Invalid position." };
  if (!SEE_RULES.includes(r.see as SeeRule)) return { error: "Unknown rule for who can see." };
  if (!POST_RULES.includes(r.post as PostRule)) return { error: "Unknown rule for who can post." };
  const cap = opts.retentionCapDays === undefined ? DEFAULT_RETENTION_CAP_DAYS : (opts.retentionCapDays ?? RETENTION_CEILING_DAYS);
  const days = r.retentionDays;
  if (days !== null && !(Number.isInteger(days) && (days as number) >= 1 && (days as number) <= Math.min(cap, RETENTION_CEILING_DAYS))) {
    return { error: `Messages are kept 1 to ${Math.min(cap, RETENTION_CEILING_DAYS)} days, or with no limit.` };
  }
  for (const k of ["encrypted", "published", "archived"] as const) {
    if (typeof r[k] !== "boolean") return { error: `${k} must be true or false.` };
  }
  if (!isNullableNumberish(r.matrixRoomId, /^!\S+$/)) return { error: "Invalid Matrix room id." };
  if (!isNullableNumberish(r.discordChannelId, /^\d{1,32}$/)) return { error: "Invalid Discord channel id." };
  if (r.encrypted && r.see === "everyone") return { error: "A channel everyone can see cannot be encrypted." };
  if (r.published && r.see !== "everyone") return { error: "Only a channel everyone can see can be published." };
  return {
    id: r.id,
    spaceId: r.spaceId,
    kind: r.kind as RoomKind,
    name: r.name,
    topic: r.topic,
    avatarMxc: r.avatarMxc,
    orderKey: r.orderKey,
    see: r.see as SeeRule,
    post: r.post as PostRule,
    retentionDays: days as number | null,
    encrypted: r.encrypted as boolean,
    published: r.published as boolean,
    archived: r.archived as boolean,
    matrixRoomId: r.matrixRoomId,
    discordChannelId: r.discordChannelId,
  };
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────

// Order keys compare by code point (COLLATE "C"), as Matrix compares m.space.child order; a
// locale collation would put "Z" after "a".
const SPACES_SQL = `
  SELECT id, parent_id AS "parentId", kind, name, topic, avatar_mxc AS "avatarMxc", banner_mxc AS "bannerMxc", order_key AS "orderKey",
         matrix_room_id AS "matrixRoomId", gate_tier AS "gateTier"
    FROM site.community_spaces
   ORDER BY order_key COLLATE "C", id`;
const ROOMS_SQL = `
  SELECT id, space_id AS "spaceId", kind, name, topic, avatar_mxc AS "avatarMxc", order_key AS "orderKey",
         see_rule AS see, post_rule AS post, retention_days AS "retentionDays", encrypted, published, archived,
         matrix_room_id AS "matrixRoomId", discord_channel_id AS "discordChannelId"
    FROM site.community_rooms
   ORDER BY space_id, order_key COLLATE "C", id`;
const ROLES_SQL = `
  SELECT key, label, level, colour, hoist, order_key AS "orderKey", builtin
    FROM site.community_roles
   ORDER BY level DESC, order_key COLLATE "C", key`;

// An install that started from the baseline has no roles (the seed holds singleton rows only), as a
// store's prices start empty: the default ladder is written on first read. ON CONFLICT makes two
// first readers safe.
async function fillDefaultRoles(db: Queryable): Promise<void> {
  const values = DEFAULT_ROLES.map((_, i) => `($${i * 7 + 1}, $${i * 7 + 2}, $${i * 7 + 3}, $${i * 7 + 4}, $${i * 7 + 5}, $${i * 7 + 6}, $${i * 7 + 7})`);
  await db.query(
    `INSERT INTO site.community_roles (key, label, level, colour, hoist, order_key, builtin)
     VALUES ${values.join(", ")} ON CONFLICT (key) DO NOTHING`,
    DEFAULT_ROLES.flatMap((r) => [r.key, r.label, r.level, r.colour, r.hoist, r.orderKey, r.builtin]),
  );
}

/**
 * The whole desired state: spaces and rooms in order-key order, roles from the top of the ladder.
 * @parked consumed by the reconciler feed and the panel (community plan tasks 2.x, 3.x)
 */
export async function readDesired(db: Queryable): Promise<DesiredState> {
  let roles = (await db.query<RoleRow>(ROLES_SQL)).rows;
  if (roles.length === 0) {
    await fillDefaultRoles(db);
    roles = (await db.query<RoleRow>(ROLES_SQL)).rows;
  }
  const spaces = (await db.query<SpaceRow>(SPACES_SQL)).rows;
  const rooms = (await db.query<RoomRow>(ROOMS_SQL)).rows;
  return { spaces, rooms, roles };
}
