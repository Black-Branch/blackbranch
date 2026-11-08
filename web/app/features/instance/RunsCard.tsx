"use client";

// Admin Panel › Site › Community › Last applied: what the server's last run did, in the sentences
// the run itself wrote (each entry's `said`), and the last check if it is newer (spec 2026-10-23
// §4.1). A change made outside the panel and undone is "Put back:".

import type { RunView } from "@/app/lib/community/communityAdmin";
import { RUN_LIMIT_MS } from "@/app/lib/community/runLimit";
import { ago, btn, card, h2, h3 } from "./parts";

type Entry = { op?: string; kind?: string; said?: string; message?: string; label?: string; putBack?: boolean };

const SHOWN = 50;
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Where an apply run stands. A run writes its row when it starts and fills it when it ends; a row
 *  still unfinished past the run limit is a run that crashed, not one still going. */
function runStatus(run: RunView): string {
  if (!run.finishedAt) {
    return Date.now() - Date.parse(run.startedAt) < RUN_LIMIT_MS
      ? `Running since ${clock(run.startedAt)}.`
      : `Started at ${clock(run.startedAt)} and did not finish.`;
  }
  return `${ago(run.startedAt)}: ${run.ok === false ? `stopped. ${run.error ?? ""}` : "done."}`;
}

/** The sentence an entry carries; an older run's entry without one falls back to its label. */
function said(e: Entry): string {
  return e.said ?? e.message ?? `${e.op ?? e.kind ?? "change"} ${e.label ?? ""}`.trim();
}

/** An apply run's lines: what it did (put back or not), then what it left. */
function applyLines(run: RunView): string[] {
  const done = (run.applied as Entry[]).map((e) => (e.putBack ? `Put back: ${said(e)}` : cap1(said(e))));
  const left = (run.drift as Entry[]).map((e) => (e.op && e.op !== "warn" ? `Left as it is: ${said(e)}` : cap1(said(e))));
  return [...done, ...left];
}

function Lines({ lines }: { lines: readonly string[] }) {
  return (
    <ul className="mt-1.5 space-y-0.5 text-xs text-body">
      {lines.slice(0, SHOWN).map((l, i) => <li key={i} data-line>{l}</li>)}
      {lines.length > SHOWN && <li className="text-muted">and {lines.length - SHOWN} more</li>}
    </ul>
  );
}

export default function RunsCard({ lastApply, lastReport, reconciler, canAsk, waiting, notice, onRun }: {
  lastApply: RunView | null; lastReport: RunView | null;
  reconciler: boolean; canAsk: boolean;
  /** A run the page asked for and is waiting on. */
  waiting: "report" | "apply" | null;
  /** What became of it when it did not run (the host refused, or the wait ran out). */
  notice: string | null;
  onRun: (mode: "report" | "apply") => void;
}) {
  const reportNewer = lastReport && (!lastApply || lastReport.id > lastApply.id);
  return (
    <section className={card} aria-label="Last applied">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className={`${h2} mr-auto`}>Last applied</h2>
        {canAsk && <button type="button" className={btn} disabled={!!waiting} onClick={() => onRun("report")}>Check now</button>}
        {canAsk && reconciler && <button type="button" className={btn} disabled={!!waiting} onClick={() => onRun("apply")}>Apply now</button>}
      </div>
      {waiting && <p role="status" className="mt-1 text-xs text-secondary">{waiting === "report" ? "Checking…" : "Applying…"}</p>}
      {notice && <p role="status" className="mt-1 text-xs text-secondary">{notice}</p>}
      {!lastApply && <p className="mt-1 text-xs text-muted">Nothing has been applied yet.</p>}
      {lastApply && (
        <>
          <p data-run-status className="mt-1 text-xs text-secondary">{runStatus(lastApply)}</p>
          {applyLines(lastApply).length
            ? <Lines lines={applyLines(lastApply)} />
            : lastApply.finishedAt && <p className="mt-1 text-xs text-muted">Everything already matched.</p>}
        </>
      )}
      {reportNewer && lastReport && (
        <div className="mt-3 border-t border-edge pt-2">
          <h3 className={h3}>Last check, {ago(lastReport.startedAt)}</h3>
          {lastReport.ok === false
            ? <p className="mt-1 text-xs text-secondary">It stopped. {lastReport.error ?? ""}</p>
            : lastReport.drift.length
              ? <Lines lines={(lastReport.drift as Entry[]).map((e) => (e.op && e.op !== "warn" ? `Would change: ${said(e)}` : cap1(said(e))))} />
              : <p className="mt-1 text-xs text-muted">Everything matches.</p>}
        </div>
      )}
    </section>
  );
}
