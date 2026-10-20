import { useEffect, type RefObject } from "react";
// .ts extension on purpose: this hook runs under `node --test` (its render
// test), and Node's strip-only loading resolves no extensionless paths.
import { useEscapeDismiss } from "./chrome/dismissStack.ts";

// Calls `onOutside` when a pointer press lands outside `ref` — optionally also on
// Escape. Replaces the dozen hand-rolled mousedown/touchstart + contains effects
// scattered across popovers, menus and cards.
//
// `ref` may be an array when several elements count as "inside" (e.g. a popover
// plus the button that toggles it — pressing either shouldn't dismiss).
// `enabled` lets callers attach the listeners only while the popover is open
// (pass the open flag). `touch` (default true) also listens for touchstart so
// taps outside dismiss on mobile; `escape` adds a keydown→Escape dismiss.
export function useOutsideClick<T extends HTMLElement>(
  ref: RefObject<T | null> | ReadonlyArray<RefObject<T | null>>,
  onOutside: () => void,
  opts: { enabled?: boolean; escape?: boolean; touch?: boolean } = {},
) {
  const { enabled = true, escape = false, touch = true } = opts;
  // Escape rides the shared LIFO dismiss stack — a raw document keydown
  // listener fires for EVERY open surface at once, regardless of stacking order, so Escape with a menu over a modal
  // over a panel closed all three. The stack dismisses only the top layer;
  // registration order (mount order) is stacking order.
  useEscapeDismiss(onOutside, { enabled: enabled && escape });
  useEffect(() => {
    if (!enabled) return;
    const refs = Array.isArray(ref) ? ref : [ref];
    const onPointer = (e: MouseEvent | TouchEvent) => {
      const inside = refs.some((r) => r.current?.contains(e.target as Node));
      // Only fire once at least one element is actually mounted (matches the
      // single-ref behavior of doing nothing while ref.current is null).
      if (!inside && refs.some((r) => r.current)) onOutside();
    };
    document.addEventListener("mousedown", onPointer);
    if (touch) document.addEventListener("touchstart", onPointer);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      if (touch) document.removeEventListener("touchstart", onPointer);
    };
  }, [ref, onOutside, enabled, touch]);
}
