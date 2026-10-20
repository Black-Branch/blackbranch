import { useState, useEffect, useCallback } from "react";
import { getJson, postJson } from "./http";
import { noticeOnFailure } from "./chatNotice";
import { lsGet, lsSet } from "./safeLocalStorage";
import type { PinnedMessage } from "./pinnedMessage";
import type { ChatMsg } from "./chatMsg";

// ── Pinned message: fetched on load, kept live by WS {type:"pin"} ──
export function useChatPin() {
  const [pin, setPin] = useState<PinnedMessage | null>(null);
  const [dismissedPinId, setDismissedPinId] = useState<number | null>(() => {
    const v = parseInt(lsGet("dismissedPinId") ?? "", 10);
    return isNaN(v) ? null : v;
  });
  // Measured height of the overlaid PinnedBanner — pads the scroll area's top so
  // no message hides under it at rest (the banner floats over the list).
  const [pinHeight, setPinHeight] = useState(0);
  useEffect(() => {
    getJson<{ pin?: PinnedMessage | null }>("/api/chat/pin")
      .then((d) => setPin(d.pin ?? null))
      .catch(() => {});
  }, []);
  const handlePin = useCallback((msg: ChatMsg) => {
    void noticeOnFailure(postJson("/api/chat/pin", { platform: msg.platform, messageId: msg.id }), "Couldn’t pin that message.");
  }, []);
  const handleUnpin = useCallback(() => {
    void noticeOnFailure(postJson("/api/chat/pin", undefined, "DELETE"), "Couldn’t unpin.");
  }, []);
  const dismissPin = useCallback((id: number) => {
    setDismissedPinId(id);
    lsSet("dismissedPinId", String(id));
  }, []);

  return { pin, setPin, dismissedPinId, pinHeight, setPinHeight, handlePin, handleUnpin, dismissPin };
}
