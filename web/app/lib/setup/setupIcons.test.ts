// The site's icons from an upload: the five PNGs are checked (a PNG, the exact size, ≤ 1 MB)
// and handed to the host through its request folder — the site-files/ folder is read-only to web.
// Run: node --test app/lib/setup/setupIcons.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ICON_FILES, checkIconFile, checkIconSet, writeIconSet, requestsDir, iconAnswer, stageIconSet, type IconFile } from "./setupIcons.ts";
import { INSTANCE_KEYS, parseInstanceValue } from "../instanceSchema.generated.mjs";

/** A PNG's first bytes: the signature and an IHDR chunk naming the size (all the check reads). */
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}
const url = (b: Buffer) => `data:image/png;base64,${b.toString("base64")}`;
const set = () => Object.fromEntries(Object.entries(ICON_FILES).map(([n, s]) => [n, url(png(s, s))])) as Record<IconFile, string>;

test("the sizes are the product's own icon set's (public/brand), so an install's set replaces it file for file", () => {
  for (const [name, size] of Object.entries(ICON_FILES)) {
    const b = readFileSync(new URL(`../../../public/brand/${name}`, import.meta.url));
    assert.deepEqual([b.readUInt32BE(16), b.readUInt32BE(20)], [size, size], name);
  }
});

test("a PNG of the exact size passes; anything else is refused in words", () => {
  assert.ok(checkIconFile("icon-192.png", url(png(192, 192))).ok);
  for (const [v, says] of [
    [url(png(512, 512)), /512×512, expected 192×192/],
    [url(png(192, 191)), /expected 192×192/],
    ["data:image/jpeg;base64,/9j/4AAQ", /a PNG image expected/],
    [`data:image/png;base64,${Buffer.from("GIF89a-not-a-png-at-all-really").toString("base64")}`, /not a PNG/],
    [`data:image/png;base64,${"A".repeat(1_500_000)}`, /larger than 1 MB/],
    [42, /a PNG image expected/],
  ] as const) {
    const r = checkIconFile("icon-192.png", v);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, says);
  }
});

test("the set must be exactly the five files", () => {
  assert.ok(checkIconSet(set()).ok);
  const missing: Record<string, string> = { ...set() }; delete missing["apple-touch-icon.png"];
  assert.equal(checkIconSet(missing).ok, false);
  const r = checkIconSet({ ...set(), "../../etc/passwd": url(png(1, 1)) });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /not one of the icon files/);
  assert.equal(checkIconSet(null).ok, false);
});

test("the files land in <requests>/site-icons/ — and a second upload replaces the first whole (retry)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bb-icons-"));
  try {
    const first = checkIconSet(set());
    assert.ok(first.ok);
    if (!first.ok) return;
    await writeIconSet(first.files, dir);
    assert.deepEqual((await readdir(join(dir, "site-icons"))).sort(), Object.keys(ICON_FILES).sort());
    // A stray file from an earlier, different upload must not survive into the next.
    await writeFile(join(dir, "site-icons", "stale.png"), "x");
    await writeIconSet(first.files, dir);
    assert.deepEqual((await readdir(join(dir, "site-icons"))).sort(), Object.keys(ICON_FILES).sort());
    assert.deepEqual(await readFile(join(dir, "site-icons", "icon-192.png")), png(192, 192));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the host's answer is read in the standard result shape: a refusal's reason comes from `message`, an older answer is not this one", () => {
  const asked = "2026-10-21T10:00:00Z";
  assert.deepEqual(iconAnswer(null, asked), { state: "waiting" });
  assert.deepEqual(iconAnswer({ ok: true, at: "2026-10-21T09:59:59Z", message: "" }, asked), { state: "waiting" }, "an answer to an earlier upload");
  assert.deepEqual(iconAnswer({ ok: false, at: "2026-10-21T10:00:05Z", message: "icon-192.png: 512×512, expected 192×192" }, asked),
    { state: "refused", message: "icon-192.png: 512×512, expected 192×192" });
  assert.deepEqual(iconAnswer({ ok: false, at: "2026-10-21T10:00:05Z", message: "" }, asked), { state: "refused", message: "the server gave no reason" });
  assert.deepEqual(iconAnswer({ ok: true, at: "2026-10-21T10:00:05Z", message: "placed 5 icons" }, asked), { state: "placed" });
  // Retry: the same answer read twice says the same.
  const r = { ok: true, at: "2026-10-21T10:00:05Z", message: "" };
  assert.deepEqual(iconAnswer(r, asked), iconAnswer(r, asked));
});

test("once placed, SITE_ICON_SET=/site-files is staged with the other display values (Finish's apply-install writes .env) — never before", () => {
  assert.deepEqual(stageIconSet(undefined), { SITE_ICON_SET: "/site-files" });
  assert.deepEqual(stageIconSet({ SITE_NAME: "Gadget" }), { SITE_NAME: "Gadget", SITE_ICON_SET: "/site-files" }, "the other staged values are kept");
  assert.deepEqual(stageIconSet(stageIconSet({ SITE_NAME: "Gadget" })), { SITE_NAME: "Gadget", SITE_ICON_SET: "/site-files" }, "a second answer changes nothing");
  // It is a value the setup record and the host's apply-install both accept.
  const entry = INSTANCE_KEYS.find((k) => k.key === "setup.state")!;
  assert.ok(parseInstanceValue(entry, { install: stageIconSet({ SITE_NAME: "Gadget" }) }).ok);
  const host = readFileSync(new URL("../../../../install/blackbranch", import.meta.url), "utf8");
  assert.match(host, /SETTABLE_KEYS=\([^)]*SITE_ICON_SET/, "the host's apply-install takes SITE_ICON_SET");
  assert.match(host, /site_icons\(\) \{/, "vacuity anchor: the host's site-icons request exists");
});

test("the request folder is the one hostRequests.ts uses (BB_REQUESTS_DIR, else /requests)", async () => {
  assert.equal(requestsDir({}), "/requests");
  assert.equal(requestsDir({ BB_REQUESTS_DIR: "/tmp/x" }), "/tmp/x");
  const src = await readFile(new URL("../hostRequests.ts", import.meta.url), "utf8");
  assert.match(src, /requests: env\.BB_REQUESTS_DIR \|\| "\/requests"/, "the two read the same variable");
});
