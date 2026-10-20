/** POST/PUT/PATCH/DELETE a JSON body to our own API routes. Returns the raw
 * Response so callers keep full control of res.ok / res.json() / .catch().
 * Pass no body for a bodyless request (e.g. a DELETE that needs no payload).
 *
 * `timeoutMs` bounds the request with `AbortSignal.timeout`. It is OPT-IN, not
 * a default: this helper also carries media uploads, which are legitimately
 * slow, and a blanket ceiling would abort them. Opt in wherever silence is
 * worse than failure — a bare `fetch` waits on whatever the browser and the
 * edge happen to agree on, which on the chat send path can be ~10 seconds of
 * a cleared composer with no feedback at all.
 *
 * On timeout the rejection is a DOMException named `TimeoutError`, whose
 * message is the useless "signal timed out". Callers that surface `err.message`
 * to a human must map it — see useSendChatMessage.
 *
 * `keepalive` is also OPT-IN: it is the standard mechanism for a request that
 * must survive the page unloading or navigating away mid-flight (see
 * clientError.ts, which sets it because an error boundary's own recovery can
 * reload the page before an ordinary fetch would otherwise land). It is not a
 * default because the browser caps a keepalive request's body size, and most
 * callers here have no reason to outlive navigation. */
export function postJson(
  url: string,
  body?: unknown,
  method: "POST" | "PUT" | "PATCH" | "DELETE" = "POST",
  opts?: { timeoutMs?: number; keepalive?: boolean },
): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  if (opts?.timeoutMs) init.signal = AbortSignal.timeout(opts.timeoutMs);
  if (opts?.keepalive) init.keepalive = true;
  return fetch(url, init);
}

/** Classify a `fetch` rejection — the cases where NO response arrived, so every
 * status-code branch a caller has is moot.
 *
 * The two are not interchangeable and must not be reported as one:
 *  • `unreachable` — the request never left (offline, DNS, refused). The send
 *    definitively did not happen, and saying so is true.
 *  • `timeout` — we stopped waiting. The server may well have processed it and
 *    only the response was lost, so a caller must NOT claim "not sent". Any
 *    retry on this path has to be idempotent.
 *
 * `null` means the rejection was something else; re-throw it rather than
 * dressing an unrelated bug up as a network blip. */
// Failure codes that prove the request NEVER LEFT this machine: no connection
// was ever established (refused, DNS, no route, undici's connect deadline).
// Only these keep `unreachable`'s "the send definitively did not happen".
const NEVER_LEFT_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  "ENETDOWN", "EADDRNOTAVAIL", "UND_ERR_CONNECT_TIMEOUT",
]);

// Every failure code carried by `err.cause` on a fetch TypeError. Node's
// dual-stack (happy-eyeballs) connect failure arrives as an AggregateError
// whose members carry the codes, sometimes without one on the aggregate itself.
function causeCodes(err: TypeError): string[] {
  const cause = (err as { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") return [];
  const codes: string[] = [];
  const code = (cause as { code?: unknown }).code;
  if (typeof code === "string") codes.push(code);
  if (cause instanceof AggregateError) {
    for (const e of cause.errors) {
      const c = (e as { code?: unknown } | null)?.code;
      if (typeof c === "string") codes.push(c);
    }
  }
  return codes;
}

export function networkFailureKind(err: unknown): "timeout" | "unreachable" | null {
  if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) return "timeout";
  // `fetch` rejects with a plain TypeError for every transport failure, and the
  // message text differs per runtime — so match on the type, never the wording.
  if (err instanceof TypeError) {
    // Server-side (undici) the SAME TypeError covers both "never connected"
    // and "connection severed AFTER the body went out" (keep-alive race,
    // stream-api restart with a spend in flight). The second may have been
    // PROCESSED — calling it `unreachable` legalizes a refund for a spend that
    // credited. undici's `err.cause.code` is the discriminator.
    const codes = causeCodes(err);
    if (codes.length > 0) {
      // `unreachable` only when EVERY code proves the request never left; any
      // indeterminate or unrecognized code demotes the whole failure to the
      // timeout path — evidence withheld is not evidence of safety.
      return codes.every((c) => NEVER_LEFT_CODES.has(c)) ? "unreachable" : "timeout";
    }
    // No cause code = a browser rejection, where TypeError still means
    // offline/DNS/refused. Keep the honest "not sent" meaning there.
    return "unreachable";
  }
  return null;
}

/** Thrown by getJson/postJsonOrThrow on a non-2xx response. `status` lets callers
 * branch (e.g. 429 → "slow down"); `message` is the server's { error } text. */
// `status` is an explicit field, NOT a constructor parameter property
// (`constructor(public readonly status: number, …)`). Parameter properties are
// the one TS construct Node's strip-only type stripping cannot compile, and
// this module sits in the import graph of hooks exercised under `node --test` —
// so the shorthand takes the whole render-test suite down with
// ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. Identical at runtime; keep it spelled out.
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
}

// Pull the most useful message out of an error Response: the server's { error }
// JSON field if present, else the raw text, else a generic status line.
async function errorMessage(res: Response): Promise<string> {
  try {
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (typeof body?.error === "string" && body.error) return body.error;
    } else {
      const text = await res.text().catch(() => "");
      if (text) return text;
    }
  } catch { /* fall through to generic */ }
  return `Request failed (${res.status})`;
}

/** GET a JSON endpoint and parse it as T. Throws HttpError on non-2xx (use a
 * try/catch or `.catch()` for the optional path). Centralizes the untyped
 * `fetch().then(r => r.json())` reads scattered across the app. */
export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new HttpError(res.status, await errorMessage(res));
  return res.json() as Promise<T>;
}

/** Like postJson, but throws HttpError on non-2xx (surfacing the server's { error })
 * and returns the parsed body as T. Replaces the repeated
 * `if (!r.ok) throw new Error((await r.json())?.error)` boilerplate.
 * `opts.timeoutMs` is postJson's — opt-in, same reasoning. */
export async function postJsonOrThrow<T = unknown>(
  url: string,
  body?: unknown,
  method: "POST" | "PUT" | "PATCH" | "DELETE" = "POST",
  opts?: { timeoutMs?: number },
): Promise<T> {
  const res = await postJson(url, body, method, opts);
  if (!res.ok) throw new HttpError(res.status, await errorMessage(res));
  if (res.status === 204) return undefined as T;
  return res.json().catch(() => undefined) as Promise<T>;
}
