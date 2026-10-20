"use client";

import { useEffect, useState } from "react";

// The bot's display name (instance key bot.name) for client components, fetched once per page
// load and shared. Until it arrives — or when it is unset — the caller's fallback shows.
let cached: string | null | undefined;
let inflight: Promise<string | null> | null = null;

function fetchName(): Promise<string | null> {
  inflight ??= fetch("/api/bot/name")
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { name?: unknown } | null) => (typeof j?.name === "string" && j.name.trim() ? j.name.trim() : null))
    .catch(() => null)
    .then((n) => { cached = n; return n; });
  return inflight;
}

/** The bot's name, or `fallback` while unknown or unset. */
export function useBotName(fallback: string): string {
  const [name, setName] = useState<string | null | undefined>(cached);
  useEffect(() => {
    if (cached !== undefined) return;
    let live = true;
    void fetchName().then((n) => { if (live) setName(n); });
    return () => { live = false; };
  }, []);
  return name || fallback;
}
