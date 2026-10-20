// What THIS install runs, as the legal page needs to know it. Pure, so the page can be rendered
// for any configuration in a test (legalDocument.render.test.ts).
//
// Every fact comes from the process that runs the feature: the AI features from stream-api's and
// stream-ingest's own reports (GET /config `self` / `reports`, GET /ai/routes), the payment
// providers and the YouTube sign-in from web's own settings. A process that has not reported
// falls back to web's own reading of the saved setting.

import type { StreamApiSnapshot } from "../lib/instanceAdminView.ts";
import type { AiRoutesSnapshot, RouteSummary } from "../lib/aiAdminView.ts";
import type { PluginPrivacy } from "../lib/plugins/types.ts";

export type LegalFacts = {
  /** bot.name; null = unset. */
  botName: string | null;
  ai: {
    /** A chat bot answers in chat (the product's or a plugin's). */
    bot: boolean;
    /** Chat messages are embedded so the AI can recall them. */
    memory: boolean;
    /** Chat messages are checked by the AI for moderators. */
    automod: boolean;
    /** Help pop-up questions are answered by the AI. */
    helpdesk: boolean;
    /** A plugin's own AI tasks run. */
    plugin: boolean;
    /** The AI services chat is sent to, by name. Empty = not known (or none). */
    providers: string[];
    /** memory.retentionDays as the memory store applies it; null = until the person is forgotten. */
    memoryRetentionDays: number | null;
  };
  youtube: {
    /** The YouTube Data API reads the stream's own channel (an API key is set). */
    publicData: boolean;
    /** Viewers may link a YouTube account (and then post to its live chat). */
    linking: boolean;
  };
  payments: {
    stripe: boolean; paypal: boolean; kofi: boolean; patreon: boolean; streamlabs: boolean;
    /** A subscription can be bought: card payments AND a tier price (the checkout's own test). */
    subscriptions: boolean;
    /** Points can be bought: the buy switch on and a processor that sells them. */
    points: boolean;
  };
  /** The points' plural name, as the store shows it. */
  currencyName: string;
  /** Requests reach this site through Cloudflare. */
  cloudflare: boolean;
  /** The bundled homeserver's message retention, in days; null = the homeserver is run elsewhere
   *  and its retention is not this site's to state. */
  homeserverRetention: { dms: number; general: number } | null;
  /** Days a browser error report is kept (the pruner's own constant). */
  errorLogDays: number;
  /** What the install's owner plugin adds; null = no plugin. */
  plugin: PluginPrivacy | null;
};

export type AiFeatures = Pick<LegalFacts["ai"], "bot" | "memory" | "automod" | "helpdesk" | "plugin">;

/** Any AI feature at all. */
export function anyAi(ai: AiFeatures): boolean {
  return ai.bot || ai.memory || ai.automod || ai.helpdesk || ai.plugin;
}

export type LegalInputs = {
  /** stream-api GET /config; null = unreachable. */
  cfg: StreamApiSnapshot | null;
  /** stream-api GET /ai/routes; null = unreachable. */
  routes: AiRoutesSnapshot | null;
  /** web's own reading of a saved setting — the fallback for a process that has not reported. */
  saved: (key: string) => unknown;
  botName: string | null;
  youtube: LegalFacts["youtube"];
  stripe: boolean;
  /** The subscription tier has a price (lib/tiers.ts — what /api/billing/checkout requires). */
  subscriptions: boolean;
  paypal: boolean;
  /** `currency.purchasable` — the buy switch both points checkouts read. */
  pointsPurchase: boolean;
  currencyName: string;
  cloudflare: boolean;
  homeserverRetention: LegalFacts["homeserverRetention"];
  errorLogDays: number;
  plugin: PluginPrivacy | null;
};

const BUILTIN_LABELS: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI" };

/** A slot's feature, for the product's slots (config/ai-adapter.mjs PRODUCT_SLOTS). */
const PRODUCT_SLOT_FEATURE: Record<string, keyof AiFeatures> = {
  "bot.reply": "bot", "automod.classify": "automod", "helpdesk.answer": "helpdesk", embeddings: "memory",
};

export function legalFactsFrom(i: LegalInputs): LegalFacts {
  const served = (key: string, pkg: "stream-api" | "stream-ingest"): unknown => {
    const r = pkg === "stream-api" ? i.cfg?.self?.[key] : i.cfg?.reports?.[pkg]?.keys?.[key];
    return r ? r.display : i.saved(key);
  };
  const enabledRoutes = (s: AiRoutesSnapshot["slots"][number]) =>
    Object.values(s.routes).filter((r): r is Extract<RouteSummary, { enabled: true }> => !!r && r.enabled);
  const slots = i.routes?.slots ?? [];
  // A switched-on feature whose task has no model does nothing; while the routes are unknown, the
  // switch is taken at its word.
  const routed = (feature: keyof AiFeatures) =>
    !i.routes || slots.some((s) => s.owner === "product" && PRODUCT_SLOT_FEATURE[s.id] === feature && enabledRoutes(s).length > 0);

  const pluginSlots = slots.filter((s) => s.owner !== "product" && s.running !== false && enabledRoutes(s).length > 0);
  const features: AiFeatures = {
    bot: !!i.routes?.providesBot || (served("bot.enabled", "stream-ingest") === true && routed("bot")),
    memory: served("memory.enabled", "stream-api") === true && routed("memory"),
    automod: served("automod.enabled", "stream-api") === true && routed("automod"),
    helpdesk: served("helpdesk.enabled", "stream-ingest") === true && routed("helpdesk"),
    plugin: pluginSlots.length > 0,
  };

  const custom = Array.isArray(i.cfg?.values?.["ai.connections"])
    ? (i.cfg!.values!["ai.connections"] as { id?: unknown; label?: unknown }[])
    : [];
  const labelOf = (id: string) =>
    BUILTIN_LABELS[id] ?? (custom.find((c) => c.id === id && typeof c.label === "string")?.label as string | undefined) ?? id;
  const used = [
    ...slots.filter((s) => s.owner === "product" && PRODUCT_SLOT_FEATURE[s.id] && features[PRODUCT_SLOT_FEATURE[s.id]!]),
    ...pluginSlots,
  ];
  const providers = [...new Set(used.flatMap((s) => enabledRoutes(s).map((r) => labelOf(r.connection))))].sort();

  const days = served("memory.retentionDays", "stream-api");
  const secretSet = (key: string) => {
    const v = served(key, "stream-api");
    return typeof v === "string" && v.length > 0;
  };

  return {
    botName: i.botName,
    ai: { ...features, providers, memoryRetentionDays: typeof days === "number" ? days : null },
    youtube: i.youtube,
    payments: {
      stripe: i.stripe, paypal: i.paypal,
      kofi: secretSet("kofi.verificationToken"),
      patreon: secretSet("patreon.webhookSecret"),
      streamlabs: secretSet("streamlabs.socketToken"),
      subscriptions: i.stripe && i.subscriptions,
      points: i.pointsPurchase && (i.stripe || i.paypal),
    },
    currencyName: i.currencyName,
    cloudflare: i.cloudflare,
    homeserverRetention: i.homeserverRetention,
    errorLogDays: i.errorLogDays,
    plugin: i.plugin,
  };
}
