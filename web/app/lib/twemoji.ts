import React, { useState } from "react";

// Render unicode emoji as Twemoji images (like Discord / Element-web) so they
// look identical across every OS instead of falling back to a missing system
// glyph (a "box" on machines without a colour-emoji font, e.g. bare Arch).

const TWEMOJI_BASE = "https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72";

// Emoji string → Twemoji codepoint filename. Mirrors twemoji's own logic: build
// the codepoint sequence, then drop the FE0F variation selector unless this is a
// keycap (…20E3) sequence.
function twemojiCodepoints(emoji: string): string {
  const out: string[] = [];
  let high = 0;
  for (let i = 0; i < emoji.length; i++) {
    const c = emoji.charCodeAt(i);
    if (high) {
      out.push((0x10000 + ((high - 0xd800) << 10) + (c - 0xdc00)).toString(16));
      high = 0;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      high = c;
    } else {
      out.push(c.toString(16));
    }
  }
  const isKeycap = out.includes("20e3");
  return out.filter((c) => isKeycap || c !== "fe0f").join("-");
}

function twemojiUrl(emoji: string): string {
  return `${TWEMOJI_BASE}/${twemojiCodepoints(emoji)}.png`;
}

// <Twemoji> — renders the emoji as a Twemoji <img>, falling back to the raw
// unicode text if the image fails (unknown key, CDN blocked, custom shortcode).
export function Twemoji({ emoji, size }: { emoji: string; size?: string }) {
  const [failed, setFailed] = useState(false);
  const dim = size ?? "1.2em";
  if (failed) return React.createElement("span", null, emoji);
  return React.createElement("img", {
    src: twemojiUrl(emoji),
    alt: emoji,
    draggable: false,
    onError: () => setFailed(true),
    style: { width: dim, height: dim, verticalAlign: "-0.2em", display: "inline-block" },
  });
}
