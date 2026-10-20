"use client";

// One person's open suspicious mark in their usercard (mods only — the route refuses everyone
// else): the fixed-text reason, the evidence rows with the model's own reason on each, and Clear.

import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "@/app/lib/http";
import type { UserMark } from "@/app/lib/userMarks";

export function MarkPanel({ matrixId, canonicalId }: { matrixId: string | null; canonicalId: string | null }) {
  const [mark, setMark] = useState<UserMark | null | undefined>(undefined);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!matrixId && !canonicalId) return;
    const q = matrixId ? `matrixId=${encodeURIComponent(matrixId)}` : `canonicalId=${encodeURIComponent(canonicalId!)}`;
    getJson<{ mark: UserMark | null }>(`/api/mod/marks?${q}`).then((d) => setMark(d.mark)).catch(() => setMark(null));
  }, [matrixId, canonicalId]);
  useEffect(() => { load(); }, [load]);
  if ((!matrixId && !canonicalId) || !mark) return null;
  async function clear() {
    const res = await postJson(`/api/mod/marks/${mark!.id}/clear`, {}).catch(() => null);
    if (res?.ok) { setMsg("Mark cleared."); setMark(null); } else setMsg("Couldn't clear it — try again.");
  }
  return (
    <div className="px-3 py-2 border-b border-edge text-2xs space-y-1" aria-label="Suspicious mark">
      <div className="flex items-center gap-2">
        <span className="rounded px-1 font-semibold text-amber-300 border border-amber-400/40">Marked</span>
        <span className="text-secondary">{mark.reason}</span>
        <button type="button" onClick={() => void clear()}
          className="ml-auto px-1.5 py-0.5 rounded text-body-dim hover:text-strong hover:bg-surface-1 transition-colors">Clear</button>
      </div>
      <ul className="space-y-0.5">
        {mark.evidence.map((e) => (
          <li key={e.id} className="text-muted break-words">
            <span className="text-amber-300/80">{e.category ?? "?"}{e.confidence != null ? ` ${Math.round(e.confidence * 100)} %` : ""}</span>
            {" "}<span className="text-body-dim">“{e.text.slice(0, 140)}”</span>
            {e.reason && <span> — {e.reason}</span>}
          </li>
        ))}
      </ul>
      {msg && <p role="status" className="text-muted">{msg}</p>}
    </div>
  );
}
