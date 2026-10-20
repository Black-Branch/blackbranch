// The one DM-room code path and the crypto rule as a test. An owner terminal's use of it is
// tested in its owner folder. Source scan: the SDK is not loadable under node --test, and the
// rule is about what the code never calls.
//
// Run: node --test app/lib/matrixDm.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";

const dm = stripComments(readFileSync("app/lib/matrixDm.ts", "utf8"));
const view = stripComments(readFileSync("app/features/community/MatrixView.tsx", "utf8"));

test("a DM room is made in ONE place, with the shape the Community tab always made: direct, private, no guests, encrypted", () => {
  assert.match(dm, /export async function openOrCreateDm\(client: MatrixClient, userId: string, banned: \(\) => Promise<boolean> = viewerBanned\)/);
  assert.match(dm, /is_direct: true,\s*invite: \[userId\],\s*preset: "private_chat"/);
  assert.match(dm, /guest_access: "forbidden"/);
  assert.match(dm, /type: "m\.room\.encryption", state_key: "", content: \{ algorithm: "m\.megolm\.v1\.aes-sha2" \}/);
  assert.match(view, /import \{ openOrCreateDm, rememberDm \} from "@\/app\/lib\/matrixDm"/);
  assert.doesNotMatch(view, /createRoom\(/, "the Community tab holds no copy of its own");
  assert.match(view, /await openOrCreateDm\(client, userId\)/);
});

test("the DM path never runs a crypto flow: no setup, bootstrap, signing, verification, store or device code", () => {
  for (const [name, src] of [["matrixDm", dm]] as const) {
    assert.doesNotMatch(src, /bootstrapCrossSigning|crossSignDevice|setupCrypto|requestVerification|initRustCrypto|indexedDB|getCrypto\(|secretStorage|deviceId|setupNewCrossSigning/i, `${name} touches crypto`);
    assert.doesNotMatch(src, /^import \{[^}]*\} from "matrix-js-sdk"/m, `${name} value-imports the SDK (it would land in the terminal's chunk)`);
  }
  assert.match(dm, /isDecryptionFailure\(\)\) return \{ ts, fromId: sender, text: "", undecryptable: true \}/, "an unreadable line is reported, never requested");
  assert.match(dm, /\}\s*$/, "vacuity anchor");
});
