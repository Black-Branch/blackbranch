"use client";

// Admin Panel → Utility → OBS: the rig page. The one browser source OBS
// needs — its address with this site's key (copy, regenerate), a light for whether a rig page is
// connected now and since when, test buttons that send a made-up clip down the real path, and the
// scenes the page reported, each a button that switches OBS through it.
//
// ONE component, two mounts: Admin Panel → Utility → OBS (the whole page) and the Stream tab's OBS
// card (`frame`: the stream view's card look, the status light, scene buttons and the tests — the
// address and its key stay on the admin page, out of a screen that is on stream). Both send the same
// actions to the same route, so a scene switch drives OBS the same way from either.

import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "@/app/lib/http";
import type { RigView } from "@/app/lib/rig/rigAdmin";
import { card, h2, h3, btn, chip, ago } from "./parts";

const POLL_MS = 5_000;
// obsstudio.getControlLevel() → the words OBS's "Page permissions" list uses.
const LEVEL_WORDS = ["No access to OBS", "Read access to OBS status", "Read access to user information", "Basic access to OBS", "Advanced access to OBS", "Full access to OBS"];
const ADVANCED = 4;
const SINK_WORDS: Record<NonNullable<RigView["sink"]>, string> = {
  satellite: "the audio satellite on the streaming computer",
  rig: "the rig page in OBS",
  local: "this server's own audio output, if it has one — no rig page is connected",
};
const SCENE_REFUSED: Record<string, string> = {
  not_connected: "no rig page is connected",
  no_permission: "the rig page's permission is below \"Advanced access to OBS\"",
  unknown_scene: "OBS did not report that scene",
  off: "the OBS module is off",
};

function Light({ on, label, small = false }: { on: boolean; label: string; small?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${small ? "text-2xs" : "text-sm"} text-body`} data-rig-light={on ? "on" : "off"}>
      <span aria-hidden className={`inline-block size-2.5 rounded-full ${on ? "bg-emerald-400" : "bg-surface-3 ring-1 ring-edge"}`} />
      {label}
    </span>
  );
}

/** The Stream tab's card classes, handed in so this feature does not reach into that one. */
type Frame = { card: string; title: string };

export default function RigPanel({ note: noteProp, frame, active = true }: {
  /** The Admin Panel's status line; without one (the Stream tab) the card shows its own. */
  note?: (m: string) => void;
  /** Set = the Stream tab's compact card. */
  frame?: Frame;
  /** The Stream tab polls only while it is the open tab and the page is visible. */
  active?: boolean;
}) {
  const [said, setSaid] = useState<string | null>(null);
  const note = noteProp ?? setSaid;
  const [view, setView] = useState<RigView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);

  const load = useCallback(() => {
    getJson<RigView>("/api/admin/rig", { cache: "no-store" })
      .then((v) => { setView(v); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "could not load"));
  }, []);
  useEffect(() => {
    if (!active) return;
    load();
    // The admin page polls as it always has; the stream card skips a hidden page.
    const t = setInterval(() => { if (!frame || document.visibilityState === "visible") load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [load, active, frame]);

  const act = async (what: string, body: Record<string, unknown>, done: (b: Record<string, unknown>) => string) => {
    setBusy(what);
    try {
      const res = await postJson("/api/admin/rig", body);
      const b = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      if (res.ok) note(done(b));
      else note(typeof b.code === "string" ? `Not switched: ${SCENE_REFUSED[b.code] ?? b.code}.` : `Failed: ${typeof b.error === "string" ? b.error : res.status}`);
    } catch { note("Failed: the site did not answer"); }
    setBusy(null);
    load();
  };

  const copy = () => {
    if (!view?.url) return;
    const p = navigator.clipboard?.writeText(view.url);
    if (!p) { setCopied("failed"); return; }
    p.then(() => setCopied("copied"), () => setCopied("failed")).finally(() => setTimeout(() => setCopied(null), 1800));
  };

  if (frame) return <StreamCard frame={frame} view={view} error={error} busy={busy} said={noteProp ? null : said} act={act} />;
  if (error) return <section className={card}><p className="text-sm text-red-300">Could not read the rig page&apos;s state: {error}</p></section>;
  if (!view) return <section className={card}><p role="status" className="text-sm text-muted">Loading the rig page…</p></section>;
  if (!view.on) {
    return (
      <section className={`${card} space-y-1`} data-rig-panel="off">
        <h2 className={h2}>The rig page</h2>
        <p className="text-xs text-secondary">{view.error ? `Not available: ${view.error}.` : "The OBS module is off. Switch it on at the top of this page; it applies when the chat service restarts."}</p>
      </section>
    );
  }

  const level = maxLevel(view);
  const masked = view.url ? view.url.replace(/key=[^&]+/, "key=••••••••") : "";

  return (
    <section className={`${card} space-y-4`} data-rig-panel="on">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className={h2}>The rig page</h2>
          <Light on={view.connected > 0} label={connectedLabel(view)} />
        </div>
        <p className="text-xs text-secondary">One browser source in OBS carries the bot&apos;s voice, the sound alerts, its avatar and scene switching. It connects out from OBS, so it works from any network; nothing is installed on your computer.</p>
      </div>

      <div className="space-y-1">
        <h3 className={h3}>Browser source address</h3>
        <div className="flex flex-wrap gap-2">
          <code className="min-w-0 flex-1 basis-64 rounded-md border border-edge bg-surface-2 px-2 py-0.5 text-xs text-strong break-all" data-rig-url>{shown ? view.url : masked}</code>
          <button type="button" className={btn} onClick={() => setShown((s) => !s)} aria-pressed={shown}>{shown ? "Hide" : "Show"}</button>
          <button type="button" className={`${btn} w-20`} onClick={copy} aria-live="polite" disabled={!view.url}>{copied === "copied" ? "Copied" : copied === "failed" ? "Not copied" : "Copy"}</button>
          <button type="button" className={btn} disabled={busy !== null}
            onClick={() => { if (window.confirm("Make a new key? The current address stops working at once, and OBS needs the new one.")) void act("key", { action: "regenerate" }, () => "New key made — paste the new address into OBS."); }}>
            Regenerate
          </button>
        </div>
        <p className="text-2xs text-muted">The key in it lets a page play sound into your stream — keep it out of screenshots and chat. In OBS: Browser source, 1920 × 1080, tick &quot;Control audio via OBS&quot;, Page permissions &quot;Advanced access to OBS&quot;.</p>
      </div>

      {view.connected > 0 && (
        <div className="space-y-1">
          <h3 className={h3}>In OBS</h3>
          <p className="text-xs text-secondary">
            Page permission: <span className="text-body">{level == null ? "not reported (not a browser source in OBS?)" : LEVEL_WORDS[level] ?? level}</span>
            {level != null && level < ADVANCED && <span className="text-amber-300"> — scene switching needs &quot;Advanced access to OBS&quot; (the source&apos;s Properties → Page permissions).</span>}
          </p>
          {view.scene && <p className="text-xs text-secondary">On air: <span className="text-body">{view.scene}</span></p>}
        </div>
      )}

      {view.scenes.length > 0 && (
        <div className="space-y-1">
          <h3 className={h3}>Switch scene</h3>
          <Scenes view={view} level={level} busy={busy} act={act} />
        </div>
      )}

      <div className="space-y-1">
        <h3 className={h3}>Test</h3>
        <Tests view={view} busy={busy} act={act} />
      </div>
    </section>
  );
}

type Act = (what: string, body: Record<string, unknown>, done: (b: Record<string, unknown>) => string) => Promise<void>;

const maxLevel = (view: RigView) => view.pages.reduce<number | null>((m, p) => (p.level == null ? m : Math.max(m ?? 0, p.level)), null);
const connectedLabel = (view: RigView) => {
  const first = view.pages[0] ?? null;
  return view.connected > 0
    ? `Connected${view.connected > 1 ? ` (${view.connected} pages)` : ""} since ${first ? new Date(first.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "?"} · ${ago(first?.since)}`
    : "Not connected";
};

/** The scene buttons — the same on both mounts. */
function Scenes({ view, level, busy, act }: { view: RigView; level: number | null; busy: string | null; act: Act }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="OBS scenes">
      {view.scenes.map((s) => (
        <button key={s} type="button" className={`${btn} ${s === view.scene ? "border-edge-bright text-strong" : ""}`} aria-pressed={s === view.scene}
          disabled={busy !== null || (level ?? 0) < ADVANCED} onClick={() => void act(`scene:${s}`, { action: "scene", name: s }, () => `Asked OBS to show ${s}.`)}>
          {s}
        </button>
      ))}
    </div>
  );
}

/** Test voice and Test sound — the same on both mounts. */
function Tests({ view, busy, act }: { view: RigView; busy: string | null; act: Act }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={btn} disabled={busy !== null} onClick={() => void act("voice", { action: "test", what: "voice" }, () => "Test voice sent — the avatar moves while it plays.")}>Test voice</button>
      <button type="button" className={btn} disabled={busy !== null} onClick={() => void act("sound", { action: "test", what: "sound" }, () => "Test sound sent.")}>Test sound</button>
      {view.sink && <span className={`${chip} text-secondary`}>Plays through {SINK_WORDS[view.sink]}</span>}
    </div>
  );
}

/** The Stream tab's card: the light, the scenes, the tests, and what the last tap did. */
function StreamCard({ frame, view, error, busy, said, act }: { frame: Frame; view: RigView | null; error: string | null; busy: string | null; said: string | null; act: Act }) {
  const level = view ? maxLevel(view) : null;
  return (
    <section className={frame.card} data-section="obs" data-rig-panel={view ? (view.on ? "on" : "off") : undefined}>
      <div className={frame.title}>
        <span>OBS</span>
        {view?.on && <span className="normal-case tracking-normal font-normal"><Light on={view.connected > 0} label={connectedLabel(view)} small /></span>}
      </div>
      {error ? (
        <p className="mt-2 text-xs text-red-300">Could not read the rig page&apos;s state: {error}</p>
      ) : !view ? (
        <p role="status" className="mt-2 text-xs text-muted">Loading…</p>
      ) : !view.on ? (
        <p className="mt-2 text-xs text-muted">{view.error ? `Not available: ${view.error}.` : "The OBS module is off — switch it on in Settings › OBS below; it applies when the chat service restarts."}</p>
      ) : (
        <div className="mt-2 space-y-2">
          {view.connected === 0 && <p className="text-2xs text-muted">No rig page is connected — add its browser source in OBS (Settings › OBS below has the address).</p>}
          {view.connected > 0 && level != null && level < ADVANCED && (
            <p className="text-2xs text-amber-300">Scene switching needs &quot;Advanced access to OBS&quot; (the source&apos;s Properties → Page permissions).</p>
          )}
          {view.scenes.length > 0 && <Scenes view={view} level={level} busy={busy} act={act} />}
          <Tests view={view} busy={busy} act={act} />
        </div>
      )}
      {said && <p role="status" className="mt-1.5 text-2xs text-body-dim break-words">{said}</p>}
    </section>
  );
}
