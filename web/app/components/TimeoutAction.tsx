"use client";

import { useState } from "react";
import { TIMEOUT_CHOICES, TIMEOUT_REASON_MAX } from "@/app/lib/community/timeoutChoices";

// The member card's Timeout (spec 2026-10-23 §4.11): one length from the fixed list, a reason, then a
// plain confirm. The site writes the timeout; every community channel follows it.

type Props = {
  userId: string;
  /** Called when the action opens, so the card can disarm its other two-step buttons. */
  onOpen?: () => void;
};

export function TimeoutAction({ userId, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState<number>(10);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const label = TIMEOUT_CHOICES.find((c) => c.minutes === minutes)?.label ?? "";
  const ready = reason.trim().length > 0 && !busy;

  async function send() {
    if (!ready) return;
    setBusy(true);
    try {
      const res = await fetch("/api/mod/timeout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, minutes, reason: reason.trim() }),
      });
      const d = (await res.json().catch(() => ({}))) as { applied?: boolean; until?: string; error?: string };
      if (!res.ok) { setSaid(d.error ?? "The timeout could not be saved. Try again."); return; }
      const until = d.until ? new Date(d.until).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
      setSaid(d.applied ? `Timed out until ${until}.` : `They are already timed out until ${until}.`);
      setOpen(false);
      setReason("");
    } catch {
      setSaid("The timeout could not be saved. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <>
        <button type="button" onClick={() => { onOpen?.(); setSaid(null); setOpen(true); }}
          className="w-full text-sm px-3 py-1.5 rounded-md text-body-dim hover:bg-surface-2 transition-colors">
          Timeout
        </button>
        {said && <p role="status" className="text-2xs text-body-dim">{said}</p>}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-surface-2 p-2">
      <div className="flex flex-wrap gap-1" role="group" aria-label="How long">
        {TIMEOUT_CHOICES.map((c) => (
          <button key={c.minutes} type="button" aria-pressed={c.minutes === minutes} onClick={() => setMinutes(c.minutes)}
            className={`text-2xs px-2 py-0.5 rounded-full transition-colors ${c.minutes === minutes ? "text-on-accent" : "text-body-dim hover:bg-surface-1"}`}
            style={c.minutes === minutes ? { backgroundColor: "var(--accent)" } : undefined}>
            {c.label}
          </button>
        ))}
      </div>
      <input type="text" value={reason} maxLength={TIMEOUT_REASON_MAX} placeholder="Reason (required)" aria-label="Reason"
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
        className="w-full text-sm px-2 py-1 rounded-md bg-surface-1 text-body" />
      <div className="flex gap-1">
        <button type="button" disabled={!ready} onClick={() => void send()}
          className="flex-1 text-sm px-2 py-1 rounded-md text-red-300 hover:bg-red-500/15 transition-colors disabled:opacity-50">
          {busy ? "Saving…" : `Time out for ${label}`}
        </button>
        <button type="button" onClick={() => { setOpen(false); setReason(""); }}
          className="text-sm px-2 py-1 rounded-md text-body-dim hover:bg-surface-1 transition-colors">
          Cancel
        </button>
      </div>
      {said && <p role="status" className="text-2xs text-body-dim">{said}</p>}
    </div>
  );
}
