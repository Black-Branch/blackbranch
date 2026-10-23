"use client";

// Admin Panel → Platforms → Emotes: where the site's emotes come from (the global 7TV, BTTV and FFZ
// sets, and each platform channel's own), which channel id each channel set is looked up by, how
// many each set gave at the last check, and Refresh. The emote list rebuilds itself every half
// hour; Refresh is for an emote added mid-stream.
//
// What this release does not have, said on the page rather than offered as a dead control:
// switching one set off, and approving an emote before it shows. Neither has a setting behind it.

import { useState } from "react";
import { postJson } from "@/app/lib/http";
import type { InstanceView } from "@/app/lib/instanceAdminView";
import { card, h2, h3, btn, chip } from "./parts";

type Slice = { id: string; fresh: number; prev: number; kept: "fresh" | "last-good" };

/** Every set the site reads, with the channel id it needs (null = a global set, needs none). */
const SETS: readonly { id: string; label: string; needs: string | null; place: string | null }[] = [
  { id: "7tv:global", label: "7TV global", needs: null, place: null },
  { id: "bttv:global", label: "BTTV global", needs: null, place: null },
  { id: "ffz:global", label: "FFZ global", needs: null, place: null },
  { id: "twitch:channel", label: "Twitch channel emotes", needs: "platform.twitch.broadcasterId", place: "platforms/twitch" },
  { id: "7tv:channel", label: "7TV, your Twitch channel", needs: "platform.twitch.broadcasterId", place: "platforms/twitch" },
  { id: "bttv:channel", label: "BTTV, your Twitch channel", needs: "platform.twitch.broadcasterId", place: "platforms/twitch" },
  { id: "ffz:channel", label: "FFZ, your Twitch channel", needs: "platform.twitch.channel", place: "platforms/twitch" },
  { id: "7tv:kick", label: "7TV, your Kick channel", needs: "platform.kick.userId", place: "platforms/kick" },
];

function held(view: InstanceView, key: string): string {
  const k = view.keys.find((x) => x.key === key);
  const v = (k?.packages.find((p) => p.package === "web") ?? k?.packages[0])?.display;
  return typeof v === "string" ? v : "";
}

export default function EmotesPanel({ inst, note, go }: {
  inst: InstanceView; note: (m: string) => void;
  /** Opens another Admin Panel place (where a channel is set). */
  go: (id: string) => void;
}) {
  const [slices, setSlices] = useState<Slice[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function ask(action: "check" | "refresh") {
    setBusy(true);
    try {
      const res = await postJson("/api/mod/emotes", { action });
      const j = (await res.json().catch(() => ({}))) as { error?: string; slices?: Slice[]; count?: number; wouldLoad?: number };
      if (!res.ok) { note(`Emotes: ${j.error ?? "not answered"}`); return; }
      setSlices(j.slices ?? []);
      note(action === "refresh" ? `Emotes refreshed: ${j.count ?? 0} in chat now.` : `Emotes checked: a refresh would load ${j.wouldLoad ?? 0}.`);
    } catch { note("Emotes: not answered (network)"); }
    finally { setBusy(false); }
  }

  return (
    <>
      <section className={card} aria-label="Emote sets">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className={h2}>Emote sets</h2>
            <p className="mt-0.5 text-xs text-muted">Chat shows the global sets and your channels&apos; own. A channel&apos;s sets are found by its id, which the site finds when the channel is saved. The list rebuilds itself every half hour.</p>
          </div>
          <span className="flex gap-2">
            <button type="button" className={btn} disabled={busy} onClick={() => void ask("check")} data-emotes-check>Check</button>
            <button type="button" className={btn} disabled={busy} onClick={() => void ask("refresh")} data-emotes-refresh>Refresh now</button>
          </span>
        </div>
        <ul className="mt-3 space-y-2">
          {SETS.map((s) => {
            const id = s.needs ? held(inst, s.needs) : "";
            const missing = !!s.needs && !id;
            const got = slices?.find((x) => x.id === s.id);
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs" data-set={s.id} data-missing={missing ? "" : undefined}>
                <span className="text-sm text-body">{s.label}</span>
                {got && <span className={`${chip} text-secondary`}>{got.fresh} emote{got.fresh === 1 ? "" : "s"}{got.kept === "last-good" ? `, keeping the last ${got.prev}` : ""}</span>}
                {missing && s.place && (
                  <span className="text-muted">
                    Not looked up: no channel set on{" "}
                    <button type="button" className="text-body-dim underline hover:text-strong" onClick={() => go(s.place!)}>{s.place === "platforms/kick" ? "Kick" : "Twitch"}</button>.
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {!slices && <p className="mt-2 text-2xs text-muted">Press Check to see how many emotes each set gives now.</p>}
      </section>
      <section className={card} aria-label="Approvals">
        <h3 className={h3}>Switching a set off, approving emotes</h3>
        <p className="mt-0.5 text-xs text-muted">Not in this release: every set above shows in chat. Switching one set off and approving an emote before it shows arrive in a later release.</p>
      </section>
    </>
  );
}
