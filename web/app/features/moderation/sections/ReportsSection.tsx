"use client";

// The Mod Panel's Reports: what viewers reported — from a chat line's ⋯ menu, a user card, or the
// help desk — for any mod to read and resolve. A report names a site account or a platform-only
// chatter, and the message it was filed from when there is one.
// Internal to the `moderation` feature — nothing outside can import it.

import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "@/app/lib/http";
import { LoadingState } from "@/app/components/Spinner";
import PlatformIcon from "@/app/components/PlatformIcon";
import { isNativePlatform } from "@/app/lib/nativePlatform";
import { card, h2, btn, timeAgo } from "../shared";

type Report = {
  id: number; reason: string; created_at: string; reported: string; reporter: string;
  reported_id: string | null; reported_canonical_id: string | null;
  message_platform: string | null; message_id: string | null; message_text: string | null;
};

export default function ReportsSection({ note, onBan }: { note: (m: string) => void; onBan?: (matrixId: string) => void }) {
  const [reports, setReports] = useState<Report[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getJson<{ reports: Report[] }>("/api/mod/support").then((d) => setReports(d.reports)).catch(() => setReports([]));
  }, []);
  useEffect(load, [load]);

  async function resolve(id: number) {
    setBusy(true);
    try {
      const res = await postJson("/api/mod/support", { kind: "report", id });
      if (!res.ok) note("Couldn't resolve — try again.");
      load();
    } catch {
      note("Couldn't resolve — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={card}>
      <h2 className={h2} data-repeats-place="">Reports</h2>
      {reports === null ? (
        <LoadingState label="Loading reports…" />
      ) : reports.length === 0 ? (
        <p className="text-sm text-muted">No pending reports. What viewers report from a chat line&apos;s ⋯ menu or a user card waits here for a mod.</p>
      ) : (
        <ul className="space-y-2">
          {reports.map((r) => (
            <li key={r.id} data-report={r.id} className="flex items-start gap-2 rounded-lg border border-edge p-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-body">
                  {r.message_platform && !isNativePlatform(r.message_platform) && (
                    <PlatformIcon platform={r.message_platform} size="0.9em" className="mr-1 inline-block align-baseline" />
                  )}
                  <span className="font-semibold">{r.reported}</span>
                  {!r.reported_id && <span className="text-muted"> (no site account)</span>}
                  <span className="text-muted"> reported by </span>
                  <span className="font-semibold">{r.reporter}</span>
                  <span className="text-muted"> · {timeAgo(r.created_at)}</span>
                </p>
                <p className="mt-0.5 text-sm text-body-dim">{r.reason}</p>
                {r.message_text != null && (
                  <p className="mt-1 border-l-2 border-edge pl-2 text-xs text-secondary break-words">“{r.message_text}”</p>
                )}
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                {onBan && r.reported_id && (
                  <button type="button" className={btn} onClick={() => onBan(r.reported_id!)}>Ban…</button>
                )}
                <button type="button" disabled={busy} onClick={() => resolve(r.id)} className={btn}>Resolve</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
