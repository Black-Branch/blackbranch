"use client";

// The Admin Panel's Moderators: who holds the mod role, adding and removing it. The same route as
// the `/mod` and `/unmod` commands and the user card's Make / Remove moderator (admin only). A
// moderator's power in the community rooms follows at the owner's next visit to the community
// (useModPowerSync), in both directions.

import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "@/app/lib/http";
import { LoadingState } from "@/app/components/Spinner";
import { matrixServerName } from "@/app/lib/matrixConfig";
import { card, h2, btn, input, timeAgo, shortName, resolveTarget } from "../shared";

type Moderator = { matrixId: string; displayName: string | null; since: string | null };

export default function ModeratorList({ note }: { note: (m: string) => void }) {
  const [mods, setMods] = useState<Moderator[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getJson<{ moderators: Moderator[] }>("/api/mod/setmod").then((d) => setMods(d.moderators)).catch(() => setMods([]));
  }, []);
  useEffect(load, [load]);

  async function setRole(targetId: string, grant: boolean) {
    setBusy(true);
    try {
      const res = await postJson("/api/mod/setmod", { targetId, grant });
      if (res.status === 404) note("No account by that name.");
      else if (!res.ok) note("Couldn't change the role — try again.");
      else {
        note(grant ? `${shortName(targetId)} is now a moderator.` : `${shortName(targetId)} is no longer a moderator.`);
        if (grant) setName("");
      }
      load();
    } catch {
      note("Couldn't change the role — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={card}>
      <h2 className={h2}>Moderators</h2>
      <p className="mb-3 text-xs text-muted">
        Moderators get the Mod Panel and mod power in the community rooms. Admins have every mod power already.
        In chat: <code>/mod &lt;user&gt;</code> and <code>/unmod &lt;user&gt;</code>.
      </p>
      <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void setRole(resolveTarget(name), true); }}>
        <input className={input} value={name} onChange={(e) => setName(e.target.value)}
          placeholder={`username or @user:${matrixServerName()}`} aria-label="Make a moderator" />
        <button type="submit" className={btn} disabled={busy || !name.trim()}>Make moderator</button>
      </form>
      {mods === null ? (
        <LoadingState />
      ) : mods.length === 0 ? (
        <p className="text-sm text-muted">No moderators yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {mods.map((m) => (
            <li key={m.matrixId} className="flex items-center gap-3 rounded-lg bg-surface-1 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <span className="font-medium text-body">{shortName(m.matrixId, m.displayName)}</span>
                <span className="ml-2 text-xs text-muted">{m.matrixId}</span>
                {m.since && <span className="ml-2 text-xs text-muted">since {timeAgo(m.since)}</span>}
              </div>
              <button type="button" className={btn} disabled={busy} onClick={() => void setRole(m.matrixId, false)}>Remove moderator</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
