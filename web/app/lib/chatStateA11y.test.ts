// Two chat states that must be audible as well as visible.
//
// A vote button in its cooling window is styled disabled (`cursor-not-allowed
// opacity-40`) but stays a live button — correct behavior (the clamp is
// temporary, disabling would drop keyboard focus mid-interaction). The WHY
// must not live only in `title`, which most SRs skip on a button that has
// text content. `aria-disabled` says "present but won't act" without ejecting
// focus, which is precisely this state.
//
// And the slow-mode line: `sendError` is role=alert and `Sending…` is
// role=status, so the third sibling — "Slow mode — you can send again in Ns"
// — is role=status too; as a plain <p>, the user whose send was refused BY
// slow mode would hear nothing. Polite, so the countdown ticks don't
// interrupt.
//
// Run: node --test app/lib/chatStateA11y.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function readWhole(path: string, tailAnchor: RegExp): string {
  const src = readFileSync(join(webRoot, path), "utf8");
  assert.match(
    src.slice(-400), tailAnchor,
    `${path} did not end as expected — the read is truncated, and every assertion below it is vacuous`,
  );
  return stripComments(src);
}

test("cooling vote buttons say they are disabled without being disabled", () => {
  const src = readWhole("app/features/chat/ChatMessage.tsx", /<\/div>\s*\)\s*;\s*}\s*\)\s*;\s*$/);
  const hits = src.match(/aria-disabled={msg\._voteCooling \|\| undefined}/g) ?? [];
  assert.equal(hits.length, 2,
    `both vote buttons (▲ and ▼) need aria-disabled while cooling — found ${hits.length}. ` +
    "The styled-disabled state is otherwise invisible to a SR, and a real `disabled` would " +
    "eject keyboard focus mid-interaction");
});

test("the slow-mode countdown is a live region like its two siblings", () => {
  const src = readWhole("app/features/chat/ChatInput.tsx", /<\/form>\s*\)\s*;\s*}\s*$/);
  assert.match(src, /{slowActive && \(\s*<p role="status"/,
    "the slow-mode line is a plain <p> again — sendError alerts and Sending… reports, but the " +
    "state that actually refuses sends says nothing");
});
