// Word blocklist for slurs / TOS-violating content (stream-api / platform ingest).
//
// Severity decides the outcome (`actionFor`: 4 block · 2-3 hold · 1 allow).
// A matching platform-ingest message is withheld from site chat and recorded
// for review; nothing in chat is masked with asterisks. The one remaining mask
// is the alert path below, where TTS/OBS have no hold state. The runtime
// override layer (`startOverrideRefresh`) swaps in mod re-grades from
// `site.blocklist_overrides` in the background.
//
// Keep in sync with web/app/lib/blacklist.ts (separate runtimes;
// blacklistParity.test.ts fails on drift).
//
// ── Terms: imported from github.com/dsojevic/profanity-list (MIT, © David
// Sojevic), then re-mapped. Do not re-import naively.
//
// Upstream severity measures how profane a word is, not how much moderator
// attention it needs. Upstream rates common swearing at the top of its scale
// and only a few racial terms there, so imported literally this filter would
// hard-block ordinary swearing and leave actual slurs merely held.
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
const BLOCKLIST = [
  { term: 'analassassin', severity: 4, tags: ['lgbtq'] },
  { term: 'analastronaut', severity: 4, tags: ['lgbtq'] },
  { term: 'arsebandit', severity: 4, tags: ['lgbtq'] },
  { term: 'assbandit', severity: 4, tags: ['lgbtq'] },
  { term: 'battyboi', severity: 4, tags: ['lgbtq'] },
  { term: 'battyboy', severity: 4, tags: ['lgbtq'] },
  { term: 'beaner', severity: 4, tags: ['racial'] },
  { term: 'beaners', severity: 4, tags: ['racial'] },
  { term: 'beanflicker', severity: 4, tags: ['lgbtq'] },
  { term: 'beanqueen', severity: 4, tags: ['lgbtq'] },
  { term: 'bicon', severity: 4, tags: ['lgbtq'] },
  { term: 'bluewaffle', severity: 4, tags: ['shock'] },
  { term: 'bonesmuggler', severity: 4, tags: ['lgbtq'] },
  { term: 'bootybuffer', severity: 4, tags: ['lgbtq'] },
  { term: 'brownieking', severity: 4, tags: ['lgbtq'] },
  { term: 'browniequeen', severity: 4, tags: ['lgbtq'] },
  { term: 'brownpiper', severity: 4, tags: ['lgbtq'] },
  { term: 'buddhahead', severity: 4, tags: ['racial'] },
  { term: 'bufter', severity: 4, tags: ['lgbtq'] },
  { term: 'bufty', severity: 4, tags: ['lgbtq'] },
  { term: 'bulldyke', severity: 4, tags: ['lgbtq'] },
  { term: 'bumboy', severity: 4, tags: ['lgbtq'] },
  { term: 'bumchum', severity: 4, tags: ['lgbtq'] },
  { term: 'bumdriller', severity: 4, tags: ['lgbtq'] },
  { term: 'bumholeengineer', severity: 4, tags: ['lgbtq'] },
  { term: 'bumpilot', severity: 4, tags: ['lgbtq'] },
  { term: 'bumpirate', severity: 4, tags: ['lgbtq'] },
  { term: 'bumrider', severity: 4, tags: ['lgbtq'] },
  { term: 'bumrobber', severity: 4, tags: ['lgbtq'] },
  { term: 'bumrustler', severity: 4, tags: ['lgbtq'] },
  { term: 'buttboy', severity: 4, tags: ['lgbtq'] },
  { term: 'buttholeengineer', severity: 4, tags: ['lgbtq'] },
  { term: 'buttpilot', severity: 4, tags: ['lgbtq'] },
  { term: 'buttpirate', severity: 4, tags: ['lgbtq'] },
  { term: 'buttrider', severity: 4, tags: ['lgbtq'] },
  { term: 'buttrobber', severity: 4, tags: ['lgbtq'] },
  { term: 'buttrustler', severity: 4, tags: ['lgbtq'] },
  { term: 'cameljockey', severity: 4, tags: ['racial'] },
  { term: 'cameljockies', severity: 4, tags: ['racial'] },
  { term: 'carpetmuncher', severity: 4, tags: ['lgbtq'] },
  { term: 'cheeseeatingsurrendermonkey', severity: 4, tags: ['racial'] },
  { term: 'chichiman', severity: 4, tags: ['lgbtq'] },
  { term: 'chickenqueen', severity: 4, tags: ['lgbtq'] },
  { term: 'chinaman', severity: 3, tags: ['racial'] },
  { term: 'chinamen', severity: 3, tags: ['racial'] },
  { term: 'chingchong', severity: 3, tags: ['racial'] },
  { term: 'chink', severity: 4, tags: ['racial'] },
  { term: 'chinks', severity: 4, tags: ['racial'] },
  { term: 'chinky', severity: 4, tags: ['racial'] },
  { term: 'cishet', severity: 4, tags: ['lgbtq'] },
  { term: 'cissie', severity: 4, tags: ['lgbtq'] },
  { term: 'cissy', severity: 4, tags: ['lgbtq'] },
  { term: 'cockpipecosmonaut', severity: 4, tags: ['lgbtq'] },
  { term: 'cockstructionworker', severity: 4, tags: ['lgbtq'] },
  { term: 'coon', severity: 4, tags: ['racial'] },
  { term: 'coons', severity: 4, tags: ['racial'] },
  { term: 'craftybutcher', severity: 4, tags: ['lgbtq'] },
  { term: 'cuntboy', severity: 4, tags: ['lgbtq'] },
  { term: 'currymuncher', severity: 4, tags: ['racial'] },
  { term: 'darkey', severity: 4, tags: ['racial'] },
  { term: 'darkie', severity: 4, tags: ['racial'] },
  { term: 'darkies', severity: 4, tags: ['racial'] },
  { term: 'darky', severity: 4, tags: ['racial'] },
  { term: 'dickgirl', severity: 4, tags: ['lgbtq'] },
  { term: 'donutmuncher', severity: 4, tags: ['lgbtq'] },
  { term: 'donutpuncher', severity: 4, tags: ['lgbtq'] },
  { term: 'dooncoon', severity: 4, tags: ['racial'] },
  { term: 'dunecoon', severity: 4, tags: ['racial'] },
  { term: 'dyke', severity: 4, tags: ['lgbtq'] },
  { term: 'enby', severity: 4, tags: ['lgbtq'] },
  { term: 'eyetie', severity: 3, tags: ['racial'] },
  { term: 'fag', severity: 4, tags: ['lgbtq'] },
  { term: 'fagbomb', severity: 4, tags: ['lgbtq'] },
  { term: 'faggot', severity: 4, tags: ['lgbtq'] },
  { term: 'fagot', severity: 4, tags: ['lgbtq'] },
  { term: 'finocchio', severity: 4, tags: ['lgbtq'] },
  { term: 'finoccio', severity: 4, tags: ['lgbtq'] },
  { term: 'finochio', severity: 4, tags: ['lgbtq'] },
  { term: 'frogeater', severity: 3, tags: ['racial'] },
  { term: 'fudgepacker', severity: 4, tags: ['lgbtq'] },
  { term: 'futanari', severity: 4, tags: ['lgbtq'] },
  { term: 'gaysian', severity: 4, tags: ['lgbtq'] },
  { term: 'ginjockey', severity: 3, tags: ['racial'] },
  { term: 'ginjocky', severity: 3, tags: ['racial'] },
  { term: 'girlscup', severity: 4, tags: ['shock'] },
  { term: 'goatcx', severity: 4, tags: ['shock'] },
  { term: 'goatse', severity: 4, tags: ['shock'] },
  { term: 'golliwog', severity: 3, tags: ['racial'] },
  { term: 'gollywog', severity: 3, tags: ['racial'] },
  { term: 'gook', severity: 4, tags: ['racial'] },
  { term: 'gookeye', severity: 4, tags: ['racial'] },
  { term: 'gookie', severity: 4, tags: ['racial'] },
  { term: 'gooks', severity: 4, tags: ['racial'] },
  { term: 'gooky', severity: 4, tags: ['racial'] },
  { term: 'grayqueen', severity: 4, tags: ['lgbtq'] },
  { term: 'greaseball', severity: 3, tags: ['racial'] },
  { term: 'greyqueen', severity: 4, tags: ['lgbtq'] },
  { term: 'gymbunny', severity: 4, tags: ['lgbtq'] },
  { term: 'hadji', severity: 3, tags: ['racial'] },
  { term: 'haji', severity: 3, tags: ['racial'] },
  { term: 'hajji', severity: 3, tags: ['racial'] },
  { term: 'heimie', severity: 3, tags: ['racial'] },
  { term: 'hermie', severity: 4, tags: ['lgbtq'] },
  { term: 'honkey', severity: 3, tags: ['racial'] },
  { term: 'honkeys', severity: 3, tags: ['racial'] },
  { term: 'honkies', severity: 3, tags: ['racial'] },
  { term: 'honky', severity: 3, tags: ['racial'] },
  { term: 'hymie', severity: 3, tags: ['racial'] },
  { term: 'jigaboo', severity: 4, tags: ['racial'] },
  { term: 'jiggerboo', severity: 4, tags: ['racial'] },
  { term: 'junglebunny', severity: 3, tags: ['racial'] },
  { term: 'kike', severity: 4, tags: ['racial'] },
  { term: 'kittypuncher', severity: 4, tags: ['lgbtq'] },
  { term: 'ladyboy', severity: 4, tags: ['lgbtq'] },
  { term: 'lemonparty', severity: 4, tags: ['shock'] },
  { term: 'lesbo', severity: 4, tags: ['lgbtq'] },
  { term: 'leso', severity: 4, tags: ['lgbtq'] },
  { term: 'lezzie', severity: 4, tags: ['lgbtq'] },
  { term: 'lezzies', severity: 4, tags: ['lgbtq'] },
  { term: 'lightinthefedora', severity: 4, tags: ['lgbtq'] },
  { term: 'lightintheloafers', severity: 4, tags: ['lgbtq'] },
  { term: 'lightinthepants', severity: 4, tags: ['lgbtq'] },
  { term: 'limpwristed', severity: 4, tags: ['lgbtq'] },
  { term: 'manjar', severity: 4, tags: ['shock'] },
  { term: 'meatmasseuse', severity: 4, tags: ['lgbtq'] },
  { term: 'meatspin', severity: 4, tags: ['shock'] },
  { term: 'mrhands', severity: 4, tags: ['shock'] },
  { term: 'muffdiver', severity: 4, tags: ['lgbtq'] },
  { term: 'musclemary', severity: 4, tags: ['lgbtq'] },
  { term: 'negro', severity: 3, tags: ['racial'] },
  { term: 'neonazi', severity: 3, tags: ['racial'] },
  { term: 'nigga', severity: 4, tags: ['racial'] },
  { term: 'nigger', severity: 4, tags: ['racial'] },
  { term: 'niggs', severity: 4, tags: ['racial'] },
  { term: 'nignog', severity: 4, tags: ['racial'] },
  { term: 'oklahomo', severity: 4, tags: ['lgbtq'] },
  { term: 'onecuptwogirls', severity: 4, tags: ['shock'] },
  { term: 'onejaroneman', severity: 4, tags: ['shock'] },
  { term: 'onemanonejar', severity: 4, tags: ['shock'] },
  { term: 'paki', severity: 4, tags: ['racial'] },
  { term: 'pansy', severity: 4, tags: ['lgbtq'] },
  { term: 'peterpuffer', severity: 4, tags: ['lgbtq'] },
  { term: 'petrolsniffer', severity: 4, tags: ['racial'] },
  { term: 'pikey', severity: 4, tags: ['racial'] },
  { term: 'pikeys', severity: 4, tags: ['racial'] },
  { term: 'pisspig', severity: 4, tags: ['lgbtq'] },
  { term: 'poof', severity: 4, tags: ['lgbtq'] },
  { term: 'potatoqueen', severity: 4, tags: ['lgbtq'] },
  { term: 'pussypuncher', severity: 4, tags: ['lgbtq'] },
  { term: 'ricequeen', severity: 4, tags: ['lgbtq'] },
  { term: 'ringraider', severity: 4, tags: ['lgbtq'] },
  { term: 'sandnigger', severity: 4, tags: ['racial'] },
  { term: 'sheepshagger', severity: 3, tags: ['racial'] },
  { term: 'shemale', severity: 4, tags: ['lgbtq'] },
  { term: 'sissy', severity: 4, tags: ['lgbtq'] },
  { term: 'slanteye', severity: 4, tags: ['racial'] },
  { term: 'spearchucker', severity: 4, tags: ['racial'] },
  { term: 'spic', severity: 4, tags: ['racial'] },
  { term: 'spick', severity: 4, tags: ['racial'] },
  { term: 'spicks', severity: 4, tags: ['racial'] },
  { term: 'spics', severity: 4, tags: ['racial'] },
  { term: 'suastika', severity: 3, tags: ['racial'] },
  { term: 'svastika', severity: 3, tags: ['racial'] },
  { term: 'swampguinea', severity: 4, tags: ['racial'] },
  { term: 'swastika', severity: 3, tags: ['racial'] },
  { term: 'switchhitter', severity: 4, tags: ['lgbtq'] },
  { term: 'tgirl', severity: 4, tags: ['lgbtq'] },
  { term: 'timbernigger', severity: 4, tags: ['racial'] },
  { term: 'towelhead', severity: 4, tags: ['racial'] },
  { term: 'trannie', severity: 4, tags: ['lgbtq'] },
  { term: 'tranny', severity: 4, tags: ['lgbtq'] },
  { term: 'transbian', severity: 4, tags: ['lgbtq'] },
  { term: 'tubgirl', severity: 4, tags: ['shock'] },
  { term: 'twink', severity: 4, tags: ['lgbtq'] },
  { term: 'twogirlsonecup', severity: 4, tags: ['shock'] },
  { term: 'wagonburner', severity: 3, tags: ['racial'] },
  { term: 'wetback', severity: 4, tags: ['racial'] },
  { term: 'whigger', severity: 3, tags: ['racial'] },
  { term: 'whitepower', severity: 4, tags: ['racial'] },
  { term: 'wigga', severity: 3, tags: ['racial'] },
  { term: 'wigger', severity: 3, tags: ['racial'] },
  { term: 'zipperhead', severity: 4, tags: ['racial'] },
  { term: 'zippocat', severity: 4, tags: ['shock'] },
];

const BLACKLIST = BLOCKLIST.map((e) => e.term);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word, separator-tolerant, ASCII-letter word boundaries (avoids the
// "Scunthorpe" substring problem). The term is reduced to letters FIRST: that
// keeps the interleaved separator class disjoint from every literal, which is
// what makes the match linear. Without it, a term that itself contains a
// separator-class char (`*`, `-`, `.`, `_`) lets `[\s._*\-]*` overlap the
// literal and backtrack catastrophically on a long punctuation run (ReDoS).
// Returns null for a term with no letters (nothing to match).
function termRegex(term, flags) {
  const letters = String(term).replace(/[^a-z]/gi, '');
  if (!letters) return null;
  // Plural forms are the same slur — mirrors web/app/lib/blacklist.ts. A
  // singular-only boundary would let the plural followed by another word through.
  const sep = '[\\s._*\\-]*';
  const interleave = (s) => s.split('').map(escapeRegex).join(sep);
  const body = letters.endsWith('y')
    ? `${interleave(letters.slice(0, -1))}${sep}(?:y(?:${sep}s)?|i${sep}e${sep}s)`
    : `${interleave(letters)}(?:${sep}e?${sep}s)?`;
  return new RegExp(`(?<![a-zA-Z])${body}(?![a-zA-Z])`, flags);
}

// ── Severity-driven classification — MIRRORS web/app/lib/blacklist.ts ────────
//
// Chat ingest does not mask. A chat message is either bad enough to withhold
// from site chat and put in front of a mod, or it is fine; a starred-out slur is
// neither, and it still shows everyone what was said.
//
// maskBlacklist exists for the ALERT path only, and removing it would be a
// silent regression. Alert text is read aloud by TTS and painted on the OBS
// overlay, and `alert.js` degrades to identity when the dep is missing — so
// dropping the export would not crash anything, it would start reading slurs
// out loud on stream. An alert has no "hold" state, so it masks instead.

// Masks the ACTIVE list, not the shipped one. Compiled from whatever grading
// is live (severity ≥ 2 — an allowed term has no business being starred), and
// rebuilt by setOverrides alongside ENTRY_PATTERNS: a mod's `/blacklist word X`
// must reach the TTS/OBS alert surface — the HIGHEST-amplification one — within
// the same minute it reaches chat, and a `/whitelist`ed term must stop being
// asterisked in alerts.
function maskPatternsFrom(entries) {
  return entries
    .filter((e) => actionFor(e.severity) !== 'allow')
    .map((e) => termRegex(e.term, 'gi'))
    .filter(Boolean);
}
const SHIPPED_MASK_PATTERNS = maskPatternsFrom(BLOCKLIST);
let maskPatterns = SHIPPED_MASK_PATTERNS;

/** ALERT PATH ONLY — see the note above. Chat ingest withholds instead. */
function maskBlacklist(text) {
  let out = String(text);
  for (const re of maskPatterns) out = out.replace(re, (m) => '*'.repeat(m.length));
  return out;
}

function actionFor(severity) {
  if (severity >= 4) return 'block';
  if (severity >= 2) return 'hold';
  return 'allow';
}

function compileTerms(entries) {
  return entries
    .map((entry) => ({ entry, re: termRegex(entry.term, 'i') }))
    .filter((p) => p.re !== null);
}

// ── Runtime overrides ───────────────────────────────────────────────────────
//
// Mirror of web/app/lib/blacklist.ts. Two separate runtimes, one resolution
// order — blacklistParity.test.ts asserts they agree, for the override layer as
// well as the shipped list. Overrides let mods correct a grading mid-stream
// without a deploy.

/**
 * Terms are keyed by their LETTERS, lowercased — the matcher reduces terms to
 * letters anyway, so "Twink" / "twink" / "tw.ink" are one word but three raw
 * strings. Without this a re-grade silently ADDS an entry instead of replacing
 * the shipped one, and the shipped severity stays in force.
 */
function normalizeTerm(term) {
  return String(term).toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * Shipped entries with overrides applied on top: an override replaces a shipped
 * severity (tags kept — a re-grade doesn't change what KIND of term it is) or
 * adds an unlisted term. Pure; exported for the parity test.
 */
function applyOverrides(shipped, overrides) {
  const bySeverity = new Map();
  for (const o of overrides || []) {
    const key = normalizeTerm(o.term);
    if (key) bySeverity.set(key, o.severity);
  }
  const out = [];
  const seen = new Set();
  for (const entry of shipped) {
    const key = normalizeTerm(entry.term);
    seen.add(key);
    const override = bySeverity.get(key);
    out.push(override === undefined ? entry : { ...entry, severity: override });
  }
  for (const [key, severity] of bySeverity) {
    if (!seen.has(key)) out.push({ term: key, severity, tags: ['override'] });
  }
  return out;
}

const SHIPPED_PATTERNS = compileTerms(BLOCKLIST);

// THE HOT PATH STAYS SYNCHRONOUS. Every ingested platform message calls
// classify(); the override store refreshes in the BACKGROUND and swaps this
// reference, so no chat message ever waits on the database.
// Replaced wholesale, never mutated — a message classified mid-refresh sees one
// consistent list, not a half-applied one.
let ENTRY_PATTERNS = SHIPPED_PATTERNS;

/**
 * `[]` means "no overrides exist" (back to shipped grading) and is NOT the
 * same as "the read failed" — the loader must never call this on an error, or a
 * DB blip would silently revert every mod re-grade.
 */
function setOverrides(overrides) {
  const active = (overrides && overrides.length)
    ? applyOverrides(BLOCKLIST, overrides)
    : null;
  ENTRY_PATTERNS = active ? compileTerms(active) : SHIPPED_PATTERNS;
  // The alert mask rides the same swap — see maskPatternsFrom. Both references
  // are replaced in one synchronous tick, so no caller sees a half-applied set.
  maskPatterns = active ? maskPatternsFrom(active) : SHIPPED_MASK_PATTERNS;
}


// Highest-severity match, not the first — otherwise the order of the term
// list silently decides whether a slur blocks or merely holds.
function classifyWith(patterns, text) {
  let worst = null;
  for (const { entry, re } of patterns) {
    if (!re.test(text)) continue;
    if (!worst || entry.severity > worst.severity) worst = entry;
  }
  if (!worst) return { action: 'allow' };
  const action = actionFor(worst.severity);
  if (action === 'allow') return { action: 'allow' };
  return { action, term: worst.term, severity: worst.severity, tags: worst.tags || [] };
}

function classify(text) {
  return classifyWith(ENTRY_PATTERNS, String(text));
}

// ── Loading overrides from the database ─────────────────────────────────────
//
// Mirrors web/app/lib/blocklistOverrides.ts. Kept in THIS file rather than a
// sibling module because stream-api deploys as a flat set of files and one more
// module for ~30 lines buys nothing — but the semantics below are the same ones,
// and they are the part that matters.

// The cycle with link-gate.js is real (it requires this module for
// `actionFor`), but THIS require's position changes nothing — module.exports
// is assigned at the bottom of both files either way. The actual cycle-breaker
// is link-gate's memoised lazy require of actionFor; see the note there.
const linkGate = require('./link-gate');

const OVERRIDE_REFRESH_MS = 60_000;
let overrideTimer = null;
let everLoaded = false;
// Refreshes are SERIALISED. A route-triggered refresh (a mod just wrote a
// rule and awaits it) must start after any in-flight timer refresh finishes —
// otherwise the timer's read, started before the write, can land LAST and
// silently revert the mod's change until the next tick.
let refreshChain = Promise.resolve();

/**
 * FAILURE SEMANTICS, spelled out because getting them wrong fails OPEN:
 *   • zero rows  → a real answer ("no overrides"); installs the shipped grading.
 *   • read fails, never loaded → shipped list stays. Strictest available state.
 *   • read fails AFTER a good load → the last known set STAYS. Reverting would
 *     undo a mod's mid-stream whitelisting the moment the DB blips.
 * Never MORE open than a minute ago, which is the property that matters.
 */
function refreshOverrides(pool) {
  const run = refreshChain.then(() => doRefreshOverrides(pool));
  refreshChain = run.catch(() => {});
  return run;
}

async function doRefreshOverrides(pool) {
  try {
    // Rules AND posture in ONE statement — one MVCC snapshot, so arming the
    // gate can never be seen a refresh apart from the allowlist it depends on
    // (held-everything-the-mod-just-allowlisted is the failure this closes).
    // The posture rides along as a sentinel row; severity is unused for it.
    const { rows } = await pool.query(
      `SELECT kind, term, severity FROM site.blocklist_overrides
       UNION ALL
       SELECT 'posture', link_gate, 1 FROM site.lockdown WHERE id = 1`
    );
    const posture = rows.find((r) => r.kind === 'posture');
    // Re-validated on READ. The DB CHECK caps severity at 3, but a row written
    // before the constraint (or by hand in psql) must not be able to turn on
    // blocking from data.
    const valid = rows.filter((r) => r.kind !== 'posture' && r.severity >= 1 && r.severity <= 3);
    const overrides = valid
      .filter((r) => r.kind === 'word')
      .map((r) => ({ term: r.term, severity: r.severity }));
    const hosts = valid
      .filter((r) => r.kind === 'host')
      .map((r) => ({ host: r.term, severity: r.severity }));

    setOverrides(overrides);
    linkGate.setHostRules(hosts);
    linkGate.setLinkPosture((posture && posture.term) || 'off');
    everLoaded = true;
    return { ok: true, count: overrides.length + hosts.length };
  } catch (e) {
    console.warn('[blocklist] override refresh failed:', e.message,
      everLoaded ? '(keeping the last known set)' : '(shipped list still in force)');
    return { ok: false, error: e.message };
  }
}

/** Start the refresh loop. `unref` so it never holds the process open. */
function startOverrideRefresh({ pool, intervalMs = OVERRIDE_REFRESH_MS }) {
  if (overrideTimer) return;
  refreshOverrides(pool).catch(() => {});
  overrideTimer = setInterval(() => { refreshOverrides(pool).catch(() => {}); }, intervalMs);
  if (overrideTimer.unref) overrideTimer.unref();
}

module.exports = {
  BLACKLIST, BLOCKLIST, termRegex, maskBlacklist, actionFor, compileTerms, classifyWith, classify,
  normalizeTerm, applyOverrides, setOverrides,
  // `refreshOverrides` is deliberately NOT exported. `startOverrideRefresh`
  // is the entry point: it does the first load AND installs the interval, and
  // it serialises refreshes so a mod's write cannot be reverted by a timer read
  // that started earlier. A caller reaching past it for a bare refresh would get
  // neither guarantee. (The names above are shared with the web twin; these two
  // are server-only, which is why the two surfaces are not identical here the
  // way link-gate's are.)
  startOverrideRefresh,
};
