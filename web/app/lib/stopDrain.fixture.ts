// The child process stopDrain.test.ts starts and signals: an HTTP server that stops exactly the way
// Next 16's standalone server does in production (next/dist/server/lib/start-server.js, `cleanup`:
// on SIGTERM, `server.close()` and WAIT for it — no deadline, no closeAllConnections outside dev —
// then exit 143). Next registers that handler before instrumentation.ts runs, so this does too, and
// only then installs the drain — the order the real process has.
//
// Arguments: `drain` or `none`, the drain's deadline in ms, the port (0 = any). Arguments, not env:
// a harness's switches are not settings an install could set.
import http from "node:http";
import type { AddressInfo } from "node:net";

const [mode, deadlineMs, port] = process.argv.slice(2);

const server = http.createServer((req, res) => {
  if (req.url?.split("?")[0] === "/stream") {
    // An ACTIVE response that never ends on its own (an event stream): no idle sweep reaches it.
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: open\n\n");
    return;
  }
  if (req.url === "/streamed") {
    // A streamed page: headers and the first chunk go out at once, the rest later — how Next sends
    // an App Router page. Its headers are already sent when the signal lands.
    res.writeHead(200, { "content-type": "text/html" });
    res.write("<p>first");
    setTimeout(() => res.end("rest</p>"), 400);
    return;
  }
  if (req.url === "/slow") { setTimeout(() => res.end("slow"), 400); return; }
  res.end("ok");
});

let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  server.close(() => process.exit(143));
});

if (mode === "drain") {
  const { installStopDrain } = await import("./stopDrain.ts");
  installStopDrain({ deadlineMs: Number(deadlineMs) });
}

server.listen(Number(port ?? 0), "127.0.0.1", () => {
  console.log(`PORT ${(server.address() as AddressInfo).port}`);
});
