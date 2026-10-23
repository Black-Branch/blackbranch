"use client";

// Admin Panel → Site → Points: the site currency as settings.
// Name and look, Buying and Earning are instance keys (KeyCards, the same rows as every other
// section); Store prices is a table of its own, edited as prices. A price is stored as streams of
// earning (so a later change to what a stream earns moves it with the rest); the table converts.
// What a typical viewer earns per stream is shown as information, never edited here.
//
// Every route behind this checks is_admin itself — this component being admin-only is not the
// guard. Prices are public; nothing secret passes through here.

import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "@/app/lib/http";
import { FIELD } from "@/app/components/SettingsControls";
import type { InstanceView } from "@/app/lib/instanceAdminView";
import { currencyLabel, currencyName } from "@/app/lib/currency";
import { formatCoinsShort } from "@/app/lib/coins";
import PointsIcon from "@/app/components/PointsIcon";
import { card, h2, btn } from "./parts";
import { keyGroupsFor } from "./adminLayout";
import KeyCards from "./KeyCards";

type PriceRow = { itemKey: string; baseStreams: number; price: number };

/** Plain names for the store's items (the keys are the spend sinks' own). */
const ITEM_LABEL: Record<string, string> = {
  sticker: "Sticker", sticker_boost: "Sticker boost (least)", highlight: "Highlight a message",
  tts: "Read a message aloud", badge_slot: "Extra badge slot",
};
const narrow = `${FIELD} w-20 shrink-0 px-2 text-xs tabular-nums`;

/** The streams of earning a typed price is stored as (three decimals, as the column holds).
 *  @test-only exported so pointsPanel.render.test.ts can hold the conversion (the row calls it here). */
export function streamsForPrice(price: number, e: number): number {
  return Math.round((price / e) * 1000) / 1000;
}

function PriceRowEdit({ row, e, onSaved, note }: { row: PriceRow; e: number; onSaved: () => void; note: (m: string) => void }) {
  const [draft, setDraft] = useState(String(row.price));
  const [busy, setBusy] = useState(false);
  const label = ITEM_LABEL[row.itemKey] ?? row.itemKey;
  async function save() {
    setBusy(true);
    try {
      const res = await postJson(`/api/admin/points/prices/${encodeURIComponent(row.itemKey)}`, { baseStreams: streamsForPrice(Number(draft), e) }, "PUT");
      const j = (await res.json().catch(() => ({}))) as { error?: string; from?: number; to?: number };
      if (res.ok) { note(`${label}: ${j.from} → ${j.to}.`); onSaved(); }
      else note(`${label}: ${j.error ?? "not saved"}`);
    } catch { note(`${label}: not saved (network)`); }
    finally { setBusy(false); }
  }
  const changed = draft.trim() !== "" && Number(draft) > 0 && Number(draft) !== row.price;
  return (
    <li className="flex flex-wrap items-center gap-2 border-t border-edge pt-2 first:border-t-0 first:pt-0" data-item={row.itemKey}>
      <span className="min-w-0 flex-1 basis-40 text-sm text-body">{label}</span>
      <form className="flex items-center gap-2" onSubmit={(ev) => { ev.preventDefault(); if (changed) void save(); }}>
        <input className={narrow} inputMode="numeric" value={draft} onChange={(ev) => setDraft(ev.target.value.replace(/\D/g, ""))}
          aria-label={`${label}: price`} />
        <span className="text-2xs text-muted">{currencyName()}</span>
        <button type="submit" className={btn} disabled={busy || !changed}>Save</button>
      </form>
      <span className="ml-auto w-28 shrink-0 text-right text-2xs tabular-nums text-muted" data-streams>about {row.baseStreams} stream{row.baseStreams === 1 ? "" : "s"} of earning</span>
    </li>
  );
}

function StorePrices({ note }: { note: (m: string) => void }) {
  const [data, setData] = useState<{ rows: PriceRow[]; e: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    getJson<{ rows: PriceRow[]; e: number }>("/api/admin/points", { cache: "no-store" })
      .then((d) => { setData(d); setErr(null); })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "could not load"));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <section className={card} aria-label="Store prices">
      <h2 className={h2}>Store prices</h2>
      <p className="mt-0.5 text-xs text-muted">
        What each item costs. Badges and name styles are priced in the store itself.
      </p>
      {err && <p className="mt-2 text-xs text-red-300">Could not load the prices: {err}</p>}
      {!data && !err && <p role="status" className="mt-2 text-xs text-muted">Loading prices…</p>}
      {data && (
        <>
          <p className="mt-2 text-xs text-secondary" data-typical>A typical viewer earns about {currencyLabel(data.e)} per stream.</p>
          <ul className="mt-3 space-y-2">
            {/* Keyed on the stored value too: a saved change remounts the row with the new number. */}
            {data.rows.map((r) => <PriceRowEdit key={`${r.itemKey}:${r.price}`} row={r} e={data.e} onSaved={load} note={note} />)}
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
