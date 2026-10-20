// The mod panel's Chat history as rows: chat order (oldest at the top, newest at the bottom), the
// mod log's actions inside the snapshot's span woven in by time, a live frame turned into a row
// when "Follow new messages" is on, and the filter a frame must pass to join. Pure — node --test
// reads it.
import type { ChatMsg } from "./chatMsg.ts";
import type { HistMsg } from "./modHistory.ts";
import { isNativePlatform } from "./nativePlatform.ts";

/** A mod log entry as GET /api/mod/log returns it. */
export type ModLogRow = {
  id: number; action: string; targetId: string; targetName: string | null;
  performedBy: string; modName: string | null; durationMinutes: number | null;
  reason: string | null; at: string;
};

export type HistRow = { kind: "msg"; key: string; ts: number; m: HistMsg } | { kind: "mod"; key: string; ts: number; e: ModLogRow };

export type HistFilters = { q: string; user: string; platform: string; deletedOnly: boolean };

const msgKey = (m: { platform: string; id: number }) => `${m.platform}:${m.id}`;

/** Oldest first; ties by platform then id (the API's keyset order, reversed).
 *  @test-only weave() sorts through it; the test pins the order on its own. */
export function chatOrder(msgs: readonly HistMsg[]): HistMsg[] {
  return [...msgs].sort((a, b) => a.ts - b.ts || (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : a.id - b.id));
}

/** The mod actions that belong in a chat stream: what was done to people and to the chat itself.
 *  Settings work (memory, word lists, pronouns…) stays in Mod history only. */
const INLINE_ACTIONS: ReadonlySet<string> = new Set([
  "ban", "timeout", "unban", "delete", "purge", "slowmode", "slowmode_user",
  "signups_disabled", "signups_enabled", "crosspost_disabled", "crosspost_enabled", "min_account_age_set",
  "ingest_paused_set", "sub_only_enabled", "sub_only_disabled",
]);

/** Messages and mod actions in one stream, oldest first. A mod action older than the oldest
 *  message on screen is left out — it belongs to a page not loaded yet — and so is one that is not
 *  chat moderation (INLINE_ACTIONS). Duplicate messages (a followed frame that a refresh also
 *  loaded) appear once. */
export function weave(msgs: readonly HistMsg[], mods: readonly ModLogRow[], person = ""): HistRow[] {
  const seen = new Set<string>();
  const rows: HistRow[] = [];
  for (const m of chatOrder(msgs)) {
    const key = msgKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ kind: "msg", key, ts: m.ts, m });
  }
  const floor = rows[0]?.ts ?? Infinity;
  for (const e of mods) {
    const ts = Date.parse(e.at);
    if (Number.isNaN(ts) || ts < floor || !INLINE_ACTIONS.has(e.action)) continue;
    // A snapshot filtered to one person shows only what was done to them.
    if (person && !(e.targetId === person || (e.targetName ?? "").toLowerCase().includes(person.toLowerCase()))) continue;
    rows.push({ kind: "mod", key: `mod:${e.id}`, ts, e });
  }
  // Stable: a mod action at the same moment as a message follows it.
  return rows.map((r, i) => [r, i] as const).sort((a, b) => a[0].ts - b[0].ts || a[1] - b[1]).map(([r]) => r);
}

const VERB: Record<string, string> = {
  ban: "banned", timeout: "timed out", unban: "lifted the ban on", delete: "deleted a message from",
  purge: "purged messages from", slowmode: "set slow mode", slowmode_user: "slowed",
  signups_disabled: "blocked new signups", signups_enabled: "re-opened signups",
  crosspost_disabled: "blocked cross-posting", crosspost_enabled: "re-enabled cross-posting",
  min_account_age_set: "set the minimum account age", ingest_paused_set: "changed paused platforms",
  sub_only_enabled: "turned sub-only chat on", sub_only_disabled: "turned sub-only chat off",
};

/** One line for a mod action in the stream: "mod banned name for 10m — reason". */
export function modLine(e: ModLogRow): string {
  const who = e.modName ?? e.performedBy.replace(/^@([^:]+):.*$/, "$1");
  // A delete names the message (platform:id), not a person.
  const msgRef = /^([a-z]+):(\d+)$/.exec(e.targetId);
  if (e.action === "delete" && msgRef) return `${who} deleted a message (#${msgRef[2]} on ${msgRef[1]})${e.reason ? ` — ${e.reason}` : ""}`;
  const target = e.targetId === "site" ? "" : ` ${e.targetName ?? e.targetId.replace(/^@([^:]+):.*$/, "$1")}`;
  const verb = VERB[e.action] ?? e.action.replace(/_/g, " ");
  const length = e.action === "timeout" && e.durationMinutes ? ` for ${e.durationMinutes >= 60 && e.durationMinutes % 60 === 0 ? `${e.durationMinutes / 60}h` : `${e.durationMinutes}m`}` : "";
  return `${who} ${verb}${target}${length}${e.reason ? ` — ${e.reason}` : ""}`;
}

/** A live chat frame as a history row, or null for a card / sticker / anything without a number. */
export function frameToHist(f: ChatMsg): HistMsg | null {
  if (f.system) return null;
  const id = Number(f.id);
  if (!Number.isFinite(id)) return null;
  const ts = Number(f.ts) || Date.now();
  return {
    id, platform: f.platform, username: f.username, message: f.message,
    canonicalId: f.canonicalId ?? null, matrixId: f.matrixId ?? null, deleted: !!f.deleted,
    ts, cts: new Date(ts).toISOString(),
    destPlatforms: isNativePlatform(f.platform) ? (f.destPlatforms ?? (f.destPlatform ? [f.destPlatform] : [])) : [f.platform],
    replyTo: f.reply_to_username ? { username: f.reply_to_username, text: f.reply_to_text ?? "" } : null,
    scores: { karma: null, intelligence: null },
    emotes: f.emotes ?? null,
  };
}

/** Whether a followed message belongs in a snapshot taken with these filters (the server's rules,
 *  as far as a frame can tell them). */
export function passesFilters(m: HistMsg, f: HistFilters): boolean {
  if (f.deletedOnly && !m.deleted) return false;
  if (f.platform && (isNativePlatform(f.platform) ? !isNativePlatform(m.platform) : m.platform !== f.platform)) return false;
  if (f.q.trim() && !m.message.toLowerCase().includes(f.q.trim().toLowerCase())) return false;
  const u = f.user.trim();
  if (u && !(m.username.toLowerCase().includes(u.toLowerCase()) || m.matrixId === u || m.canonicalId === u)) return false;
  return true;
}

/** The value a name click filters on: the Matrix id, else the user id, else the name. */
export function personFilter(m: Pick<HistMsg, "matrixId" | "canonicalId" | "username">): string {
  return m.matrixId ?? m.canonicalId ?? m.username;
}
