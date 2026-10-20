"use client";

import React from "react";
import { stripBidiControls } from "./bidi";
import { deceptiveLinkHost, linkDestinationHost } from "./linkGuard";
// In its own .ts module so it can be unit-tested — `node --test` cannot load a
// .tsx file at all. Same reason the markdown-link phishing guard lives in ./linkGuard.
import { splitTokens } from "./lineTokens";
import { elideUrl } from "./elideUrl";
import { stripTracking } from "./stripTracking";
import { copyText } from "./clipboard";
import { keepFocus } from "./keepFocus";
import type { EmoteMap } from "./useEmotes";
import { baselineEmoteUrl, emoteCrossOrigin, emoteSizingVersion, rightSizeEmoteUrl, stepDownEmoteUrl, subscribeEmoteSizing, twitchStillUrl } from "./emoteRes";
import { useClientValue } from "./useClientState";
import { Twemoji } from "./twemoji";
import { splitEmoji } from "./emojiSplit";
import { matchMention, type ChatDirectory } from "./chatDirectory";
import { maskProfanity } from "./profanity";

// ─── segment types ────────────────────────────────────────────────────────────

type EmoteSeg = {
  t: "emote";
  name: string;
  url: string;
  ar?: number; // intrinsic aspect ratio → reserve width before load (no CLS)
  still?: string; // static (first-frame) URL — swapped in when animated emotes are off
  h?: number; // the emote's real 1x height → its own size ladder (emoteRes.ts)
  overlays: { name: string; url: string; ar?: number; still?: string; h?: number }[];
  leading: boolean;
};
type TextSeg = { t: "text"; text: string; leading: boolean };
type UrlSeg = { t: "url"; href: string; leading: boolean };
type LinkSeg = { t: "link"; href: string; label: string; leading: boolean };
type BrSeg = { t: "br" };
// An @mention resolved against the chat directory. `trail` is the punctuation
// that followed it — it must render OUTSIDE the coloured span, or "@bob," looks
// like the comma is part of the name.
type MentionSeg = { t: "mention"; name: string; trail: string; color: string; leading: boolean };
type Seg = EmoteSeg | TextSeg | UrlSeg | LinkSeg | BrSeg | MentionSeg;

// ─── helpers ──────────────────────────────────────────────────────────────────

// Adjacent emote splitting: "KEKWKAPPA" → ["KEKW", "KAPPA"] when both are emotes.
// Only splits if every chunk resolves — otherwise falls back to text.
function splitIntoEmotes(
  word: string,
  msgEmotes: Record<string, string> | null | undefined,
  emotes: EmoteMap,
): string[] | null {
  if (msgEmotes?.[word] !== undefined || emotes[word] !== undefined) return null;
  const parts: string[] = [];
  let rem = word;
  while (rem.length > 0) {
    let found = false;
    for (let len = rem.length; len >= 1; len--) {
      const chunk = rem.slice(0, len);
      if (msgEmotes?.[chunk] !== undefined || emotes[chunk] !== undefined) {
        parts.push(chunk);
        rem = rem.slice(len);
        found = true;
        break;
      }
    }
    if (!found) return null;
  }
  return parts.length > 1 ? parts : null;
}

// Platform mid-word emote splitting: "helloKEKW" using per-message emote map only.
function splitMixed(
  word: string,
  msgEmotes: Record<string, string> | null | undefined,
): Array<{ emote: boolean; value: string }> | null {
  if (!msgEmotes) return null;
  const names = Object.keys(msgEmotes).sort((a, b) => b.length - a.length);
  if (names.length === 0) return null;
  const parts: Array<{ emote: boolean; value: string }> = [];
  let text = "";
  let rem = word;
  outer: while (rem.length > 0) {
    for (const name of names) {
      if (rem.startsWith(name)) {
        if (text) { parts.push({ emote: false, value: text }); text = ""; }
        parts.push({ emote: true, value: name });
        rem = rem.slice(name.length);
        continue outer;
      }
    }
    text += rem[0];
    rem = rem.slice(1);
  }
  if (text) parts.push({ emote: false, value: text });
  return parts.some((p) => p.emote) && parts.length > 1 ? parts : null;
}

// Render a text run with its emoji promoted to Twemoji images. Keyed by offset so
// React can reconcile the mixed list.
function renderTextRun(text: string, keyBase: string): React.ReactNode {
  const pieces = splitEmoji(text);
  if (pieces.length === 1 && !pieces[0]!.emoji) return text;
  return pieces.map((p, pi) =>
    p.emoji
      ? <Twemoji key={`${keyBase}-e${pi}`} emoji={p.value} />
      : <React.Fragment key={`${keyBase}-t${pi}`}>{p.value}</React.Fragment>
  );
}

const URL_RE = /^https?:\/\/\S+$/;
// Markdown link as a single token: [label](https://…). Bridged messages (e.g.
// Discord forwards/embeds via mautrix) arrive as Markdown in the plaintext body,
// so a link shows raw without this. Only https?: hrefs are accepted (no
// javascript: etc.). Multi-word labels reach this anchored regex as ONE token
// because splitTokens (lineTokens.ts) keeps a space-delimited markdown link
// whole — that is piece 3's tokenizer fix; the regex itself never changed.
const MD_LINK_RE = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/;
// The markdown-link phishing guard lives in ./linkGuard, because the Matrix
// HTML renderer needs the SAME check on <a> elements (a stronger spoof
// primitive than a markdown link). It is unit-tested there, which it could
// not be in this .tsx file — `node --test` only globs `*.test.ts`.

// ─── segment builder ──────────────────────────────────────────────────────────

// Split a message into segments, processing each line independently and emitting
// a hard line break between lines. Tokenizing per-line (rather than on a single
// " ".split of the whole string) is what lets a URL sitting at the start of a
// line — common in multi-line forum post bodies — linkify, and renders the
// newlines that would otherwise collapse to a single space.
function buildSegs(
  text: string,
  emotes: EmoteMap,
  msgEmotes: Record<string, string> | null | undefined,
  directory?: ChatDirectory,
): Seg[] {
  const lines = text.split("\n");
  const segs: Seg[] = [];
  lines.forEach((line, li) => {
    if (li > 0) segs.push({ t: "br" });
    buildLineSegs(line, emotes, msgEmotes, segs, directory);
  });
  return segs;
}

function buildLineSegs(
  text: string,
  emotes: EmoteMap,
  msgEmotes: Record<string, string> | null | undefined,
  segs: Seg[],
  directory?: ChatDirectory,
): void {
  // NOT `text.split(" ")` — see splitTokens. A markdown link with a
  // multi-word label has to survive tokenization as one token, or the anchored
  // MD_LINK_RE below can never match it.
  const words = splitTokens(text);

  for (let wi = 0; wi < words.length; wi++) {
    const word = words[wi];
    const leading = wi > 0;

    if (!word) {
      // Preserve double-spaces as a text segment
      const last = segs[segs.length - 1];
      if (last?.t === "text") last.text += " ";
      else segs.push({ t: "text", text: " ", leading: false });
      continue;
    }

    const mdLink = word.match(MD_LINK_RE);
    if (mdLink) {
      segs.push({ t: "link", href: mdLink[2]!, label: mdLink[1]!, leading });
      continue;
    }

    // Before the emote lookup on purpose. A person can share a name with an
    // emote, and the `@` is what says which one was meant — checking emotes
    // first would render `@KEKW` as the image whenever someone is called that.
    // Unresolvable mentions fall through to plain text: `@` is ordinary
    // punctuation in chat and colouring a stranger's name would be a lie about
    // who is present.
    if (directory && word.startsWith("@")) {
      const hit = matchMention(word);
      const person = hit ? directory.byKey.get(hit.name.toLowerCase()) : null;
      if (hit && person) {
        segs.push({ t: "mention", name: person.name, trail: hit.trail, color: person.color, leading });
        continue;
      }
    }

    const msgUrl = msgEmotes?.[word];
    const globalInfo = emotes[word];
    const url = msgUrl ?? globalInfo?.url;
    // Only global emotes carry the zero-width flag; per-message emotes are never ZW
    const isZW = !msgUrl && (globalInfo?.zeroWidth ?? false);
    // Aspect ratio only for catalog emotes; per-message URLs carry no
    // dimensions. Their still is derivable for Twitch (twitchStillUrl).
    const ar = msgUrl ? undefined : globalInfo?.ar;
    const still = msgUrl ? twitchStillUrl(msgUrl) : globalInfo?.still;
    const h = msgUrl ? undefined : globalInfo?.h;

    if (url) {
      if (isZW) {
        const last = segs[segs.length - 1];
        if (last?.t === "emote") {
          // Overlay on the previous emote — no new segment, no space consumed
          last.overlays.push({ name: word, url, ar, still, h });
          continue;
        }
      }
      segs.push({ t: "emote", name: word, url, ar, still, h, overlays: [], leading });
      continue;
    }

    const parts = splitIntoEmotes(word, msgEmotes, emotes);
    if (parts) {
      parts.forEach((p, pi) => {
        const pMsgUrl = msgEmotes?.[p];
        const pUrl = pMsgUrl ?? emotes[p]!.url;
        segs.push({
          t: "emote", name: p, url: pUrl,
          ar: pMsgUrl ? undefined : emotes[p]?.ar,
          still: pMsgUrl ? twitchStillUrl(pMsgUrl) : emotes[p]?.still,
          h: pMsgUrl ? undefined : emotes[p]?.h,
          overlays: [], leading: pi === 0 ? leading : false,
        });
      });
      continue;
    }

    const mixed = splitMixed(word, msgEmotes);
    if (mixed) {
      mixed.forEach((piece, pi) => {
        if (piece.emote) {
          segs.push({ t: "emote", name: piece.value, url: msgEmotes![piece.value] ?? "", overlays: [], leading: pi === 0 ? leading : false });
        } else {
          const last = segs[segs.length - 1];
          if (last?.t === "text" && pi > 0) {
            last.text += piece.value;
          } else {
            segs.push({ t: "text", text: piece.value, leading: pi === 0 ? leading : false });
          }
        }
      });
      continue;
    }

    if (URL_RE.test(word)) {
      segs.push({ t: "url", href: word, leading });
      continue;
    }

    const last = segs[segs.length - 1];
    if (last?.t === "text") {
      last.text += " " + word;
    } else {
      segs.push({ t: "text", text: word, leading });
    }
  }
}

// ─── renderer ─────────────────────────────────────────────────────────────────

/**
 * Copy the full href of a link whose display text has been shortened.
 *
 * Rendered ONLY when `elideUrl` actually hid something. A copy button beside a
 * link you can already read in full is noise, and noise on every link is how an
 * affordance stops being noticed.
 *
 * `stopPropagation` because a chat row is itself clickable (selection / context
 * menu) — without it, copying a link would also select the message.
 */
function CopyLinkButton({ href }: { href: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      title={`Copy full link: ${href}`}
      aria-label="Copy full link"
      className="text-muted hover:text-body align-baseline"
      style={{ fontSize: "0.85em", marginLeft: "0.15em" }}
      // The click handler's preventDefault below does nothing for focus —
      // focus moved on mousedown, long before click. This is the one that
      // keeps the keyboard.
      onMouseDown={keepFocus}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        void copyText(href).then((ok) => {
          if (!ok) return;
          setCopied(true);
          // Long enough to read, short enough that the row settles back before
          // anyone scrolls past it.
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}


// A stable snapshot getter for useClientValue: true on every client render
// that is not the hydration render (React uses the server value there).
const isHydrated = () => true;

// An emote <img> that, on load failure, first steps DOWN a size rung (the tier
// rightSizeEmoteUrl picked may not be rendered for this emote and 404s — the
// next-lower rung usually exists) and only then degrades to its code as plain text
// — a visible name beats an invisible gap (Chatterino renders the code while an
// emote is unavailable). Overlays instead vanish on failure (`fallback:"hide"`):
// text inside the positioned wrapper would break the base emote's layout.
function EmoteImg({
  src, name, style, fallback, h,
}: { src: string; name: string; style: React.CSSProperties; fallback: "text" | "hide"; h?: number }) {
  const [failed, setFailed] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [showTint, setShowTint] = React.useState(false);
  // A no-aspect-ratio emote (per-message / BTTV) collapses to zero width until it
  // loads, so an emote-only message would read as EMPTY — reserve a min-width for
  // those. Catalog emotes already reserve their exact width via `aspect-ratio`.
  const reserved = style.aspectRatio != null;
  const needsReserve = !loaded && !reserved;
  // Only PAINT the loading tint once the image is still unloaded after a beat. A
  // warmed emote is a ~2ms cache hit — its onLoad fires long before this, so it
  // never flashes a grey box "for no reason" (the thing that read as slowness even
  // when it wasn't). The tint appears only for a genuinely slow cold fetch, where
  // it's actually informative. setTimeout keeps this async (no set-state-in-render).
  React.useEffect(() => {
    if (!needsReserve) return;
    const t = setTimeout(() => setShowTint(true), 200);
    return () => clearTimeout(t);
  }, [needsReserve]);
  // Right-size to the display: the SMALLEST rung whose native height covers
  // the drawn device pixels, from this emote's own 1x height — never below it, so
  // never blurry, and no bigger, so no wasted bytes. (Warmer + picker request this
  // same URL.)
  //
  // Not before hydration, though: a row can arrive in the server's HTML (the seeded
  // history, chatSeed.ts), and the server cannot see the display. It renders the 2x
  // baseline, and so must the client's hydration render, or every seeded emote is an
  // attribute mismatch React keeps the server side of. Such a row then KEEPS that
  // baseline when it already covers the display — on a DPR1 screen a smaller copy
  // would be a second download of an emote already painted. A row mounted after
  // hydration (every live message) sizes on its first render.
  //
  // `sizing` re-renders the emote when the drawn device pixels change (browser zoom,
  // the emote-size / chat-font settings) — with no 2x floor to hide it, a row sized
  // for the old value would otherwise stay soft until it scrolled away.
  const hydrated = useClientValue(isHydrated, false);
  const [bornHydrated] = React.useState(hydrated);
  const sizing = React.useSyncExternalStore(subscribeEmoteSizing, emoteSizingVersion, () => 0);
  const sizedSrc = React.useMemo(
    () => (hydrated ? rightSizeEmoteUrl(src, h, bornHydrated ? undefined : baselineEmoteUrl(src)) : baselineEmoteUrl(src)),
    // `sizing` is the re-size trigger — rightSizeEmoteUrl reads the live display.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sizing is a version counter whose only job is to invalidate this memo
    [hydrated, bornHydrated, src, h, sizing],
  );
  if (failed) return fallback === "text" ? <span title={name}>{name}</span> : null;
  // color:transparent hides the alt text the browser paints inside the reserved
  // box while the image bytes download (the "name flashes before the emote"
  // effect) — alt/title stay intact for a11y and copy-paste, and real failures
  // still surface via the visible onError fallback above.
  const pending = needsReserve
    ? {
        minWidth: "var(--chat-emote-size, 1.4em)",
        ...(showTint ? { background: "rgba(128,128,128,0.14)", borderRadius: "3px" } : {}),
      }
    : null;
  return (
    <img
      src={sizedSrc}
      crossOrigin={emoteCrossOrigin(sizedSrc)}
      alt={name}
      title={name}
      // decoding:async keeps the image decode off the render path (matters during
      // chat bursts, where synchronous decode of many WebPs would jank paint);
      // fetchPriority:high lets a visible in-chat emote jump the browser's request
      // queue ahead of background loads (avatars, badges, prefetches).
      decoding="async"
      fetchPriority="high"
      style={{ ...style, color: "transparent", ...pending }}
      onLoad={() => setLoaded(true)}
      onError={(e) => {
        const lower = stepDownEmoteUrl(e.currentTarget.src);
        if (lower) e.currentTarget.src = lower; // retry a smaller rung in place
        else setFailed(true);                   // out of rungs → name text
      }}
    />
  );
}

export function renderText(
  text: string,
  emotes: EmoteMap,
  msgEmotes?: Record<string, string> | null,
  /** Chat directory — omit and @mentions render as plain text, which is what
   *  every non-chat surface (forum, Matrix HTML, pins) wants. */
  directory?: ChatDirectory,
  /** `still: true` swaps every emote (and overlay) to its still-frame URL when
   *  one exists (EmoteInfo.still) — the "animated emotes off" setting. Optional
   *  and additive: every existing caller (forum, Matrix, pins) omits it and
   *  keeps rendering the animated URL exactly as before.
   *  `mask: true` (Behavior › Hide swear words) stars out swear words in the
   *  PLAIN text pieces only — never inside an emote, link or @mention. */
  opts?: { still?: boolean; mask?: boolean },
): React.ReactNode[] {
  return buildSegs(text, emotes, msgEmotes, directory).map((seg, i) => {
    if (seg.t === "mention") {
      return (
        <React.Fragment key={i}>
          {seg.leading && " "}
          {/* Their colour, everyone's view. The "you were tagged" signal is the
              ROW highlight, which is derived client-side and therefore only ever
              visible to the person tagged. */}
          <span className="chat-mention" style={{ color: seg.color }}>@{seg.name}</span>
          {seg.trail}
        </React.Fragment>
      );
    }
    if (seg.t === "emote") {
      // Zero-height inline-block wrapper keeps line height constant regardless
      // of emote size. The img overflows via overflow:visible and is centered
      // with translateY(-50%). --chat-emote-overlap controls horizontal spacing.
      const emoteStyle: React.CSSProperties = {
        display: "inline-block",
        height: 0,
        overflow: "visible",
        verticalAlign: "middle",
        margin: "0 var(--chat-emote-overlap, 2px)",
      };
      // translateY(-50%) centers the emote on the wrapper's vertical-align:middle
      // reference, which is the baseline + half the x-height — LOWER than the text's
      // optical (cap-height) center, so tall emotes read "bottom-heavy" against the
      // line. The extra --chat-emote-rise nudge lifts them onto the optical center.
      // em resolves against the emote's own inherited font size, so it scales with
      // the chat font. Tunable (and can become a user setting); ~0.08em is the
      // cap-vs-x midline gap for typical fonts — live-tune on a phone if needed.
      const imgStyle: React.CSSProperties = {
        height: "var(--chat-emote-size, 1.4em)",
        width: "auto",
        display: "block",
        transform: "translateY(calc(-50% - var(--chat-emote-rise, 0.08em)))",
      };
      // When the emote's intrinsic ratio is known, set `aspect-ratio` so the
      // browser computes its width (= height × ar) and reserves that space
      // BEFORE the image loads — the chat row no longer jumps as emotes arrive
      // (the dominant CLS source). Exact ratio, so no visual change on load.
      const baseImgStyle: React.CSSProperties = seg.ar ? { ...imgStyle, aspectRatio: String(seg.ar) } : imgStyle;
      return (
        <React.Fragment key={i}>
          {seg.leading && " "}
          {seg.overlays.length > 0 ? (
            // Layered (zero-width) stack — Chatterino's model: every layer keeps
            // its OWN natural size (height-driven, aspect preserved), the
            // composite box is as wide as the WIDEST layer, and narrower layers
            // are centered in it. inline-grid with all layers in the same cell
            // gives exactly that: the column track sizes to the widest img (so
            // a wide zero-width emote widens the unit's footprint in the text
            // instead of being clipped or squeezed), justifyItems centers the
            // rest. maxWidth:none is load-bearing — Tailwind preflight puts
            // max-width:100% on every <img>, which silently shrank any overlay
            // wider than the base emote. Each layer keeps the shared
            // translateY(-50%) vertical-centering trick (grid items sit at the
            // 0-height wrapper's top, i.e. the text middle).
            <span className="chat-emote-el" style={{ ...emoteStyle, display: "inline-grid", justifyItems: "center", alignItems: "start" }}>
              <EmoteImg
                src={opts?.still && seg.still ? seg.still : seg.url}
                h={seg.h}
                name={seg.name}
                style={{ ...baseImgStyle, gridArea: "1 / 1", maxWidth: "none" }}
                fallback="text"
              />
              {seg.overlays.map((ov, j) => (
                <EmoteImg
                  key={j}
                  src={opts?.still && ov.still ? ov.still : ov.url}
                  h={ov.h}
                  name={ov.name}
                  fallback="hide"
                  style={{ ...imgStyle, ...(ov.ar ? { aspectRatio: String(ov.ar) } : {}), gridArea: "1 / 1", maxWidth: "none" }}
                />
              ))}
            </span>
          ) : (
            // `chat-emote-el` is not cosmetic — globals.css lifts it above the
            // redacted cipher, whose opaque block glyphs would otherwise paint
            // over an emote that had spilled out of its own line box. Both
            // emote branches need it; only one having it means layered emotes
            // stay occluded and nothing looks obviously wrong.
            <span className="chat-emote-el" style={emoteStyle}>
              <EmoteImg src={opts?.still && seg.still ? seg.still : seg.url} h={seg.h} name={seg.name} style={baseImgStyle} fallback="text" />
            </span>
          )}
        </React.Fragment>
      );
    }

    if (seg.t === "br") {
      return <br key={i} />;
    }

    if (seg.t === "url") {
      // A bare URL rendering its ENTIRE href would let a 200-character tracking
      // link shred across several lines and bury the conversation. The
      // shortening rules live in ./elideUrl and are security rules, not style
      // ones — the host is never cut, and only the TAIL is dropped.
      // Strip on DISPLAY, keep the stored link as typed. The database keeps
      // `seg.href` verbatim — rewriting what somebody wrote is unrecoverable —
      // while everything the reader touches uses the stripped one. ONE variable
      // feeds display, href and copy, so they cannot drift: stripping only the
      // visible text while the href kept its params would be theatre (the click
      // still phones home) and the copy button would hand over a different
      // link than the reader followed.
      const { clean: cleanHref } = stripTracking(seg.href);
      const { display, elided } = elideUrl(cleanHref);
      return (
        <React.Fragment key={i}>
          {seg.leading && " "}
          <a
            href={cleanHref}
            target="_blank"
            rel="noopener noreferrer"
            // The full (stripped) href is always one hover away — nothing is
            // lost, only moved out of the way.
            title={cleanHref}
            className="text-blue-400 hover:underline break-all"
            onClick={(e) => e.stopPropagation()}
          >
            {display}
          </a>
          {/* Only when text is actually hidden. Offering "copy the full link"
              beside a link that is already fully visible is noise, and the
              flag is what keeps the two in step. */}
          {elided && <CopyLinkButton href={cleanHref} />}
        </React.Fragment>
      );
    }

    if (seg.t === "link") {
      // Strip FIRST, then check. The phishing guard must analyse the label as the
      // reader SEES it — a bidi control inside the label could otherwise break up
      // the domain match and walk straight past the check it is meant to trip.
      // Same rule as the bare-URL branch: the stored text keeps its params, the
      // rendered link does not. The host is unchanged by stripping, so the
      // phishing guard and the destination chip are unaffected either way — but
      // they are fed the same string the reader clicks, so nothing can diverge.
      const { clean: cleanHref } = stripTracking(seg.href);
      const label = stripBidiControls(seg.label);
      const realHost = deceptiveLinkHost(label, cleanHref);
      // Only when the label is NOT deceptive — otherwise a link would carry
      // both a warning and a neutral chip saying the same host, and the neutral
      // one would soften the warning.
      const destHost = realHost ? null : linkDestinationHost(label, cleanHref);
      return (
        <React.Fragment key={i}>
          {seg.leading && " "}
          <a
            href={cleanHref}
            target="_blank"
            rel="noopener noreferrer"
            title={cleanHref}
            className="text-blue-400 hover:underline break-all"
            onClick={(e) => e.stopPropagation()}
          >
            {opts?.mask ? maskProfanity(label) : label}
          </a>
          {realHost && (
            <span
              className="text-amber-400/90 break-all"
              style={{ fontSize: "0.85em" }}
              title={`This link actually goes to ${cleanHref}`}
            >
              {" "}
              (↗ {realHost})
            </span>
          )}
          {/* Destination chip. Multi-word labels ("click here for the thing")
              make no domain claim at all, so the phishing guard's deception test
              passes and the reader still cannot see where the link goes. Muted,
              not amber: this is information, not an alarm, and an alarm on
              every link is one nobody reads. */}
          {/* cleanHref, like every other surface in both branches — the chip's
              hover must show the same URL the click follows, not the tracking
              params the display just stripped. */}
          {destHost && (
            <span
              className="text-muted break-all"
              style={{ fontSize: "0.85em" }}
              title={cleanHref}
            >
              {" "}
              ({destHost})
            </span>
          )}
        </React.Fragment>
      );
    }

    return (
      <React.Fragment key={i}>
        {seg.leading && " "}
        {renderTextRun(opts?.mask ? maskProfanity(seg.text) : seg.text, String(i))}
      </React.Fragment>
    );
  });
}
