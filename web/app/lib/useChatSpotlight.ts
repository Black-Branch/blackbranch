import { useCallback } from "react";
import { postJson } from "./http";
import type { ChatMsg } from "./chatMsg";
import { spotlightKeyOf } from "./chatSpotlight";

// The click that sets the streamer's highlighted message (chatSpotlight.ts): a
// click on the picked row clears it, a click on any other row picks that one.
// The server decides who may (the route is admin-gated) and fans the result out
// as the `spotlight` frame — no optimistic state here; the frame is back in
// milliseconds and it is the same frame everyone else renders from.
export function useSpotlightToggle(current: string | null) {
  return useCallback((msg: ChatMsg) => {
    postJson("/api/chat/spotlight", {
      spotlight: current !== null && current === spotlightKeyOf({ platform: msg.platform, messageId: msg.id })
        ? null
        : { platform: msg.platform, messageId: msg.id },
    }).catch(() => {});
  }, [current]);
}
