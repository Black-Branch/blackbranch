"use client";

// The SlowMode section of the mod panel, extracted from ModPanel.tsx.
// Internal to the `moderation` feature — nothing outside can import it.

import { useEffect, useState } from "react";
import { siteName } from "@/app/lib/siteName";
import { getJson, postJson } from "@/app/lib/http";
import { slowModeHint, slowModeNote } from "@/app/lib/slowModeCopy";
import { card, h2, btn } from "../shared";

// ─── Slow mode ────────────────────────────────────────────────────────────────

const SLOW_PRESETS = [0, 5, 10, 30, 60, 120] as const;

export default function SlowModeSection({ note }: { note: (m: string) => void }) {
  const [current, setCurrent] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [mirrors, setMirrors] = useState<string[]>([]);

  useEffect(() => {
    getJson<{ slowModeSeconds: number; mirrorsTo?: string[] }>("/api/mod/slowmode")
      .then((d) => { setCurrent(d.slowModeSeconds); setMirrors(d.mirrorsTo ?? []); })
      .catch(() => setCurrent(0));
  }, []);

  async function apply(seconds: number) {
    setBusy(true);
    try {
      const res = await postJson("/api/mod/slowmode", { seconds });
      if (res.ok) {
        setCurrent(seconds);
        note(slowModeNote(seconds, mirrors));
      } else {
        note("Couldn't update slow mode.");
      }
    } catch {
      note("Couldn't update slow mode.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={card}>
      <h2 className={h2}>Slow mode</h2>
      <div className="flex flex-wrap items-center gap-2">
        {SLOW_PRESETS.map((s) => (
          <button
            key={s}
            disabled={busy || current === null}
            onClick={() => apply(s)}
            className={`${btn} ${current === s ? "!border-sky-500/50 !bg-sky-500/15 !text-sky-300" : ""}`}
          >
            {s === 0 ? "Off" : `${s}s`}
          </button>
        ))}
        <span className="text-xs text-muted ml-1">
          {slowModeHint(siteName(), mirrors)}
        </span>
      </div>
    </section>
  );
}
