// The Admin Panel's layout as data: its sections, each section's sub-tabs, and where every
// instance key lives. Pure, so adminLayout.test.ts can prove nothing falls out of the panel.

import { SETUP_GUIDES } from "../../lib/setup/setupGuideMap.ts";
import { INSTANCE_KEYS } from "../../lib/instanceSchema.generated.mjs";
import type { PanelPlace } from "../../lib/panelSearch.ts";

/** The sections, in order — the rail's groups (adminRail walks them).
 *  @test-only adminLayout.test.ts walks every section's cards through it; the panel reads the
 *  sections through adminRail, in this file. */
export const ADMIN_SECTIONS = [
  { key: "ai", label: "AI" },
  { key: "utility", label: "Utility" },
  { key: "payments", label: "Payments" },
  { key: "platforms", label: "Platforms" },
  { key: "site", label: "Site" },
  // The doctor's checks.
  { key: "doctor", label: "Doctor" },
  // The update channel.
  { key: "updates", label: "Updates" },
] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number]["key"];

/** Where the panel opens when nothing names a place: the site's own settings, not AI. */
export const ADMIN_HOME: AdminSection = "site";

const AI_SUBS = [
  { key: "models", label: "Models" },
  { key: "bot", label: "Chat Bot" },
  { key: "scoring", label: "Scoring" },
  { key: "automod", label: "Automod" },
  { key: "helpdesk", label: "Help Desk" },
  { key: "embeddings", label: "Embeddings" },
] as const;
export type AiSub = (typeof AI_SUBS)[number]["key"];

/** One place in a section. `depth: 1` nests it under the place before it in the rail. */
export type AdminSub = { key: string; label: string; depth?: 0 | 1 };

/** Sub-tabs per section. An empty list = the section is one page of its own (Doctor, Updates).
 *  @test-only adminLayout.test.ts walks every section's places through it; the panel reads them
 *  through adminRail in this file (and an install's own tools may read it too). */
export const SUBS: Record<AdminSection, readonly AdminSub[]> = {
  ai: AI_SUBS,
  // The timer, the support bar and the stream effects live in OBS's own sub-sections, not the mod
  // panel.
  utility: [
    { key: "obs", label: "OBS" },
    { key: "timer", label: "Timer", depth: 1 },
    { key: "bar", label: "Support bar", depth: 1 },
    { key: "effects", label: "Effects", depth: 1 },
    { key: "tts", label: "TTS" },
    // The stream-api overlay pages and how to add them to OBS (the setup pages do not carry OBS).
    { key: "overlays", label: "Overlays" },
  ],
  // "Payment history", not "History": no label is in both panels (the mod panel has Mod history).
  payments: [{ key: "history", label: "Payment history" }, { key: "connections", label: "Connections" }],
  // The Stream tab's embed switches have their home here too.
  platforms: [
    { key: "player", label: "Player" },
    { key: "youtube", label: "YouTube" }, { key: "twitch", label: "Twitch" }, { key: "kick", label: "Kick" },
    { key: "streamplace", label: "Streamplace" }, { key: "discord", label: "Discord" },
  ],
  // The site currency has its own screen beside the site's cards.
  // Every module switch, one list.
  // Badges and Support tickets live here, not in the mod panel.
  site: [
    { key: "general", label: "Site" }, { key: "points", label: "Points" }, { key: "modules", label: "Modules" },
    { key: "badges", label: "Badges" }, { key: "tickets", label: "Support tickets" }, { key: "moderators", label: "Moderators" },
  ],
  doctor: [],
  updates: [],
};

/** A plugin's Admin Panel place, as the layout reads it (app/lib/plugins/types.ts AdminPanelEntry). */
export type PluginPlace = { section: string; key: string; label: string; after?: string };

/** One item of the Admin Panel's rail: a section's place (or a section of its own). */
export type AdminRailItem = {
  /** `<section>/<sub>`, or the section alone when it has no places. */
  id: string;
  section: AdminSection;
  sub: string | null;
  label: string;
  group: string;
  depth: 0 | 1;
  /** Registered by the install's plugin. */
  plugin: boolean;
};

const ADMIN_GROUP: Record<AdminSection, string> = {
  ai: "AI", utility: "Utility", payments: "Payments", platforms: "Platforms", site: "Site", doctor: "Install", updates: "Install",
};

/** The whole rail, in order: every section's places, with the plugin's places after the one each
 *  names (nested under it) — or at the section's end. Doctor and Updates are one item each. */
export function adminRail(plugins: readonly PluginPlace[] = []): AdminRailItem[] {
  const out: AdminRailItem[] = [];
  for (const sec of ADMIN_SECTIONS) {
    const group = ADMIN_GROUP[sec.key];
    if (!SUBS[sec.key].length) {
      out.push({ id: sec.key, section: sec.key, sub: null, label: sec.label, group, depth: 0, plugin: false });
      continue;
    }
    const mine = plugins.filter((p) => p.section === sec.key && !SUBS[sec.key].some((x) => x.key === p.key));
    const items: AdminRailItem[] = SUBS[sec.key].map((x) => ({ id: `${sec.key}/${x.key}`, section: sec.key, sub: x.key, label: x.label, group, depth: x.depth ?? 0, plugin: false }));
    for (const p of mine) {
      const item: AdminRailItem = { id: `${sec.key}/${p.key}`, section: sec.key, sub: p.key, label: p.label, group, depth: p.after ? 1 : 0, plugin: true };
      const at = p.after ? items.findIndex((x) => x.sub === p.after) : -1;
      if (at < 0) items.push({ ...item, depth: 0 });
      else {
        // After the named place AND anything already nested under it.
        let end = at + 1;
        while (end < items.length && items[end]!.depth === 1) end++;
        items.splice(end, 0, item);
      }
    }
    out.push(...items);
  }
  return out;
}

/** The rail item a URL names (`/admin/<section>?sub=<sub>`), or the section's first place. */
export function adminItemFor(items: readonly AdminRailItem[], section: AdminSection, sub: string | null | undefined): AdminRailItem {
  return items.find((x) => x.section === section && (sub ? x.sub === sub : true))
    ?? items.find((x) => x.section === section)
    ?? items[0]!;
}

/** The URL of a rail item — the page form keeps it in the address bar. */
export function adminHref(item: Pick<AdminRailItem, "section" | "sub">): string {
  return item.sub ? `/admin/${item.section}?sub=${encodeURIComponent(item.sub)}` : `/admin/${item.section}`;
}

const KEY_LABEL = new Map<string, string>((INSTANCE_KEYS as readonly { key: string; label?: string }[]).map((e) => [e.key, e.label ?? ""]));
// Each key's hint (its description) is searched too.
const KEY_HINT = new Map<string, string>((INSTANCE_KEYS as readonly { key: string; description?: string }[]).map((e) => [e.key, e.description ?? ""]));

/** Words the search also matches for a place with no key cards of its own. */
const EXTRA_WORDS: Record<string, string> = {
  "ai/models": "anthropic openai model provider key", "ai/bot": "bot name account trigger speak",
  "ai/scoring": "sentiment temperament intelligence score", "ai/automod": "moderation classify model",
  "ai/helpdesk": "help desk support answers", "ai/embeddings": "memory vectors embed",
  "utility/timer": "subathon clock countdown", "utility/bar": "goal meter colours shape",
  "utility/effects": "alerts sounds lights scene", "utility/overlays": "obs browser source alert support bar meter bubble poll sticker", "payments/history": "refunds failures totals donations",
  "platforms/player": "embed embeds sources watch page", "site/badges": "badge price unlock", "site/tickets": "help requests bug reports", "site/points": "currency store prices",
  doctor: "health checks logs", updates: "release version upgrade",
};

/** The rail items a search matches: the place's name, its group, its cards' titles and every key's
 *  label, name and hint on it. An empty query matches everything. */
export function adminSearch(items: readonly AdminRailItem[], query: string): AdminRailItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((it) => {
    const groups = KEY_GROUPS.filter((g) => g.section === it.section && g.sub === it.sub);
    const hay = [
      it.label, it.group, EXTRA_WORDS[it.id] ?? "",
      ...groups.flatMap((g) => [g.title, g.blurb ?? "", ...g.keys, ...g.keys.map((k) => KEY_LABEL.get(k) ?? ""), ...g.keys.map((k) => KEY_HINT.get(k) ?? "")]),
    ].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

/** The Admin Panel places a query matches, for the mod panel's search. An
 *  empty query lists nothing — the other panel shows only search results. */
export function adminPlacesFor(query: string, plugins: readonly PluginPlace[] = []): PanelPlace[] {
  if (!query.trim()) return [];
  return adminSearch(adminRail(plugins), query).map((x) => ({ panel: "admin", id: x.id, label: x.label, group: x.group }));
}

/** The section + sub an Admin Panel place id names (`ai/bot` → ai, bot). */
export function adminPlaceParts(id: string): { section: AdminSection; sub: string | null } | null {
  const [section, sub] = id.split("/");
  return section && isAdminSection(section) ? { section, sub: sub ?? null } : null;
}

export function isAdminSection(s: string): s is AdminSection {
  return ADMIN_SECTIONS.some((x) => x.key === s);
}

/** One card of key rows: which section and sub-tab it sits in, its title, its keys in order. */
/** `ownerOnly`: shown only on an install with a site plugin (the OBS WebSocket path). */
export type KeyGroup = { section: AdminSection; sub: string | null; title: string; blurb?: string; keys: readonly string[]; ownerOnly?: boolean };

/** Every card, in order — the move table as code.
 *  @test-only adminLayout.test.ts checks every card against the schema and the sub-tab list; the
 *  panel itself reads cards through keyGroupsFor. */
export const KEY_GROUPS: readonly KeyGroup[] = [
  { section: "ai", sub: "models", title: "Built-in connection keys", blurb: "The keys for the built-in Anthropic and OpenAI connections above.", keys: ["anthropic.apiKey", "openai.apiKey"] },
  { section: "ai", sub: "bot", title: "Accounts", keys: ["bot.matrixId", "chat.botUsernames"] },

  { section: "utility", sub: "obs", title: "Timer", blurb: "The rig page reports OBS's scene; the timer pauses on this one.", keys: ["timer.pauseScene"] },
  { section: "utility", sub: "obs", title: "OBS WebSocket", blurb: "For a server on the same network as OBS: it adds showing and hiding OBS's own sources.", keys: ["obs.url", "obs.password"], ownerOnly: true },
  { section: "utility", sub: "obs", title: "Scenes and sources", blurb: "Used through the OBS WebSocket. OBS finds these by name, so each must match OBS exactly. A name left empty switches off only what it drives.", keys: ["obs.soundSource", "obs.botScene", "obs.botSource", "obs.botShowScene"], ownerOnly: true },
  { section: "utility", sub: "obs", title: "Room lights", blurb: "Used while the room lights module is on (Site → Modules).", keys: ["homeassistant.url", "homeassistant.token"] },
  { section: "utility", sub: "tts", title: "Voice", keys: ["tts.enabled", "elevenlabs.apiKey", "tts.voiceCasual", "tts.voiceLoud"] },
  { section: "utility", sub: "tts", title: "Playback", keys: ["tts.sink", "tts.dualVoice", "tts.clipsDir"] },

  { section: "payments", sub: "connections", title: "Stripe", keys: ["stripe.secretKey", "stripe.publishableKey", "stripe.webhookSecret", "stripe.supporterPriceId"] },
  { section: "payments", sub: "connections", title: "PayPal", keys: ["paypal.env", "paypal.clientId", "paypal.clientSecret", "paypal.webhookId", "paypal.plans"] },
  { section: "payments", sub: "connections", title: "Other", blurb: "Patreon, Ko-fi and Streamlabs.", keys: ["patreon.webhookSecret", "kofi.verificationToken", "streamlabs.socketToken"] },
  { section: "payments", sub: "connections", title: "Links", blurb: "Where support links point outside the site.", keys: ["money.subscribeUrl", "money.supportLine", "site.donateUrl"] },

  { section: "platforms", sub: "player", title: "Player", blurb: "Which live sources the watch page offers. The Stream tab switches the same setting.", keys: ["player.embedsOff"] },
  { section: "platforms", sub: "youtube", title: "YouTube", keys: ["platform.youtube.channelId", "platform.youtube.vodPlaylist", "youtube.apiKey", "youtube.oauthClientId", "youtube.oauthClientSecret"] },
  { section: "platforms", sub: "twitch", title: "Twitch", keys: ["platform.twitch.channel", "platform.twitch.broadcasterId", "twitch.clientId", "twitch.clientSecret"] },
  { section: "platforms", sub: "kick", title: "Kick", keys: ["platform.kick.slug", "platform.kick.userId", "kick.clientId", "kick.clientSecret", "kick.chatroomId", "kick.channelId"] },
  { section: "platforms", sub: "streamplace", title: "Streamplace", keys: ["platform.streamplace.did", "platform.streamplace.channel"] },
  { section: "platforms", sub: "discord", title: "Discord", blurb: "The Discord bridge on the community server.", keys: ["discordBridge.usernameTemplate", "discordBridge.displaynameTemplate"] },

  // The streamer's name first: the one row here a new install edits (the Site card's rows are set
  // where the site is built).
  { section: "site", sub: "general", title: "Streamer", keys: ["streamer.displayName", "streamer.matrixId", "staff.extraMatrixIds"] },
  { section: "site", sub: "general", title: "Site", keys: ["site.name", "site.shortName", "site.description", "site.tagline", "site.homeHeading", "site.homeIntro", "site.iconSet", "site.origin", "site.apiOrigin", "site.apiWsOrigin", "site.legacyId"] },
  { section: "site", sub: "general", title: "Legal", blurb: "Who runs the site, as the Terms, Privacy and About pages name it (set where the site is built), and the liability cap the Terms state (changed here).", keys: ["legal.operator", "legal.contactEmail", "legal.governingLaw", "legal.effectiveDate", "legal.liabilityCapUsd"] },
  { section: "site", sub: "general", title: "Community server", blurb: "Federation lets other Matrix servers exchange messages with this community's rooms. It does not decide who may sign in here — the next card does.", keys: ["matrix.serverName", "matrix.baseUrl", "matrix.federationServer", "matrix.legacyNamespace", "matrix.federation", "matrix.registration", "matrix.rooms.hub", "matrix.rooms.general", "matrix.oauth.issuer", "matrix.oauth.clientId", "matrix.oauth.clientSecret"] },
  { section: "site", sub: "general", title: "Sign-in from other servers", blurb: "Who may sign in HERE with an account made on another Matrix server — not federation, which is about servers exchanging messages. This site's own server always signs in. Server names are matched exactly; a change applies at once, to people already signed in too.", keys: ["auth.federatedSignin", "auth.federatedAllow", "auth.federatedDeny"] },
  { section: "site", sub: "general", title: "Health", blurb: "Where alerts for whoever runs the site are pushed.", keys: ["ntfy.wakeUrl", "ntfy.quietUrl"] },
  { section: "site", sub: "general", title: "Running the site", blurb: "Set during setup; change them here.", keys: ["site.timeZone", "site.dataSince", "updates.quietHour", "bugReports.enabled"] },
  { section: "site", sub: "general", title: "Backups", blurb: "Where the nightly backup goes. A change applies at the next backup; run blackbranch backup on the server to try it now.", keys: ["backup.target", "backup.repository", "backup.s3.region", "backup.s3.accessKeyId", "backup.s3.secretAccessKey", "backup.keepDaily", "backup.keepWeekly"] },

  // Site → Points. The Store prices card is PointsPanel's own (it is a table, not keys).
  { section: "site", sub: "points", title: "Name and look", blurb: "What people read wherever points show. Set where the site is built.", keys: ["currency.name", "currency.namePlural", "currency.symbol", "currency.icon", "community.scoreName"] },
  { section: "site", sub: "points", title: "Buying", keys: ["currency.purchasable"] },
  { section: "site", sub: "points", title: "Earning", blurb: "What each kind of taking part pays, and the caps on it. Changes apply to the next award.", keys: [
    "currency.earn.firstMessage", "currency.earn.message", "currency.earn.messageCooldownMinutes",
    "currency.earn.voteCast", "currency.earn.votesPerStream",
    "currency.earn.upvoteReceived", "currency.earn.paidUpvotesPerVoter",
    "currency.earn.watchCap", "currency.earn.watchMinutesPerPoint", "currency.earn.clockMultiplier",
  ] },

  // Site → Modules. Off = not started and its addresses answer "not found"; a switch
  // applies when the chat service restarts. Each module's own settings stay in their section.
  { section: "site", sub: "modules", title: "Modules", blurb: "Parts of the site that can be switched off. A module is on once the service that runs it restarts with its switch on, and the website shows it from that service's report — the radio tab follows the chat service's restart. Card payments and PayPal, which only the website reads, apply at once.", keys: ["modules.obs", "modules.lights", "modules.meter", "modules.radio", "modules.youtube", "modules.stripe", "modules.paypal"] },
];

export function guidesFor(section: AdminSection, sub: string | null): string[] {
  // SETUP_GUIDES lives beside the server code that builds the guides (lib/setup/setupGuides.ts).
  return SETUP_GUIDES.filter((g) => g.section === section && g.sub === sub).map((g) => g.list);
}

export function keyGroupsFor(section: AdminSection, sub: string | null, ownerPlugin = true): KeyGroup[] {
  return KEY_GROUPS.filter((g) => g.section === section && g.sub === sub && (ownerPlugin || !g.ownerOnly));
}

// `radio`: the radio DJ is not one of the layout's AI features, so it shows under Models → Other tasks.
const AI_PREFIX: Record<string, AiSub> = { bot: "bot", automod: "automod", helpdesk: "helpdesk", embeddings: "embeddings", score: "scoring", radio: "models" };

/** The AI sub-tab a task (or a plugin's prompt) belongs to, by the first part of its id. An
 *  unmatched plugin task goes with the chat bot; an unmatched product task goes to Models. */
export function aiSubOf(id: string, group: "product" | "plugin"): AiSub {
  return AI_PREFIX[id.split(".")[0] ?? ""] ?? (group === "plugin" ? "bot" : "models");
}

/** Plain names for the three services, shown wherever a per-service status is listed. */
const SERVICE_NAME: Record<string, string> = {
  web: "website",
  "stream-api": "chat service",
  "stream-ingest": "ingest service",
};
export function serviceName(pkg: string): string {
  return SERVICE_NAME[pkg] ?? pkg;
}
