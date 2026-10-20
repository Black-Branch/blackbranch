"use client";

// The Purge section of the mod panel, extracted from ModPanel.tsx.
// Internal to the `moderation` feature — nothing outside can import it.

import { useState } from "react";
import { postJson } from "@/app/lib/http";
import { card, h2, btn, shortName, resolveTarget } from "../shared";
import { matrixServerName } from "@/app/lib/matrixConfig";
import { purgeRequest } from "@/app/lib/modRequests";

// ─── Purge ────────────────────────────────────────────────────────────────────

export default function PurgeSection({ note, initialTarget }: { note: (m: string) => void; initialTarget?: string }) {
  const [target, setTarget] = useState(initialTarget ?? "");
  const [hours, setHours] = useState("24");
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function purge() {
    const matrixId = resolveTarget(target);
    setBusy(true);
    setArmed(false);
    try {
      const res = await postJson("/api/mod/purge", purgeRequest({ targetId: matrixId }, Number(hours) * 60));
      const d = await res.json().catch(() => ({} as { purged?: number }));
      note(res.ok
        ? `Purged ${d.purged ?? 0} message(s) from ${shortName(matrixId)} (last ${hours}h); platform removal is fanning out.`
        : "Purge failed.");
      if (res.ok) setTarget("");
    } catch {
      note("Purge failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={card}>
      <h2 className={h2}>Purge messages</h2>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={target}
          onChange={(e) => { setTarget(e.target.value); setArmed(false); }}
          placeholder={`username or @user:${matrixServerName()}`}
          className="flex-1 min-w-40 rounded-lg bg-surface-1 border border-edge px-3 py-1.5 text-sm text-body placeholder:text-muted outline-none focus:border-edge-strong"
        />
        <select
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          className="rounded-lg bg-surface-1 border border-edge px-2 py-1.5 text-xs text-body outline-none focus:border-edge-strong"
        >
          <option value="1">last 1h</option>
          <option value="6">last 6h</option>
          <option value="24">last 24h</option>
        </select>
        <button
          className={`${btn} ${armed ? "!bg-red-900/60 !text-red-100 !border-red-500/40" : "hover:!bg-red-900/50"}`}
          disabled={busy || !target.trim()}
          onClick={() => (armed ? purge() : setArmed(true))}
        >
          {armed ? "Confirm purge?" : "Purge"}
        </button>
      </div>
      <p className="mt-2 text-xs text-muted">
        Flags their recent messages everywhere on the site and removes them platform-side
        (Twitch via 1s timeout; Kick/YouTube per-message, capped).
      </p>
    </section>
  );
}
