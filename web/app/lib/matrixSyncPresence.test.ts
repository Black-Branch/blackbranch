// Pinned against node_modules on purpose (the same pattern as
// matrixVerifyTrust.test.ts). MatrixClientContext.tsx calls
// `mxClient.setSyncPresence(...)` AFTER `await mxClient.startClient(...)`
// resolves, not before — before is a silent no-op: `setSyncPresence` is
// `this.syncApi?.setPresence(...)`, and `syncApi` does not exist until
// `startClient` creates it. If an SDK upgrade moves where `syncApi` is
// created, renames `setSyncPresence`, or reorders `sync()` so the first
// `/sync` request goes out before push rules are fetched, the "after
// startClient, before any other await" placement stops being early enough
// and a stored Idle/Invisible status silently stops applying on page load —
// exactly what this file exists to catch before it ships.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/matrixSyncPresence.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const sdk = (file: string) => stripComments(readFileSync(join(process.cwd(), "node_modules/matrix-js-sdk/lib", file), "utf8"));

test("SDK: setSyncPresence is a thin call onto syncApi.setPresence — a no-op whenever syncApi is unset", () => {
  const client = sdk("client.js");
  const start = client.indexOf("async setSyncPresence(");
  assert.ok(start > 0, "setSyncPresence not found in the SDK");
  const end = client.indexOf("\n  }\n", start);
  const fn = client.slice(start, end);
  assert.match(fn, /this\.syncApi\?\.setPresence\(/, "setSyncPresence must still be a no-op-when-unset call onto syncApi");
});

test("SDK: startClient creates syncApi and fires sync() WITHOUT awaiting it — a caller's next line runs before the first /sync request is built", () => {
  const client = sdk("client.js");
  const fnStart = client.indexOf("async startClient(");
  assert.ok(fnStart > 0, "startClient not found in the SDK");
  const fnEnd = client.indexOf("\n  }\n", fnStart);
  const fn = client.slice(fnStart, fnEnd);
  const created = fn.indexOf("this.syncApi = new SyncApi(");
  const started = fn.indexOf("this.syncApi.sync().catch(");
  assert.ok(created > 0, "syncApi is no longer created with `new SyncApi(...)` inside startClient");
  assert.ok(started > created, "syncApi must be created before its sync() is kicked off");
  // Not awaited: the statement immediately before `.sync()` on the same
  // logical statement must not be `await` — startClient returns to its
  // caller (our `await mxClient.startClient(...)`) while sync() is still
  // running its own async setup.
  const statementStart = fn.lastIndexOf(";", started) + 1;
  const statement = fn.slice(statementStart, started + "this.syncApi.sync().catch(".length);
  assert.doesNotMatch(statement, /\bawait\b/, "syncApi.sync() must not be awaited inside startClient, or our continuation would run too late to matter");
});

test("SDK: sync() awaits the push-rules round-trip before it builds the first /sync request", () => {
  const sync = sdk("sync.js");
  const fnStart = sync.indexOf("async sync() {");
  assert.ok(fnStart > 0, "SyncApi.sync() not found in the SDK");
  const fnEnd = sync.indexOf("\n  }\n", fnStart);
  const fn = sync.slice(fnStart, fnEnd);
  const pushRules = fn.indexOf("await this.getPushRules()");
  const firstRequest = fn.indexOf("doSyncRequest(");
  assert.ok(pushRules > 0, "sync() no longer awaits getPushRules() directly");
  assert.ok(firstRequest > pushRules, "the first /sync request must still be built AFTER the push-rules round-trip — that gap is what our continuation lands inside of");
});
