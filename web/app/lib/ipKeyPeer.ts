// The peer stamp: the socket address of every HTTP request, written by the SERVER into the
// PEER_HEADER request header (rateLimit.ts), over anything a client sent under that name. SERVER
// ONLY; installed once at boot (instrumentation.ts).
//
// Why: a route handler in this Next.js version gets a Request with headers and no socket, so the
// only addresses it could read were headers a client can write itself (CF-Connecting-IP,
// X-Forwarded-For) — Next fills X-Forwarded-For from the socket only when the client sent none.
// ipKey needs the real peer to decide whether a forwarded address may be believed (only from a
// trusted proxy). Wrapping http.Server's emit puts the socket address on the request before Next
// sees it; every server in the process is Next's own.
//
// A request that arrives while the server is still booting (before this runs) carries no stamp;
// ipKey then answers one shared key rather than trusting any header.

import http from "node:http";
import { PEER_HEADER } from "./rateLimit.ts";

const G = globalThis as typeof globalThis & { __peerStampInstalled?: boolean };

export function installPeerStamp(): void {
  if (G.__peerStampInstalled) return;
  G.__peerStampInstalled = true;
  const proto = http.Server.prototype as unknown as { emit: (event: string | symbol, ...args: unknown[]) => boolean };
  const emit = proto.emit;
  proto.emit = function stampedEmit(this: unknown, event: string | symbol, ...args: unknown[]): boolean {
    if (event === "request") {
      const req = args[0] as http.IncomingMessage | undefined;
      if (req?.headers) req.headers[PEER_HEADER] = req.socket?.remoteAddress ?? "";
    }
    return emit.call(this, event, ...args);
  };
}
