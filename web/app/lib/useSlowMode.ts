import { useState, useEffect, useRef } from "react";
import { getJson } from "./http";

// Slow mode (mod-set, site-wide): non-mods wait N seconds between sends. The
// current setting arrives via fetch on mount + live {type:'chat_settings'} WS
// frames (forwarded as a window event by useChatMessages); the per-user
// countdown arms locally after each accepted send via armSlowMode(). The
// server enforces regardless — this is just honest UI. "bb:slow-mode-wait"
// is fired by ChatSidebar when the server 429s a send (another tab consumed
// the window, or the local countdown drifted) so the countdown re-arms honestly.
export function useSlowMode(isMod: boolean) {
  const [slowSeconds, setSlowSeconds] = useState(0);
  const [slowRemaining, setSlowRemaining] = useState(0);
  const slowNextRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    getJson<{ slowModeSeconds?: number }>("/api/mod/slowmode")
      .then(d => {
        if (!cancelled && typeof d.slowModeSeconds === "number" && Number.isFinite(d.slowModeSeconds)) {
          setSlowSeconds(d.slowModeSeconds);
        }
      })
      .catch(() => {});
    const onSettings = (e: Event) => {
      const s = (e as CustomEvent<{ slowModeSeconds?: number }>).detail?.slowModeSeconds;
      if (typeof s === "number") setSlowSeconds(s);
    };
    const onWait = (e: Event) => {
      const s = (e as CustomEvent<{ retryAfterSeconds?: number }>).detail?.retryAfterSeconds;
      if (typeof s === "number" && s > 0) {
        slowNextRef.current = Date.now() + s * 1000;
        setSlowRemaining(s);
      }
    };
    window.addEventListener("bb:chat-settings", onSettings);
    window.addEventListener("bb:slow-mode-wait", onWait);
    return () => {
      cancelled = true;
      window.removeEventListener("bb:chat-settings", onSettings);
      window.removeEventListener("bb:slow-mode-wait", onWait);
    };
  }, []);

  // Countdown ticker — armed only while a wait is active; 250ms granularity so
  // the displayed second flips close to the real boundary.
  const slowActive = slowRemaining > 0 && !isMod;
  useEffect(() => {
    if (!slowActive) return;
    const t = setInterval(() => {
      setSlowRemaining(Math.max(0, Math.ceil((slowNextRef.current - Date.now()) / 1000)));
    }, 250);
    return () => clearInterval(t);
  }, [slowActive]);

  // Accepted → arm the slow-mode countdown (commands don't count; the server
  // exempts mods and doesn't consume their window either).
  function armSlowMode() {
    if (!isMod && slowSeconds > 0) {
      slowNextRef.current = Date.now() + slowSeconds * 1000;
      setSlowRemaining(slowSeconds);
    }
  }

  return { slowActive, slowRemaining, armSlowMode };
}
