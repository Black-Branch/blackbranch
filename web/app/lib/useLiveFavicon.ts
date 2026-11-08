"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useChatSocket, type ChatSocketEvent } from "./useChatSocket.ts";
import { livenessOf } from "./streamLiveness.ts";
import { dottedIcon, iconLinks, liveStateOf, showLiveIcons, showPlainIcons, type LiveState } from "./liveFavicon.ts";

/**
 * The red dot on the tab icon while the stream is live (liveFavicon.ts). Its live state is the
 * `platformStates` frame on the page's one shared socket (sent on connect and on every change),
 * the same report the player reads: no request of its own.
 *
 * Call it ONCE, from a component in the initial commit (LiveFavicon in the root layout): the frame
 * stream-api sends on connect is only seen by a subscriber attached before the socket opens.
 *
 * Until the first report the icon is left alone, so a reload never flashes a dot it then removes.
 * A report that knows nothing (a platform not read yet, the reports gone silent) leaves it as it
 * is too.
 */
export function useLiveFavicon(dotted: (href: string) => Promise<string | null> = dottedIcon): LiveState {
  // `attempt` re-runs the swap for a later live report when an earlier one could not draw the dot.
  const [shown, setShown] = useState<{ state: LiveState; attempt: number }>({ state: "unknown", attempt: 0 });
  const wearing = useRef(false);
  const onEvent = useCallback((data: ChatSocketEvent) => {
    if (data.type !== "platformStates") return;
    const snap = livenessOf({ liveness: data });
    if (!snap) return;
    const state = liveStateOf(snap);
    if (state === "unknown") return;
    setShown((prev) => (prev.state === state && (state !== "live" || wearing.current)
      ? prev : { state, attempt: prev.attempt + 1 }));
  }, []);
  useChatSocket(onEvent);

  useEffect(() => {
    if (shown.state === "unknown") return;
    if (shown.state === "offline") {
      wearing.current = false;
      showPlainIcons(document);
      return;
    }
    let current = true;
    const show = () => void showLiveIcons(document, dotted, () => current).then((all) => {
      if (current) wearing.current = all;
    });
    show();
    // A navigation may render the head's icon links afresh, with the plain address: dot those too.
    const watch = new MutationObserver(() => {
      if (iconLinks(document).some((el) => el.dataset.plainHref === undefined)) show();
    });
    watch.observe(document.head, { childList: true, subtree: true });
    return () => {
      current = false;
      watch.disconnect();
    };
  }, [shown, dotted]);

  return shown.state;
}
