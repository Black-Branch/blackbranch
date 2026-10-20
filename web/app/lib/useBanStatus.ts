"use client";

import { useEffect, useState } from "react";
import { getJson } from "@/app/lib/http";

// Own ban / timeout state for the chat input. `banExpiry` is a small tri-state:
//   undefined → not banned (input shown)
//   null      → permanent ban
//   string    → timed-out until this ISO timestamp (countdown bar)
// `nowTick` advances once a second while a timeout counts down so the remaining
// time re-renders; it stays still otherwise. `setBanExpiry` is exposed so the
// send path can flip the bar when /api/chat/send returns a 403 ban.
export function useBanStatus(isSignedIn: boolean) {
  const [banExpiry, setBanExpiry] = useState<string | null | undefined>(undefined);
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Fetch own ban/timeout status on mount (drives the countdown bar)
  useEffect(() => {
    if (!isSignedIn) return;
    getJson<{ banned?: boolean; expiresAt?: string | null }>("/api/me/ban")
      .then((d) => { if (d.banned) setBanExpiry(d.expiresAt ?? null); })
      .catch(() => {});
  }, [isSignedIn]);

  // Tick once a second while banned; clear the bar when a timeout expires
  useEffect(() => {
    if (banExpiry === undefined) return; // not banned
    const t = setInterval(() => {
      const now = Date.now();
      setNowTick(now);
      if (typeof banExpiry === "string" && new Date(banExpiry).getTime() <= now) {
        setBanExpiry(undefined);
      }
    }, 1000);
    return () => clearInterval(t);
  }, [banExpiry]);

  return { banExpiry, setBanExpiry, nowTick };
}
