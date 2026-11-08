// Asking the host for a fixed action. SERVER ONLY.
//
// The site never gets the Docker socket. On a bundle install it drops an empty file named after
// the verb into /requests (its drop box); the host's path unit runs the matching fixed
// `blackbranch` verb and writes `<verb>.json` into /request-results, a directory only the host
// writes and the site only reads. A request's content is never read by the host, so nothing but the
// verb's name travels. An install that is not the bundle has no drop box: `available` is false.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { INSTANCE_KEYS } from "./instanceSchema.generated.mjs";
import type { DiscordCallVerb } from "./community/discordLink.ts";

/** The verbs the site may ask for (install/blackbranch `cmd_process_requests`). An update names its
 *  release in the request's name (`update-v1.2.3`); the host checks it against the signed feed and
 *  answers under the fixed name `update`. */
export type HostVerb = "render" | "matrix-bootstrap" | "apply-install" | "doctor" | "backup" | "backup-test" | "backup-key"
  | "recovery-sheet" | "restart-stream-api" | "restart-stream-ingest" | "update-check"
  // The wizard's icon upload: the host copies the staged icons into site-files/. Like every verb, only the name travels.
  | "site-icons"
  // A community reconciler run (apply) after a change in the panel: the host starts it in its own unit and
  // answers "started" at once; the run's own result arrives in the run log (/api/internal/community/runs).
  | "community-reconcile"
  // The Community page's "Check now": a report run (reads both sides, changes nothing), started the same way.
  | "community-report"
  // The Discord page: what the Discord bridge has linked, read into results/ (discord-bridge-links.json).
  | "discord-links"
  // Its Link the server button: the Discord server id rides in the NAME (the host checks it), answered as discord-links.
  | `discord-guild-${string}`
  // Its link and unlink buttons (discordLink.ts): the ids ride in the NAME, the host checks each and
  // makes the bridge's call inside the bridge; every one is answered as discord-call.
  | DiscordCallVerb
  // The Bot step: who the bot is (results/discord-bot-info.json); the token the site dropped, into .env.
  | "discord-bot" | "discord-token"
  // The Import step: one Discord server read whole (results/discord-guild.json), its id in the NAME, answered as discord-read.
  | `discord-read-${string}`
  | `update-v${string}`;
/** A release version as the host accepts one (install/blackbranch VERSION_RE). */
export const RELEASE_VERSION = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})(-[0-9a-z-]+(\.[0-9a-z-]+)*)?$/;
export type HostResult = { ok: boolean; at: string; message: string; request?: string };

const VERB = /^[a-z0-9-]{1,40}$/;
// A Discord call names a server and a channel (17 to 20 digits each): longer than the other verbs.
const DISCORD_CALL = /^discord-(link-space|privacy|unlink-space)-\d{17,20}$|^discord-(link|unlink)-\d{17,20}-\d{17,20}$/;
const isVerb = (v: string) => VERB.test(v) || DISCORD_CALL.test(v) || (v.startsWith("update-v") && v.length <= 72 && RELEASE_VERSION.test(v.slice(8)));

function hostRequestDirs(env: Record<string, string | undefined> = process.env) {
  return { requests: env.BB_REQUESTS_DIR || "/requests", results: env.BB_RESULTS_DIR || "/request-results" };
}

export function hostRequestsAvailable(dirs = hostRequestDirs()): boolean {
  return existsSync(dirs.requests) && existsSync(dirs.results);
}

/** Drop the request. Returns the time it was asked (a later result answers it). */
export async function requestHost(verb: HostVerb, dirs = hostRequestDirs()): Promise<{ ok: true; requestedAt: string } | { ok: false; error: string }> {
  if (!isVerb(verb)) return { ok: false, error: "bad verb" };
  if (!hostRequestsAvailable(dirs)) return { ok: false, error: "this install has no host request folder (it is not the bundle)" };
  const requestedAt = new Date(Date.now() - 1000).toISOString().replace(/\.\d+Z$/, "Z");
  try {
    await mkdir(dirs.requests, { recursive: true });
    await writeFile(join(dirs.requests, `${verb}.req`), "");
  } catch (e) {
    return { ok: false, error: `could not ask the host: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, requestedAt };
}

/** The settings the HOST turns into rendered config (install/matrix/render.sh): the federation
 *  listener, MAS's sign-up, and MAS's outgoing mail (with password recovery) — the schema's
 *  `hostRendered` mark. Saving one changes nothing on the box until it re-renders, so a write asks
 *  for that render. */
const HOST_RENDERED = new Set(INSTANCE_KEYS.filter((e) => e.hostRendered).map((e) => e.key));
/** Settings the site reads too (live), that the host ALSO renders into its nightly timers
 *  (install/blackbranch backup_timers): the quiet hour and the time zone. Without a render the
 *  timers waited for the next backup to re-render them — a change applied a night late. */
const RENDERS_TIMERS = new Set(["updates.quietHour", "site.timeZone"]);

/** Is `key` a setting the host applies by re-rendering, rather than one a service reads? */
export function isHostRendered(key: string): boolean {
  return HOST_RENDERED.has(key);
}

/** Ask for a render when `key` is one the host renders (its config or its timers) and this install
 *  has a drop box. True when it was asked. Best effort: the setting is saved either way, and the
 *  doctor reports a render that does not match it. */
export async function requestRenderFor(key: string, dirs = hostRequestDirs()): Promise<boolean> {
  if (!(isHostRendered(key) || RENDERS_TIMERS.has(key)) || !hostRequestsAvailable(dirs)) return false;
  return (await requestHost("render", dirs)).ok;
}

/** The host's last answer to a verb, or null (none yet / unreadable). Fixed fields only. */
export async function hostResult(verb: HostVerb | "update" | "discord-call" | "discord-read", dirs = hostRequestDirs()): Promise<HostResult | null> {
  if (!VERB.test(verb)) return null;
  try {
    const j = JSON.parse(await readFile(join(dirs.results, `${verb}.json`), "utf8")) as Record<string, unknown>;
    if (typeof j.at !== "string" || typeof j.ok !== "boolean") return null;
    return { ok: j.ok, at: j.at, message: typeof j.message === "string" ? j.message.slice(0, 600) : "",
      ...(typeof j.request === "string" ? { request: j.request.slice(0, 80) } : {}) };
  } catch { return null; }
}

/** Is `result` the answer to a request made at `requestedAt` (not an older one)? */
export function answers(result: HostResult | null, requestedAt: string): result is HostResult {
  return !!result && Date.parse(result.at) >= Date.parse(requestedAt);
}

/** The backup passphrase for the setup pages' recovery sheet, from the host — or null when it has
 *  none to give. The site never holds it in its environment: the site also chooses where the backups
 *  go, so a compromised site holding the key to open them could send them to its own server and read
 *  every secret in them. The host writes it into the results folder only while setup's recovery step
 *  is current, and takes it back for good once setup moves on (install/blackbranch `recovery_sheet`).
 *  Not there yet: ask, and wait up to `waitMs` for the host's answer. */
export async function hostRecoveryPassphrase(dirs = hostRequestDirs(), waitMs = 20_000, stepMs = 500): Promise<string | null> {
  const read = async (): Promise<string | null> => {
    try {
      const p = (JSON.parse(await readFile(join(dirs.results, "recovery-passphrase.json"), "utf8")) as { passphrase?: unknown }).passphrase;
      return typeof p === "string" && p.length > 0 && p.length <= 256 ? p : null;
    } catch { return null; }
  };
  const now = await read();
  if (now || !hostRequestsAvailable(dirs)) return now;
  const asked = await requestHost("recovery-sheet", dirs);
  if (!asked.ok) return null;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, stepMs));
    const p = await read();
    if (p) return p;
    // The host answered without a sheet (not the recovery step, or shown already).
    if (answers(await hostResult("recovery-sheet", dirs), asked.requestedAt)) return read();
  }
  return null;
}

/** A file the host keeps in the results folder for the site to read (e.g. the doctor's host facts),
 *  parsed as JSON; null when absent, too large or unreadable. */
export async function hostFile(name: "doctor-host.json" | "update-feed.json" | "update-last.json" | "update-state.json" | "retention-cap.json" | "discord-bridge.json" | "discord-bridge-links.json"
  | "discord-bot-info.json" | "discord-guild.json", dirs = hostRequestDirs()): Promise<unknown> {
  try {
    const text = await readFile(join(dirs.results, name), "utf8");
    return text.length > (name === "discord-bridge-links.json" || name === "discord-guild.json" ? 1_048_576 : 65_536) ? null : (JSON.parse(text) as unknown);
  } catch { return null; }
}

/** The Bot step's token, dropped beside the requests for the host's `discord-token` (install/blackbranch
 *  discord_token moves it into its own folder, checks it, writes it into .env and removes it). The site
 *  keeps no copy: this file is the only place it is written, and only until the host takes it. */
export async function dropDiscordToken(token: string, dirs = hostRequestDirs()): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!hostRequestsAvailable(dirs)) return { ok: false, error: "this install has no host request folder (it is not the bundle)" };
  try {
    await writeFile(join(dirs.requests, "discord-token.value"), token, { mode: 0o600 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `could not hand the token to the host: ${e instanceof Error ? e.message : String(e)}` };
  }
}
