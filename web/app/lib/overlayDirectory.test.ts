// The overlay directory (/overlay, "Overlay Configuration") lists
// EVERY OBS browser source with the URL or file OBS points at. A directory that
// silently misses a source, or names one that no longer exists, is worse than
// none — so each entry is pinned to the thing it describes:
//   • served by the site      → its page exists under app/overlay/<path>/page.tsx
//   • served by stream-api    → a PUBLIC GET in route-surface.snapshot.json
//   • a file on the rig       → listed by the install's site plugin, and pinned there
//                               (app/(owner)/rigOverlays.test.ts on an install that has one)
//
// Run: node --test app/lib/overlayDirectory.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import "./testInstallValues.ts";
import { OVERLAY_SOURCES, sourceHref } from "./overlayDirectory.ts";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "..");
const repo = join(web, "..");

test("every source has a unique id, a name, one line on what it shows, and a size hint", () => {
  const ids = new Set<string>();
  for (const s of OVERLAY_SOURCES) {
    assert.ok(s.id && !ids.has(s.id), `duplicate or empty id ${s.id}`);
    ids.add(s.id);
    assert.ok(s.name.length > 0 && s.shows.length > 0 && s.size.length > 0, `${s.id}: incomplete`);
  }
  assert.deepEqual([...ids].sort(), ["alert", "bubble", "chat", "credit", "meter", "poll", "rig", "sticker", "support-bar"],
    "every source, by name — a deleted entry must fail here, not vanish");
  assert.ok(OVERLAY_SOURCES.every((s) => s.served !== "rig"), "a file on the streaming PC is an install's own: its plugin lists it");
});

test("site-served sources point at pages that exist", () => {
  const site = OVERLAY_SOURCES.filter((s) => s.served === "site");
  assert.ok(site.length >= 2, "at least the chat source and the credit line");
  for (const s of site) {
    assert.match(s.path, /^\/overlay\/[a-z-]+/, `${s.id}: a site source lives under /overlay/`);
    const seg = s.path.replace(/^\/overlay\//, "").replace(/\?.*$/, "");
    assert.ok(existsSync(join(web, "app", "overlay", seg, "page.tsx")), `${s.id}: no page at app/overlay/${seg}/page.tsx`);
  }
});

test("stream-api sources are PUBLIC GETs on the pinned route surface", () => {
  const surface = readFileSync(join(repo, "stream-api", "route-surface.snapshot.json"), "utf8");
  const api = OVERLAY_SOURCES.filter((s) => s.served === "stream-api");
  // The four money overlays are agent D's routes (contract 4): this stays red in a tree without
  // them, by design — the directory must not name a source stream-api does not serve.
  assert.ok(api.length >= 6, "the poll, sticker, alert, support-bar, meter and bubble overlays");
  for (const s of api) {
    assert.ok(surface.includes(`"GET ${s.path} [PUBLIC]"`), `${s.id}: GET ${s.path} is not a PUBLIC route`);
  }
});

test("what OBS is given: a URL for a served source, a file for a rig source", () => {
  const origin = "https://site.test";
  const chat = OVERLAY_SOURCES.find((s) => s.id === "chat")!;
  assert.equal(sourceHref(chat, origin), "https://site.test/overlay/chat?scale=1.5");
  const poll = OVERLAY_SOURCES.find((s) => s.id === "poll")!;
  assert.equal(sourceHref(poll, origin), "https://api.example.tv/overlay/poll");
  assert.equal(sourceHref({ ...chat, served: "rig", path: "x.html" }, origin, "/srv/obs"), "/srv/obs/x.html");
});

test("/overlay is a mod page, and the Admin Panel's OBS place links to it", () => {
  const page = stripComments(readFileSync(join(web, "app", "(main)", "overlay", "page.tsx"), "utf8"));
  assert.match(page, /if \(!\(await isModUser\(\)\)\) redirect\("\/"\);/, "gated exactly like /mod");
  assert.match(page, /<OverlayDirectory \/>/);
  assert.ok(page.trimEnd().endsWith("}"), "END anchor");
  // The /mod page is the mod window (no text links); the directory is an
  // OBS concern, linked from Utility → OBS.
  const admin = stripComments(readFileSync(join(web, "app", "features", "instance", "AdminPanel.tsx"), "utf8"));
  assert.match(admin, /section === "utility" && sub === "obs"[\s\S]{0,200}href="\/overlay"/, "the OBS place is where the directory is found");
});
