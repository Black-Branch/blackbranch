// The mod kill switch must (1) tell stream-api the end was FORCED and by whom,
// so the poller holds instead of re-opening a session twenty seconds later
// while Kick and YouTube still say live, and (2) leave a mod-log row, so it is
// always known who ended the stream.
//
// Run: node --test app/api/mod/stream/end/forcedEnd.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "../../../../lib/testSource.ts";

const src = stripComments(readFileSync(new URL("./route.ts", import.meta.url), "utf8"));

test("the end is posted as forced, with the mod's id", () => {
  assert.match(src, /body: JSON\.stringify\(\{ streamId: data\.streamId, forced: true, by: me \}\)/);
});

test("a successful end is written to the mod log before the response", () => {
  const log = src.indexOf('appendModLog({ action: "stream_force_offline", target: "site", by: me, reason: `session ${data.streamId}` })');
  assert.ok(log > 0, "the mod-log write exists with the session id in the reason");
  const ok = src.indexOf("return Response.json({ live: false, ended: true, streamId: data.streamId });");
  assert.ok(ok > log, "the row is written before the success response (END anchor)");
  const refused = src.indexOf("Couldn't end the session");
  assert.ok(refused > 0 && refused < log, "a refused end writes nothing");
});

test("the action is part of the mod-log contract", () => {
  const modlog = stripComments(readFileSync(new URL("../../../../lib/modlog.ts", import.meta.url), "utf8"));
  assert.match(modlog, /\| "stream_force_offline"\s*(\||;)/);
  assert.ok(modlog.lastIndexOf("export async function appendModLog") > modlog.indexOf("stream_force_offline"));
});
