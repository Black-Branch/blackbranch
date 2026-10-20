"use client";
// The Admin Panel's Payment history: every payment received — on this
// site and from each platform — and every failed payment, refund and dispute, newest first, with
// filters. The real gate is the route's requireAdmin(); the panel being admin-only is
// defense-in-depth.
import { useCallback, useEffect, useState } from "react";
import { getJson } from "@/app/lib/http";
import { LoadingState } from "@/app/components/Spinner";
import EmptyState from "@/app/components/EmptyState";
import { Chips } from "@/app/components/chrome";
import { platformLabel } from "@/app/lib/platforms";
import { siteName } from "@/app/lib/siteName";
import type { PaymentRow } from "@/app/lib/paymentHistory";
import { card, h2, btn, timeAgo } from "../shared";

// The stored outcome codes, in the words a reader uses (the codes stay the filter's values).
const OUTCOMES = [
  { key: "received", label: "Received" },
  { key: "failed", label: "Failed" }, { key: "refunded", label: "Refunded" }, { key: "refund_updated", label: "Refund changed" },
  { key: "dispute_opened", label: "Dispute opened" }, { key: "dispute_closed", label: "Dispute closed" }, { key: "renewal_failed", label: "Renewal failed" },
] as const;
const FILTERS = [{ key: "all", label: "All" }, ...OUTCOMES] as const;
const SOURCES = ["", "site", "twitch", "youtube", "kick", "kofi", "patreon", "streamlabs"] as const;
const outcomeWord = (o: string) => OUTCOMES.find((x) => x.key === o)?.label ?? o;
const sourceWord = (s: string) => (s === "" ? "every source" : s === "site" ? siteName() : s === "kofi" ? "Ko-fi" : s === "streamlabs" ? "Streamlabs" : s === "patreon" ? "Patreon" : platformLabel(s));
// In the payment's own currency (it printed "$" before every currency).
const money = (cents: number | null, currency: string | null) => {
  if (cents == null) return "—";
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: (currency ?? "usd").toUpperCase() }).format(cents / 100); }
  catch { return `${(cents / 100).toFixed(2)} ${(currency ?? "").toUpperCase()}`; }
};

type Reply = { rows: PaymentRow[]; nextBefore: string | null; last30: { count: number; cents: number } | null };

export default function PaymentsSection({ onSetup }: { onSetup?: () => void }) {
  const [rows, setRows] = useState<PaymentRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [last30, setLast30] = useState<Reply["last30"]>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const url = useCallback((before?: string) => {
    const qs = new URLSearchParams();
    if (outcome) qs.set("outcome", outcome);
    if (source) qs.set("source", source);
    if (before) qs.set("before", before);
    return `/api/mod/payments${qs.size ? `?${qs}` : ""}`;
  }, [outcome, source]);
  useEffect(() => {
    getJson<Reply>(url()).then((d) => { setRows(d.rows); setNext(d.nextBefore); setLast30(d.last30); }).catch(() => setRows([]));
  }, [url]);
  async function older() {
    if (!next) return;
    setBusy(true);
    try {
      const d = await getJson<Reply>(url(next));
      setRows((prev) => [...(prev ?? []), ...d.rows]);
      setNext(d.nextBefore);
    } finally { setBusy(false); }
  }
  const received = (rows ?? []).filter((r) => r.outcome === "received" && !r.points);
  const receivedCents = received.reduce((a, r) => a + (r.amount ?? 0), 0);

  return (
    <section className={card}>
      <h2 className={h2} data-repeats-place="">Payment history</h2>
      <div className="mt-2 mb-2 -mx-2">
        <Chips items={FILTERS} value={outcome ?? "all"} label="Show payments"
          onChange={(k) => { setRows(null); setOutcome(k === "all" ? null : k); }} />
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-secondary">
        <label className="flex items-center gap-1.5">From
          <select value={source} onChange={(e) => { setRows(null); setSource(e.target.value); }} aria-label="Source"
            className="rounded-lg bg-surface-1 border border-edge px-2 py-1 text-xs text-body">
            {SOURCES.map((s) => <option key={s} value={s}>{sourceWord(s)}</option>)}
          </select>
        </label>
        {last30 && (
          <span className="ml-auto" data-totals>
            Last 30 days: {money(last30.cents, "usd")} from {last30.count} payment{last30.count === 1 ? "" : "s"}
            {received.length > 0 && <> · shown: {money(receivedCents, "usd")} received{rows && rows.some((r) => r.points) ? " (points spends not counted)" : ""}</>}
          </span>
        )}
      </div>
      {rows === null ? (
        <LoadingState label="Loading payments…" />
      ) : rows.length === 0 ? (
        <EmptyState>
          {outcome ? `No payment is marked “${outcomeWord(outcome)}”${source ? ` from ${sourceWord(source)}` : ""}.`
            : "Every payment you receive — on this site and from each platform — shows here, with failures, refunds and disputes."}
          {onSetup && !outcome && <> <button type="button" className="underline hover:text-strong" onClick={onSetup}>Set up payments (Payments → Connections)</button></>}
        </EmptyState>
      ) : (
        <>
          <ul className="space-y-2">
            {rows.map((r) => (
              <li key={r.key} className="rounded-lg border border-edge p-3 text-sm" data-outcome={r.outcome}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  <span className={`rounded px-1.5 py-0.5 ${r.outcome === "received" ? "bg-emerald-500/15 text-emerald-300" : "bg-surface-2 text-body-dim"}`}>{outcomeWord(r.outcome)}</span>
                  <span className="text-body">{money(r.amount, r.currency)}{r.points ? " in points" : ""}</span>
                  <span>· {r.who}</span>
                  <span>· {r.kind ?? "unknown"}</span>
                  <span>· {sourceWord(r.source)}</span>
                  <span title={new Date(r.time).toLocaleString()}>· {timeAgo(r.time)}</span>
                  {r.link && <a href={r.link} target="_blank" rel="noopener" className="ml-auto text-accent hover:underline">Stripe ↗</a>}
                </div>
                {r.reasonText && <p className="mt-1.5 text-body-dim">{r.reasonText}</p>}
              </li>
            ))}
          </ul>
          {next && <button type="button" className={`${btn} mt-3`} disabled={busy} onClick={() => void older()}>Show older</button>}
        </>
      )}
    </section>
  );
}
