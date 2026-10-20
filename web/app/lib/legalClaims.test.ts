// The privacy page names every personal-data field the site stores (the bio and
// the sign-up answers are personal data: they are named in /legal). Prose, so a
// source scan with an END anchor.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("/legal names the bio under Account & profile", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "app/legal/LegalDocument.tsx"), "utf8");
  const start = src.indexOf("Account &amp; profile:");
  assert.notEqual(start, -1, "the Account & profile item moved");
  const item = src.slice(start, src.indexOf("</li>", start));
  for (const word of ["display name", "pronouns", "bio", "banner", "status line"]) {
    assert.ok(item.includes(word), `Account & profile item does not name "${word}"`);
  }
  assert.ok(src.trimEnd().endsWith("}"), "END anchor: page.tsx ends with a closing brace");
});
