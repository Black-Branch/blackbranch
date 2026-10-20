// The device-health reporter. Mounted once per page by app/components/DeviceHealthReporter.tsx.
//
// What it observes from the first frame: Resource Timing (bytes by category), Long Animation
// Frames, heap. What it samples on its own 60 s timer while the page is visible: the player
// (playerHealth.samplePlayer); and once at the first tick, then before each report: a 1 s
// requestAnimationFrame count (with that sample's own cost) and the running CSS animations.
// INP and CLS come from web-vitals, imported at idle so they stay out of the first-load JS.
//
// Cadence: a report every 5 minutes while visible, one at the hidden edge, and one at
// pagehide only if nothing was sent since the hidden edge. Nothing is sent while hidden.
//
// It must never break the page or feed itself into the error reporter: every callback and
// sample is wrapped, and an API a browser lacks (LoAF on Safari, getAnimations, mediaCapabilities)
// is simply absent from the report.
import { categorize, type Category } from "./resourceCategory.ts";
import { addLoaf, emptyLoaf, type LoafEntry } from "./loafSummary.ts";
import { buildReport, routeOf, type ByteCount, type HealthReport } from "./report.ts";
import { playerSnapshot, samplePlayer } from "../playerHealth.ts";
import { emptyVideoAcc, foldVideoSample, videoReport } from "./videoQuality.ts";
import { socketHealth } from "../socketHealth.ts";
import { deviceClass } from "../deviceClass.ts";
import { Q_NARROW } from "../deviceQueries.ts";
import { readValues } from "../settingsRegistry.ts";

/** @test-only the cadence test advances fake time by these instead of restating them */
export const TICK_MS = 60_000;
/** @test-only the cadence test advances fake time by these instead of restating them */
export const REPORT_EVERY_TICKS = 5;
const ENDPOINT = "/api/device-health";

/** The stream's real video: H.264 1080p59.94, ~7 Mbps. */
const DECODE_CONFIGS: Array<{ type: string; video: Record<string, unknown> }> = [
  { type: "webrtc", video: { contentType: "video/H264;profile-level-id=640c2a;packetization-mode=1", width: 1920, height: 1080, bitrate: 7_000_000, framerate: 60 } },
  { type: "media-source", video: { contentType: 'video/mp4; codecs="avc1.640c2a"', width: 1920, height: 1080, bitrate: 7_000_000, framerate: 60 } },
];

const mb = (b: number | undefined) => (typeof b === "number" ? Math.round(b / 1048576 * 10) / 10 : null);
const safe = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };

type Nav = Navigator & {
  connection?: { effectiveType?: string; saveData?: boolean };
  deviceMemory?: number;
};

/** A 1 s count of animation frames, and how long its own callbacks took. Null if the page went
 *  hidden mid-sample (rAF stops) or the browser has no rAF. */
function sampleFrames(windowMs = 1000): Promise<{ fps: number; costMs: number } | null> {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    let n = 0;
    let cost = 0;
    let done = false;
    const start = performance.now();
    const bail = setTimeout(() => { done = true; resolve(null); }, windowMs * 3);
    const step = () => {
      if (done) return;
      const a = performance.now();
      n += 1;
      if (a - start >= windowMs) {
        done = true;
        clearTimeout(bail);
        cost += performance.now() - a;
        resolve({ fps: Math.round((n * 1000) / (a - start)), costMs: Math.round(cost * 100) / 100 });
        return;
      }
      requestAnimationFrame(step);
      cost += performance.now() - a;
    };
    requestAnimationFrame(step);
  });
}

/** Running vs other CSS/Web animations right now. */
function countAnimations(): { running: number; idle: number } | null {
  if (typeof document === "undefined" || typeof document.getAnimations !== "function") return null;
  let running = 0;
  let idle = 0;
  for (const a of document.getAnimations()) {
    if (a.playState === "running") running += 1;
    else idle += 1;
  }
  return { running, idle };
}

/** Start reporting for this page. Returns a stop function. */
export function startDeviceHealth(): () => void {
  if (typeof window === "undefined" || location.pathname.startsWith("/overlay")) return () => {};

  const sid = safe(() => crypto.randomUUID(), "");
  if (!sid) return () => {};
  const origin = location.origin;
  // Started at idle (DeviceHealthReporter), so time is measured from navigation start, not from here.
  const t0 = 0;
  const video = emptyVideoAcc();
  let seq = 0;
  let visMs = 0;
  let visibleSince: number | null = document.visibilityState === "hidden" ? null : t0;
  let sentSinceHidden = false;
  let ticks = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stops: Array<() => void> = [];

  const loaf = emptyLoaf();
  const bytes: Partial<Record<Category, ByteCount>> = {};
  let req = 0;
  let inp: HealthReport["inp"] = null;
  let cls: number | null = null;
  let decode: HealthReport["decode"] = null;
  let frames: HealthReport["frames"] = null;
  let anim: HealthReport["anim"] = null;
  const mem = () => (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize;
  const heap = { startMb: mb(mem()), peakMb: mb(mem()) };
  const notePeak = () => { const m = mb(mem()); if (m !== null && (heap.peakMb === null || m > heap.peakMb)) heap.peakMb = m; };

  // The buffer was raised to 3000 at mount (DeviceHealthReporter) so the entries before this idle
  // start are still there for `buffered: true` (the emote warmer alone is ~1,000 requests).
  const types = safe(() => PerformanceObserver.supportedEntryTypes ?? [], [] as readonly string[]);
  const observe = (type: string, onEntry: (e: PerformanceEntry) => void) => {
    if (!types.includes(type)) return;
    safe(() => {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) safe(() => onEntry(e), undefined);
      });
      po.observe({ type, buffered: true });
      stops.push(() => po.disconnect());
    }, undefined);
  };
  observe("resource", (e) => {
    const r = e as PerformanceResourceTiming;
    if (r.name.includes(ENDPOINT)) return;
    const c = categorize(r.name, r.initiatorType, origin);
    const slot = (bytes[c] ??= { n: 0, b: 0, nb: 0 });
    slot.n += 1;
    req += 1;
    if (r.transferSize > 0) slot.b += r.transferSize;
    else if (!r.encodedBodySize && !r.decodedBodySize) slot.nb += 1; // size hidden (no TAO), F8
  });
  observe("long-animation-frame", (e) => addLoaf(loaf, e as unknown as LoafEntry, origin));

  const settings = (): HealthReport["settings"] => {
    const v = safe(() => readValues(), null);
    return {
      animEmotes: v ? v.animEmotesOn : true,
      lowPower: v ? v.lowPower : false,
      reducedMotion: safe(() => matchMedia("(prefers-reduced-motion: reduce)").matches, false),
      startMuted: v ? v.streamAutoMute : false,
    };
  };

  const send = () => {
    const now = performance.now();
    if (visibleSince !== null) { visMs += now - visibleSince; visibleSince = document.visibilityState === "hidden" ? null : now; }
    notePeak();
    // A session shorter than the first sample still says whether the page was animating (cheap, sync).
    if (anim === null) anim = safe(countAnimations, null);
    const nav = navigator as Nav;
    const report = buildReport({
      sid, seq: ++seq, route: routeOf(location.pathname),
      dc: deviceClass(), narrow: safe(() => matchMedia(Q_NARROW).matches, false),
      dm: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
      hc: typeof nav.hardwareConcurrency === "number" ? nav.hardwareConcurrency : null,
      et: nav.connection?.effectiveType ?? null, sd: typeof nav.connection?.saveData === "boolean" ? nav.connection.saveData : null,
      dpr: window.devicePixelRatio || 1,
      openMs: Math.round(now - t0), visMs: Math.round(visMs),
      loaf, inp, cls, req, bytes, sock: { reconnects: socketHealth.reconnects },
      player: { ...playerSnapshot(now), video: videoReport(video) }, decode, frames, anim, settings: settings(), heap,
    });
    const body = JSON.stringify(report);
    const ok = safe(() => typeof navigator.sendBeacon === "function" &&
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" })), false);
    if (!ok) {
      safe(() => {
        void fetch(ENDPOINT, { method: "POST", body, keepalive: true, headers: { "Content-Type": "application/json" } }).catch(() => {});
      }, undefined);
    }
  };

  const sampleScene = async () => {
    anim = safe(countAnimations, null) ?? anim;
    const f = await sampleFrames().catch(() => null);
    if (f) frames = f;
  };

  const tick = async () => {
    ticks += 1;
    const v = await samplePlayer().catch(() => null);
    if (v) foldVideoSample(video, v);
    if (ticks === 1 || ticks % REPORT_EVERY_TICKS === 0) await sampleScene();
    if (ticks % REPORT_EVERY_TICKS === 0 && document.visibilityState !== "hidden") send();
  };
  const startTimer = () => { if (!timer) timer = setInterval(() => { void tick(); }, TICK_MS); };
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };

  // On a real unload Chrome fires pagehide BEFORE visibilitychange→hidden (two sends for one
  // navigation otherwise), so the de-duplication runs in both directions —
  // whichever edge comes first sends, the other stands down until the page is visible again.
  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      stopTimer();
      if (!sentSinceHidden) send();
      visibleSince = null;
      sentSinceHidden = true;
    } else {
      visibleSince = performance.now();
      sentSinceHidden = false;
      startTimer();
    }
  };
  const onPageHide = () => { if (!sentSinceHidden) { send(); sentSinceHidden = true; } };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  stops.push(() => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
    stopTimer();
  });
  if (document.visibilityState !== "hidden") startTimer();

  // Idle work: INP/CLS (lazy chunk) and the one-off decode capability.
  let cancelled = false;
  const idle = () => {
    if (cancelled) return;
    void import("web-vitals/attribution").then(({ onINP, onCLS }) => {
      if (cancelled) return;
      onINP((m) => {
        const a = m.attribution;
        inp = { ms: Math.round(m.value), type: a.interactionType ?? "", target: a.interactionTarget ?? "",
          inDelay: Math.round(a.inputDelay), proc: Math.round(a.processingDuration), pres: Math.round(a.presentationDelay) };
      }, { reportAllChanges: true });
      onCLS((m) => { cls = Math.round(m.value * 1000) / 1000; }, { reportAllChanges: true });
    }).catch(() => {});
    const mc = (navigator as Navigator & { mediaCapabilities?: MediaCapabilities }).mediaCapabilities;
    if (mc?.decodingInfo) {
      void (async () => {
        for (const cfg of DECODE_CONFIGS) {
          try {
            const r = await mc.decodingInfo(cfg as unknown as MediaDecodingConfiguration);
            decode = { type: cfg.type, supported: r.supported, smooth: r.smooth, powerEfficient: r.powerEfficient };
            return;
          } catch { /* type unsupported here — try the next form */ }
        }
      })();
    }
  };
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(idle, { timeout: 10_000 });
  else setTimeout(idle, 3000);
  stops.push(() => { cancelled = true; });

  return () => { for (const s of stops) safe(s, undefined); };
}
