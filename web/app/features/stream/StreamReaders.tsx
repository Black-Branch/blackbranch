"use client";
// The Stream tab's chat readers: per platform the ingest service reads, whether its reader is
// running, still starting, failed (with the one-line reason) or off — from the ingest's own health
// answer, relayed by GET /api/admin/stream/readers. A reader that failed to start shows here, not
// only in a log. Asked when the tab opens, on Refresh, and every 30 s while the tab is open and
// the page visible (a reader that is starting settles within two minutes).
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getJson } from "@/app/lib/http";
import { agoLabel } from "@/app/lib/relativeTime";
import { platformLabel } from "@/app/lib/platforms";
import PlatformIcon from "@/app/components/PlatformIcon";
import { readersView, type ReadersReply, type ReaderState } from "./ingestReaders";
import { card, cardTitle } from "./StreamCharts";

const POLL_MS = 30_000;
const WORD: Record<ReaderState, { label: string; tone: string }> = {
  running: { label: "Reading", tone: "text-emerald-300" },
  starting: { label: "Starting", tone: "text-amber-300" },
  failed: { label: "Failed", tone: "text-red-400" },
  off: { label: "Off", tone: "text-muted" },
};

export function StreamReaders({ active }: { active: boolean }) {
  // The answer, with the moment it arrived: "since" labels read that, never the clock in render.
  const [got, setGot] = useState<{ reply: ReadersReply; at: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    getJson<ReadersReply>("/api/admin/stream/readers")
      .then((reply) => { setGot({ reply, at: Date.now() }); setFailed(false); })
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => {
    if (!active) return;
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [active, load]);

  const v = readersView(got?.reply ?? null);
  return (
    <section className={card} data-section="readers">
      <div className={cardTitle}>
        <span>Chat readers</span>
        <button type="button" onClick={load} className="normal-case tracking-normal font-normal text-2xs text-muted underline hover:text-strong">Refresh</button>
      </div>
      {v.kind === "unreachable" ? (
        <p className="mt-2 text-xs text-red-400" data-readers="unreachable">The chat reader service did not answer — no platform chat is coming in through it. On a bundled install: blackbranch logs stream-ingest.</p>
      ) : v.kind === "unknown" ? (
        <p className="mt-2 text-xs text-muted" data-readers="unknown">{failed ? "Couldn't ask the chat reader service." : got ? "The chat reader service answered in a shape this page does not know." : "Checking…"}</p>
      ) : v.rows.length === 0 ? (
        <p className="mt-2 text-xs text-muted" data-readers="none">No platform is set up to read chat from. <Link href="/admin/platforms" className="underline hover:text-strong">Admin → Platforms</Link></p>
      ) : (
        <ul className="mt-2 divide-y divide-edge" data-readers="ok">
          {v.rows.map((r) => (
            <li key={r.platform} className="py-1.5 first:pt-0 last:pb-0" data-reader={r.platform} data-state={r.state}>
              <div className="flex min-h-6 items-center gap-2 text-xs">
                <PlatformIcon platform={r.platform} size={14} />
                <span className="text-body">{platformLabel(r.platform)}</span>
                <span className={`ml-auto ${WORD[r.state].tone}`}>
                  {WORD[r.state].label}
                  {r.since && got && r.state !== "off" ? <span className="text-muted"> · {agoLabel(r.since, got.at)}</span> : null}
                </span>
              </div>
              {r.state === "failed" && (
                <p className="pl-6 text-2xs text-red-300 break-words" data-reader-error>{r.error ?? "No reason given."}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {v.kind === "ok" && v.bot !== null && <p className="mt-2 text-2xs text-faint">Chat bot: {v.bot === "running" ? "running" : "off"}</p>}
    </section>
  );
}
