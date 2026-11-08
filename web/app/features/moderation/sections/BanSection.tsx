"use client";

// The Ban section of the mod panel, extracted from ModPanel.tsx.
// Internal to the `moderation` feature — nothing outside can import it.
//
// The form starts on a 10-minute timeout, the gentlest action: a permanent ban is chosen on
// purpose, and only it asks to be confirmed. The button names the action it will take.

import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "@/app/lib/http";
import { LoadingState } from "@/app/components/Spinner";
import { card, h2, btn, timeAgo, shortName, timeLeft, resolveTarget } from "../shared";
import { matrixServerName } from "@/app/lib/matrixConfig";
import { platformLabel } from "@/app/lib/platforms";
import { trackPropagation, type FanOut } from "@/app/lib/modPropagation";
import { siteBansChanged } from "@/app/lib/modQuickActions";
import { banFormDefaults, banButtonLabel, type BanDuration } from "../banForm";
import { HISTORY_WINDOWS, type HistoryWindow } from "@/app/lib/banHistory";
import { useCommunityHistory } from "@/app/lib/useCommunityHistory";

type Ban = {
  matrixId: string; targetName: string | null; bannedBy: string; modName: string | null;
  reason: string | null; expiresAt: string | null; createdAt: string; failedPlatforms?: string[];
};

/** A refusal's own words (a 403 says who may do it), else the generic failure. */
async function refusal(res: Response, fallback: string): Promise<string> {
  if (res.status !== 403) return fallback;
  const t = (await res.text().catch(() => "")).trim();
  return t && t.length < 160 ? t : fallback;
}

// ─── Active bans + ban form ───────────────────────────────────────────────────

export default function BanSection({ note, initialTarget }: { note: (m: string) => void; initialTarget?: string }) {
  const [bans, setBans] = useState<Ban[] | null>(null);
  const [target, setTarget] = useState(initialTarget ?? "");
  const [duration, setDuration] = useState<BanDuration>(banFormDefaults.duration);
  const [reason, setReason] = useState("");
  const [override, setOverride] = useState(false);
  // A ban or timeout also removes their messages of the last 24 hours, unless turned off for this one.
  const [alsoRemove, setAlsoRemove] = useState(true);
  // A permanent ban can also delete their community message history (banHistory.ts); default none.
  const [history, setHistory] = useState<HistoryWindow>(banFormDefaults.history);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const deleteCommunityHistory = useCommunityHistory();

  const load = useCallback(() => {
    getJson<{ bans: Ban[] }>("/api/mod/bans").then((d) => setBans(d.bans)).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const label = banButtonLabel(duration);

  async function applyBan() {
    const matrixId = resolveTarget(target);
    if (!target.trim()) return;
    // A permanent ban asks once; the button says so.
    if (duration === "perm" && !armed) { setArmed(true); return; }
    setArmed(false);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { targetId: matrixId, override, purge: alsoRemove };
      if (duration !== "perm") payload.durationMinutes = Number(duration);
      if (reason.trim()) payload.reason = reason.trim();
      const res = await postJson("/api/mod/ban", payload);
      if (!res.ok) { note(await refusal(res, "Ban failed.")); load(); return; }
      const d = await res.json().catch(() => ({} as { applied?: boolean; kept?: string; identitiesKeepBan?: number } & FanOut));
      const purged = typeof d.purged === "number" ? d.purged : null;
      if (d.applied === false) {
        note(d.kept === "permanent"
          ? "Kept the existing permanent ban — check Override to downgrade deliberately."
          : "Kept the existing longer timeout — check Override to shorten deliberately.");
      } else {
        const keep = d.identitiesKeepBan ?? 0;
        const done = `${duration === "perm" ? "Banned" : `Timed out (${duration}m)`} ${shortName(matrixId)}.` +
          (purged ? ` Removed ${purged} recent ${purged === 1 ? "message" : "messages"}.` : "") +
          (d.purgeFailed ? " Their messages couldn't be removed. Purge them by hand." : "") +
          (keep > 0 ? ` ${keep} linked ${keep === 1 ? "identity keeps its" : "identities keep their"} own ban — Unban lifts it.` : "");
        note(done);
        trackPropagation(duration === "perm" ? "Ban" : `Timeout ${duration}m`, d);
        siteBansChanged();
        const window = duration === "perm" ? history : "none";
        setTarget("");
        setReason("");
        setOverride(false);
        setAlsoRemove(true);
        setHistory(banFormDefaults.history);
        // Then their community lines, from this moderator's own client (the ban stands either way).
        if (window !== "none") {
          const line = await deleteCommunityHistory({
            targetId: matrixId, window, reason: reason.trim() || undefined,
            siteRemoved: purged, batchId: typeof d.batchId === "string" ? d.batchId : null,
            onProgress: (p) => { if (p) note(`${done} ${p}`); },
          });
          if (line) note(`${done} ${line}`);
        }
      }
      load();
    } catch {
      note("Ban failed.");
    } finally {
      setBusy(false);
    }
  }

  async function unban(matrixId: string) {
    setBusy(true);
    try {
      const res = await postJson("/api/mod/ban", { targetId: matrixId }, "DELETE");
      note(res.ok ? `Unbanned ${shortName(matrixId)}.` : await refusal(res, "Unban failed."));
      if (res.ok) { trackPropagation("Unban", (await res.json().catch(() => ({}))) as FanOut); siteBansChanged(); }
      load();
    } catch {
      note("Unban failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={card}>
      <h2 className={h2} data-repeats-place="">Bans</h2>

      <div className="flex flex-wrap items-center gap-2 mb-2">
        <input
          value={target}
          onChange={(e) => { setTarget(e.target.value); setArmed(false); }}
          placeholder={`username or @user:${matrixServerName()}`}
          aria-label="Who"
          className="flex-1 min-w-40 rounded-lg bg-surface-1 border border-edge px-3 py-1.5 text-sm text-body placeholder:text-muted outline-none focus:border-edge-strong"
        />
        <select
          value={duration}
          onChange={(e) => { setDuration(e.target.value as BanDuration); setArmed(false); }}
          aria-label="How long"
          className="rounded-lg bg-surface-1 border border-edge px-2 py-1.5 text-xs text-body outline-none focus:border-edge-strong"
        >
          <option value="10">10m timeout</option>
          <option value="60">1h timeout</option>
          <option value="1440">24h timeout</option>
          <option value="10080">7d timeout</option>
          <option value="perm">Permanent ban</option>
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          placeholder="Reason (optional — shown in the mod history)"
          aria-label="Reason"
          className="flex-1 min-w-40 rounded-lg bg-surface-1 border border-edge px-3 py-1.5 text-sm text-body placeholder:text-muted outline-none focus:border-edge-strong"
        />
        <label className="flex items-center gap-1.5 text-xs text-secondary select-none">
          <input type="checkbox" checked={alsoRemove} onChange={(e) => setAlsoRemove(e.target.checked)} />
          Also remove their recent messages
        </label>
        {duration === "perm" && (
          <label className="flex items-center gap-1.5 text-xs text-secondary select-none">
            Community history
            <select value={history} onChange={(e) => { setHistory(e.target.value as HistoryWindow); setArmed(false); }}
              aria-label="Delete message history"
              className="rounded-lg bg-surface-1 border border-edge px-2 py-1 text-xs text-body outline-none focus:border-edge-strong">
              {HISTORY_WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
            </select>
          </label>
        )}
        <label className="flex items-center gap-1.5 text-xs text-secondary select-none">
          <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
          Override
        </label>
        <button
          className={`${btn} ${armed ? "!bg-red-900/60 !text-red-100 !border-red-500/40" : "hover:!bg-red-900/50"}`}
          disabled={busy || !target.trim()}
          onClick={applyBan}
          onBlur={() => setArmed(false)}
        >
          {armed ? "Confirm permanent ban?" : label}
        </button>
      </div>

      {bans === null ? (
        <LoadingState />
      ) : bans.length === 0 ? (
        <p className="text-xs text-muted">No active bans or timeouts. Everyone banned or timed out — here, from a user card or a chat line&apos;s ⋯ menu — is listed here until it ends.</p>
      ) : (
        <ul className="space-y-1.5">
          {bans.map((b) => (
            <li key={b.matrixId} className="flex items-center gap-3 rounded-lg bg-surface-1 px-3 py-2 text-sm">
              <div className="flex-1 min-w-0">
                <span className="text-body font-medium">{shortName(b.matrixId, b.targetName)}</span>
                <span className={`ml-2 text-xs ${b.expiresAt ? "text-yellow-400/90" : "text-red-400/90"}`}>
                  {b.expiresAt ? `timeout · ${timeLeft(b.expiresAt)}` : "permanent"}
                </span>
                {!!b.failedPlatforms?.length && (
                  <span className="ml-2 text-xs text-red-400" title="The ban did not land there — retry it from Mod history">
                    ✗ {b.failedPlatforms.map(platformLabel).join(", ")}
                  </span>
                )}
                {b.reason && <span className="ml-2 text-xs text-muted truncate">“{b.reason}”</span>}
                <span className="ml-2 text-xs text-muted">by {shortName(b.bannedBy, b.modName)} · {timeAgo(b.createdAt)}</span>
              </div>
              <button className={`${btn} hover:!bg-emerald-900/50 shrink-0`} disabled={busy} onClick={() => unban(b.matrixId)}>
                Unban
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
