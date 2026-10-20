"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Fragment } from "react";
import type React from "react";
import { getJson, HttpError } from "@/app/lib/http";
import {
  splitRedacted, redactSegments, redactFiller, revealRefusal, REDACT_REVEAL_MS, REDACT_ANIMATE_MS, type RedactRun,
} from "@/app/lib/redactedMessage";
import { renderText } from "@/app/lib/renderText";
import { maskProfanity } from "@/app/lib/profanity";
import type { ChatDirectory } from "@/app/lib/chatDirectory";
import type { EmoteMap } from "@/app/lib/useEmotes";
import { keepFocus } from "@/app/lib/keepFocus";

// A Supporter redacted message, in the chat row.
//
// The stored message arrives with its hidden parts already replaced by
// placeholder glyphs — this component never has the hidden words
// until someone asks for them, and asking is an authenticated fetch per
// message. So the redaction the reader sees and the access control are the same
// mechanism, rather than a visual effect over text that was already on the wire.
//
// Only PART of a message may be hidden (`the ending is ||he was dead|| lol`).
// The visible parts render like any other message; each hidden part is a run
// of bars that opens on its OWN tap, with its own reveal walk and its own
// re-seal timer.
//
// Deliberately NOT auto-opening on arrival. A backlog of 50 restored messages
// would fire 50 authenticated fetches on load, and a reveal nobody was looking
// at would burn its seconds unseen.
//
// Re-opening REFETCHES even though an opened part keeps its words under the
// closed bar (that is only so the width holds still). It costs one request per
// reveal (per PART — each tap is its own reveal), and in exchange "entitled at
// the moment you read it" stays literally true instead of being true only the
// first time: a refused refetch drops the held words.

/**
 * What sits under a bar while it is closed. NOT the stored glyphs: the bar is
 * transparent text over a background, so any character works, and a letter in
 * the chat's own font is the closest stand-in for the width of real words. Each
 * stored glyph names its letter's rough shape, so the filler is a letter of
 * that shape (redactFiller) and a sealed word is already near its real width.
 * Deterministic on purpose — random glyphs would be a hydration mismatch
 * (React #418), because the server render and the client render would draw
 * different ones.
 */
const fill = (text: string) => [...text].map(redactFiller).join("");

type Props = {
  /** The stored message: visible text plus placeholder glyphs. */
  text: string;
  /** site.chat_messages id. */
  messageId: number;
  /** Global emote manifest — visible and opened text go through renderText. */
  emotes: EmoteMap;
  /** This message's own platform emotes, if any. */
  msgEmotes?: Record<string, string> | null;
  /** @mention directory, as for any other message. */
  directory?: ChatDirectory;
  /** "Animated emotes" off (chatStyle_animEmotes), threaded from ChatMessage's
   *  stillEmotes prop — a redacted row's visible AND revealed text go through
   *  renderText like any other message, so this must reach every call the same
   *  way `emotes`/`msgEmotes`/`directory` do. */
  stillEmotes?: boolean;
  /** Behavior › Hide swear words — the visible AND the opened text. Masking keeps
   *  the length, so the character-by-character reveal stays aligned. */
  mask?: boolean;
};

type Phase = "sealed" | "loading" | "revealing" | "open" | "resealing" | "denied";

export function RedactedText({ text, messageId, emotes, msgEmotes, directory, stillEmotes, mask }: Props) {
  const runs = useMemo(() => splitRedacted(text), [text]);
  const textLen = useMemo(() => [...text].length, [text]);
  return (
    <span className="inline">
      {runs.map((r, i) => r.hidden
        ? <HiddenRun key={i} run={r} textLen={textLen} messageId={messageId}
            emotes={emotes} msgEmotes={msgEmotes} directory={directory} stillEmotes={stillEmotes} mask={mask} />
        : <span key={i}>{renderText(r.text, emotes, msgEmotes, directory, { still: stillEmotes, mask })}</span>)}
    </span>
  );
}

// NO in-component reset for "the message changed". The call site passes
// `key={msg.id}`, so React remounts rather than reuses — a revealed plaintext
// can never survive onto a different message. Do not remove that key.

type Token = { t: string; o: number; n: number; space: boolean };

/** A hidden run's words and gaps, with code-point offsets into the run. */
function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let o = 0;
  for (const t of text.split(/(\s+)/)) {
    if (!t) continue;
    const n = [...t].length;
    out.push({ t, o, n, space: /^\s+$/.test(t) });
    o += n;
  }
  return out;
}

/**
 * One `||hidden part||`: its own bars, its own fetch, its own timers.
 *
 * NOTHING MOVES WHEN IT OPENS. Each word is its own span with its own bar. At
 * the tap, before the plaintext arrives, every word's SEALED width is
 * measured; once the real words are in, each is spaced (letter-spacing) to
 * fill exactly that width — an emote word, which spacing cannot stretch, is
 * held at it as an inline-block. The words then stay under the closed bar
 * after the re-seal, so the width is the sealed width at every step. The
 * shape filler keeps the spacing change too small to notice.
 */
function HiddenRun({ run, textLen, messageId, emotes, msgEmotes, directory, stillEmotes, mask }: {
  run: RedactRun; textLen: number; messageId: number;
  emotes: EmoteMap; msgEmotes?: Record<string, string> | null; directory?: ChatDirectory;
  stillEmotes?: boolean;
  mask?: boolean;
}) {
  const len = useMemo(() => [...run.text].length, [run.text]);
  const tokens = useMemo(() => tokenize(run.text), [run.text]);
  const [phase, setPhase] = useState<Phase>("sealed");
  // How many of THIS part's characters are uncovered. Sealed = 0; the reveal
  // walks it up, the re-seal walks it back down.
  const [shownUpTo, setShownUpTo] = useState(0);
  // This part's plaintext, once this viewer has opened it. It is KEPT under
  // the closed bar after the re-seal, so the width holds still. Only a viewer
  // who was entitled and tapped ever holds it; everyone else still has only
  // the filler. Re-opening still refetches — see the note at the top.
  // `aligned` = the slice lines up with the stored text, word for word.
  const [plain, setPlain] = useState<{ text: string; aligned: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Every timer this part starts, so unmounting mid-reveal (chat scrolls fast;
  // rows are recycled constantly) cannot setState on a dead component.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const raf = useRef(0);
  const box = useRef<HTMLSpanElement>(null);
  // Each word's width while sealed, by token index — measured at the first tap.
  const sealedW = useRef<Map<number, number> | null>(null);

  const stopAll = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = 0;
  }, []);

  useEffect(() => stopAll, [stopAll]);

  /**
   * Uncover (or re-cover) this part one character at a time: left→right on
   * reveal (reading order), right→left on re-seal, so closing reads as closing
   * rather than as a second, identical reveal.
   */
  const walk = useCallback((
    { closing, next }: { closing: boolean; next: Phase },
    after?: () => void,
  ) => {
    const start = performance.now();
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / REDACT_ANIMATE_MS);
      const moved = Math.floor(t * len);
      setShownUpTo(closing ? len - moved : moved);
      if (t < 1) { raf.current = requestAnimationFrame(frame); return; }
      raf.current = 0;
      setPhase(next);
      after?.();
    };
    raf.current = requestAnimationFrame(frame);
  }, [len]);

  const reveal = useCallback(async () => {
    if (phase !== "sealed" && phase !== "denied") return;
    stopAll();
    // Measure the sealed words NOW, while they are still filler.
    if (!sealedW.current && box.current) {
      const m = new Map<number, number>();
      box.current.querySelectorAll<HTMLElement>("[data-w]").forEach((el) => {
        m.set(Number(el.dataset.w), el.getBoundingClientRect().width);
      });
      sealedW.current = m;
    }
    setPhase("loading");
    setError(null);
    try {
      const d = await getJson<{ text?: string }>(`/api/chat/decrypt/${messageId}`);
      if (typeof d?.text !== "string") throw new Error("no text");
      // The plaintext lines up with the stored text code point for code point
      // (parseRedaction guarantees it), so this part is a slice of it. A row
      // that somehow does not line up shows the whole plaintext here rather
      // than a slice cut at the wrong places.
      const cps = [...d.text];
      setPlain(cps.length === textLen
        ? { text: cps.slice(run.start, run.start + len).join(""), aligned: true }
        : { text: d.text, aligned: false });
      setPhase("revealing");
      walk({ closing: false, next: "open" }, () => {
        // …and it re-seals. Readable for a while, not forever — the point of
        // the whole thing. Animated closed the same way it opened.
        timers.current.push(
          setTimeout(() => {
            setPhase("resealing");
            walk({ closing: true, next: "sealed" });
          }, REDACT_REVEAL_MS)
        );
      });
    } catch (e) {
      // Branch on the STATUS, not on the message text (revealRefusal — the words are shared
      // with the terminal's chat TUI).
      const status = e instanceof HttpError ? e.status : 0;
      setPlain(null);
      setError(revealRefusal(status));
      setPhase("denied");
      timers.current.push(setTimeout(() => { setError(null); setPhase("sealed"); }, 4000));
    }
  }, [phase, messageId, walk, stopAll, textLen, run.start, len]);

  const open = phase === "open" || phase === "revealing" || phase === "resealing";
  const busy = phase === "loading";
  // Rich only when fully OPEN. During the walk a word stays a plain character
  // string — an emote is a single image and cannot be uncovered one glyph at a
  // time.
  const rich = phase === "open" && plain !== null;
  const words = useMemo(() => (plain?.aligned ? [...plain.text] : null), [plain]);

  // Fit each opened word to its sealed width. Runs when the words arrive and
  // when they switch between plain characters and the rich render (emotes),
  // never per animation frame. Styles are set on the word spans directly;
  // React does not own their `style`, so a re-render leaves them alone.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const spans = el.querySelectorAll<HTMLElement>("[data-w]");
    const clear = (w: HTMLElement) => {
      w.style.letterSpacing = ""; w.style.display = ""; w.style.width = "";
      w.style.textAlign = ""; w.style.textIndent = "";
    };
    if (!words || !sealedW.current) { spans.forEach(clear); return; }
    spans.forEach((w) => {
      const k = Number(w.dataset.w);
      const target = sealedW.current!.get(k);
      clear(w);
      if (target === undefined) return;
      if (w.querySelector("img")) {
        w.style.display = "inline-block";
        w.style.width = `${target}px`;
        w.style.textAlign = "center";
        w.style.textIndent = "0";
        return;
      }
      const natural = w.getBoundingClientRect().width;
      const n = tokens[k]?.n ?? 1;
      w.style.letterSpacing = `${(target - natural) / n}px`;
    });
  // `rich` flips the content between the character walk and the rendered emotes.
  }, [words, rich, tokens]);

  let content: React.ReactNode;
  if (plain && !plain.aligned) {
    content = open
      ? renderText(plain.text, emotes, msgEmotes, directory, { still: stillEmotes, mask })
      : redactSegments(fill(run.text), 0).map((seg, j) =>
          seg.bar ? <span key={j} className="redact-bar">{seg.text}</span> : seg.text);
  } else {
    content = tokens.map((tk, k) => {
      if (tk.space) return <Fragment key={k}>{tk.t}</Fragment>;
      const word = words ? words.slice(tk.o, tk.o + tk.n).join("") : null;
      const local = Math.max(0, Math.min(tk.n, shownUpTo - tk.o));
      return (
        <span key={k} data-w={k}>
          {rich && word !== null
            ? renderText(word, emotes, msgEmotes, directory, { still: stillEmotes, mask })
            : redactSegments(word ?? fill(tk.t), word === null ? 0 : local).map((seg, j) =>
                seg.bar ? <span key={j} className="redact-bar">{seg.text}</span> : seg.text)}
        </span>
      );
    });
  }

  // A <span role="button">, NEVER a <button>: a button is an atomic
  // inline-block, so it cannot start partway along a line — it drops whole to
  // the next one and changes the row's line count.
  // Interactive ONLY while sealed; every part is its own control, so every part
  // takes focus.
  const interactive: React.HTMLAttributes<HTMLSpanElement> = open ? {} : {
    role: "button",
    tabIndex: 0,
    onClick: reveal,
    // Opening is a read, not a departure — nothing here wants focus.
    onMouseDown: keepFocus,
    // role="button" does not bring Enter/Space activation with it.
    onKeyDown: (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); reveal(); }
    },
    title: busy ? "Opening…" : "Redacted — tap to read",
    "aria-label": "Redacted text. Activate to read.",
    "aria-busy": busy,
  };

  return (
    <>
      <span
        ref={box}
        className={`redact-text ${open ? "" : "select-none cursor-pointer"}`}
        data-sealed={open ? "false" : "true"}
        {...interactive}
      >
        {content}
      </span>
      {error && <span className="ml-1.5 text-chat-xs text-muted">{error}</span>}
    </>
  );
}

/**
 * A redacted message quoted somewhere small — the "↩ name: …" line above a
 * reply, and the composer's reply bar. The quote carries the stored text, so a
 * hidden part is still placeholder glyphs; this draws them as closed bars
 * instead of the old block characters. Never opens: a quote is a pointer.
 */
export function RedactedQuote({ text, mask = false }: { text: string; mask?: boolean }) {
  return (
    <>
      {splitRedacted(text).map((r, i) =>
        r.hidden
          ? <span key={i} aria-label="redacted">{redactSegments(fill(r.text), 0).map((seg, j) =>
              seg.bar ? <span key={j} className="redact-bar">{seg.text}</span> : seg.text)}</span>
          : mask ? maskProfanity(r.text) : r.text)}
    </>
  );
}

/** The same quote as plain words, for an aria-label or a title. */
export function redactedQuoteLabel(text: string): string {
  return splitRedacted(text).map((r) => (r.hidden ? "[redacted]" : r.text)).join("");
}
