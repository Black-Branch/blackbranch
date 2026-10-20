// The device-health report: its shape (shared with the route that ingests it) and the one builder
// that guarantees it fits the route's body cap.
import type { Category } from "./resourceCategory.ts";
import type { LoafAcc } from "./loafSummary.ts";
import type { PlayerReport } from "../playerHealth.ts";
import type { VideoReport } from "./videoQuality.ts";

/** The route refuses anything larger, and sendBeacon's own queue limit is 64 KB shared. */
export const MAX_REPORT_BYTES = 16_384;

export type ByteCount = { n: number; b: number; nb: number };

export type HealthReport = {
  v: 1; sid: string; seq: number;
  route: string;
  dc: "mobile" | "desktop"; narrow: boolean;
  dm: number | null; hc: number | null; et: string | null; sd: boolean | null; dpr: number;
  openMs: number; visMs: number;
  loaf: LoafAcc;
  inp: { ms: number; type: string; target: string; inDelay: number; proc: number; pres: number } | null;
  cls: number | null;
  req: number;
  bytes: Partial<Record<Category, ByteCount>>;
  sock: { reconnects: number };
  player: PlayerReport & { video: VideoReport | null };
  decode: { type: string; supported: boolean; smooth: boolean; powerEfficient: boolean } | null;
  frames: { fps: number; costMs: number } | null;
  anim: { running: number; idle: number } | null;
  settings: { animEmotes: boolean; lowPower: boolean; reducedMotion: boolean; startMuted: boolean };
  heap: { startMb: number | null; peakMb: number | null };
};

/** "/", "/popout", "/donate", "/mod" … — the first path segment only, never ids or queries. */
export function routeOf(pathname: string): string {
  const seg = pathname.split("/")[1] ?? "";
  return /^[a-z0-9_-]{1,40}$/i.test(seg) ? `/${seg}` : "/";
}

/** The report as sent. If it would not fit the cap, the kept long frames are dropped worst-last
 *  until it does — the counts (`n`, `blockMs`) always survive, only the detail is shed. */
export function buildReport(s: Omit<HealthReport, "v">): HealthReport {
  const r: HealthReport = { v: 1, ...s, loaf: { ...s.loaf, worst: [...s.loaf.worst] } };
  while (r.loaf.worst.length > 0 && JSON.stringify(r).length > MAX_REPORT_BYTES) r.loaf.worst.pop();
  return r;
}
