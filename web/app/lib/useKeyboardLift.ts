"use client";

// The one lift primitive: a keyboard-hosting panel rises by the committed
// inset K instead of the shell shrinking under it. One element, one inline
// transform — the same discipline as the shell's own direct `height` write,
// and for the same measured reason: a custom property on :root invalidates
// the whole document per write (~40ms/frame), a style write on one element is
// free. K is discrete (one value per keyboard open), so a permanent transform
// transition on the element can never chase jitter — the jitter never
// reaches K.
//
// `enabled` exists for hosts that are sometimes inside an already-lifted panel:
// MatrixView's UnifiedLayout lifts only as the /community page (`pageChrome`);
// embedded in the stream chat panel it MUST not double-lift.
//
// Longhands, not the `transition` shorthand — the stream chat panel carries
// conditional Tailwind transition utilities on desktop (`snapping`), and a
// shorthand would clobber their delay/extra properties if both ever co-exist.
// They never do at runtime (K > 0 only on touch-primary devices, snapping is
// desktop-only), but longhands make that a non-event rather than a trap.
//
// Styles are written ONLY while lifting and cleared symmetrically, so on
// desktop this hook never touches the element at all.
//
// It publishes K as well as applying it: `--kb-lift` is a registered <length>
// that INHERITS, so any overlay inside the lifted subtree can do its own
// geometry in CSS — see chrome.css `.chrome-window-layer`, whose ceiling is a
// calc() over this and two other chrome tokens rather than a JS measurement
// that goes stale the moment a bar animates. Written on THIS element, never
// on :root (a :root custom-property write invalidates the whole document,
// ~40ms/frame; a subtree write is free) and once per discrete K commit, the
// same cadence as the transform beside it.
//
// And it ANNOUNCES each write: KB_LIFT_EVENT is dispatched on the element,
// bubbling, immediately before and after the style writes (`detail.phase`).
// A descendant whose layout follows `--kb-lift` — a panel window in the pane's
// layer — can read its own box on both sides of the change in one task and
// turn the one-frame jump into a compositor translate (PanelWindow's
// lift-follow, Window.tsx). No write, no event: a disabled or never-lifted
// host announces nothing, exactly as it writes nothing.
import { useEffect, useRef, type RefObject } from "react";
import { useKeyboardInset } from "./useKeyboardOpenDetection";
import { KB_LIFT_EVENT, type KbLiftDetail } from "./useViewportHeightVar";

export function useKeyboardLift(ref: RefObject<HTMLElement | null>, enabled = true): void {
  const k = useKeyboardInset();
  const applied = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = enabled && k > 0 ? k : 0;
    // Nothing applied and nothing to apply: no write, and so no announcement
    // either — desktop never sees a style OR an event from this hook.
    if (next === 0 && !applied.current) return;
    const announce = (phase: KbLiftDetail["phase"]) =>
      el.dispatchEvent(new CustomEvent<KbLiftDetail>(KB_LIFT_EVENT, { bubbles: true, detail: { phase, k: next } }));
    announce("before");
    if (next > 0) {
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      el.style.transitionProperty = "transform";
      el.style.transitionDuration = reduced ? "0s" : "var(--anim-default)";
      el.style.transitionTimingFunction = "var(--anim-ease)";
      el.style.transform = `translateY(-${next}px)`;
      el.style.setProperty("--kb-lift", `${next}px`);
      applied.current = true;
    } else {
      // Clear the transform but keep the transition for one more change so the
      // drop animates; the properties are inert once transform is empty.
      // The longhands are NEVER cleared after the first lift — they are
      // harmless residue while transform stays empty, but anyone later adding
      // a DIFFERENT transform/transition to this element on mobile inherits
      // them and must account for that (they will clobber a shorthand, and
      // they set the curve for whatever transform arrives next too).
      el.style.transform = "";
      el.style.removeProperty("--kb-lift");
      applied.current = false;
    }
    announce("after");
  }, [ref, enabled, k]);
}
