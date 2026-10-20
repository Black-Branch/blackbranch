// The request proxy: the first-boot gate for every path, then Auth.js for the signed-in areas — and
// the two response headers that name this install's own values: the Content-Security-Policy with
// the install's origins (app/lib/csp.ts), and the points icon's cache line. The values are read at
// start, not fixed at build.
//
// While a fresh install is being set up (app/lib/setup/setupGate.ts), every page goes to /setup and
// every other API answers 503. The state comes from /api/setup/status on this same server — the
// proxy may run apart from the app's modules, so it never reads the settings layer's memory
// itself. Any failure to learn the state fails OPEN, and "complete" is remembered longest: on a
// site that is set up the gate costs one local request every few minutes.
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { gateAction, setupPathOpen, type SetupGateState } from "@/app/lib/setup/setupGate";
import { contentSecurityPolicy } from "@/app/lib/csp";
import { installValue } from "@/app/lib/installValues";
import { MEDIA_CSP, MEDIA_PROXY_PREFIX } from "@/app/lib/mediaHeaders";

const AUTH_AREAS = /^\/(account|mod|admin)(\/|$)/;
const TTL: Record<SetupGateState, number> = { complete: 300_000, "setting-up": 2_000, unknown: 5_000 };

let known: { state: SetupGateState; until: number } | null = null;
let asking: Promise<SetupGateState> | null = null;

async function ask(): Promise<SetupGateState> {
  try {
    const res = await fetch(`http://127.0.0.1:${process.env.PORT || "3000"}/api/setup/status`, {
      cache: "no-store", signal: AbortSignal.timeout(1_500),
    });
    const j = (await res.json()) as { state?: unknown };
    return j.state === "setting-up" || j.state === "complete" ? j.state : "unknown";
  } catch {
    return "unknown";
  }
}

async function gateState(): Promise<SetupGateState> {
  if (known && known.until > Date.now()) return known.state;
  asking ??= ask().then((state) => {
    known = { state, until: Date.now() + TTL[state] };
    asking = null;
    return state;
  });
  return asking;
}

const authed = auth as unknown as (req: NextRequest, ev: NextFetchEvent) => Promise<Response | undefined>;

// The policy with this install's origins, made once per distinct set (the values never change in
// a running process; a test may give new ones).
let cspFor = "";
let csp = "";
function installCsp(): string {
  const o = { api: installValue("site.apiOrigin"), ws: installValue("site.apiWsOrigin"), matrix: installValue("matrix.baseUrl") };
  const k = `${o.api} ${o.ws} ${o.matrix}`;
  if (k !== cspFor) { cspFor = k; csp = contentSecurityPolicy(o); }
  return csp;
}

// The points icon (install key currency.icon) when it is a file on this site: a small, near-static
// asset Lighthouse flagged at a 4 h TTL. 30 days, NOT immutable: the name is unversioned, so a new
// icon still reaches everyone within a month (or at once, under a new name). Unset = the built-in
// glyph, no file. The matcher's second entry sends image files here for this one check.
const IMAGE_FILE = /\.(?:webp|png|gif|svg|avif|jpe?g)$/i;
function pointsIconPath(): string | null {
  const v = installValue("currency.icon");
  return /^\/[\w./-]+$/.test(v) ? v : null;
}

/** Sets a header where the response allows it (a redirect made by a library may be immutable). */
function withHeader(res: Response, name: string, value: string): Response {
  try { res.headers.set(name, value); } catch { /* immutable headers: leave the response as it is */ }
  return res;
}

export async function proxy(req: NextRequest, ev: NextFetchEvent) {
  const path = req.nextUrl.pathname;
  if (IMAGE_FILE.test(path)) {
    const res = NextResponse.next();
    if (path === pointsIconPath()) res.headers.set("Cache-Control", "public, max-age=2592000");
    return res;
  }
  return withHeader(await route(req, ev, path), "Content-Security-Policy", responseCsp(path));
}

/** The Matrix media proxy serves bodies whose type an uploader chose: it gets the media sandbox,
 *  never the site's policy (which allows inline script). Next keeps the first CSP set, so the
 *  route's own sandbox would otherwise never arrive. */
function responseCsp(path: string): string {
  return path.startsWith(MEDIA_PROXY_PREFIX) ? MEDIA_CSP : installCsp();
}

async function route(req: NextRequest, ev: NextFetchEvent, path: string): Promise<Response> {
  if (!setupPathOpen(path)) {
    const action = gateAction(path, await gateState());
    if (action === "redirect") {
      // Next's proxy needs an absolute Location; the request's own URL keeps its host.
      const to = req.nextUrl.clone();
      to.pathname = "/setup";
      to.search = "";
      const res = NextResponse.redirect(to, 307);
      res.headers.set("Cache-Control", "no-store");
      return res;
    }
    if (action === "unavailable") return NextResponse.json({ error: "this site is being set up" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (AUTH_AREAS.test(path)) return (await authed(req, ev)) ?? NextResponse.next();
  return NextResponse.next();
}

export const config = {
  // Every path but the build's static files and anything with a file extension (icons, fonts, the
  // service worker…), which the gate never needs to hold back — plus image files outside the
  // build's own, for the points icon's cache line alone (above).
  matcher: [
    "/((?!_next/static|_next/image|.*\\.[A-Za-z0-9]+$).*)",
    "/((?!_next/).*\\.(?:webp|png|gif|svg|avif|jpg|jpeg))",
  ],
};
