"use client";

// Manual identity linkage — fold two chat identities (canonicals) into one
// person, e.g. someone's Twitch account and their Kick account, so stats,
// badges and the bot's read stop fragmenting. The merge is IRREVERSIBLE (the
// losing identity's row is deleted after its history is repointed), so the
// flow is deliberately heavy: pick two, read the preview naming which side
// survives, type the losing identity's name, then confirm an armed button.
// Backed by /api/mod/identity/link (mod-gated; server re-checks the name).

import { useEffect, useState } from "react";
import { getJson, postJson } from "@/app/lib/http";
import { useBotName } from "@/app/lib/useBotName";
import { card, h2, btn, timeAgo } from "./shared";

type Candidate = {
  userId: string; name: string | null; nickname: string | null;
  activity: number; firstSeen: string | null; platforms: string[];
  impression: string | null; interactions: number;
};
type Preview = { targets: Candidate[]; survivorId: string; victimId: string };

const input = "flex-1 min-w-0 rounded-lg border border-edge bg-surface-1 px-3 py-1.5 text-sm text-body placeholder:text-faint outline-none focus:border-edge-strong";

const displayName = (c: Candidate) => c.nickname || c.name || c.userId;

function IdentityPicker({ label, selected, excludeId, onSelect }: {
  label: string;
  selected: Candidate | null;
  excludeId: string | null;
  onSelect: (c: Candidate | null) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Candidate[] | null>(null);

  // Debounced search. State resets happen in the change handler (not the
  // effect) per the set-state-in-effect lint; the effect only schedules the
  // fetch, whose .then lands async.
  useEffect(() => {
    const t = q.trim();
    if (!t) return;
    const timer = setTimeout(() => {
      getJson<{ candidates: Candidate[] }>(`/api/mod/identity/link?q=${encodeURIComponent(t)}`)
        .then((d) => setResults(d.candidates))
        .catch(() => setResults([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [q]);

  if (selected) {
    return (
      <div className="flex-1 min-w-0">
        <div className="text-xs text-muted mb-1">{label}</div>
        <div className="flex items-center gap-2 rounded-lg bg-surface-1 px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm text-body font-medium">{displayName(selected)}</span>
          <span className="text-xs text-muted">{selected.platforms.join(", ") || "no platforms"}</span>
          <button className="text-muted hover:text-body text-sm" title="Clear" onClick={() => onSelect(null)}>✕</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-w-0">
      <div className="text-xs text-muted mb-1">{label}</div>
      <input
        className={`${input} w-full`}
        placeholder="Search by name…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          if (!e.target.value.trim()) setResults(null);
        }}
      />
      {results && (
        <ul className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-edge bg-panel/95">
          {results.filter((c) => c.userId !== excludeId).length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted">No matches.</li>
          ) : results.filter((c) => c.userId !== excludeId).map((c) => (
            <li key={c.userId}>
              <button
                className="w-full text-left px-3 py-1.5 hover:bg-surface-2 flex items-center gap-2"
                onClick={() => { onSelect(c); setQ(""); setResults(null); }}
              >
                <span className="min-w-0 flex-1 truncate text-sm text-body">{displayName(c)}</span>
                <span className="text-xs text-muted shrink-0">
                  {c.platforms.join(", ") || "—"} · {c.activity} msgs
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function IdentitySection({ note }: { note: (m: string) => void }) {
  const [a, setA] = useState<Candidate | null>(null);
  const [b, setB] = useState<Candidate | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  // The bot's configured name (bot.name); unset = "the bot".
  const botName = useBotName("");

  // Load the merge preview once both sides are picked (async .then only —
  // resets happen in the pick handlers below).
  useEffect(() => {
    if (!a || !b || a.userId === b.userId) return;
    getJson<Preview>(`/api/mod/identity/link?preview=${a.userId},${b.userId}`)
      .then(setPreview)
      .catch(() => setPreview(null));
  }, [a, b]);

  const pick = (side: "a" | "b") => (c: Candidate | null) => {
    (side === "a" ? setA : setB)(c);
    setPreview(null);
    setConfirmName("");
    setArmed(false);
  };

  const survivor = preview?.targets.find((t) => t.userId === preview.survivorId) ?? null;
  const victim = preview?.targets.find((t) => t.userId === preview.victimId) ?? null;
  const nameMatches = !!victim
    && [victim.name, victim.nickname].some(
      (n) => !!n && n.toLowerCase() === confirmName.trim().toLowerCase());

  async function link() {
    if (!a || !b || !victim) return;
    if (!armed) { setArmed(true); return; }
    setBusy(true);
    try {
      const res = await postJson("/api/mod/identity/link", {
        canonicalIds: [a.userId, b.userId],
        confirmName: confirmName.trim(),
      });
      if (res.ok) {
        note(`Linked — ${victim ? displayName(victim) : "the smaller identity"} folded into ${survivor ? displayName(survivor) : "the survivor"}. ${botName || "The bot"} now holds one read on them.`);
        setA(null); setB(null); setPreview(null); setConfirmName("");
      } else {
        const t = await res.text().catch(() => "");
        note(t || "Link failed.");
      }
    } catch {
      note("Link failed (network).");
    } finally {
      setArmed(false);
      setBusy(false);
    }
  }

  return (
    <section className={card}>
      <h2 className={h2} data-repeats-place="">Identity links</h2>
      <p className="text-xs text-muted mb-3">
        Fold two chat identities into one person (same human on two platforms/accounts).
        History, stats and {botName || "the bot"}&apos;s read all merge. <span className="text-amber-400">This cannot be undone.</span>
      </p>
      <div className="flex flex-col sm:flex-row gap-2">
        <IdentityPicker label="Identity A" selected={a} excludeId={b?.userId ?? null} onSelect={pick("a")} />
        <IdentityPicker label="Identity B" selected={b} excludeId={a?.userId ?? null} onSelect={pick("b")} />
      </div>

      {a && b && a.userId !== b.userId && preview && survivor && victim && (
        <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.05] p-3 space-y-2">
          <div className="text-sm text-body">
            <span className="font-medium">{displayName(survivor)}</span> survives —{" "}
            <span className="font-medium">{displayName(victim)}</span>&apos;s chat history, stats and
            {botName || "the bot"}&apos;s read fold into it, then the identity is deleted.
          </div>
          <ul className="text-xs text-secondary space-y-1">
            {preview.targets.map((t) => (
              <li key={t.userId} className="break-words">
                <span className="text-body-dim font-medium">{displayName(t)}</span>
                {" · "}{t.platforms.join(", ") || "no platforms"} · {t.activity} msgs
                {t.firstSeen ? ` · first seen ${timeAgo(t.firstSeen)}` : ""}
                {t.impression ? <span className="text-muted"> · read: “{t.impression.slice(0, 120)}{t.impression.length > 120 ? "…" : ""}”</span> : ""}
              </li>
            ))}
          </ul>
          <div className="flex gap-2 items-center">
            <input
              className={input}
              placeholder={`Type "${displayName(victim)}" to confirm`}
              value={confirmName}
              onChange={(e) => { setConfirmName(e.target.value); setArmed(false); }}
            />
            <button
              className={`${btn} ${armed ? "!border-red-500/50 !bg-red-500/15 !text-red-300" : ""}`}
              disabled={busy || !nameMatches}
              onClick={() => void link()}
            >
              {armed ? "Confirm merge?" : "Link identities"}
            </button>
          </div>
        </div>
      )}
      {a && b && a.userId === b.userId && (
        <p className="mt-2 text-xs text-amber-400">Those are the same identity.</p>
      )}
    </section>
  );
}
