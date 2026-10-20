// @test-only test infrastructure — a local HTTP server whose body never finishes, for the
// fetch-deadline tests (ssrf.test.ts, homeserverFetch.test.ts). Not product code.
//
// It answers headers at once, then `{"a":"` and one more byte every 200 ms, forever. That is the
// shape a header-only timeout cannot see and undici's between-chunk `bodyTimeout` never trips: the
// only thing that ends it is a deadline that is still live while the caller reads the body.

import http from "node:http";
import type { AddressInfo } from "node:net";

/** Start the server on 127.0.0.1 and an ephemeral port. */
export async function trickleServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const timers = new Set<NodeJS.Timeout>();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"a":"');
    const t = setInterval(() => res.write("x"), 200);
    timers.add(t);
    res.on("close", () => { clearInterval(t); timers.delete(t); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const t of timers) clearInterval(t);
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** `p`, or "hung" when it has not settled after `ms` — the test's own guard, so a missing deadline
 *  FAILS the test instead of hanging the suite. */
export function within<T>(p: Promise<T>, ms: number): Promise<T | "hung"> {
  return Promise.race([p, new Promise<"hung">((r) => setTimeout(() => r("hung"), ms).unref())]);
}
