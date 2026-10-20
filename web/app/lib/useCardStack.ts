"use client";

import { useCallback, useMemo, useState } from "react";
import { pushPage, popPage, ROOT_PAGE, type CardPage } from "./cardStack";

// Open/navigate/close state for the one account card. The reducer next door is
// pure; this is the thin React wrapper around it.
//
// The state lives in the HOST rather than in AccountCard because the card is
// unmounted while closed — a listener inside it could never be the thing that
// opens it. Two hosts use this: UserMenu (the usual one, driven by the
// `bb:open-*` events) and MatrixView (the /community rail's fallback, where
// no UserMenu is mounted to claim them).

export type CardStack = {
  /** null while the card is closed. */
  stack: readonly CardPage[] | null;
  /** Open the card, or navigate an already-open one. No argument = the root. */
  open: (page?: CardPage) => void;
  back: () => void;
  close: () => void;
  /** The avatar button: open at the root, or close if already open. */
  toggle: () => void;
};

export function useCardStack(): CardStack {
  const [stack, setStack] = useState<readonly CardPage[] | null>(null);

  const open = useCallback((page?: CardPage) => {
    setStack((s) => {
      if (!page) return s ?? [ROOT_PAGE];
      // Opening a page cold puts the root underneath it, so Back always has
      // somewhere to go — a page reached from a chat button still leads to the
      // profile rather than dead-ending.
      return s ? pushPage(s, page) : [ROOT_PAGE, page];
    });
  }, []);

  const back = useCallback(() => setStack((s) => (s ? popPage(s) : s)), []);
  const close = useCallback(() => setStack(null), []);
  const toggle = useCallback(() => setStack((s) => (s ? null : [ROOT_PAGE])), []);

  return useMemo(() => ({ stack, open, back, close, toggle }), [stack, open, back, close, toggle]);
}
