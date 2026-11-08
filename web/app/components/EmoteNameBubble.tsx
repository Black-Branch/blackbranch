"use client";

import { useEffect, useState } from "react";

const SHOW_MS = 2000;
/** Longer than this is a long press, which opens the message sheet instead. */
const TAP_MAX_MS = 500;

type Shown = { name: string; x: number; y: number };

/**
 * A phone has no hover, so an emote's `title` never shows (tickets #159/#173). A TAP on an
 * emote image (`img[data-emote-name]`, from renderText and MatrixHtml) shows its name above it
 * for two seconds; a mouse click shows nothing new, because a desktop already has the title.
 * One listener on the document, mounted once by the root layout.
 *
 * Left alone: an emote in a hidden spoiler (`.invisible`) — the name would give it away — and
 * one inside a link or button, whose tap belongs to that control.
 */
export default function EmoteNameBubble() {
  const [shown, setShown] = useState<Shown | null>(null);

  useEffect(() => {
    let downType = "";
    let downAt = 0;
    let target: Element | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const place = (img: Element) => {
      const r = img.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top };
    };
    const onDown = (e: PointerEvent) => { downType = e.pointerType; downAt = Date.now(); };
    const onClick = (e: MouseEvent) => {
      if (downType !== "touch" || Date.now() - downAt > TAP_MAX_MS) return;
      const img = (e.target as Element | null)?.closest?.("img[data-emote-name]");
      if (!img || img.closest("a, button, [role='button'], .invisible")) return;
      // A stacked emote (a zero-width layer over a base) names every layer, base first.
      const stack = img.closest(".chat-emote-el");
      const layers = stack ? [...stack.querySelectorAll("img[data-emote-name]")] : [img];
      const name = layers.map((l) => l.getAttribute("data-emote-name")).filter(Boolean).join(" + ");
      if (!name) return;
      target = img;
      clearTimeout(timer);
      setShown({ name, ...place(img) });
      timer = setTimeout(() => { target = null; setShown(null); }, SHOW_MS);
    };
    // The chat scrolls under it (new lines arrive): follow the emote, never hide early.
    const onScroll = () => {
      const img = target;
      if (!img) return;
      if (!img.isConnected) { target = null; clearTimeout(timer); setShown(null); return; }
      setShown((s) => (s ? { ...s, ...place(img) } : s));
    };

    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("click", onClick);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("click", onClick);
      window.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, []);

  if (!shown) return null;
  return (
    // aria-hidden: the image's alt already names it for a screen reader.
    <div
      data-emote-name-bubble
      aria-hidden="true"
      className="fixed z-50 pointer-events-none -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-edge-strong bg-panel px-2 py-1 text-sm font-medium text-strong shadow-lg"
      style={{ left: shown.x, top: shown.y - 6 }}
    >
      {shown.name}
    </div>
  );
}
