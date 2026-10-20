// A timeout mutes the COMPOSER, not the account.
//
// UserMenu (the avatar) mounts inside ChatInput, and UserMenu is the ONLY
// listener for every `bb:open-*` event (store, support, account settings, mod
// panel, profile card…). A banned/timed-out branch that swapped ChatInput out
// for a bare notice would cost a viewer serving a routine 10-minute timeout
// their avatar, settings, linked accounts, the support panel (the one appeal
// channel), and sign-out — and the MetaBar's Donate / Subscribe / Qorm buttons
// would dispatch events NOBODY hears.
//
// The invariant: every branch the composer slot renders for a SIGNED-IN viewer
// must mount UserMenu, so the account surface (and the event hub riding in it)
// survives moderation state.
//
// Run: node --test app/features/chat/bannedSurface.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "../../lib/testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function readWhole(path: string, tailAnchor: RegExp): string {
  const src = readFileSync(join(webRoot, path), "utf8");
  assert.match(
    src.slice(-400), tailAnchor,
    `${path} did not end as expected — the read is truncated, and every assertion below it is vacuous`,
  );
  return stripComments(src);
}

const SIDEBAR = "app/features/chat/ChatSidebar.tsx";
const SIDEBAR_TAIL = /<\/aside>\s*\)\s*;\s*}\s*$/;

test("the banned/timed-out branch still mounts UserMenu", () => {
  const src = readWhole(SIDEBAR, SIDEBAR_TAIL);
  assert.match(src, /<UserMenu[\s\S]{0,1200}You are banned from chat\./,
    "the ban branch dropped UserMenu — a banned viewer loses settings, support, sign-out, " +
    "and every MetaBar money button goes dead (their bb:open-* events have no listener)");
});

test("both moderation states still tell the viewer what is happening", () => {
  const src = readWhole(SIDEBAR, SIDEBAR_TAIL);
  assert.match(src, /You are banned from chat\./,
    "the permanent-ban notice is gone — a banned viewer sees no explanation");
  assert.match(src, /Timed out — [\s\S]{0,200}remaining/,
    "the timeout countdown is gone — a timed-out viewer can't tell it expires");
});
