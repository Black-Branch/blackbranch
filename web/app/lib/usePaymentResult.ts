"use client";
// Polls GET /api/billing/result every 3s while a checkout box is mounted.
// Polling, not WS — a push reaches every viewer; a 3s poll reaches the one
// person who needs it. sessionId is supplied by the caller (the checkout
// routes now return { clientSecret, sessionId } — see checkoutSessionId.test.ts)
// rather than parsed out of clientSecret.
import { useEffect, useState } from "react";
import { getJson } from "./http.ts";

type ResultResponse =
  | { outcome: "none" }
  | { outcome: "failed"; title: string; body: string; canRetry: boolean; at: string };

// @test-only usePaymentResult.test.ts exercises the parse logic directly; the
// hook below is its only production caller, in this same file.
export function parseResult(json: unknown): { title: string; body: string } | null {
  const r = json as Partial<ResultResponse> | null | undefined;
  if (!r || r.outcome !== "failed") return null;
  const { title, body } = r as Extract<ResultResponse, { outcome: "failed" }>;
  return { title, body };
}

export function usePaymentResult(sessionId: string | null, active: boolean): { title: string; body: string } | null {
  const [result, setResult] = useState<{ title: string; body: string } | null>(null);
  // Keyed on the session id alone — every checkout is a fresh session, so
  // nothing older can match.

  useEffect(() => {
    if (!active || !sessionId) {
      // Deferred to a microtask, same as usePresence's first tick — a
      // synchronous setState in an effect body is react-hooks/set-state-in-effect
      // (a hard error here).
      Promise.resolve().then(() => setResult(null));
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const json = await getJson<ResultResponse>(
          `/api/billing/result?session=${encodeURIComponent(sessionId)}`
        );
        const parsed = parseResult(json);
        if (!cancelled && parsed) setResult(parsed);
      } catch { /* transient — next 3s tick retries */ }
    };
    void poll();
    const timer = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [sessionId, active]);

  return result;
}
