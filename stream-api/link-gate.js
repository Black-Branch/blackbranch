// The link gate — stream-api mirror of web/app/lib/linkGate.ts.
//
// Two runtimes, one policy. The web copy gates NATIVE sends (the sender is told
// and can edit); this one gates PLATFORM INGEST. Same detection, same ordering,
// same reasons — different response, which is the asymmetry the word blocklist
// already documents: a platform message is already public over there, so there
// is nobody here to refuse.
//
// LinkGateParity.test.ts imports BOTH and fails on divergence. Anything added
// here has to be added there, and the resolution ORDER is part of the contract,
// not just the outcome.

// LAZY, and it has to be. blacklist.js requires THIS module (its refresher
// installs our host rules), so a top-level destructure here reads `actionFor`
// off a half-initialised module and gets `undefined` — which then throws on the
// FIRST RULE LOOKUP rather than at load, i.e. it surfaces as a mystery runtime
// error under one specific posture instead of a startup failure. (It did.)
//
// Memoised after the first call: `require` is a cache hit, but this is the
// ingest hot path and there is no reason to pay for it per message.
//
// Deliberately NOT solved by copying actionFor here. One severity→outcome
// mapping is the entire premise of piece 1; a second copy could disagree with
// the word filter about what severity 1 means.
const { instanceConfig } = require('./instance-config');

let _actionFor = null;
function actionFor(severity) {
  if (!_actionFor) _actionFor = require('./blacklist').actionFor;
  return _actionFor(severity);
}

// ── Extraction ───────────────────────────────────────────────────────────────

/**
 * Every http(s) URL in the text, including markdown hrefs.
 *
 * The markdown branch is not redundant, though it looks it — the bare scan
 * stops at `)` and finds the href anyway. What it changes is a URL in the
 * LABEL: that must NOT be judged, because a label is not clickable and the
 * "label claims a domain the href does not go to" case is a separate check. Deleting
 * this branch breaks exactly one test, which is the one that says so.
 */
function extractUrls(text) {
  const out = [];
  // Case-insensitive on the scheme (HTTPS:// works in every browser — a
  // lowercase-only scan was evadable with caps lock), and trailing sentence
  // punctuation is trimmed from BARE urls so "https://youtube.com." judges
  // youtube.com, not the never-matching "youtube.com.". Markdown hrefs are not
  // trimmed: their end is machine-delimited by `)`.
  const md = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/gi;
  const rest = String(text).replace(md, (_m, href) => { out.push(href); return ' '; });
  for (const m of rest.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    out.push(m[0].replace(/[.,!?;:…]+$/, ''));
  }
  return out;
}

// @parked surface parity with web/app/lib/linkGate.ts: both copies expose the same functions
// (linkGateParity.test.ts, "the two copies expose the SAME SURFACE"). Nothing in stream-api calls it.
function hostOf(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    // Trailing dot = DNS "fully qualified"; same host, judged as the same host.
    return h.replace(/\.$/, '').replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

// @parked surface parity with web/app/lib/linkGate.ts (linkGateParity.test.ts). Nothing in
// stream-api calls it.
function hostMatches(host, rule) {
  const r = String(rule).toLowerCase().replace(/^www\./, '');
  return host === r || host.endsWith('.' + r);
}

// ── Hosts that can never be trusted WHOLESALE ────────────────────────────────
//
// A shortener's host says nothing about where the link goes; a user-content host
// is honest about the domain and silent about the FILE. Per-message Allow keeps
// working for both; wholesale trust does not.
//
// Code-shipped and deliberately NOT runtime-editable — a mod allowlisting
// bit.ly mid-stream is the single edit that would quietly undo the gate.
const UNTRUSTABLE = [
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'buff.ly', 'is.gd',
  'cutt.ly', 'rebrand.ly', 'shorturl.at', 'rb.gy', 't.ly', 'shorte.st',
  'adf.ly', 'bl.ink', 'lnkd.in', 'tiny.cc', 's.id', 'v.gd', 'clck.ru',
  'youtu.be', 'redd.it', 'fb.me', 'amzn.to', 'spoti.fi',
  'cdn.discordapp.com', 'media.discordapp.net', 'files.catbox.moe',
  'anonfiles.com', 'gofile.io', 'mega.nz', 'pixeldrain.com',
  'transfer.sh', 'file.io', '0x0.st', 'temp.sh', 'litter.catbox.moe',
  'pastebin.com', 'paste.ee', 'hastebin.com', 'ghostbin.co',
];

function isUntrustable(host) {
  return UNTRUSTABLE.some((u) => hostMatches(host, u));
}

/**
 * Does this host try to LOOK like something it is not? FLAGS, never blocks — a
 * punycode domain is not evidence of an attack, it is evidence that the rendered
 * name and the real name differ, which is worth one look.
 */
function looksHomographic(host) {
  if (host.includes('xn--')) return true;
  for (const label of host.split('.')) {
    const scripts = new Set();
    for (const ch of label) {
      if (/[a-z0-9-]/.test(ch)) { scripts.add('latin'); continue; }
      if (/[Ѐ-ӿ]/.test(ch)) scripts.add('cyrillic');
      else if (/[Ͱ-Ͽ]/.test(ch)) scripts.add('greek');
      else if (/[԰-֏]/.test(ch)) scripts.add('armenian');
      // The \x00 below is a RANGE ENDPOINT for "is this character outside ASCII", not an attempt
      // to match a control character; no-control-regex cannot tell those apart. Written as a full
      // range on purpose — this scan flags a label that MIXES scripts, so "not ASCII" has to mean
      // every byte above it. The directive must stay the LAST comment line: eslint applies it to
      // the line immediately following, so a line of prose underneath would silently absorb it.
      // eslint-disable-next-line no-control-regex -- \x00 is a range endpoint, see above
      else if (/[^\x00-\x7f]/.test(ch)) scripts.add('other');
      if (scripts.size > 1) return true;
    }
  }
  return false;
}

/** A floor so arming the gate does not instantly hold the stream's own links: the platforms
 *  streams live on, plus the install's own domain (siteHosts). */
const BASELINE_HOSTS = [
  'twitch.tv', 'youtube.com', 'kick.com', 'stream.place',
  'wikipedia.org', 'wikimedia.org',
];

/** The install's own domain, and through hostMatches every subdomain of it (the site, its API,
 *  its community server): the instance key matrix.serverName, read per call. Unset = none. */
function siteHosts() {
  const name = instanceConfig.get('matrix.serverName');
  return name ? [String(name).toLowerCase()] : [];
}

/**
 * ORDER IS THE POLICY:
 *   1. homograph   — beats everything, including an allowlist entry
 *   2. untrustable — beats an allowlist entry, by design
 *   3. an explicit mod rule (most specific wins)
 *   4. the baseline
 *   5. otherwise: unlisted → held
 */
function judgeHost(host, rules) {
  if (looksHomographic(host)) return 'homograph';
  if (isUntrustable(host)) return 'untrustable';

  let best = null;
  for (const rule of rules || []) {
    if (!hostMatches(host, rule.host)) continue;
    if (!best || String(rule.host).length > String(best.host).length) best = rule;
  }
  if (best) return actionFor(best.severity) === 'allow' ? null : 'listed';

  if ([...BASELINE_HOSTS, ...siteHosts()].some((b) => hostMatches(host, b))) return null;
  return 'unlisted';
}

const RANK = { homograph: 4, untrustable: 3, listed: 2, unlisted: 1 };

/** WORST-WINS, matching the word blocklist — otherwise a gated link travels
 *  alongside a youtube.com link and nothing is ever held. */
function gateLinks({ text, posture, rules }) {
  if (posture === 'off') return { action: 'allow' };
  const urls = extractUrls(text);
  if (urls.length === 0) return { action: 'allow' };

  let worst = { action: 'allow' };
  for (const url of urls) {
    const host = hostOf(url);
    if (!host) continue;
    const reason = judgeHost(host, rules);
    if (!reason) continue;
    if (worst.action === 'allow' || RANK[reason] > RANK[worst.reason]) {
      worst = { action: 'hold', host, reason, url };
    }
  }
  return worst;
}

// ── Runtime state ────────────────────────────────────────────────────────────
//
// Read SYNCHRONOUSLY on the ingest hot path; the blacklist refresher swaps these
// wholesale in the background, exactly like the word overrides.

let hostRules = [];
let posture = 'off';

/**
 * Hosts keep their dots. The word normaliser reduces a term to LETTERS, which
 * would turn "example.com" into "examplecom" — a rule that can never match. That
 * is why overrides carry a `kind` discriminator instead of one flat list.
 */
function normalizeHost(raw) {
  let h = String(raw).trim().toLowerCase();
  h = h.replace(/^[a-z]+:\/\//, '');
  h = h.split(/[/?#]/)[0] || '';
  h = h.split('@').pop() || '';
  h = h.split(':')[0] || '';
  h = h.replace(/^www\./, '');
  // Empty labels refused, not stored — `example..com` would be a silent no-op rule.
  if (h.startsWith('.') || h.includes('..')) return '';
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) ? h : '';
}

function setHostRules(rules) { hostRules = rules || []; }

/** An unrecognised posture is `off`, never `hold`. A value we cannot parse
 *  must not be able to start withholding chat. */
function setLinkPosture(p) { posture = (p === 'hold' || p === 'flag') ? p : 'off'; }

function currentPosture() { return posture; }
// @parked surface parity with web/app/lib/linkGate.ts (linkGateParity.test.ts). Nothing in
// stream-api calls it; web's copy feeds the mod routes' link-gate dry run.
function currentHostRules() { return hostRules; }

/** Production entry point: judge `text` against the live rules and posture. */
function gate(text) {
  return gateLinks({ text, posture, rules: hostRules });
}

module.exports = {
  extractUrls, hostOf, hostMatches, judgeHost, gateLinks, gate,
  isUntrustable, looksHomographic, normalizeHost,
  setHostRules, setLinkPosture, currentPosture, currentHostRules,
  UNTRUSTABLE, BASELINE_HOSTS,
};
