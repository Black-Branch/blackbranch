import { useState, useEffect } from "react";
import { getJson } from "./http";

// Whether the viewer already has an active Supporter subscription — drives the
// Subscribe⇄Gift button swap (a subscriber gifts instead of re-subscribing).
export function useSubscriptionStatus(isSignedIn: boolean) {
  const [subscribedRaw, setSubscribed] = useState(false);
  useEffect(() => {
    if (!isSignedIn) return;
    getJson<{ tier?: string | null }>("/api/me")
      .then((d) => setSubscribed(d?.tier != null))
      .catch(() => {});
  }, [isSignedIn]);

  return isSignedIn && subscribedRaw;
}
