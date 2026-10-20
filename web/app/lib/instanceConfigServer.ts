// The instance settings layer — web's server-side reader. SERVER ONLY.
//
// Keys are declared once in config/instance-schema.mjs; ./instanceSchema.generated.mjs is web's
// generated copy.
//
// Precedence for every key, in THIS process: env > database > the schema's neutral default.
// - Install-tier keys (the site's name + origins) are read from env once, at boot
//   (installValuesServer.ts) — read them through installValues.ts; this reader answers them from
//   the same values.
// - Plain instance values come straight from site.instance_config with web's own pool (web
//   never proxies DB reads through stream-api).
// - Stored credentials come from stream-api's GET /config/secrets?package=web (bearer secret):
//   stream-api alone holds INSTANCE_MASTER_KEY. One stream-api could not decrypt arrives as a
//   NAME in `unreadable` and resolves here as an ERROR, never as the default.
//
// Sync reads (`instanceValue`) from a cache on globalThis — Next can bundle a module into more
// than one chunk, and two copies of a module-level cache would disagree. Refreshed by
// `config_changed` on an INTERNAL socket (the bearer secret at upgrade), every 60 s as the
// backstop, and right after web's own writes. The loaded/stale state is exposed for the
// key cards: a reader answering from an old layer must be visible, not silent.
//
// FAIL-SAFE for the switches marked `legacyOn` (Stripe, PayPal, YouTube): those parts ran,
// always on, before they had a switch. On a database built by the migration chain (no
// schema_migrations row noted 'baseline') an ABSENT switch reads ON, with one loud
// line per key, so a web deploy that lands before the migration that writes the switch rows
// cannot switch a payment provider off and answer its webhooks "not found". Until the database is
// known to be baseline-built (not loaded yet, or the query failed) it reads ON too: on a fresh
// install nothing is lost by that, because a provider with no keys does nothing either way.

import pool from "../../lib/db.ts";
import { streamApiFetch, streamApiWsUrl } from "./streamApi.ts";
import { installValues, type InstallKey } from "./installValues.ts";
import {
  INSTANCE_KEYS, resolveInstanceValue,
} from "./instanceSchema.generated.mjs";

/** The JSDoc types the generated copy carries. */
export type InstanceEntry = (typeof INSTANCE_KEYS)[number];
export type InstanceResolution = ReturnType<typeof resolveInstanceValue>;

const SELF = "web";
const BY_KEY = new Map(INSTANCE_KEYS.map((e) => [e.key, e]));
const BACKSTOP_MS = 60_000;
const RECONNECT_MS = 5_000;

type Layer = {
  plain: Record<string, unknown>;
  secrets: Record<string, string>;
  unreadable: Set<string>;
  loadedAt: number | null;
  failingSince: number | null;
  lastError: string | null;
  /** true = built by the migration chain; false = from the baseline; null = not known. */
  chainBuilt: boolean | null;
};

type Deps = {
  env: () => Record<string, string | undefined>;
  queryPlain: () => Promise<{ key: string; value: unknown }[]>;
  fetchSecrets: () => Promise<{ values?: Record<string, string>; unreadable?: string[] }>;
  queryChainBuilt: () => Promise<boolean>;
  now: () => number;
  log: Pick<Console, "warn" | "error" | "log">;
};

const realDeps: Deps = {
  env: () => process.env,
  queryPlain: async () =>
    (await pool.query<{ key: string; value: unknown }>("SELECT key, value FROM site.instance_config")).rows,
  fetchSecrets: async () => {
    const res = await streamApiFetch("/config/secrets?package=web");
    if (!res.ok) throw new Error(`stream-api /config/secrets answered ${res.status}`);
    return (await res.json()) as { values?: Record<string, string>; unreadable?: string[] };
  },
  queryChainBuilt: async () =>
    (await pool.query<{ chain: boolean }>("SELECT NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE note = 'baseline') AS chain")).rows[0]?.chain !== false,
  now: () => Date.now(),
  log: console,
};

/** @test-only the factory builds an isolated reader with stub deps; production uses the
 *  globalThis singleton below. */
export function createInstanceReader(deps: Deps = realDeps) {
  const layer: Layer = { plain: {}, secrets: {}, unreadable: new Set(), loadedAt: null, failingSince: null, lastError: null, chainBuilt: null };
  const warnedFallback = new Set<string>();

  function entryOf(key: string): InstanceEntry {
    const e = BY_KEY.get(key);
    if (!e) throw new Error(`unknown instance key ${key}`);
    return e;
  }

  function resolve(key: string): InstanceResolution {
    const e = entryOf(key);
    if (e.tier === "install") {
      // The values published at boot are the truth for install keys (installValues.ts says why).
      const v = installValues()[e.key as InstallKey] ?? "";
      return v
        ? { value: v, source: "env", envName: e.env[0] ?? null, error: null }
        : resolveInstanceValue(e, deps.env(), null);
    }
    const r = resolveInstanceValue(e, deps.env(), e.secret ? layer.secrets : layer.plain);
    if (e.secret && r.source !== "env" && layer.unreadable.has(e.key)) {
      return { value: null, source: "database", envName: null, error: "stored credential cannot be read (stream-api could not decrypt it)" };
    }
    if (e.legacyOn && r.source === "default" && layer.chainBuilt !== false) {
      if (layer.chainBuilt === true && !warnedFallback.has(e.key)) {
        warnedFallback.add(e.key);
        deps.log.error(`[instance-config] ${e.key} has no row on a database built by the migration chain — kept ON (fail-safe). Apply the pending database migrations (blackbranch migrate on a bundle install) to write it.`);
      }
      return { ...r, value: true };
    }
    return r;
  }

  /** The switches the fail-safe holds on right now (the doctor shows them). */
  function heldOn(): string[] {
    if (layer.chainBuilt !== true) return [];
    return INSTANCE_KEYS.filter((e) => e.legacyOn && resolveInstanceValue(e, deps.env(), layer.plain).source === "default").map((e) => e.key);
  }

  /** Re-read both halves. Resolves true on success; a failure keeps the last good layer (or
   *  env + defaults before the first) and is recorded, never thrown. */
  async function load(): Promise<boolean> {
    try {
      const [rows, sec, chain] = await Promise.all([deps.queryPlain(), deps.fetchSecrets(), deps.queryChainBuilt().catch(() => null)]);
      const plain: Record<string, unknown> = {};
      for (const r of rows) {
        const e = BY_KEY.get(r.key);
        if (e && !e.secret && e.tier !== "install") plain[r.key] = r.value;
      }
      layer.plain = plain;
      layer.secrets = sec && typeof sec.values === "object" && sec.values ? sec.values : {};
      layer.unreadable = new Set(Array.isArray(sec?.unreadable) ? sec.unreadable : []);
      layer.chainBuilt = chain;
      layer.loadedAt = deps.now();
      layer.failingSince = null;
      layer.lastError = null;
      return true;
    } catch (e) {
      if (layer.failingSince === null) layer.failingSince = deps.now();
      layer.lastError = e instanceof Error ? e.message : String(e);
      deps.log.warn(`[instance-config] load failed: ${layer.lastError} — keeping ${layer.loadedAt !== null ? "the last layer" : "env + defaults"}`);
      return false;
    }
  }

  function state() {
    return {
      loaded: layer.loadedAt !== null,
      loadedAt: layer.loadedAt !== null ? new Date(layer.loadedAt).toISOString() : null,
      failingSince: layer.failingSince !== null ? new Date(layer.failingSince).toISOString() : null,
    };
  }

  /** Every key web consumes, as the page shows it: source, winning env name, page-safe
   *  display (`…abcd` for a secret), error. Never a secret value. */
  function statusReport() {
    const keys: Record<string, { source: string; envName: string | null; display: unknown; error: string | null }> = {};
    for (const e of INSTANCE_KEYS) {
      if (!e.packages.includes(SELF)) continue;
      const r = resolve(e.key);
      keys[e.key] = { source: r.source, envName: r.envName, display: display(e, r.value), error: r.error };
    }
    return keys;
  }

  return { resolve, load, state, statusReport, heldOn, layer };
}

/** What may be shown of a secret — the same rule as stream-api: last four, only when long.
 */
export function lastFour(value: unknown): string {
  const s = String(value ?? "");
  return s.length >= 12 ? s.slice(-4) : "";
}
function display(e: InstanceEntry, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (e.secret) { const l4 = lastFour(value); return l4 ? `…${l4}` : "(set)"; }
  return value;
}

// ── the process singleton ─────────────────────────────────────────────────────────────────
type Reader = ReturnType<typeof createInstanceReader>;
const G = globalThis as typeof globalThis & { __instanceReader?: Reader; __instanceReaderStarted?: boolean };
function reader(): Reader {
  return (G.__instanceReader ??= createInstanceReader());
}

/** env > DB > default for one key, in this process.
 */
export function instanceResolve(key: string): InstanceResolution {
  return reader().resolve(key);
}
/** A string-valued key's value, or null. */
export function instanceString(key: string): string | null {
  const v = reader().resolve(key).value;
  return typeof v === "string" ? v : null;
}
/** A switch's value: true only when it resolves to exactly true (unset, a default of false or a
 *  read error are all "off"). */
export function instanceBool(key: string): boolean {
  return reader().resolve(key).value === true;
}
/** The `legacyOn` module switches the fail-safe holds on (no row on a chain-built database). */
export function instanceHeldOn(): string[] {
  return reader().heldOn();
}
/** A list-valued key's value ([] when unset). */
export function instanceList(key: string): string[] {
  const v = reader().resolve(key).value;
  return Array.isArray(v) ? v : [];
}
/** This process's loaded/stale state.
 */
export function instanceState() {
  return reader().state();
}
/** This process's view of every key it consumes (the Credentials page).
 */
export function instanceStatusReport() {
  return reader().statusReport();
}
/** Re-read now — after web's own writes.
 */
export function reloadInstanceConfig(): Promise<boolean> {
  return reader().load();
}

/**
 * Boot (instrumentation.ts, after publishInstallValues): the first load, the internal socket and
 * the backstop.
 */
export async function startInstanceConfig(): Promise<void> {
  if (G.__instanceReaderStarted) return;
  G.__instanceReaderStarted = true;
  const r = reader();
  const ok = await r.load();
  console.log(`[instance-config] ${ok ? "loaded" : "NOT loaded (env + defaults) — retrying every 60 s"}`);
  setInterval(() => { void r.load(); }, BACKSTOP_MS).unref?.();
  subscribe(r);
}

// Node's global WebSocket accepts undici's `headers` option (the bearer secret makes this an
// INTERNAL socket — the only kind stream-api sends control frames to).
type NodeWebSocketCtor = new (url: string, init?: { headers?: Record<string, string> }) => WebSocket;

function subscribe(r: Reader) {
  const url = streamApiWsUrl();
  const secret = process.env.STREAM_API_SECRET ?? "";
  if (!url || !secret) {
    console.warn("[instance-config] stream-api socket (STREAM_API_WS_URL / STREAM_API_URL) or STREAM_API_SECRET unset — no live config_changed; the 60 s re-read still runs");
    return;
  }
  const connect = () => {
    let ws: WebSocket;
    try {
      ws = new (WebSocket as unknown as NodeWebSocketCtor)(url, { headers: { Authorization: `Bearer ${secret}` } });
    } catch {
      setTimeout(connect, RECONNECT_MS).unref?.();
      return;
    }
    ws.addEventListener("open", () => { void r.load(); });
    ws.addEventListener("message", (ev) => {
      const text = typeof ev.data === "string" ? ev.data : "";
      if (!text.includes('"config_changed"')) return;
      void r.load();
    });
    ws.addEventListener("close", () => { setTimeout(connect, RECONNECT_MS).unref?.(); });
    ws.addEventListener("error", () => { /* 'close' follows and reconnects */ });
  };
  connect();
}
