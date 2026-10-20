// Where the encrypted plaintext is allowed to be.
//
// The scramble/decrypt split only holds if exactly ONE route ever reads
// `encrypted_text` out of the database. Every other reader of
// site.chat_messages — chat/history, mod/chat-history, vote, pin, purge — names
// its columns explicitly, so the column is invisible to them by default; this
// test is what stops that from quietly changing.
//
// The failure it guards against is not exotic. Someone adds a column to the
// history SELECT, reaches for `m.*` because the list is long, and every
// encrypted message in the backlog is served in clear text to an endpoint that
// is public for non-mod viewers. Nothing else in the system would notice.
//
// Run: node --test app/lib/redactedExposure.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { stripComments } from "./testSource.ts";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The only file permitted to read the plaintext column. */
const DECRYPT_ROUTE = "api/chat/decrypt/[id]/route.ts";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

// Comments are stripped first: a static scan can pass because the name it
// looks for appears only in a comment explaining why it must NOT appear — the
// check satisfied by its own documentation.

const files = sourceFiles(appDir);

test("only the decrypt route reads encrypted_text", () => {
  assert.ok(files.length > 100, "the file walk found suspiciously little to scan");
  const offenders = files
    .filter((f) => stripComments(readFileSync(f, "utf8")).includes("encrypted_text"))
    .map((f) => relative(appDir, f).replaceAll("\\", "/"))
    .filter((rel) => rel !== DECRYPT_ROUTE)
    // chat/history derives the boolean FLAG (`encrypted_text IS NOT NULL`),
    // which is the one non-decrypt use that is safe by construction — it can
    // only ever produce a true/false, never the text. Checked separately below.
    .filter((rel) => rel !== "api/chat/history/route.ts")
    // boards (the Leaderboard's Top messages face) SKIPS redacted rows with
    // `encrypted_text IS NULL` — the same flag-only construction, checked
    // separately below.
    .filter((rel) => rel !== "lib/boards.ts")
    // Delete my account CLEARS the column (`encrypted_text = NULL`) and never reads it —
    // checked separately below.
    .filter((rel) => rel !== "lib/accountDeletion.ts");
  assert.deepEqual(offenders, [], `these read the plaintext column: ${offenders.join(", ")}`);
});

test("account deletion mentions encrypted_text only to clear it, in its two erase forms", () => {
  const src = stripComments(readFileSync(join(appDir, "lib/accountDeletion.ts"), "utf8"));
  const all = src.match(/encrypted_text/g) ?? [];
  const clears = src.match(/encrypted_text\s*=\s*NULL/g) ?? [];
  assert.equal(all.length, clears.length, "account deletion mentions encrypted_text outside a clear");
  assert.equal(clears.length, 2, "expected exactly two clears (the evidence-keeping and the full erase)");
});

test("boards mentions encrypted_text only as the IS NULL skip, exactly once", () => {
  const src = stripComments(readFileSync(join(appDir, "lib/boards.ts"), "utf8"));
  const all = src.match(/encrypted_text/g) ?? [];
  const flagged = src.match(/encrypted_text\s+IS\s+NULL/gi) ?? [];
  assert.equal(all.length, flagged.length, "boards mentions encrypted_text outside an IS NULL test");
  assert.equal(flagged.length, 1, "expected exactly one skip");
});

test("the history route derives only the flag, never selects the text", () => {
  const src = stripComments(
    readFileSync(join(appDir, "api/chat/history/route.ts"), "utf8")
  );
  // Every mention must be inside an IS NOT NULL test. Counting occurrences
  // rather than pattern-matching one of them: a second, bare `m.encrypted_text`
  // added anywhere else in the file would still leave the first match intact
  // and a "does it contain the safe form" assertion green.
  const all = src.match(/encrypted_text/g) ?? [];
  const flagged = src.match(/encrypted_text\s+IS\s+NOT\s+NULL/gi) ?? [];
  assert.equal(all.length, flagged.length,
    "the history route mentions encrypted_text outside an IS NOT NULL test");
  assert.equal(flagged.length, 1, "expected exactly one flag derivation");
});

test("no reader of site.chat_messages uses SELECT *", () => {
  // The column is invisible to explicit column lists — that is the whole
  // defence, and a star select removes it silently for every existing reader at
  // once rather than one at a time.
  for (const f of files) {
    const src = stripComments(readFileSync(f, "utf8"));
    if (!src.includes("site.chat_messages")) continue;
    assert.ok(
      !/SELECT\s+\*\s+FROM\s+site\.chat_messages/i.test(src),
      `${relative(appDir, f)}: SELECT * would expose encrypted_text`
    );
  }
});

test("an opened message renders like any other message, emotes and all", () => {
  // Emotes hide and unhide with the words around them.
  const src = stripComments(readFileSync(join(appDir, "components/RedactedText.tsx"), "utf8"));
  assert.ok(src.trimEnd().endsWith("}"), "RedactedText.tsx truncated");
  // Visible parts and opened parts (a misaligned row opens as the whole
  // plaintext, through the same call) go through renderText with BOTH emote
  // maps and the mention directory. The optional trailing `still` opts (Task
  // 11 — "animated emotes off") is allowed but not required by THIS pattern;
  // stillEmotes.test.ts is what pins that every call also carries it.
  const calls = (src.match(/renderText\(/g) ?? []).length;
  const full = (src.match(/renderText\([^\n]*?, emotes, msgEmotes, directory(?:, \{ still: stillEmotes(?:, mask)? \})?\)/g) ?? []).length;
  assert.ok(calls >= 2, `expected renderText for visible and opened text, found ${calls}`);
  assert.equal(full, calls, "a renderText call is missing an emote map or the mention directory");
  // …and an opened part only once fully OPEN — an emote cannot be walked.
  assert.match(src, /const rich = phase === "open" && plain !== null/,
    "the rich render must be gated on the OPEN phase, not on having the plaintext");

  const caller = stripComments(readFileSync(join(appDir, "features/chat/ChatMessage.tsx"), "utf8"));
  const at = caller.indexOf("<RedactedText");
  assert.notEqual(at, -1, "ChatMessage no longer renders RedactedText");
  const tag = caller.slice(at, caller.indexOf("/>", at));
  for (const prop of ["key={msg.id}", "emotes={emotes}", "msgEmotes={msg.emotes}", "directory={directory}"]) {
    assert.ok(tag.includes(prop), `ChatMessage does not pass ${prop}`);
  }
});

test("the bars are inline spans for every phase, never a <button>", () => {
  // A LAYOUT rule wearing accessibility clothes: a <button> is an atomic
  // inline-block, so it cannot start partway along a line and drops whole to
  // the next one — changing the row's line count.
  const src = stripComments(readFileSync(join(appDir, "components/RedactedText.tsx"), "utf8"));
  assert.ok(!/<button/.test(src), "a <button> is inline-block and changes the row's line count");
  assert.match(src, /role:\s*"button"/, "the sealed bars must still be a button to assistive tech");
  assert.match(src, /tabIndex:\s*0/, "and reachable by keyboard");
  assert.match(src, /e\.key === "Enter" \|\| e\.key === " "/, "role=button needs Enter/Space handled by hand");
  assert.match(src, /= open \? \{\} : \{/, "the interactive props must drop away once open");
});

test("each ||hidden part|| opens on its own tap", () => {
  // "I think i want each ||block|| to be individual taps/clicks for each part."
  // It was one shared phase for the whole message. Each part is now its own
  // component — own phase, own walk, own fetch, own re-seal timer — so opening
  // one cannot open, or hold open, another.
  const src = stripComments(readFileSync(join(appDir, "components/RedactedText.tsx"), "utf8"));
  const at = src.indexOf("function HiddenRun(");
  assert.notEqual(at, -1, "there is no per-part component any more");
  const outer = src.slice(src.indexOf("export function RedactedText("), at);
  assert.match(outer, /r\.hidden\s*\?\s*<HiddenRun key=\{i\}/, "every hidden run must be its own HiddenRun");
  assert.doesNotMatch(outer, /useState|getJson/, "the message-level wrapper holds reveal state again — one tap would open all");
  const part = src.slice(at, src.indexOf("export function RedactedQuote"));
  assert.match(part, /useState<Phase>\("sealed"\)/, "a part must own its phase");
  assert.match(part, /getJson<[^>]*>\(`\/api\/chat\/decrypt\/\$\{messageId\}`\)/, "a part must fetch on its own tap");
  assert.match(part, /cps\.slice\(run\.start, run\.start \+ len\)/, "a part must hold only its OWN slice of the plaintext");
  assert.doesNotMatch(src, /firstHidden/, "only the first part is focusable again — every part is its own control");
});

test("a never-opened part holds no plaintext; an opened one keeps its width; no random glyphs", () => {
  // Under a closed bar that nobody here has opened sits a fixed filler —
  // random glyphs there are a React #418 hydration mismatch. Once THIS viewer
  // has opened a part, its plaintext stays under the re-sealed bar, so the
  // width does not jump a second time on closing.
  const src = stripComments(readFileSync(join(appDir, "components/RedactedText.tsx"), "utf8"));
  assert.match(src, /useState<\{ text: string; aligned: boolean \} \| null>\(null\)/, "a part must start with no plaintext");
  assert.match(src, /redactSegments\(word \?\? fill\(tk\.t\), word === null \? 0 : local\)/,
    "a closed bar must sit over the filler until opened, then over the real words");
  assert.match(src, /walk\(\{ closing: true, next: "sealed" \}\);/,
    "the re-seal must end WITHOUT dropping the words — the width would jump back on close");
  const refused = src.slice(src.indexOf("} catch (e) {"), src.indexOf('setPhase("denied")'));
  assert.match(refused, /setPlain\(null\)/, "a refused re-open must drop the held words — entitlement is checked every time");
  assert.doesNotMatch(src, /Math\.random|scramble\(/, "the painted seal must be deterministic");
});

test("every place that quotes a message draws hidden parts as bars, never raw glyphs", () => {
  // The reply HOVER preview goes through RedactedQuote like the reply line and
  // the composer bar — printing the stored text raw would show the old block
  // cipher.
  for (const [file, pattern] of [
    ["features/chat/ReplyPreview.tsx", /<RedactedQuote text=\{preview\.text\} \/>/],
    ["features/chat/ChatMessage.tsx", /<RedactedQuote text=\{snippet\(msg\.reply_to_text\)\}(?: mask=\{maskSwears\})? \/>/],
    ["features/chat/ChatInput.tsx", /<RedactedQuote text=\{/],
  ] as const) {
    const src = stripComments(readFileSync(join(appDir, file), "utf8"));
    assert.match(src, pattern, `${file} quotes a message without RedactedQuote`);
  }
  const preview = stripComments(readFileSync(join(appDir, "features/chat/ReplyPreview.tsx"), "utf8"));
  const raw = (preview.match(/\{preview\.text\}/g) ?? []).length;
  const quoted = (preview.match(/text=\{preview\.text\}/g) ?? []).length;
  assert.equal(raw, quoted, "the hover preview prints the stored text raw again");
});

test("an opened word is fitted to its sealed width, so nothing moves", () => {
  // Split by word + word shape + fitted: the bar is built from the letters'
  // shapes, and on opening each word is spaced to fill exactly the width it
  // had sealed.
  const src = stripComments(readFileSync(join(appDir, "components/RedactedText.tsx"), "utf8"));
  const tap = src.slice(src.indexOf("const reveal = useCallback"), src.indexOf("await getJson"));
  assert.match(tap, /sealedW\.current = m;/, "the sealed widths must be measured at the tap, BEFORE the plaintext arrives");
  const fit = src.slice(src.indexOf("useLayoutEffect(() => {"), src.indexOf("}, [words, rich, tokens]);"));
  assert.ok(fit.length > 0, "the fit effect is gone");
  assert.match(fit, /w\.style\.letterSpacing = `\$\{\(target - natural\) \/ n\}px`;/, "a text word must be spaced to its sealed width");
  assert.match(fit, /w\.querySelector\("img"\)[\s\S]*w\.style\.width = `\$\{target\}px`;/, "an emote word must be held at its sealed width");
  assert.match(fit, /if \(!words \|\| !sealedW\.current\) \{ spans\.forEach\(clear\); return; \}/,
    "a part with no words (never opened, or refused) must carry no fitting");
  assert.match(src, /<span key=\{k\} data-w=\{k\}>/, "each word must be its own measurable span");
});

// ── The send route: which text goes where ───────────────────────────────────

const route = stripComments(readFileSync(join(appDir, "api/chat/send/route.ts"), "utf8"));

test("the send route was read whole", () => {
  assert.ok(route.trimEnd().endsWith("}") && route.includes('return new Response("OK");\n}'),
    "send route truncated — every negative below would pass on a hole");
});

test("every post to site.test carries the public text, never the plaintext", () => {
  // `message` is the PLAINTEXT after parseRedaction. A /chat/native body that
  // sent it would broadcast hidden words to every viewer and into the 200-line
  // history buffer replayed to everyone who connects later.
  const sites = [...route.matchAll(/streamApiFetch\(`\/chat\/native`/g)].map((m) => m.index!);
  assert.equal(sites.length, 4, `expected the 4 native posts (whole, all, single, plain), found ${sites.length}`);
  for (const at of sites) {
    const body = route.slice(at, route.indexOf("}),", at));
    assert.match(body, /message: red\.publicText,/, `a native post does not send red.publicText:\n${body.slice(0, 200)}`);
    assert.match(body, /\.\.\.redactExtra,/, "a native post drops the plaintext column, so the message could never be opened");
    assert.doesNotMatch(body, /^\s*message,\s*$/m, "a native post sends the bare (plaintext) message");
  }
  assert.match(route, /const redactExtra = red\.redacted \? \{ encryptedText: message \} : \{\};/);
});

test("every platform send carries the [REDACTED] text, never the plaintext", () => {
  const sends = [...route.matchAll(/sendToPlatform\(matrixId, (\w+), ([\w.]+)/g)];
  assert.equal(sends.length, 2, `expected the fan-out and single-target sends, found ${sends.length}`);
  for (const m of sends) {
    assert.ok(m[2] === "red.platformText" || m[2] === "outgoingMessage", `a platform send passes ${m[2]}`);
  }
  assert.match(route, /const outgoingMessage = platformTarget === "youtube" \? await stripLongEmoteNames\(red\.platformText\) : red\.platformText;/,
    "outgoingMessage must derive from red.platformText");
  // The fan-out's echo key must be the text the platforms will send back.
  assert.match(route, /\.\.\.\(red\.redacted \? \{ echoText: red\.platformText \} : \{\}\)/);
});

test("the redaction gates run before anything is posted", () => {
  const gate = route.indexOf("if (red.redacted) {");
  // Every way the text leaves this route. A name that stops matching is a -1,
  // which would win Math.min and fail for the wrong reason — or, reordered,
  // pass over a hole — so each one must be found first.
  const exits = [
    "streamApiFetch(`/chat/native`",
    "sendToPlatform(",
    "deliverChatEvent(",
    "askPronounCommand(",
  ].map((needle) => {
    const at = route.indexOf(needle);
    assert.notEqual(at, -1, `the route no longer contains ${needle} — update this list`);
    return at;
  });
  const firstPost = Math.min(...exits);
  assert.ok(gate !== -1 && gate < firstPost, "a redacted message can be posted before the Supporter gate");
  const block = route.slice(gate, route.indexOf("\n  }\n", gate));
  assert.match(block, /if \(!tier\)[\s\S]*supporter_only/, "non-Supporters are not refused");
  assert.match(block, /credit < REDACT_MIN_CREDIT/, "the social-credit gate is gone");
  assert.match(block, /if \(body\.spend\)[\s\S]*redact_no_spend/, "a bought card/read-aloud could publish hidden words");
  // The filter and length limit judge the plaintext.
  assert.ok(route.indexOf("const message = red.plain;") < route.indexOf("classify(message)"),
    "the word filter must judge the plaintext");
});

test("a truncated message is refused, so a cut can never orphan a closing mark", () => {
  // Truncating `a ||secret …||` past its limit would drop the closing mark,
  // leave the opening one literal, and post the secret in the clear.
  assert.match(route, /const rawTruncated = rawMessage\.length >= rawCap;/);
  assert.match(route, /if \(rawTruncated \|\| message\.length > charLimit\)/);
});

test("personal emotes are never attached to a redacted message", () => {
  // Their keys are words from the plaintext — hidden ones included.
  assert.match(route, /const personalEmotes: Record<string, string> \| null = red\.redacted \? null :/);
});

test("a reply to a site message quotes the stored row, not the client's text", () => {
  // …and only a VISIBLE stored row (the shared rule — messageVisibility.test.ts pins it).
  assert.match(route, /SELECT m\.message FROM site\.chat_messages m WHERE m\.id = \$1 AND \$\{messageVisibleSql\("m"\)\}/);
  assert.match(route, /reply_to_text: quoteText/);
});

test("the decrypt route requires a signed-in viewer before touching the row", () => {
  const src = stripComments(readFileSync(join(appDir, DECRYPT_ROUTE), "utf8"));
  const auth = src.indexOf("requireUser");
  const read = src.indexOf("encrypted_text");
  assert.ok(auth !== -1, "the decrypt route no longer authenticates at all");
  assert.ok(auth < read, "the row is read before the caller is authenticated");
  // The entitlement itself: a 403 for anyone who is not the author, a mod, or a
  // subscriber. Pinned on the guard EXPRESSION, not on the names appearing
  // somewhere — `assert.match(src, /supporter_only/)` would pass against a
  // commented-out branch or an unreachable one.
  assert.match(src, /if\s*\(\s*!isAuthor\s*&&\s*!isMod\s*&&\s*tier\s*==\s*null\s*\)/,
    "the supporter/mod/author gate is not in the shape the route documents");
});
