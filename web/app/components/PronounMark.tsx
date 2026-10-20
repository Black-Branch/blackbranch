import type { ReactNode } from "react";

// The pronoun symbol after a name in chat, small and raised in its upper-right
// corner like the Fund-the-Night clock (SponsorClockBadge — same lift, gap and
// shadow): ♂ he/him · ♀ she/her · ⚲ they/them, drawn as SVG rather than font glyphs — ⚲ is missing from common
// Android fonts, and a tofu box beside a name reads as a defect. The words ride
// `title` (hover) and `aria-label` (screen readers); a phone tap on the name opens
// the card, which says them. Hidden per reader by the "Pronouns" chat setting
// (`.chat-pron-off` on the root, globals.css).
// Soft blue · soft pink · light grey (not purple, which reads too close to the
// pink) — light enough to sit beside any name colour without competing with it.
const COLOUR: Record<string, string> = { "he/him": "#8ab8f0", "she/her": "#f0a8c8", "they/them": "#d4d8e0" };
const RING = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const GLYPHS: Record<string, ReactNode> = {
  "he/him": (
    <g {...RING}>
      <circle cx="6.5" cy="9.5" r="4" />
      <path d="M9.3 6.7 14 2M10.2 2H14v3.8" />
    </g>
  ),
  "she/her": (
    <g {...RING}>
      <circle cx="8" cy="6" r="4" />
      <path d="M8 10v5.2M5.4 12.8h5.2" />
    </g>
  ),
  "they/them": (
    <g {...RING}>
      <circle cx="8" cy="6" r="4" />
      <path d="M8 10v5.2" />
    </g>
  ),
};

export function PronounMark({ pronouns }: { pronouns?: string | null }) {
  const glyph = pronouns ? GLYPHS[pronouns] : undefined;
  if (!glyph) return null;
  return (
    <span
      className="chat-pron"
      role="img"
      title={pronouns!}
      aria-label={pronouns!}
      style={{
        display: "inline-block",
        color: COLOUR[pronouns!],
        verticalAlign: "0.45em",
        marginLeft: "0.12em",
        lineHeight: 0,
        filter: "drop-shadow(0 1px 1px rgba(0,0,0,0.55))",
      }}
    >
      <svg viewBox="0 0 16 16" width="0.6em" height="0.6em" aria-hidden="true">{glyph}</svg>
    </span>
  );
}
