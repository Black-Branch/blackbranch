// Readable-article extraction for GET /api/rss/article — the fetch, the parse,
// the cache and the global slot cap, lifted out of the route so a test can drive
// them with a fake fetch (articleExtract.test.ts).
//
// Only links already in site.rss_items are fetched, but the publisher behind one
// can stall or drip forever, and the slot cap is global: before external review
// S7, three stalled publishers held every slot and every other reader got 503
// until a socket timeout, and a huge body went whole into the synchronous parse.
// Now each URL gets one TOTAL deadline (headers and body) and a byte cap
// enforced while the body is read (which also bounds the parse), and
// concurrent misses for one URL share one extraction.
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import sanitizeHtml from "sanitize-html";

export type ArticleData = { title: string | null; byline: string | null; html: string };
export type ArticleOutcome = { ok: true; data: ArticleData } | { ok: false; error: string };
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const TTL = 30 * 60_000;
const MAX_CACHE = 200;
// A realistic UA — many publishers 403 a bot-looking agent.
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function clean(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "figure", "figcaption", "h1", "h2"]),
    allowedAttributes: {
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt"],
    },
    // Drop tracking/relative images that won't load cross-origin; keep https only.
    exclusiveFilter: (f) => f.tag === "img" && !(f.attribs.src ?? "").startsWith("https://"),
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer" }),
    },
  });
}

/** Settles with `p`, or rejects as soon as `signal` aborts — whether or not
 *  `p` itself honours the signal (a DNS lookup, a fetch that ignores it). */
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

/** The body as text, refusing more than `maxBytes` — counted while it is read,
 *  so an oversized or endless body is cancelled at the cap rather than buffered
 *  and measured afterwards. Decoded as UTF-8, as `res.text()` does. */
async function readCapped(res: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new Error("too_large");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await untilAborted(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("too_large");
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

/** @parked consumed by app/api/rss/article/route.ts's binding and by
 *  articleExtract.test.ts, which drives it with a fake fetch. */
export function createArticleExtractor(deps: {
  fetch: Fetcher;
  /** Distinct URLs extracted at once, across all readers. */
  maxInflight?: number;
  /** Headers plus body, per URL. The synchronous parse after it is bounded by maxBytes. */
  deadlineMs?: number;
  /** Largest body read; a page past it is refused, never parsed. */
  maxBytes?: number;
}) {
  const cache = new Map<string, { at: number; data: ArticleData }>();
  const maxInflight = deps.maxInflight ?? 3;
  const deadlineMs = deps.deadlineMs ?? 10_000;
  const maxBytes = deps.maxBytes ?? 2 * 1024 * 1024;
  // One extraction per URL: concurrent misses for it wait on the same promise
  // and hold one slot between them.
  const running = new Map<string, Promise<ArticleOutcome>>();

  function cached(url: string): ArticleData | null {
    const hit = cache.get(url);
    return hit && Date.now() - hit.at < TTL ? hit.data : null;
  }

  /** The extraction for `url` — joined if one is already running. null = every
   *  slot is taken by other URLs (the route answers 503 busy). A slot is held
   *  for at most `deadlineMs`: the deadline aborts the fetch, cancels the body
   *  and settles the extraction even when the publisher ignores the abort. */
  function extract(url: string): Promise<ArticleOutcome> | null {
    const joined = running.get(url);
    if (joined) return joined;
    if (running.size >= maxInflight) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("timeout")), deadlineMs);
    const run = (async (): Promise<ArticleOutcome> => {
      try {
        const fetching = deps.fetch(url, {
          headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
          signal: ac.signal,
        });
        // A response that arrives after the deadline is nobody's: close its body.
        fetching.then((r) => { if (ac.signal.aborted) r.body?.cancel().catch(() => {}); }, () => {});
        const res = await untilAborted(fetching, ac.signal);
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          throw new Error(`http_${res.status}`);
        }
        const html = await readCapped(res, maxBytes, ac.signal);
        const dom = new JSDOM(html, { url });
        const article = new Readability(dom.window.document).parse();
        // Reject too-thin extractions (paywall teasers / failed parses) so the reader
        // shows the archive.is fallback rather than a misleading one-sentence stub.
        if (!article?.content || (article.textContent?.trim().length ?? 0) < 500) {
          throw new Error("no_content");
        }
        const data: ArticleData = {
          title: article.title ?? null,
          byline: article.byline ?? null,
          html: clean(article.content),
        };
        if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
        cache.set(url, { at: Date.now(), data });
        return { ok: true, data };
      } catch (e) {
        if (ac.signal.aborted) return { ok: false, error: "timeout" };
        return { ok: false, error: e instanceof Error ? e.message : "failed" };
      } finally {
        clearTimeout(timer);
        running.delete(url);
      }
    })();
    running.set(url, run);
    return run;
  }

  return { cached, extract };
}
