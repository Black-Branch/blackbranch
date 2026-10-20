import { useEffect, useRef, useState } from "react";

// ONE row menu open at a time, by construction rather than by dismissal.
//
// WHY THIS EXISTS. Only one message may be selected at a time.
//
// `barOpen` is per-row state. `useOutsideClick` cannot be the thing that closes
// a previously-open row: it cannot listen on touchstart (touchstart fires on
// the first touch of a scroll, before the browser knows it is a scroll), and a
// long press deliberately swallows its own touchend so no compatibility
// mousedown ever arrives. So long-pressing row B would leave row A open, with
// nothing to shut it.
//
// Chasing that with another dismissal event would be the wrong fix: "only one
// is open" is an INVARIANT, not a side effect of some gesture happening to be
// observed. The opener announces itself and everyone else closes — so it holds
// no matter which gesture, browser or pointer opened it.
//
// Subscribers register only WHILE OPEN, so ~80 mounted rows do not each hold a
// listener; at most one does. The registry is module-level and therefore shared
// across ChatMessage and MatrixMessageRow, which is correct: a chat row and a
// Matrix row must not both be open either.

type Listener = (owner: symbol) => void;

const subscribers = new Set<Listener>();

/**
 * Announce that `owner` is opening. Every other open holder closes.
 *
 * Call this BEFORE flipping your own open state: the opener has not subscribed
 * yet at that point, so it cannot tell itself to close. Re-claiming while
 * already open is a no-op for the same reason the identity check exists.
 */
export function claimExclusive(owner: symbol): void {
  // Copy first — a listener closing itself mutates the set during iteration.
  for (const notify of [...subscribers]) notify(owner);
}

/**
 * Returns this component's stable identity token. While `open`, it listens for
 * anyone else claiming and calls `close`.
 */
export function useExclusiveOpen(open: boolean, close: () => void): symbol {
  // useState's lazy initialiser, NOT a lazily-filled ref: the identity has to be
  // stable and readable during render, and reading or writing a ref there is
  // exactly what react-hooks/refs forbids (it is unsafe under concurrent
  // rendering, where a render can be thrown away).
  const [owner] = useState(() => Symbol("exclusive-open"));

  // `close` is usually a fresh closure each render; holding it in a ref keeps
  // the subscription from being torn down and rebuilt on every parent render.
  // Written in an effect for the same reason as above.
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; }, [close]);

  useEffect(() => {
    if (!open) return;
    const notify: Listener = (who) => { if (who !== owner) closeRef.current(); };
    subscribers.add(notify);
    return () => { subscribers.delete(notify); };
  }, [open, owner]);

  return owner;
}
