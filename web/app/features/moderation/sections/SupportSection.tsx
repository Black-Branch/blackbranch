"use client";

// The Admin Panel's Support tickets: what the help desk escalated, and forwarding them to the
// Black Branch project (a switch, Send per ticket, Send all skipping what was sent). Reports about
// people are the Mod Panel's (ReportsSection), where every mod can see them.

import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "@/app/lib/http";
import { LoadingState } from "@/app/components/Spinner";
import { Toggle } from "@/app/components/SettingsControls";
import { useBotName } from "@/app/lib/useBotName";
import { card, h2, btn, timeAgo } from "../shared";

type Ticket = {
  id: number; kind: "bug" | "other"; body: string;
  transcript: { role: "bot" | "user"; text: string }[] | null;
  created_at: string; who: string;
};
type Forwarding = { available: boolean; on: boolean; sent: number[] };

export default function SupportSection({ note }: { note: (m: string) => void }) {
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [busy, setBusy] = useState(false);
  // The help desk speaks as the install's bot.name; unset = "Help".
  const deskName = useBotName("");

  const [fwd, setFwd] = useState<Forwarding | null>(null);

  const load = useCallback(() => {
    getJson<{ tickets: Ticket[] }>("/api/mod/support")
      .then((d) => setTickets(d.tickets))
      .catch(() => {});
    getJson<Forwarding>("/api/admin/support/forward")
      .then(setFwd)
      .catch(() => setFwd(null));
  }, []);

  async function forward(body: { ids: number[] } | { all: true }) {
    setBusy(true);
    try {
      const res = await postJson("/api/admin/support/forward", body);
      const j = (await res.json().catch(() => ({}))) as { error?: string; sent?: number[]; skipped?: number[] };
      note(res.ok ? `Sent ${j.sent?.length ?? 0} ticket(s) to Black Branch${j.skipped?.length ? `; ${j.skipped.length} already sent` : ""}.` : j.error ?? "Not sent.");
      load();
    } catch {
      note("Not sent (network).");
    } finally {
      setBusy(false);
    }
  }
  const canSend = !!fwd?.available;
  const unsent = (tickets ?? []).filter((t) => !fwd?.sent.includes(t.id));
  useEffect(load, [load]);

  async function resolve(kind: "ticket", id: number) {
    setBusy(true);
    try {
      const res = await postJson("/api/mod/support", { kind, id });
      if (!res.ok) note("Couldn't resolve — try again.");
      load();
    } catch {
      note("Couldn't resolve — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className={card} aria-label="Forward to Black Branch" data-forwarding={canSend ? "available" : "later"}>
        <h2 className={h2}>Forward to Black Branch</h2>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-body">
          <Toggle on={!!fwd?.on} onToggle={() => {}} disabled={!canSend || busy} label="Forward tickets to Black Branch" />
          <span>Forward tickets to Black Branch</span>
          <button type="button" className={`${btn} ml-auto`} disabled={!canSend || busy || unsent.length === 0} onClick={() => void forward({ all: true })} data-send-all>
            Send all
          </button>
        </div>
        <p className="mt-1 text-xs text-muted">
          {canSend
            ? "Sends a ticket to the project that makes this software, without the person's account or any secret. Send all skips tickets already sent."
            : "Forwarding tickets to Black Branch arrives in a later release."}
        </p>
      </section>
      <section className={card}>
        <h2 className={h2}>Support tickets</h2>
        {tickets === null ? (
          <LoadingState label="Loading tickets…" />
        ) : tickets.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing open. Help requests and bug reports people send from the site land here
            {deskName ? ` — ${deskName}'s got the front desk` : ""}. Reports about people are in the Mod Panel → Reports.
          </p>
        ) : (
          <ul className="space-y-3">
            {tickets.map((t) => (
              <li key={t.id} className="rounded-lg border border-edge p-3">
                <div className="flex items-center gap-2 text-xs text-muted">
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 uppercase">{t.kind}</span>
                  <span>{t.who}</span>
                  <span>· {timeAgo(t.created_at)}</span>
                  <button
                    type="button" disabled={!canSend || busy || !!fwd?.sent.includes(t.id)}
                    onClick={() => void forward({ ids: [t.id] })}
                    className={`${btn} ml-auto`} data-send={t.id}
                  >
                    {fwd?.sent.includes(t.id) ? "Sent" : "Send"}
                  </button>
                  <button
                    type="button" disabled={busy}
                    onClick={() => resolve("ticket", t.id)}
                    className={btn}
                  >
                    Resolve
                  </button>
                </div>
                <p className="mt-1.5 text-sm text-body">{t.body}</p>
                {t.transcript && t.transcript.length > 0 && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-xs text-muted">
                      Conversation ({t.transcript.length})
                    </summary>
                    <div className="mt-1 space-y-0.5 border-l-2 border-edge pl-2">
                      {t.transcript.map((m, i) => (
                        <p key={i} className="text-xs text-body-dim">
                          <span className="font-semibold">{m.role === "user" ? t.who : deskName || "Help"}:</span> {m.text}
                        </p>
                      ))}
                    </div>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

    </>
  );
}
