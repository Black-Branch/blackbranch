"use client";

import { useCallback, useState } from "react";
import { useChatSocket, type ChatSocketEvent } from "./useChatSocket";
import { livenessOf } from "./streamLiveness.ts";
import { newest, type PlatformStates } from "./livePlatforms.ts";
import type { PublicSnapshot } from "./platformLiveness.generated.mjs";

/**
 * Each platform's public live state, newest first by `at` (livePlatforms.ts `newest`), from three
 * inputs: the server render's snapshot (`initial`), the `platformStates` frame (sent on connect and
 * on every change) and the 30 s status poll's `liveness` (`polled`, useStreamStatusPoll).
 *
 * Call it ONCE, from a component in the initial commit (StreamView): the frame stream-api sends on
 * connect is only seen by a subscriber attached before the socket opens (useChatSocket's note).
 */
export function usePlatformStates(initial: PublicSnapshot, polled?: PublicSnapshot | null): PlatformStates {
  const [pushed, setPushed] = useState(() => newest(initial, null));
  const onEvent = useCallback((data: ChatSocketEvent) => {
    if (data.type !== "platformStates") return;
    // Cut again through the one sanitizer, like the poll's copy (streamLiveness.ts).
    const snap = livenessOf({ liveness: data });
    if (snap) setPushed((prev) => newest(prev, snap));
  }, []);
  useChatSocket(onEvent);
  return newest(pushed, polled).platforms;
}
