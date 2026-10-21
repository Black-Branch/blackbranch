// Server side of the device-health beacon: turns an untrusted body into the row the route stores.
// Pure — no pool, no auth — so it is tested directly.
//
// THE CLIENT IS NOT TRUSTED TO HAVE REDUCED ANYTHING. The reporter strips queries, ids and
// third-party paths on the device, and this re-checks every string against the shape it should
// have, replacing a miss with "other". An open endpoint that stored whatever arrived would be a
// place for anyone to park arbitrary text in our database.
import { CATEGORIES } from "./resourceCategory.ts";
import { MAX_REPORT_BYTES } from "./report.ts";
import { createSlidingWindowLimiter } from "../rateLimit.ts";
import { normalizePlatform } from "../nativePlatform.ts";

// @parked plugin API: a site plugin's console beside the chat reads or drives the chat through it
export const MAX_SEQ = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAYER_SRCS = new Set(["none", "native", "streamplace", "youtube", "twitch", "replay", "community", "radio"]);
const EFFECTIVE_TYPES = new Set(["slow-2g", "2g", "3g", "4g"]);
const CATEGORY_SET = new Set<string>(CATEGORIES);
const DAY_MS = 86_400_000;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A finite number clamped into [0, max], or `fallback`. */
function n(v: unknown, max: number, fallback: number): number;
function n(v: unknown, max: number, fallback: null): number | null;
function n(v: unknown, max: number, fallback: number | null): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(0, v));
}
const int = (v: unknown, max: number) => Math.round(n(v, max, 0));
const intOrNull = (v: unknown, max: number) => { const x = n(v, max, null); return x === null ? null : Math.round(x); };
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** @test-only normalizeReport in this file is the production caller; exported so each shape is pinned
 *  A script source as the client should have reduced it: "", "extension", "other", our own path
 *  (no query, no fragment), or a bare host. Anything else is "other". */
export function cleanScriptSrc(v: unknown): string {
  if (typeof v !== "string") return "other";
  if (v === "" || v === "extension" || v === "other") return v;
  if (/^\/[\w./~-]{0,200}$/.test(v)) return v;
  if (/^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(v)) return v.toLowerCase();
  return "other";
}

/** A short code label (function name, invoker): no URL survives, no element id. */
function cleanLabel(v: unknown, max = 60): string {
  if (typeof v !== "string") return "";
  if (v.includes("://")) return "other";
  return v.replace(/#[^\s.>:[\]]+/g, "").slice(0, max);
}

/** @test-only normalizeReport in this file is the production caller; exported so each strip is pinned
 *  An INP target selector with every `#id` and `[attr…]` stripped, cut to 100 characters. */
export function cleanSelector(v: unknown): string {
  if (typeof v !== "string") return "";
  if (v.includes("://")) return "other";
  return v.replace(/\[[^\]]*\]/g, "").replace(/#[^\s.>+~:[\]]+/g, "").slice(0, 100);
}

export type NormalizedRow = {
  sessionId: string; seq: number; route: string; deviceClass: "mobile" | "desktop"; narrow: boolean | null;
  deviceMemory: number | null; hwConcurrency: number | null; effectiveType: string | null; saveData: boolean | null;
  dpr: number | null; openMs: number; visibleMs: number;
  loafCount: number; loafBlockingMs: number; loafWorst: unknown[];
  inpMs: number | null; inp: Record<string, unknown> | null; cls: number | null;
  reqCount: number; bytes: Record<string, { n: number; b: number; nb: number }>; socketReconnects: number;
  player: Record<string, unknown> | null; decode: Record<string, unknown> | null;
  frames: Record<string, unknown> | null; anim: Record<string, unknown> | null;
  settings: Record<string, boolean> | null; heapStartMb: number | null; heapPeakMb: number | null;
};

function video(v: unknown): Record<string, unknown> | null {
  if (!isObj(v)) return null;
  return {
    w: int(v.w, 16_384), h: int(v.h, 16_384), fps: n(v.fps, 1000, null),
    decoded: int(v.decoded, 1e12), dropped: int(v.dropped, 1e12), decodeMs: n(v.decodeMs, 10_000, null),
    freezes: int(v.freezes, 1e9), freezeMs: int(v.freezeMs, 1e12), bytes: int(v.bytes, 1e15),
    mode: v.mode === "hls" ? "hls" : "webrtc",
  };
}

/** The row to store, or null when the body is not a report at all. */
export function normalizeReport(body: unknown): NormalizedRow | null {
  if (!isObj(body) || body.v !== 1) return null;
  if (typeof body.sid !== "string" || !UUID.test(body.sid)) return null;
  const seq = body.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1 || seq > MAX_SEQ) return null;

  const loaf = isObj(body.loaf) ? body.loaf : {};
  const worst = (Array.isArray(loaf.worst) ? loaf.worst : []).slice(0, 10).filter(isObj).map((f) => ({
    d: int(f.d, 60_000), b: int(f.b, 60_000), t: int(f.t, 1e10),
    s: (Array.isArray(f.s) ? f.s : []).slice(0, 5).filter(isObj).map((sc) => ({
      src: cleanScriptSrc(sc.src), fn: cleanLabel(sc.fn), inv: cleanLabel(sc.inv),
      d: int(sc.d, 60_000), fsl: int(sc.fsl, 60_000),
    })),
  }));

  const bytes: NormalizedRow["bytes"] = {};
  if (isObj(body.bytes)) {
    for (const [k, v] of Object.entries(body.bytes)) {
      if (!CATEGORY_SET.has(k) || !isObj(v)) continue;
      bytes[k] = { n: int(v.n, 1e9), b: int(v.b, 1e15), nb: int(v.nb, 1e9) };
    }
  }

  const inpIn = isObj(body.inp) ? body.inp : null;
  const inp = inpIn && {
    ms: int(inpIn.ms, 60_000),
    type: typeof inpIn.type === "string" && /^[a-z]{1,20}$/.test(inpIn.type) ? inpIn.type : "other",
    target: cleanSelector(inpIn.target),
    inDelay: int(inpIn.inDelay, 60_000), proc: int(inpIn.proc, 60_000), pres: int(inpIn.pres, 60_000),
  };

  const p = isObj(body.player) ? body.player : null;
  const player = p && {
    // A page from before the platform-key rename names the site's player by the old id (nativePlatform.ts).
    src: typeof p.src === "string" && PLAYER_SRCS.has(String(normalizePlatform(p.src))) ? String(normalizePlatform(p.src)) : "other",
    silent: bool(p.silent), vol: n(p.vol, 1, null),
    mountedMs: int(p.mountedMs, 30 * DAY_MS), unseenMs: int(p.unseenMs, 30 * DAY_MS),
    silentUnseenMs: int(p.silentUnseenMs, 30 * DAY_MS), foldedMs: int(p.foldedMs, 30 * DAY_MS),
    video: video(p.video),
  };

  const d = isObj(body.decode) ? body.decode : null;
  const decode = d && {
    type: d.type === "media-source" ? "media-source" : "webrtc",
    supported: bool(d.supported), smooth: bool(d.smooth), powerEfficient: bool(d.powerEfficient),
  };
  const f = isObj(body.frames) ? body.frames : null;
  const frames = f && { fps: n(f.fps, 1000, 0), costMs: n(f.costMs, 10_000, 0) };
  const a = isObj(body.anim) ? body.anim : null;
  const anim = a && { running: int(a.running, 1e6), idle: int(a.idle, 1e6) };
  const st = isObj(body.settings) ? body.settings : null;
  const settings = st && {
    animEmotes: st.animEmotes === true, lowPower: st.lowPower === true,
    reducedMotion: st.reducedMotion === true, startMuted: st.startMuted === true,
  };
  const heap = isObj(body.heap) ? body.heap : {};
  const sock = isObj(body.sock) ? body.sock : {};

  return {
    sessionId: body.sid.toLowerCase(), seq,
    route: typeof body.route === "string" && /^\/[a-z0-9_-]{0,40}$/i.test(body.route) ? body.route : "other",
    deviceClass: body.dc === "mobile" ? "mobile" : "desktop",
    narrow: bool(body.narrow),
    deviceMemory: n(body.dm, 1024, null), hwConcurrency: intOrNull(body.hc, 1024),
    effectiveType: typeof body.et === "string" && EFFECTIVE_TYPES.has(body.et) ? body.et : null,
    saveData: bool(body.sd), dpr: n(body.dpr, 16, null),
    openMs: int(body.openMs, 30 * DAY_MS), visibleMs: int(body.visMs, 30 * DAY_MS),
    loafCount: int(loaf.n, 1e9), loafBlockingMs: int(loaf.blockMs, 2e9), loafWorst: worst,
    inpMs: inp ? inp.ms : null, inp, cls: n(body.cls, 1000, null),
    reqCount: int(body.req, 1e9), bytes, socketReconnects: int(sock.reconnects, 1e6),
    player, decode, frames, anim, settings,
    heapStartMb: n(heap.startMb, 1e6, null), heapPeakMb: n(heap.peakMb, 1e6, null),
  };
}

/** The body cap the route enforces, on both the declared and the measured length. */
export const MAX_BODY_BYTES = MAX_REPORT_BYTES;

/**
 * The route's two limits: 60 reports a minute per address, and — because there is no
 * dedupe here, unlike client_errors — at most `newPerHour` NEW session ids an hour per address,
 * which is what stops an open endpoint becoming a row factory. Known (address, session id) pairs are
 * remembered in a bounded set (oldest forgotten first); a forgotten id only costs one more "new" count.
 */
export function createDeviceHealthGate(opts: { perMinute?: number; newPerHour?: number; remember?: number } = {}) {
  const perMinute = createSlidingWindowLimiter(60_000, opts.perMinute ?? 60);
  const newPerHour = createSlidingWindowLimiter(3_600_000, opts.newPerHour ?? 120);
  const remember = opts.remember ?? 20_000;
  const known = new Set<string>();
  return {
    /** True when this request (before parsing) is over the per-minute limit. */
    limited: (ipKey: string) => perMinute(ipKey),
    /** True when this session id is NEW and the address has used up its new ids for the hour. */
    newSessionLimited(ipKey: string, sid: string): boolean {
      // Known per ADDRESS, not globally: a session id seen from one
      // address must not let another address skip this limit and overwrite that row.
      const k = `${ipKey}|${sid}`;
      if (known.has(k)) return false;
      if (newPerHour(ipKey)) return true;
      known.add(k);
      if (known.size > remember) known.delete(known.values().next().value as string);
      return false;
    },
  };
}
