"use client";

// "Report" on a chat line (its ⋯ menu) and on a user card: a reason, sent to the mods' Reports.
// Works for anyone in chat — a site account or a chatter who only spoke from a platform — because
// the report names the MESSAGE and the server finds its author (app/lib/reportTarget.ts).
//
// It mounts itself (openReportDialog) so a menu that closes on click, or a card in any host, can
// open it without every host carrying a slot for it.

import { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { postJson } from "@/app/lib/http";

export type ReportTarget = { platform: string; messageId: string | number; name: string };

/** What the report route's answer means for the person who sent it.
 *  @test-only the dialog in this file reads it; exported so the test pins each refusal's words. */
export function reportOutcome(status: number, error?: string): string {
  if (status >= 200 && status < 300) return "Reported — the mods will see it.";
  if (status === 401) return "Sign in to report.";
  if (status === 429) return "Easy — a few reports a minute is plenty.";
  if (error === "blocked") return "That reason tripped the word filter — reword it.";
  if (error === "self") return "That's your own message.";
  if (error === "message_not_found") return "That message is gone.";
  return "Couldn't send the report — try again.";
}

function ReportDialog({ target, onDone }: { target: ReportTarget; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDone(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  async function send() {
    if (!reason.trim()) return;
    setBusy(true);
    const res = await postJson("/api/support/report", { platform: target.platform, messageId: Number(target.messageId), reason: reason.trim() }).catch(() => null);
    const d = (await res?.json().catch(() => null)) as { error?: string } | null;
    setBusy(false);
    setResult(reportOutcome(res?.status ?? 0, d?.error));
    if (res?.ok) setTimeout(onDone, 1500);
  }

  return (
    <div className="fixed inset-0 z-(--z-modal) flex items-center justify-center bg-scrim p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(); }}>
      <div aria-label={`Report ${target.name}`} className="glass w-full max-w-sm rounded-xl p-4 space-y-3">
        <p className="text-sm font-semibold text-strong">Report {target.name}</p>
        <p className="text-xs text-secondary">The mods see this message and your reason. {target.name} is not told who reported them.</p>
        <textarea
          ref={box}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={3}
          aria-label="Reason"
          placeholder="What's wrong with it?"
          className="w-full rounded-lg bg-surface-1 border border-edge px-3 py-2 text-sm text-body placeholder:text-muted outline-none focus:border-edge-strong"
        />
        {result && <p role="status" className="text-xs text-body">{result}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onDone} className="rounded-md px-3 py-1.5 text-sm text-body-dim hover:bg-surface-2">Cancel</button>
          <button type="button" disabled={busy || !reason.trim()} onClick={() => void send()}
            className="rounded-md bg-red-900/50 px-3 py-1.5 text-sm text-red-100 hover:bg-red-900/70 disabled:opacity-50">
            Send report
          </button>
        </div>
      </div>
    </div>
  );
}

let mounted: { root: Root; host: HTMLElement } | null = null;

/** Open the report dialog for a message (one at a time). */
export function openReportDialog(target: ReportTarget): void {
  if (typeof document === "undefined") return;
  if (mounted) { mounted.root.unmount(); mounted.host.remove(); }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const me = { root, host };
  mounted = me;
  const done = () => {
    if (mounted !== me) return;
    mounted = null;
    root.unmount();
    host.remove();
  };
  root.render(<ReportDialog target={target} onDone={done} />);
}
