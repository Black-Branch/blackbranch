// The Admin Panel's Updates section, server side. SERVER ONLY.
//
// The box keeps three files about the update channel in its results folder (install/blackbranch):
// the last read of the signed feed, the last update's result, and an update in progress. The
// verdicts — "the feed went quiet", "the last update was rolled back" — are the doctor's own rows
// (config/doctor.mjs, area Updates), evaluated here on those same files, so the page, the doctor
// page and `blackbranch doctor` say the same thing. The buttons only drop a request: `update-check`,
// or `update-v<version>` — the host applies that version only if the signed feed still names it.

import { DOCTOR } from "../doctor.generated.mjs";
import type { DoctorRow } from "../doctor.generated.mjs";
import { answers, hostFile, hostRequestsAvailable, hostResult, requestHost, RELEASE_VERSION } from "../hostRequests.ts";

type UpdateCheck = {
  at: string; ok: boolean; readAt: string | null; channel: string; current: string;
  available: { version: string; security: boolean; published: string; notes: string } | null;
  refused: string | null; error: string | null;
};
type UpdateLast = {
  at: string; started: string; from: string; to: string;
  result: "updated" | "rolled-back" | "rollback-failed" | "not-applied" | "interrupted"; ok: boolean; message: string; snapshot: string;
  health: { ok: boolean; failed?: string[] } | null; rollbackHealth: { ok: boolean; failed?: string[] } | null;
};
type UpdateState = { state: "running" | "waiting" | "idle"; from: string; to: string; step: number | null; steps: number; words: string; since: string; at: string };
export type UpdatesView = {
  bundle: boolean;
  rows: DoctorRow[];
  check: UpdateCheck | null;
  last: UpdateLast | null;
  state: UpdateState | null;
  at: string;
  /** Whether a stream is live now (null = not asked). Apply is refused while it is. */
  live: boolean | null;
  /** Set when a button's request could not be made or answered. */
  note?: string;
};

const v1 = <T>(x: unknown): T | null => (x && typeof x === "object" && (x as { v?: unknown }).v === 1 ? (x as T) : null);
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

/** Is a stream live now — the fact the rest of the site reads (stream-api's /stream/current, the
 *  database when it does not answer). Not known = not live, the host's own rule for the nightly
 *  security update: nobody is watching a site that cannot say whether it is live. */
export async function updatesLiveNow(): Promise<boolean> {
  try {
    const { streamLiveNow } = await import("../streamTabServer");
    return (await streamLiveNow()).live.live === true;
  } catch {
    return false;
  }
}

export async function updatesView(note?: string, live: boolean | null = null): Promise<UpdatesView> {
  const bundle = hostRequestsAvailable();
  const at = nowIso();
  const [check, last, state] = bundle
    ? await Promise.all([hostFile("update-feed.json"), hostFile("update-last.json"), hostFile("update-state.json")])
    : [null, null, null];
  const updates = { check: v1<UpdateCheck>(check), last: v1<UpdateLast>(last), state: v1<UpdateState>(state) };
  // The doctor's rows, on the same facts the box's own doctor reads (host.updates).
  const rows = DOCTOR.evaluate({ host: bundle ? { at, updates } : null, hostState: bundle ? "ok" : "none", site: {}, siteError: null })
    .filter((r) => r.area === "Updates");
  return { bundle, rows, ...updates, at, live, ...(note ? { note } : {}) };
}

async function waitFor(verb: "update-check" | "update", requestedAt: string, waitMs: number) {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const r = await hostResult(verb);
    if (answers(r, requestedAt)) return r;
    await new Promise((res) => setTimeout(res, 1_000));
  }
  return null;
}

/** "Check now": the host reads the feed (the request `update-check`), then the view again. */
export async function updatesCheckNow(waitMs = 60_000): Promise<UpdatesView> {
  if (!hostRequestsAvailable()) return updatesView();
  const asked = await requestHost("update-check");
  if (!asked.ok) return updatesView(asked.error);
  const r = await waitFor("update-check", asked.requestedAt, waitMs);
  if (!r) return updatesView("the box did not answer in time (is blackbranch-requests.path running?)");
  return updatesView(r.ok ? undefined : `the feed could not be read: ${r.message}`);
}

/** "Apply": only the release this page offers, only while no update runs, and never while the
 *  stream is live — an update takes the site down for a few minutes. The host starts the update as
 *  its own unit and checks the version against the signed feed before anything else. */
export async function updatesApply(version: unknown, waitMs = 20_000, isLive: () => Promise<boolean> = updatesLiveNow): Promise<UpdatesView> {
  if (!hostRequestsAvailable()) return updatesView("this site is not a bundle install");
  if (typeof version !== "string" || !RELEASE_VERSION.test(version)) return updatesView("not a release version");
  const now = await updatesView();
  if (now.state?.state === "running") return updatesView("an update is already running");
  if (now.check?.available?.version !== version) return updatesView("that release is not the one on offer any more — check again");
  if (now.check?.refused) return updatesView(`that release cannot be applied here: ${now.check.refused}`);
  if (await isLive()) return updatesView("the stream is live: an update takes the site down for a few minutes — apply it after the stream ends", true);
  const asked = await requestHost(`update-v${version}`);
  if (!asked.ok) return updatesView(asked.error);
  const r = await waitFor("update", asked.requestedAt, waitMs);
  if (!r) return updatesView("the box did not answer in time (is blackbranch-requests.path running?)");
  return updatesView(r.ok ? undefined : `the update did not start: ${r.message}`);
}
