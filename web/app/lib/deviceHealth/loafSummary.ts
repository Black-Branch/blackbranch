// Long Animation Frames, summarised for the device-health report.
//
// Every long frame is COUNTED; only the 10 worst (by blockingDuration) are KEPT, each with its
// scripts reduced to something that carries no third-party path or query string.

/** @test-only the summary test asserts the kept count against this, not a restated 10 */
export const WORST_KEPT = 10;
// Five per frame: ten frames × five scripts keeps a worst-case report well inside the 16 KB cap.
const MAX_SCRIPTS = 5;

export type LoafScript = { src: string; fn: string; inv: string; d: number; fsl: number };
export type LoafFrame = { d: number; b: number; t: number; s: LoafScript[] };
export type LoafAcc = { n: number; blockMs: number; worst: LoafFrame[] };

/** The slice of a PerformanceLongAnimationFrameTiming this reads (Chromium only). */
export type LoafEntry = {
  duration: number;
  blockingDuration?: number;
  startTime: number;
  scripts?: ReadonlyArray<{
    sourceURL?: string; sourceFunctionName?: string; invoker?: string;
    duration?: number; forcedStyleAndLayoutDuration?: number;
  }>;
};

export function emptyLoaf(): LoafAcc {
  return { n: 0, blockMs: 0, worst: [] };
}

/**
 * @test-only addLoaf in this file is the production caller; exported so the test pins each reduction
 * Where a script came from, with nothing identifying left in it: our own file as a bare path
 * (no query), a third party as its host only, and any browser extension as `extension`.
 */
export function reduceScriptSrc(url: string, origin: string): string {
  if (!url) return "";
  if (/^(?:chrome|moz|safari(?:-web)?)-extension:/i.test(url)) return "extension";
  let u: URL;
  try {
    u = new URL(url, origin);
  } catch {
    return "other";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "other";
  return u.origin === origin ? u.pathname : u.hostname;
}

const round = (n: number | undefined) => Math.round(Number.isFinite(n) ? (n as number) : 0);

/** Count one long frame, and keep it if it is among the worst. */
export function addLoaf(acc: LoafAcc, e: LoafEntry, origin: string): void {
  const b = round(e.blockingDuration);
  acc.n += 1;
  acc.blockMs += b;
  const worst = acc.worst;
  const floor = worst[worst.length - 1];
  if (worst.length >= WORST_KEPT && floor && b <= floor.b) return;
  const frame: LoafFrame = {
    d: round(e.duration), b, t: round(e.startTime),
    s: (e.scripts ?? []).slice(0, MAX_SCRIPTS).map((s) => ({
      src: reduceScriptSrc(s.sourceURL ?? "", origin),
      fn: (s.sourceFunctionName ?? "").slice(0, 60),
      inv: (s.invoker ?? "").slice(0, 60),
      d: round(s.duration),
      fsl: round(s.forcedStyleAndLayoutDuration),
    })),
  };
  worst.push(frame);
  worst.sort((x, y) => y.b - x.b);
  if (worst.length > WORST_KEPT) worst.length = WORST_KEPT;
}
