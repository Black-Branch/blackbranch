// The AI section's VIEW — pure enough to test under `node --test`.
//
// Built from two stream-api reads: GET /config (the settings layer: stored values, each
// process's source per key, credential STATUS) and GET /ai/routes (every slot, what it resolves
// to in each process that runs it, its health, today's usage, the memory store). Like the
// key cards, this is STATUS ONLY — a connection's key appears as set / `…abcd` / not set,
// never as a value. The routes are in instanceAdminServer.ts.

import { buildInstanceView, type InstanceView, type StreamApiSnapshot } from "./instanceAdminView.ts";
import { INSTANCE_KEYS } from "./instanceSchema.generated.mjs";

type Pkg = "stream-api" | "stream-ingest";

export type AiRoute = { connection: string; model: string };
export type AiTask = { enabled?: boolean; connection?: string; model?: string; maxTokens?: number };
export type AiCustomConnection = { id: string; kind: "openai-compatible"; label: string; baseUrl: string };
export type RouteSummary =
  | { enabled: true; connection: string; model: string; source: "env" | "db" | "default"; envName: string | null }
  | { enabled: false; reason: string };
export type SlotHealth = { status: "ok" | "flaky" | "failing"; consecutive: number; failingSince: string | null; lastCode: string | null; lastOkAt: string | null };
type SlotUsage = { calls: number; errors: number; unchecked: number; tokensIn: number; tokensOut: number };
export type MemoryStats = {
  state: { model: string; connection: string; dim: number; since: string; status: "on" | "paused" | "switching"; pausedReason?: string; pausedAt?: string; reduced?: boolean } | null;
  enabled: boolean; retentionDays: number | null; rows: number; oldest: string | null; columnDim: number | null; nextPurge: number;
  olderThan?: Record<string, number>;
} | { error: string };

/** GET /ai/routes, as stream-api answers it. */
export type AiRoutesSnapshot = {
  slots: {
    id: string; kind: "chat" | "embed"; owner: string; package?: string; label: string; description: string; needs: string[];
    defaultPrompt?: string | null;
    /** A plugin slot's own prompts (content `prompt.<key>`), as the running plugin declared them. */
    prompts?: { key: string; label: string; help: string; defaultPrompt: string }[];
    routes: Partial<Record<Pkg, RouteSummary | null>>;
    health?: Partial<Record<Pkg, SlotHealth | null>>;
    lockedBy?: string | null; lastReportedAt?: string; running?: boolean;
  }[];
  usage?: { day: string; slots: Record<string, SlotUsage> };
  memory?: MemoryStats | null;
  providesBot: string | null;
  bot?: BotReport | null;
  reportedAt: string | null;
};

/** The chat bot's line in stream-ingest's report: where it can speak, and what it did. */
export type BotReport = { speakOn: { site: boolean; twitch: string | null }; replies: number; skippedUnlinked: number; screened: number; failed: number; cooldown: number };

/** GET /content, as stream-api answers it: every content row (prompts, the behavior file, the facts). */
export type ContentSnapshot = { content: Record<string, { body: string; updatedBy: string; updatedAt: string }> };
export type ContentRow = { body: string; updatedBy: string; updatedAt: string };

/** Where one process gets one setting: its source and the env name that won, if any. */
export type SettingSource = { package: Pkg; known: boolean; source: string | null; envName: string | null };

export type AiView = {
  processes: InstanceView["processes"];
  routesReachable: boolean;
  mode: { value: "simple" | "advanced"; sources: SettingSource[] };
  defaultRoute: AiRoute | null;
  helpdeskEnabled: { value: boolean; sources: SettingSource[] };
  /** bot.name as stream-ingest resolves it (it runs the bot and the help desk); null = unset. */
  botName: { value: string | null; stored: string | null; sources: SettingSource[] };
  /** Editable prompts: each product chat task's, then each prompt a running plugin declared.
   *  `slot` is the content key's tail (`prompt.<slot>`); `help` is the plugin's own line. */
  prompts: { slot: string; label: string; defaultPrompt: string; own: ContentRow | null; group: "product" | "plugin"; help: string | null }[];
  /** The help desk's reference text (content `helpdesk.facts`). */
  facts: ContentRow | null;
  contentReachable: boolean;
  botEnabled: { value: boolean; sources: SettingSource[] };
  botBehavior: ContentRow | null;
  bot: BotReport | null;
  /** Automod's settings as stream-api resolves them (the one that runs the check), each with
   *  whether env pins it. */
  automod: Record<string, { value: unknown; envName: string | null }>;
  /** memory.minWords as stream-ingest (the one that applies it) resolves it. */
  memoryMinWords: { value: number; envName: string | null };
  connections: {
    id: string; kind: "anthropic" | "openai-compatible"; label: string; baseUrl: string; builtin: boolean; keyName: string;
    key: { stored: null | { display: string; updatedBy: string; updatedAt: string; readable: boolean };
      packages: { package: Pkg; known: boolean; source: string | null; envName: string | null; display: string | null; error: string | null }[] };
  }[];
  slots: {
    id: string; kind: "chat" | "embed"; group: "product" | "plugin"; owner: string; label: string; description: string; needs: string[];
    running: boolean; lockedBy: string | null;
    routes: { package: Pkg; route: RouteSummary | null; health: SlotHealth | null }[];
    /** The env NAME that pins this slot in some process (the page then shows it read-only). */
    envPinned: string | null;
    task: AiTask | null;
    usage: SlotUsage | null;
  }[];
  memory: MemoryStats | null;
  providesBot: string | null;
  usageDay: string | null;
  ingestReportedAt: string | null;
};

const BUILTINS = [
  { id: "anthropic", kind: "anthropic" as const, label: "Anthropic", baseUrl: "https://api.anthropic.com", keyName: "anthropic.apiKey" },
  { id: "openai", kind: "openai-compatible" as const, label: "OpenAI", baseUrl: "https://api.openai.com/v1", keyName: "openai.apiKey" },
];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isRoute = (v: unknown): v is AiRoute => isObj(v) && typeof v.connection === "string" && typeof v.model === "string";

function sourcesOf(s: StreamApiSnapshot | null, key: string, pkgs: Pkg[]): SettingSource[] {
  return pkgs.map((p) => {
    const st = p === "stream-api" ? s?.self?.[key] : s?.reports?.["stream-ingest"]?.keys?.[key];
    return { package: p, known: !!st, source: st?.source ?? null, envName: st?.envName ?? null };
  });
}

/** The page's whole view. `cfg` null = stream-api unreachable; `routes` null = /ai/routes failed. */
export function buildAiView(cfg: StreamApiSnapshot | null, routes: AiRoutesSnapshot | null, content: ContentSnapshot | null = null): AiView {
  const inst = buildInstanceView(cfg);
  const values = cfg?.values ?? {};
  const resolvedMode = cfg?.self?.["ai.mode"]?.display;
  const mode = resolvedMode === "advanced" || resolvedMode === "simple" ? resolvedMode : values["ai.mode"] === "advanced" ? "advanced" : "simple";
  const helpdesk = cfg?.reports?.["stream-ingest"]?.keys?.["helpdesk.enabled"]?.display;
  const tasks = isObj(values["ai.tasks"]) ? (values["ai.tasks"] as Record<string, AiTask>) : {};
  const custom = Array.isArray(values["ai.connections"]) ? (values["ai.connections"] as AiCustomConnection[]) : [];

  const keyFor = (keyName: string) => {
    const k = inst.keys.find((x) => x.key === keyName);
    const sec = cfg?.secrets?.[keyName];
    const stored = sec ? { display: sec.last4 ? `…${sec.last4}` : "(set)", updatedBy: sec.updatedBy, updatedAt: sec.updatedAt, readable: sec.readable } : null;
    const packages = (k?.packages ?? [])
      .filter((p): p is typeof p & { package: Pkg } => p.package !== "web")
      .map((p) => ({ package: p.package, known: p.known, source: p.source, envName: p.envName, display: typeof p.display === "string" ? p.display : null, error: p.error }));
    return { stored, packages };
  };
  const connections: AiView["connections"] = [
    ...BUILTINS.map((b) => ({ ...b, builtin: true, key: keyFor(b.keyName) })),
    ...custom.map((c) => {
      const keyName = `ai.connection.${c.id}.apiKey`;
      return { id: c.id, kind: "openai-compatible" as const, label: c.label, baseUrl: c.baseUrl, builtin: false, keyName, key: keyFor(keyName) };
    }),
  ];

  const usage = routes?.usage?.slots ?? {};
  const slots: AiView["slots"] = (routes?.slots ?? []).map((s) => {
    const pkgs = (Object.keys(s.routes) as Pkg[]).filter((p) => p === "stream-api" || p === "stream-ingest");
    const rs = pkgs.map((p) => ({ package: p, route: s.routes[p] ?? null, health: s.health?.[p] ?? null }));
    const pinned = rs.map((r) => r.route).find((r): r is Extract<RouteSummary, { enabled: true }> => !!r && r.enabled && r.source === "env");
    return {
      id: s.id, kind: s.kind, group: s.owner === "product" ? "product" : "plugin", owner: s.owner, label: s.label, description: s.description,
      needs: s.needs, running: s.owner === "product" ? true : s.running !== false, lockedBy: s.lockedBy ?? null,
      routes: rs, envPinned: pinned ? pinned.envName : null,
      task: isObj(tasks[s.id]) ? tasks[s.id]! : null, usage: usage[s.id] ?? null,
    };
  });

  const rows = content?.content ?? {};
  const row = (k: string): ContentRow | null => {
    const r = rows[k];
    return r && typeof r.body === "string" ? { body: r.body, updatedBy: String(r.updatedBy ?? ""), updatedAt: String(r.updatedAt ?? "") } : null;
  };
  const prompts: AiView["prompts"] = (routes?.slots ?? [])
    .filter((s) => s.owner === "product" && s.kind === "chat" && typeof s.defaultPrompt === "string" && s.defaultPrompt)
    .map((s) => ({ slot: s.id, label: s.label, defaultPrompt: s.defaultPrompt as string, own: row(`prompt.${s.id}`), group: "product" as const, help: null }));
  for (const s of routes?.slots ?? []) {
    if (s.owner === "product" || !Array.isArray(s.prompts)) continue;
    for (const p of s.prompts) {
      if (typeof p?.key !== "string" || typeof p.defaultPrompt !== "string" || !p.defaultPrompt) continue;
      prompts.push({ slot: p.key, label: String(p.label || p.key), defaultPrompt: p.defaultPrompt, own: row(`prompt.${p.key}`), group: "plugin", help: typeof p.help === "string" && p.help ? p.help : null });
    }
  }
  const ingestName = cfg?.reports?.["stream-ingest"]?.keys?.["bot.name"]?.display;
  const storedName = typeof values["bot.name"] === "string" ? (values["bot.name"] as string) : null;

  return {
    processes: inst.processes,
    routesReachable: !!routes,
    mode: { value: mode, sources: sourcesOf(cfg, "ai.mode", ["stream-api", "stream-ingest"]) },
    defaultRoute: isRoute(values["ai.default"]) ? values["ai.default"] : null,
    helpdeskEnabled: { value: helpdesk === true, sources: sourcesOf(cfg, "helpdesk.enabled", ["stream-ingest"]) },
    botName: { value: typeof ingestName === "string" ? ingestName : storedName, stored: storedName, sources: sourcesOf(cfg, "bot.name", ["stream-ingest"]) },
    prompts, facts: row("helpdesk.facts"), contentReachable: !!content,
    botEnabled: { value: cfg?.reports?.["stream-ingest"]?.keys?.["bot.enabled"]?.display === true, sources: sourcesOf(cfg, "bot.enabled", ["stream-ingest"]) },
    botBehavior: row("bot.behavior"),
    bot: routes?.bot ?? null,
    automod: Object.fromEntries(INSTANCE_KEYS.filter((e) => e.key.startsWith("automod.")).map((e) => {
      const self = cfg?.self?.[e.key];
      const value = self ? self.display : e.key in values ? values[e.key] : e.default;
      return [e.key, { value: value ?? e.default, envName: self?.source === "env" ? self.envName : null }];
    })),
    memoryMinWords: (() => {
      const st = cfg?.reports?.["stream-ingest"]?.keys?.["memory.minWords"];
      const floor = Number(INSTANCE_KEYS.find((e) => e.key === "memory.minWords")?.default);
      const v = Number(st?.display ?? values["memory.minWords"] ?? floor);
      return { value: Number.isInteger(v) && v > 0 ? v : floor, envName: st?.source === "env" ? st.envName ?? null : null };
    })(),
    connections, slots,
    memory: routes?.memory ?? null,
    providesBot: routes?.providesBot ?? null,
    usageDay: routes?.usage?.day ?? null,
    ingestReportedAt: routes?.reportedAt ?? null,
  };
}
