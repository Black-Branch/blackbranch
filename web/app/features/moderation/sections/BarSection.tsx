"use client";

// Support-bar economics — the panel form of `/bar hr|fill`.
//
// These two are DOLLAR settings, not timer settings: `fill` is the bar's $
// target and `hr` is both the timer earn-rate AND the bar's segment size
// (segments = ceil(fill / hr) = hour marks). Colour is deliberately NOT here —
// it is a per-viewer setting in the Theme tab.

import { useState } from "react";
import { postJson } from "@/app/lib/http";
import { card, h2, input, btn } from "../shared";

export default function BarSection({ note }: { note: (m: string) => void }) {
  const [goal, setGoal] = useState("");
  const [rate, setRate] = useState("");
  const [busy, setBusy] = useState(false);

  // Same proxy the `/bar hr|fill` commands use.
  async function save(body: unknown, ok: string) {
    setBusy(true);
    try { await postJson("/api/mod/timer", body); note(ok); }
    catch { note("That didn't go through."); }
    finally { setBusy(false); }
  }

  return (
    <section className={card}>
      <h2 className={h2}>Support bar</h2>
      <div className="flex flex-wrap gap-2 items-center mb-2">
        <span className="text-sm text-secondary w-24 shrink-0">Goal ($)</span>
        <input className={input} value={goal} inputMode="decimal" placeholder="200"
          onChange={(e) => setGoal(e.target.value)} aria-label="Dollars that fill the bar" />
        <button type="button" className={btn} disabled={busy || !goal}
          onClick={() => save({ action: "fill", value: Number(goal) }, "Goal updated.")}>Save</button>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-sm text-secondary w-24 shrink-0">Rate ($/hr)</span>
        <input className={input} value={rate} inputMode="decimal" placeholder="40"
          onChange={(e) => setRate(e.target.value)} aria-label="Dollars that buy one hour" />
        <button type="button" className={btn} disabled={busy || !rate}
          onClick={() => save({ action: "hr", value: Number(rate) }, "Rate updated.")}>Save</button>
      </div>
      <p className="text-xs text-secondary mt-2">
        Segments on the bar are goal ÷ rate — each one is an hour mark.
      </p>
    </section>
  );
}
