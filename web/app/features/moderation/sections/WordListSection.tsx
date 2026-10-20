"use client";

// The word and link lists, editable in the panel, alongside the /blacklist and /whitelist
// chat commands. Same route (/api/mod/blocklist, mod-gated, logged), same rule:
// 1 = allowed (the whitelist), 3 = held for a mod (the blacklist); 4 (destroy) stays code-only.
// Also the AI automod switch, which a mod may flip (/api/mod/automod/enabled).

import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "@/app/lib/http";
import { Toggle } from "@/app/components/SettingsControls";
import { card, h2, btn, input, timeAgo, shortName } from "../shared";

type Override = {
  kind: "word" | "host"; term: string; severity: number; action: string;
  shippedAction: string | null; isNewTerm: boolean; setBy: string; setAt: string; note: string | null;
};

export default function WordListSection({ note }: { note: (m: string) => void }) {
  const [rows, setRows] = useState<Override[] | null>(null);
  const [ai, setAi] = useState<boolean | null>(null);
  const [term, setTerm] = useState("");
  const [kind, setKind] = useState<"word" | "host">("word");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getJson<{ overrides: Override[] }>("/api/mod/blocklist").then((d) => setRows(d.overrides)).catch(() => setRows([]));
    getJson<{ aiEnabled?: boolean }>("/api/mod/automod").then((d) => setAi(d.aiEnabled ?? null)).catch(() => setAi(null));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function add(severity: 1 | 3) {
    const t = term.trim();
    if (!t) return;
    setBusy(true);
    try {
      const res = await postJson("/api/mod/blocklist", { term: t, severity, kind });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      note(res.ok ? `${t}: ${severity === 1 ? "allowed (whitelist)" : "held for a mod (blacklist)"}.` : j.error ?? "Not saved.");
      if (res.ok) setTerm("");
      load();
    } finally { setBusy(false); }
  }
  async function clear(o: Override) {
    setBusy(true);
    try {
      const res = await postJson("/api/mod/blocklist", { term: o.term, kind: o.kind }, "DELETE");
      note(res.ok ? `${o.term}: back to the shipped list.` : "Not cleared.");
      load();
    } finally { setBusy(false); }
  }
  async function flipAi() {
    if (ai === null) return;
    setBusy(true);
    try {
      const res = await postJson("/api/mod/automod/enabled", { on: !ai });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      note(res.ok ? `AI automod ${!ai ? "on" : "off"}.` : `AI automod: ${j.error ?? "not changed"}`);
      load();
    } finally { setBusy(false); }
  }

  const listed = (sev: number) => (rows ?? []).filter((r) => (sev === 1 ? r.severity === 1 : r.severity > 1));

  return (
    <section className={card} aria-label="Word lists">
      <h2 className={h2}>AI automod and word lists</h2>
      <div className="mb-3 flex items-center gap-2 text-sm text-body">
        <Toggle on={ai === true} onToggle={() => void flipAi()} disabled={busy || ai === null} label="AI automod" />
        <span>AI automod {ai === null ? "(state unknown)" : ai ? "on" : "off"}</span>
        <span className="text-xs text-muted">— checks each message with the AI; risky site messages wait here, risky platform messages are flagged.</span>
      </div>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void add(3); }}>
        <select value={kind} onChange={(e) => setKind(e.target.value as "word" | "host")} aria-label="Word or link"
          className="rounded-lg bg-surface-1 border border-edge px-2 py-1.5 text-xs text-body">
          <option value="word">word</option>
          <option value="host">link host</option>
        </select>
        <input className={input} value={term} onChange={(e) => setTerm(e.target.value)} placeholder={kind === "word" ? "a word (3+ letters)" : "example.com"} aria-label="Term" />
        <button type="submit" className={btn} disabled={busy || !term.trim()}>Blacklist (hold)</button>
        <button type="button" className={btn} disabled={busy || !term.trim()} onClick={() => void add(1)}>Whitelist (allow)</button>
      </form>
      {/* The lists fold, closed by default. */}
      {rows === null ? <p className="mt-2 text-xs text-muted">Loading…</p> : (
        <details className="mt-3">
        <summary className="cursor-pointer select-none text-xs text-secondary hover:text-strong">
          Blacklist and whitelist — {listed(3).length} held, {listed(1).length} allowed
        </summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {([3, 1] as const).map((sev) => (
            <div key={sev}>
              <div className="mb-1 text-xs font-medium text-secondary">{sev === 1 ? "Whitelist — allowed" : "Blacklist — held for a mod"}</div>
              {listed(sev).length === 0 ? <p className="text-xs text-muted">None.</p> : (
                <ul className="space-y-1">
                  {listed(sev).map((o) => (
                    <li key={`${o.kind}:${o.term}`} className="flex items-center gap-2 text-xs">
                      <span className="font-mono text-body">{o.term}</span>
                      {o.kind === "host" && <span className="text-muted">link</span>}
                      <span className="text-muted truncate">{shortName(o.setBy)} · {timeAgo(o.setAt)}</span>
                      <button type="button" className="ml-auto text-muted hover:text-strong" disabled={busy} onClick={() => void clear(o)} aria-label={`Remove ${o.term}`}>✕</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
        </details>
      )}
    </section>
  );
}
