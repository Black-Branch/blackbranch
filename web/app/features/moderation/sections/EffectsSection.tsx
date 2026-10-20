"use client";

// Low-timer effects — the page treatment as the clock runs down. These are
// BROADCAST-WIDE (every viewer sees them). The per-viewer accessibility opt-out
// lives in settings → Theme → Timer glow and only suppresses the page glow.

import { useState } from "react";
import { postJson } from "@/app/lib/http";
import { useStreamTimer } from "@/app/lib/useStreamTimer";
import { card, h2, input, btn } from "../shared";

export default function EffectsSection({ note }: { note: (m: string) => void }) {
  const timer = useStreamTimer();
  const [threshold, setThreshold] = useState("");
  const [ramp, setRamp] = useState("");
  const [glow, setGlow] = useState("");
  const [busy, setBusy] = useState(false);

  // These have no slash command — they ride the panel-only "config" action on
  // the shared /api/mod/timer proxy.
  async function save(config: Record<string, unknown>, ok: string) {
    setBusy(true);
    try { await postJson("/api/mod/timer", { action: "config", config }); note(ok); }
    catch { note("That didn't go through."); }
    finally { setBusy(false); }
  }

  return (
    <section className={card}>
      <h2 className={h2}>Low-timer effects</h2>

      <label className="flex items-center gap-2 text-sm text-body mb-3">
        <input type="checkbox" checked={timer.effects.enabled} disabled={busy}
          onChange={(e) => save({ lowPulseEnabled: e.target.checked },
            e.target.checked ? "Effects on." : "Effects off.")} />
        Pulse
        <span className="text-xs text-secondary">master switch, for everyone</span>
      </label>

      <div className="flex flex-wrap gap-2 items-center mb-2">
        <span className="text-sm text-secondary w-28 shrink-0">Threshold (s)</span>
        <input className={input} value={threshold} inputMode="numeric" placeholder="300"
          onChange={(e) => setThreshold(e.target.value)} aria-label="Seconds at which effects begin" />
        <button type="button" className={btn} disabled={busy || !threshold}
          onClick={() => save({ lowThresholdSec: Number(threshold) }, "Threshold updated.")}>Save</button>
      </div>

      <div className="flex flex-wrap gap-2 items-center mb-2">
        <span className="text-sm text-secondary w-28 shrink-0">Ramp rate</span>
        <input className={input} value={ramp} inputMode="decimal" placeholder="1.6"
          onChange={(e) => setRamp(e.target.value)} aria-label="How sharply the effect ramps" />
        <button type="button" className={btn} disabled={busy || !ramp}
          onClick={() => save({ lowRampRate: Number(ramp) }, "Ramp rate updated.")}>Save</button>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-sm text-secondary w-28 shrink-0">Glow ceiling</span>
        <input className={input} value={glow} inputMode="decimal" placeholder="0.55"
          onChange={(e) => setGlow(e.target.value)} aria-label="Maximum page-glow opacity" />
        <button type="button" className={btn} disabled={busy || !glow}
          onClick={() => save({ lowGlowMax: Number(glow) }, "Glow ceiling updated.")}>Save</button>
      </div>

      <p className="text-xs text-secondary mt-2">
        Ramp above 1 holds back then accelerates late; below 1 comes on strong immediately.
        Out-of-range values are refused by the server, not silently clamped here.
      </p>
    </section>
  );
}
