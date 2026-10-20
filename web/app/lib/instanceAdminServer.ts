// The instance key cards' server side — SERVER ONLY. Every /api/admin/instance route goes
// through here.
//
// The rules this file exists to hold:
//   • AUTHORIZATION ON THE SERVER, every route: signed in (401) AND site.users.is_admin (403).
//     The page hiding its link from non-admins is a courtesy, not the guard.
//   • A mutation must come from this site's own pages: Sec-Fetch-Site: same-origin, or an
//     Origin equal to the site's origin. Neither header (or a foreign one) = refused. Defence in
//     depth on top of the SameSite=Lax session cookie.
//   • NO SECRET VALUE EVER LEAVES. The view is built from status alone — sources, the winning
//     env NAME, `…abcd`, check results as fixed codes — never from /config/secrets. Values are
//     write-only: the browser sends one, nothing sends one back.

import { adminSetupGuides } from "./setup/setupGuides";
import { hostRequestsAvailable, hostResult } from "./hostRequests";
import { ownerPluginInstalled } from "./plugins/installed";
import { SETUP_GUIDES } from "./setup/setupGuideMap";
import { auth } from "@/auth";
import pool from "@/lib/db";
import { streamApiFetch } from "./streamApi";
import { instanceResolve, lastFour } from "./instanceConfigServer";
import { INSTANCE_KEYS, instanceEntry, normalizeCheckResult, describeCheck, runProviderCheck, parseInstanceValue } from "./instanceSchema.generated.mjs";
import { sameOriginRequest, buildInstanceView, type InstanceView, type StreamApiSnapshot } from "./instanceAdminView";
import { buildAiView, type AiView, type AiRoutesSnapshot, type ContentSnapshot } from "./aiAdminView";

/** The signed-in admin's Matrix id, or the Response to return. */
export async function requireAdminResponse(): Promise<string | Response> {
  const session = await auth().catch(() => null);
  const id = session?.user?.id;
  if (!id) return Response.json({ error: "sign in first" }, { status: 401 });
  const { rows } = await pool
    .query<{ is_admin: boolean }>("SELECT is_admin FROM site.users WHERE matrix_id = $1", [id])
    .catch(() => ({ rows: [] as { is_admin: boolean }[] }));
  if (!rows[0]?.is_admin) return Response.json({ error: "admins only" }, { status: 403 });
  return id;
}

/** The view, with stream-api's snapshot fetched (null when stream-api is unreachable — the page
 *  then says so instead of showing web's half as the whole). */
export async function loadInstanceView(): Promise<InstanceView> {
  let snap: StreamApiSnapshot | null = null;
  let speak: InstanceView["botSpeakOn"] = null;
  try {
    const [res, routes] = await Promise.all([
      streamApiFetch("/config", { cache: "no-store" }),
      streamApiFetch("/ai/routes", { cache: "no-store" }).catch(() => null),
    ]);
    if (res.ok) snap = (await res.json()) as StreamApiSnapshot;
    if (routes?.ok) {
      const so = ((await routes.json().catch(() => null)) as AiRoutesSnapshot | null)?.bot?.speakOn;
      if (so) speak = { site: so.site === true, twitch: typeof so.twitch === "string" ? so.twitch : null };
    }
  } catch { /* unreachable: shown as such */ }
  const bundle = hostRequestsAvailable();
  return {
    ...buildInstanceView(snap, speak), guides: adminSetupGuides(SETUP_GUIDES.map((g) => g.list)),
    canRestart: bundle, bundle, render: bundle ? await hostResult("render") : null, ownerPlugin: ownerPluginInstalled(),
  };
}

/** The AI page's view: the settings layer plus stream-api's AI routing view. Either half may be
 *  missing (unreachable), and the view says which — never a guess in its place. */
export async function loadAiView(): Promise<AiView> {
  const read = async <T,>(path: string): Promise<T | null> => {
    try {
      const res = await streamApiFetch(path, { cache: "no-store" });
      return res.ok ? ((await res.json()) as T) : null;
    } catch { return null; }
  };
  const [cfg, routes, content] = await Promise.all([
    read<StreamApiSnapshot>("/config"), read<AiRoutesSnapshot>("/ai/routes"), read<ContentSnapshot>("/content"),
  ]);
  return buildAiView(cfg, routes, content);
}

const CONTENT_KEY = /^(prompt\.[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+){0,3}|bot\.behavior|helpdesk\.facts)$/;

/** Write (body) or revert (null) one content row through stream-api, the one writer — which
 *  validates it (a known task, the size bounds, the behavior file's shape). Status only back. */
export async function writeContent(key: string, body: string | null, updatedBy: string): Promise<{ status: number; body: unknown }> {
  if (!CONTENT_KEY.test(key)) return { status: 404, body: { error: "unknown content key" } };
  if (body !== null && (typeof body !== "string" || body.length > 32768)) return { status: 400, body: { error: "text, at most 32768 characters" } };
  try {
    const res = await streamApiFetch(`/content/${encodeURIComponent(key)}`, {
      method: body === null ? "DELETE" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body === null ? { updatedBy } : { body, updatedBy }),
    });
    const j = (await res.json().catch(() => ({}))) as { error?: string; removed?: boolean };
    return { status: res.status, body: res.ok ? { ok: true, ...(typeof j.removed === "boolean" ? { removed: j.removed } : {}) } : { error: j.error ?? `stream-api answered ${res.status}` } };
  } catch {
    return { status: 502, body: { error: "stream-api unreachable" } };
  }
}

/** The AI page's Detect (a connection's models) or Test (one slot's route), run by stream-api
 *  where the keys are. The answer is stream-api's fixed shape — a code, model ids, a latency —
 *  re-reduced here so nothing else can pass through to the browser. */
export async function runAiCheck(op: "detect" | "test", id: string): Promise<{ status: number; body: unknown }> {
  if (!/^[a-z][a-zA-Z0-9.-]{0,63}$/.test(id)) return { status: 400, body: { error: "bad id" } };
  const path = op === "detect" ? `/ai/detect/${encodeURIComponent(id)}` : `/ai/test/${encodeURIComponent(id)}`;
  try {
    const res = await streamApiFetch(path, { method: "POST" }, 30_000);
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { status: res.status, body: { error: typeof j.error === "string" ? j.error.slice(0, 200) : `stream-api answered ${res.status}` } };
    const body: Record<string, unknown> = {
      package: j.package === "stream-ingest" ? "stream-ingest" : "stream-api",
      ok: j.ok === true, code: typeof j.code === "string" && /^[a-z_]{1,40}$/.test(j.code) ? j.code : "bad_response",
    };
    if (j.unanswered === true) body.unanswered = true;
    if (Number.isInteger(j.latencyMs)) body.latencyMs = j.latencyMs;
    if (Number.isInteger(j.dim)) body.dim = j.dim;
    if (Array.isArray(j.models)) body.models = j.models.filter((m): m is string => typeof m === "string" && /^[\w.:/@-]{1,128}$/.test(m)).slice(0, 500);
    return { status: 200, body };
  } catch {
    return { status: 502, body: { error: "stream-api unreachable" } };
  }
}

/** requireAdminResponse + sameOriginRequest, for the mutating routes. */
export async function requireAdminMutation(req: Request): Promise<string | Response> {
  if (!sameOriginRequest(req.headers)) return Response.json({ error: "cross-site request refused" }, { status: 403 });
  return requireAdminResponse();
}

const lastWebTest = new Map<string, number>();
const WEB_TEST_COOLDOWN_MS = 5_000;

/**
 * Run a credential's check in every process that holds it: web here (its own resolved value),
 * then stream-api (in-process + stream-ingest over its internal socket). Web's result is stored
 * through stream-api's /config/report as a fixed-shape result — never text.
 */
export async function runInstanceTest(key: string): Promise<{ status: number; body: unknown }> {
  const e = INSTANCE_KEYS.find((k) => k.key === key);
  if (!e || !(e.secret || e.test)) return { status: 404, body: { error: "unknown credential" } };
  if (!e.test) return { status: 400, body: { error: "no test available for this credential" } };
  const now = Date.now();
  if (now - (lastWebTest.get(key) ?? 0) < WEB_TEST_COOLDOWN_MS) return { status: 429, body: { error: "tested a moment ago — wait a few seconds" } };
  lastWebTest.set(key, now);
  const results: { package: string; ok: boolean; detail: string }[] = [];
  // A plain setting with a check of its own (the Streamplace account) is checked
  // here only, where the setup page is, and nothing is stored: stream-api keeps test results for
  // credentials alone.
  if (!e.secret) {
    const result = normalizeCheckResult((await runProviderCheck(e.test, (k: string) => instanceResolve(k).value, fetch)) ?? { ok: false, code: "no_check" });
    return { status: 200, body: { ok: true, key, results: [{ package: "web", ok: result.ok, detail: describeCheck(result) }] } };
  }
  if (e.packages.includes("web")) {
    const get = (k: string) => instanceResolve(k).value;
    const raw = await runProviderCheck(e.test, get, fetch);
    const result = normalizeCheckResult(raw ?? { ok: false, code: "no_check" });
    const r = instanceResolve(key);
    results.push({ package: "web", ok: result.ok, detail: describeCheck(result) });
    await streamApiFetch("/config/report", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package: "web", tests: [{ key, result, source: r.source, last4: lastFour(r.value) || null }] }),
    }).catch(() => undefined);
  }
  if (e.packages.some((p) => p !== "web")) {
    try {
      const res = await streamApiFetch(`/config/test/${encodeURIComponent(key)}`, { method: "POST" }, 25_000);
      const body = (await res.json().catch(() => ({}))) as { results?: { package: string; ok: boolean; detail: string }[]; error?: string };
      if (res.ok && Array.isArray(body.results)) {
        for (const x of body.results) results.push({ package: x.package, ok: !!x.ok, detail: String(x.detail ?? "") });
      } else {
        results.push({ package: "stream-api", ok: false, detail: body.error ? `stream-api: ${body.error}` : `stream-api answered ${res.status}` });
      }
    } catch {
      results.push({ package: "stream-api", ok: false, detail: "stream-api unreachable" });
    }
  }
  return { status: 200, body: { ok: true, key, results } };
}

/** Validate here first (a 400 with the schema's words), then write through stream-api — the
 *  one writer. The response carries status, never the value. */
export async function writeInstanceValue(key: string, value: unknown, updatedBy: string): Promise<{ status: number; body: unknown }> {
  // instanceEntry: a fixed key, or a pattern's concrete key (an AI connection's own key).
  const e = instanceEntry(key);
  if (!e) return { status: 404, body: { error: "unknown key" } };
  if (e.tier === "install") return { status: 400, body: { error: "install-tier: set in the site's environment (on a bundle: blackbranch set), then restart web" } };
  const parsed = parseInstanceValue(e, value);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  return forward(`/config/${encodeURIComponent(key)}`, "PUT", { value: parsed.value, updatedBy });
}

export async function clearInstanceValue(key: string, updatedBy: string): Promise<{ status: number; body: unknown }> {
  const e = instanceEntry(key);
  if (!e) return { status: 404, body: { error: "unknown key" } };
  if (e.tier === "install") return { status: 400, body: { error: "install-tier: set in the site's environment (on a bundle: blackbranch set), then restart web" } };
  return forward(`/config/${encodeURIComponent(key)}`, "DELETE", { updatedBy });
}

async function forward(path: string, method: "PUT" | "DELETE", body: unknown): Promise<{ status: number; body: unknown }> {
  try {
    const res = await streamApiFetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    // Status only: stream-api's own body says ok/removed/error and a `…abcd` at most.
    return { status: res.status, body: res.ok ? { ok: true } : { error: j.error ?? `stream-api answered ${res.status}` } };
  } catch {
    return { status: 502, body: { error: "stream-api unreachable" } };
  }
}

/** The memory panel's three flows (Turn on, Start fresh, Resume), run by stream-api — the one
 *  writer of the store and of memory.state. The admin's id rides as `actor` (stream-api logs and
 *  audits it). The answer is stream-api's own fixed shape: codes, counts, a date, a dimension. */
export async function runMemoryAction(action: string, body: { connection?: unknown; model?: unknown; confirm?: unknown }, actor: string): Promise<{ status: number; body: unknown }> {
  const path = action === "enable" ? "/memory/enable" : action === "start-fresh" ? "/memory/start-fresh" : action === "resume" ? "/memory/resume" : null;
  if (!path) return { status: 404, body: { error: "unknown memory action" } };
  const payload: Record<string, unknown> = { actor };
  if (action !== "resume") {
    if (typeof body.connection !== "string" || !/^[a-z0-9-]{1,24}$/.test(body.connection)) return { status: 400, body: { error: "choose a connection" } };
    if (typeof body.model !== "string" || !/^[\w.:/@-]{1,128}$/.test(body.model)) return { status: 400, body: { error: "type or detect a model id" } };
    payload.connection = body.connection; payload.model = body.model;
    if (action === "start-fresh" && Number.isInteger(body.confirm)) payload.confirm = body.confirm;
  }
  try {
    const res = await streamApiFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, action === "start-fresh" ? 60_000 : 40_000);
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of ["ok", "error", "code", "dim", "reduced", "retyped", "cleared", "count", "oldest", "needConfirm", "needsStartFresh", "lockedBy", "already", "status", "rows"]) {
      const v = j[k];
      if (typeof v === "string") out[k] = v.slice(0, 300);
      else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    }
    return { status: res.status, body: out };
  } catch {
    return { status: 502, body: { error: "stream-api unreachable" } };
  }
}
