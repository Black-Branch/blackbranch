"use client";

// The History section of the mod panel, extracted from ModPanel.tsx.
// Internal to the `moderation` feature — nothing outside can import it.

import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "@/app/lib/http";
import { LoadingState } from "@/app/components/Spinner";
import { card, h2, btn, input, timeAgo, shortName } from "../shared";
import EmptyState from "@/app/components/EmptyState";
import PlatformIcon from "@/app/components/PlatformIcon";
import { platformLabel } from "@/app/lib/platforms";

type LogEntry = {
  id: number; action: string; targetId: string; targetName: string | null;
  performedBy: string; modName: string | null; durationMinutes: number | null;
  expiresAt: string | null; reason: string | null; batchId: string | null; at: string;
  /** Platforms this action failed on — the ✗ on the row. */
  failedPlatforms?: string[];
};

type PlatformAction = {
  id: number; action: string; platform: string; ok: boolean; status: number | null;
  detail: string | null; actedVia: string | null; durationSeconds: number | null; at: number;
};

// ─── History + propagation ────────────────────────────────────────────────────

// History shows 8, expands to 16, then pages; a search bar above.
const FIRST = 8;
const PAGE = 16;

export default function HistorySection({ note }: { note: (m: string) => void }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // 0 = the first 8; then pages of 16 (page 1 = the first 16).
  const [page, setPage] = useState(0);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [expansion, setExpansion] = useState<PlatformAction[] | null>(null);
  const [retrying, setRetrying] = useState<number | null>(null);

  const load = useCallback((pg: number, search: string) => {
    const size = pg === 0 ? FIRST : PAGE;
    const offset = pg <= 1 ? 0 : (pg - 1) * PAGE;
    const qs = new URLSearchParams({ limit: String(size + 1), offset: String(offset) });
    if (search) qs.set("q", search);
    getJson<{ entries: LogEntry[] }>(`/api/mod/log?${qs}`)
      .then((d) => {
        setEntries(d.entries.slice(0, size));
        setHasMore(d.entries.length > size);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);
  useEffect(() => load(page, query), [load, page, query]);

  // Fetch (or re-fetch) the platform actions behind one log entry. Split out of
  // toggleExpand so a refresh does not have to go through the toggle — see retry().
  function loadExpansion(e: LogEntry) {
    setExpansion(null);
    const qs = e.batchId
      ? `?batchId=${encodeURIComponent(e.batchId)}`
      : `?targetId=${encodeURIComponent(e.targetId)}&limit=8`;
    getJson<{ actions: PlatformAction[] }>(`/api/mod/platform-actions${qs}`)
      .then((d) => setExpansion(d.actions))
      .catch(() => setExpansion([]));
  }

  function toggleExpand(e: LogEntry) {
    if (expanded === e.id) { setExpanded(null); setExpansion(null); return; }
    setExpanded(e.id);
    loadExpansion(e);
  }

  async function retry(actionId: number, entry: LogEntry) {
    setRetrying(actionId);
    try {
      const res = await postJson("/api/mod/platform-actions/retry", { id: actionId });
      if (res.status === 422) note("That action can't be retried from here.");
      else if (!res.ok) note("Retry failed.");
      else note("Retried — refreshing outcome.");
      // Was `toggleExpand(entry); toggleExpand(entry);` — both calls read the SAME
      // `expanded` value from this closure (React state does not update
      // synchronously), so both took the collapse branch. The row collapsed and the
      // new outcome was never fetched: the mod clicked Retry, saw the panel shut,
      // and had no way to tell whether the retry had worked.
      loadExpansion(entry);
    } catch {
      note("Retry failed.");
    } finally {
      setRetrying(null);
    }
  }

  return (
    <section className={card}>
      <h2 className={h2} data-repeats-place="">Mod history</h2>
      <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); setPage(0); setQuery(q.trim()); }}>
        <input className={input} type="search" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search — who, which mod, action, reason" aria-label="Search the mod history" />
        <button type="submit" className={btn}>Search</button>
        {query && <button type="button" className={btn} onClick={() => { setQ(""); setQuery(""); setPage(0); }}>Clear</button>}
      </form>
      {!loaded ? (
        <LoadingState />
      ) : entries.length === 0 ? (
        <EmptyState>{query ? "Nothing in the mod history matches." : "Every mod action — bans, timeouts, deletes, purges, lockdown changes — is logged here. None yet."}</EmptyState>
      ) : (
        <ul className="space-y-1">
          {entries.map((e) => (
            <li key={e.id}>
              <button
                onClick={() => toggleExpand(e)}
                className="w-full text-left flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm hover:bg-surface-1 transition-colors"
              >
                <span className={`shrink-0 text-xs font-medium uppercase tracking-wide ${
                  e.action === "unban" ? "text-emerald-400"
                  // Site-wide raid posture (v82) — deliberately louder than a
                  // per-user action, because "who closed the doors, and when"
                  // is the first question asked after a raid.
                  : e.action === "signups_disabled" || e.action === "crosspost_disabled" ? "text-amber-400 font-semibold"
                  : e.action === "signups_enabled" || e.action === "crosspost_enabled" ? "text-emerald-400 font-semibold"
                  : e.action === "slowmode" || e.action === "slowmode_user" ? "text-sky-400"
                  : e.action === "delete" ? "text-secondary"
                  : "text-red-400"
                }`}>{e.action === "slowmode_user" ? "slowmode" : e.action}</span>
                <span className="text-body-dim truncate">{shortName(e.targetId, e.targetName)}</span>
                {e.durationMinutes != null && <span className="text-xs text-muted shrink-0">{e.durationMinutes}m</span>}
                {!!e.failedPlatforms?.length && (
                  <span className="text-xs text-red-400 shrink-0" title="Did not land there — open the row to retry">
                    ✗ {e.failedPlatforms.map(platformLabel).join(", ")}
                  </span>
                )}
                {e.reason && <span className="text-xs text-muted truncate">“{e.reason}”</span>}
                <span className="ml-auto text-xs text-muted shrink-0">
                  {shortName(e.performedBy, e.modName)} · {timeAgo(e.at)}
                </span>
              </button>
              {expanded === e.id && (
                <div className="ml-4 mt-1 mb-2 rounded-lg bg-surface-1 px-3 py-2 space-y-1">
                  {expansion === null ? (
                    <p className="text-xs text-muted">Loading propagation…</p>
                  ) : expansion.length === 0 ? (
                    <p className="text-xs text-muted">No platform fan-out recorded for this action.</p>
                  ) : (
                    expansion.map((a) => (
                      <div key={a.id} className="flex items-center gap-2 text-xs" title={a.detail ?? undefined}>
                        <span className={a.detail === "unsupported" ? "text-muted" : a.ok ? "text-emerald-400" : "text-red-400"}>
                          {a.detail === "unsupported" ? "—" : a.ok ? "✓" : "✗"}
                        </span>
                        <span className="text-secondary flex items-center gap-1">
                          <PlatformIcon platform={a.platform} size="0.9em" /> {a.platform} {a.action}
                        </span>
                        {a.actedVia === "broadcaster" && <span className="text-muted">(as broadcaster)</span>}
                        {!a.ok && a.status != null && <span className="text-muted">({a.status})</span>}
                        {!a.ok && a.detail && a.detail !== "unsupported" && (
                          <span className="text-muted truncate max-w-48">{a.detail}</span>
                        )}
                        <span className="text-faint ml-auto shrink-0">{timeAgo(a.at)}</span>
                        {!a.ok && a.detail !== "unsupported" && ["ban", "timeout", "unban", "slowmode"].includes(a.action) && (
                          <button
                            className="text-sky-400/90 hover:text-sky-300 shrink-0 disabled:opacity-40"
                            disabled={retrying === a.id}
                            onClick={(ev) => { ev.stopPropagation(); retry(a.id, e); }}
                          >
                            Retry
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {page === 0 && hasMore && <button className={btn} onClick={() => setPage(1)}>Show 16</button>}
        {page >= 1 && (
          <>
            <button className={btn} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Newer</button>
            <span className="text-xs text-muted">Page {page}</span>
            <button className={btn} disabled={!hasMore} onClick={() => setPage((p) => p + 1)}>Older</button>
          </>
        )}
      </div>
    </section>
  );
}
