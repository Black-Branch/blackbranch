// The per-message mod actions, written ONCE: the mod ⋯ menu on a live chat row and on a Chat
// history row, and the user card's action strip, all use these. The target rule lives here
// only: a site account goes by its Matrix id; a platform-only chatter by their canonical id,
// which the ban/purge routes upgrade to the linked site account server-side
// (app/api/mod/ban/route.ts linkedMatrixId).
import { postJson } from "./http.ts";
import { lsGet, lsSet } from "./safeLocalStorage.ts";
import { offerUndo } from "./modUndo.ts";
import { purgeRequest, PURGE_MAX_MINUTES } from "./modRequests.ts";
import { trackPropagation, type FanOut } from "./modPropagation.ts";
import { SITE_BANS_CHANGED } from "./siteBanSync.ts";

/** Tell an open community to reconcile its room bans now (siteBanSync.ts). */
export function siteBansChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new window.Event(SITE_BANS_CHANGED));
}

export type ModTargetMsg = {
  id: string | number;
  platform: string;
  matrixId?: string | null;
  canonicalId?: string | null;
};

/** Who an action on this message's sender targets, or null when nothing identifies them. */
export function banTargetOf(msg: ModTargetMsg): { targetId: string } | { canonicalId: string } | null {
  if (msg.matrixId) return { targetId: msg.matrixId };
  if (msg.canonicalId) return { canonicalId: msg.canonicalId };
  return null;
}

/** The timeout length a mod last used, remembered across cards and menus (minutes). */
const LAST_TIMEOUT_KEY = "modLastTimeoutMins";
export function lastTimeoutMins(): number {
  const n = Number(lsGet(LAST_TIMEOUT_KEY));
  return Number.isFinite(n) && n > 0 ? n : 10;
}
export function rememberTimeoutMins(n: number): void {
  if (Number.isFinite(n) && n > 0) lsSet(LAST_TIMEOUT_KEY, String(n));
}

/** Compact label for a timeout length. */
export function timeoutLabel(mins: number): string {
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

export type ModResult = { ok: true } | { ok: false; error: string };

async function answer(res: Response | null, what: string): Promise<ModResult> {
  if (!res) return { ok: false, error: `${what} failed (network)` };
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return { ok: false, error: t && t.length < 120 ? t : `${what} failed` };
  }
  // The ban route keeps a stronger existing ban (applied: false) — say so, never "succeed".
  const d = (await res.clone().json().catch(() => ({}))) as { applied?: boolean; kept?: string };
  if (d.applied === false) return { ok: false, error: d.kept === "permanent" ? "Kept the existing permanent ban" : "Kept the existing longer timeout" };
  return { ok: true };
}

export async function modDelete(msg: ModTargetMsg): Promise<ModResult> {
  return answer(await postJson("/api/mod/delete", { messageId: msg.id, platform: msg.platform }).catch(() => null), "Delete");
}

/** Remove the sender's messages from the last `minutes` (24 h by default). */
export async function modPurge(msg: ModTargetMsg, minutes = PURGE_MAX_MINUTES): Promise<ModResult> {
  const target = banTargetOf(msg);
  if (!target) return { ok: false, error: "Purge unavailable — this message has no resolvable identity" };
  return answer(await postJson("/api/mod/purge", purgeRequest(target, minutes)).catch(() => null), "Purge");
}

/** What a ban replaced, as the ban route reports it: no earlier ban, or the earlier ban's end
 *  (null = it was permanent). */
export type BanPrevious = { expiresAt: string | null } | null;

/** How an Undo puts back what a ban replaced: no earlier ban (or one that
 *  has run out since) → lift the ban; an earlier ban → put it back as it was.
 *  @test-only modBanAtOnce reads it; the test pins each case with a fixed clock. */
export function undoPlan(previous: BanPrevious | undefined, now = Date.now()): { kind: "lift" } | { kind: "restore"; minutes: number | null } {
  if (!previous) return { kind: "lift" };
  if (previous.expiresAt === null) return { kind: "restore", minutes: null };
  const left = Date.parse(previous.expiresAt) - now;
  return left > 0 ? { kind: "restore", minutes: Math.ceil(left / 60_000) } : { kind: "lift" };
}

/** Time out (minutes) or ban the sender AT ONCE and offer an Undo. The
 *  message is removed only when the Undo window closes — a removal cannot be taken back. */
export async function modBanAtOnce(msg: ModTargetMsg, minutes?: number): Promise<ModResult> {
  const target = banTargetOf(msg);
  const what = minutes ? `Timeout ${timeoutLabel(minutes)}` : "Ban";
  if (!target) return { ok: false, error: `${what} unavailable — this message has no resolvable identity` };
  const res = await postJson("/api/mod/ban", minutes ? { ...target, durationMinutes: minutes } : target).catch(() => null);
  const r = await answer(res, what);
  if (!r.ok || !res) return r;
  const d = (await res.json().catch(() => ({}))) as { previous?: BanPrevious } & FanOut;
  trackPropagation(what, d);
  siteBansChanged();
  const plan = undoPlan(d.previous);
  offerUndo(
    `${what}: done.`,
    async () => {
      const r = plan.kind === "lift"
        ? await answer(await postJson("/api/mod/ban", target, "DELETE").catch(() => null), "Undo")
        : await answer(await postJson("/api/mod/ban", {
          ...target, ...(plan.minutes ? { durationMinutes: plan.minutes } : {}), override: true, reason: "Undo: the earlier ban put back",
        }).catch(() => null), "Undo");
      siteBansChanged();
      return r;
    },
    (leaving) => { void postJson("/api/mod/delete", { messageId: msg.id, platform: msg.platform }, "POST", { keepalive: leaving }).catch(() => {}); },
  );
  return { ok: true };
}
