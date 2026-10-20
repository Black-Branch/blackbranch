"use client";

// Open suspicious marks (automod): who, why (fixed text), the latest evidence, and
// Clear. Mods only — the route checks. A mark changes nothing about what a person can post.

import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "@/app/lib/http";
import type { UserMark } from "@/app/lib/userMarks";
import { card, h2, btn, timeAgo } from "../shared";

export default function MarksSection({ note }: { note: (m: string) => void }) {
  const [marks, setMarks] = useState<UserMark[] | null>(null);
  const load = useCallback(() => {
    getJson<{ marks: UserMark[] }>("/api/mod/marks").then((d) => setMarks(d.marks)).catch(() => setMarks([]));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!marks || marks.length === 0) return null;
  async function clear(id: number) {
    const res = await postJson(`/api/mod/marks/${id}/clear`, {}).catch(() => null);
    note(res?.ok ? "Mark cleared." : "Couldn't clear that mark — try again.");
    load();
  }
  return (
    <section className={card} aria-label="Suspicious marks">
      <h2 className={h2}>Marked by automod</h2>
      <p className="mt-0.5 mb-2 text-xs text-muted">People with repeated risky messages. Only mods see this; it changes nothing about what they can post.</p>
      <ul className="space-y-2">
        {marks.map((m) => (
          <li key={m.id} className="flex items-start gap-3 rounded-lg bg-surface-1 px-3 py-2">
            <div className="min-w-0 flex-1 text-xs">
              <div className="text-secondary">
                <span className="font-medium text-body">{m.platformUser ?? m.matrixId ?? m.canonicalId}</span>
                {m.platform && <span className="ml-2 text-muted">{m.platform}</span>}
                <span className="ml-2 text-muted">{timeAgo(m.createdAt)}</span>
              </div>
              <div className="text-amber-300/90">{m.reason}</div>
              {m.evidence[0] && <div className="text-body-dim break-words">latest: “{m.evidence[0].text.slice(0, 160)}”</div>}
            </div>
            <button type="button" className={btn} onClick={() => void clear(m.id)}>Clear</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
