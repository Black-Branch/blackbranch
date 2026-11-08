"use client";

// The DM list's "+" (Discord's new message; ticket #193): type a name, see every site account it can
// mean — username or display name, anywhere in either, the matched part marked — and pick one to
// open a conversation with them. Opening makes nothing: the first line does (Task 2's draft).

import { useEffect, useRef, useState } from "react";
import { MatchText } from "@/app/components/MatchText";
import { useDmNameSearch } from "@/app/lib/dm/useDmNameSearch";

export function NewMessageSearch({ onPick, onDone }: { onPick: (matrixId: string) => void; onDone: () => void }) {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const search = useDmNameSearch(q);
  return (
    <div data-new-message="" className="mx-2 mb-2 rounded-md bg-surface-1 p-1.5">
      <input
        ref={input}
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") onDone(); }}
        placeholder="Who do you want to message?"
        aria-label="Find someone to message"
        className="h-9 w-full rounded bg-surface-2 px-2 text-sm text-body placeholder:text-muted outline-none focus-visible:outline focus-visible:outline-edge-bright"
      />
      {search.status === "done" && !search.people.length && (
        <p className="px-1 pt-1.5 text-xs text-muted">No one goes by that.</p>
      )}
      {search.status === "failed" && <p role="alert" className="px-1 pt-1.5 text-xs text-red-300">Couldn&apos;t look that up. Try again.</p>}
      {search.people.length > 0 && (
        <ul className="mt-1 flex flex-col" role="listbox" aria-label="People">
          {search.people.map((p) => (
            <li key={p.matrixId}>
              <button type="button" role="option" aria-selected={false}
                onClick={() => { onPick(p.matrixId); onDone(); }}
                className="flex h-11 w-full items-center gap-2 rounded-md px-1.5 text-left hover:bg-surface-2 focus-visible:outline focus-visible:outline-edge-bright">
                <img src={`/api/avatar/user/${encodeURIComponent(p.matrixId)}`} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-heading"><MatchText text={p.displayName || p.username} query={search.query} /></span>
                  {/* The full id: two accounts can share a name (another server's), and this says which. */}
                  <span className="block truncate text-2xs text-muted"><MatchText text={p.matrixId} query={search.query} /></span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
