// Matrix `org.matrix.custom.html` → a serializable, allowlisted node tree.
//
// WHY THIS EXISTS
// Bridged messages (mautrix-discord) put their real content in `formatted_body`
// as HTML and only a markdown-ish FALLBACK in `body`. Rendering `body` would
// show a Discord forward or embed as literal `>` quotes and `[label](url)`.
//
// WHY IT IS NOT "JUST TRUST THE BRIDGE"
// `app/api/matrix/token/route.ts` hands the browser a RAW homeserver access
// token, and there is no server-side send proxy. Any logged-in site user can
// therefore PUT an event with `format: org.matrix.custom.html` and an arbitrary
// `formatted_body`, bypassing buildMatrixMessage entirely. So this input is
// hostile input from an AUTHENTICATED attacker, not bridge output.
//
// THE APPROACH: never inject HTML.
// We never produce a string of markup and never touch dangerouslySetInnerHTML.
// We parse to an inert document, walk it against a closed allowlist, and emit a
// plain data tree. The renderer (MatrixHtml.tsx) maps that tree to React
// elements, so anything not modelled here CANNOT reach the DOM — the failure
// mode of a missed case is "renders as text", not "executes".
//
// Text nodes stay raw and are handed to the existing `renderText` pipeline by
// the renderer, so emotes, Twemoji, bare-URL linkification and the
// deceptive-link guard all behave exactly as they do in normal chat.
//
// The allowlist below is DATA-DRIVEN: every tag and attribute was measured
// against the formatted_body events in a real Synapse, not guessed from the
// spec.

import { installValue } from "./installValues.ts";

const MAX_NODES = 400;
const MAX_DEPTH = 16;
/** Emote <img height> is clamped into this range; anything else is ignored. */
const EMOTE_H_MIN = 8;
const EMOTE_H_MAX = 64;

export type MxTag =
  | "p" | "br" | "span" | "a" | "img" | "blockquote"
  | "ul" | "ol" | "li"
  | "em" | "strong" | "u" | "s" | "del" | "sub" | "sup"
  | "code" | "pre"
  | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
  | "table" | "thead" | "tbody" | "tr" | "th" | "td"
  | "hr";

/** Closed set of Discord-embed structural roles (from `class=`). */
export type EmbedRole = "embed" | "author" | "title" | "description" | "image" | "footer" | "field";

export type MxAttrs = {
  href?: string;
  /** Already rewritten to a URL we are willing to load. */
  src?: string;
  alt?: string;
  title?: string;
  height?: number;
  /** `data-mx-emoticon` — render inline at chat-emote size, not as a block image. */
  emote?: true;
  /** `language-*` off a <code> class. */
  lang?: string;
  /** Structural role parsed from a Discord-embed class. */
  role?: EmbedRole;
  /** Validated `#rgb`/`#rrggbb` accent for the embed stripe. */
  accent?: string;
  /** `data-mx-spoiler` on a span — hidden until the reader clicks. */
  spoiler?: true;
  /** The attribute's value, when non-empty: what the spoiler is about. */
  spoilerReason?: string;
};

export type MxNode =
  | { t: "text"; text: string }
  | { t: "el"; tag: MxTag; attrs: MxAttrs; children: MxNode[] };

export type SanitizeResult = {
  nodes: MxNode[];
  /** Hit a size/depth cap — the renderer shows an explicit "…" so it is never silent. */
  truncated: boolean;
};

/** DOMParser-shaped. Injected so tests can supply jsdom's. */
export type ParserLike = { parseFromString(markup: string, type: string): Document };

// ─── allowlists ───────────────────────────────────────────────────────────────

const ALLOWED: ReadonlySet<string> = new Set<MxTag>([
  "p", "br", "span", "a", "img", "blockquote",
  "ul", "ol", "li",
  "em", "strong", "u", "s", "del", "sub", "sup",
  "code", "pre",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tr", "th", "td",
  "hr",
]);

/** Presentational synonyms folded onto their semantic twin. */
const ALIAS: Record<string, MxTag> = { b: "strong", i: "em", strike: "del", ins: "u", font: "span" };

// Dropped ENTIRELY — element and descendants.
//
// These must never be "unwrapped" like other unknown tags. DOMParser puts a
// <script>'s or <style>'s source in a TEXT child, so unwrapping would splash raw
// JavaScript or CSS into the message as visible text. <mx-reply> is dropped for a
// different reason: it is the spec's reply FALLBACK, and we render replies with
// our own ReplyPreview — keeping it would double every quoted message.
const DROP: ReadonlySet<string> = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet",
  "svg", "math", "form", "input", "button", "select", "textarea", "option",
  "link", "meta", "base", "title", "head", "noscript", "template",
  "audio", "video", "source", "track", "canvas", "map", "area", "portal",
  "mx-reply",
]);

// Hosts we are willing to load an <img> from.
//
// Not "mxc:// only": that would break our OWN emotes — buildMatrixMessage.ts emits
// `<img src="https://cdn.7tv.app/…" data-mx-emoticon>` for emotes in replies, and
// real images include https ones on emote CDNs. But leaving `img` open would
// be a tracking-pixel / IP-leak vector — next.config.ts CSP is `img-src 'self'
// https: data: blob:`, permissive enough that any remote src would load and phone
// home the reader's IP and user-agent to a URL the SENDER chose. An allowlist
// keeps every image that legitimately appears while closing that.
const IMG_HOST_SUFFIXES = [
  "7tv.app", "7tv.io",              // 7TV
  "betterttv.net",                  // BTTV
  "jtvnw.net",                      // Twitch
  "frankerfacez.com",               // FFZ
];

/** The site's own host (install key site.origin) — images the site itself serves. */
function ownHost(): string | null {
  try {
    return new URL(installValue("site.origin")).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

// The server part must START AND END with an alphanumeric. A laxer
// `[A-Za-z0-9.-]+` accepts ".." — `mxc://../x` then builds
// `/api/matrix/media/download/../x`, which the browser resolves UP a path segment
// and out of the media proxy. matrixHtml.test.ts pins it; keep the anchors. Every mxc → URL
// builder (matrixMedia.ts) and every place that STORES an mxc uses this one pattern.
export const MXC_RE = /^mxc:\/\/([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d+)?)\/([A-Za-z0-9_=-]+)$/;
const LANG_RE = /^language-([A-Za-z0-9+#.-]{1,32})$/;
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const EMBED_ROLES: Record<string, EmbedRole> = {
  "discord-embed": "embed",
  "discord-embed-author": "author",
  "discord-embed-title": "title",
  "discord-embed-description": "description",
  "discord-embed-image": "image",
  "discord-embed-footer": "footer",
  "discord-embed-field": "field",
};

// ─── value validators ─────────────────────────────────────────────────────────

function hostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  const own = ownHost();
  return [...IMG_HOST_SUFFIXES, ...(own ? [own] : [])].some((s) => h === s || h.endsWith("." + s));
}

/**
 * A link target we are willing to render.
 * `new URL()` normalizes away the classic obfuscations for us — it strips tabs and
 * newlines, so `java&#9;script:` collapses to `javascript:` and is then rejected by
 * the protocol check rather than sneaking through a naive string comparison.
 */
// @test-only matrixHtml.test.ts pins href sanitisation.
export function safeHref(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null; // relative or unparseable → drop (no base to resolve against)
  }
  if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "matrix:") return u.href;
  return null; // javascript:, data:, vbscript:, blob:, file: …
}

/** An image source we are willing to fetch: mxc through our proxy, or an allowlisted CDN. */
// @test-only matrixHtml.test.ts pins img-src sanitisation.
export function safeImgSrc(raw: string): string | null {
  const v = raw.trim();
  const mxc = v.match(MXC_RE);
  if (mxc) {
    // Charset is already constrained by MXC_RE, so neither segment can contain a
    // slash or "..": the proxy path below cannot be escaped.
    return `/api/matrix/media/download/${mxc[1]}/${mxc[2]}`;
  }
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  return hostAllowed(u.hostname) ? u.href : null;
}

// ─── the walk ─────────────────────────────────────────────────────────────────

function attrsFor(el: Element, tag: MxTag): MxAttrs | null {
  const attrs: MxAttrs = {};
  const get = (n: string) => el.getAttribute(n) ?? "";

  if (tag === "a") {
    const href = safeHref(get("href"));
    // A link with no usable target is not a link — unwrap to its text rather than
    // rendering a dead anchor.
    if (!href) return null;
    attrs.href = href;
  }

  if (tag === "img") {
    const src = safeImgSrc(get("src"));
    if (!src) return null; // disallowed host → drop the image entirely
    attrs.src = src;
    const alt = get("alt").slice(0, 200);
    if (alt) attrs.alt = alt;
    const title = get("title").slice(0, 200);
    if (title) attrs.title = title;
    if (el.hasAttribute("data-mx-emoticon")) attrs.emote = true;
    const h = Number.parseInt(get("height"), 10);
    if (Number.isFinite(h)) attrs.height = Math.min(EMOTE_H_MAX, Math.max(EMOTE_H_MIN, h));
  }

  if (tag === "code") {
    const m = get("class").match(LANG_RE);
    if (m) attrs.lang = m[1];
  }

  // Discord's ||spoiler|| bridges as <span data-mx-spoiler="reason?">. Only a
  // span carries it; the value is reader-facing text, so it is length-capped.
  if (tag === "span" && el.hasAttribute("data-mx-spoiler")) {
    attrs.spoiler = true;
    const reason = get("data-mx-spoiler").trim().slice(0, 100);
    if (reason) attrs.spoilerReason = reason;
  }

  // `class` is NEVER passed through as a string. Our stylesheet is Tailwind, so an
  // arbitrary class list is a UI-spoofing primitive — `class="fixed inset-0 z-50
  // bg-black"` from a message body would paint a full-page overlay. Instead the
  // class is mapped onto a CLOSED enum of embed roles and everything else is dropped.
  const role = EMBED_ROLES[get("class").trim()];
  if (role) attrs.role = role;

  // mautrix carries the embed's accent on a non-standard `background-color` attribute.
  if (tag === "blockquote") {
    const c = get("background-color").trim();
    if (HEX_RE.test(c)) attrs.accent = c;
  }

  return attrs;
}

type Ctx = { budget: { n: number }; truncated: { v: boolean }; pre: boolean; depth: number };

/** Collapse HTML whitespace the way CSS would — except inside <pre>. */
function normalizeText(s: string, pre: boolean): string {
  return pre ? s : s.replace(/[\t\n\r ]+/g, " ");
}

function walk(node: Node, ctx: Ctx, out: MxNode[]): void {
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i]!;

    if (ctx.budget.n <= 0) {
      ctx.truncated.v = true;
      return;
    }

    // TEXT_NODE
    if (child.nodeType === 3) {
      const text = normalizeText(child.nodeValue ?? "", ctx.pre);
      if (!text) continue;
      ctx.budget.n--;
      const last = out[out.length - 1];
      if (last?.t === "text") last.text += text; // keep the tree flat where we can
      else out.push({ t: "text", text });
      continue;
    }

    // Anything that is not an element (comments, CDATA, processing instructions)
    // carries no renderable content — skip rather than surface it.
    if (child.nodeType !== 1) continue;

    const el = child as Element;
    const name = el.tagName.toLowerCase();

    if (DROP.has(name)) continue;

    const tag = (ALIAS[name] ?? name) as MxTag;

    if (!ALLOWED.has(tag)) {
      // Unknown but harmless (e.g. <time>, <font> variants we don't model): keep the
      // CONTENT, discard the element. Dangerous tags never reach here — DROP catches
      // them above — so unwrapping can't expose script or style source.
      walk(el, ctx, out);
      continue;
    }

    if (ctx.depth >= MAX_DEPTH) {
      // Discord forwards nest blockquotes; without a depth cap a crafted message is
      // a render bomb. Past the cap keep the text and stop descending.
      const text = normalizeText(el.textContent ?? "", ctx.pre).trim();
      if (text) {
        ctx.budget.n--;
        out.push({ t: "text", text });
      }
      ctx.truncated.v = true;
      continue;
    }

    const attrs = attrsFor(el, tag);
    if (!attrs) {
      // Attribute validation rejected it (dead href, disallowed image host).
      // Images vanish; everything else keeps its text.
      if (tag !== "img") walk(el, ctx, out);
      continue;
    }

    ctx.budget.n--;
    const children: MxNode[] = [];
    const isVoid = tag === "br" || tag === "img" || tag === "hr";
    if (!isVoid) {
      walk(el, { ...ctx, depth: ctx.depth + 1, pre: ctx.pre || tag === "pre" }, children);
    }
    out.push({ t: "el", tag, attrs, children });
  }
}

// ─── entry point ──────────────────────────────────────────────────────────────

function defaultParser(): ParserLike | null {
  return typeof DOMParser === "undefined" ? null : new DOMParser();
}

/**
 * Parse and allowlist a `formatted_body`. Returns a tree the renderer maps to
 * React — never a markup string.
 *
 * The parse is inert: a document from `DOMParser.parseFromString` has no browsing
 * context, so scripts do not run and images are not fetched during sanitization.
 */
export function sanitizeMatrixHtml(html: string, parser?: ParserLike): SanitizeResult {
  const p = parser ?? defaultParser();
  // Server-render / no DOM available: degrade to the plain text of the markup
  // rather than shipping unparsed HTML anywhere near the DOM.
  if (!p) return { nodes: [{ t: "text", text: html.replace(/<[^>]*>/g, "") }], truncated: false };

  let doc: Document;
  try {
    // The leading "<body>" is load-bearing. `formatted_body` is a FRAGMENT, but
    // parseFromString parses a DOCUMENT — so a head-only element at the start
    // (<noscript>, <style>, <title>, <meta>) gets hoisted into <head>, and the
    // parser can spill its text content into <body> as a bare text node — so
    // `<noscript>PWNED</noscript>` would render as "PWNED" while the element we
    // would have dropped sat in the head, out of reach of the walk. Opening
    // <body> explicitly puts the parser in "in body" insertion mode, so
    // everything arrives as a real element in the tree and the DROP set
    // actually sees it.
    doc = p.parseFromString("<body>" + html, "text/html");
  } catch {
    return { nodes: [], truncated: false };
  }
  const body = doc.body;
  if (!body) return { nodes: [], truncated: false };

  const ctx: Ctx = { budget: { n: MAX_NODES }, truncated: { v: false }, pre: false, depth: 0 };
  const nodes: MxNode[] = [];
  walk(body, ctx, nodes);
  return { nodes, truncated: ctx.truncated.v };
}

/**
 * Every http(s) link target in a sanitized tree, in document order — the anchors'
 * hrefs, which is what LinkPreview should be built from on the HTML path. Reading
 * the raw markdown body instead is what produced duplicate/empty preview cards.
 *
 * A `matrix.to` href is excluded: `Anchor` draws those as a user pill (a person,
 * not a page), and MatrixMessageRow feeds every returned href to LinkPreview — so
 * without this, every resolved @mention fired a silent `/api/og` fetch for a URL
 * that was never going to render a card.
 */
export function treeHrefs(nodes: MxNode[]): string[] {
  const out: string[] = [];
  const visit = (ns: MxNode[]) => {
    for (const n of ns) {
      if (n.t !== "el") continue;
      if (n.tag === "a" && n.attrs.href && /^https?:/.test(n.attrs.href)) {
        let isPill = false;
        try {
          isPill = new URL(n.attrs.href).hostname === "matrix.to";
        } catch {
          /* unparseable already failed safeHref upstream; treat as not a pill */
        }
        if (!isPill) out.push(n.attrs.href);
      }
      visit(n.children);
    }
  };
  visit(nodes);
  return out;
}

/**
 * Plain-text projection of a sanitized tree (copy-to-clipboard, search).
 *
 * `imgAlt` controls whether <img> alt text counts as text. It must be FALSE for
 * anything that reasons about what the reader can see — see linkLabelText.
 */
export function treeText(nodes: MxNode[], imgAlt = true): string {
  let s = "";
  for (const n of nodes) {
    if (n.t === "text") s += n.text;
    else if (n.tag === "br") s += "\n";
    else if (n.tag === "img") s += imgAlt ? (n.attrs.alt ?? "") : "";
    else s += treeText(n.children, imgAlt);
  }
  return s;
}

/**
 * The text of a link as the READER SEES IT — the label the link-label guard must judge.
 *
 * Deliberately excludes <img alt>. The renderer paints the image, never its alt,
 * so alt text is invisible to the reader. Fed to the guard, it would let a 1x1
 * transparent emote with `alt="@"` inject an invisible character into the
 * label — enough to trigger the handle carve-out and suppress the phishing warning
 * on a link whose visible text was just "paypal.com". A guard that reasons about
 * deception has to read exactly what the human reads.
 */
export function linkLabelText(nodes: MxNode[]): string {
  return treeText(nodes, false);
}

/**
 * True when the tree carries a bridged Discord embed (`class="discord-embed"`,
 * mapped to role "embed") on a `blockquote` — the only tag `MatrixHtml.tsx`'s
 * `Quote` renderer ever draws as an embed. The role attribute is assigned from
 * the class regardless of tag, so any other element carrying it is decoration
 * an authenticated attacker can PUT on their own message; it renders as nothing
 * and must not count, or it would silently switch off the site's own preview
 * cards for a link that never actually got Discord's unfurl.
 */
export function treeHasEmbed(nodes: MxNode[]): boolean {
  for (const n of nodes) {
    if (n.t !== "el") continue;
    if (n.tag === "blockquote" && n.attrs.role === "embed") return true;
    if (treeHasEmbed(n.children)) return true;
  }
  return false;
}
