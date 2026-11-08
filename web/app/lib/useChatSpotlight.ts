import { useCallback, useEffect, useState } from "react";
import { postJson } from "./http";
import type { ChatMsg } from "./chatMsg";
import { spotlightKeyOf } from "./chatSpotlight";
import { SPOTLIGHT_OFF_KEY } from "./spotlightSwitch";

// The click that sets the streamer's highlighted message (chatSpotlight.ts): a
// click on the picked row clears it, a click on any other row picks it.
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

// Whether this viewer's rows offer the click: an admin, while the streamer's switch (Admin Panel ›
// Site › Site › Streamer highlight, #250) leaves the highlight on. Asked once per mount and again
// when the Admin Panel saves that key (KeyCards' bb:instance-changed). Until the answer — or if it
// never comes — the click stays as it always was: the route refuses it anyway when switched off.
export function useSpotlightSwitch(isAdmin: boolean): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!isAdmin) return;
    let live = true;
    const ask = () => {
      fetch("/api/chat/spotlight/switch", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { on?: unknown } | null) => { if (live && typeof j?.on === "boolean") setOn(j.on); })
        .catch(() => {});
    };
    const onChanged = (e: Event) => { if ((e as CustomEvent).detail === SPOTLIGHT_OFF_KEY) ask(); };
    ask();
    window.addEventListener("bb:instance-changed", onChanged);
    return () => { live = false; window.removeEventListener("bb:instance-changed", onChanged); };
  }, [isAdmin]);
  return isAdmin && on;
}
