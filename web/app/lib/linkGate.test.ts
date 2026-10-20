// The link gate — piece 2. Default-deny for links from unlisted hosts, held for
// a mod exactly like a mid-severity word.
//
// The tests that matter here are the BYPASS tests. An allowlist gate is only
// worth having if it cannot be walked around by wrapping the link in markdown,
// pairing it with an allowed link, or pointing a subdomain at it.
//
// Run: node --test app/lib/linkGate.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import {
  gateLinks, extractUrls, hostOf, hostMatches, judgeHost,
  isUntrustable, looksHomographic, UNTRUSTABLE, BASELINE_HOSTS,
  normalizeHost, setLinkPosture, currentPosture,
  type HostRule,
} from "./linkGate.ts";

// The migration history (migrations/schema.sql + migrate-vN.sql) is the private repo's; a public
// tree starts from migrations/baseline/. A test of what one migration wrote runs where the history is.
const CHAIN = existsSync(new URL("../../../migrations/schema.sql", import.meta.url));
const HISTORY = CHAIN ? false : "reads the migration history, which this tree does not carry";

const HERE = dirname(fileURLToPath(import.meta.url));

const RULES: HostRule[] = [
  { host: "example.com", severity: 1 },      // allowlisted
  { host: "bad.example.com", severity: 3 },  // …with a hostile child
  { host: "spam.test", severity: 3 },        // explicitly held
];

const gate = (text: string, posture: "off" | "flag" | "hold" = "hold") =>
  gateLinks({ text, posture, rules: RULES });

// ── Dormant by default ───────────────────────────────────────────────────────

test("posture `off` allows everything, including what it would otherwise hold", () => {
  // The property that makes this safe to DEPLOY before anyone decides to arm it.
  // An allowlist gate armed with an empty allowlist holds every link in chat,
  // which is an outage, not a policy.
  for (const text of [
    "https://unknown-site.test/x",
    "look at https://bit.ly/abc",
    "https://xn--pple-43d.com",
  ]) {
    assert.equal(gate(text, "off").action, "allow", `"${text}" was gated while off`);
  }
});

test("a message with no links is allowed at every posture", () => {
  for (const posture of ["off", "flag", "hold"] as const) {
    assert.equal(gateLinks({ text: "just talking", posture, rules: RULES }).action, "allow");
  }
});

// ── The bypasses ─────────────────────────────────────────────────────────────

test("a markdown label cannot smuggle a link past the gate", () => {
  // The bypass that would make the whole gate decorative — and multi-word
  // labels widen exactly this door.
  const v = gate("[a totally normal site](https://unknown-site.test/x)");
  assert.equal(v.action, "hold", "a link inside a markdown label was not seen at all");
  assert.equal(v.host, "unknown-site.test");
});

test("pairing an allowed link with an unlisted one does not launder it", () => {
  // Worst-wins, same as the word blocklist. Otherwise every gated link travels
  // alongside a youtube.com link and nothing is ever held.
  const v = gate("https://youtube.com/watch?v=1 and https://unknown-site.test/x");
  assert.equal(v.action, "hold");
  assert.equal(v.host, "unknown-site.test");
});

test("a subdomain does not inherit trust it was explicitly denied", () => {
  // The most specific rule wins, so a hostile child of an allowlisted parent is
  // still held.
  assert.equal(gate("https://example.com/ok").action, "allow", "parent should pass");
  const v = gate("https://bad.example.com/x");
  assert.equal(v.action, "hold", "an explicitly held subdomain rode its parent's allowlist entry");
  assert.equal(v.reason, "listed");
});

test("an ordinary subdomain DOES inherit an allowlist entry", () => {
  // The other direction — otherwise allowlisting a site means allowlisting
  // exactly one hostname of it, and `/whitelist host` becomes useless.
  assert.equal(gate("https://docs.example.com/x").action, "allow");
});

test("a shortener is held even when someone allowlists it", () => {
  // Per-message Allow on shorteners and user-content hosts, NOT allowlisting
  // them. A shortener's host says nothing about where the link goes:
  // allowlisting bit.ly allowlists the whole internet behind it.
  const withRule = gateLinks({
    text: "https://bit.ly/abc",
    posture: "hold",
    rules: [...RULES, { host: "bit.ly", severity: 1 }],
  });
  assert.equal(withRule.action, "hold", "a mod allowlisted a shortener and the gate let it through");
  assert.equal(withRule.reason, "untrustable");
});

test("a user-content host is held even when allowlisted", () => {
  const v = gateLinks({
    text: "https://cdn.discordapp.com/attachments/1/2/x.png",
    posture: "hold",
    rules: [{ host: "cdn.discordapp.com", severity: 1 }],
  });
  assert.equal(v.action, "hold");
  assert.equal(v.reason, "untrustable", "the domain is honest; the FILE is what is unknown");
});

// ── Homograph ────────────────────────────────────────────────────────────────

test("punycode and mixed-script hosts are flagged", () => {
  assert.ok(looksHomographic("xn--pple-43d.com"), "punycode not flagged");
  assert.ok(looksHomographic("pа" + "ypal.com"), "a Cyrillic а inside a Latin label not flagged");
  assert.ok(!looksHomographic("example.com"));
  assert.ok(!looksHomographic("sub.domain.co.uk"));
  assert.ok(!looksHomographic("xn.example.com"), "a label merely containing 'xn' is not punycode");
});

test("homograph beats an allowlist entry", () => {
  // A host that misreads is a problem even if a mod allowlisted the thing it is
  // impersonating — which is the whole point of the attack.
  const v = gateLinks({
    text: "https://xn--pple-43d.com/x",
    posture: "hold",
    rules: [{ host: "xn--pple-43d.com", severity: 1 }],
  });
  assert.equal(v.action, "hold");
  assert.equal(v.reason, "homograph");
});

test("the most informative reason survives when a message has several links", () => {
  const v = gate("https://spam.test/a https://bit.ly/b https://xn--pple-43d.com/c");
  assert.equal(v.action, "hold");
  assert.equal(v.action === "hold" && v.reason, "homograph",
    "the sharpest signal must be the one reported");
});

// ── Extraction ───────────────────────────────────────────────────────────────

test("extraction finds bare URLs and markdown hrefs, and does not double-count", () => {
  assert.deepEqual(extractUrls("plain https://a.test/1 here"), ["https://a.test/1"]);
  assert.deepEqual(extractUrls("[x](https://b.test/2)"), ["https://b.test/2"]);
  // The markdown span is removed before the bare scan, so the href appears once.
  assert.deepEqual(extractUrls("[x](https://c.test/3) and https://d.test/4"),
    ["https://c.test/3", "https://d.test/4"]);
  assert.deepEqual(extractUrls("no links at all"), []);
});

test("the gate judges where a link GOES, not what its label says", () => {
  // This is what the markdown-href branch of extractUrls is actually FOR:
  // deleting that branch changes nothing in any other test, because the
  // bare-URL scan stops at `)` and finds the href anyway. The one case it does
  // change is a URL sitting in the LABEL.
  //
  // A label is not clickable. Judging it would hold messages for a destination
  // nobody can reach, and the deception case ("label claims a domain the href
  // does not go to") is the link-label guard's job — deceptiveLinkHost, which
  // runs after stripBidiControls and is tested separately.
  const v = gateLinks({
    text: "[https://never-seen-before.test](https://example.com/real)",
    posture: "hold",
    rules: RULES,
  });
  assert.equal(v.action, "allow",
    "a URL in the LABEL was judged as if it were a destination — labels are not clickable");

  // …and the href is still judged, so this is not a hole.
  const held = gateLinks({
    text: "[https://example.com](https://never-seen-before.test/real)",
    posture: "hold",
    rules: RULES,
  });
  assert.equal(held.action, "hold", "the real destination stopped being judged");
  assert.equal(held.host, "never-seen-before.test");
});

test("trailing punctuation is not swallowed into the host", () => {
  assert.equal(hostOf(extractUrls("see https://a.test/x).")[0]!), "a.test");
  // The host-final case: "check https://youtube.com." must not judge
  // `youtube.com.` — matching no rule and no baseline entry — or a
  // baseline-allowed host is held as "unlisted" whenever it ends a
  // sentence. Both layers close it: extraction trims, and hostOf drops a
  // trailing (FQDN) dot.
  assert.equal(extractUrls("check https://youtube.com.")[0], "https://youtube.com");
  assert.equal(extractUrls("really! https://youtube.com!?")[0], "https://youtube.com");
  assert.equal(hostOf("https://youtube.com./watch"), "youtube.com");
  assert.equal(gate("check https://youtube.com.").action, "allow",
    "a sentence-final full stop must not defeat the baseline");
  // Markdown hrefs are machine-delimited — a dot typed inside `()` is kept.
  assert.equal(extractUrls("[x](https://a.test/file.)")[0], "https://a.test/file.");
});

test("an uppercase scheme cannot walk past the gate", () => {
  // HTTPS:// works in every browser and every platform linkifier; a
  // lowercase-only scan made the whole gate evadable with caps lock.
  assert.equal(extractUrls("go HTTPS://EVIL.EXAMPLE/x").length, 1);
  const v = gate("go HTTPS://scam.example/free");
  assert.equal(v.action, "hold");
  assert.equal(v.action === "hold" && v.host, "scam.example");
  // …and through a markdown href too.
  assert.equal(gate("[hi](HTTP://scam.example/x)").action, "hold");
});

test("ordinary ASCII oddities in a label are NOT homographs", () => {
  // Regression pin: the script-mix fallback is `[^\x00-\x7f]` (outside ASCII).
  // Written with RAW control bytes it is easily misread as `[^ -]` — a class
  // that would brand every underscore a foreign script, with an unfixable
  // "homograph" hold (homograph outranks the allowlist by design). This pins
  // the behaviour against a well-meaning "fix".
  assert.equal(looksHomographic("foo_bar.example.com"), false);
  assert.equal(looksHomographic("cdn~edge.example.com"), false);
  // The defence-in-depth loop still catches a raw mixed-script label…
  assert.equal(looksHomographic("pаypal.com"), true); // Cyrillic а
  // …and the production path catches the same host post-IDNA.
  assert.equal(hostOf("https://pаypal.com/x"), "xn--pypal-4ve.com");
  assert.equal(looksHomographic("xn--pypal-4ve.com"), true);
});

test("www. is normalised so one rule covers both spellings", () => {
  assert.equal(hostOf("https://www.example.com/x"), "example.com");
  assert.ok(hostMatches("example.com", "www.example.com"));
});

// ── The baseline ─────────────────────────────────────────────────────────────

test("the baseline lets the stream's own links through when first armed", () => {
  // Arming the gate must not instantly hold links to the site itself and the
  // platforms it lives on.
  for (const h of BASELINE_HOSTS) {
    assert.equal(judgeHost(h, []), null, `${h} would be held with no rules configured`);
  }
});

test("the baseline is small — it is a floor, not a curated good-internet list", () => {
  assert.ok(BASELINE_HOSTS.length <= 12,
    "the baseline is growing into a policy; those hosts belong in /whitelist host, not in code");
});

test("an unlisted host is held — default deny", () => {
  const v = gate("https://never-seen-before.test/x");
  assert.equal(v.action, "hold");
  assert.equal(v.reason, "unlisted");
});

// ── Sanity on the shipped list ───────────────────────────────────────────────

test("the untrustable list is lowercase, de-duplicated and host-shaped", () => {
  const seen = new Set<string>();
  for (const h of UNTRUSTABLE) {
    assert.equal(h, h.toLowerCase(), `${h} is not lowercase — hostMatches would miss it`);
    assert.ok(!h.startsWith("www."), `${h} carries a www. prefix that hostOf strips`);
    assert.ok(h.includes("."), `${h} is not a host`);
    assert.ok(!seen.has(h), `${h} is listed twice`);
    seen.add(h);
  }
});

test("every untrustable entry actually trips the check", () => {
  // Guards against an entry that is present but unreachable (e.g. a typo'd TLD
  // that hostMatches can never equal).
  for (const h of UNTRUSTABLE) {
    assert.ok(isUntrustable(h), `${h} is listed but does not match itself`);
    assert.ok(isUntrustable("sub." + h), `${h} does not cover its own subdomains`);
  }
});

// ── Wiring: the properties that only exist at the call sites ────────────────

test("the gate ships DORMANT — the deployed default is `off`", () => {
  // The single most important property of this whole piece. An allowlist gate
  // armed with an empty allowlist holds every link in chat. Deploying must
  // change nothing until a mod decides otherwise, so the DEFAULT lives in the
  // migration, not in a code path someone can forget to take.
  if (!CHAIN) {
    // A fresh install's database is the baseline: the same default and check, as pg_dump writes them.
    const baseline = readFileSync(join(HERE, "../../../migrations/baseline/schema.sql"), "utf8");
    assert.match(baseline, /link_gate text DEFAULT 'off'::text NOT NULL/, "a fresh install's link gate does not default to off");
    assert.match(baseline, /CHECK \(\(link_gate = ANY \(ARRAY\['off'::text, 'flag'::text, 'hold'::text\]\)\)\)/, "a fresh install's posture is not constrained");
    return;
  }
  const sql = readFileSync(join(HERE, "../../../migrations/migrate-v88.sql"), "utf8")
    .split("\n").map((l) => { const i = l.indexOf("--"); return i === -1 ? l : l.slice(0, i); })
    .join("\n");
  assert.match(sql, /link_gate\s+text\s+NOT NULL\s+DEFAULT\s+'off'/i,
    "the link gate no longer defaults to off — deploying would start holding links");
  assert.match(sql, /CHECK\s*\(link_gate\s+IN\s*\(\s*'off',\s*'flag',\s*'hold'\s*\)\)/i,
    "the posture is not constrained; an unparseable value could reach the gate");
});

test("an unrecognised posture is treated as off, never as hold", () => {
  // Defence in depth behind the CHECK: whatever arrives from the database, a
  // value we cannot parse must not be able to start withholding chat.
  for (const bad of ["", "on", "HOLD", "enforce", "true", "1"]) {
    setLinkPosture(bad);
    assert.equal(currentPosture(), "off", `"${bad}" was not treated as off`);
  }
  setLinkPosture("hold");
  assert.equal(currentPosture(), "hold", "a real posture stopped working");
  setLinkPosture("off");
});

test("the send path checks the gate, and flag mode DELIVERS", () => {
  const route = readFileSync(join(HERE, "../api/chat/send/route.ts"), "utf8")
    .split("\n").filter((l) => !l.trimStart().startsWith("//"))
    .map((l) => l.replace(/\/\/.*$/, "")).join("\n");

  assert.match(route, /const linkVerdict = gate\(message\)/, "the send path no longer gates links");
  // The word blocklist must still run FIRST — a slur in a message that also has
  // a link should be judged as a slur, not as a link.
  assert.ok(route.indexOf("classify(message)") < route.indexOf("gate(message)"),
    "the word filter must run before the link gate");
  // flag mode records but does not withhold.
  assert.match(route, /if \(!flagOnly\)/,
    "flag mode no longer falls through to delivery — it would be indistinguishable from hold");
  // recordLinkHit, the link-gate recorder — NOT recordBlocklistHit. Link
  // holds filed as source='blocklist' are not in the resolve route's
  // RELEASABLE set, so Allow would resolve the row without ever delivering the
  // message.
  assert.match(route, /recordLinkHit\(\{/, "a gated link writes no link-gate review row, so nothing is measurable");
  assert.ok(!/recordBlocklistHit\(\{[^}]*linkVerdict/.test(route),
    "the link branch is back on the word recorder — Allow would resolve without delivering");
});

test("flag-mode rows are measurements: 'flagged', never 'pending' (v89)", { skip: HISTORY }, () => {
  // A flag-mode message was DELIVERED. A 'pending' row for it renders
  // Allow/Deny, and Allow republishes the same message a second time.
  const web = stripComments(readFileSync(join(HERE, "blocklistReview.ts"), "utf8"));
  assert.match(web, /flagOnly \? "flagged" : "pending"/,
    "the web recorder writes flag rows as pending — Allow would double-post");
  const api = stripComments(
    readFileSync(join(HERE, "../../../stream-api/blocklist-review.js"), "utf8"));
  assert.match(api, /flagOnly \? 'flagged' : 'pending'/,
    "the stream-api recorder writes flag rows as pending — Allow would double-post");
  // And the DB must admit both new values — the v88 rollout failed exactly
  // here: the source CHECK never learned 'link_gate', so every row the gate
  // recorded violated the constraint and vanished into the best-effort catch.
  const raw = readFileSync(join(HERE, "../../../migrations/migrate-v89.sql"), "utf8");
  const sql = raw.split("\n").map((l) => {
    const i = l.indexOf("--");
    return i === -1 ? l : l.slice(0, i);
  }).join("\n");
  assert.match(sql, /source IN \('twitch','blocklist','account_age','link_gate'\)/,
    "v89 does not admit link_gate as a source — gate rows fail the CHECK silently");
  assert.match(sql, /'flagged'/, "v89 does not admit the flagged status");
});

test("a native pending row releases through /chat/native, not /chat", () => {
  // Releasing a native hold via /chat would re-run stream-api's word blocklist
  // (re-holding the exact message the mod just allowed) and would produce a
  // platform-shaped line instead of a real site.chat_messages row.
  const resolve = stripComments(
    readFileSync(join(HERE, "../api/mod/automod/resolve/route.ts"), "utf8"));
  assert.match(resolve, /isNative = isNativePlatform\(row\.platform\) && !!row\.matrix_id/,
    "native detection is gone from the resolve route");
  assert.match(resolve, /streamApiFetch\("\/chat\/native"/,
    "native rows no longer release through /chat/native");
  assert.match(resolve, /matrixId: row\.matrix_id/,
    "the native release does not carry the sender's identity");
  // The platform path must still exist and still skip the gates via releaseHold.
  assert.match(resolve, /releaseHold: true/, "the platform release path lost its releaseHold flag");
});

test("host rules use the HOST normaliser, never the word one", () => {
  // The bug this prevents: normalizeTerm strips everything but letters, so
  // "example.com" would key as "examplecom" — a rule that can never match. That
  // is the entire reason the table has a `kind` discriminator.
  assert.equal(normalizeHost("Example.COM"), "example.com");
  assert.equal(normalizeHost("https://www.example.com/path?q=1"), "example.com");
  // A pasted URL with a query but NO path must not be refused: splitting off
  // only `/` lets `?x=1` ride into the shape check and tells the mod their
  // perfectly good paste "is not a hostname".
  assert.equal(normalizeHost("https://example.com?x=1"), "example.com");
  assert.equal(normalizeHost("example.com#section"), "example.com");
  // Empty labels are refused, not stored as never-matching rules.
  assert.equal(normalizeHost("example..com"), "", "a double dot is junk, not a rule");
  assert.equal(normalizeHost(".example.com"), "", "a leading dot is junk, not a rule");
  assert.equal(normalizeHost("user@example.com:8443"), "example.com");
  assert.equal(normalizeHost("not a host"), "", "junk must be refused, not stored");
  assert.equal(normalizeHost("localhost"), "", "a bare label is not a host rule");

  const route = readFileSync(join(HERE, "../api/mod/blocklist/route.ts"), "utf8");
  assert.match(route, /kind === "host" \? normalizeHost\(raw\) : normalizeTerm\(raw\)/,
    "the write path uses one normaliser for both kinds — host rules would be unmatched forever");
});
