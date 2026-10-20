"use client";
// The Stream tab's health strip: the doctor's own verdicts counted, the first failing check named,
// and the way to the Doctor. Read from the existing GET /api/admin/doctor — no new checks. Fetched
// when the tab opens and on Refresh, never polled: the doctor gathers the site's facts on every
// call.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getJson } from "@/app/lib/http";
import { healthSummary, type DoctorRow } from "@/app/lib/streamStats";
import { card, cardTitle } from "./StreamCharts";

const ORDER = [
  { status: "fail", label: "failing", tone: "text-red-400" },
  { status: "warn", label: "warning", tone: "text-amber-300" },
  { status: "ok", label: "ok", tone: "text-emerald-300" },
  { status: "grey", label: "not checked", tone: "text-muted" },
] as const;

export function StreamHealth({ active }: { active: boolean }) {
  const [rows, setRows] = useState<DoctorRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    getJson<{ rows: DoctorRow[] }>("/api/admin/doctor")
      .then((d) => { setRows(d.rows); setFailed(false); })
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => { if (active) load(); }, [active, load]);
  const s = rows ? healthSummary(rows) : null;
  return (
    <section className={card} data-section="health">
      <div className={cardTitle}>
        <span>Health</span>
        <span className="flex items-center gap-3 normal-case tracking-normal font-normal">
          <button type="button" onClick={load} className="text-2xs text-muted underline hover:text-strong">Refresh</button>
          <Link href="/admin/doctor" className="text-2xs text-muted underline hover:text-strong">Open Doctor</Link>
        </span>
      </div>
      {!s ? (
        <p className="mt-2 text-xs text-muted">{failed ? "Couldn't ask the doctor." : "Checking…"}</p>
      ) : (
        <>
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums" data-health>
            {ORDER.filter((o) => s.counts[o.status] > 0).map((o) => (
              <span key={o.status} className={o.tone}>{s.counts[o.status]} {o.label}</span>
            ))}
          </p>
          {s.worst && <p className="mt-1 text-2xs text-muted">First to look at: {s.worst.title}</p>}
        </>
      )}
    </section>
  );
}
