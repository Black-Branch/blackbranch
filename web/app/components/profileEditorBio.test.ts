// Review Important 4: the bio input was seeded only from the in-memory card
// cache, which every profile save clears — so the field showed empty and a
// blur then erased the saved bio. The editor's own /api/me fetch must apply the
// bio, and a save must be a no-op when nothing changed. Source scan (the
// editor is a 600-line client component); END anchor on the file's last brace.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { stripComments } from "../lib/testSource.ts";

test("ProfileEditor seeds the bio from /api/me and never saves an unchanged bio", () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), "app/components/ProfileEditor.tsx"), "utf8"));
  const fetchIdx = src.indexOf('("/api/me")');
  assert.notEqual(fetchIdx, -1, "the /api/me fetch moved");
  const fetchType = src.slice(src.lastIndexOf("getJson<", fetchIdx), fetchIdx);
  assert.ok(fetchType.includes("bio?: string | null"), "the /api/me fetch does not ask for bio");
  assert.match(src, /setBio\(d\.bio \?\? ""\);\s*savedBio\.current = d\.bio \?\? "";/, "the fetched bio seeds the field AND the last-saved value");
  assert.match(src, /if \(bio === savedBio\.current\) return;/, "an unchanged bio is not saved");
  assert.match(src, /savedBio\.current = d\.bio;/, "a successful save records what the server kept");
  assert.ok(src.trimEnd().endsWith("}"), "END anchor");
});
