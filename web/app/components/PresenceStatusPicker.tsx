"use client";

import { useEffect, useRef, useState } from "react";
import { getJson } from "@/app/lib/http";
import { PresenceDot } from "./PresenceDot";
import { isSelfStatus, type SelfStatus } from "@/app/lib/presenceState";

// The self-set status: Online / Idle / Do Not Disturb / Invisible +
// a custom line, on the account card's profile page. Saves on choose and on
// blur; announces the change so an open community client follows it.

const OPTIONS: { value: SelfStatus; label: string; dot: "site" | "away" | "dnd" | "offline" }[] = [
  { value: "online", label: "Online", dot: "site" },
  { value: "idle", label: "Idle", dot: "away" },
  { value: "dnd", label: "Do Not Disturb", dot: "dnd" },
  { value: "invisible", label: "Invisible", dot: "offline" },
];

export default function PresenceStatusPicker() {
  const [status, setStatus] = useState<SelfStatus>("online");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The last value the server actually confirmed — what a failed save reverts
  // to, so the picker never shows a choice that silently didn't take.
  const [saved, setSaved] = useState<{ status: SelfStatus; text: string }>({ status: "online", text: "" });
  // A second save() while one is still in flight is IGNORED, not queued — a
  // plain ref because state is batched/async and this must be checked
  // synchronously at call time. The buttons below do NOT disable while a
  // save runs (a disabled option would eat a fast click before it could
  // land — see the mousedown comment), so this is what stops two overlapping
  // PUTs racing to decide `saved` instead. The option onClick checks this
  // BEFORE calling setStatus, so the whole click is ignored — no state change
  // at all — while a save is running; otherwise the click's own setStatus
  // would show the new option picked even though save() went on to no-op.
  // Whichever save is already in flight wins; click again once it settles.
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getJson<{ presenceStatus?: unknown; presenceStatusText?: string }>("/api/me", { cache: "no-store" })
      .then((d) => {
        if (cancelled) return;
        const loaded: { status: SelfStatus; text: string } = {
          status: isSelfStatus(d.presenceStatus) ? d.presenceStatus : "online",
          text: d.presenceStatusText ?? "",
        };
        setStatus(loaded.status);
        setText(loaded.text);
        setSaved(loaded);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const save = async (next: SelfStatus, nextText: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch("/api/presence/status", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: next, text: nextText }),
      });
      if (res.ok) {
        setSaved({ status: next, text: nextText });
        setError(null);
        window.dispatchEvent(new CustomEvent("bb:presence-status", { detail: { status: next } }));
      } else {
        // No retry actually happens — revert to the last confirmed value and
        // say so, rather than leaving an unpersisted choice showing as picked.
        setStatus(saved.status);
        setText(saved.text);
        setError("Couldn't save your status. Try again.");
      }
    } catch {
      setStatus(saved.status);
      setText(saved.text);
      setError("Couldn't save your status. Try again.");
    } finally { inFlight.current = false; }
  };

  return (
    <div className="px-2 pt-3">
      <p className="px-3 pb-1 text-3xs uppercase tracking-wider text-muted">Status</p>
      <div className="flex flex-wrap gap-1 px-3">
        {OPTIONS.map((o) => (
          <button key={o.value} type="button" data-status-option={o.value}
            // The text input's onBlur fires BEFORE this button's onClick — a
            // disabled-while-saving button would already be disabled by
            // the time the click landed, swallowing the tap on the status
            // the user actually meant to choose. preventDefault on mousedown
            // stops the input from ever blurring into the click at all.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { if (inFlight.current) return; setStatus(o.value); void save(o.value, text); }}
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors ${status === o.value ? "bg-surface-2 text-strong" : "text-secondary hover:bg-surface-1"}`}>
            <PresenceDot state={o.dot} size={8} />
            {o.label}
          </button>
        ))}
      </div>
      <input value={text} maxLength={80} placeholder="Set a custom status"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (text !== saved.text) void save(status, text); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }}
        className="mt-2 mx-3 w-[calc(100%-1.5rem)] rounded-lg border border-control bg-canvas px-3 py-1.5 text-xs text-heading outline-none focus:border-accent" />
      {error && <p role="alert" className="mt-1 mx-3 text-xs text-red-400">{error}</p>}
    </div>
  );
}
