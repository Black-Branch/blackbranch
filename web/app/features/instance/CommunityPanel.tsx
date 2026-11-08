"use client";

// Admin Panel › Site › Community: the community's channels and categories, its roles, and what the
// server last applied (spec 2026-10-23 §4.1, §4.7). One control surface: every save writes the
// database first, then asks the server to make the community match; the page says "Applying…"
// until the server's next run is in the log. Federation and sign-up, and the rooms the server's
// setup made, sit here too.
//
// Every route behind this checks is_admin itself; this component being admin-only is not the guard.

import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "@/app/lib/http";
import type { InstanceView } from "@/app/lib/instanceAdminView";
import type { CommunityView } from "@/app/lib/community/communityAdmin";
import { keyGroupsFor } from "./adminLayout";
import KeyCards from "./KeyCards";
import ChannelsPage, { type Save } from "./ChannelsPage";
import RolesPage from "./RolesPage";
import RunsCard from "./RunsCard";
import BannerCard from "./BannerCard";

/** How often the page looks for the run a save asked for, and for how long. */
const POLL_MS = 3_000;
const WAIT_MS = 180_000;

const OFF_WORDS = "Saved. Changes are applied by the reconciler when it is turned on.";
const LATER_WORDS = "Saved. Changes are applied on the next scheduled run.";

export default function CommunityPanel({ inst, reloadInst, note }: {
  /** The settings view, for the key cards; null while it loads (the channels do not wait for it). */
  inst: InstanceView | null; reloadInst: () => void; note: (m: string) => void;
}) {
  const [view, setView] = useState<CommunityView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** The run a save or a button is waiting on: when the host was asked, and when the wait began. */
  const [waiting, setWaiting] = useState<{ at: string; mode: "report" | "apply"; since: number } | null>(null);
  const [expired, setExpired] = useState(false);

  const load = useCallback(() => {
    getJson<CommunityView>("/api/admin/community", { cache: "no-store" })
      .then((v) => { setView(v); setErr(null); })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "could not load"));
  }, []);
  useEffect(() => { load(); }, [load]);

  // Waiting: look again until a run started at or after the request is in the log, the host says
  // it could not start one, or the wait runs out. All three are read from the view, not stored.
  const asked = waiting ? Date.parse(waiting.at) : NaN;
  // A check is answered under its own verb (community-report), an apply under community-reconcile.
  const answer = waiting?.mode === "report" ? view?.hostReport : view?.host;
  const hostRefused = !!waiting && !!answer && !answer.ok && Date.parse(answer.at) >= asked;
  const answered = !!waiting && !!view && ((!!view.latestStartedAt && Date.parse(view.latestStartedAt) >= asked) || hostRefused);
  const pending = !!waiting && !answered && !expired;
  useEffect(() => {
    if (!pending || !waiting) return;
    const t = setTimeout(() => { if (Date.now() - waiting.since > WAIT_MS) setExpired(true); else load(); }, POLL_MS);
    return () => clearTimeout(t);
  }, [pending, waiting, view, load]);
  const checking = waiting?.mode === "report";
  const notice = hostRefused && answer ? `${checking ? "Not checked" : "Not applied"}: ${answer.message}`
    : waiting && expired && !answered
      ? (checking ? "The server has not finished checking yet." : "The server has not applied the change yet. It will on its next run.")
      : null;

  const wait = useCallback((at: string, mode: "report" | "apply") => { setExpired(false); setWaiting({ at, mode, since: Date.now() }); }, []);

  const afterAsk = useCallback((requestedAt: string | null, savedWords: string) => {
    if (requestedAt) { wait(requestedAt, "apply"); note(savedWords); }
    else note(view?.reconciler === false ? OFF_WORDS : LATER_WORDS);
  }, [note, view?.reconciler, wait]);

  const save: Save = useCallback(async (url, method, body) => {
    try {
      const res = await postJson(url, body, method);
      const j = (await res.json().catch(() => ({}))) as { error?: string; requestedAt?: string | null };
      if (!res.ok) { note(j.error ?? "Not saved."); return false; }
      afterAsk(j.requestedAt ?? null, "Saved.");
      load();
      return true;
    } catch {
      note("Not saved: the site did not answer.");
      return false;
    }
  }, [afterAsk, load, note]);

  const run = useCallback(async (mode: "report" | "apply") => {
    try {
      const res = await postJson("/api/admin/community/reconcile", { mode });
      const j = (await res.json().catch(() => ({}))) as { error?: string; requestedAt?: string };
      if (!res.ok || !j.requestedAt) { note(j.error ?? "The server could not be asked."); return; }
      wait(j.requestedAt, mode);
      note(mode === "report" ? "Checking…" : "Applying…");
    } catch {
      note("The site did not answer.");
    }
  }, [note, wait]);

  const cards = inst ? keyGroupsFor("site", "community", inst.ownerPlugin !== false) : [];
  return (
    <>
      {err && <p className="text-sm text-red-300">Could not load the community: {err}</p>}
      {!view && !err && <p role="status" className="text-sm text-muted">Loading the community…</p>}
      {view && !view.reconciler && (
        <p className="rounded-lg border border-edge bg-surface-1 px-3 py-2 text-xs text-body-dim">
          Changes here are saved, and applied by the reconciler when it is turned on.
        </p>
      )}
      {view && (
        <>
          <BannerCard bannerMxc={view.spaces.find((s) => s.kind === "hub")?.bannerMxc ?? null} note={note}
            saved={(at, words) => { afterAsk(at, words); load(); }} />
          <ChannelsPage spaces={view.spaces} rooms={view.rooms} cap={view.retentionCapDays} save={save} note={note} />
          <RunsCard lastApply={view.lastApply} lastReport={view.lastReport} reconciler={view.reconciler} canAsk={view.canAsk}
            waiting={pending && waiting ? waiting.mode : null} notice={notice} onRun={(m) => void run(m)} />
          <RolesPage roles={view.roles} save={save} />
        </>
      )}
      {inst && <KeyCards view={inst} groups={cards} onChanged={reloadInst} note={note} placeLabel="Community" />}
    </>
  );
}
