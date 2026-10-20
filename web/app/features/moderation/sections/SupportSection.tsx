"use client";

// The Admin Panel's Support tickets: what the help desk escalated. Reports about people are the
// Mod Panel's (ReportsSection), where every mod can see them.

import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "@/app/lib/http";
import { LoadingState } from "@/app/components/Spinner";
import { useBotName } from "@/app/lib/useBotName";
import { card, h2, btn, timeAgo } from "../shared";

type Ticket = {
  id: number; kind: "bug" | "other"; body: string;
  transcript: { role: "bot" | "user"; text: string }[] | null;
  created_at: string; who: string;
};

export default function SupportSection({ note }: { note: (m: string) => void }) {
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [busy, setBusy] = useState(false);
  // The help desk speaks as the install's bot.name; unset = "Help".
  const deskName = useBotName("");

  const load = useCallback(() => {
    getJson<{ tickets: Ticket[] }>("/api/mod/support")
      .then((d) => setTickets(d.tickets))
      .catch(() => {});
  }, []);
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
                    type="button" disabled={busy}
                    onClick={() => resolve("ticket", t.id)}
                    className={`${btn} ml-auto`}
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
