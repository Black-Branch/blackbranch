// The privacy policy and the About page say what is shown about linked accounts, and when,
// and what happens to platform chat after an account is deleted — not only "recognise you as
// the same person across platforms" with nothing about who sees the link.
// Run: node --test app/lib/linkPolicyText.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const flat = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\s+/g, " ");
const legal = flat("app/legal/LegalDocument.tsx");
const about = flat("app/about/page.tsx");

test("the policy says the link is private by default, who sees it, and when it shows", () => {
  for (const words of [
    "The link is private by default",
    "public chat and profiles carry a separate id for each platform",
    "is posted from your own account there",
    "your profile lists your linked platforms if you turn that on under Linked accounts",
    "Moderators can see which accounts are linked",
    "hides it again",
  ]) assert.ok(legal.includes(words), `the policy no longer says: ${words}`);
});

test("D2: after deletion, platform chat is processed like anyone else's, and moderation records are kept", () => {
  assert.ok(legal.includes("If you keep chatting in a platform&apos;s public chat after deleting your account, those messages are processed like anyone else&apos;s platform chat"));
  assert.ok(legal.includes("moderation records about you are kept"));
});

test("About no longer promises to recognise you across platforms in public", () => {
  assert.ok(!about.includes("same person across platforms"));
  assert.ok(about.includes("the link itself is shown only where you choose to show it"));
  assert.ok(legal.length > 5000 && about.length > 1000, "vacuity anchor");
});
