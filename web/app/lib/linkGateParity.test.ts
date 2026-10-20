// PARITY GUARD: web/app/lib/linkGate.ts ⇄ stream-api/link-gate.js
//
// Same shape as blacklistParity.test.ts, and for the same reason: two runtimes
// that cannot share an import, one policy. The web copy gates NATIVE sends; the
// stream-api copy gates PLATFORM INGEST. Detection and ordering must be
// identical — only the RESPONSE differs, because a platform message is already
// public over there and there is nobody here to refuse.
//
// A divergence here is invisible until a link gets through on one path and not
// the other, which is the worst way to find out.
//
// Run: node --test app/lib/linkGateParity.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { HostRule } from "./linkGate.ts";

// The site's own domain is an install value in both copies: web reads its published
// matrix.serverName (INSTALL_VALUES, read by installValues.ts — set before the dynamic import
// below), stream-api reads MATRIX_SERVER_NAME per call. Both are given the same
// neutral domain so the site-host branch is compared too.
const SITE_DOMAIN = "example.tv";
process.env.INSTALL_VALUES = JSON.stringify({ "matrix.serverName": SITE_DOMAIN });
process.env.MATRIX_SERVER_NAME = SITE_DOMAIN;
const {
  gateLinks: webGate, extractUrls: webExtract, judgeHost: webJudge,
  looksHomographic: webHomo, normalizeHost: webNormHost,
  isUntrustable: webUntrust, UNTRUSTABLE: WEB_UNTRUSTABLE,
  BASELINE_HOSTS: WEB_BASELINE,
} = await import("./linkGate.ts");

const require = createRequire(import.meta.url);
const api = require("../../../stream-api/link-gate.js") as {
  gateLinks: (i: { text: string; posture: string; rules: HostRule[] }) => { action: string; host?: string; reason?: string };
  extractUrls: (t: string) => string[];
  judgeHost: (h: string, r: HostRule[]) => string | null;
  looksHomographic: (h: string) => boolean;
  isUntrustable: (h: string) => boolean;
  normalizeHost: (r: string) => string;
  UNTRUSTABLE: string[];
  BASELINE_HOSTS: string[];
  setLinkPosture: (p: string) => void;
  currentPosture: () => string;
};

const HERE = dirname(fileURLToPath(import.meta.url));

const RULES: HostRule[] = [
  { host: "example.com", severity: 1 },
  { host: "bad.example.com", severity: 3 },
  { host: "spam.test", severity: 3 },
];

// Chosen to exercise every branch of the ordering, not the happy path.
const MESSAGES = [
  "no links here",
  "https://example.com/ok",
  "https://docs.example.com/ok",
  "https://bad.example.com/x",
  "https://spam.test/x",
  "https://never-seen.test/x",
  "https://bit.ly/abc",
  "https://cdn.discordapp.com/a/b/c.png",
  "https://xn--pple-43d.com/x",
  "[label](https://never-seen.test/y)",
  "[https://never-seen.test](https://example.com/real)",
  "https://youtube.com/watch?v=1 and https://never-seen.test/x",
  "https://spam.test/a https://bit.ly/b https://xn--pple-43d.com/c",
  "https://example.com/x)., trailing punctuation",
  "http://example.com/insecure",
  "https://WWW.Example.COM/CASE",
  // Edge cases the mirror must not drift on:
  "go HTTPS://EVIL.EXAMPLE/x",                  // uppercase scheme
  "[hi](HTTP://scam.example/x)",                // …in a markdown href
  "check https://youtube.com.",                 // sentence-final dot
  "really https://spam.test!?",                 // stacked punctuation
  "https://youtube.com./watch",                 // FQDN trailing dot in the host
  "https://foo_bar.example.com/x",              // ASCII underscore is NOT a homograph
];

test("both runtimes return the same verdict for the same message", () => {
  for (const posture of ["off", "flag", "hold"]) {
    for (const text of MESSAGES) {
      const w = webGate({ text, posture: posture as "off" | "flag" | "hold", rules: RULES });
      const a = api.gateLinks({ text, posture, rules: RULES });
      assert.equal(a.action, w.action, `action differs at posture=${posture} for "${text}"`);
      if (w.action === "hold" && a.action === "hold") {
        assert.equal(a.host, w.host, `host differs for "${text}"`);
        assert.equal(a.reason, w.reason, `reason differs for "${text}"`);
      }
    }
  }
});

test("extraction agrees, including the markdown-label case", () => {
  for (const text of MESSAGES) {
    assert.deepEqual(api.extractUrls(text), webExtract(text), `extraction differs for "${text}"`);
  }
});

test("host judgement agrees, including the ordering", () => {
  const hosts = [
    "example.com", "docs.example.com", "bad.example.com", "spam.test",
    "never-seen.test", "bit.ly", "sub.bit.ly", "cdn.discordapp.com",
    "xn--pple-43d.com", "youtube.com", "m.youtube.com",
    SITE_DOMAIN, `api.${SITE_DOMAIN}`, `not${SITE_DOMAIN}`,
  ];
  for (const h of hosts) {
    assert.equal(api.judgeHost(h, RULES), webJudge(h, RULES), `judgement differs for ${h}`);
  }
  // …and with an allowlist entry that must LOSE to an untrustable/homograph.
  const sneaky: HostRule[] = [{ host: "bit.ly", severity: 1 }, { host: "xn--pple-43d.com", severity: 1 }];
  for (const h of ["bit.ly", "xn--pple-43d.com"]) {
    assert.equal(api.judgeHost(h, sneaky), webJudge(h, sneaky),
      `${h} — the two runtimes disagree about whether an allowlist entry can win`);
  }
});

test("the untrustable list is IDENTICAL in both runtimes", () => {
  // Not "both non-empty" — identical. A host trusted on one path and not the
  // other is a gate with a hole in exactly one direction.
  assert.deepEqual([...api.UNTRUSTABLE].sort(), [...WEB_UNTRUSTABLE].sort());
  assert.ok(api.UNTRUSTABLE.length > 20, "the list emptied out — every shortener would pass");
});

test("the baseline allowlist is IDENTICAL in both runtimes", () => {
  assert.deepEqual([...api.BASELINE_HOSTS].sort(), [...WEB_BASELINE].sort());
});

test("homograph detection and host normalisation agree", () => {
  const hosts = [
    "example.com", "xn--pple-43d.com", "pа" + "ypal.com", "sub.domain.co.uk", "xn.example.com",
  ];
  for (const h of hosts) {
    assert.equal(api.looksHomographic(h), webHomo(h), `homograph differs for ${h}`);
    assert.equal(api.isUntrustable(h), webUntrust(h), `untrustable differs for ${h}`);
  }
  for (const raw of [
    "Example.COM", "https://www.example.com/path?q=1", "user@example.com:8443",
    "not a host", "localhost", "", "HTTPS://SUB.EXAMPLE.COM/",
    "https://example.com?x=1", "example.com#frag", "example..com", ".example.com",
  ]) {
    assert.equal(api.normalizeHost(raw), webNormHost(raw), `normalizeHost differs for "${raw}"`);
  }
});

test("the two copies expose the SAME SURFACE, not just the same answers", () => {
  // Every test above compares BEHAVIOUR: give both copies the same input, demand
  // the same verdict. That is the important half and it is not the whole
  // contract — it can only compare functions that both copies still have.
  //
  // Three of stream-api's exports — hostMatches, hostOf, currentHostRules — are
  // called by nothing in stream-api and by none of the behavioural tests here,
  // while web's copy exports all three and its mod route uses
  // `currentHostRules` for the link-gate dry run. They look exactly like dead
  // code, and deleting them would be wrong: the two files are one policy in two
  // runtimes, and the moment their surfaces diverge, the NEXT person to port a
  // fix writes it against a shape that only exists on one side.
  //
  // So the reason those exports are kept is a test rather than a comment.
  // Types are web-only by nature (`HostRule`, `LinkPosture`, `LinkVerdict`,
  // `LinkReason`, `GateInput`) and are excluded — the contract is the VALUES.
  const webSrc = readFileSync(join(HERE, "linkGate.ts"), "utf8");
  const apiSrc = readFileSync(join(HERE, "../../../stream-api/link-gate.js"), "utf8");

  const webNames = [...webSrc.matchAll(/^export\s+(?:async\s+)?(function|const|class)\s+([A-Za-z0-9_$]+)/gm)]
    .map((m) => m[2]!);
  assert.ok(webNames.length > 10, `parsed only ${webNames.length} web exports — the scan is vacuous`);

  const list = /module\.exports\s*=\s*\{([\s\S]*?)\n\};/.exec(apiSrc);
  assert.ok(list, "stream-api/link-gate.js no longer ends with a module.exports block");
  const apiNames = [...list[1]!.matchAll(/([A-Za-z0-9_$]+)/g)].map((m) => m[1]!);
  assert.ok(apiNames.length > 10, `parsed only ${apiNames.length} stream-api exports — the scan is vacuous`);

  assert.deepEqual(
    [...apiNames].sort(), [...webNames].sort(),
    "the link gate's two copies no longer expose the same functions — port the " +
      "addition to both, or the next fix will be written against a shape that " +
      "exists in only one runtime"
  );
});

test("an unrecognised posture is `off` in the stream-api copy too", () => {
  for (const bad of ["", "on", "HOLD", "enforce"]) {
    api.setLinkPosture(bad);
    assert.equal(api.currentPosture(), "off", `"${bad}" was not treated as off`);
  }
  api.setLinkPosture("off");
});

// ── The release path ─────────────────────────────────────────────────────────

test("a link hold is RELEASABLE — otherwise 'held' is a lie", () => {
  // The resolve route must republish link holds, not only `account_age` rows. A
  // link hold filed as 'blocklist' would resolve, the panel would say allowed,
  // and the message would never appear — "the difference between withhold and
  // block, quietly erased", which is the account-age release path's own comment
  // about the same failure.
  const resolve = readFileSync(join(HERE, "../api/mod/automod/resolve/route.ts"), "utf8")
    .split("\n").filter((l) => !l.trimStart().startsWith("//"))
    .map((l) => l.replace(/\/\/.*$/, "")).join("\n");

  // Since v89 the set is a ternary (native rows also release 'blocklist' word
  // holds, via /chat/native) — link_gate must be releasable on BOTH branches.
  const releasableArrays = [...resolve.matchAll(/\[("account_age"[^\]]*)\]/g)].map((m) => m[1] ?? "");
  assert.ok(releasableArrays.length >= 2, "the RELEASABLE ternary lost a branch");
  for (const arr of releasableArrays) {
    assert.match(arr, /"link_gate"/,
      "link_gate rows are not republished on Allow — the hold would silently drop them");
  }
  assert.match(resolve, /releaseHold: true/, "the release no longer skips the gates that held it");

  // Both recorders must file under that source, or the dispatch never matches.
  const webRec = readFileSync(join(HERE, "blocklistReview.ts"), "utf8");
  assert.match(webRec, /VALUES \('link_gate'/, "the native recorder files link holds under the wrong source");
  // A real hold is 'pending' — releasable. (Flag-mode rows are 'flagged', v89;
  // linkGate.test.ts pins that half.)
  assert.match(webRec, /flagOnly \? "flagged" : "pending"/,
    "a link hold must be pending, not blocked — it IS releasable");

  const apiRec = readFileSync(join(HERE, "../../../stream-api/blocklist-review.js"), "utf8");
  assert.match(apiRec, /VALUES \('link_gate'/, "the ingest recorder files link holds under the wrong source");
});

test("releasing a held message SKIPS the link gate on re-ingest", () => {
  // Without this, Allow re-posts the message, the gate refuses it again, and the
  // mod's decision silently does nothing — the same failure the age gate's
  // release guards against.
  const chat = readFileSync(join(HERE, "../../../stream-api/chat.js"), "utf8")
    .split("\n").filter((l) => !l.trimStart().startsWith("//"))
    .map((l) => l.replace(/\/\/.*$/, "")).join("\n");

  assert.match(chat, /releaseHold === true\s*\?\s*\{ action: 'allow' \}\s*:\s*linkGate\.gate\(message\)/,
    "a released message is re-gated, so Allow is a no-op");
  // The word blocklist must NOT be skipped by a release.
  assert.ok(chat.indexOf("classify(message)") < chat.indexOf("linkGate.gate(message)"),
    "the word filter must still run before the link gate on ingest");
  assert.doesNotMatch(chat, /releaseHold === true\s*\?\s*\{ action: 'allow' \}\s*:\s*classify/,
    "a release must not skip the word blocklist — that would let Allow publish a slur");
});
