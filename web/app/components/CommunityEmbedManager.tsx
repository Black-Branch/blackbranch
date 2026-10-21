"use client";

import { useEffect, useState, useCallback } from "react";
import { getJson, postJsonOrThrow } from "@/app/lib/http";
import { Window } from "@/app/components/chrome";
import { LoadingState } from "./Spinner";
import EmptyState from "./EmptyState";

// Mod/admin panel for the community embed rotation, opened from the video top
// bar. Add a featured streamer (YouTube and/or Twitch as video sources),
// reorder priority, remove, and toggle which video sources the viewer's
// switcher offers. Also carries the "force offline" override for a stuck live
// session.

type Embed = {
  id: number;
  priority: number;
  display_name: string | null;
  channel_name: string;
  youtube_channel_id: string | null;
  twitch_login: string | null;
  ingest_enabled: boolean;
  ingest_twitch: boolean;
  ingest_youtube: boolean;
};

/** A row of the community fallback playlist (migrate-v77). */
type LoopVideo = { id: number; video_id: string; title: string | null; priority: number };

const PLATFORM_FLAG = {
  twitch: "ingest_twitch",
  youtube: "ingest_youtube",
} as const;

export default function CommunityEmbedManager({ onClose }: { onClose: () => void }) {
  const [embeds, setEmbeds] = useState<Embed[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Add form
  const [yt, setYt] = useState("");
  const [tw, setTw] = useState("");

  // Fallback playlist — what the community player loops when NOBODY is live.
  const [loop, setLoop] = useState<LoopVideo[]>([]);
  const [loopUrl, setLoopUrl] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, l] = await Promise.all([
        getJson<{ embeds?: Embed[] }>("/api/mod/embed"),
        getJson<{ videos?: LoopVideo[] }>("/api/mod/loop-videos"),
      ]);
      setEmbeds(d.embeds ?? []);
      setLoop(l.videos ?? []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);
  // Microtask defer keeps load()'s sync setLoading out of the effect pass.
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  async function flash(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : "Action failed"); }
    finally { setBusy(false); }
  }

  const add = () => flash(async () => {
    if (!yt.trim() && !tw.trim()) { setErr("Enter at least one handle"); return; }
    // Bounded: the server resolves the YouTube channel by scraping its page, and
    // a stalling page would otherwise pin this dialog's `busy` state indefinitely.
    await postJsonOrThrow("/api/mod/embed", {
      youtube: yt.trim() || undefined, twitch: tw.trim() || undefined,
    }, "POST", { timeoutMs: 8_000 });
    setYt(""); setTw("");
    await load();
  });

  const remove = (e: Embed) => flash(async () => {
    await postJsonOrThrow("/api/mod/embed", { id: e.id }, "DELETE");
    await load();
  });

  const move = (i: number, dir: -1 | 1) => flash(async () => {
    const j = i + dir;
    if (i < 0 || i >= embeds.length || j < 0 || j >= embeds.length) return;
    const order = embeds.map((e) => e.id);
    const oi = order[i], oj = order[j];
    if (oi === undefined || oj === undefined) return;
    order[i] = oj; order[j] = oi;
    // The server answers with the rows as it now has them — that is the order to
    // show. A local swap drifted from it whenever another mod had changed the
    // list in between.
    const d = await postJsonOrThrow<{ reordered?: Embed[] }>("/api/mod/embed", { order }, "PATCH");
    if (d?.reordered) setEmbeds(d.reordered);
  });

  const toggle = (e: Embed, field: keyof Embed) => flash(async () => {
    const next = !e[field];
    await postJsonOrThrow("/api/mod/embed", { id: e.id, [field]: next }, "PATCH");
    setEmbeds((prev) => prev.map((x) => (x.id === e.id ? { ...x, [field]: next } : x)));
  });

  const addLoop = () => flash(async () => {
    if (!loopUrl.trim()) { setErr("Paste a YouTube link"); return; }
    await postJsonOrThrow("/api/mod/loop-videos", { url: loopUrl.trim() });
    setLoopUrl("");
    await load();
  });

  const removeLoop = (v: LoopVideo) => flash(async () => {
    await postJsonOrThrow("/api/mod/loop-videos", { id: v.id }, "DELETE");
    setLoop((prev) => prev.filter((x) => x.id !== v.id));
  });

  const moveLoop = (i: number, dir: -1 | 1) => flash(async () => {
    const j = i + dir;
    if (i < 0 || i >= loop.length || j < 0 || j >= loop.length) return;
    const order = loop.map((v) => v.id);
    const oi = order[i], oj = order[j];
    if (oi === undefined || oj === undefined) return;
    order[i] = oj; order[j] = oi;
    // Same as `move`: the server's rows are the order.
    const d = await postJsonOrThrow<{ videos?: LoopVideo[] }>("/api/mod/loop-videos", { order }, "PATCH");
    if (d?.videos) setLoop(d.videos);
  });

  const forceOffline = () => flash(async () => {
    const d = await postJsonOrThrow<{ ended?: boolean }>("/api/mod/stream/end", {});
    setErr(d?.ended ? "Stream marked offline." : "Nothing was live.");
  });

  return (
    <Window
      presentation="dialog"
      name="Community embeds"
      title="Community embeds"
      onClose={onClose}
      width={512}
      actions={
        <button
          onClick={forceOffline}
          disabled={busy}
          title="Force the live indicator offline (ends a stuck session)"
          className="text-2xs px-2 py-1 rounded bg-surface-1 hover:bg-surface-3 text-body-dim border border-edge disabled:opacity-50"
        >
          Force offline
        </button>
      }
    >
      <div className="flex flex-col">
        {err && <p className="px-4 pt-3 text-xs text-amber-400">{err}</p>}

        {/* Add */}
        <div className="px-4 py-3 border-b border-edge">
          <p className="text-2xs uppercase tracking-wide text-muted mb-2">Add a streamer</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Field label="YouTube" value={yt} onChange={setYt} placeholder="@handle / URL / UC…" />
            <Field label="Twitch" value={tw} onChange={setTw} placeholder="login" />
          </div>
          <button
            onClick={add}
            disabled={busy}
            className="mt-2 w-full text-sm font-medium text-strong bg-[#6d98b3] hover:bg-[#5d86a0] rounded px-3 py-1.5 transition-colors disabled:opacity-50"
          >
            Add / merge
          </button>
        </div>

        {/* List */}
        <div className="px-2 py-2">
          {loading ? (
            <LoadingState className="justify-center py-6" />
          ) : embeds.length === 0 ? (
            <EmptyState className="text-center py-6">No embeds yet.</EmptyState>
          ) : (
            embeds.map((e, i) => (
              <div key={e.id} className="rounded-lg px-2 py-2 hover:bg-surface-1">
                <div className="flex items-center gap-2">
                  {/* Reorder */}
                  <div className="flex flex-col shrink-0">
                    <button onClick={() => move(i, -1)} disabled={busy || i === 0}
                      className="text-muted hover:text-strong disabled:opacity-30 leading-none text-xs">▲</button>
                    <button onClick={() => move(i, 1)} disabled={busy || i === embeds.length - 1}
                      className="text-muted hover:text-strong disabled:opacity-30 leading-none text-xs">▼</button>
                  </div>
                  <span className="text-muted text-xs w-4 shrink-0">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-heading truncate">{e.display_name || e.channel_name}</div>
                    <div className="flex gap-1.5 mt-0.5">
                      {e.youtube_channel_id && <Chip label="YT" on />}
                      {e.twitch_login && <Chip label={`tw/${e.twitch_login}`} on />}
                    </div>
                  </div>
                  <button onClick={() => remove(e)} disabled={busy}
                    title="Remove" className="shrink-0 text-muted hover:text-red-400 px-1">✕</button>
                </div>
                {/* Video-source toggles. Only our own community chat populates
                    the chat feed, so these flags govern the viewer's source
                    switcher and nothing else. */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 pl-8">
                  {(["twitch", "youtube"] as const).map((p) => {
                    const has = p === "twitch" ? e.twitch_login : e.youtube_channel_id;
                    if (!has) return null;
                    const field = PLATFORM_FLAG[p] as keyof Embed;
                    return <Toggle key={p} label={p} on={!!e[field]} onClick={() => toggle(e, field)} busy={busy} />;
                  })}
                </div>
              </div>
            ))
          )}
        </div>
        {/* Fallback playlist */}
        <div className="px-4 py-3 border-t border-edge">
          <p className="text-2xs uppercase tracking-wide text-muted mb-1">Fallback playlist</p>
          <p className="text-3xs text-muted mb-2">
            Loops in the Community player when nobody is live. A live streamer always wins.
          </p>
          <div className="flex gap-2">
            <input
              value={loopUrl}
              onChange={(e) => setLoopUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addLoop(); }}
              placeholder="YouTube link or video id"
              aria-label="YouTube link or video id"
              className="flex-1 min-w-0 text-sm rounded bg-surface-1 border border-edge px-2 py-1 text-heading placeholder:text-muted focus:border-edge-bright outline-none"
            />
            <button
              onClick={addLoop}
              disabled={busy}
              className="shrink-0 text-xs px-2.5 py-1 rounded bg-surface-2 hover:bg-surface-3 text-body border border-edge disabled:opacity-50"
            >
              Add
            </button>
          </div>

          {loop.length === 0 ? (
            <p className="mt-2 text-3xs text-muted">
              Nothing yet — with an empty playlist the Community source is hidden when nobody is live.
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {loop.map((v, i) => (
                <li key={v.id} className="flex items-center gap-2 text-xs">
                  <span className="text-3xs text-muted tabular-nums w-4 shrink-0">{i + 1}</span>
                  <img
                    src={`https://i.ytimg.com/vi/${v.video_id}/default.jpg`}
                    alt=""
                    loading="lazy"
                    className="w-10 h-[30px] object-cover rounded shrink-0 bg-surface-2"
                  />
                  <a
                    href={`https://www.youtube.com/watch?v=${v.video_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 flex-1 truncate text-body-dim hover:text-body"
                    title={v.video_id}
                  >
                    {v.title ?? v.video_id}
                  </a>
                  <button onClick={() => moveLoop(i, -1)} disabled={busy || i === 0}
                    aria-label="Move up"
                    className="px-1 text-muted hover:text-body disabled:opacity-30">↑</button>
                  <button onClick={() => moveLoop(i, 1)} disabled={busy || i === loop.length - 1}
                    aria-label="Move down"
                    className="px-1 text-muted hover:text-body disabled:opacity-30">↓</button>
                  <button onClick={() => removeLoop(v)} disabled={busy}
                    aria-label={`Remove ${v.title ?? v.video_id}`}
                    className="px-1 text-muted hover:text-red-400 disabled:opacity-50">×</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="px-4 pb-3 text-3xs text-muted">
          Per-platform toggles gate which video sources the viewer can switch between.
        </p>
      </div>
    </Window>
  );
}

function Field({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-3xs text-muted">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full mt-0.5 text-sm rounded bg-surface-1 border border-edge px-2 py-1 text-heading placeholder:text-muted focus:border-edge-bright outline-none"
      />
    </label>
  );
}

function Chip({ label, on }: { label: string; on: boolean }) {
  return (
    <span className={`text-3xs px-1.5 py-0.5 rounded ${on ? "bg-surface-2 text-body-dim" : "bg-surface-1 text-muted"}`}>
      {label}
    </span>
  );
}

function Toggle({ label, on, onClick, busy }: {
  label: string; on: boolean; onClick: () => void; busy: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="flex items-center gap-1.5 text-xs disabled:opacity-50"
    >
      <span className={`w-7 h-4 rounded-full relative transition-colors ${on ? "bg-[#6d98b3]" : "bg-surface-3"}`}>
        <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${on ? "left-3.5" : "left-0.5"}`} />
      </span>
      <span className={on ? "text-body" : "text-muted"}>{label}</span>
    </button>
  );
}
