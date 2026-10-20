// The emote catalog and the personal set report into the readiness registry
// from the fetch paths they already have. Both hooks fold
// "not fetched yet" and "fetched empty" into one shape — the registry is
// where the difference lives.
import test from "node:test";
import assert from "node:assert/strict";
import { mountHook, serveJson, resetStorage } from "./testDom.ts";
import "./testTsx.ts";
import { readReadiness } from "./readiness.ts";
import { EMOTES_READINESS_KEY } from "./emoteReadiness.ts";
const { useEmotes } = await import("./useEmotes.ts");
const { usePersonalEmotes } = await import("./usePersonalEmotes.ts");

const statuses = () => readReadiness([EMOTES_READINESS_KEY]).map((s) => `${s.id}:${s.status}`);

test("catalog and personal go active on their fetch and done when it lands — registered at module load, pending until a hook mounts", async () => {
  resetStorage();
  // One body serves both fetches: a manifest-shaped object for /api/emotes,
  // and "no personal set" for /api/emotes/mine (no `emotes` field → EMPTY).
  serveJson({ Kappa: { url: "https://cdn.example/kappa.webp" } });
  assert.deepEqual(statuses(), ["catalog:pending", "personal:pending"], "registered by the module, nothing fetched yet");
  const h = await mountHook(() => { useEmotes(); usePersonalEmotes(); });
  await h.act(async () => { await Promise.resolve(); await Promise.resolve(); });
  assert.deepEqual(statuses(), ["catalog:done", "personal:done"]);
  await h.unmount();
});
