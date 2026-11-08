// The Discord bridge's own link calls, asked of the host. SERVER ONLY.
//
// The bridge (Out Of Your Element) links a Discord server to a Matrix space and a channel to a room
// through its web page's API, which answers only a page session sealed with its as_token. That token
// is the bridge's appservice token (it can act as every bridge account), so it stays in the bridge's
// container: the site drops a request whose NAME carries the ids (`discord-link-<server>-<channel>`
// …), the host runs install/ooye/link.js inside the bridge, which seals a five-minute session and
// makes the call, and the bridge's own answer comes back as the request's result. The rooms come
// from the site's rows on the host's side, never from the request. Spec:
// docs/superpowers/plans/2026-10-23-community-management-discord.md task 2.4.

/** The bridge's answer as link.js prints it. */
export type BridgeAnswer = { ok: boolean; status: number | null; data: string };
export type DiscordCallVerb = `discord-link-space-${string}` | `discord-privacy-${string}` | `discord-link-${string}-${string}`
  | `discord-unlink-${string}-${string}` | `discord-unlink-space-${string}`;
/** Asks the host for one call and waits: the bridge's answer, the host's refusal, or null (no answer in time). */
export type BridgeCall = (verb: DiscordCallVerb) => Promise<BridgeAnswer | { hostRefused: string } | null>;

export type Outcome = { ok: true } | { ok: false; status: number | null; words: string };

const SNOWFLAKE = /^\d{17,20}$/;
/** A Discord id as Discord writes one. */
export function isDiscordId(v: unknown): v is string {
  return typeof v === "string" && SNOWFLAKE.test(v);
}

// OOYE's refusals (link.js, guild-settings.js), each matched on its own text, in plain words.
const REFUSALS: [RegExp, string][] = [
  [/already bridged and cannot be reused/, "That Discord channel or this room is already linked. Unlink it first."],
  [/needs power level 100/, "The bridge's bot does not have full power there yet. The server gives it that on its next run: try again in a minute."],
  [/You personally must invite OOYE/, "The bridge's bot has not been invited to the community yet. The server invites it on its next run: try again in a minute."],
  [/Unable to join the requested Matrix (space|room)/, "The bridge's bot could not join yet. The server invites it on its next run: try again in a minute."],
  [/Matrix room needs to be part of the bridged space/, "That room is not inside the community the Discord server is linked to."],
  [/Discord guild does not exist or bot has not joined it/, "The bridge's bot is not in that Discord server. Add the bot to the server first, then try again."],
  [/Discord channel does not exist/, "The bridge's bot sees no Discord channel with that ID."],
  [/is not part of guild/, "That Discord channel belongs to another Discord server."],
  [/Encrypted rooms are not supported/, "An encrypted room cannot be linked to Discord."],
  [/has not been considered for bridging/, "That Discord server is not linked."],
  [/Can't (edit|change settings for) a guild|aren't logged in to Matrix/, "The bridge did not accept the server's sign-in for it. Run sudo blackbranch up on the server, then try again."],
];

/** Plain words for what the bridge answered.
 *  @test-only exported for the words' own test; the calls below are its callers */
export function wordsFor(status: number | null, data: string): string {
  if (status === null) return "The Discord bridge did not answer. It may be switched off or still starting: see its line at the top of this page.";
  for (const [re, words] of REFUSALS) if (re.test(data)) return words;
  const said = data.replace(/\s+/g, " ").trim().slice(0, 200);
  return `The Discord bridge answered ${status}${said ? `: ${said}` : ""}.`;
}

/** The answer a call came back with, as an Outcome (and the bridge's raw text, for the not-linked check). */
async function ask(call: BridgeCall, verb: DiscordCallVerb): Promise<Outcome & { data?: string }> {
  const a = await call(verb).catch(() => null);
  if (!a) return { ok: false, status: null, words: "The server has not answered yet. Try again in a minute." };
  if ("hostRefused" in a) return { ok: false, status: null, words: `The server could not make the call: ${a.hostRefused}` };
  if (a.ok) return { ok: true };
  return { ok: false, status: a.status, words: wordsFor(a.status, a.data), data: a.data };
}
const strip = (o: Outcome & { data?: string }): Outcome => (o.ok ? { ok: true } : { ok: false, status: o.status, words: o.words });

/** Link the Discord server to the community's space (the host names the space). The bot must be in it at 100. */
export async function linkSpace(call: BridgeCall, guildId: string): Promise<Outcome> {
  return strip(await ask(call, `discord-link-space-${guildId}`));
}

/** Who may join the rooms the bridge links: "link" keeps the community's space open to everyone,
 *  as the install made it; the bridge's default would make the space invite-only at its next sync. */
export async function setPrivacy(call: BridgeCall, guildId: string): Promise<Outcome> {
  return strip(await ask(call, `discord-privacy-${guildId}`));
}

/** Link the room whose row is marked for `channelId` (the host reads which). The bot must be in it at 100. */
export async function linkRoom(call: BridgeCall, guildId: string, channelId: string): Promise<Outcome> {
  return strip(await ask(call, `discord-link-${guildId}-${channelId}`));
}

/** Unlink one channel. A channel that is not linked any more counts as done (a retry after a lost answer). */
export async function unlinkRoom(call: BridgeCall, guildId: string, channelId: string): Promise<Outcome> {
  const o = await ask(call, `discord-unlink-${guildId}-${channelId}`);
  if (!o.ok && o.status === 400 && /is not currently bridged/.test(o.data ?? "")) return { ok: true };
  return strip(o);
}

/** Unlink the whole Discord server: the bridge unlinks every channel, leaves the space, and its bot
 *  LEAVES the Discord server (it has to be added again to link anything later). */
export async function unlinkSpace(call: BridgeCall, guildId: string): Promise<Outcome> {
  return strip(await ask(call, `discord-unlink-space-${guildId}`));
}
