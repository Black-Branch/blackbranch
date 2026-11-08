// The channels the setup pages list (spec 2026-10-23 §4.6). The community starts with #general and
// #forum, which the setup step's bootstrap makes (install/matrix/bootstrap.mjs). The rest of the
// list waits in community.setupChannels: a channel row needs its home's row, and the home's row is
// written only when the reconciler first takes the community's home into the Community page
// (adoptServer.ts). That import writes these rows with it; the reconciler's next run makes them.
import type { PostRule, RoomKind } from "./desired.ts";
import { orderKeyBetween } from "./desired.ts";
import { defaultKeepDays } from "./communityWords.ts";

export type SetupChannel = { kind: RoomKind; name: string };

/** Made at setup by the bootstrap, so listed fixed. */
export const STARTING_CHANNELS: readonly SetupChannel[] = [{ kind: "text", name: "general" }, { kind: "forum", name: "forum" }];
/** The rest of setup's default list, made by the reconciler after setup. */
export const DEFAULT_SETUP_CHANNELS: readonly SetupChannel[] = [{ kind: "announcement", name: "announcements" }, { kind: "text", name: "off-topic" }];

const KINDS: readonly RoomKind[] = ["text", "announcement", "forum"];
const MAX_CHANNELS = 20;
const MAX_NAME = 100;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

/** The list as the setup page sends it, checked as the Community page checks a channel's name. */
export function checkSetupChannels(input: unknown): { ok: true; channels: SetupChannel[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "channels: a list of channels" };
  if (input.length > MAX_CHANNELS) return { ok: false, error: `channels: at most ${MAX_CHANNELS} at setup — add more on the Community page later` };
  const out: SetupChannel[] = [];
  const seen = new Set(STARTING_CHANNELS.map((c) => c.name));
  for (const item of input) {
    const c = (item ?? {}) as { kind?: unknown; name?: unknown };
    if (!KINDS.includes(c.kind as RoomKind)) return { ok: false, error: "channels: each is chat, announcements or a forum" };
    const name = typeof c.name === "string" ? c.name.trim().replace(/^#+/, "").trim() : "";
    if (name.length < 1 || name.length > MAX_NAME) return { ok: false, error: `channels: a channel name is 1 to ${MAX_NAME} characters` };
    if (CONTROL.test(name)) return { ok: false, error: "channels: a channel name cannot hold control characters" };
    // The stored list is also an env value (COMMUNITY_SETUP_CHANNELS), split on commas.
    if (name.includes(",")) return { ok: false, error: "channels: a channel name cannot hold a comma" };
    const key = name.toLowerCase();
    if (STARTING_CHANNELS.some((s) => s.name === key)) return { ok: false, error: `channels: #${key} is made with the community already` };
    if (seen.has(key)) return { ok: false, error: `channels: #${key} is listed twice` };
    seen.add(key);
    out.push({ kind: c.kind as RoomKind, name });
  }
  return { ok: true, channels: out };
}

/** As community.setupChannels stores them: `<kind>:<name>`. */
export function encodeSetupChannels(list: readonly SetupChannel[]): string[] {
  return list.map((c) => `${c.kind}:${c.name}`);
}

/** The stored list read back through the page's own check (it may come from the environment, never
 *  checked): an item that fails it — not a channel, a second #general or #forum, a name twice — is
 *  dropped, never guessed into a channel; the rest stay. */
export function decodeSetupChannels(stored: unknown): SetupChannel[] {
  if (!Array.isArray(stored)) return [];
  let out: SetupChannel[] = [];
  for (const s of stored) {
    if (typeof s !== "string") continue;
    const i = s.indexOf(":");
    if (i < 1) continue;
    const next = checkSetupChannels([...out, { kind: s.slice(0, i), name: s.slice(i + 1) }]);
    if (next.ok) out = next.channels;
  }
  return out;
}

type Resolution = { value: unknown; source: string };

/** The list the setup step shows: as stored (an empty list included — "none" is an answer); never
 *  stored = setup's defaults, or nothing once the community was made before the list existed. */
export function stepChannelsFrom(r: Resolution, made: boolean): SetupChannel[] {
  if (r.source === "database" || r.source === "env") return decodeSetupChannels(r.value);
  return made ? [] : [...DEFAULT_SETUP_CHANNELS];
}

/** Whether to write the list: never stored (so an empty answer is kept as one), or changed. */
export function setupChannelsNeedWrite(r: Resolution, stored: readonly string[]): boolean {
  return r.source !== "database" || JSON.stringify(r.value) !== JSON.stringify(stored);
}

export type SetupChannelRow = {
  kind: RoomKind; name: string; orderKey: string; see: "everyone"; post: PostRule; retentionDays: number | null; published: true;
};

/** The rows they become under the community's home, in the order listed: everyone sees each (so
 *  it is listed); an announcements channel takes posts from Mods and above; the days are a new
 *  channel's (ADR 0139: chat 30, the rest no limit of their own), within the install's cap. */
export function setupChannelRows(list: readonly SetupChannel[], retentionCapDays: number): SetupChannelRow[] {
  let key: string | null = null;
  return list.map((c) => {
    key = orderKeyBetween(key, null);
    return { kind: c.kind, name: c.name, orderKey: key, see: "everyone", post: c.kind === "announcement" ? "mods" : "everyone",
      retentionDays: defaultKeepDays(c.kind, retentionCapDays), published: true };
  });
}
