// What lets a stop finish while the site is busy (O01). SERVER ONLY; installed once at boot
// (instrumentation.ts).
//
// Next's standalone server stops by calling server.close() and waiting for it, with no deadline
// (next/dist/server/lib/start-server.js). close() ends the sockets that are idle at that moment —
// but a socket that is mid-request is left alone, and Node goes on answering
// `Connection: keep-alive` on it and serving every new request that arrives on it. close()
// completes only after that socket has sat unused for the 5 s keep-alive timeout. The Cloudflare
// tunnel carries the whole site over a few such sockets, and the site's polls keep them busy about
// once a second, so a stop that caught one mid-request never finished: the old process served ~100
// more requests and systemd SIGKILLed it at 90 s (2026-10-20, 10-23, 10-24; reproduced on the
// throwaway install against the built server, and in stopDrain.test.ts).
//
// So once the stop signal arrives, every response still open — and any that arrives on a socket
// that is still open — is sent with `Connection: close` and its socket is ended when it has been
// written: the proxy opens its next connection to the new process instead. A response that never
// ends on its own (a stream, a long wait not tied to shutdownSignal) cannot hold the stop either:
// after the deadline the open requests are logged by method and path, and the process exits the
// way Next would (143).

import http from "node:http";
import { shutdownSignal } from "./shutdownSignal.ts";

/** Well inside systemd's 90 s stop timeout and Docker's 40 s grace (contract 5); far longer than
 *  any ordinary request takes. */
const STOP_DEADLINE_MS = 10_000;

const G = globalThis as typeof globalThis & { __stopDrainInstalled?: boolean };

export function installStopDrain({ deadlineMs = STOP_DEADLINE_MS }: { deadlineMs?: number } = {}): void {
  if (G.__stopDrainInstalled) return;
  G.__stopDrainInstalled = true;
  const open = new Set<http.ServerResponse>();
  let stopping = false;

  const closeWhenAnswered = (res: http.ServerResponse) => {
    if (!res.headersSent) res.setHeader("Connection", "close");
    // The server detaches the socket from the response as it finishes, so hold it from here.
    const socket = res.socket;
    res.once("finish", () => socket?.end());
  };

  const proto = http.Server.prototype as unknown as { emit: (event: string | symbol, ...args: unknown[]) => boolean };
  const emit = proto.emit;
  proto.emit = function drainingEmit(this: unknown, event: string | symbol, ...args: unknown[]): boolean {
    if (event === "request") {
      const res = args[1] as http.ServerResponse | undefined;
      if (res) {
        open.add(res);
        res.once("close", () => open.delete(res));
        if (stopping) closeWhenAnswered(res);
      }
    }
    return emit.call(this, event, ...args);
  };

  shutdownSignal().addEventListener("abort", () => {
    stopping = true;
    for (const res of open) closeWhenAnswered(res);
    setTimeout(() => {
      const left = [...open].map((r) => `${r.req.method} ${(r.req.url ?? "").split("?")[0]}`);
      console.error(`[stop] ${left.length} request(s) still open ${deadlineMs / 1000} s after the stop signal: ${left.slice(0, 10).join(", ")} — exiting without them`);
      process.exit(143);
    }, deadlineMs);
  }, { once: true });
}
