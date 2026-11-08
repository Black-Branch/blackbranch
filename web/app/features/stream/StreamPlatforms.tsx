"use client";
// The Stream tab's ONE Platforms card (#247: the site's side and the chat readers merged). Per
// platform one row:
//   • the platform's mark and name, its live detection (Live / Offline / Scheduled for <time> /
//     Can't tell and why — ingestReaders.ts), and its embed switch (the watch page's live sources —
//     one setting, player.embedsOff, written through the Admin Panel's own writer);
//   • its chat reader: reading / starting / failed with the one-line reason / off, and since when;
//   • its current title where a key the site holds can read it, and a link to change it on the
//     platform. Titles are never written here.
// Two reads, each on its own clock: the platforms every 2 min (titles are cached on the server),
// the readers every 30 s (a reader that is starting settles within two minutes) — both only while
// the tab is open and the page visible, and both on Refresh. Phone first: a row folds, it never
// widens the pane.
import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "@/app/lib/http";
import { agoLabel } from "@/app/lib/relativeTime";
import { Toggle } from "@/app/components/SettingsControls";
import PlatformIcon from "@/app/components/PlatformIcon";
import type { PlatformRow } from "@/app/lib/streamStats";
import { readersView, YOUTUBE_LIVE_NOTE, type LiveChip, type ReadersReply, type ReaderState } from "./ingestReaders";
import { mergePlatformRows, type MergedPlatformRow } from "./platformsView";
import { AdminJump, placeFromAdminHref } from "./AdminJump";
import { card, cardTitle } from "./StreamCharts";

const TITLE_POLL_MS = 2 * 60_000;
const READER_POLL_MS = 30_000;
const WORD: Record<ReaderState, { label: string; tone: string }> = {
  running: { label: "Reading", tone: "text-emerald-300" },
  starting: { label: "Starting", tone: "text-amber-300" },
  failed: { label: "Failed", tone: "text-red-400" },
  off: { label: "Off", tone: "text-muted" },
};
const LIVE_TONE: Record<LiveChip["state"], string> = {
  live: "border-emerald-400/40 text-emerald-300",
  offline: "border-edge text-muted",
  upcoming: "border-sky-400/40 text-sky-300",
  unknown: "border-amber-400/40 text-amber-300",
};

/** Load `fn` when the tab opens and every `ms` while it is open and the page visible. */
function useTabPoll(active: boolean, ms: number, fn: () => void) {
  useEffect(() => {
    if (!active) return;
    fn();
    const t = setInterval(() => { if (document.visibilityState === "visible") fn(); }, ms);
    return () => clearInterval(t);
  }, [active, ms, fn]);
}

export function StreamPlatforms({ active }: { active: boolean }) {
  const [rows, setRows] = useState<PlatformRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadSite = useCallback(() => {
    getJson<{ platforms: PlatformRow[] }>("/api/admin/stream/platforms")
      .then((d) => { setRows(d.platforms); setFailed(false); })
      .catch(() => setFailed(true));
  }, []);
  // The readers' answer, with the moment it arrived: "since" labels read that, never the clock in render.
  const [got, setGot] = useState<{ reply: ReadersReply; at: number } | null>(null);
  const [readersFailed, setReadersFailed] = useState(false);
  const loadReaders = useCallback(() => {
    getJson<ReadersReply>("/api/admin/stream/readers")
      .then((reply) => { setGot({ reply, at: Date.now() }); setReadersFailed(false); })
      .catch(() => setReadersFailed(true));
  }, []);
  useTabPoll(active, TITLE_POLL_MS, loadSite);
  useTabPoll(active, READER_POLL_MS, loadReaders);

  const v = readersView(got?.reply ?? null);
  const merged = mergePlatformRows(rows, v.kind === "ok" ? v.rows : []);
  const embeds = (rows ?? []).filter((r) => r.embed);
  const onCount = embeds.filter((r) => r.embed!.on).length;
  async function flip(r: PlatformRow) {
    if (!r.embed) return;
    const off = embeds.filter((x) => (x.key === r.key ? x.embed!.on : !x.embed!.on)).map((x) => x.embed!.source);
    setSaving(r.key);
    setError(null);
    try {
      const res = await postJson("/api/admin/instance/player.embedsOff", { value: off }, "PUT");
      if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not save");
      loadSite();
    } catch {
      setError("Could not save — the site did not answer");
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className={card} data-section="platforms">
      <div className={cardTitle}>
        <span>Platforms</span>
        <button type="button" onClick={() => { loadSite(); loadReaders(); }} className="normal-case tracking-normal font-normal text-2xs text-muted underline hover:text-strong">Refresh</button>
      </div>
      {/* What the chat reader service said as a whole, above the rows it would have filled. */}
      {v.kind === "unreachable" ? (
        <p className="mt-2 text-xs text-red-400" data-readers="unreachable">The chat reader service did not answer — no platform chat is coming in through it. On a bundled install: blackbranch logs stream-ingest.</p>
      ) : v.kind === "unknown" ? (
        <p className="mt-2 text-2xs text-muted" data-readers="unknown">{readersFailed ? "Couldn't ask the chat reader service." : got ? "The chat reader service answered in a shape this page does not know." : "Checking the chat readers…"}</p>
      ) : v.rows.length === 0 ? (
        <p className="mt-2 text-2xs text-muted" data-readers="none">No platform is set up to read chat from. <AdminJump place="platforms">Admin → Platforms</AdminJump></p>
      ) : null}
      {rows === null && <p className="mt-2 text-xs text-muted">{failed ? "Couldn't load the platforms." : "Loading…"}</p>}
      {merged.length > 0 && (
        <ul className="mt-2 divide-y divide-edge" data-readers={v.kind === "ok" && v.rows.length > 0 ? "ok" : undefined}>
          {merged.map((m) => (
            <Row key={m.key} m={m} at={got?.at ?? null}
              switchDisabled={saving !== null || (!!m.site?.embed?.on && onCount <= 1)} onFlip={(r) => void flip(r)} />
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-2xs text-red-400" role="alert">{error}</p>}
      <p className="mt-2 text-2xs text-faint">
        {v.kind === "ok" && v.bot !== null && <span data-bot>Chat bot: {v.bot === "running" ? "running" : "off"} · </span>}
        Embed switches apply to viewers at their next page load. Setting titles and scheduling streams from here is not in this release.
      </p>
    </section>
  );
}

function Row({ m, at, switchDisabled, onFlip }: { m: MergedPlatformRow; at: number | null; switchDisabled: boolean; onFlip: (r: PlatformRow) => void }) {
  const s = m.site;
  const r = m.reader;
  return (
    <li className="py-2 first:pt-0 last:pb-0" data-platform={m.key}>
      <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
        <PlatformIcon platform={m.key} size={14} />
        <span className="text-xs text-body">{m.label}</span>
        {r?.live && (
          <span data-live={r.live.state} data-stale={r.live.stale ? "" : undefined}
            className={`inline-block min-w-0 max-w-full rounded border px-1.5 py-px text-2xs break-words ${LIVE_TONE[r.live.state]}`}>{r.live.head}</span>
        )}
        {s && !s.setUp && (
          <AdminJump place={placeFromAdminHref(s.setupHref)} className="text-2xs text-muted underline hover:text-strong">Not set up — set it up</AdminJump>
        )}
        {s?.embed && (
          <span className="ml-auto flex items-center gap-2 text-2xs text-muted">
            <span>Embed</span>
            <Toggle
              on={s.embed.on}
              label={`${s.label} on the watch page`}
              // The last source on cannot be switched off: a player with no source is a dark site.
              disabled={switchDisabled}
              onToggle={() => onFlip(s)}
            />
          </span>
        )}
      </div>
      <div className="pl-6 text-2xs text-muted">
        {r?.live?.why && <p className="text-amber-300 break-words" data-live-why>Can&apos;t tell: {r.live.why}</p>}
        {r?.state && (
          <p data-reader={m.key} data-state={r.state}>
            Chat reader: <span className={WORD[r.state].tone}>{WORD[r.state].label}</span>
            {r.since && at !== null && r.state !== "off" ? <span> · {agoLabel(r.since, at)}</span> : null}
          </p>
        )}
        {r?.state === "failed" && <p className="text-red-300 break-words" data-reader-error>{r.error ?? "No reason given."}</p>}
        {r?.live?.note && <p className="text-amber-300 break-words" data-live-note>{r.live.note}</p>}
        {s?.setUp && (
          <>
            {s.title ? (
              <p className="text-xs text-body break-words" data-title>{s.title}{s.category ? <span className="text-muted"> · {s.category}</span> : null}</p>
            ) : (
              <p>{s.titleNote}</p>
            )}
            {s.manageUrl && (
              <a href={s.manageUrl} target="_blank" rel="noopener" className="underline hover:text-strong">Change the title on {s.label} ↗</a>
            )}
          </>
        )}
        {m.key === "youtube" && (
          <p className="mt-0.5 text-faint break-words">
            {r?.live && <span data-youtube-note>{YOUTUBE_LIVE_NOTE} </span>}
            {s?.setUp && "Read-only here: setting titles and scheduling on YouTube comes with 1.0."}
          </p>
        )}
      </div>
    </li>
  );
}
