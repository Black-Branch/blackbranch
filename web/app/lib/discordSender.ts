// Is this Matrix sender a Discord bridge ghost?
//
// The bridge writes its own suffix into each ghost's Matrix displayname, and
// matrixDisplay.ts renders rawDisplayName verbatim — so the "(Discord)" a
// viewer sees is the BRIDGE's text, produced on the bridge host, not by this
// codebase. We recognise the sender and show the platform the way every other
// platform is shown, with its glyph.
//
// MODULE CONFIG. Everything here is DERIVED from the
// bridge's own two templates, copied from its config into the install keys
// `discordBridge.usernameTemplate` (`username_template`, e.g. `discord_{{.}}`) and
// `discordBridge.displaynameTemplate` (`displayname_template`). Unset = the module is off: no
// sender is a ghost, no name is altered, and the SQL exclusions exclude nobody.
//
// Keyed on the sender ID, never on the display name. A display name is
// user-controlled and changes; the ghost's localpart is assigned by the bridge
// from `username_template` (`{{.}}` = the Discord user's numeric id).
// (A guessed `@_discord_` — an underscore the bridge never emits — matches
// zero real senders while every test stays green, which is why the fixture in
// discordSender.test.ts is a real row.)
//
// ONE pattern for the whole app. It is POSIX-compatible on purpose, so SQL can
// bind it (`matrix_id !~ $n`) instead of restating it.

import { installValue } from "./installValues.ts";

// Metacharacters of BOTH JavaScript regexes and Postgres AREs — the pattern runs in both.
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type BridgeMatchers = {
  /** POSIX-compatible ghost-id pattern, or null when the module is off. */
  ghostPattern: string | null;
  ghost: RegExp | null;
  /** The bridge's fixed display-name tail (" (Discord)"), anchored to the end. */
  suffix: RegExp | null;
  /** The bot marker followed by that tail ("(bot) (Discord)"), anchored to the end. */
  bot: RegExp | null;
};

/**
 * The matchers a bridge's two templates imply.
 *  · `discord_{{.}}` → `^@discord_[0-9]+:` (any server: a ghost id names its own).
 *  · `{{or .GlobalName .Username}}{{if .Bot}} (bot){{end}} (Discord)` → the tail "(Discord)"
 *    (the text after the last action) and the bot marker "(bot)" (the `{{if .Bot}}` text).
 * A template that does not have that shape yields no matcher for that part, never a guess.
 * @test-only discordSender.test.ts drives it with explicit templates (module on / off /
 * another bridge); the app reads it through the install values below.
 */
export function bridgeMatchers(usernameTemplate: string, displaynameTemplate: string): BridgeMatchers {
  let ghostPattern: string | null = null;
  const parts = usernameTemplate.split("{{.}}");
  if (parts.length === 2 && parts[0]! + parts[1]! !== "") {
    ghostPattern = `^@${escapeRe(parts[0]!)}[0-9]+${escapeRe(parts[1]!)}:`;
  }
  const lastAction = displaynameTemplate.lastIndexOf("}}");
  const tail = lastAction >= 0 ? displaynameTemplate.slice(lastAction + 2).trim() : "";
  const botText = /\{\{\s*if\s+\.Bot\s*\}\}(.*?)\{\{\s*end\s*\}\}/.exec(displaynameTemplate)?.[1]?.trim() ?? "";
  return {
    ghostPattern,
    ghost: ghostPattern ? new RegExp(ghostPattern) : null,
    suffix: tail ? new RegExp(`\\s*${escapeRe(tail)}\\s*$`, "i") : null,
    bot: botText ? new RegExp(`${escapeRe(botText)}\\s*${tail ? escapeRe(tail) + "\\s*" : ""}$`, "i") : null,
  };
}

let built: BridgeMatchers | null = null;
function matchers(): BridgeMatchers {
  return (built ??= bridgeMatchers(installValue("discordBridge.usernameTemplate"), installValue("discordBridge.displaynameTemplate")));
}

/** The ghost-id pattern to bind into SQL (`$n::text IS NULL OR matrix_id !~ $n`), or null when
 *  the bridge module is off. */
export function discordGhostPattern(): string | null {
  return matchers().ghostPattern;
}

export function isDiscordGhost(userId: string): boolean {
  const g = matchers().ghost;
  return g !== null && typeof userId === "string" && g.test(userId);
}

// The bridge appends its own "(Discord)" marker to a ghost's displayname; once
// isDiscordGhost() has confirmed the sender IS a bridge ghost, strip it for
// display. Anchored to the END so a real display name like "Discord Mod" (or
// one with the marker somewhere other than the tail) is left alone.
function stripDiscordSuffix(name: string): string {
  const sfx = matchers().suffix;
  return sfx ? name.replace(sfx, "") : name;
}

// The bridge marks a Discord BOT account in its displayname template —
// `{{if .Bot}} (bot){{end}}` sits directly before the " (Discord)" marker
// ("FixTweet (bot) (Discord)" is a real example). Keyed on that
// marker plus the ghost id, never on a snowflake, so nothing owner-specific
// lives in code. ignoredBots.ts turns this into the account's ignore list.

/** A bridge ghost that stands for a Discord bot account. */
export function isBridgedBot(name: string, userId: string): boolean {
  const bot = matchers().bot;
  return bot !== null && isDiscordGhost(userId) && typeof name === "string" && bot.test(name);
}

export type SenderLabel = { label: string; fromDiscord: boolean };

/** The name to show for a Matrix sender: the bridge's " (Discord)" stripped
 *  when the sender is a bridge ghost, untouched otherwise. Every place that
 *  prints a member's name goes through this so the rule lives once. */
export function senderLabel(name: string, userId: string): SenderLabel {
  const fromDiscord = isDiscordGhost(userId);
  return { label: fromDiscord ? stripDiscordSuffix(name) : name, fromDiscord };
}
