// Word blocklist for slurs / TOS-violating content — the web (native-send) copy.
//
// Severity decides the outcome (`actionFor`: ≥4 block · 2-3 hold · 1 allow).
// A blocked native send is refused with a review row; a held one is genuinely
// withheld until a mod allows or denies. Platform ingest (stream-api) withholds
// the same way — nothing in chat is masked with asterisks; the one mask is
// stream-api's ALERT path, where TTS/OBS have no hold state.
//
// On top of the shipped list sits the runtime override layer:
// `setOverrides` swaps in mod re-grades from `site.blocklist_overrides`
// (`/blacklist`, `/whitelist` in chat), refreshed in the background.
//
// IMPORTANT: keep this file in sync with `stream-api/blacklist.js` — separate
// runtimes, no shared import. `blacklistParity.test.ts` imports BOTH copies and
// fails if the term lists or the matcher diverge — which is why `termRegex` is
// exported here (stream-api exports it for the same reason). It is not part of
// the module's real API; do not build on it.
export type Severity = 1 | 2 | 3 | 4;

/**
 * One blocklist entry. Severity is what decides the OUTCOME:
 *   4 severe → BLOCK: never delivered, recorded for review. Deliberately not
 *              "held" — a queue whose Allow button publishes a slur is one
 *              mis-click from the worst outcome. Mods moderate the person.
 *   2-3 mid  → HOLD: withheld until a mod allows or denies.
 *   1 mild   → allowed through; no review row, no interruption.
 *
 * `tags` mirror the categories maintained lists use (general / lgbtq / racial /
 * religious / sexual / shock) so a review row can say WHY, not just "blocked".
 */
export type BlockTerm = { term: string; severity: Severity; tags?: string[] };

// Keep terms lowercase and letters-only; the matcher handles case and
// separator-evasion ("n i g g e r", "n.i.g.g.e.r") on its own, and
// letter-lookaround boundaries mean substrings inside longer words never fire
// ("Scunthorpe", "assassin", "Penistone" are all clean).
//
// Sourcing: prefer importing a MAINTAINED list with severities and categories
// over hand-authoring — a hand-rolled list goes stale, misses variants, and
// makes this repo the maintainer of a slur catalogue. Hence the import below.
// ── Terms: imported from github.com/dsojevic/profanity-list (MIT, © David
// Sojevic), then RE-MAPPED. Do not re-import naively.
//
// Upstream severity measures HOW PROFANE, not how much moderator attention a
// word needs — they are different axes. Upstream rates `fuck` 4, `shit` 2,
// `bitch` 3, while only THREE racial terms reach 4. Imported literally, this
// filter would hard-block ordinary swearing on a political-commentary stream
// and leave actual slurs merely "held".
//
// So the mapping is by CATEGORY, not raw severity:
//   • kept:     racial, lgbtq, shock  — identity-hate; a mod needs to see these
//   • dropped:  general, sexual, religious — ordinary profanity, not a
//               moderation event here, and holding it would flood the queue
//   • block(4): kept tags at upstream severity >= 3
//   • hold(3):  kept tags at upstream severity 2
//
// Upstream `match` syntax (`|` alternatives, `*` repetition) is expanded to
// plain letter terms; our matcher supplies its own separator tolerance. Terms
// under 3 letters are dropped — they are false-positive machines.
//
// To change what is blocked, edit BOTH copies (parity-tested) — or better,
// re-run the mapping and regenerate.
export const BLOCKLIST: BlockTerm[] = [
  { term: "analassassin", severity: 4, tags: ["lgbtq"] },
  { term: "analastronaut", severity: 4, tags: ["lgbtq"] },
  { term: "arsebandit", severity: 4, tags: ["lgbtq"] },
  { term: "assbandit", severity: 4, tags: ["lgbtq"] },
  { term: "battyboi", severity: 4, tags: ["lgbtq"] },
  { term: "battyboy", severity: 4, tags: ["lgbtq"] },
  { term: "beaner", severity: 4, tags: ["racial"] },
  { term: "beaners", severity: 4, tags: ["racial"] },
  { term: "beanflicker", severity: 4, tags: ["lgbtq"] },
  { term: "beanqueen", severity: 4, tags: ["lgbtq"] },
  { term: "bicon", severity: 4, tags: ["lgbtq"] },
  { term: "bluewaffle", severity: 4, tags: ["shock"] },
  { term: "bonesmuggler", severity: 4, tags: ["lgbtq"] },
  { term: "bootybuffer", severity: 4, tags: ["lgbtq"] },
  { term: "brownieking", severity: 4, tags: ["lgbtq"] },
  { term: "browniequeen", severity: 4, tags: ["lgbtq"] },
  { term: "brownpiper", severity: 4, tags: ["lgbtq"] },
  { term: "buddhahead", severity: 4, tags: ["racial"] },
  { term: "bufter", severity: 4, tags: ["lgbtq"] },
  { term: "bufty", severity: 4, tags: ["lgbtq"] },
  { term: "bulldyke", severity: 4, tags: ["lgbtq"] },
  { term: "bumboy", severity: 4, tags: ["lgbtq"] },
  { term: "bumchum", severity: 4, tags: ["lgbtq"] },
  { term: "bumdriller", severity: 4, tags: ["lgbtq"] },
  { term: "bumholeengineer", severity: 4, tags: ["lgbtq"] },
  { term: "bumpilot", severity: 4, tags: ["lgbtq"] },
  { term: "bumpirate", severity: 4, tags: ["lgbtq"] },
  { term: "bumrider", severity: 4, tags: ["lgbtq"] },
  { term: "bumrobber", severity: 4, tags: ["lgbtq"] },
  { term: "bumrustler", severity: 4, tags: ["lgbtq"] },
  { term: "buttboy", severity: 4, tags: ["lgbtq"] },
  { term: "buttholeengineer", severity: 4, tags: ["lgbtq"] },
  { term: "buttpilot", severity: 4, tags: ["lgbtq"] },
  { term: "buttpirate", severity: 4, tags: ["lgbtq"] },
  { term: "buttrider", severity: 4, tags: ["lgbtq"] },
  { term: "buttrobber", severity: 4, tags: ["lgbtq"] },
  { term: "buttrustler", severity: 4, tags: ["lgbtq"] },
  { term: "cameljockey", severity: 4, tags: ["racial"] },
  { term: "cameljockies", severity: 4, tags: ["racial"] },
  { term: "carpetmuncher", severity: 4, tags: ["lgbtq"] },
  { term: "cheeseeatingsurrendermonkey", severity: 4, tags: ["racial"] },
  { term: "chichiman", severity: 4, tags: ["lgbtq"] },
  { term: "chickenqueen", severity: 4, tags: ["lgbtq"] },
  { term: "chinaman", severity: 3, tags: ["racial"] },
  { term: "chinamen", severity: 3, tags: ["racial"] },
  { term: "chingchong", severity: 3, tags: ["racial"] },
  { term: "chink", severity: 4, tags: ["racial"] },
  { term: "chinks", severity: 4, tags: ["racial"] },
  { term: "chinky", severity: 4, tags: ["racial"] },
  { term: "cishet", severity: 4, tags: ["lgbtq"] },
  { term: "cissie", severity: 4, tags: ["lgbtq"] },
  { term: "cissy", severity: 4, tags: ["lgbtq"] },
  { term: "cockpipecosmonaut", severity: 4, tags: ["lgbtq"] },
  { term: "cockstructionworker", severity: 4, tags: ["lgbtq"] },
  { term: "coon", severity: 4, tags: ["racial"] },
  { term: "coons", severity: 4, tags: ["racial"] },
  { term: "craftybutcher", severity: 4, tags: ["lgbtq"] },
  { term: "cuntboy", severity: 4, tags: ["lgbtq"] },
  { term: "currymuncher", severity: 4, tags: ["racial"] },
  { term: "darkey", severity: 4, tags: ["racial"] },
  { term: "darkie", severity: 4, tags: ["racial"] },
  { term: "darkies", severity: 4, tags: ["racial"] },
  { term: "darky", severity: 4, tags: ["racial"] },
  { term: "dickgirl", severity: 4, tags: ["lgbtq"] },
  { term: "donutmuncher", severity: 4, tags: ["lgbtq"] },
  { term: "donutpuncher", severity: 4, tags: ["lgbtq"] },
  { term: "dooncoon", severity: 4, tags: ["racial"] },
  { term: "dunecoon", severity: 4, tags: ["racial"] },
  { term: "dyke", severity: 4, tags: ["lgbtq"] },
  { term: "enby", severity: 4, tags: ["lgbtq"] },
  { term: "eyetie", severity: 3, tags: ["racial"] },
  { term: "fag", severity: 4, tags: ["lgbtq"] },
  { term: "fagbomb", severity: 4, tags: ["lgbtq"] },
  { term: "faggot", severity: 4, tags: ["lgbtq"] },
  { term: "fagot", severity: 4, tags: ["lgbtq"] },
  { term: "finocchio", severity: 4, tags: ["lgbtq"] },
  { term: "finoccio", severity: 4, tags: ["lgbtq"] },
  { term: "finochio", severity: 4, tags: ["lgbtq"] },
  { term: "frogeater", severity: 3, tags: ["racial"] },
  { term: "fudgepacker", severity: 4, tags: ["lgbtq"] },
  { term: "futanari", severity: 4, tags: ["lgbtq"] },
  { term: "gaysian", severity: 4, tags: ["lgbtq"] },
  { term: "ginjockey", severity: 3, tags: ["racial"] },
  { term: "ginjocky", severity: 3, tags: ["racial"] },
  { term: "girlscup", severity: 4, tags: ["shock"] },
  { term: "goatcx", severity: 4, tags: ["shock"] },
  { term: "goatse", severity: 4, tags: ["shock"] },
  { term: "golliwog", severity: 3, tags: ["racial"] },
  { term: "gollywog", severity: 3, tags: ["racial"] },
  { term: "gook", severity: 4, tags: ["racial"] },
  { term: "gookeye", severity: 4, tags: ["racial"] },
  { term: "gookie", severity: 4, tags: ["racial"] },
  { term: "gooks", severity: 4, tags: ["racial"] },
  { term: "gooky", severity: 4, tags: ["racial"] },
  { term: "grayqueen", severity: 4, tags: ["lgbtq"] },
  { term: "greaseball", severity: 3, tags: ["racial"] },
  { term: "greyqueen", severity: 4, tags: ["lgbtq"] },
  { term: "gymbunny", severity: 4, tags: ["lgbtq"] },
  { term: "hadji", severity: 3, tags: ["racial"] },
  { term: "haji", severity: 3, tags: ["racial"] },
  { term: "hajji", severity: 3, tags: ["racial"] },
  { term: "heimie", severity: 3, tags: ["racial"] },
  { term: "hermie", severity: 4, tags: ["lgbtq"] },
  { term: "honkey", severity: 3, tags: ["racial"] },
  { term: "honkeys", severity: 3, tags: ["racial"] },
  { term: "honkies", severity: 3, tags: ["racial"] },
  { term: "honky", severity: 3, tags: ["racial"] },
  { term: "hymie", severity: 3, tags: ["racial"] },
  { term: "jigaboo", severity: 4, tags: ["racial"] },
  { term: "jiggerboo", severity: 4, tags: ["racial"] },
  { term: "junglebunny", severity: 3, tags: ["racial"] },
  { term: "kike", severity: 4, tags: ["racial"] },
  { term: "kittypuncher", severity: 4, tags: ["lgbtq"] },
  { term: "ladyboy", severity: 4, tags: ["lgbtq"] },
  { term: "lemonparty", severity: 4, tags: ["shock"] },
  { term: "lesbo", severity: 4, tags: ["lgbtq"] },
  { term: "leso", severity: 4, tags: ["lgbtq"] },
  { term: "lezzie", severity: 4, tags: ["lgbtq"] },
  { term: "lezzies", severity: 4, tags: ["lgbtq"] },
  { term: "lightinthefedora", severity: 4, tags: ["lgbtq"] },
  { term: "lightintheloafers", severity: 4, tags: ["lgbtq"] },
  { term: "lightinthepants", severity: 4, tags: ["lgbtq"] },
  { term: "limpwristed", severity: 4, tags: ["lgbtq"] },
  { term: "manjar", severity: 4, tags: ["shock"] },
  { term: "meatmasseuse", severity: 4, tags: ["lgbtq"] },
  { term: "meatspin", severity: 4, tags: ["shock"] },
  { term: "mrhands", severity: 4, tags: ["shock"] },
  { term: "muffdiver", severity: 4, tags: ["lgbtq"] },
  { term: "musclemary", severity: 4, tags: ["lgbtq"] },
  { term: "negro", severity: 3, tags: ["racial"] },
  { term: "neonazi", severity: 3, tags: ["racial"] },
  { term: "nigga", severity: 4, tags: ["racial"] },
  { term: "nigger", severity: 4, tags: ["racial"] },
  { term: "niggs", severity: 4, tags: ["racial"] },
  { term: "nignog", severity: 4, tags: ["racial"] },
  { term: "oklahomo", severity: 4, tags: ["lgbtq"] },
  { term: "onecuptwogirls", severity: 4, tags: ["shock"] },
  { term: "onejaroneman", severity: 4, tags: ["shock"] },
  { term: "onemanonejar", severity: 4, tags: ["shock"] },
  { term: "paki", severity: 4, tags: ["racial"] },
  { term: "pansy", severity: 4, tags: ["lgbtq"] },
  { term: "peterpuffer", severity: 4, tags: ["lgbtq"] },
  { term: "petrolsniffer", severity: 4, tags: ["racial"] },
  { term: "pikey", severity: 4, tags: ["racial"] },
  { term: "pikeys", severity: 4, tags: ["racial"] },
  { term: "pisspig", severity: 4, tags: ["lgbtq"] },
  { term: "poof", severity: 4, tags: ["lgbtq"] },
  { term: "potatoqueen", severity: 4, tags: ["lgbtq"] },
  { term: "pussypuncher", severity: 4, tags: ["lgbtq"] },
  { term: "ricequeen", severity: 4, tags: ["lgbtq"] },
  { term: "ringraider", severity: 4, tags: ["lgbtq"] },
  { term: "sandnigger", severity: 4, tags: ["racial"] },
  { term: "sheepshagger", severity: 3, tags: ["racial"] },
  { term: "shemale", severity: 4, tags: ["lgbtq"] },
  { term: "sissy", severity: 4, tags: ["lgbtq"] },
  { term: "slanteye", severity: 4, tags: ["racial"] },
  { term: "spearchucker", severity: 4, tags: ["racial"] },
  { term: "spic", severity: 4, tags: ["racial"] },
  { term: "spick", severity: 4, tags: ["racial"] },
  { term: "spicks", severity: 4, tags: ["racial"] },
  { term: "spics", severity: 4, tags: ["racial"] },
  { term: "suastika", severity: 3, tags: ["racial"] },
  { term: "svastika", severity: 3, tags: ["racial"] },
  { term: "swampguinea", severity: 4, tags: ["racial"] },
  { term: "swastika", severity: 3, tags: ["racial"] },
  { term: "switchhitter", severity: 4, tags: ["lgbtq"] },
  { term: "tgirl", severity: 4, tags: ["lgbtq"] },
  { term: "timbernigger", severity: 4, tags: ["racial"] },
  { term: "towelhead", severity: 4, tags: ["racial"] },
  { term: "trannie", severity: 4, tags: ["lgbtq"] },
  { term: "tranny", severity: 4, tags: ["lgbtq"] },
  { term: "transbian", severity: 4, tags: ["lgbtq"] },
  { term: "tubgirl", severity: 4, tags: ["shock"] },
  { term: "twink", severity: 4, tags: ["lgbtq"] },
  { term: "twogirlsonecup", severity: 4, tags: ["shock"] },
  { term: "wagonburner", severity: 3, tags: ["racial"] },
  { term: "wetback", severity: 4, tags: ["racial"] },
  { term: "whigger", severity: 3, tags: ["racial"] },
  { term: "whitepower", severity: 4, tags: ["racial"] },
  { term: "wigga", severity: 3, tags: ["racial"] },
  { term: "wigger", severity: 3, tags: ["racial"] },
  { term: "zipperhead", severity: 4, tags: ["racial"] },
  { term: "zippocat", severity: 4, tags: ["shock"] },
];

/** Back-compat view for callers that only need "is this term listed at all". */
// @test-only blacklistParity.test.ts compares the shipped term list against stream-api.
export const BLACKLIST: string[] = BLOCKLIST.map((e) => e.term);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-word match, tolerating separators/symbols between the letters so simple
// spacing/punctuation evasion still trips. Word boundaries use ASCII-letter
// lookaround so substrings inside longer words (the "Scunthorpe" problem) don't match.
// The term is reduced to letters FIRST so the interleaved separator class stays
// disjoint from every literal — that keeps the match linear. Without it, a term
// that itself contains a separator-class char (`*`, `-`, `.`, `_`) lets the
// `[\s._*\-]*` group overlap the literal and backtrack catastrophically on a long
// punctuation run (ReDoS). Returns null for a term with no letters.
// @test-only blacklistParity.test.ts needs the matcher itself; stream-api exports it for the same reason.
export function termRegex(term: string, flags: string): RegExp | null {
  const letters = term.replace(/[^a-z]/gi, "");
  if (!letters) return null;
  // Plural forms are the same slur: without a plural tail the trailing
  // [a-zA-Z] lookaround treats the "s" as "inside a longer word" and lets the
  // plural through. Accept an optional plural tail —
  // s / es, and ies for y-ending terms (tranny → trannies) — with the same
  // separator tolerance as the body. The tail is a fixed optional suffix of
  // literal letters, so the linearity argument above still holds.
  const sep = "[\\s._*\\-]*";
  const interleave = (s: string) => s.split("").map(escapeRegex).join(sep);
  const body = letters.endsWith("y")
    ? `${interleave(letters.slice(0, -1))}${sep}(?:y(?:${sep}s)?|i${sep}e${sep}s)`
    : `${interleave(letters)}(?:${sep}e?${sep}s)?`;
  return new RegExp(`(?<![a-zA-Z])${body}(?![a-zA-Z])`, flags);
}

/**
 * "Would this text be refused as chat?" — the yes/no view for callers with no
 * hold state (the support ticket/report/message routes). Text a mod would at
 * least review must not be acceptable where no mod queue exists.
 *
 * A view over `classify`, NOT a private pattern set. A list compiled from the
 * SHIPPED terms at module load would quietly exempt the runtime override layer
 * in both directions: a mod's `/blacklist word X` would hold chat within a
 * minute while these routes kept accepting X, and a `/whitelist`ed term would
 * stay refused here with no way for any mod to fix it.
 */
export function matchesBlacklist(text: string): boolean {
  return classify(text).action !== "allow";
}

// ── Severity-driven classification ───────────────────────────────────────────
//
// The blocklist answers "what should happen", not just "is this listed?",
// because review is about the PERSON, not only the message — it might need a
// ban. A silently rejected message teaches a mod nothing.
//
// Latency: patterns compile once at module load, so a clean message costs
// only N regex tests over a short string — measured 4.3µs at 50 terms, 41µs at
// 500, against a request already spending tens of ms on network and DB. There
// is deliberately NO I/O here; the review row is written by the caller, only on
// a hit, and only for messages that were never going to be delivered anyway.

export type BlockAction = "allow" | "hold" | "block";

export type Verdict =
  | { action: "allow" }
  | { action: "hold" | "block"; term: string; severity: Severity; tags: string[] };

const ALLOW: Verdict = { action: "allow" };

/** Severity → outcome. The one place the mapping lives. */
export function actionFor(severity: Severity): BlockAction {
  if (severity >= 4) return "block";
  if (severity >= 2) return "hold";
  return "allow";
}

export type CompiledTerm = { entry: BlockTerm; re: RegExp };

/**
 * Pattern per ENTRY (not per term string) so a match carries its severity back.
 *
 * Exported so tests can drive the REAL matching logic with fixtures — the
 * shipped list is empty, and a test that reimplements the worst-match rule
 * locally passes happily while the shipped rule is broken (which is exactly
 * what a break-verify caught here).
 */
// @test-only blocklistClassify.test.ts compiles fixtures without the shipped list.
export function compileTerms(entries: readonly BlockTerm[]): CompiledTerm[] {
  return entries
    .map((entry) => ({ entry, re: termRegex(entry.term, "i") }))
    .filter((p): p is CompiledTerm => p.re !== null);
}

// ── Runtime overrides ────────────────────────────────────────────────────────
//
// A mod-curated layer over the shipped list, so a grading can be corrected
// mid-stream instead of by deploy: a term shipped at severity 4 (block) offers
// no Allow button on its blocked rows, and the list itself is code-only.
//
// An override is a SEVERITY, not a new concept — `actionFor` already defines the
// whole outcome space, so /whitelist is "set 1" and /blacklist is "set 3".

/** A mod's re-grading of one term. Severity is capped at 3 by the DB CHECK. */
export type Override = { term: string; severity: Severity };

/**
 * Terms are keyed by their LETTERS, lowercased.
 *
 * Not cosmetic. The matcher already reduces a term to letters (`termRegex`),
 * so "Twink", "twink" and "tw.ink" all match the same word — but as raw strings
 * they are three different keys. Without this, `/whitelist word Twink` would
 * silently ADD a second entry instead of re-grading the shipped one, and the
 * shipped severity-4 entry would go on blocking.
 */
export function normalizeTerm(term: string): string {
  return term.toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * The effective term list: shipped entries with overrides applied on top.
 *
 * - an override for a term IN the shipped list replaces its severity (tags kept,
 *   because the tag says what KIND of term it is, which a re-grade doesn't change)
 * - an override for a term NOT shipped adds it
 * - anything without an override is untouched
 *
 * Pure, and exported, so both runtimes can be tested against the same fixtures —
 * `blacklistParity.test.ts` asserts they resolve identically.
 */
// @test-only blocklistOverrides.test.ts drives the override layer directly.
export function applyOverrides(
  shipped: readonly BlockTerm[],
  overrides: readonly Override[],
): BlockTerm[] {
  const bySeverity = new Map<string, Severity>();
  for (const o of overrides) {
    const key = normalizeTerm(o.term);
    if (key) bySeverity.set(key, o.severity);
  }
  const out: BlockTerm[] = [];
  const seen = new Set<string>();
  for (const entry of shipped) {
    const key = normalizeTerm(entry.term);
    seen.add(key);
    const override = bySeverity.get(key);
    out.push(override === undefined ? entry : { ...entry, severity: override });
  }
  for (const [key, severity] of bySeverity) {
    if (!seen.has(key)) out.push({ term: key, severity, tags: ["override"] });
  }
  return out;
}

// Compiled ONCE at module load — this is what keeps a clean message at µs.
const SHIPPED_PATTERNS: CompiledTerm[] = compileTerms(BLOCKLIST);

/**
 * What `classify` actually reads. Starts as the shipped list and is REPLACED
 * wholesale by `setOverrides` — never mutated, so a message being classified
 * mid-refresh sees one consistent list rather than a half-applied one.
 *
 * THE HOT PATH STAYS SYNCHRONOUS AND I/O-FREE. Every native send calls
 * `classify`, and "deliberately NO I/O here" (above) is a property worth
 * keeping: awaiting a cache check per message would put the database between
 * a user and their own chat line. So the override store REFRESHES IN THE
 * BACKGROUND and pushes the result here; readers never wait.
 *
 * KEPT ON `globalThis`, NOT IN A MODULE-LEVEL `let`. The compiled Next build
 * gives `instrumentation.ts` its OWN copy of this module, so a refresher
 * started there would update a copy chat never reads — a mod re-grade would
 * work (the route's own refresh reaches the live copy) until the next
 * restart, then silently revert to the shipped grading. One slot keyed by
 * `Symbol.for` is shared by every copy in the process.
 */
type BlocklistStore = { patterns: CompiledTerm[] };
const STORE_KEY = Symbol.for("bb.blocklist");
const slots = globalThis as unknown as Record<symbol, BlocklistStore | undefined>;
const store: BlocklistStore = (slots[STORE_KEY] ??= { patterns: SHIPPED_PATTERNS });

/**
 * Install a new override set. Called by the refresher, not by request paths.
 *
 * Passing `[]` is meaningful — it means "there are no overrides", i.e. back to
 * the shipped grading. It is NOT the same as never having loaded, which is why
 * the loader must distinguish "read zero rows" from "the read failed".
 */
export function setOverrides(overrides: readonly Override[]): void {
  store.patterns = overrides.length === 0
    ? SHIPPED_PATTERNS
    : compileTerms(applyOverrides(BLOCKLIST, overrides));
}


/**
 * What should happen to this message?
 *
 * Returns the HIGHEST-severity match, not the first. A message mixing a mild
 * word with a severe one must be judged on the severe one — taking the first
 * match would let ordering in the term list decide whether a slur is blocked.
 */
// @test-only blocklistClassify.test.ts pins classification against an explicit pattern set.
export function classifyWith(patterns: readonly CompiledTerm[], text: string): Verdict {
  let worst: { entry: BlockTerm } | null = null;
  for (const { entry, re } of patterns) {
    if (!re.test(text)) continue;
    if (!worst || entry.severity > worst.entry.severity) worst = { entry };
  }
  if (!worst) return ALLOW;
  const action = actionFor(worst.entry.severity);
  if (action === "allow") return ALLOW;
  return {
    action,
    term: worst.entry.term,
    severity: worst.entry.severity,
    tags: worst.entry.tags ?? [],
  };
}

/** Production entry point: the shipped list, precompiled. */
export function classify(text: string): Verdict {
  return classifyWith(store.patterns, text);
}
