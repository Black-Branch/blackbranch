"use client";

// The Undo for a timeout or ban that was applied at once:
// "Ban: done. Undo" for six seconds, then gone. One store (app/lib/modUndo.ts) and one toast for
// every host — live chat and the Chat history both mount this, and only the first mounted one
// draws, so a mod with the panel open beside chat never sees two.

import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { pendingUndos, subscribeUndos, runUndo } from "@/app/lib/modUndo";
import { statusLines, subscribeStatusLines, retryLine, propagationLine } from "@/app/lib/modPropagation";

const EMPTY: readonly never[] = [];
let owner: symbol | null = null;
const ownerSubs = new Set<() => void>();
const ownerChanged = () => { for (const fn of Array.from(ownerSubs)) fn(); };

export default function ModUndoToast() {
  const [me] = useState(() => Symbol("undo-toast"));
  useEffect(() => {
    if (!owner) { owner = me; ownerChanged(); }
    return () => { if (owner === me) { owner = null; ownerChanged(); } };
  }, [me]);
  const mine = useSyncExternalStore((fn) => { ownerSubs.add(fn); return () => { ownerSubs.delete(fn); }; }, () => owner === me, () => false);
  const items = useSyncExternalStore(subscribeUndos, pendingUndos, () => EMPTY);
  // After a ban, timeout or unban: which platforms it reached, one line per action, with Retry.
  const lines = useSyncExternalStore(subscribeStatusLines, statusLines, () => EMPTY);
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => {
    if (!result) return;
    const t = setTimeout(() => setResult(null), 4000);
    return () => clearTimeout(t);
  }, [result]);

  if (!mine || typeof document === "undefined" || (items.length === 0 && lines.length === 0 && !result)) return null;
  return createPortal(
    <div role="status" aria-live="polite" className="fixed bottom-4 left-1/2 z-(--z-modal) -translate-x-1/2 space-y-1.5 pointer-events-none">
      {items.map((u) => (
        <div key={u.id} className="pointer-events-auto flex items-center gap-3 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-sm text-body shadow-lg">
          <span>{u.label}</span>
          <button type="button" className="rounded-md border border-edge px-2 py-0.5 text-xs font-medium text-strong hover:bg-surface-3"
            onClick={() => { void runUndo(u.id).then((r) => setResult(r.ok ? "Undone." : r.error)); }}>
            Undo
          </button>
        </div>
      ))}
      {lines.map((l) => {
        const text = l.outcomes === null ? "checking the platforms…" : propagationLine(l.outcomes) || "no platform to reach";
        const retry = !!l.outcomes?.some((o) => o.state === "failed" && o.retryable);
        return (
          <div key={`p${l.id}`} data-propagation="" className="pointer-events-auto flex items-center gap-3 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-sm text-body shadow-lg">
            <span><span className="text-secondary">{l.label}:</span> {text}</span>
            {retry && (
              <button type="button" className="rounded-md border border-edge px-2 py-0.5 text-xs font-medium text-strong hover:bg-surface-3"
                onClick={() => { void retryLine(l.id); }}>
                Retry
              </button>
            )}
          </div>
        );
      })}
      {result && <div className="pointer-events-auto rounded-lg border border-edge bg-surface-2 px-3 py-2 text-sm text-body shadow-lg">{result}</div>}
    </div>,
    document.body,
  );
}
