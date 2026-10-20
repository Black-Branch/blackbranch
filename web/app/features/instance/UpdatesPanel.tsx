"use client";

// Admin Panel → Updates: the release in use and its channel, when the signed feed was last read,
// the release on offer with its Apply button, an update while it runs, and how the last one ended —
// a rollback included. The verdicts are the doctor's own Updates rows (the same words
// `blackbranch doctor` prints). On a site that is not a bundle install everything here is grey,
// like the doctor's Box rows.

import { useCallback, useEffect, useRef, useState } from "react";
import { getJson, postJsonOrThrow } from "@/app/lib/http";
import type { UpdatesView } from "@/app/lib/updates/updatesServer";
import { DoctorRowItem } from "./DoctorPanel";
import { card, h2, h3, btn, chip, ago } from "./parts";

const POLL_MS = 3_000;
const RESULT: Record<string, { label: string; cls: string }> = {
  updated: { label: "updated", cls: "text-emerald-400" },
  "rolled-back": { label: "failed — rolled back", cls: "text-amber-300" },
  "rollback-failed": { label: "failed — rollback did not finish", cls: "text-red-300" },
  "not-applied": { label: "not applied", cls: "text-amber-300" },
  interrupted: { label: "stopped without finishing", cls: "text-red-300" },
};
/** What Apply asks before it drops the request. */
function applyConfirmText(version: string): string {
  return `Apply ${version} now? A backup is made first, then the site is down for a few minutes while it updates. If the new release fails its health check, the box goes back to this one and its data.`;
}
const healthWords = (h: { ok: boolean; failed?: string[] } | null) =>
  !h ? "not run" : h.ok ? "passed" : `failed${h.failed?.length ? ` (${h.failed.join(", ")})` : ""}`;

export default function UpdatesPanel() {
  const [view, setView] = useState<UpdatesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"check" | "apply" | null>(null);
  const [away, setAway] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    getJson<UpdatesView>("/api/admin/updates", { cache: "no-store" })
      .then((v) => { setView(v); setError(null); setAway(false); })
      // While an update runs the site itself restarts; keep asking rather than giving up.
      .catch((e: unknown) => { setAway(true); setError(e instanceof Error ? e.message : "could not load"); });
  }, []);
  useEffect(() => { load(); }, [load]);
  const running = view?.state?.state === "running" || away;
  useEffect(() => {
    if (!running) return;
    timer.current = setTimeout(load, POLL_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [running, view, away, load]);

  const act = (action: "check" | "apply", version?: string) => {
    // An update takes the site down: say so and ask first.
    if (action === "apply" && !window.confirm(applyConfirmText(version ?? ""))) return;
    setBusy(action);
    postJsonOrThrow<UpdatesView>("/api/admin/updates", { action, version }, "POST", { timeoutMs: 90_000 })
      .then((v) => { setView(v); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "could not ask the box"))
      .finally(() => setBusy(null));
  };

  if (!view) return error ? <p className="text-sm text-red-300">Could not load the updates: {error}</p> : <p role="status" className="text-sm text-muted">Loading…</p>;

  const { check, last, state } = view;
  const avail = check?.available ?? null;
  return (
    <>
      <section className={card} aria-label="Updates">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className={h2}>Updates</h2>
            <p className="mt-0.5 text-xs text-muted">
              {view.bundle
                ? <>
                    {/* "local" = a box installed from a copy that carries no release name. */}
                    {check?.current && check.current !== "local"
                      ? <>Release <span className="font-mono text-body">{check.current}</span></>
                      : <>A release with no name (installed from a copy, not from the update channel)</>}
                    {" "}on the <span className="text-body">{check?.channel ?? "stable"}</span> channel.{" "}
                    {check?.readAt ? <>The update feed was read {ago(check.readAt)}.</> : <>The update feed has not been read yet.</>}
                  </>
                : <>This site is not a bundle install: it is updated by its own deploy, not by the update channel.</>}
            </p>
          </div>
          {view.bundle && <button type="button" className={btn} disabled={busy !== null || running} onClick={() => act("check")}>{busy === "check" ? "Checking…" : "Check now"}</button>}
        </div>
        <ul className="mt-3 space-y-2.5">
          {view.rows.map((r) => <DoctorRowItem key={r.id} r={r} />)}
        </ul>
        {view.note && <p className="mt-2 text-xs text-amber-300 break-words">{view.note}</p>}
        {error && !away && <p className="mt-2 text-xs text-red-300 break-words">{error}</p>}
      </section>

      {view.bundle && running && (
        <section className={card} aria-label="Update in progress" role="status">
          <h3 className={h3}>Updating{state?.to ? ` to ${state.to}` : ""}</h3>
          {away
            ? <p className="mt-1 text-xs text-body-dim">The site is restarting for the update — this page keeps asking.</p>
            : <p className="mt-1 text-xs text-body-dim break-words">Step {state?.step ?? "?"} of {state?.steps ?? "?"}: {state?.words}</p>}
          <p className="mt-1 text-2xs text-muted">The site is down for a few minutes near the end. If the new release fails its health check, the box goes back to {state?.from || "the release before"} and its data from just before the update.</p>
        </section>
      )}

      {view.bundle && !running && avail && (
        <section className={card} aria-label="Release on offer">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className={h3}>Release {avail.version} {avail.security ? <span className={`${chip} text-amber-300`}>security</span> : <span className={`${chip} text-secondary`}>feature</span>}</h3>
              <p className="mt-1 text-2xs text-muted">Published {ago(avail.published)}.</p>
            </div>
            {!check?.refused && (
              <button type="button" className={btn} disabled={busy !== null || view.live === true} onClick={() => act("apply", avail.version)}>
                {busy === "apply" ? "Starting…" : `Apply ${avail.version}`}
              </button>
            )}
          </div>
          {view.live === true && !check?.refused && (
            <p className="mt-2 text-xs text-amber-300" data-live-hold>The stream is live: an update takes the site down for a few minutes, so Apply waits until the stream ends.</p>
          )}
          {avail.notes && <p className="mt-2 text-xs text-body-dim break-words whitespace-pre-line">{avail.notes}</p>}
          {last && last.to === avail.version && (last.result === "rolled-back" || last.result === "rollback-failed") && (
            <p className="mt-2 text-xs text-amber-300 break-words">This release failed its health check on this box {ago(last.at)}: applying it again will most likely go back again. The nightly check does not retry it.</p>
          )}
          <p className="mt-2 text-2xs text-muted break-words">
            {check?.refused
              ? <>It cannot be applied on this box: {check.refused}</>
              : avail.security
                ? <>A security release applies itself at the quiet hour (Site → Running the site), never while the stream is live. Apply it now to not wait.</>
                : <>A feature release waits for you. A backup is made first; the site is down for a few minutes; if the new release fails its health check the box goes back to this one and its data.</>}
          </p>
        </section>
      )}

      {view.bundle && last && (
        <section className={card} aria-label="Last update">
          <h3 className={h3}>Last update</h3>
          <p className="mt-1 text-xs break-words">
            <span className="font-mono text-body">{last.from} → {last.to}</span>{" "}
            <span className={RESULT[last.result]?.cls ?? "text-muted"}>{RESULT[last.result]?.label ?? last.result}</span>{" "}
            <span className="text-muted">{ago(last.at)}</span>
          </p>
          {last.message && <p className="mt-1 text-xs text-body-dim break-words">{last.message}</p>}
          {(last.health || last.rollbackHealth) && (
            <p className="mt-1 text-2xs text-muted break-words">
              Health check of {last.to}: {healthWords(last.health)}.
              {last.result === "rolled-back" || last.result === "rollback-failed" ? <> After going back to {last.from}: {healthWords(last.rollbackHealth)}.</> : null}
              {last.snapshot ? <> Backup made before it: <span className="font-mono">{last.snapshot.slice(0, 8)}</span>.</> : null}
            </p>
          )}
        </section>
      )}
    </>
  );
}
