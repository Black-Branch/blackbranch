// The Stream tab's charts: hand-rolled SVG, no chart library. Each chart is one card: a title row
// (name left, a number right), the drawing, and a legend where it needs one. Platform colours
// follow the viewer's Platform colours setting (platformColorVar).
import { areaPath, linePath, scale, stepPath, type XY } from "@/app/lib/chartPath";
import { platformColorVar } from "@/app/lib/platformColors";
import { platformLabel } from "@/app/lib/platforms";
import {
  VIEWER_PLATFORMS, composition, earnedCurve, fmtMoney, hourlyRate,
  type ChatPoint, type CurvePoint, type SupportEvent, type VelocityBucket, type ViewerPlatform, type Viewers,
} from "@/app/lib/streamStats";

const W = 320;
const PAD = 4;

export const card = "rounded-lg border border-edge bg-surface-1 px-3 py-2.5";
export const cardTitle = "flex items-baseline justify-between gap-2 text-2xs font-semibold uppercase tracking-wide text-secondary";

/** Stacked areas per platform, bottom → top in VIEWER_PLATFORMS order. */
export function ViewerCurve({ curve, title }: { curve: readonly CurvePoint[]; title: string }) {
  if (curve.length < 2) {
    return (
      <section className={card} data-chart="viewers">
        <div className={cardTitle}><span>{title}</span></div>
        <p className="mt-2 text-xs text-muted">No viewer counts recorded yet.</p>
      </section>
    );
  }
  const H = 90;
  const max = Math.max(1, ...curve.map((c) => c.total));
  const x = scale(curve[0]!.ms, curve[curve.length - 1]!.ms, PAD, W - PAD);
  const y = scale(0, max, H - PAD, PAD);
  // Cumulative bands: each is an area to the baseline; drawing the top of the stack first lets the
  // lower ones paint over it, leaving each platform its own visible slice.
  const bands: { p: ViewerPlatform; pts: XY[] }[] = [];
  const running = curve.map(() => 0);
  for (const p of VIEWER_PLATFORMS) {
    let any = false;
    const pts = curve.map((c, i): XY => {
      running[i]! += c[p];
      if (c[p] > 0) any = true;
      return [x(c.ms), y(running[i]!)];
    });
    if (any) bands.push({ p, pts });
  }
  return (
    <section className={card} data-chart="viewers">
      <div className={cardTitle}><span>{title}</span><span className="tabular-nums">peak {max}</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-2 block h-[90px] w-full" aria-hidden>
        {[...bands].reverse().map((b) => <path key={b.p} d={areaPath(b.pts, H - PAD)} fill={platformColorVar(b.p)} opacity="0.75" />)}
        {bands.length > 0 && <path d={linePath(bands[bands.length - 1]!.pts)} fill="none" stroke="var(--color-strong)" strokeWidth="1" opacity="0.5" vectorEffect="non-scaling-stroke" />}
      </svg>
      <Legend platforms={bands.map((b) => b.p)} />
    </section>
  );
}

function Legend({ platforms }: { platforms: readonly string[] }) {
  if (!platforms.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-3xs text-muted">
      {platforms.map((p) => (
        <span key={p} className="inline-flex items-center gap-1.5">
          <i className="inline-block h-2 w-2 rounded-[2px]" style={{ background: platformColorVar(p) }} />
          {platformLabel(p)}
        </span>
      ))}
    </div>
  );
}

/** The viewers now as one bar, each platform's share in its colour. */
export function CompositionBar({ viewers }: { viewers: Viewers | null }) {
  const parts = composition(viewers);
  if (!parts.length) return null;
  return (
    <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden data-composition>
      {parts.map((c) => <i key={c.platform} className="h-full" style={{ width: `${c.share * 100}%`, background: platformColorVar(c.platform) }} />)}
    </div>
  );
}

/** Chat per minute, the last 30 minutes (live). */
export function VelocityChart({ buckets }: { buckets: readonly VelocityBucket[] }) {
  const H = 60;
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const perMin = buckets.length ? Math.round(buckets.reduce((a, b) => a + b.total, 0) / buckets.length) : 0;
  const bw = W / Math.max(1, buckets.length);
  return (
    <section className={card} data-chart="chat">
      <div className={cardTitle}><span>Chat · last 30 min</span><span className="tabular-nums">{perMin}/min</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-2 block h-[60px] w-full" aria-hidden>
        {buckets.map((b, i) => {
          const h = b.total === 0 ? 1 : Math.max(2, (b.total / max) * (H - 6));
          return <rect key={b.ms} x={i * bw + 1} y={H - h} width={Math.max(1, bw - 2)} height={h} rx="1" fill="var(--color-strong)" opacity={b.total === 0 ? 0.2 : 0.7} />;
        })}
      </svg>
    </section>
  );
}

/** Chat per 5 minutes over a whole stream (a review). */
export function ChatCurve({ points }: { points: readonly ChatPoint[] }) {
  const H = 60;
  const total = points.reduce((a, p) => a + p.count, 0);
  if (points.length < 2) {
    return (
      <section className={card} data-chart="chat">
        <div className={cardTitle}><span>Chat · per 5 min</span><span className="tabular-nums">{total} msgs</span></div>
        <p className="mt-2 text-xs text-muted">Not enough chat to draw.</p>
      </section>
    );
  }
  const max = Math.max(1, ...points.map((p) => p.count));
  const x = scale(points[0]!.ms, points[points.length - 1]!.ms, PAD, W - PAD);
  const y = scale(0, max, H - PAD, PAD);
  const pts = points.map((p): XY => [x(p.ms), y(p.count)]);
  return (
    <section className={card} data-chart="chat">
      <div className={cardTitle}><span>Chat · per 5 min</span><span className="tabular-nums">{total} msgs · peak {max}</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-2 block h-[60px] w-full" aria-hidden>
        <path d={areaPath(pts, H - PAD)} fill="var(--color-strong)" opacity="0.12" />
        <path d={linePath(pts)} fill="none" stroke="var(--color-strong)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
    </section>
  );
}

/** The running total earned over the stream, with the hourly rate (income only). */
export function EarnedChart({ events, startedMs, endMs }: { events: readonly SupportEvent[]; startedMs: number; endMs: number }) {
  const H = 60;
  const curve = earnedCurve(events, startedMs, endMs);
  const total = curve[curve.length - 1]!.cents;
  const x = scale(startedMs, Math.max(startedMs + 1, endMs), PAD, W - PAD);
  const y = scale(0, Math.max(1, total), H - PAD, PAD);
  const pts = curve.map((p): XY => [x(p.ms), y(p.cents)]);
  return (
    <section className={card} data-chart="earned">
      <div className={cardTitle}>
        <span>Earned</span>
        <span className="tabular-nums">{fmtMoney(total)} · {fmtMoney(hourlyRate(total, startedMs, endMs), true)}/h</span>
      </div>
      {total === 0 ? (
        <p className="mt-2 text-xs text-muted">Nothing yet this stream.</p>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-2 block h-[60px] w-full" aria-hidden>
          <path d={stepPath(pts)} fill="none" stroke="var(--color-strong)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
    </section>
  );
}
