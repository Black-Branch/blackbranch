// Discord's markdown subset, on SEND, to the HTML the render side already
// accepts (matrixHtml.ts allowlist). Hand-written on purpose: a general
// markdown library adds tables, setext headings, images and raw-HTML
// passthrough that Discord does not do, and the bridge turns this HTML back
// into Discord markdown, so what a Discord user types by habit must round-trip.
//
// The caller supplies `inline`, which renders a plain-text run (emotes, pills,
// escaping) — the converter never escapes a run itself, except inside code,
// where nothing else applies.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type InlineRenderer = (run: string) => string;
export type MarkdownResult = { html: string; changed: boolean };

const FENCE_OPEN = /^```([A-Za-z0-9+#.-]{1,32})?\s*$/;
const FENCE_CLOSE = /^```\s*$/;
const HEADING = /^(#{1,3}) (.+)$/;
// Discord treats a leading `- ` OR `* ` as a bullet — `* a *` is a list item
// whose text is `a *`, not an emphasis attempt (a `* ` line never reaches the
// inline `*` rule at all, since block detection runs first).
const BULLET = /^[-*] /;
const ORDERED = /^\d+\. /;
const ESCAPABLE = new Set(["*", "_", "~", "`", "|", ">", "#", "\\"]);
const WORD = /[A-Za-z0-9]/;

// Inline delimiters, longest first so `***` is not read as `**` + `*`.
// `inlineMd` re-scans its own remaining slice from each delimiter's content
// start, so nested delimiters are worst-case quadratic in input length —
// accepted: a few milliseconds even at the composer's 2000-character limit.
const DELIMS: Array<{ d: string; open: string; close: string }> = [
  { d: "***", open: "<strong><em>", close: "</em></strong>" },
  { d: "**", open: "<strong>", close: "</strong>" },
  { d: "__", open: "<u>", close: "</u>" },
  { d: "~~", open: "<del>", close: "</del>" },
  { d: "||", open: "<span data-mx-spoiler>", close: "</span>" },
  { d: "*", open: "<em>", close: "</em>" },
  { d: "_", open: "<em>", close: "</em>" },
];

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

export function renderMarkdown(text: string, inline: InlineRenderer): MarkdownResult {
  let changed = false;

  function inlineMd(s: string): string {
    const out: string[] = [];
    let plain = "";
    const flush = () => {
      if (plain) out.push(inline(plain));
      plain = "";
    };
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === "\\" && ESCAPABLE.has(s[i + 1] ?? "")) {
        plain += s[i + 1];
        changed = true;
        i += 2;
        continue;
      }
      if (ch === "`") {
        let n = 1;
        while (s[i + n] === "`") n++;
        const run = "`".repeat(n);
        const end = s.indexOf(run, i + n);
        if (end > i + n) {
          flush();
          out.push(`<code>${escapeHtml(s.slice(i + n, end))}</code>`);
          changed = true;
          i = end + n;
          continue;
        }
        plain += run;
        i += n;
        continue;
      }
      const delim = DELIMS.find((x) => s.startsWith(x.d, i));
      if (delim) {
        const { d } = delim;
        const contentStart = i + d.length;
        // `_` only formats at word boundaries (snake_case stays text).
        const wordBound = d !== "_" || !WORD.test(s[i - 1] ?? " ");
        if (wordBound && !isSpace(s[contentStart])) {
          let end = s.indexOf(d, contentStart);
          while (end !== -1 && (isSpace(s[end - 1]) || (d === "_" && WORD.test(s[end + 1] ?? " ")))) {
            end = s.indexOf(d, end + 1);
          }
          if (end !== -1) {
            // A closing run longer than this delimiter (e.g. the trailing
            // `***` of `**bold *and italic***`) closes with its LAST
            // `d.length` characters, leaving the leading extra character(s)
            // inside the content for the recursive parse to pair up as a
            // nested delimiter — otherwise the inner `*and italic*` would
            // never find its own closing `*`.
            let runLen = 0;
            while (s[end + runLen] === d[0]) runLen++;
            if (runLen > d.length) end += runLen - d.length;
            flush();
            out.push(delim.open + inlineMd(s.slice(contentStart, end)) + delim.close);
            changed = true;
            i = end + d.length;
            continue;
          }
        }
        plain += d;
        i += d.length;
        continue;
      }
      plain += ch;
      i++;
    }
    flush();
    return out.join("");
  }

  const lines = text.split("\n");
  const out: string[] = [];
  let plain: string[] = [];
  const flushPlain = () => {
    if (plain.length) out.push(plain.join("<br>"));
    plain = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("```")) {
      const fence = FENCE_OPEN.exec(line);
      if (fence) {
        flushPlain();
        const code: string[] = [];
        i++;
        while (i < lines.length && !FENCE_CLOSE.test(lines[i] ?? "")) {
          code.push(lines[i] ?? "");
          i++;
        }
        i++; // the closing fence (or past the end)
        const cls = fence[1] ? ` class="language-${fence[1]}"` : "";
        out.push(`<pre><code${cls}>${escapeHtml(code.join("\n"))}</code></pre>`);
        changed = true;
        continue;
      }
      // An invalid language token (e.g. containing a space) means this was
      // never a fence at all — including whatever bare ``` would otherwise
      // have read as its close, which must NOT get a second, independent
      // chance to open an (empty) fence of its own.
      plain.push(inlineMd(line));
      i++;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i] ?? "")) {
        plain.push(inlineMd(lines[i] ?? ""));
        i++;
      }
      if (i < lines.length) {
        plain.push(inlineMd(lines[i] ?? ""));
        i++;
      }
      continue;
    }
    if (line.startsWith(">>> ")) {
      flushPlain();
      const rest = [line.slice(4), ...lines.slice(i + 1)];
      out.push(`<blockquote>${rest.map(inlineMd).join("<br>")}</blockquote>`);
      changed = true;
      break;
    }
    if (line.startsWith("> ")) {
      flushPlain();
      const quoted: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith("> ")) {
        quoted.push((lines[i] ?? "").slice(2));
        i++;
      }
      out.push(`<blockquote>${quoted.map(inlineMd).join("<br>")}</blockquote>`);
      changed = true;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushPlain();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inlineMd(heading[2]!)}</h${level}>`);
      changed = true;
      i++;
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      flushPlain();
      const ordered = ORDERED.test(line);
      const re = ordered ? ORDERED : BULLET;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(re, ""));
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((t) => `<li>${inlineMd(t)}</li>`).join("")}</${tag}>`);
      changed = true;
      continue;
    }
    plain.push(inlineMd(line));
    i++;
  }
  flushPlain();
  return { html: out.join(""), changed };
}
