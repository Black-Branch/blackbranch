// What an install's site plugin may add to the site.
//
// The product renders whatever a plugin contributes and nothing when it contributes nothing, so
// every field is optional and every consumer must work with it absent. Product code reads a
// plugin only through this folder (app/lib/plugins/) — never by importing the owner folder.

import type { ComponentType } from "react";
import type { Viewer } from "../commands/parse.ts";
import type { PillRole } from "../tierPills.ts";

/** A plugin's contributions. */
export type WebPlugin = {
  /** Shown in logs and the admin panel. */
  id: string;
  /**
   * The owner-only module switches (config/modules.mjs, kind "owner") this plugin implements.
   * An owner module that no plugin implements is not installed: its switch and settings are hidden.
   */
  ownerModules?: readonly string[];
  /** The per-message scores this install computes. */
  messageScores?: readonly MessageScore[];
  /** What the plugin's own features keep about people, for the privacy policy (/legal). */
  privacy?: PluginPrivacy;
};

/**
 * The privacy policy states only what the product does; a plugin that keeps more about people
 * says so here, in plain sentences, and the policy shows them only on an install that has it.
 */
export type PluginPrivacy = {
  /** Added to "AI-derived data": what the plugin's features derive from chat. */
  derived?: string;
  /** Added to what switching AI memory off does (one list item each). */
  memoryOff?: readonly string[];
  /** Further statements about the plugin's data, one paragraph each. */
  more?: readonly string[];
};

/** What a fallback's player is given by the player area. */
export type FallbackPlayerProps = {
  active: boolean;
  isSignedIn: boolean;
  /** The panel's own collapse (a content-fit player may fold to a strip); persisted per fallback. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
};

/**
 * A REGISTERED FALLBACK player mode: what the player offers when nothing is live and no featured
 * streamer is on — after Live and Community on the rail. The core chain is live → featured →
 * registered fallbacks → the offline card.
 */
export type PlayerFallback = {
  /** Its tab, rail mode and telemetry name. Stored in player_mode, so it must never change. */
  id: string;
  /** The rail's word for it. */
  label: string;
  /** The bottom bar's title while it plays. */
  title: string;
  /** The rail icon (a Phosphor-style component). */
  Icon: ComponentType<{ size?: number; weight?: "fill" }>;
  /** The video panel's sizing class while it is the tab (globals.css). */
  panelClass: string;
  Player: ComponentType<FallbackPlayerProps>;
  /** The module switch (`modules.<id>`, config/modules.mjs) this mode needs. While it is off the
   *  mode is not offered at all: no rail item, no title, no offline landing. */
  module?: string;
};

/** What the chat box hands a console when it mounts one beside the input. */
export type ConsoleHostProps = {
  viewer: Viewer;
  name: string;
  signedIn: boolean;
  roles: string[];
  onShowTimestampsChange?: (v: boolean) => void;
  onShowMatrixNameChange?: (v: boolean) => void;
};

/**
 * A CONSOLE beside the chat box: a window that can run the site's commands and show their long
 * output. With none installed, a bare "/" does nothing special, /help and every command reply
 * print in the chat's notice line, and the chat bar has no console button.
 */
export type ChatConsole = {
  /** Open it; with `text`, print it there as the reply to `cmd`; with `run`, run `cmd` there. */
  open(detail?: { cmd?: string; text?: string; run?: boolean }): void;
  /** Open if closed, close if open (the chat bar's button). */
  toggle(): void;
  /** A command reply too long for the notice line, which the console shows instead. */
  isLongReply(text: string): boolean;
  /** Whether /help runs the console's own help rather than printing chat's list. */
  ownsHelp: boolean;
  /** Mounted beside the chat input. */
  Host: ComponentType<ConsoleHostProps>;
  /** The chat bar's button. */
  button: { label: string; Icon: ComponentType<{ size?: number; weight?: "bold" }> };
};

/** What the Admin Panel hands a registered section. */
export type AdminPanelProps = {
  /** Show a short message in the panel's status line. */
  note: (msg: string) => void;
};

/**
 * An ADMIN PANEL PLACE a plugin adds: one more item in the Admin Panel's rail, inside one of its
 * sections, placed after the item it names (nested under it), shown to admins only. With none
 * registered the Admin Panel has only the product's places.
 */
export type AdminPanelEntry = {
  /** The Admin Panel section it sits in ("ai", "utility", …). */
  section: string;
  /** Its key — the `sub` in the panel's URL. Unique within the section. */
  key: string;
  /** The rail's word for it. Must not be a label the Mod Panel uses. */
  label: string;
  /** The section item it follows and nests under; omitted = the section's end, not nested. */
  after?: string;
  Panel: ComponentType<AdminPanelProps>;
};

/**
 * A SCORE a plugin computes for each chat message: the Chat history's message details show it,
 * and nothing shows a score a plugin does not declare — the public build has none. `key` names
 * the product's own per-message column it is stored in.
 */
export type MessageScore = { key: "karma" | "intelligence"; label: string };

/** What the site's command runner hands a plugin command's runner. */
export type ChatCommandContext = {
  /** The leaf's resolved path, e.g. ["mybot", "on"] — a runner shared by sibling leaves reads which one. */
  path: readonly string[];
  /** Print in the command's output (the chat's notice line, or the console). */
  showNotice: (text: string) => void;
  /** Show (or clear) the command's error line. */
  setSendError: (msg: string | null) => void;
  /**
   * POST (or DELETE) to a site route; a failure is shown in the error line (the route's short
   * answer, else `failMsg`). True when the route answered OK.
   */
  modFetch: (url: string, body: unknown, failMsg: string, method?: "POST" | "DELETE") => Promise<boolean>;
};

/**
 * Runs one PLUGIN COMMAND leaf with its positional argument values (rest-joined). A plugin adds
 * commands as CommandNode trees whose leaves' `run` is a `<plugin>:<name>` key
 * (`@owner/commands`), and the runners by those keys (`@owner/commandRunners`). The site's runner
 * checks scope and required arguments first, exactly as for its own commands.
 */
export type ChatCommandRunner = (args: string[], ctx: ChatCommandContext) => Promise<void>;

/** A profile payload as a plugin reads it: the card's fields, by name. */
export type ProfileFacts = Readonly<Record<string, unknown>>;

/**
 * What a plugin adds to a person's profile cards (`profileExtras`), read from the card's profile
 * payload (/api/user/[id], stream-api's data). Each part is optional: without it the cards show
 * no such pill and no read.
 */
export type ProfileExtras = {
  /**
   * One more descriptor: a toned pill among the user card's tier pills (after the regularity tier),
   * and `label: value` among the own-profile card's stat pills.
   */
  descriptor?: {
    label: string;
    value: (profile: ProfileFacts) => string;
    /** The pill's colour for a value; neutral when absent. The values are the plugin's own
     *  vocabulary, so the product cannot colour them. */
    tone?: (value: string) => PillRole;
  };
  /** A sentence-long read of the person, shown under the pills; null for none. */
  read?: (profile: ProfileFacts) => string | null;
  /**
   * Extra fields of stream-api's /user/lookup this plugin's pill or read needs on the card, by
   * name. The product's public profile is a fixed list (publicProfile.ts); these are forwarded on
   * top of it only on an install that carries this plugin, and only with the merged stats (never
   * to a caller who may not see the person's cross-platform link). Some names are never
   * forwarded whatever a plugin declares (publicProfile.ts NEVER_FORWARDED).
   */
  publicFields?: readonly string[];
};

/** What the rig page (the OBS browser source, /overlay/rig) hands an avatar. */
export type RigAvatarProps = {
  /** The bot is speaking or has speech queued — the avatar is on screen. */
  speaking: boolean;
  /** A spoken clip is playing at this moment — the mouth moves. */
  talking: boolean;
};
/** An install's own avatar for the rig page, in place of the product's default. */
export type RigAvatar = ComponentType<RigAvatarProps>;
