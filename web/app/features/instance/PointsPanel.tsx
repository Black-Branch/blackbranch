"use client";

// Admin Panel → Site → Points: the site currency as settings.
// Name and look, Buying and Earning are instance keys (KeyCards — the same rows as every other
// section); Store prices is a table of its own: E with a preview before anything moves, and each
// item's size in streams.
//
// Every route behind this checks is_admin itself — this component being admin-only is not the
// guard. Prices are public; nothing secret passes through here.

import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "@/app/lib/http";
import { FIELD } from "@/app/components/SettingsControls";
import type { InstanceView } from "@/app/lib/instanceAdminView";
import { currencyLabel, currencyName, currencyTitle } from "@/app/lib/currency";
import { formatCoinsShort } from "@/app/lib/coins";
import PointsIcon from "@/app/components/PointsIcon";
import { card, h2, btn } from "./parts";
import { keyGroupsFor } from "./adminLayout";
import KeyCards from "./KeyCards";

type PriceRow = { itemKey: string; baseStreams: number; price: number };
type Change = { itemKey: string; from: number; to: number };

/** Plain names for the store's items (the keys are the spend sinks' own). */
const ITEM_LABEL: Record<string, string> = {
  sticker: "Sticker", sticker_boost: "Sticker boost (least)", highlight: "Highlight a message",
  tts: "Read a message aloud", badge_slot: "Extra badge slot",
};
const narrow = `${FIELD} w-20 shrink-0 px-2 text-xs tabular-nums`;

function PriceRowEdit({ row, onSaved, note }: { row: PriceRow; onSaved: () => void; note: (m: string) => void }) {
  const [draft, setDraft] = useState(String(row.baseStreams));
  const [busy, setBusy] = useState(false);
  const label = ITEM_LABEL[row.itemKey] ?? row.itemKey;
  async function save() {
    setBusy(true);
    try {
      const res = await postJson(`/api/admin/points/prices/${encodeURIComponent(row.itemKey)}`, { baseStreams: Number(draft) }, "PUT");
      const j = (await res.json().catch(() => ({}))) as { error?: string; from?: number; to?: number };
      if (res.ok) { note(`${label}: ${j.from} → ${j.to}.`); onSaved(); }
      else note(`${label}: ${j.error ?? "not saved"}`);
    } catch { note(`${label}: not saved (network)`); }
    finally { setBusy(false); }
  }
  const changed = draft.trim() !== "" && Number(draft) !== row.baseStreams;
  return (
    <li className="flex flex-wrap items-center gap-2 border-t border-edge pt-2 first:border-t-0 first:pt-0" data-item={row.itemKey}>
      <span className="min-w-0 flex-1 basis-40 text-sm text-body">{label}</span>
      <form className="flex items-center gap-2" onSubmit={(ev) => { ev.preventDefault(); if (changed) void save(); }}>
        <input className={narrow} inputMode="decimal" value={draft} onChange={(e) => setDraft(e.target.value)}
          aria-label={`${label}: streams of earning`} />
        <span className="text-2xs text-muted">streams</span>
        <button type="submit" className={btn} disabled={busy || !changed}>Save</button>
      </form>
      <span className="ml-auto w-24 shrink-0 text-right text-xs tabular-nums text-secondary">{currencyLabel(row.price)}</span>
    </li>
  );
}

function StorePrices({ note }: { note: (m: string) => void }) {
  const [data, setData] = useState<{ rows: PriceRow[]; e: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [eDraft, setEDraft] = useState("");
  const [plan, setPlan] = useState<{ e: number; changes: Change[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    getJson<{ rows: PriceRow[]; e: number }>("/api/admin/points", { cache: "no-store" })
      .then((d) => { setData(d); setErr(null); setEDraft(String(d.e)); })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "could not load"));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function recompute(apply: boolean) {
    const e = apply && plan ? plan.e : Math.round(Number(eDraft));
    setBusy(true);
    try {
      const res = await postJson("/api/store/prices/recompute", { e, apply });
      const j = (await res.json().catch(() => ({}))) as { changes?: Change[]; error?: string; min?: number; max?: number };
      if (!res.ok) { note(j.error === "bad_e" ? `Points per stream must be ${j.min}–${j.max}.` : "Could not read the change."); return; }
      if (apply) { setPlan(null); note(`Points per stream is now ${e}; ${j.changes?.length ?? 0} price(s) moved.`); load(); }
      else setPlan({ e, changes: j.changes ?? [] });
    } catch { note("Not saved (network)"); }
    finally { setBusy(false); }
  }

  return (
    <section className={card} aria-label="Store prices">
      <h2 className={h2}>Store prices</h2>
      <p className="mt-0.5 text-xs text-muted">
        Each price is stored as streams of earning and shown at today&apos;s {currencyName()} per stream, so changing
        what a stream earns moves every price together. Badges and name styles are priced in the store itself.
      </p>
      {err && <p className="mt-2 text-xs text-red-300">Could not load the prices: {err}</p>}
      {!data && !err && <p role="status" className="mt-2 text-xs text-muted">Loading prices…</p>}
      {data && (
        <>
          <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={(ev) => { ev.preventDefault(); void recompute(false); }}>
            <span className="min-w-0 flex-1 basis-40 text-sm text-body">{currencyTitle()} a viewer earns per stream</span>
            <input className={narrow} inputMode="numeric" value={eDraft} onChange={(e) => { setEDraft(e.target.value); setPlan(null); }}
              aria-label={`${currencyTitle()} a typical viewer earns per stream`} />
            <button type="submit" className={btn} disabled={busy || !eDraft.trim() || Number(eDraft) === data.e}>Preview</button>
          </form>
          {plan && (
            <div className="mt-2 rounded-lg border border-edge bg-surface-2 p-2 text-xs text-secondary" role="status">
              {plan.changes.length === 0
                ? <p>No price would move — the rounding steps absorb a change this small.</p>
                : <ul>{plan.changes.map((c) => <li key={c.itemKey}>{ITEM_LABEL[c.itemKey] ?? c.itemKey}: {c.from} → {c.to}</li>)}</ul>}
              <p className="mt-1 text-muted">Prices move at most 10% (or one rounding step) per change, so a big jump takes several.</p>
              <div className="mt-2 flex gap-2">
                <button type="button" className={btn} disabled={busy} onClick={() => void recompute(true)}>Apply</button>
                <button type="button" className={btn} disabled={busy} onClick={() => setPlan(null)}>Cancel</button>
              </div>
            </div>
          )}
          <ul className="mt-3 space-y-2">
            {/* Keyed on the stored value too: a saved change remounts the row with the new number. */}
            {data.rows.map((r) => <PriceRowEdit key={`${r.itemKey}:${r.baseStreams}`} row={r} onSaved={load} note={note} />)}
          </ul>
        </>
      )}
    </section>
  );
}

export default function PointsPanel({ inst, reloadInst, note }: {
  inst: InstanceView; reloadInst: () => void; note: (m: string) => void;
}) {
  return (
    <>
      <section className={card} aria-label="How points look">
        <h2 className={h2}>How it reads</h2>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-body">
          <span className="inline-flex items-center gap-1"><PointsIcon size={16} /> {currencyLabel(150)}</span>
          <span className="tabular-nums">{formatCoinsShort(1475)}</span>
          <span className="text-secondary">“Not enough {currencyName()}.”</span>
        </p>
      </section>
      <KeyCards view={inst} groups={keyGroupsFor("site", "points")} onChanged={reloadInst} note={note} />
      <StorePrices note={note} />
    </>
  );
}
