// The doctor's SITE facts. SERVER ONLY. Everything here READS: SELECTs, GETs through the public
// names, and the module Tests run by stream-api with `record: false` (asked only of a stream-api
// that says it can — an older one would store the result). The facts are numbers, booleans and
// fixed words: no secret, no chat text, no viewer id, no address. The verdicts are
// config/doctor.mjs's, never decided here.

import pool from "@/lib/db";
import { installValue } from "../installValues";
import { matrixBaseUrl, matrixFederationServer, matrixOAuthIssuer } from "../matrixConfig";
import { legacyNamespaceSet } from "../matrixNamespace";
import { lockdownDoctorFact, type LockdownDoctorFact } from "../lockdownRegistration";
import { legacyNativePlatform } from "../nativePlatform";
import { instanceBool, instanceHeldOn, instanceResolve } from "../instanceConfigServer";
import { INSTANCE_KEYS, MODULES, runProviderCheck, normalizeCheckResult, describeCheck } from "../instanceSchema.generated.mjs";
import { streamApiFetch } from "../streamApi";
import { decToken } from "../tokenCrypto";
import { hostRequestsAvailable } from "../hostRequests";
import { keyInstalled, ownerPluginInstalled } from "../plugins/installed";

type Snapshot = {
  features?: string[];
  state?: { loaded?: boolean };
  secrets?: Record<string, { readable: boolean }>;
  self?: Record<string, { display: unknown } | undefined>;
  reports?: Record<string, { at?: string; state?: { loaded?: boolean } | null } | undefined>;
};
type ModuleTest = { step: string; ok: boolean | null; detail: string };
export type SiteFacts = {
  v: 1;
  at: string;
  bundle: boolean;
  db: { reachable: boolean; version: number | null; baseline: boolean | null; vector: string | null };
  matrix: {
    versions: number; mas: number; issuer: boolean | null; wellKnownClient: boolean; wellKnownServer: boolean;
    federation: { switch: boolean; reachable: boolean | null }; legacyNamespace: boolean;
    /** The lockdown's last change to homeserver sign-up and the host's last render (null: unreadable). */
    lockdown: LockdownDoctorFact | null;
  };
  secrets: { missing: string[]; token: "ok" | "fail" | "none" | "unknown"; stored: { total: number; unreadable: number } | null };
  modules: { id: string; on: boolean; servesMedia: boolean; owner: boolean; tests: ModuleTest[] }[];
  /** Whether this site's api. address answers through Cloudflare (a `cf-ray` header on its own
   *  /stream/current), measured from here — null when it did not answer. The media check's front door
   *  on an install that is not a bundle. */
  door: { apiCloudflare: boolean | null };
  skipped: string[];
  heldOn: string[];
  payments: { stripe: ProviderFact; paypal: ProviderFact };
  /** `tested: false` = the channel is set and there is nothing to test (no app keys): not checked. */
  platforms: { id: string; label: string; set: boolean; tested: boolean; ok: boolean | null; detail: string }[];
  /** The Admin Panel's service strip as facts, and chat coming in per platform. `connected` is
   *  null while the ingest service does not report its readers' connections. */
  services: {
    api: { reachable: boolean; loaded: boolean };
    ingest: { reportedMinutesAgo: number | null; loaded: boolean | null };
    platforms: { id: string; label: string; set: boolean; connected: boolean | null; lastMessageMinutes: number | null }[];
  };
  /** How many operator alert topics the chat service holds (0, 1 or 2); null when it did not answer. */
  alerts: { topics: number } | null;
  /** site.legacyId: the install value's state (never the word itself), and whether any account here is
   *  older than the platform-key rename (v145) — null when that could not be read. */
  platform: { legacyId: "unset" | "set" | "ignored"; olderAccounts: boolean | null };
};
type ProviderFact = { on: boolean; test: { ok: boolean | null; code: string; detail: string } | null };

const TIMEOUT_MS = 8_000;

/** GET → the status (0 = no answer) and the JSON body when there is one. Never throws. */
async function probe(url: string): Promise<{ status: number; json: Record<string, unknown> | null }> {
  try {
    const res = await fetch(url, { cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, json: json && typeof json === "object" ? json : null };
  } catch {
    return { status: 0, json: null };
  }
}
const noSlash = (u: unknown) => (typeof u === "string" ? u.replace(/\/+$/, "") : "");

async function dbFacts(): Promise<SiteFacts["db"]> {
  try {
    const { rows } = await pool.query<{ version: number | null; baseline: boolean; vector: string | null }>(
      `SELECT (SELECT max(version) FROM public.schema_migrations)::int AS version,
              EXISTS (SELECT 1 FROM public.schema_migrations WHERE note = 'baseline') AS baseline,
              (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector`);
    const r = rows[0];
    return { reachable: true, version: r?.version ?? null, baseline: r?.baseline ?? null, vector: r?.vector ?? null };
  } catch {
    return { reachable: false, version: null, baseline: null, vector: null };
  }
}

async function matrixFacts(): Promise<SiteFacts["matrix"]> {
  const base = noSlash(matrixBaseUrl());
  const issuer = matrixOAuthIssuer();
  const origin = noSlash(installValue("site.origin"));
  const fedServer = matrixFederationServer();
  const issuerBase = issuer.endsWith("/") ? issuer : `${issuer}/`;
  const [versions, health, meta, wkClient, wkServer, fed] = await Promise.all([
    probe(`${base}/_matrix/client/versions`),
    probe(`${issuerBase}health`),
    probe(`${base}/_matrix/client/v1/auth_metadata`),
    probe(`${origin}/.well-known/matrix/client`),
    probe(`${origin}/.well-known/matrix/server`),
    fedServer ? probe(`https://${fedServer}/_matrix/federation/v1/version`) : Promise.resolve({ status: 0, json: null }),
  ]);
  // MAS answers /health on the listener the bundle exposes; an install whose sign-in service keeps
  // /health private still answers its discovery document.
  let mas = health.status;
  if (mas === 404) mas = (await probe(`${issuerBase}.well-known/openid-configuration`)).status;
  const client = wkClient.json;
  const hs = client?.["m.homeserver"] as { base_url?: unknown } | undefined;
  const auth = client?.["m.authentication"] as { issuer?: unknown } | undefined;
  return {
    versions: versions.status === 200 && Array.isArray(versions.json?.versions) ? 200 : versions.status || 0,
    mas,
    issuer: meta.status === 200 && meta.json ? meta.json.issuer === issuer : null,
    wellKnownClient: wkClient.status === 200 && noSlash(hs?.base_url) === base && (!issuer || auth?.issuer === issuer),
    wellKnownServer: wkServer.status === 200 && wkServer.json?.["m.server"] === fedServer,
    federation: {
      switch: instanceBool("matrix.federation"),
      reachable: fed.status === 0 ? false : fed.status === 200 && !!fed.json?.server,
    },
    legacyNamespace: legacyNamespaceSet(),
    lockdown: await lockdownDoctorFact().catch(() => null),
  };
}

/** The secrets this process runs with: present, never shown. */
function siteSecretsMissing(env: Record<string, string | undefined> = process.env): string[] {
  const missing: string[] = [];
  if (!env.AUTH_SECRET) missing.push("AUTH_SECRET");
  if (!/^[0-9a-fA-F]{64}$/.test(env.TOKEN_ENC_KEY ?? "")) missing.push("TOKEN_ENC_KEY");
  if (!env.STREAM_API_SECRET) missing.push("STREAM_API_SECRET");
  if (!env.DATABASE_URL) missing.push("DATABASE_URL");
  if (!instanceResolve("matrix.oauth.clientSecret").value) missing.push("MATRIX_OAUTH_CLIENT_SECRET");
  return missing;
}

/** One stored token (encrypted with TOKEN_ENC_KEY) decrypted in memory and dropped. */
async function tokenFact(): Promise<SiteFacts["secrets"]["token"]> {
  const sources = [
    "SELECT mx_refresh_token AS t FROM site.user_sessions WHERE mx_refresh_token LIKE 'v1:%' LIMIT 1",
    "SELECT mx_refresh_token AS t FROM site.users WHERE mx_refresh_token LIKE 'v1:%' LIMIT 1",
    "SELECT refresh_token AS t FROM site.accounts WHERE refresh_token LIKE 'v1:%' LIMIT 1",
  ];
  try {
    for (const sql of sources) {
      const { rows } = await pool.query<{ t: string }>(sql);
      if (rows[0]) return decToken(rows[0].t) !== null ? "ok" : "fail";
    }
    return "none";
  } catch {
    return "unknown";
  }
}

async function readSnapshot(): Promise<Snapshot | null> {
  try {
    const res = await streamApiFetch("/config", { cache: "no-store" });
    return res.ok ? ((await res.json()) as Snapshot) : null;
  } catch { return null; }
}

/** One credential's Test, recording nothing: web's own check here, stream-api's with record:false. */
async function runTest(key: string, snap: Snapshot | null): Promise<{ ok: boolean | null; detail: string }> {
  const e = INSTANCE_KEYS.find((k) => k.key === key);
  if (!e || !e.test) return { ok: null, detail: "no Test" };
  const parts: { ok: boolean | null; detail: string }[] = [];
  if (e.packages.includes("web")) {
    const r = normalizeCheckResult((await runProviderCheck(e.test, (k: string) => instanceResolve(k).value, fetch)) ?? { ok: false, code: "no_check" });
    parts.push({ ok: r.ok, detail: describeCheck(r) });
  }
  if (e.secret && e.packages.some((p) => p !== "web")) {
    if (!snap) parts.push({ ok: null, detail: "the chat service did not answer" });
    else if (!snap.features?.includes("test-unrecorded")) parts.push({ ok: null, detail: "the chat service is older than the doctor; its Test was not run" });
    else {
      try {
        const res = await streamApiFetch(`/config/test/${encodeURIComponent(key)}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ record: false }),
        }, 25_000);
        const body = (await res.json().catch(() => ({}))) as { results?: { ok: boolean | null; detail?: string }[]; error?: string };
        if (res.ok && Array.isArray(body.results)) for (const x of body.results) parts.push({ ok: x.ok === true ? true : x.ok === false ? false : null, detail: String(x.detail ?? "").slice(0, 160) });
        else parts.push({ ok: null, detail: String(body.error ?? `the chat service answered ${res.status}`).slice(0, 160) });
      } catch { parts.push({ ok: null, detail: "the chat service did not answer" }); }
    }
  }
  const bad = parts.find((p) => p.ok === false);
  if (bad) return bad;
  const unrun = parts.find((p) => p.ok === null);
  return unrun ?? { ok: true, detail: parts.map((p) => p.detail).join("; ") };
}

/** One check in THIS process only (web holds every payment and platform value), recording nothing. */
async function webCheck(test: string): Promise<{ ok: boolean | null; code: string; detail: string }> {
  const r = normalizeCheckResult((await runProviderCheck(test, (k: string) => instanceResolve(k).value, fetch)) ?? { ok: false, code: "no_check" });
  return { ok: r.ok, code: r.code, detail: describeCheck(r) };
}
const isSet = (key: string) => { const v = instanceResolve(key).value; return v !== null && v !== undefined && v !== ""; };

async function paymentFacts(): Promise<SiteFacts["payments"]> {
  const provider = async (id: "stripe" | "paypal", test: string): Promise<ProviderFact> => {
    const on = instanceBool(`modules.${id}`);
    return { on, test: on ? await webCheck(test) : null };
  };
  const [stripe, paypal] = await Promise.all([provider("stripe", "stripe-webhook"), provider("paypal", "paypal-webhook")]);
  return { stripe, paypal };
}

/** The platforms the doctor knows, and whether each is set up (its channel is). */
function platformsSetUp(): { id: string; label: string; set: boolean; test: string | null; why: string }[] {
  return [
    { id: "twitch", label: "Twitch", set: isSet("platform.twitch.channel"), test: isSet("twitch.clientId") ? "twitch" : null, why: "chat is read without signing in" },
    { id: "kick", label: "Kick", set: isSet("platform.kick.slug"), test: isSet("kick.clientId") ? "kick" : null, why: "no app to test" },
    { id: "streamplace", label: "Streamplace", set: isSet("platform.streamplace.did"), test: "streamplace", why: "" },
    { id: "youtube", label: "YouTube", set: instanceBool("modules.youtube") && isSet("platform.youtube.channelId"), test: isSet("youtube.apiKey") ? "youtube" : null, why: "no API key to test" },
  ];
}

/** A platform counts as set up once its channel is; its Test runs when it has something to test,
 *  and one with nothing to test is reported as not tested — never as passed. */
async function platformFacts(rows = platformsSetUp()): Promise<SiteFacts["platforms"]> {
  return Promise.all(rows.map(async (r) => {
    if (!r.set) return { id: r.id, label: r.label, set: false, tested: false, ok: null, detail: "" };
    if (!r.test) return { id: r.id, label: r.label, set: true, tested: false, ok: null, detail: `not checked — channel set; nothing to test (${r.why})` };
    const t = await webCheck(r.test);
    return { id: r.id, label: r.label, set: true, tested: true, ok: t.ok, detail: t.detail };
  }));
}

/** Minutes since each platform's newest chat line, over the last 30 days (null = none). */
async function lastMessageMinutes(ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  try {
    const { rows } = await pool.query<{ platform: string; minutes: number }>(
      `SELECT platform, floor(extract(epoch FROM now() - max(created_at)) / 60)::int AS minutes
         FROM stream.chat_log
        WHERE created_at > now() - interval '30 days' AND platform = ANY($1::text[])
        GROUP BY platform`, [ids]);
    return new Map(rows.map((r) => [r.platform, Number(r.minutes)]));
  } catch {
    return new Map();
  }
}

/** The service strip's facts (the /config snapshot: stream-api answering, stream-ingest's last
 *  report) and, per set-up platform, its newest chat line. */
async function serviceFacts(snap: Snapshot | null, rows = platformsSetUp(), now = Date.now()): Promise<SiteFacts["services"]> {
  const ingest = snap?.reports?.["stream-ingest"];
  const at = ingest?.at ? Date.parse(ingest.at) : NaN;
  const last = await lastMessageMinutes(rows.filter((r) => r.set).map((r) => r.id));
  return {
    api: { reachable: !!snap, loaded: snap?.state?.loaded === true },
    ingest: {
      reportedMinutesAgo: Number.isNaN(at) ? null : Math.max(0, Math.floor((now - at) / 60_000)),
      loaded: ingest?.state ? ingest.state.loaded === true : null,
    },
    platforms: rows.map((r) => ({ id: r.id, label: r.label, set: r.set, connected: null, lastMessageMinutes: last.get(r.id) ?? null })),
  };
}

/** How many alert topics stream-api holds — it reports each one as set (`…abcd`) or not, never the address. */
function alertFacts(snap: Snapshot | null): SiteFacts["alerts"] {
  if (!snap?.self) return null;
  const set = (k: string) => { const d = snap.self?.[k]?.display; return d !== null && d !== undefined && d !== ""; };
  return { topics: (set("ntfy.wakeUrl") ? 1 : 0) + (set("ntfy.quietUrl") ? 1 : 0) };
}

async function moduleFacts(snap: Snapshot | null): Promise<SiteFacts["modules"]> {
  // An owner-only module this install has no plugin for is not part of it.
  return Promise.all(MODULES.filter((m) => keyInstalled(`modules.${m.id}`)).map(async (m) => {
    const key = `modules.${m.id}`;
    const seen = snap?.self?.[key];
    const on = seen ? seen.display === true : instanceBool(key);
    // A step a public install never shows (ownerOnly) is never tested there either.
    const owner = ownerPluginInstalled();
    const steps = (("setup" in m && Array.isArray(m.setup) ? m.setup : []) as { id: string; test: string | null; ownerOnly?: boolean }[])
      .filter((s) => owner || s.ownerOnly !== true);
    const tests: ModuleTest[] = [];
    if (on) for (const s of steps) if (s.test) tests.push({ step: s.id, ...(await runTest(s.test, snap)) });
    return { id: m.id, on, servesMedia: "servesMedia" in m && m.servesMedia === true, owner: m.kind === "owner", tests };
  }));
}

async function doorFacts(): Promise<SiteFacts["door"]> {
  const api = noSlash(installValue("site.apiOrigin"));
  if (!api) return { apiCloudflare: null };
  try {
    const res = await fetch(`${api}/stream/current`, { cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.body?.cancel().catch(() => {});
    return { apiCloudflare: res.headers.has("cf-ray") };
  } catch {
    return { apiCloudflare: null };
  }
}

async function platformKeyFacts(): Promise<SiteFacts["platform"]> {
  const raw = installValue("site.legacyId").trim();
  const legacyId = !raw ? "unset" : legacyNativePlatform() ? "set" : "ignored";
  try {
    const { rows } = await pool.query<{ older: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM site.users u JOIN public.schema_migrations m ON m.version = 145
                       WHERE u.created_at < m.applied_at) AS older`);
    return { legacyId, olderAccounts: rows[0]?.older ?? null };
  } catch {
    return { legacyId, olderAccounts: null };
  }
}

export async function gatherSiteFacts(): Promise<SiteFacts> {
  const snap = await readSnapshot();
  const setUp = platformsSetUp();
  const [db, matrix, token, modules, payments, platforms, platform, door, services] = await Promise.all([dbFacts(), matrixFacts(), tokenFact(), moduleFacts(snap), paymentFacts(), platformFacts(setUp), platformKeyFacts(), doorFacts(), serviceFacts(snap, setUp)]);
  const secrets = snap?.secrets ? Object.values(snap.secrets) : null;
  const state = instanceResolve("setup.state").value as { skipped?: unknown } | null;
  return {
    v: 1,
    at: new Date().toISOString(),
    bundle: hostRequestsAvailable(),
    db,
    matrix,
    secrets: {
      missing: siteSecretsMissing(),
      token,
      stored: secrets ? { total: secrets.length, unreadable: secrets.filter((s) => !s.readable).length } : null,
    },
    modules,
    door,
    heldOn: instanceHeldOn(),
    payments,
    platforms,
    platform,
    services,
    alerts: alertFacts(snap),
    skipped: Array.isArray(state?.skipped) ? state.skipped.filter((x): x is string => typeof x === "string" && /^[a-z0-9:-]{1,64}$/.test(x)) : [],
  };
}
