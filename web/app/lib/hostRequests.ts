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

/** The verbs the site may ask for (install/blackbranch `cmd_process_requests`). An update names its
 *  release in the request's name (`update-v1.2.3`); the host checks it against the signed feed and
 *  answers under the fixed name `update`. */
export type HostVerb = "render" | "matrix-bootstrap" | "apply-install" | "doctor" | "backup" | "backup-test" | "backup-key"
  | "recovery-sheet" | "restart-stream-api" | "restart-stream-ingest" | "update-check"
  // The wizard's icon upload: the host copies the staged icons into site-files/. Like every verb, only the name travels.
  | "site-icons" | `update-v${string}`;
/** A release version as the host accepts one (install/blackbranch VERSION_RE). */
export const RELEASE_VERSION = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})(-[0-9a-z-]+(\.[0-9a-z-]+)*)?$/;
export type HostResult = { ok: boolean; at: string; message: string };

const VERB = /^[a-z0-9-]{1,40}$/;
const isVerb = (v: string) => VERB.test(v) || (v.startsWith("update-v") && v.length <= 72 && RELEASE_VERSION.test(v.slice(8)));

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
 *  listener and MAS's sign-up. Saving one changes nothing on the box until it re-renders, so a
 *  write asks for that render. */
const HOST_RENDERED = new Set(["matrix.federation", "matrix.registration"]);
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
export async function hostResult(verb: HostVerb | "update", dirs = hostRequestDirs()): Promise<HostResult | null> {
  if (!VERB.test(verb)) return null;
  try {
    const j = JSON.parse(await readFile(join(dirs.results, `${verb}.json`), "utf8")) as Record<string, unknown>;
    if (typeof j.at !== "string" || typeof j.ok !== "boolean") return null;
    return { ok: j.ok, at: j.at, message: typeof j.message === "string" ? j.message.slice(0, 600) : "" };
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
export async function hostFile(name: "doctor-host.json" | "update-feed.json" | "update-last.json" | "update-state.json", dirs = hostRequestDirs()): Promise<unknown> {
  try {
    const text = await readFile(join(dirs.results, name), "utf8");
    return text.length > 65_536 ? null : (JSON.parse(text) as unknown);
  } catch { return null; }
}
