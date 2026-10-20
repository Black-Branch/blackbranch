import { useEffect, useRef } from "react";
import type { StreamFrame } from "./wsFrames";
import { socketHealth } from "./socketHealth";
import { installValue } from "./installValues.ts";

// The public WebSocket origin of stream-api — install key site.apiWsOrigin (the page's install
// values, read when this module first loads: the layout's <head> script has run by then).
const WS_URL = installValue("site.apiWsOrigin");

/**
 * A parsed frame from the stream-api broadcast socket. Typed as the full
 * `StreamFrame` registry (see wsFrames.ts) so callers get compile-time
 * narrowing when they switch on `type`. The wire is trusted (our own server
 * builds every frame); this hook does not re-validate the payload.
 */
export type ChatSocketEvent = StreamFrame;

type ChatSocketOpts = {
  /** Fired on every successful (re)connect. */
  onOpen?: () => void;
  /** Fired whenever the socket drops (before the reconnect backoff starts). */
  onClose?: () => void;
};

// ── ONE shared connection per page, fanned out to every hook instance ────────
//
// One WebSocket per `useChatSocket()` call would give a live mobile viewer
// three concurrent connections to the same endpoint (chat, timer, support
// bar), each JSON.parse-ing every broadcast frame and two of them discarding
// almost all of it. The connection is module-level and ref-counted: the first
// subscriber opens it, the last one closes it, every frame is parsed once and
// handed to each subscriber.
//
// Connect-time semantics, preserved by construction:
//   • The server sends its connect-time frames once, on open: `history` (the
//     message buffer) and then the state frames ws-hub's connectFrames builds
//     (`timerState`, `sponsorState`, and `spotlight` when a message is
//     picked). The timer/bar state also rides the 15s heartbeat, so a
//     subscriber that attaches to an already-open socket (a moderation panel
//     section mounting after the page has been open a while, say) waits ≤15s
//     for it — the same worst case it would have with its own fresh connection.
//   • A subscriber that CONSUMES `history` or `spotlight` must therefore
//     attach before the socket opens. Every such consumer mounts in the
//     initial commit (useChatMessages via the always-mounted ChatSidebar;
//     ChatOverlay and the popout are their own pages, hence their own module
//     instance), and subscription is synchronous in the mount effect while the
//     open is async — so this holds. If a LATE-mounting consumer of either is
//     ever added, it will start without them: extend this module with a
//     replay cache first.
//   • `onOpen` fires on every real (re)connect, and synthetically for a
//     subscriber attaching while the socket is already open — so connection
//     badges (`setConnected(true)`) read correctly regardless of mount order.
//   • One reconnect backoff (1s → 30s) instead of one per consumer.

type Subscriber = {
  onEvent: (data: ChatSocketEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
};

type SharedConn = {
  ws: WebSocket | null;
  subs: Set<Subscriber>;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectDelay: number;
  open: boolean;
};

let conn: SharedConn | null = null;

function connect(c: SharedConn) {
  if (conn !== c || c.ws?.readyState === WebSocket.OPEN) return;
  const ws = new WebSocket(WS_URL);
  c.ws = ws;
  ws.onopen = () => {
    c.reconnectDelay = 1000;
    c.open = true;
    for (const s of Array.from(c.subs)) s.onOpen?.();
  };
  ws.onclose = () => {
    c.open = false;
    for (const s of Array.from(c.subs)) s.onClose?.();
    if (conn !== c) return; // last subscriber left — no reconnect
    socketHealth.reconnects += 1; // device-health report: a drop that reconnects
    c.reconnectTimer = setTimeout(() => {
      c.reconnectDelay = Math.min(c.reconnectDelay * 2, 30000);
      connect(c);
    }, c.reconnectDelay);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (e) => {
    let data: ChatSocketEvent;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    // Parse once, deliver to all. Per-subscriber try/catch so one throwing
    // handler cannot starve the others of the frame.
    for (const s of Array.from(c.subs)) {
      try {
        s.onEvent(data);
      } catch {}
    }
  };
}

function subscribe(sub: Subscriber): () => void {
  if (!conn) {
    conn = { ws: null, subs: new Set(), reconnectTimer: null, reconnectDelay: 1000, open: false };
    connect(conn);
  }
  const c = conn;
  c.subs.add(sub);
  if (c.open) sub.onOpen?.(); // synthetic: the socket was already up
  return () => {
    c.subs.delete(sub);
    if (c.subs.size === 0 && conn === c) {
      conn = null; // clear FIRST so onclose skips the reconnect
      if (c.reconnectTimer) clearTimeout(c.reconnectTimer);
      c.ws?.close();
    }
  };
}

/**
 * Transport-only WebSocket hook for the broadcast chat feed. Subscribes to the
 * page-wide shared connection above; the caller keeps full ownership of message
 * state and decides what each frame means.
 *
 * `onEvent`/`onOpen`/`onClose` are stored in refs and read live, so passing
 * fresh closures every render does NOT churn the subscription — it attaches
 * once on mount and detaches on unmount.
 */
export function useChatSocket(
  onEvent: (data: ChatSocketEvent) => void,
  opts?: ChatSocketOpts
) {
  const handlerRef = useRef(onEvent);
  const optsRef = useRef(opts);

  // Keep the latest callbacks in refs so the shared socket always dispatches to
  // current handlers. Declared before the subscription effect so the handler is
  // in place before the first frame can arrive.
  useEffect(() => {
    handlerRef.current = onEvent;
    optsRef.current = opts;
  });

  useEffect(() => {
    return subscribe({
      onEvent: (d) => handlerRef.current(d),
      onOpen: () => optsRef.current?.onOpen?.(),
      onClose: () => optsRef.current?.onClose?.(),
    });
  }, []);
}
