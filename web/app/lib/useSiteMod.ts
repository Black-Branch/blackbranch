"use client";

// Is the viewer a site mod? The member card mounts on every click, so this
// must not refetch per card: one in-flight promise per page load, shared.

import { useEffect, useState } from "react";

let cached: Promise<boolean> | null = null;

function load(): Promise<boolean> {
  cached ??= fetch("/api/me")
    .then((r) => (r.ok ? r.json() : { isMod: false }))
    .then((d: { isMod?: boolean }) => !!d.isMod)
    .catch(() => false);
  return cached;
}

export function useSiteMod(): boolean {
  const [isMod, setIsMod] = useState(false);
  useEffect(() => {
    let live = true;
    void load().then((v) => { if (live) setIsMod(v); });
    return () => { live = false; };
  }, []);
  return isMod;
}
