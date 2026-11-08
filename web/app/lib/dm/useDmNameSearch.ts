"use client";

// The people a typed name can mean, as you type it (ticket #193): the `/dm` name's completion and the
// DM list's "+" both ask the same lookup (/api/dm/resolve — every site account, anywhere in the
// name). One request per pause in typing; an answer for an older query never replaces a newer one.

import { useEffect, useState } from "react";
import { resolveDmName } from "./api.ts";
import type { DmPerson } from "./bus.ts";

/** How long typing must pause before the lookup goes. */
const PAUSE_MS = 200;

export type DmNameSearch = { query: string; people: DmPerson[]; status: "idle" | "searching" | "done" | "failed" };

export function useDmNameSearch(query: string | null): DmNameSearch {
  const q = (query ?? "").trim().replace(/^@/, "");
  const [answer, setAnswer] = useState<DmNameSearch>({ query: "", people: [], status: "idle" });
  useEffect(() => {
    if (!q) return;
    let alive = true;
    const timer = setTimeout(() => {
      void resolveDmName(q).then((r) => {
        if (!alive) return;
        setAnswer(r.ok ? { query: q, people: r.people, status: "done" } : { query: q, people: [], status: "failed" });
      });
    }, PAUSE_MS);
    return () => { alive = false; clearTimeout(timer); };
  }, [q]);
  if (!q) return { query: "", people: [], status: "idle" };
  // A stale answer (for another query) is not shown as this one's.
  return answer.query === q ? answer : { query: q, people: [], status: "searching" };
}
