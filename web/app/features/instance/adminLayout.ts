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
  ],
  // "Payment history", not "History": no label is in both panels (the mod panel has Mod history).
  payments: [{ key: "history", label: "Payment history" }, { key: "connections", label: "Connections" }],
  // The Stream tab's embed switches have their home here too.
  platforms: [
    { key: "player", label: "Player" },
    { key: "youtube", label: "YouTube" }, { key: "twitch", label: "Twitch" }, { key: "kick", label: "Kick" },
    { key: "streamplace", label: "Streamplace" }, { key: "discord", label: "Discord" }, { key: "emotes", label: "Emotes" },
  ],
  // The site currency has its own screen beside the site's cards.
  // Badges and Support tickets live here, not in the mod panel.
  site: [
    { key: "general", label: "Site" }, { key: "points", label: "Points" }, { key: "leaderboard", label: "Leaderboard" },
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
  "utility/timer": "subathon clock countdown", "utility/bar": "goal colours shape overlay",
  "utility/effects": "alerts sounds overlay", "utility/obs": "obs browser source overlay rig bubble poll sticker", "payments/history": "refunds failures totals donations",
  "platforms/player": "embed embeds sources watch page", "site/badges": "badge price unlock", "site/tickets": "help requests bug reports", "site/points": "currency store prices", "site/leaderboard": "boards ranks home top", "platforms/emotes": "7tv bttv ffz emote sets refresh",
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
export type KeyGroup = {
  section: AdminSection; sub: string | null; title: string; blurb?: string; keys: readonly string[]; ownerOnly?: boolean;
  /** Every row shown, none edited here: the values the install was made with. */
  readOnly?: boolean;
  /** Under the page's Advanced fold. */
  advanced?: boolean;
  /** A read-only card's own line for each row, in place of "set it on the server" (a value the
   *  server finds itself, which no setting changes). */
  readOnlyNote?: string;
  /** The card starts closed (a fold with its title as the summary). */
  folded?: boolean;
  /** Rows shown only once they hold a value (a fresh install never sets them). */
  hideUnset?: readonly string[];
  /** Rows shown only while another key holds one of these values. */
  onlyWhen?: Readonly<Record<string, { key: string; is: readonly string[] }>>;
};

/** Keys no card shows, each with why. Every other key the Credentials page lists is on exactly one
 *  card.
 *  @test-only adminLayout.test.ts holds every other key to exactly one card and each of these to a reason. */
export const UNPLACED: Readonly<Record<string, string>> = {
  "bugReports.enabled": "nothing sends bug reports yet; shown once a sender exists",
  "youtube.oauthClientId": "for posting into YouTube chat, which ships in a later release",
  "youtube.oauthClientSecret": "for posting into YouTube chat, which ships in a later release",
  // The owner's modules and the OBS WebSocket path are the owner plugin's, set on the server.
  "modules.lights": "an owner module, switched on the server (MODULE_LIGHTS)",
  "modules.meter": "an owner module, switched on the server (MODULE_METER)",
  "modules.radio": "an owner module, switched on the server (MODULE_RADIO)",
  "homeassistant.url": "the owner's room lights, set on the server",
  "homeassistant.token": "the owner's room lights, set on the server",
  "obs.url": "the OBS WebSocket path, which the product does not use (the rig page replaces it)",
  "obs.password": "the OBS WebSocket path, which the product does not use (the rig page replaces it)",
  "obs.soundSource": "the OBS WebSocket path, which the product does not use (the rig page replaces it)",
  "obs.botScene": "the OBS WebSocket path, which the product does not use (the rig page replaces it)",
  "obs.botSource": "the OBS WebSocket path, which the product does not use (the rig page replaces it)",
  "obs.botShowScene": "the OBS WebSocket path, which the product does not use (the rig page replaces it)",
};

/** Every card, in order — the move table as code.
 *  @test-only adminLayout.test.ts checks every card against the schema and the sub-tab list; the
 *  panel itself reads cards through keyGroupsFor. */
export const KEY_GROUPS: readonly KeyGroup[] = [
  { section: "ai", sub: "models", title: "Built-in connection keys", blurb: "The keys for the built-in Anthropic and OpenAI connections above.", keys: ["anthropic.apiKey", "openai.apiKey"] },
  { section: "ai", sub: "bot", title: "Accounts", keys: ["bot.matrixId"] },
  { section: "ai", sub: "bot", title: "Bot usernames", keys: ["chat.botUsernames"], advanced: true },

  // Each module's switch sits on its own feature's page; there is no Modules tab.
  { section: "utility", sub: "obs", title: "OBS", keys: ["modules.obs"] },
  { section: "utility", sub: "obs", title: "Timer", blurb: "The rig page reports OBS's scene; the timer pauses on this one.", keys: ["timer.pauseScene"] },
  { section: "utility", sub: "tts", title: "Voice", keys: ["tts.enabled", "elevenlabs.apiKey", "tts.voiceCasual", "tts.voiceLoud"] },
  { section: "utility", sub: "tts", title: "Playback", keys: ["tts.sink", "tts.dualVoice", "tts.clipsDir"] },

  { section: "payments", sub: "connections", title: "Stripe", keys: ["modules.stripe", "stripe.secretKey", "stripe.publishableKey", "stripe.webhookSecret", "stripe.supporterPriceId"] },
  { section: "payments", sub: "connections", title: "PayPal", keys: ["modules.paypal", "paypal.env", "paypal.clientId", "paypal.clientSecret", "paypal.webhookId", "paypal.plans"] },
  { section: "payments", sub: "connections", title: "Other", blurb: "Patreon, Ko-fi and Streamlabs.", keys: ["patreon.webhookSecret", "kofi.verificationToken", "streamlabs.socketToken"] },
  { section: "payments", sub: "connections", title: "Links", blurb: "Where support links point outside the site.", keys: ["money.subscribeUrl", "money.supportLine", "site.donateUrl"] },

  { section: "platforms", sub: "player", title: "Player", blurb: "Which live sources the watch page offers. The Stream tab switches the same setting.", keys: ["player.embedsOff"] },
  { section: "platforms", sub: "youtube", title: "YouTube", keys: ["modules.youtube", "platform.youtube.channelId", "platform.youtube.vodPlaylist", "youtube.apiKey"] },
  { section: "platforms", sub: "twitch", title: "Twitch", keys: ["platform.twitch.channel", "platform.twitch.broadcasterId", "twitch.clientId", "twitch.clientSecret"] },
  { section: "platforms", sub: "kick", title: "Kick", keys: ["platform.kick.slug", "platform.kick.userId", "kick.clientId", "kick.clientSecret", "kick.chatroomId", "kick.channelId"] },
  { section: "platforms", sub: "streamplace", title: "Streamplace", keys: ["platform.streamplace.did", "platform.streamplace.channel"] },
  { section: "platforms", sub: "discord", title: "Discord", blurb: "The Discord bridge on the community server.", keys: ["discordBridge.usernameTemplate", "discordBridge.displaynameTemplate"] },

  // The streamer's name first: the one row here a new install edits from the start.
  { section: "site", sub: "general", title: "Streamer", keys: ["streamer.displayName", "streamer.matrixId"] },
  { section: "site", sub: "general", title: "Site", keys: ["site.name", "site.shortName", "site.description", "site.tagline", "site.homeHeading", "site.homeIntro", "site.iconSet"] },
  { section: "site", sub: "general", title: "Legal", blurb: "Who runs the site, as the Terms, Privacy and About pages name it, and the liability cap the Terms state.", keys: ["legal.operator", "legal.contactEmail", "legal.governingLaw", "legal.effectiveDate", "legal.liabilityCapUsd"] },
  // Federation and sign-in from other servers are two cards on purpose: they read as one switch
  // when they share a heading, and they are not one.
  { section: "site", sub: "general", title: "Community", blurb: "Federation lets other Matrix servers exchange messages with this community's rooms. It does not decide who may sign in here: the next card does.", keys: ["matrix.federation", "matrix.registration"] },
  { section: "site", sub: "general", title: "Sign-in from other servers", blurb: "Who may sign in HERE with an account made on another Matrix server. This is not federation, which is about servers exchanging messages. This site's own server always signs in. Server names are matched exactly; a change applies at once, to people already signed in too.", keys: ["auth.federatedSignin", "auth.federatedAllow", "auth.federatedDeny"] },
  // The two rooms the server's community setup made. The installer passes neither id to any
  // service: `blackbranch matrix bootstrap` records them in the database. Facts, not settings.
  { section: "site", sub: "general", title: "Community rooms", readOnly: true,
    blurb: "The community space and #general, as the server made them.",
    readOnlyNote: "Found by the server when it made the community. Nothing to change here.",
    keys: ["matrix.rooms.hub", "matrix.rooms.general"] },
  { section: "site", sub: "general", title: "Alerts to your phone", blurb: "Where alerts for whoever runs the site are pushed: urgent ones and quiet ones.", keys: ["ntfy.wakeUrl", "ntfy.quietUrl"] },
  { section: "site", sub: "general", title: "Running the site", keys: ["site.timeZone", "site.dataSince", "updates.quietHour"] },
  { section: "site", sub: "general", title: "Backups", blurb: "Where the nightly backup goes. A change applies at the next backup; run sudo blackbranch backup on the server to try it now.",
    keys: ["backup.target", "backup.repository", "backup.s3.region", "backup.s3.accessKeyId", "backup.s3.secretAccessKey", "backup.keepDaily", "backup.keepWeekly"],
    onlyWhen: Object.fromEntries(["backup.s3.region", "backup.s3.accessKeyId", "backup.s3.secretAccessKey"].map((k) => [k, { key: "backup.target", is: ["s3"] }])) },
  // Every value the install was made with, in one closed card at the bottom: the addresses, the
  // homeserver and its sign-in client, the two rooms the bootstrap made. Changed on the server.
  { section: "site", sub: "general", title: "Install values", folded: true, readOnly: true,
    blurb: "Set when this site was installed. To change one, change it on the server, then restart the site.",
    keys: ["site.origin", "site.apiOrigin", "site.apiWsOrigin", "matrix.serverName", "matrix.baseUrl", "matrix.federationServer",
      "matrix.oauth.issuer", "matrix.oauth.clientId", "matrix.oauth.clientSecret", "site.legacyId", "matrix.legacyNamespace"],
    hideUnset: ["site.legacyId", "matrix.legacyNamespace"] },

  // Site → Leaderboard: Home's Leaderboard on or off, and which boards it offers.
  { section: "site", sub: "leaderboard", title: "Leaderboard", keys: ["leaderboard.off", "leaderboard.hidden"] },

  // Site → Moderators: the accounts treated as staff besides the streamer and the bot.
  { section: "site", sub: "moderators", title: "Staff", keys: ["staff.extraMatrixIds"] },

  // Site → Points. The Store prices card is PointsPanel's own (it is a table, not keys).
  { section: "site", sub: "points", title: "Name and look", blurb: "What people read wherever points show.", keys: ["currency.name", "currency.namePlural", "currency.symbol", "currency.icon", "community.scoreName"] },
  { section: "site", sub: "points", title: "Buying", keys: ["currency.purchasable"] },
  { section: "site", sub: "points", title: "Earning", blurb: "What each kind of taking part pays, and the caps on it. Changes apply to the next award.", keys: [
    "currency.earn.firstMessage", "currency.earn.message", "currency.earn.messageCooldownMinutes",
    "currency.earn.voteCast", "currency.earn.votesPerStream",
    "currency.earn.upvoteReceived", "currency.earn.paidUpvotesPerVoter",
    "currency.earn.watchCap", "currency.earn.watchMinutesPerPoint", "currency.earn.clockMultiplier",
  ] },

];

/** A key as a card reads it: what each service holds. */
type CardKey = { key: string; packages: readonly { package: string; display?: unknown }[] };

/** What a key holds now: the website's value where it reads the key, else the first service's. */
function heldValue(k: CardKey): unknown {
  return (k.packages.find((p) => p.package === "web") ?? k.packages[0])?.display ?? null;
}
const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** The rows a card shows, in its order: keys this install has (an owner-only module's keys need the
 *  site plugin), minus a `hideUnset` key that holds nothing and an `onlyWhen` key whose condition
 *  does not hold. */
export function shownKeys<K extends CardKey>(g: KeyGroup, keys: readonly K[], installed: (key: string) => boolean = () => true): K[] {
  const byKey = new Map(keys.map((k) => [k.key, k]));
  return g.keys.filter(installed).map((key) => byKey.get(key)).filter((k): k is K => {
    if (!k) return false;
    if (g.hideUnset?.includes(k.key) && isEmpty(heldValue(k))) return false;
    const when = g.onlyWhen?.[k.key];
    if (when) {
      const other = byKey.get(when.key);
      if (!other || !when.is.includes(String(heldValue(other) ?? ""))) return false;
    }
    return true;
  });
}

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
