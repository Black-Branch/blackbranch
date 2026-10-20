// What a platform refusing the sender's lines leaves behind in THIS tab: the one
// note, the platforms skipped for the session, and when a transient failure was
// last shown. (U1 rework, k 2026-10-18: a note per refused message made people
// unlink Kick rather than follow it.)
//
//   • PERSISTENT refusal (followers-only, banned there… — `deliveryFailureKind`):
//     explained ONCE per platform+reason per session, then that platform is
//     skipped — the send hook leaves it out of the request (`skip_platforms`),
//     so no refused call is made again. Re-picking it in Send to, or a new
//     session, tries again.
//   • TRANSIENT failure (not live, can't reach, token): shown at most once per
//     platform per TRANSIENT_WINDOW_MS, never once per message; the line carries
//     the zero-height marker (undeliveredLines.ts).
//   • INFRASTRUCTURE (quota, rate limit, 5xx, timeout — nothing the viewer can
//     act on; ticket #184): silent — no note, no marker, no skip — unless the
//     viewer picked that platform ALONE in Send to; then ONE plain line per
//     platform per session ("Couldn't reach YouTube chat right now."). Never
//     skipped: the next send tries again.
//
// "Session" is this tab's life: a MODULE store, not sessionStorage. A reload is
// a fresh attempt — one refused call, which also notices the person followed in
// the meantime — and nothing about a channel's mode is worth persisting. Pop-out
// and /chat windows are their own documents, so each holds its own (one note per
// window).
//
// `.ts` extensions: exercised under `node --test`.
import { useSyncExternalStore } from "react";
import { deliveryFailureKind, describeDelivery, type DeliveryFailure } from "./sendDelivery.ts";
import { refusalNoteForms, unreachableNoteForms } from "./crossPostCopy.ts";
import { platformLabel } from "./platforms.ts";

/**
 * How long a transient failure on one platform stays quiet after it was shown.
 * @test-only exported so the window tests step past THIS number, not a copy of it.
 */
export const TRANSIENT_WINDOW_MS = 3 * 60_000;

export type RefusalNote = {
  /** Distinguishes one note from the next, so a stale dismiss timer cannot close a newer one. */
  id: number;
  kind: "persistent" | "transient" | "unavailable";
  platform: string;
  /** The full sentence — always the title and what a screen reader hears. */
  text: string;
  /** Every length of it, longest first (`text` is the first); the field shows the longest that fits. */
  forms: string[];
};

const skipped = new Map<string, string>();       // platform → the persistent reason
const explained = new Set<string>();             // `${platform}|${reason}` noted this session
const lastTransient = new Map<string, number>(); // platform → when its transient note was shown
const unreachableShown = new Set<string>();       // platforms whose "couldn't reach" line was shown
let note: RefusalNote | null = null;
let noteSeq = 0;
// useSyncExternalStore needs a stable snapshot between changes.
let skippedSnapshot: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();

function changed(): void {
  skippedSnapshot = new Map(skipped);
  for (const fn of listeners) fn();
}

/**
 * Take a send's `failed` list. Returns the platforms to mark on the line — the
 * transient ones only: a persistent refusal is explained by the note and the
 * Send-to menu, and marking every line until the person follows is the noise
 * this exists to remove.
 *
 * `alone` is the platform the viewer picked as the ONLY destination (Send to =
 * exactly that platform, not a reply, not All), else null; only then may an
 * infrastructure failure on it be mentioned at all.
 */
export function recordFailures(failed: readonly DeliveryFailure[], now = Date.now(), alone: string | null = null): { marked: string[] } {
  const transient: DeliveryFailure[] = [];
  let unreachable: DeliveryFailure | null = null;
  const noteBefore = note;
  let skipsChanged = false;
  for (const f of failed) {
    const kind = deliveryFailureKind(f);
    if (kind === "transient") { transient.push(f); continue; }
    if (kind === "infrastructure") {
      if (f.platform === alone && !unreachableShown.has(f.platform)) unreachable = f;
      continue;
    }
    const reason = f.reason!;
    if (skipped.get(f.platform) !== reason) skipsChanged = true;
    skipped.set(f.platform, reason);
    const key = `${f.platform}|${reason}`;
    if (!explained.has(key)) {
      explained.add(key);
      const forms = refusalNoteForms(f.platform, reason);
      note = { id: ++noteSeq, kind: "persistent", platform: f.platform, text: forms[0] ?? "", forms };
    }
  }
  // One note at a time, and an unread persistent one outranks a transient one —
  // which keeps its window unspent so it can show once the persistent is gone.
  const due = note?.kind === "persistent"
    ? []
    : transient.filter((f) => now - (lastTransient.get(f.platform) ?? -Infinity) >= TRANSIENT_WINDOW_MS);
  const text = describeDelivery({ posted: true, failed: due });
  if (due[0] && text) {
    for (const f of due) lastTransient.set(f.platform, now);
    // The phone form names who missed it; the sentence says why.
    const short = `Missed ${due.map((f) => platformLabel(f.platform)).join(", ")}`;
    note = { id: ++noteSeq, kind: "transient", platform: due[0].platform, text, forms: [text, short] };
  }
  // Same rule for the "couldn't reach" line: never over an unread persistent note,
  // and not spent while it could not be seen.
  if (unreachable && note?.kind !== "persistent") {
    unreachableShown.add(unreachable.platform);
    const forms = unreachableNoteForms(unreachable.platform);
    note = { id: ++noteSeq, kind: "unavailable", platform: unreachable.platform, text: forms[0] ?? "", forms };
  }
  // A silent failure is silent to React too: no re-render for nothing new.
  if (skipsChanged || note !== noteBefore) changed();
  return { marked: transient.map((f) => f.platform) };
}

/** The platforms the next send must leave out (`skip_platforms`). */
export function skippedPlatforms(): string[] {
  return [...skipped.keys()];
}

/**
 * The person picked `dest` in Send to — including the one already selected: try
 * it again. A platform clears its own skip; "all" clears every skip (it names
 * them all); the site (null) holds none.
 */
export function retryDestination(dest: string | null): void {
  if (dest == null) return;
  const cleared = dest === "all" ? [...skipped.keys()] : skipped.has(dest) ? [dest] : [];
  if (cleared.length === 0) return;
  for (const p of cleared) skipped.delete(p);
  if (note && cleared.includes(note.platform)) note = null;
  changed();
}

/** Close the note — or, given an id, only that note (a timer that outlived it must not close the next). */
export function dismissRefusalNote(id?: number): void {
  if (!note || (id != null && note.id !== id)) return;
  note = null;
  changed();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The one note the composer shows, or null. */
export function useRefusalNote(): RefusalNote | null {
  return useSyncExternalStore(subscribe, () => note, () => null);
}

const NO_SKIPS: ReadonlyMap<string, string> = new Map();

/** platform → persistent reason, for the Send-to menu ("Kick: followers-only"). */
export function useSkippedPlatforms(): ReadonlyMap<string, string> {
  return useSyncExternalStore(subscribe, () => skippedSnapshot, () => NO_SKIPS);
}

/** @test-only each test starts from a fresh session. */
export function resetRefusals(): void {
  skipped.clear();
  explained.clear();
  lastTransient.clear();
  unreachableShown.clear();
  note = null;
  changed();
}
