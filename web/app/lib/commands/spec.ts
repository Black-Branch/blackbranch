import { siteName } from "../siteName.ts";
import { installValue } from "../installValues.ts";
import { currencyLabel } from "../currency.ts";
import { HIGHLIGHT_PRICE, TTS_PRICE } from "../coins.ts";
import { PLUGIN_COMMANDS } from "../plugins/commands.ts";
// The canonical `/` command tree.
//
// ONE declaration drives everything: what autocomplete offers, what the hint line
// says, which scope may run a command, and which handler fires. A separate hint
// list and dispatch table drift (commands dispatched but invisible to every
// user); a static test asserts both directions of spec ⇄ handler, so that class
// of drift cannot return.
//
// SCOPE: the site's `/` commands are the mod/admin surface. Twitch, YouTube
// and Kick have their own command languages and keep them — you cannot run site
// moderation from a platform chat, and platform mod commands are not mirrored here.
// `scope` below is UX only: it decides what is offered and what is refused early
// with a clear message. The server's requireMod/requireAdmin remains the actual
// gate.

const PRONOUN_CHOICES = [
  { value: "he/him", desc: "" },
  { value: "she/her", desc: "" },
  { value: "they/them", desc: "" },
  { value: "clear", desc: "remove them" },
];

/** What a leaf accepts, in positional order. */
export type ArgSpec =
  /** A site user. Completes from the same mention candidates as `@user`. */
  | { kind: "user"; name: string; required?: boolean }
  /** "10m", "2h", "30" (bare = minutes). */
  | { kind: "duration"; name: string; default?: string; required?: boolean }
  | { kind: "enum"; name: string; values: { value: string; desc: string }[]; required?: boolean }
  | { kind: "number"; name: string; min?: number; max?: number; unit?: string; required?: boolean }
  /** A single free-form token (a name/key), NOT the rest of the line. */
  | { kind: "word"; name: string; required?: boolean }
  /** Free text, consumes the remainder of the line. */
  | { kind: "text"; name: string; rest: true; required?: boolean };

export type Scope = "all" | "mod" | "admin";

/**
 * A ROUTING leaf. Instead of calling an API, it sends the rest of the line as an
 * ordinary chat message with a ONE-SHOT destination override — `/t hello` posts
 * "hello" to Twitch without touching the sticky `send to:` toggle.
 *
 * Two mechanisms, one for each job: the toggle keeps persistent intent, these
 * are the per-message override.
 */
export type Route = {
  /** Platform id, or null for native site chat. */
  destination: string | null;
  /** Native-only encrypted message. Requires an active Supporter subscription. */
  encrypted?: boolean;
  /**
   * Native-only paid product. `/highlight` and `/tts` are the only route
   * leaves that COST something — see the note beside them below.
   */
  spend?: "highlight" | "tts";
};

/**
 * Handler ids. A closed union so the spec cannot name a handler that does not
 * exist, and `commands.test.ts` can assert the reverse too.
 */
export type HandlerKey =
  | "ban" | "unban" | "timeout" | "purge" | "slowmode"
  | "bansList" | "modLog" | "automodList" | "streamEnd" | "slowmodeList"
  | "setmod" | "unsetmod"
  | "embedAdd" | "embedList" | "embedRemove"
  | "timerControl" | "timerSet" | "timerAdjust" | "timerCap"
  | "barFill" | "barHr" | "barReset"
  | "loopAdd" | "loopList" | "loopRemove"
  | "emotesRefresh" | "emotesForce" | "emotesCheck"
  | "blocklistWord" | "blocklistList" | "whitelistWord" | "whitelistClear"
  | "blocklistHost" | "whitelistHost" | "linkGateSet" | "linkGateStatus"
  | "pronouns"
  | "ignore" | "unignore"
  | "support" | "bugReport"
  | "dm" | "announce"
  | "help";

/**
 * A plugin command's handler id — `<plugin>:<name>`. The colon keeps it
 * apart from every HandlerKey, so the site's own keys stay a closed union; the runner looks these
 * up in the plugin's runners (app/lib/plugins/commandRunners.ts).
 */
export type PluginHandlerKey = `${string}:${string}`;

export type CommandNode = {
  name: string;
  desc: string;
  scope: Scope;
  /** Alternate spellings. Kept so existing muscle memory keeps working. */
  aliases?: string[];
  /**
   * Parses and runs, but is never SUGGESTED. Nothing uses it right now, but it
   * is the mechanism for deprecating a command without breaking it
   * mid-stream, which is worth keeping around.
   */
  hidden?: boolean;
  /** Branch node: sub-commands. Mutually exclusive with `run`. */
  sub?: CommandNode[];
  /** Leaf node: positional arguments. */
  args?: ArgSpec[];
  /** Leaf node: which handler runs it — the site's, or a plugin's. Mutually exclusive with `route`. */
  run?: HandlerKey | PluginHandlerKey;
  /** Leaf node: send the line as chat, with an overridden destination. */
  route?: Route;
};

const DURATION = (name: string, def?: string): ArgSpec => ({ kind: "duration", name, default: def });
const USER: ArgSpec = { kind: "user", name: "user", required: true };
const REASON: ArgSpec = { kind: "text", name: "reason", rest: true };
/** The chat line a routing command carries. Required — `/t` alone is a mistake,
 *  not an instruction, and must be refused rather than sent as an empty message. */
const MESSAGE: ArgSpec = { kind: "text", name: "message", rest: true, required: true };

// The site's own destination is named after the site: its short name as one lower-case word (an
// install called "Example" gets /example), "site" when that word is empty. Its one-letter alias is
// the word's first letter — dropped, like the word itself, when another command already answers to
// it (the check after COMMANDS): dispatch is exact-match, so a collision would shadow a command.
const SITE_WORD = (installValue("site.shortName").trim() || siteName()).toLowerCase().replace(/[^a-z0-9]/g, "") || "site";
const SITE_LEAF: CommandNode = {
  name: SITE_WORD, desc: `Send just this message to ${siteName()}`, scope: "all",
  aliases: [SITE_WORD.slice(0, 1)], route: { destination: null }, args: [MESSAGE],
};

export const COMMANDS: CommandNode[] = [
  // ─── moderation ────────────────────────────────────────────────────────────
  { name: "ban", desc: "Permanently ban a user", scope: "mod", run: "ban", args: [USER, REASON] },
  { name: "unban", desc: "Lift a ban", scope: "mod", run: "unban", args: [USER] },
  // A timeout IS a ban row with an expiry here, so this is the same call — but
  // "untimeout" is what people reach for after "timeout", and Twitch trains it.
  { name: "untimeout", desc: "Lift a timeout", scope: "mod", run: "unban", args: [USER] },
  {
    name: "timeout", desc: "Temporarily ban (default 10m)", scope: "mod", run: "timeout",
    args: [USER, DURATION("duration", "10m"), REASON],
  },
  {
    name: "purge", desc: "Delete a user's recent messages", scope: "mod", run: "purge",
    args: [USER, DURATION("since", "24h")],
  },
  {
    // Two shapes on one command:
    //   /slowmode <seconds|off>              — the whole room
    //   /slowmode <user> <seconds|off> [for] — one person (migrate-v78)
    // The first argument is typed as a `user` so it completes usernames; a number
    // simply matches no username and falls through to the global form.
    name: "slowmode", desc: "Rate-limit chat, or one person", scope: "mod", run: "slowmode",
    args: [
      { kind: "user", name: "user | seconds", required: true },
      { kind: "word", name: "seconds" },
      { kind: "duration", name: "for" },
    ],
  },
  { name: "slowmode-list", desc: "Who is individually rate-limited", scope: "mod", run: "slowmodeList", aliases: ["slowlist"] },
  { name: "bans", desc: "Who is currently banned", scope: "mod", run: "bansList" },
  { name: "modlog", desc: "Recent moderation actions", scope: "mod", run: "modLog" },
  { name: "automod", desc: "Twitch automod-held queue", scope: "mod", run: "automodList" },
  // Everyone's chat column slides it up for 20 s; not Matrix, not encrypted, nothing to answer.
  // `/dm all …` and `/dm everyone …` reach the same handler.
  { name: "announce", desc: "Show a message to everyone here", scope: "mod", aliases: ["everyone"], run: "announce", args: [MESSAGE] },
  // Admins. Also on the user card (Make / Remove moderator) and in the Admin Panel's Moderators.
  { name: "mod", desc: "Make someone a moderator: the Mod Panel, and mod power in the community rooms", scope: "admin", run: "setmod", args: [USER] },
  { name: "unmod", desc: "Remove someone's moderator role and their community room power", scope: "admin", run: "unsetmod", args: [USER] },

  // ─── marathon timer + support bar ──────────────────────────────────────────
  //
  // These exist as site commands so the timer can be driven from here. The
  // Twitch chat commands (!start/!pause/!a/!s, stream-ingest) still work too.
  {
    name: "timer", desc: "Marathon timer", scope: "mod",
    sub: [
      { name: "start", desc: "Start / resume the countdown", scope: "mod", run: "timerControl" },
      { name: "pause", desc: "Pause the countdown", scope: "mod", run: "timerControl" },
      {
        name: "set", desc: "Set the remaining time", scope: "mod", run: "timerSet",
        args: [{ kind: "duration", name: "time", required: true }],
      },
      {
        name: "add", desc: "Add time", scope: "mod", run: "timerAdjust",
        args: [{ kind: "duration", name: "time", required: true }],
      },
      {
        name: "sub", desc: "Subtract time", scope: "mod", run: "timerAdjust",
        args: [{ kind: "duration", name: "time", required: true }],
      },
      {
        name: "cap", desc: "Maximum the timer may reach", scope: "mod", run: "timerCap",
        args: [{ kind: "duration", name: "cap | off", required: true }],
      },
    ],
  },
  {
    name: "stream", desc: "Stream session", scope: "mod",
    sub: [{
      name: "end", desc: "Force the live indicator offline (ends a stuck session)",
      scope: "mod", run: "streamEnd",
    }],
  },
  {
    // `hr` and `fill` live here, not under /timer, because both are the support
    // bar's DOLLAR economics — stream-api stores them as `usdPerHour` and
    // `fillUsd`, and together they decide how many segments the bar has
    // (segments = fill / hr). Only `cap` is genuinely a timer property.
    name: "bar", desc: "Support bar", scope: "mod",
    sub: [
      {
        name: "fill", desc: "Total dollars that fill the bar", scope: "mod", run: "barFill",
        args: [{ kind: "number", name: "dollars", min: 0, unit: "$", required: true }],
      },
      {
        name: "hr", desc: "Dollars that buy one hour on the timer", scope: "mod", run: "barHr",
        args: [{ kind: "number", name: "dollars", min: 0, unit: "$", required: true }],
      },
      { name: "reset", desc: "Zero the bar + timer for a fresh stream", scope: "mod", run: "barReset" },
    ],
  },

  // ─── community rotation ────────────────────────────────────────────────────
  {
    name: "embed", desc: "Community embed rotation", scope: "mod",
    sub: [
      {
        name: "add", desc: "Feature a streamer", scope: "mod", run: "embedAdd",
        args: [{ kind: "text", name: "handle | url", rest: true, required: true }],
      },
      { name: "list", desc: "Show the rotation", scope: "mod", run: "embedList" },
      {
        name: "remove", desc: "Drop a streamer", scope: "mod", run: "embedRemove",
        args: [{ kind: "text", name: "name | UC…", rest: true, required: true }],
      },
    ],
  },

  // ─── community fallback playlist (migrate-v77) ─────────────────────────────
  {
    name: "loop", desc: "Fallback playlist (plays when nobody is live)", scope: "mod",
    sub: [
      {
        name: "add", desc: "Add a YouTube video", scope: "mod", run: "loopAdd",
        args: [{ kind: "text", name: "url | video id", rest: true, required: true }],
      },
      { name: "list", desc: "Show the playlist", scope: "mod", run: "loopList" },
      {
        name: "remove", desc: "Drop a video", scope: "mod", run: "loopRemove",
        args: [{ kind: "text", name: "url | video id | #n", rest: true, required: true }],
      },
    ],
  },

  // ─── the plugin's commands ────────────────────────────────────────────────
  //
  // Whatever the install's plugin adds (app/lib/plugins/commands.ts), in this place in the list —
  // so /help and the suggestions show them here. None without a plugin.
  ...PLUGIN_COMMANDS,

  // ─── emotes ────────────────────────────────────────────────────────────────
  //
  // Backed by /api/mod/emotes, a mod-gated proxy that supplies the internal
  // secret. This is the ONLY manual refresh path.
  {
    name: "emotes", desc: "Emote manifest", scope: "mod",
    sub: [
      { name: "refresh", desc: "Rebuild the manifest now (skip the 30-min TTL)", scope: "mod", run: "emotesRefresh" },
      {
        name: "force", desc: "Rebuild, bypassing the shrink guard", scope: "admin", run: "emotesForce",
      },
      { name: "check", desc: "Dry run — what a refresh would change", scope: "mod", run: "emotesCheck" },
    ],
  },

  // ─── blocklist re-grading ─────────────────────────────────────────────────
  //
  // The shipped term list is code-only, so correcting one word would otherwise
  // need a deploy — while a blocked row correctly offers no Allow button. These
  // two commands are the runtime layer over the shipped list.
  //
  // SUB-COMMANDS, not argument sniffing. `word` vs `host` is explicit:
  // telling them apart by "does it contain a dot" works right up until someone
  // blocklists a phrase that contains one.
  {
    name: "blacklist", desc: "Hold a term for review", scope: "mod",
    sub: [
      {
        // Severity defaults to 3 (HOLD) and is capped there. 4 destroys the
        // message outright and stays a code-level decision — the API refuses it
        // with an explanation, and a DB CHECK backs that up.
        name: "word", desc: "Hold a term (severity 3), or re-grade it", scope: "mod",
        run: "blocklistWord",
        args: [
          { kind: "word", name: "term", required: true },
          { kind: "number", name: "severity", min: 1, max: 3 },
        ],
      },
      {
        name: "host", desc: "Hold links to a domain", scope: "mod", run: "blocklistHost",
        args: [{ kind: "word", name: "domain", required: true }],
      },
      { name: "list", desc: "Show active re-grades", scope: "mod", run: "blocklistList" },
    ],
  },
  {
    name: "whitelist", desc: "Stop a term being filtered", scope: "mod",
    sub: [
      {
        name: "word", desc: "Let a term through (severity 1)", scope: "mod",
        run: "whitelistWord",
        args: [{ kind: "word", name: "term", required: true }],
      },
      {
        // Restores the SHIPPED grading, which for a severity-4 term means
        // messages start being destroyed again — the handler says so. Also the
        // only way to REMOVE a host rule: "x.com" clears the host override,
        // "twink" the word one (the route tells them apart by shape).
        name: "clear", desc: "Drop a word re-grade or host rule", scope: "mod",
        run: "whitelistClear",
        args: [{ kind: "word", name: "term", required: true }],
      },
      {
        name: "host", desc: "Allow links to a domain", scope: "mod", run: "whitelistHost",
        args: [{ kind: "word", name: "domain", required: true }],
      },
      { name: "list", desc: "Show active re-grades", scope: "mod", run: "blocklistList" },
    ],
  },
  {
    // Ships at `off`. This gate is allowlist-based, so arming it with an empty
    // allowlist holds every link in chat — `flag` exists to measure that first.
    name: "linkgate", desc: "Link gate posture", scope: "mod",
    sub: [
      { name: "status", desc: "Posture + how many hosts are configured", scope: "mod", run: "linkGateStatus" },
      {
        name: "set", desc: "off (no gating) · flag (measure only) · hold (enforce)",
        scope: "mod", run: "linkGateSet",
        args: [{
          kind: "enum", name: "posture", required: true,
          values: [
            { value: "off", desc: "no gating at all" },
            { value: "flag", desc: "record what WOULD be held, but deliver it" },
            { value: "hold", desc: "hold links from unlisted hosts for review" },
          ],
        }],
      },
      {
        name: "test", desc: "Would this line be held? (changes nothing)", scope: "mod",
        run: "linkGateStatus", args: [{ kind: "text", name: "line", rest: true }],
      },
    ],
  },

  // ─── destination routing (everyone) ────────────────────────────────────────
  //
  // One-shot overrides of the sticky `send to:` toggle. The single-letter alias
  // is the point — `/t hey` is faster than opening anything — and it is safe
  // because dispatch is EXACT-match: `/t` cannot be swallowed by `/timer` or
  // `/timeout`, and prefix matching is autocomplete-only.
  //
  // `/k` is the platform, NOT a moderation kick (there is no moderation /kick,
  // so the letter is free).
  //
  // These are the ONLY leaves with `route` instead of `run`. They do not call
  // an API — the runner returns a `send` outcome and ChatInput posts it as chat.
  SITE_LEAF,
  {
    name: "twitch", desc: "Send just this message to Twitch", scope: "all",
    aliases: ["t"], route: { destination: "twitch" }, args: [MESSAGE],
  },
      {
    name: "kick", desc: "Send just this message to Kick", scope: "all",
    aliases: ["k"], route: { destination: "kick" }, args: [MESSAGE],
  },
  {
    name: "streamplace", desc: "Send just this message to stream.place", scope: "all",
    aliases: ["s"], route: { destination: "streamplace" }, args: [MESSAGE],
  },
  {
    name: "youtube", desc: "Send just this message to YouTube", scope: "all",
    aliases: ["y"], route: { destination: "youtube" }, args: [MESSAGE],
  },
  {
    // Native by definition — a whole-message redaction never leaves the site,
    // so `destination` is null and there is no platform variant of this.
    // /r is the one short form. NOT Matrix E2EE: the server holds the
    // plaintext and serves it to whoever is entitled to read it.
    name: "redact", desc: "Send one fully redacted message (Supporters)", scope: "all",
    aliases: ["r"], route: { destination: null, encrypted: true }, args: [MESSAGE],
  },
  // These two carry `spend`, so they are the only route leaves that COST
  // something. Native by definition for the same reason /redact is: a bought
  // message never leaves the site.
  {
    name: "highlight", desc: `Highlight this message (${currencyLabel(HIGHLIGHT_PRICE)})`, scope: "all",
    aliases: ["hl"], route: { destination: null, spend: "highlight" }, args: [MESSAGE],
  },
  {
    name: "tts", desc: `Have this message read aloud (${currencyLabel(TTS_PRICE)})`, scope: "all",
    aliases: ["speak"], route: { destination: null, spend: "tts" }, args: [MESSAGE],
  },

  // ─── everyone ──────────────────────────────────────────────────────────────
  {
    // The values only drive completion — stream-api's parser reads whatever is
    // typed (she, she/her, any …). Mods: `/pronouns @name she/her`, checked
    // server-side by /api/mod/pronouns.
    name: "pronouns", desc: "Set your pronouns (shown by your name) — mods: /pronouns @name she/her", scope: "all", run: "pronouns",
    args: [
      { kind: "enum", name: "pronouns", required: true, values: PRONOUN_CHOICES },
      { kind: "enum", name: "pronouns (after @name)", values: PRONOUN_CHOICES },
    ],
  },
  // Behavior: the viewer's OWN
  // hide list — nothing about it is sent to anyone else, so it is not moderation.
  {
    name: "ignore", desc: "Hide someone's messages — only for you", scope: "all", run: "ignore",
    args: [{ kind: "user", name: "name", required: true }],
  },
  {
    // A private, encrypted Matrix conversation in its own window.
    // `all` / `everyone` as the name is an announcement — mods only (run.ts).
    name: "dm", desc: "Message someone privately — opens a window", scope: "all", aliases: ["message"], run: "dm",
    args: [{ kind: "user", name: "name", required: true }, { kind: "text", name: "message", rest: true }],
  },
  {
    name: "unignore", desc: "Show someone you hid again", scope: "all", run: "unignore",
    args: [{ kind: "user", name: "name", required: true }],
  },
  {
    // The help desk. `on`/`off` are handled INSIDE the runner
    // (first-token dispatch) rather than as subcommands: `/support how do I x`
    // must treat "how do I x" as the message, and a sub tree would eat "how"
    // as an unknown subcommand.
    name: "support", desc: "Talk to the help desk — help, reports, bug tickets", scope: "all", run: "support",
    args: [{ kind: "text", name: "message", rest: true }],
  },
  {
    // The fast lane past the front desk: one line, straight
    // into site.support_tickets as a bug — no bubble conversation. Deliberately
    // NOT routed through the support panel, so it works in any composer,
    // whether or not it hosts the panel.
    name: "bug", desc: "File a bug report — one line, straight to the mods", scope: "all", run: "bugReport",
    args: [{ kind: "text", name: "what happened", rest: true, required: true }],
  },
  {
    name: "help", desc: "List commands, or explain one", scope: "all", run: "help",
    args: [{ kind: "text", name: "command", rest: true }],
  },
];

// Keep the site's word and letter from shadowing another command (SITE_WORD above).
{
  const others = COMMANDS.filter((c) => c !== SITE_LEAF).flatMap((c) => [c.name, ...(c.aliases ?? [])]);
  if (others.includes(SITE_LEAF.name)) SITE_LEAF.name = "site";
  SITE_LEAF.aliases = (SITE_LEAF.aliases ?? []).filter((a) => a !== SITE_LEAF.name && !others.includes(a));
}

/** Scope ordering, so `mod` sees `all` and `admin` sees everything. */
export function scopeAllows(viewer: { isMod: boolean; isAdmin: boolean }, scope: Scope): boolean {
  if (scope === "all") return true;
  if (scope === "mod") return viewer.isMod || viewer.isAdmin;
  return viewer.isAdmin;
}

/**
 * Is a ROUTING leaf actually usable by this viewer? Scope alone cannot answer
 * it: `/twitch` is scope "all", but useless to someone with no Twitch linked,
 * and `/redact` is Supporters-only.
 *
 * `undefined` means THE CALLER DID NOT SAY, and is treated as unconstrained.
 * Offering a command that then fails with "link your Twitch account" is a much
 * smaller failure than hiding one that would have worked — and the server is
 * the real gate either way. ChatInput always passes both fields.
 */
export function routeAvailable(
  node: CommandNode,
  v: { dests?: string[]; isSupporter?: boolean },
): boolean {
  const r = node.route;
  if (!r) return true;
  if (r.encrypted) return v.isSupporter !== false;
  if (r.destination === null) return true;   // the site is always a destination
  return !v.dests || v.dests.includes(r.destination);
}

/** Does this token name the node (by name or alias)? Case-insensitive. */
export function nodeMatches(node: CommandNode, token: string): boolean {
  const t = token.toLowerCase();
  return node.name === t || !!node.aliases?.includes(t);
}

/** Every leaf in the tree, with its full path — used by /help and by the tests. */
export function leaves(
  nodes: CommandNode[] = COMMANDS,
  prefix: string[] = [],
): { path: string[]; node: CommandNode }[] {
  const out: { path: string[]; node: CommandNode }[] = [];
  for (const n of nodes) {
    const path = [...prefix, n.name];
    if (n.sub?.length) out.push(...leaves(n.sub, path));
    else out.push({ path, node: n });
  }
  return out;
}

/** "/timer set <time>" — the signature shown while typing. */
export function signature(path: string[], node: CommandNode): string {
  const args = (node.args ?? [])
    .map((a) => {
      const label = a.kind === "enum" ? a.values.map((v) => v.value).join("|") : a.name;
      return a.required ? `<${label}>` : `[${label}]`;
    })
    .join(" ");
  return `/${path.join(" ")}${args ? " " + args : ""}`;
}
