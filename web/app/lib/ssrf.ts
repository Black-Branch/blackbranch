import dns from "dns/promises";
import net from "net";
import { fetch as undiciFetch, Agent, type RequestInit as UndiciRequestInit } from "undici";

// SSRF guards for server-side fetches of user-influenced URLs (link previews,
// federated Matrix discovery, OAuth endpoints). A string-only hostname check is
// bypassable via DNS rebinding and redirects, so we additionally resolve the
// host and re-validate every hop.
//
// Validation alone is still racy: resolvePublic() resolves the host, but a
// plain fetch() then resolves it AGAIN independently — an attacker's DNS can
// answer "public" to our check and "private" (127.0.0.1, 169.254.x, LAN) to the
// connect a millisecond later (classic DNS-rebinding TOCTOU). safeFetch() closes
// that by PINNING the socket to the exact address we validated: it hands undici a
// per-hop dispatcher whose lookup can only ever return that address, while the
// TLS servername stays the real hostname so certificate validation is unaffected.
// (Node's built-in global fetch can't take our dispatcher — its bundled undici is
// a different major than the one in node_modules and the handler interfaces don't
// match — so we call undici's own fetch, keeping undici encapsulated here.)

// Fast path: reject obviously-private hostnames and literal private IPs.
// @test-only ssrf.test.ts pins the private-range checks.
export function isPrivateHost(host: string): boolean {
  const h = (host.startsWith("[") ? host.slice(1, -1) : host).toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.|0\.)/.test(h)) return true;
  // IPv6: loopback, link-local (fe80::/10), ULA (fc00::/7), IPv6-mapped IPv4
  if (/^(::1$|fe[89ab][0-9a-f]:|f[cd][0-9a-f]{2}:|::ffff:)/i.test(h)) return true;
  return false;
}

// Backwards-compatible boolean check (also enforces an http(s) scheme).
export function isPrivateUrl(raw: string): boolean {
  try {
    const { hostname, protocol } = new URL(raw);
    if (protocol !== "https:" && protocol !== "http:") return true;
    return isPrivateHost(hostname);
  } catch {
    return true;
  }
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.|0\.)/.test(ip);
  }
  const l = ip.toLowerCase();
  if (l === "::1") return true;
  if (l.startsWith("::ffff:")) return isPrivateIp(l.slice(7)); // IPv6-mapped IPv4
  return /^fe[89ab]/.test(l) || /^f[cd][0-9a-f]{2}/.test(l);
}

type PinnedAddr = { address: string; family: number };

// Resolve the host and confirm every record is public. Throws on
// private/unresolvable/non-https targets. Returns the parsed URL plus the
// validated addresses (for pinning the eventual connection to exactly these).
// For an IP-literal host there is no name to rebind, so the literal is its own
// "address" and the family is inferred.
async function resolvePublic(raw: string): Promise<{ url: URL; addrs: PinnedAddr[] }> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid_url");
  }
  if (u.protocol !== "https:") throw new Error("not_https");
  if (isPrivateHost(u.hostname)) throw new Error("private_host");
  if (net.isIP(u.hostname)) {
    return { url: u, addrs: [{ address: u.hostname, family: net.isIPv6(u.hostname) ? 6 : 4 }] };
  }
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (addrs.length === 0) throw new Error("no_dns");
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error("private_ip");
  return { url: u, addrs };
}

// A dns.lookup-shaped function locked to `addrs`. undici forwards connect.lookup
// straight to net/tls.connect, so this is the only address the socket can reach —
// a rebind between our validation and the connect is impossible. net.connect calls
// this with all:false (single-address callback); the all:true array form is
// honored defensively.
function pinnedLookup(addrs: PinnedAddr[]): net.LookupFunction {
  const first = addrs[0];
  return (_hostname, options, callback) => {
    if (!first) return callback(new Error("no_pinned_address"), "", 4);
    if (options && typeof options === "object" && options.all) {
      (callback as unknown as (e: NodeJS.ErrnoException | null, a: PinnedAddr[]) => void)(null, addrs);
    } else {
      callback(null, first.address, first.family);
    }
  };
}

// fetch() that validates the target before each request and re-validates on every
// redirect hop (redirect:"manual"), then PINS the connection to the validated
// address — closing both the redirect and the DNS-rebind SSRF bypasses. Re-uses
// `init` across hops. Returns a WHATWG Response (undici's, API-identical to the
// global; the cast keeps undici from leaking into callers' types).
// Headers that carry credentials and MUST NOT survive a cross-origin redirect —
// otherwise a hostile (user-influenced) endpoint could 3xx us into replaying the
// caller's token/cookie to an attacker origin. Browsers/undici strip these on a
// cross-origin redirect automatically; safeFetch follows redirects MANUALLY (to
// re-validate + pin each hop), so it must reproduce that stripping itself.
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/** Drop credential headers when a redirect crosses to a different origin.
 *  Exported for unit testing; mutates `headers` in place. */
// @test-only ssrf.test.ts pins credential stripping.
export function stripCredentialsOnCrossOrigin(headers: Headers, fromOrigin: string, toOrigin: string): void {
  if (fromOrigin === toOrigin) return;
  for (const h of CREDENTIAL_HEADERS) headers.delete(h);
}

/** The default deadline for a server-side fetch of a URL we do not control: the WHOLE exchange —
 *  DNS, connect, every redirect hop, headers AND reading the body — must finish inside it. */
export const FETCH_DEADLINE_MS = 10_000;

/** Request options for safeFetch / homeserverFetch. `timeoutMs` replaces the default deadline (a
 *  caller that legitimately reads a large body passes its own); a caller's `signal` still works,
 *  and whichever fires first ends the request. */
export type FetchInit = RequestInit & { timeoutMs?: number };

/**
 * The caller's signal (if any) combined with a deadline `ms` from NOW.
 *
 * Why a signal and not a socket timeout: undici's `bodyTimeout` measures the gap BETWEEN chunks, so
 * a server that trickles one byte every 200 ms never trips it and holds the request open for as
 * long as it likes. A signal passed into fetch also errors the response stream while the caller is
 * still reading it — so it must be made BEFORE the fetch and left live until the body has been
 * read. Never replace or clear it once the headers arrive.
 */
export function deadlineSignal(signal: AbortSignal | null | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Settles with `p`, or rejects as soon as `signal` aborts — a DNS lookup cannot itself be aborted. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

type Resolver = (raw: string) => Promise<{ addrs: PinnedAddr[] }>;

export function safeFetch(
  rawUrl: string,
  init: FetchInit & { maxRedirects?: number } = {},
): Promise<Response> {
  return pinnedFetch(resolvePublic, rawUrl, init);
}

/**
 * safeFetch with the address check replaced by `resolve` — so a test can point the real transport
 * at a local server (which the real check refuses, correctly). Never for product code: it is the
 * SSRF guard with the guard removed.
 */
// @test-only ssrf.test.ts drives the real transport against a local trickling server.
export function pinnedFetchForTest(
  resolve: Resolver,
  rawUrl: string,
  init: FetchInit & { maxRedirects?: number } = {},
): Promise<Response> {
  return pinnedFetch(resolve, rawUrl, init);
}

async function pinnedFetch(
  resolve: Resolver,
  rawUrl: string,
  init: FetchInit & { maxRedirects?: number },
): Promise<Response> {
  const { maxRedirects, headers: initHeaders, timeoutMs, signal: callerSignal, ...rest } = init;
  const max = maxRedirects ?? 4;
  const ms = timeoutMs ?? FETCH_DEADLINE_MS;
  // ONE deadline for the whole call: every hop, and the caller's read of the body after we return.
  const signal = deadlineSignal(callerSignal, ms);
  let url = rawUrl;
  // Own a mutable Headers so credential headers can be stripped per-hop on a
  // cross-origin redirect without mutating the caller's object.
  const headers = new Headers(initHeaders as HeadersInit | undefined);
  let origin = new URL(rawUrl).origin;
  for (let i = 0; i <= max; i++) {
    const { addrs } = await untilAborted(resolve(url), signal);
    // Fresh per-hop dispatcher pinned to this hop's validated address(es). Short
    // keep-alive so the socket drains and the Agent is collectible once the body
    // is read; no long-lived idle sockets accumulate across calls. The socket
    // timeouts are a second line only: the deadline signal is what bounds a trickle.
    const dispatcher = new Agent({
      connect: { lookup: pinnedLookup(addrs) },
      keepAliveTimeout: 1,
      keepAliveMaxTimeout: 1,
      headersTimeout: ms,
      bodyTimeout: ms,
    });
    const res = await undiciFetch(url, {
      ...(rest as UndiciRequestInit),
      headers,
      redirect: "manual",
      dispatcher,
      signal,
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await dispatcher.close();
      if (!loc) return res as unknown as Response;
      const next = new URL(loc, url);
      stripCredentialsOnCrossOrigin(headers, origin, next.origin);
      url = next.toString();
      origin = next.origin;
      continue;
    }
    // Terminal response: leave the dispatcher open so the caller can read the body — inside
    // the same deadline, which is still armed.
    return res as unknown as Response;
  }
  throw new Error("too_many_redirects");
}
