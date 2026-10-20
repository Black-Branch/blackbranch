"use client";
// GETs /api/me once for isAdmin (me/route.ts:90). Shape of useCoinBalance/
// useEmotes. null while loading, so a gate can hide a tab rather than flash it.
import { useEffect, useState } from "react";
import { getJson } from "./http.ts";

export function useIsAdmin(): boolean | null {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    getJson<{ isAdmin?: boolean }>("/api/me", { cache: "no-store" })
      .then((d) => { if (!cancelled) setIsAdmin(Boolean(d.isAdmin)); })
      .catch(() => { if (!cancelled) setIsAdmin(false); });
    return () => { cancelled = true; };
  }, []);
  return isAdmin;
}
