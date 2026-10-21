"use client";

// The Admin Panel's AI section: which connection and model every AI task runs on, in each
// service, whether it is working, what it did today, and the memory store — split into the
// sub-tabs of adminLayout.ts (AI_SUBS).
//
// Status only. A connection's key shows as set / `…abcd` / not set — the view this renders is
// built without any credential value (aiAdminView.ts). A key typed here travels browser → server
// once and the input is cleared; nothing is read back into it. Every route behind this checks
// is_admin itself; this component being admin-only is not the guard.
//
// Edits go through the same write path as the key cards (PUT /api/admin/instance/<key>);
// stream-api, the one writer, decides what an edit MEANS — an unknown task or connection, a
// connection still in use, a task the connection cannot do — and answers with the reason.

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { getJson, postJson } from "@/app/lib/http";
import type { AiView, AiTask, AiCustomConnection, RouteSummary, SlotHealth } from "@/app/lib/aiAdminView";
import type { InstanceView } from "@/app/lib/instanceAdminView";
import { Toggle, Choice } from "@/app/components/SettingsControls";
import { card, h2, h3, btn, input, chip, ago } from "./parts";
import { aiSubOf, keyGroupsFor, serviceName, type AiSub } from "./adminLayout";
import KeyCards from "./KeyCards";
import HelpdeskPicture, { botMatrixId } from "./HelpdeskPicture";
import { parseBotBehavior, renderBotBehavior } from "@/app/lib/instanceSchema.generated.mjs";

type Ctx = {
  view: AiView;
  note: (m: string) => void;
  reload: () => void;
  models: Record<string, string[]>;
  detect: (connection: string) => Promise<void>;
};
const PanelCtx = createContext<Ctx | null>(null);
function usePanel(): Ctx {
  const c = useContext(PanelCtx);
  if (!c) throw new Error("AiPanel context missing");
  return c;
}

/** Save (value) or clear (undefined) one settings key through the admin route. Resolves the
 *  error text, or null when it was saved. */
async function saveKey(key: string, value: unknown): Promise<string | null> {
  try {
    const res = value === undefined
      ? await postJson(`/api/admin/instance/${encodeURIComponent(key)}`, undefined, "DELETE")
      : await postJson(`/api/admin/instance/${encodeURIComponent(key)}`, { value }, "PUT");
    if (res.ok) return null;
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    return j.error ?? `not saved (HTTP ${res.status})`;
  } catch { return "not saved (network)"; }
}

type CheckAnswer = { package?: string; ok?: boolean; code?: string; latencyMs?: number; dim?: number; models?: string[]; unanswered?: boolean; error?: string };
async function runCheck(op: "detect" | "test", id: string): Promise<CheckAnswer> {
  try {
    const res = await postJson(`/api/admin/ai/${op}/${encodeURIComponent(id)}`, undefined, "POST", { timeoutMs: 35_000 });
    const j = (await res.json().catch(() => ({}))) as CheckAnswer;
    return res.ok ? j : { error: j.error ?? `HTTP ${res.status}` };
  } catch { return { error: "network" }; }
}

type Slot = AiView["slots"][number];
type Conn = AiView["connections"][number];

const REASON: Record<string, string> = {
  off: "off",
  not_configured: "no model set",
  needs_unmet: "this connection cannot do this task",
  unknown_slot: "not running in this service",
};
const SOURCE: Record<string, string> = { env: "set on the server", db: "saved here", default: "default" };
const CODE: Record<string, string> = {
  key_rejected: "key rejected — check the key", key_missing: "no key set", quota: "provider says the account is out of credit",
  model_not_found: "model not found at this endpoint", rate_limited: "rate limited", server_error: "provider error",
  timeout: "timed out", network: "network error", bad_response: "unreadable answer (or a redirect)", bad_request: "request refused",
  unsupported: "not supported by this endpoint", http_error: "HTTP error",
};

function routeText(r: RouteSummary | null): string {
  if (!r) return "not reporting";
  if (!r.enabled) return REASON[r.reason] ?? r.reason;
  return `${r.connection} · ${r.model}`;
}

function HealthChip({ h }: { h: SlotHealth | null }) {
  if (!h || h.status === "ok") return null;
  const failing = h.status === "failing";
  return (
    <span className={`${chip} ${failing ? "text-red-300" : "text-amber-300"}`}>
      {failing ? `failing since ${ago(h.failingSince)}` : `${h.consecutive} recent failure${h.consecutive === 1 ? "" : "s"}`}
      {h.lastCode && <span>· {CODE[h.lastCode] ?? h.lastCode}</span>}
    </span>
  );
}

const SLUG = /^[a-z0-9-]{1,24}$/;

/** A connection + model picker: the connection list, and a model box fed by Detect (free text
 *  allowed — a server may serve a model it does not list). */
function RoutePicker({ connection, model, onChange, allowDefault, label, embedOnly }: {
  connection: string; model: string; onChange: (c: string, m: string) => void; allowDefault?: boolean; label: string; embedOnly?: boolean;
}) {
  const { view, models, detect } = usePanel();
  const listId = `models-${label.replace(/[^a-z0-9]/gi, "-")}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select className={`${input} basis-36 flex-none`} value={connection} onChange={(e) => onChange(e.target.value, model)} aria-label={`Connection for ${label}`}>
        {allowDefault && <option value="">default model</option>}
        {!allowDefault && <option value="">choose a connection…</option>}
        {view.connections.filter((c) => !embedOnly || c.kind === "openai-compatible").map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>
      {connection && (
        <>
          <input className={input} list={listId} value={model} onChange={(e) => onChange(connection, e.target.value.trim())}
            placeholder="model id" spellCheck={false} autoComplete="off" aria-label={`Model for ${label}`} />
          <datalist id={listId}>{(models[connection] ?? []).map((m) => <option key={m} value={m} />)}</datalist>
          <button type="button" className={btn} onClick={() => void detect(connection)}>Detect</button>
        </>
      )}
    </div>
  );
}

function ConnectionEditor({ c }: { c: Conn }) {
  const { view, note, reload } = usePanel();
  const [label, setLabel] = useState(c.label);
  const [baseUrl, setBaseUrl] = useState(c.baseUrl);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const custom = view.connections.filter((x) => !x.builtin).map((x) => ({ id: x.id, kind: "openai-compatible" as const, label: x.label, baseUrl: x.baseUrl }));
  const moved = (() => { try { return new URL(baseUrl).origin !== new URL(c.baseUrl).origin; } catch { return false; } })();

  async function save() {
    setBusy(true);
    const next = custom.map((x) => (x.id === c.id ? { ...x, label: label.trim(), baseUrl: baseUrl.trim() } : x));
    const err = await saveKey("ai.connections", next);
    note(err ? `${c.label}: ${err}` : `${c.label}: saved${moved && c.key.stored ? " — its saved key was cleared (new address)" : ""}.`);
    setBusy(false);
    if (!err) reload();
  }
  async function remove() {
    if (!window.confirm(`Remove the connection "${c.label}"? Its saved key is deleted with it.`)) return;
    setBusy(true);
    const err = await saveKey("ai.connections", custom.filter((x) => x.id !== c.id));
    note(err ? `${c.label}: ${err}` : `${c.label}: removed.`);
    setBusy(false);
    if (!err) reload();
  }
  async function saveSecret(clear: boolean) {
    setBusy(true);
    const err = await saveKey(c.keyName, clear ? undefined : key.trim());
    if (!err) setKey("");
    note(err ? `${c.label} key: ${err}` : `${c.label} key: ${clear ? "removed" : "saved"}.`);
    setBusy(false);
    if (!err) reload();
  }

  return (
    <div className="mt-2 space-y-2">
      <form className="flex flex-wrap items-center gap-2" onSubmit={(ev) => { ev.preventDefault(); void save(); }}>
        <input className={`${input} basis-32`} value={label} onChange={(e) => setLabel(e.target.value)} aria-label={`Label for ${c.id}`} placeholder="label" />
        <input className={input} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} aria-label={`Address for ${c.id}`} placeholder="https://…/v1" spellCheck={false} />
        <span className="flex gap-2">
          <button type="submit" className={btn} disabled={busy || (label.trim() === c.label && baseUrl.trim() === c.baseUrl)}>Save</button>
          <button type="button" className={btn} disabled={busy} onClick={remove}>Remove</button>
        </span>
      </form>
      {moved && c.key.stored && <p className="text-xs text-amber-300">A new address clears the saved key: a key is only ever sent to the address it was saved for.</p>}
      <form className="flex flex-wrap items-center gap-2" onSubmit={(ev) => { ev.preventDefault(); if (key.trim()) void saveSecret(false); }}>
        <input className={input} type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)}
          placeholder={c.key.stored ? `saved ${c.key.stored.display} — type to replace` : "key (optional for a local server) — never shown again"}
          aria-label={`Key for ${c.label}`} />
        <button type="submit" className={btn} disabled={busy || !key.trim()}>Save key</button>
        {c.key.stored && <button type="button" className={btn} disabled={busy} onClick={() => void saveSecret(true)}>Clear key</button>}
      </form>
    </div>
  );
}

function AddConnection() {
  const { view, note, reload } = usePanel();
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  if (!open) return <button type="button" className={`${btn} mt-3`} onClick={() => setOpen(true)}>Add connection</button>;
  const custom: AiCustomConnection[] = view.connections.filter((x) => !x.builtin).map((x) => ({ id: x.id, kind: "openai-compatible", label: x.label, baseUrl: x.baseUrl }));
  async function add() {
    setBusy(true);
    const err = await saveKey("ai.connections", [...custom, { id, kind: "openai-compatible", label: label.trim(), baseUrl: baseUrl.trim() }]);
    let keyErr: string | null = null;
    if (!err && key.trim()) keyErr = await saveKey(`ai.connection.${id}.apiKey`, key.trim());
    setKey("");
    setBusy(false);
    if (err) { note(`New connection: ${err}`); return; }
    note(keyErr ? `${label}: added, but the key was not saved: ${keyErr}` : `${label}: added.`);
    setOpen(false); setId(""); setLabel(""); setBaseUrl("");
    reload();
  }
  return (
    <form className="mt-3 space-y-2 rounded-lg border border-edge p-3" onSubmit={(ev) => { ev.preventDefault(); void add(); }} aria-label="Add a connection">
      <p className="text-xs text-secondary">An OpenAI-compatible endpoint: OpenAI, OpenRouter, a local Ollama / LM Studio / vLLM / llama.cpp server. Use the address that ends where <span className="font-mono">/models</span> and <span className="font-mono">/chat/completions</span> begin (often <span className="font-mono">…/v1</span>).</p>
      <div className="flex flex-wrap gap-2">
        <input className={`${input} basis-28`} value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="id (a-z 0-9 -)" aria-label="Connection id" spellCheck={false} />
        <input className={`${input} basis-32`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label" aria-label="Connection label" />
      </div>
      <input className={`${input} w-full`} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://10.0.0.5:11434/v1" aria-label="Connection address" spellCheck={false} />
      <input className={`${input} w-full`} type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder="key (optional) — never shown again" aria-label="Connection key" />
      <div className="flex gap-2">
        <button type="submit" className={btn} disabled={busy || !SLUG.test(id) || !label.trim() || !baseUrl.trim()}>Add</button>
        <button type="button" className={btn} disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

const kindWord = (kind: string) => (kind === "anthropic" ? "Anthropic" : "OpenAI-compatible");

function ConnectionRow({ c }: { c: Conn }) {
  const { models, detect } = usePanel();
  const [busy, setBusy] = useState(false);
  const found = models[c.id];
  return (
    <li className="border-t border-edge pt-3 first:border-t-0 first:pt-0" data-connection={c.id}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-sm font-medium text-body">{c.label}</span>
        {/* The id and the kind only when they add something to the name ("Anthropic anthropic ·
            Anthropic" said one thing three times). */}
        {c.id.toLowerCase() !== c.label.toLowerCase() && <span className="font-mono text-2xs text-muted">{c.id}</span>}
        <span className="text-2xs text-muted">{[kindWord(c.kind) !== c.label ? kindWord(c.kind) : null, c.builtin ? "built in" : null].filter(Boolean).join(" · ")}</span>
      </div>
      <p className="mt-0.5 font-mono text-xs text-secondary break-all">{c.baseUrl}</p>
      <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Key, per service">
        {c.key.packages.length === 0 && (
          <li className={`${chip} ${c.key.stored ? "text-secondary" : "text-muted"}`}>
            key {c.key.stored ? `saved ${c.key.stored.display}` : "not set"}
          </li>
        )}
        {c.key.packages.map((p) => (
          <li key={p.package} className={`${chip} ${p.error ? "text-red-300" : p.source === "unset" ? "text-muted" : "text-secondary"}`}>
            <span className="font-medium text-body">{serviceName(p.package)}</span>
            {!p.known ? "not reporting" : p.source === "unset" ? "no key" : (
              <>key {p.source === "env" ? `set on the server (${p.envName})` : "saved here"} {p.display && <span className="font-mono">{p.display}</span>}</>
            )}
            {p.error && <span>· {p.error}</span>}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className={btn} disabled={busy} onClick={() => { setBusy(true); void detect(c.id).finally(() => setBusy(false)); }}>Detect models</button>
        {found && <span className="text-2xs text-muted">{found.length} model{found.length === 1 ? "" : "s"} found — offered in the model boxes below</span>}
        {c.builtin && <span className="text-2xs text-muted">Key: under Built-in connection keys below.</span>}
      </div>
      {!c.builtin && <ConnectionEditor c={c} />}
    </li>
  );
}

/** One task's editor: on/off, and in Advanced mode its own connection, model and token cap. */
function TaskEditor({ s }: { s: Slot }) {
  const { view, note, reload } = usePanel();
  const t: AiTask = s.task ?? {};
  const productOn = t.enabled === true;
  const on = s.group === "product" ? productOn : t.enabled !== false;
  const [conn, setConn] = useState(t.connection ?? "");
  const [model, setModel] = useState(t.model ?? "");
  const [maxTokens, setMaxTokens] = useState(t.maxTokens ? String(t.maxTokens) : "");
  const [busy, setBusy] = useState(false);
  const advanced = view.mode.value === "advanced";

  async function write(next: AiTask | null) {
    setBusy(true);
    const all: Record<string, AiTask> = {};
    for (const x of view.slots) if (x.task) all[x.id] = x.task;
    if (next && Object.keys(next).length) all[s.id] = next; else delete all[s.id];
    const err = await saveKey("ai.tasks", all);
    note(err ? `${s.label}: ${err}` : `${s.label}: saved.`);
    setBusy(false);
    if (!err) reload();
  }
  const base = (): AiTask => {
    const n: AiTask = {};
    if (t.enabled !== undefined) n.enabled = t.enabled;
    if (t.connection && t.model) { n.connection = t.connection; n.model = t.model; }
    if (t.maxTokens) n.maxTokens = t.maxTokens;
    return n;
  };
  function toggle() {
    const n = base();
    if (s.group === "product") n.enabled = !productOn;
    else if (on) n.enabled = false; else delete n.enabled;
    void write(n);
  }
  function saveRoute() {
    const n = base();
    delete n.connection; delete n.model; delete n.maxTokens;
    if (conn && model) { n.connection = conn; n.model = model; }
    const mt = Number(maxTokens);
    if (maxTokens.trim() && Number.isInteger(mt) && mt > 0) n.maxTokens = mt;
    void write(n);
  }
  const dirty = conn !== (t.connection ?? "") || model !== (t.model ?? "") || maxTokens !== (t.maxTokens ? String(t.maxTokens) : "");

  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-center gap-2 text-xs text-body">
        <Toggle on={on} onToggle={toggle} disabled={busy} label={`${s.label}: on`} />
        <span>{on ? "On" : "Off"}</span>
        <span className="min-w-0 text-muted">{s.group === "product" ? "— a product task is off until switched on" : "— switching a plugin task off stops that part of the plugin"}</span>
      </div>
      {advanced ? (
        <form className="space-y-2" onSubmit={(ev) => { ev.preventDefault(); saveRoute(); }}>
          <RoutePicker label={s.id} connection={conn} model={model} allowDefault onChange={(c, m) => { setConn(c); setModel(c ? m : ""); }} />
          <div className="flex flex-wrap items-center gap-2">
            <input className={`${input} basis-28 flex-none`} inputMode="numeric" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value.replace(/\D/g, ""))} placeholder="max tokens (default)" aria-label={`Max tokens for ${s.label}`} />
            <button type="submit" className={btn} disabled={busy || !dirty || (!!conn && !model)}>Save</button>
          </div>
        </form>
      ) : (
        <p className="text-2xs text-muted">Simple mode: runs on the default model{t.connection ? ` (its own ${t.connection} · ${t.model} is kept for Advanced mode)` : ""}{!view.defaultRoute && s.group === "plugin" ? ", or the plugin's own default while none is set" : ""}.</p>
      )}
    </div>
  );
}

function SlotRow({ s }: { s: Slot }) {
  const { view, note } = usePanel();
  const [busy, setBusy] = useState(false);
  const u = s.usage;
  const editable = s.kind === "chat" && !s.envPinned && !s.lockedBy;
  async function test() {
    setBusy(true);
    const r = await runCheck("test", s.id);
    setBusy(false);
    if (r.error) { note(`${s.label}: test failed — ${r.error}`); return; }
    const where = r.package ? ` (${serviceName(r.package)})` : "";
    const budget = Number(view.automod["automod.holdBudgetMs"]?.value) || 1200;
    const slow = s.id === "automod.classify" && r.ok && typeof r.latencyMs === "number" && r.latencyMs > budget / 2
      ? ` — too slow to hold messages reliably (the budget is ${budget} ms; over half of it per check means many go unchecked)` : "";
    note(`${s.label}${where}: ${r.ok ? `answered in ${r.latencyMs ?? "?"} ms${r.dim ? ` · ${r.dim} dims` : ""}${slow}` : r.unanswered ? "the service did not answer in time" : CODE[r.code ?? ""] ?? REASON[r.code ?? ""] ?? r.code}`);
  }
  return (
    <li className="border-t border-edge pt-3 first:border-t-0 first:pt-0" data-slot={s.id}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-sm font-medium text-body">{s.label}</span>
        <span className="font-mono text-2xs text-muted break-all">{s.id}</span>
        {!s.running && <span className="text-2xs text-amber-300">· not running (no report for 10 min)</span>}
      </div>
      <p className="mt-0.5 text-xs text-secondary">{s.description}</p>
      <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="What it runs on, per service">
        {s.routes.map((r) => (
          <li key={r.package} className={`${chip} min-w-0 max-w-full flex-wrap ${r.route?.enabled ? "text-secondary" : "text-muted"}`}>
            <span className="font-medium text-body">{serviceName(r.package)}</span>
            <span className={r.route?.enabled ? "min-w-0 font-mono text-body-dim break-all" : ""}>{routeText(r.route)}</span>
            {r.route?.enabled && (
              <span>({SOURCE[r.route.source] ?? r.route.source}{r.route.source === "env" && r.route.envName ? `: ${r.route.envName}` : ""})</span>
            )}
          </li>
        ))}
        {s.routes.map((r) => <HealthChip key={`h-${r.package}`} h={r.health} />)}
      </ul>
      {s.envPinned && (
        <p className="mt-1 text-xs text-muted">Set on the server (<span className="font-mono">{s.envPinned}</span>) — change it there, or remove that setting to manage it here.</p>
      )}
      {s.lockedBy && <p className="mt-1 text-xs text-muted">Locked: {s.lockedBy}</p>}
      {s.kind === "embed" && !s.lockedBy && <p className="mt-1 text-xs text-muted">The embedder is chosen under Memory below (it turns memory on with a probe), not here.</p>}
      {editable && <TaskEditor s={s} />}
      <div className="mt-2"><button type="button" className={btn} disabled={busy} onClick={test}>Test</button></div>
      <p className="mt-1 text-2xs text-muted">
        Today: {u ? `${u.calls} call${u.calls === 1 ? "" : "s"} · ${u.errors} error${u.errors === 1 ? "" : "s"}${u.unchecked ? ` · ${u.unchecked} unchecked` : ""} · ${u.tokensIn.toLocaleString()} in / ${u.tokensOut.toLocaleString()} out tokens` : "no calls"}
      </p>
    </li>
  );
}

type MemoryAnswer = { ok?: boolean; error?: string; code?: string; dim?: number; reduced?: boolean; retyped?: boolean; cleared?: number; count?: number; oldest?: string; needConfirm?: boolean; needsStartFresh?: boolean; lockedBy?: string; already?: boolean };
async function memoryAction(action: "enable" | "start-fresh" | "resume", body: Record<string, unknown> = {}): Promise<{ status: number; j: MemoryAnswer }> {
  try {
    const res = await postJson(`/api/admin/ai/memory/${action}`, body, "POST", { timeoutMs: 70_000 });
    return { status: res.status, j: (await res.json().catch(() => ({}))) as MemoryAnswer };
  } catch { return { status: 0, j: { error: "network" } }; }
}

const RETENTION: { value: number | null; key: string; label: string }[] = [
  { value: 30, key: "30", label: "30 days" }, { value: 90, key: "90", label: "90 days" }, { value: 365, key: "365", label: "1 year" }, { value: null, key: "forever", label: "forever" },
];

function MemoryPanel({ m }: { m: AiView["memory"] }) {
  const { view, note, reload } = usePanel();
  const st = m && !("error" in m) ? m.state : null;
  const [conn, setConn] = useState(st?.connection ?? "");
  const [model, setModel] = useState(st?.model ?? "");
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!m) return <p className="text-xs text-muted">The chat service did not report the memory store.</p>;
  if ("error" in m) return <p className="text-xs text-red-300">{m.error}</p>;
  const status = !m.enabled || !st ? "off" : st.status;
  const lockedBy = view.slots.find((x) => x.id === "embeddings")?.lockedBy ?? null;

  const say = (what: string, r: { status: number; j: MemoryAnswer }) => {
    if (r.j.lockedBy) return note(`${what}: locked — ${r.j.lockedBy}`);
    if (!r.j.ok) return note(`${what}: ${r.j.error ?? `HTTP ${r.status}`}${r.j.code && r.j.code !== r.j.error ? ` (${r.j.code})` : ""}`);
  };
  async function turnOn() {
    setBusy(true);
    const r = await memoryAction("enable", { connection: conn, model });
    setBusy(false);
    if (!r.j.ok) return say("Turn on memory", r);
    note(r.j.already ? "Memory is already on with this embedder." : `Memory is on: ${conn} · ${model}, ${r.j.dim} dimensions${r.j.reduced ? " (asked for 1,536)" : ""}${r.j.retyped ? " — the empty store was set to this length" : ""}. New messages are remembered from now; older ones are not.`);
    reload();
  }
  async function startFresh() {
    setBusy(true);
    const ask = await memoryAction("start-fresh", { connection: conn, model });
    if (!ask.j.needConfirm || typeof ask.j.count !== "number") { setBusy(false); return say("Start fresh", ask); }
    const n = ask.j.count;
    const oldest = ask.j.oldest ? ` (oldest from ${new Date(ask.j.oldest).toLocaleDateString()})` : "";
    if (!window.confirm(`This clears all ${n.toLocaleString()} stored memor${n === 1 ? "y" : "ies"}${oldest}. Memory restarts from now with ${model}. This cannot be undone.`)) { setBusy(false); return; }
    note("Starting fresh — memory pauses for about 10 seconds while in-flight messages finish…");
    const r = await memoryAction("start-fresh", { connection: conn, model, confirm: n });
    setBusy(false);
    if (!r.j.ok) return say("Start fresh", r);
    note(`Started fresh: ${r.j.cleared?.toLocaleString() ?? 0} memories cleared; now ${conn} · ${model}, ${r.j.dim} dimensions.`);
    setChanging(false);
    reload();
  }
  async function resume() {
    setBusy(true);
    const r = await memoryAction("resume");
    setBusy(false);
    if (!r.j.ok) return say("Resume (probed the embedder first)", r);
    note("Memory resumed — the embedder answered at the right length.");
    reload();
  }
  async function setRetention(v: number | null) {
    const removes = v === null ? 0 : m && !("error" in m) ? m.olderThan?.[String(v)] ?? null : null;
    if (removes && !window.confirm(`Keep memories for ${v} days? The next daily run deletes ${removes.toLocaleString()} older one${removes === 1 ? "" : "s"}. This cannot be undone.`)) return;
    setBusy(true);
    const err = await saveKey("memory.retentionDays", v);
    setBusy(false);
    note(err ? `Retention: ${err}` : `Retention: ${v === null ? "forever" : `${v} days`}.`);
    if (!err) reload();
  }

  const picker = (
    <RoutePicker label="memory" embedOnly connection={conn} model={model} onChange={(c, mm) => { setConn(c); setModel(c ? mm : ""); }} />
  );
  return (
    <div className="space-y-3">
      {status === "paused" && st && (
        <div role="alert" className="rounded-lg border border-red-400/40 px-3 py-2 text-xs text-red-300">
          Memory is paused{st.pausedReason ? ` — ${st.pausedReason.replace(/_/g, " ")}` : ""}{st.pausedAt ? `, since ${ago(st.pausedAt)}` : ""}. Nothing new is remembered; the bot answers without memory meanwhile.
          <div className="mt-2"><button type="button" className={btn} disabled={busy} onClick={() => void resume()}>Resume</button>
            <span className="ml-2 text-muted">probes the embedder first, and resumes only if it answers at {st.dim} dimensions</span></div>
        </div>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted">Status</dt>
        <dd className={status === "on" ? "text-emerald-400" : status === "paused" ? "text-red-300" : "text-secondary"}>{status}</dd>
        <dt className="text-muted">Embedder</dt>
        <dd className="font-mono text-body-dim break-all">{st ? `${st.connection} · ${st.model} · ${st.dim} dims${st.reduced ? " (reduced)" : ""}` : "—"}</dd>
        <dt className="text-muted">Stored</dt>
        <dd className="text-body-dim">{m.rows.toLocaleString()} message{m.rows === 1 ? "" : "s"}{m.oldest ? `, oldest ${new Date(m.oldest).toLocaleDateString()}` : ""}</dd>
        <dt className="text-muted">Column</dt>
        <dd className="font-mono text-body-dim">{m.columnDim ? `vector(${m.columnDim})` : "unknown"}</dd>
        <dt className="text-muted">Retention</dt>
        <dd className="text-body-dim">{m.retentionDays == null ? "forever" : `${m.retentionDays} days — the next daily run removes ${m.nextPurge.toLocaleString()}`}</dd>
      </dl>
      <fieldset disabled={busy} className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">Keep memories for</span>
        <Choice label="Memory retention" value={RETENTION.find((o) => o.value === (m.retentionDays ?? null))?.key ?? ""}
          options={RETENTION.map((o) => ({ value: o.key, label: o.label }))}
          onChange={(k) => { const o = RETENTION.find((x) => x.key === k); if (o && m.retentionDays !== o.value) void setRetention(o.value); }} />
      </fieldset>
      {lockedBy ? (
        <p className="text-xs text-muted">The embedder is locked: {lockedBy}</p>
      ) : status === "off" ? (
        <form className="space-y-2 rounded-lg border border-edge p-3" onSubmit={(ev) => { ev.preventDefault(); void turnOn(); }} aria-label="Turn on memory">
          <p className="text-xs text-secondary">Pick an OpenAI-compatible connection and an embedding model. One test message is embedded first; its length becomes the store&apos;s. From then on new chat messages are remembered — older ones are not.</p>
          {picker}
          <button type="submit" className={btn} disabled={busy || !conn || !model}>Turn on memory</button>
        </form>
      ) : changing ? (
        <form className="space-y-2 rounded-lg border border-edge p-3" onSubmit={(ev) => { ev.preventDefault(); void startFresh(); }} aria-label="Start fresh">
          <p className="text-xs text-secondary">Vectors from two models cannot be compared, so a new embedder starts with an empty memory. You will be told exactly how many memories are cleared before anything happens.</p>
          {picker}
          <div className="flex gap-2">
            <button type="submit" className={btn} disabled={busy || !conn || !model}>Start fresh…</button>
            <button type="button" className={btn} disabled={busy} onClick={() => setChanging(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <button type="button" className={btn} disabled={busy || status === "switching"} onClick={() => setChanging(true)}>Change embedder…</button>
      )}
    </div>
  );
}

/** Save (string) or revert (null) one content row. Resolves the error text, or null. */
async function saveContent(key: string, body: string | null): Promise<string | null> {
  try {
    const res = await postJson(`/api/admin/ai/content/${encodeURIComponent(key)}`, body === null ? undefined : { body }, body === null ? "DELETE" : "PUT");
    if (res.ok) return null;
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    return j.error ?? `not saved (HTTP ${res.status})`;
  } catch { return "not saved (network)"; }
}

const textarea = "w-full rounded-lg border border-edge bg-surface-1 px-3 py-2 font-mono text-xs leading-5 text-body placeholder:text-faint outline-none focus:border-edge-strong";

/** One content body: the shipped default (or nothing), this install's own text, edit, revert. */
function ContentEditor({ contentKey, label, help, defaultText, own, maxLength }: {
  contentKey: string; label: string; help: string; defaultText: string | null; own: { body: string; updatedBy: string; updatedAt: string } | null; maxLength: number;
}) {
  const { note, reload } = usePanel();
  const [text, setText] = useState(own?.body ?? defaultText ?? "");
  const [busy, setBusy] = useState(false);
  const [showDefault, setShowDefault] = useState(false);
  const dirty = text !== (own?.body ?? defaultText ?? "");
  async function save() {
    setBusy(true);
    const err = await saveContent(contentKey, text);
    note(err ? `${label}: ${err}` : `${label}: saved — used from the next call.`);
    setBusy(false);
    if (!err) reload();
  }
  async function revert() {
    if (!window.confirm(defaultText ? `Go back to the shipped default for ${label}? Your text is kept in the change history.` : `Clear ${label}? It is kept in the change history.`)) return;
    setBusy(true);
    const err = await saveContent(contentKey, null);
    note(err ? `${label}: ${err}` : `${label}: ${defaultText ? "back to the default" : "cleared"}.`);
    setBusy(false);
    if (!err) { setText(defaultText ?? ""); reload(); }
  }
  return (
    <li className="border-t border-edge pt-3 first:border-t-0 first:pt-0" data-content={contentKey}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-sm font-medium text-body">{label}</span>
        <span className={`${chip} ${own ? "text-secondary" : "text-muted"}`}>{own ? `yours · ${ago(own.updatedAt)}` : defaultText ? "default" : "empty"}</span>
      </div>
      <p className="mt-0.5 text-xs text-muted">{help}</p>
      <form className="mt-2 space-y-2" onSubmit={(ev) => { ev.preventDefault(); void save(); }}>
        <textarea className={`${textarea} min-h-40`} value={text} maxLength={maxLength} onChange={(e) => setText(e.target.value)} aria-label={label} spellCheck />
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className={btn} disabled={busy || !dirty || (!!defaultText && !text.trim())}>Save</button>
          {own && <button type="button" className={btn} disabled={busy} onClick={() => void revert()}>{defaultText ? "Revert to default" : "Clear"}</button>}
          {own && defaultText && <button type="button" className={btn} onClick={() => setShowDefault((v) => !v)}>{showDefault ? "Hide default" : "Show default"}</button>}
          <span className="text-2xs text-muted">{text.length.toLocaleString()} / {maxLength.toLocaleString()}</span>
        </div>
      </form>
      {showDefault && defaultText && <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-edge p-2 text-2xs text-secondary">{defaultText}</pre>}
    </li>
  );
}

/** The prompts that belong to one sub-tab: product prompts first (the help desk's reference
 *  text after its prompt), then a plugin's own. */
function PromptsCard({ sub }: { sub: AiSub }) {
  const { view } = usePanel();
  const mine = view.prompts.filter((p) => aiSubOf(p.slot, p.group) === sub);
  const product = mine.filter((p) => p.group === "product");
  const plugin = mine.filter((p) => p.group === "plugin");
  const withFacts = product.some((p) => p.slot === "helpdesk.answer");
  if (!product.length && !plugin.length) return null;
  return (
    <section className={card} aria-label="Prompts">
      <h2 className={h2}>Prompts</h2>
      <p className="mt-0.5 mb-3 text-xs text-muted">
        What each task is told. <span className="font-mono">{"{{bot.name}}"}</span> and <span className="font-mono">{"{{site.name}}"}</span> are filled in when it runs.
        What a task needs to work — its answer format, who is asking, the reference text — is added after your words, so editing a prompt cannot break it.
      </p>
      {!view.contentReachable && <p className="mb-2 text-xs text-amber-300">The chat service did not answer when asked for this install&apos;s prompts — what you see may be the defaults, not this install&apos;s text.</p>}
      {(product.length > 0 || withFacts) && (
        <ul className="space-y-3">
          {product.map((p) => (
            <ContentEditor key={`${p.slot}:${p.own?.updatedAt ?? "d"}`} contentKey={`prompt.${p.slot}`} label={p.label} defaultText={p.defaultPrompt} own={p.own} maxLength={16000}
              help={p.slot === "automod.classify" ? "Your policy for what counts as risky. The categories and the strict answer format are added by the code." : "How the help desk answers. The person's account and the reference text below are added by the code."} />
          ))}
          {withFacts && (
            <ContentEditor key={`facts:${view.facts?.updatedAt ?? "d"}`} contentKey="helpdesk.facts" label="Help desk reference" defaultText={null} own={view.facts} maxLength={32768}
              help="Everything the help desk may answer from: features, how-tos, rules, links. Plain text or Markdown. Empty = it answers from its prompt alone." />
          )}
        </ul>
      )}
      {plugin.length > 0 && (
        <>
          <h3 className={`${product.length ? "mt-4" : ""} ${h3}`}>This install&apos;s plugin</h3>
          <p className="mt-0.5 mb-3 text-xs text-muted">
            Prompts a plugin on this install uses. They are used exactly as written — names in <span className="font-mono">{"{{ }}"}</span> are not filled in. Revert goes back to the plugin&apos;s own text.
          </p>
          <ul className="space-y-3">
            {plugin.map((p) => (
              <ContentEditor key={`${p.slot}:${p.own?.updatedAt ?? "d"}`} contentKey={`prompt.${p.slot}`} label={p.label} defaultText={p.defaultPrompt} own={p.own} maxLength={16000}
                help={p.help ?? ""} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

type Behavior = Extract<ReturnType<typeof parseBotBehavior>, { ok: true }>["value"];
/** The shipped default behavior file (parseBotBehavior of nothing). */
function defaultBehavior(): Behavior {
  const d = parseBotBehavior(null);
  if (!d.ok) throw new Error("the default behavior file does not parse");
  return d.value;
}
const FACT_TAGS = ["schedule", "rules", "links", "jokes", "other"] as const;

/** The chat bot: its name, its switch, where it can speak, and its behavior file with the
 *  render-time meter (the same renderBotBehavior the bot runs). */
function BotSection() {
  const { view, note, reload } = usePanel();
  const [name, setName] = useState(view.botName.stored ?? "");
  const stored = parseBotBehavior(view.botBehavior?.body ?? null);
  const base = stored.ok ? stored.value : defaultBehavior();
  const [b, setB] = useState<Behavior>(base);
  const [avoidText, setAvoidText] = useState(b.avoid.join("\n"));
  const [busy, setBusy] = useState(false);
  const nameEnv = view.botName.sources.find((x) => x.source === "env");
  const enabledEnv = view.botEnabled.sources.find((x) => x.source === "env");
  const task = view.slots.find((x) => x.id === "bot.reply");
  const taskOn = !!task?.routes.some((r) => r.route?.enabled);
  const current: Behavior = { ...b, avoid: avoidText.split("\n").map((x) => x.trim()).filter(Boolean) };
  const json = JSON.stringify(current);
  const check = parseBotBehavior(json);
  const meter = check.ok ? renderBotBehavior(check.value, 6000) : null;
  const dirty = json !== JSON.stringify(base);
  const speak = view.bot?.speakOn;

  async function saveName(clear: boolean) {
    setBusy(true);
    const err = await saveKey("bot.name", clear ? undefined : name.trim());
    note(err ? `Bot name: ${err}` : `Bot name: ${clear ? "cleared — shown as \"Bot\" (\"Help\" for the help desk)" : "saved"}.`);
    setBusy(false);
    if (!err) { if (clear) setName(""); reload(); }
  }
  async function toggle() {
    setBusy(true);
    const err = await saveKey("bot.enabled", !view.botEnabled.value);
    note(err ? `Chat bot: ${err}` : `Chat bot: ${view.botEnabled.value ? "off" : "on — it starts within a few seconds, no restart"}.`);
    setBusy(false);
    if (!err) reload();
  }
  async function saveBehavior() {
    setBusy(true);
    const err = await saveContent("bot.behavior", json);
    note(err ? `Behavior file: ${err}` : "Behavior file: saved — used from the next reply.");
    setBusy(false);
    if (!err) reload();
  }
  async function resetBehavior() {
    if (!window.confirm("Go back to the shipped default behavior? Your file is kept in the change history.")) return;
    setBusy(true);
    const err = await saveContent("bot.behavior", null);
    note(err ? `Behavior file: ${err}` : "Behavior file: back to the default.");
    setBusy(false);
    if (!err) { setB(defaultBehavior()); setAvoidText(""); reload(); }
  }
  const setFact = (i: number, f: Partial<Behavior["facts"][number]>) => setB((x) => ({ ...x, facts: x.facts.map((y, j) => (j === i ? { ...y, ...f } : y)) }));

  return (
    <section className={card} aria-label="Chat bot">
      <h2 className={h2}>Chat bot</h2>
      <p className="mt-0.5 mb-3 text-xs text-muted">Answers chat messages that mention its name. It sends the message, recent chat and (when memory is on) a few remembered lines to its task&apos;s connection.</p>

      <h3 className={h3}>Name</h3>
      <p className="mt-0.5 mb-1 text-2xs text-muted">Also the help desk&apos;s name, in chat, the help pop-up and the prompts. Unset = &quot;Bot&quot; (&quot;Help&quot; for the help desk).</p>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(ev) => { ev.preventDefault(); void saveName(false); }}>
        <input className={`${input} basis-48`} value={name} maxLength={32} onChange={(e) => setName(e.target.value)} disabled={!!nameEnv} placeholder="Bot" aria-label="Bot name" />
        <button type="submit" className={btn} disabled={busy || !!nameEnv || !name.trim() || name.trim() === (view.botName.stored ?? "")}>Save</button>
        {view.botName.stored && !nameEnv && <button type="button" className={btn} disabled={busy} onClick={() => void saveName(true)}>Clear</button>}
      </form>
      {nameEnv && <p className="mt-1 text-2xs text-muted">Set on the server ({nameEnv.envName}) — change it there.</p>}

      <h3 className={`mt-4 ${h3}`}>Switch</h3>
      {view.providesBot ? (
        <p className="mt-1 text-xs text-muted">Off on this install: {view.providesBot} answers chat. One identity, one bot.</p>
      ) : (
        <>
          <div className="mt-1 flex items-center gap-2 text-xs text-body">
            <Toggle on={view.botEnabled.value} onToggle={() => void toggle()} disabled={busy || !!enabledEnv} label="Answer mentions" />
            <span className="whitespace-nowrap">Answer mentions</span>
          </div>
          {/* Its own line, so the switch's label never wraps beside it at phone width. */}
          {(!taskOn || enabledEnv) && <p className="mt-1 text-2xs text-muted">{!taskOn ? "Switch the Chat bot replies task on below first." : `Set on the server (${enabledEnv!.envName}).`}</p>}
        </>
      )}
      <p className="mt-1 text-2xs text-muted">
        Can speak on: {speak ? [speak.site ? "Site" : null, speak.twitch ? `Twitch (as ${speak.twitch})` : null].filter(Boolean).join(" · ") || "nowhere yet — no bot account linked" : "the ingest service has not reported yet"}
        {" "}· YouTube, Kick and stream.place are not supported yet (mentions there are skipped).
        {view.bot && ` Since its last start: ${view.bot.replies} repl${view.bot.replies === 1 ? "y" : "ies"}, ${view.bot.skippedUnlinked} skipped (no account there), ${view.bot.screened} held back by the chat filter, ${view.bot.failed} failed.`}
      </p>

      <h3 className={`mt-4 ${h3}`}>Behavior file</h3>
      {!stored.ok && <p className="mt-1 text-xs text-amber-300">The stored file does not parse ({stored.error}) — the bot is using the default.</p>}
      <form className="mt-1 space-y-3" onSubmit={(ev) => { ev.preventDefault(); void saveBehavior(); }} aria-label="Behavior file">
        <label className="block text-xs text-secondary">Persona
          <textarea className={`${textarea} mt-1 min-h-24`} value={b.persona} maxLength={2000} onChange={(e) => setB((x) => ({ ...x, persona: e.target.value }))} aria-label="Persona" />
        </label>
        <label className="block text-xs text-secondary">Never discuss (one topic per line)
          <textarea className={`${textarea} mt-1 min-h-16`} value={avoidText} onChange={(e) => setAvoidText(e.target.value)} aria-label="Topics to avoid" />
        </label>
        <div className="space-y-2">
          <p className="text-xs text-secondary">Facts — added to the prompt in this order, whole, while they fit</p>
          {b.facts.map((f, i) => (
            <div key={i} className={`flex flex-wrap items-start gap-2 ${meter?.omitted.includes(i) ? "opacity-60" : ""}`}>
              <select className={`${input} basis-28 flex-none`} value={f.tag} onChange={(e) => setFact(i, { tag: e.target.value as Behavior["facts"][number]["tag"] })} aria-label={`Tag of fact ${i + 1}`}>
                {FACT_TAGS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <input className={input} value={f.text} maxLength={300} onChange={(e) => setFact(i, { text: e.target.value })} aria-label={`Fact ${i + 1}`} />
              <button type="button" className={btn} onClick={() => setB((x) => ({ ...x, facts: x.facts.filter((_, j) => j !== i) }))} aria-label={`Remove fact ${i + 1}`}>Remove</button>
              {meter?.omitted.includes(i) && <span className="w-full text-2xs text-amber-300">does not fit in the prompt — it is left out</span>}
            </div>
          ))}
          <button type="button" className={`${btn} block`} disabled={b.facts.length >= 60} onClick={() => setB((x) => ({ ...x, facts: [...x.facts, { text: "", tag: "other" }] }))}>Add fact</button>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {([
            ["replyLength", "Reply length", [["short", "short"], ["medium", "medium"]]],
            ["swearing", "Swearing", [["avoid", "avoid"], ["allow", "allow"]]],
            ["emoji", "Emoji", [["allow", "allow"], ["avoid", "avoid"]]],
          ] as const).map(([k, label, opts]) => (
            <div key={k} className="flex items-center gap-2 text-xs text-secondary">
              <span>{label}</span>
              <Choice label={label} value={b.settings[k] as string} options={opts.map(([v, t]) => ({ value: v as string, label: t }))}
                onChange={(v) => setB((x) => ({ ...x, settings: { ...x.settings, [k]: v } }))} />
            </div>
          ))}
        </div>
        <p role="status" className={`text-2xs ${!check.ok || (meter && meter.omitted.length) ? "text-amber-300" : "text-muted"}`}>
          {!check.ok ? `Not valid yet: ${check.error}`
            : `Used ${meter!.used.toLocaleString()} of ${meter!.cap.toLocaleString()} characters in the prompt${meter!.omitted.length ? ` — ${meter!.omitted.length} fact${meter!.omitted.length === 1 ? "" : "s"} will not fit: ${meter!.omitted.map((i) => `#${i + 1}`).join(", ")}` : ""}.`}
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={btn} disabled={busy || !check.ok || !dirty}>Save behavior</button>
          {view.botBehavior && <button type="button" className={btn} disabled={busy} onClick={() => void resetBehavior()}>Revert to default</button>}
        </div>
      </form>
    </section>
  );
}

const AUTOMOD_NUMBERS: { key: string; label: string; help: string }[] = [
  { key: "automod.holdBudgetMs", label: "Time budget (ms)", help: "how long a site message may wait on the check" },
  { key: "automod.minConfidence", label: "Confidence floor (0–1)", help: "below this a risky verdict counts as ok" },
  { key: "automod.holdExpiry", label: "Drop an unreviewed hold after (s)", help: "only automod's holds; word-filter and link holds wait" },
  { key: "automod.markAfterCount", label: "Mark after (messages)", help: "risky messages before a suspicious mark" },
  { key: "automod.markAfterHours", label: "…within (hours)", help: "" },
];

function AutomodSettings() {
  const { view, note, reload } = usePanel();
  const a = view.automod;
  const [busy, setBusy] = useState(false);
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(AUTOMOD_NUMBERS.map((n) => [n.key, String(a[n.key]?.value ?? "")])));
  const [cats, setCats] = useState(((a["automod.categories"]?.value as string[] | undefined) ?? []).join(", "));
  const task = view.slots.find((x) => x.id === "automod.classify");
  const taskOn = !!task?.routes.some((r) => r.route?.enabled);
  const on = a["automod.enabled"]?.value === true;
  async function put(key: string, value: unknown, label: string) {
    setBusy(true);
    const err = await saveKey(key, value);
    note(err ? `${label}: ${err}` : `${label}: saved.`);
    setBusy(false);
    if (!err) reload();
  }
  return (
    <section className={card} aria-label="Automod">
      <h2 className={h2}>Automod</h2>
      <p className="mt-0.5 mb-2 text-xs text-muted">Holds a risky site message for a moderator before anyone sees it, and flags risky platform messages (already public there). It never removes, bans or times anyone out. If the model is slow or down, messages are delivered unchecked. It sends each checked message&apos;s text to the Automod check task&apos;s connection; staff, mods, the bot and wholly encrypted messages are never checked.</p>
      <div className="flex items-center gap-2 text-xs text-body">
        <Toggle on={on} onToggle={() => void put("automod.enabled", !on, "Automod")} disabled={busy || !!a["automod.enabled"]?.envName} label="Check chat messages" />
        <span>Check chat messages</span>
        <span className="min-w-0 text-muted">{!taskOn ? "— switch the Automod check task on below first" : a["automod.enabled"]?.envName ? `— set on the server (${a["automod.enabled"]?.envName})` : ""}</span>
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs text-body">
        <Toggle on={a["automod.skipSupporters"]?.value === true} disabled={busy || !!a["automod.skipSupporters"]?.envName} label="Do not check paying supporters"
          onToggle={() => void put("automod.skipSupporters", a["automod.skipSupporters"]?.value !== true, "Skip supporters")} />
        <span>Do not check paying supporters</span>
      </div>
      <form className="mt-3 grid gap-2 sm:grid-cols-2" onSubmit={(ev) => ev.preventDefault()}>
        {AUTOMOD_NUMBERS.map((n) => {
          const env = a[n.key]?.envName;
          return (
            <label key={n.key} className="flex flex-col gap-1 text-xs text-secondary">
              <span>{n.label}{n.help ? <span className="text-muted"> — {n.help}</span> : null}</span>
              <span className="flex gap-2">
                <input className={`${input} basis-24`} inputMode="decimal" value={vals[n.key] ?? ""} disabled={!!env}
                  onChange={(e) => setVals((v) => ({ ...v, [n.key]: e.target.value }))} aria-label={n.label} />
                <button type="button" className={btn} disabled={busy || !!env || vals[n.key] === String(a[n.key]?.value ?? "") || !vals[n.key]?.trim()}
                  onClick={() => void put(n.key, Number(vals[n.key]), n.label)}>Save</button>
              </span>
              {env && <span className="text-2xs text-muted">set on the server ({env})</span>}
            </label>
          );
        })}
        <label className="flex flex-col gap-1 text-xs text-secondary sm:col-span-2">
          <span>Categories <span className="text-muted">— what the check may call risky (comma-separated, lower case)</span></span>
          <span className="flex gap-2">
            <input className={input} value={cats} onChange={(e) => setCats(e.target.value)} aria-label="Automod categories" disabled={!!a["automod.categories"]?.envName} />
            <button type="button" className={btn} disabled={busy || !!a["automod.categories"]?.envName}
              onClick={() => void put("automod.categories", cats.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean), "Categories")}>Save</button>
          </span>
        </label>
      </form>
    </section>
  );
}

function ModeSection() {
  const { view, note, reload } = usePanel();
  const [conn, setConn] = useState(view.defaultRoute?.connection ?? "");
  const [model, setModel] = useState(view.defaultRoute?.model ?? "");
  const [busy, setBusy] = useState(false);
  const modeEnv = view.mode.sources.find((s) => s.source === "env");
  const simple = view.mode.value === "simple";
  // In Simple mode the default runs every chat task that no env pins — plugins' tasks included.
  const affected = view.slots.filter((s) => s.kind === "chat" && !s.envPinned && (s.group === "plugin" ? s.task?.enabled !== false : s.task?.enabled === true));

  async function put(key: string, value: unknown, done: string) {
    setBusy(true);
    const err = await saveKey(key, value);
    note(err ? `${done}: ${err}` : `${done}: saved.`);
    setBusy(false);
    if (!err) reload();
  }
  function saveDefault() {
    if (conn && model && simple && affected.length &&
      !window.confirm(`In Simple mode this model runs ${affected.length} task${affected.length === 1 ? "" : "s"}: ${affected.map((s) => s.label).join(", ")}. Save it?`)) return;
    void put("ai.default", conn && model ? { connection: conn, model } : undefined, "Default model");
  }
  const dirty = conn !== (view.defaultRoute?.connection ?? "") || model !== (view.defaultRoute?.model ?? "");

  return (
    <section className={card} aria-label="Mode">
      <h2 className={h2}>Mode</h2>
      <fieldset disabled={busy || !!modeEnv} className="mt-2 flex flex-wrap items-center gap-2">
        <Choice label="AI mode" value={view.mode.value}
          options={[{ value: "simple", label: "Simple" }, { value: "advanced", label: "Advanced" }] as const}
          onChange={(m) => { if (view.mode.value !== m) void put("ai.mode", m, "Mode"); }} />
        {modeEnv && <span className="text-2xs text-muted">set on the server ({modeEnv.envName})</span>}
      </fieldset>
      <p className="mt-1 text-xs text-muted">
        {simple ? "Simple: the default model below runs every chat task that is switched on and not set on the server."
          : "Advanced: each task uses its own connection and model when it has one, else the default."}
      </p>

      <h3 className={`mt-4 ${h3}`}>Default model</h3>
      <form className="mt-1 space-y-2" onSubmit={(ev) => { ev.preventDefault(); saveDefault(); }}>
        <RoutePicker label="default" connection={conn} model={model} onChange={(c, m) => { setConn(c); setModel(c ? m : ""); }} />
        <div className="flex gap-2">
          <button type="submit" className={btn} disabled={busy || !dirty || (!!conn && !model)}>Save</button>
          {view.defaultRoute && <button type="button" className={btn} disabled={busy} onClick={() => { setConn(""); setModel(""); void put("ai.default", undefined, "Default model"); }}>Clear</button>}
        </div>
      </form>
      {simple && (
        <p className="mt-1 text-2xs text-muted">
          {affected.length ? `In Simple mode a default runs: ${affected.map((s) => s.label).join(", ")}.` : "No task would run on it yet — switch a task on in its tab."}
        </p>
      )}
    </section>
  );
}

/** The help desk's switch (Help Desk tab). */
function HelpdeskSwitch() {
  const { view, note, reload } = usePanel();
  const [busy, setBusy] = useState(false);
  const helpEnv = view.helpdeskEnabled.sources.find((s) => s.source === "env");
  async function toggle() {
    setBusy(true);
    const err = await saveKey("helpdesk.enabled", !view.helpdeskEnabled.value);
    note(err ? `Help desk: ${err}` : "Help desk: saved.");
    setBusy(false);
    if (!err) reload();
  }
  return (
    <section className={card} aria-label="Help desk">
      <h2 className={h2}>Help desk</h2>
      <div className="mt-2 flex items-center gap-2 text-xs text-body">
        <Toggle on={view.helpdeskEnabled.value} onToggle={() => void toggle()} disabled={busy || !!helpEnv} label="Help desk answers with the AI" />
        <span>Help desk answers with the AI</span>
      </div>
      <p className="mt-1 text-xs text-muted">Sends the visitor&apos;s help question and the help desk&apos;s reference text to its task&apos;s connection.{helpEnv ? ` Set on the server (${helpEnv.envName}).` : ""}</p>
    </section>
  );
}

/** The tasks that belong to one sub-tab, with what each runs on right now. */
function TasksCard({ sub, title = "Tasks" }: { sub: AiSub; title?: string }) {
  const { view } = usePanel();
  const mine = view.slots.filter((s) => aiSubOf(s.id, s.group) === sub);
  const product = mine.filter((s) => s.group === "product");
  const plugin = mine.filter((s) => s.group === "plugin");
  if (!mine.length) return null;
  return (
    <section className={card} aria-label={title}>
      <h2 className={h2}>{title}</h2>
      <p className="mt-0.5 mb-3 text-xs text-muted">What each runs on in each service right now{view.usageDay ? ` (usage: ${view.usageDay}, UTC)` : ""}.</p>
      {product.length > 0 && <ul className="space-y-3">{product.map((s) => <SlotRow key={s.id} s={s} />)}</ul>}
      {plugin.length > 0 && (
        <>
          <h3 className={`${product.length ? "mt-5" : ""} mb-2 ${h3}`}>Plugins on this install</h3>
          <ul className="space-y-3">{plugin.map((s) => <SlotRow key={s.id} s={s} />)}</ul>
        </>
      )}
    </section>
  );
}

/** The AI section of the Admin Panel: one sub-tab's cards (the rail is the panel's). */
export default function AiPanel({ sub, inst, reloadInst, note }: {
  sub: AiSub; inst: InstanceView; reloadInst: () => void; note: (m: string) => void;
}) {
  const [view, setView] = useState<AiView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<Record<string, string[]>>({});
  const detect = useCallback(async (connection: string) => {
    const r = await runCheck("detect", connection);
    if (r.error) { note(`Detect ${connection}: ${r.error}`); return; }
    if (!r.ok) { note(`Detect ${connection} (${r.package ? serviceName(r.package) : "?"}): ${r.unanswered ? "the service did not answer in time" : CODE[r.code ?? ""] ?? r.code}`); return; }
    setModels((m) => ({ ...m, [connection]: r.models ?? [] }));
    note(`Detect ${connection} (${serviceName(r.package ?? "?")}): ${(r.models ?? []).length} model(s).`);
  }, [note]);

  const load = useCallback(() => {
    getJson<AiView>("/api/admin/ai", { cache: "no-store" })
      .then((v) => { setView(v); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "could not load"));
  }, []);
  useEffect(() => { load(); }, [load]);
  const reloadBoth = useCallback(() => { load(); reloadInst(); }, [load, reloadInst]);

  if (error) return <p className="text-sm text-red-300">Could not load the AI settings: {error}</p>;
  if (!view) return <p role="status" className="text-sm text-muted">Loading AI settings…</p>;

  return (
    <PanelCtx.Provider value={{ view, note, reload: load, models, detect }}>
    <div className="space-y-4">
      {!view.routesReachable && (
        <p className="rounded-lg border border-edge bg-surface-1 px-3 py-2 text-xs text-amber-300">The chat service did not answer when asked what each AI task runs on — the tasks are missing here, not off.</p>
      )}

      {sub === "models" && (
        <>
          <ModeSection />
          <section className={card} aria-label="Connections">
            <h2 className={h2}>Connections</h2>
            <p className="mt-0.5 mb-3 text-xs text-muted">Where model calls go. A key belongs to its connection and is only ever sent to that address.</p>
            <ul className="space-y-3">{view.connections.map((c) => <ConnectionRow key={c.id} c={c} />)}</ul>
            <AddConnection />
          </section>
          <KeyCards view={inst} groups={keyGroupsFor("ai", "models")} onChanged={reloadBoth} note={note} />
          <TasksCard sub="models" title="Other tasks" />
        </>
      )}

      {sub === "bot" && (
        <>
          <BotSection />
          <KeyCards view={inst} groups={keyGroupsFor("ai", "bot")} onChanged={reloadBoth} note={note} />
          <TasksCard sub="bot" />
          <PromptsCard sub="bot" />
        </>
      )}

      {sub === "scoring" && (
        view.slots.some((s) => aiSubOf(s.id, s.group) === "scoring")
          ? <TasksCard sub="scoring" />
          : <p className={`${card} text-xs text-muted`}>No scoring task runs on this install.</p>
      )}

      {sub === "automod" && (
        <>
          <AutomodSettings />
          <TasksCard sub="automod" />
          <PromptsCard sub="automod" />
        </>
      )}

      {sub === "helpdesk" && (
        <>
          <HelpdeskSwitch />
          <HelpdeskPicture botId={botMatrixId(inst)} />
          <TasksCard sub="helpdesk" />
          <PromptsCard sub="helpdesk" />
        </>
      )}

      {sub === "embeddings" && (
        <>
          <TasksCard sub="embeddings" />
          <section className={card} aria-label="Memory">
            <h2 className={h2}>Memory</h2>
            <p className="mt-0.5 mb-3 text-xs text-muted">Chat messages turned into vectors so the bot can recall them. Needs an OpenAI-compatible connection (OpenAI, Ollama, LM Studio, …); Anthropic has no embeddings endpoint.</p>
            <MemoryPanel m={view.memory} />
          </section>
        </>
      )}
    </div>
    </PanelCtx.Provider>
  );
}
