"use client";

// Admin Panel → Doctor: the same list, verdicts and fix lines as `blackbranch doctor`, grouped by
// area. Every check is read-only; "Check again" asks the box for fresh facts and makes the list
// again.

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle, WarningCircle, XCircle, MinusCircle } from "@phosphor-icons/react/dist/ssr";
import { getJson, postJsonOrThrow } from "@/app/lib/http";
import type { DoctorView } from "@/app/lib/doctor/doctorServer";
import { DOCTOR } from "@/app/lib/doctor.generated.mjs";
import { card, h2, btn, chip, ago } from "./parts";

type Row = DoctorView["rows"][number];
const STALE_MS = 10 * 60_000;

const LOOK: Record<Row["status"], { icon: typeof CheckCircle; cls: string; label: string }> = {
  ok: { icon: CheckCircle, cls: "text-emerald-400", label: "ok" },
  warn: { icon: WarningCircle, cls: "text-amber-300", label: "to look at" },
  fail: { icon: XCircle, cls: "text-red-300", label: "failing" },
  grey: { icon: MinusCircle, cls: "text-faint", label: "not checked" },
};

/** One check: its mark, title, detail and (when it fails or is amber) its fix line. Shared with the
 *  Updates section, which shows the same rows. */
export function DoctorRowItem({ r }: { r: Row }) {
  const L = LOOK[r.status];
  const Icon = L.icon;
  return (
    <li className="flex gap-2 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-edge-bright" data-check={r.id} data-status={r.status} tabIndex={-1}>
      <Icon size={16} weight="fill" className={`mt-px shrink-0 ${L.cls}`} aria-label={L.label} />
      <div className="min-w-0">
        <p className={`text-sm ${r.status === "grey" ? "text-muted" : "text-body"}`}>{r.title}</p>
        {r.detail && <p className={`text-xs break-words ${r.status === "fail" ? "text-red-300" : r.status === "warn" ? "text-amber-300" : "text-muted"}`}>{r.detail}</p>}
        {(r.status === "fail" || r.status === "warn") && r.fix && (
          <p className="mt-0.5 text-xs text-body-dim break-words"><span className="font-medium text-body">Fix:</span> {r.fix}</p>
        )}
      </div>
    </li>
  );
}

type Group = { status: Row["status"]; words: string; meaning: string; n: number };

/** The header's three lines' words: "Failing", "To look at", "OK" (the ok line carries the
 *  not-checked count in brackets). */
const HEAD: Record<string, string> = { fail: "Failing", warn: "To look at", ok: "OK" };

/** One line of the header: the group's words and count, then what it asks of the reader. A count
 *  with rows behind it that need something (failing, to look at) jumps to the first of them: on a
 *  phone the list is long. The OK line carries the not-checked count. */
function GroupLine({ g, grey }: { g: Group; grey?: Group }) {
  const cls = LOOK[g.status].cls;
  const jump = () => {
    const el = document.querySelector<HTMLElement>(`[data-check][data-status="${g.status}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    el?.focus({ preventScroll: true });
  };
  const count = <>{HEAD[g.status]} <span className="tabular-nums">{g.n}</span>{grey ? <> ({grey.n} not checked)</> : null}</>;
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 text-xs" data-group={g.status} data-n={g.n} data-grey={grey?.n}>
      {g.n > 0 && (g.status === "fail" || g.status === "warn") ? (
        <button type="button" onClick={jump} className={`${chip} ${cls} hover:bg-surface-2 outline-none focus-visible:ring-1 focus-visible:ring-edge-bright`}>
          {count} ↓
        </button>
      ) : (
        <span className={`${chip} ${g.n ? cls : "text-muted"}`}>{count}</span>
      )}
      {g.n > 0 && g.meaning && <span className="min-w-0 text-secondary">{g.meaning}</span>}
      {grey && grey.n > 0 && grey.meaning && <span className="min-w-0 text-muted" data-grey-meaning>Not checked: {grey.meaning}</span>}
    </li>
  );
}

export default function DoctorPanel() {
  const [view, setView] = useState<DoctorView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);

  const recheck = useCallback(() => {
    setBusy(true);
    postJsonOrThrow<DoctorView>("/api/admin/doctor", {}, "POST", { timeoutMs: 90_000 })
      .then((v) => { setView(v); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "could not check"))
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    getJson<DoctorView>("/api/admin/doctor", { cache: "no-store" })
      .then((v) => {
        setView(v); setError(null);
        // The box's facts are made on demand: fetch fresh ones when there are none or they are old.
        const stale = v.bundle && (!v.hostAt || Date.now() - new Date(v.hostAt).getTime() > STALE_MS);
        if (stale && !asked.current) { asked.current = true; recheck(); }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "could not load"));
  }, [recheck]);

  if (error && !view) return <p className="text-sm text-red-300">Could not run the doctor: {error}</p>;
  if (!view) return <p role="status" className="text-sm text-muted">Running the checks…</p>;

  const areas = [...new Set(view.rows.map((r) => r.area))];
  const groups = DOCTOR.summary(view.rows) as Group[];
  const grey = groups.find((g) => g.status === "grey");
  return (
    <>
      <section className={card} aria-label="Doctor">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className={h2}>Doctor</h2>
            <p className="mt-0.5 text-xs text-muted">
              Every check only reads. The same list is printed on the server by <span className="font-mono">sudo blackbranch doctor</span>.
            </p>
          </div>
          <button type="button" className={btn} disabled={busy} onClick={recheck}>{busy ? "Checking…" : "Check again"}</button>
        </div>
        <ul className="mt-3 space-y-1" role="status" aria-label="Summary">
          {groups.filter((g) => g.status !== "grey").map((g) => <GroupLine key={g.status} g={g} grey={g.status === "ok" ? grey : undefined} />)}
        </ul>
        <p className="mt-2 text-2xs text-muted">
          {view.bundle
            ? <>The box: checked {ago(view.hostAt)}. The site: checked {ago(view.siteAt)}.</>
            : <>This site is not a bundle install, so the box&apos;s own checks are not available here.</>}
        </p>
        {view.hostNote && <p className="mt-1 text-xs text-amber-300 break-words">{view.hostNote}</p>}
        {error && <p className="mt-1 text-xs text-red-300 break-words">Could not check again: {error}</p>}
      </section>
      {areas.map((a) => (
        <section key={a} className={card} aria-label={a}>
          <h2 className={h2}>{a}</h2>
          <ul className="mt-3 space-y-2.5">
            {view.rows.filter((r) => r.area === a).map((r) => <DoctorRowItem key={r.id} r={r} />)}
          </ul>
        </section>
      ))}
    </>
  );
}
