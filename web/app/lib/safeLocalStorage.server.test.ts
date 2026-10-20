import { test } from "node:test";
import assert from "node:assert/strict";
import { lsGet, lsSet, lsRemove, lsGetJSON, lsSetJSON } from "./safeLocalStorage.ts";

// On the server there is no browser storage — but since Node 25 there IS a
// global named `localStorage`: a getter that, without --localstorage-file,
// prints "ExperimentalWarning: localStorage is not available…" the first time
// anything touches it (even `typeof localStorage`) and then yields undefined.
// The old helpers touched it inside try/catch, so every web process logged that
// warning on its first server-rendered page (a client component's
// `useState(() => lsGet(...))` runs during SSR). The helpers must not touch the
// global at all when there is no window.
//
// node --test gives each file its own process, so "no warning so far" is a
// clean reading here. This file must not import anything else that might touch
// localStorage first.
test("on the server the helpers answer 'nothing stored' WITHOUT touching Node's localStorage global", async () => {
  assert.equal(typeof window, "undefined", "this test is only meaningful without a window");
  const warnings: string[] = [];
  const onWarning = (w: Error) => warnings.push(`${w.name}: ${w.message}`);
  process.on("warning", onWarning);
  try {
    assert.equal(lsGet("k"), null);
    assert.deepEqual(lsGetJSON("k", { fallback: true }), { fallback: true });
    lsSet("k", "v");
    lsSetJSON("k", { a: 1 });
    lsRemove("k");
    // process warnings are emitted on a later tick
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off("warning", onWarning);
  }
  assert.deepEqual(warnings.filter((w) => /localStorage/i.test(w)), []);
});
