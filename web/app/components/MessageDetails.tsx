"use client";

// One message, fully inspectable: its number, exact time,
// where it came from and where it was sent, who sent it (user id, Matrix id), what it replied to,
// whether it was deleted, and the scores this install computes. Mods only — the route that serves
// it is mod-gated. Shown in the mod panel's Chat history and in the user card's mod section.
//
// Scores show only when the install's plugin declares them (app/lib/plugins/installed.ts
// messageScores): the public build has no scoring module, so it shows none.

import { useEffect, useState } from "react";
import PlatformIcon from "./PlatformIcon";
import { platformLabel } from "@/app/lib/platforms";
import { messageScores } from "@/app/lib/plugins/installed";
import { fetchHistMessage, type HistMsg } from "@/app/lib/modHistory";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-2xs">
      <span className="w-20 shrink-0 text-secondary">{label}</span>
      <span className="min-w-0 break-all text-body-dim">{children}</span>
    </div>
  );
}

/** The details of a message already loaded (a history row). */
function MessageFacts({ m }: { m: HistMsg }) {
  const scores = messageScores();
  return (
    <div className="space-y-0.5" aria-label="Message details">
      <Fact label="Message">#{m.id}</Fact>
      <Fact label="Time">{new Date(m.ts).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" })}</Fact>
      <Fact label="From"><span className="inline-flex items-center gap-1"><PlatformIcon platform={m.platform} size={11} /> {platformLabel(m.platform)}</span></Fact>
      <Fact label="Sent to">
        {m.destPlatforms.length
          ? <span className="inline-flex flex-wrap items-center gap-1.5">{m.destPlatforms.map((p) => <span key={p} className="inline-flex items-center gap-1"><PlatformIcon platform={p} size={11} /> {platformLabel(p)}</span>)}</span>
          : "this site only"}
      </Fact>
      <Fact label="User id"><span className="font-mono">{m.canonicalId ?? "—"}</span></Fact>
      <Fact label="Matrix id"><span className="font-mono">{m.matrixId ?? "— (a platform account)"}</span></Fact>
      {m.replyTo && <Fact label="Replying to">{m.replyTo.username}: “{m.replyTo.text.slice(0, 120)}”</Fact>}
      <Fact label="Deleted">{m.deleted ? "yes" : "no"}</Fact>
      {scores.map((s) => (
        <Fact key={s.key} label={s.label}>{m.scores[s.key] == null ? "not scored" : m.scores[s.key]!.toFixed(2)}</Fact>
      ))}
    </div>
  );
}

/** The details of a message by id — the user card loads them for the line it was opened from. */
export default function MessageDetails({ platform, id }: { platform: string; id: string | number }) {
  const [m, setM] = useState<HistMsg | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void fetchHistMessage(platform, id).then((r) => { if (live) setM(r); });
    return () => { live = false; };
  }, [platform, id]);
  if (m === undefined) return <p className="text-2xs text-muted">Loading message details…</p>;
  if (m === null) return <p className="text-2xs text-muted">No stored record of this message.</p>;
  return <MessageFacts m={m} />;
}
