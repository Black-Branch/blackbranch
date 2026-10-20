// The link gate.
//
// Multi-word markdown labels are allowed, with a link allowlist: a link from an
// unlisted host is treated exactly like a mid-severity word — HELD for a mod
// to approve, not destroyed. That reuses the word blocklist's whole outcome
// vocabulary (`actionFor`: 1 allow · 2-3 hold · ≥4 block) and the same review
// queue.
//
// THIS SHIPS DORMANT. An allowlist-based gate armed with an empty allowlist
// holds EVERY link in chat, which is not a moderation policy, it is an outage.
// The posture lever (site.lockdown.link_gate) defaults to `off`, and `flag` sits
// between off and on so the impact can be MEASURED on a real stream before
// anyone arms it. Same shape as the minimum-account-age lever, which is
// dormant at 0 and does no I/O until a mod arms it.
//
// Pure and dependency-free: no DB, no fetch, no clock beyond what is passed in.
// The host rules arrive from the same runtime-override layer as word re-grades.

// `.ts` extension REQUIRED — this module is exercised under `node --test`,
// which cannot resolve extensionless TypeScript specifiers. `tsconfig` sets
// `allowImportingTsExtensions`, and every tested lib here does the same.
// Dropping it does not fail the build; it kills this file's suite.
import { actionFor, type Severity } from "./blacklist.ts";
import { installValue } from "./installValues.ts";

export type LinkPosture = "off" | "flag" | "hold";

/** A mod's rule for one host. Severity 1 = allowlisted; 2-3 = always held. */
export type HostRule = { host: string; severity: Severity };

export type LinkReason =
  /** No rule, and the gate is armed — the default-deny case. */
  | "unlisted"
  /** A mod explicitly graded this host as hold-worthy. */
  | "listed"
  /** Shortener or user-content host — see UNTRUSTABLE below. */
  | "untrustable"
  /** Punycode or mixed-script host: the domain does not read as what it is. */
  | "homograph";

export type LinkVerdict =
  | { action: "allow" }
  | { action: "hold"; host: string; reason: LinkReason; url: string };

const ALLOW: LinkVerdict = { action: "allow" };

// ── Extraction ───────────────────────────────────────────────────────────────

/**
 * Every http(s) URL in the text, including the hrefs of markdown links.
 *
 * Markdown hrefs are extracted FIRST and their spans removed, so
 * `[click](https://evil.com)` yields the href once rather than the href plus a
 * fragment of the same string. A gate that missed markdown hrefs would be
 * trivially bypassed by wrapping the link in a label — and multi-word labels
 * widen that door.
 *
 * Case-INSENSITIVE on the scheme. `HTTPS://scam.example` is a working link in
 * every browser and in every platform's own linkifier; a lowercase-only scan
 * would make the whole gate evadable with the caps-lock key. (The site's renderer is
 * lowercase-only and will not linkify it — the gate must be the wider net.)
 *
 * Trailing sentence punctuation is trimmed from BARE urls. "check
 * https://youtube.com." keeps the full stop out of the host; without this the
 * gate would judge `youtube.com.` — no rule, no baseline entry matches — and a
 * baseline-allowed host would be held as "unlisted" every time it ended a sentence.
 * Markdown hrefs are NOT trimmed: their end is machine-delimited by `)`.
 */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  const md = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/gi;
  const rest = String(text).replace(md, (_m, href: string) => {
    out.push(href);
    return " ";
  });
  for (const m of rest.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    out.push(m[0].replace(/[.,!?;:…]+$/, ""));
  }
  return out;
}

/** Lowercased hostname with a leading `www.` dropped, or null if unparseable. */
// @test-only linkGate.test.ts exercises host extraction directly.
export function hostOf(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase();
    // A trailing dot is DNS for "fully qualified" — same host, so judge it as
    // the same host. Left in place it matches no rule and no baseline entry.
    return h.replace(/\.$/, "").replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** Does `host` equal `rule`, or sit beneath it as a subdomain?
 *
 *  @test-only no production caller outside this file: judgeHost and the
 *  baseline check below are how the gate uses it. It stays exported for two
 *  reasons — linkGate.test.ts checks the subdomain rule directly (the `.`
 *  prefix is what stops `notexample.com` matching `example.com`), and
 *  stripTracking.ts's header instructs the next person adding a per-host
 *  exception to import THIS rather than write a near-copy. That note is the
 *  only thing standing between one host compare and two that disagree. */
export function hostMatches(host: string, rule: string): boolean {
  const r = rule.toLowerCase().replace(/^www\./, "");
  return host === r || host.endsWith("." + r);
}

// ── Hosts that can never be trusted WHOLESALE ────────────────────────────────
//
// There is always still a per-message Allow for user-content hosts and
// shorteners.
//
// Two different problems, one answer. A shortener's host tells you nothing about
// where the link goes — allowlisting `bit.ly` allowlists the entire internet
// behind it. A user-content host (a CDN anyone can upload to) is honest about
// the domain and says nothing about the FILE. In both cases the host is simply
// not the unit of trust, so it stays hold-worthy no matter what the allowlist
// says — while the per-message Allow in the queue keeps working.
//
// This list is deliberately code-shipped and NOT runtime-editable. A mod being
// able to allowlist `bit.ly` mid-stream is the one edit that would quietly undo
// the whole gate, and "I trusted a shortener once" is not recoverable — the link
// is already clicked.
// @test-only linkGateParity.test.ts pins the code-shipped untrustable classes.
export const UNTRUSTABLE: readonly string[] = [
  // shorteners
  "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "buff.ly", "is.gd",
  "cutt.ly", "rebrand.ly", "shorturl.at", "rb.gy", "t.ly", "shorte.st",
  "adf.ly", "bl.ink", "lnkd.in", "tiny.cc", "s.id", "v.gd", "clck.ru",
  // platform-native shorteners
  "youtu.be", "redd.it", "fb.me", "amzn.to", "spoti.fi",
  // user-content hosts: the domain is honest, the file is not
  "cdn.discordapp.com", "media.discordapp.net", "files.catbox.moe",
  "anonfiles.com", "gofile.io", "mega.nz", "pixeldrain.com",
  "transfer.sh", "file.io", "0x0.st", "temp.sh", "litter.catbox.moe",
  "pastebin.com", "paste.ee", "hastebin.com", "ghostbin.co",
];

// @test-only linkGateParity.test.ts checks both runtimes agree.
export function isUntrustable(host: string): boolean {
  return UNTRUSTABLE.some((u) => hostMatches(host, u));
}

// ── Homograph / IDN ──────────────────────────────────────────────────────────

/**
 * Does this host try to LOOK like something it is not?
 *
 * Two signals, both cheap and both high-signal:
 *   • punycode (`xn--`) — a non-ASCII domain rendered in ASCII. Legitimate for
 *     genuinely international sites, and also exactly how `аpple.com` (Cyrillic
 *     а) reaches the wire.
 *   • mixed scripts inside one label — `pаypal` with one Cyrillic character is
 *     the canonical attack and is invisible to a reader.
 *
 * This FLAGS, it does not block. A punycode domain is not evidence of an
 * attack — it is evidence that the rendered name and the real name differ, which
 * is a thing a moderator should look at once. Treating it as proof would hold
 * every legitimate non-Latin domain forever.
 */
// @test-only linkGate.test.ts pins the IDN flag (never a block).
export function looksHomographic(host: string): boolean {
  if (host.includes("xn--")) return true;
  for (const label of host.split(".")) {
    const scripts = new Set<string>();
    for (const ch of label) {
      if (/[a-z0-9-]/.test(ch)) { scripts.add("latin"); continue; }
      if (/[Ѐ-ӿ]/.test(ch)) scripts.add("cyrillic");
      else if (/[Ͱ-Ͽ]/.test(ch)) scripts.add("greek");
      else if (/[԰-֏]/.test(ch)) scripts.add("armenian");
      else if (/[^\x00-\x7f]/.test(ch)) scripts.add("other");
      if (scripts.size > 1) return true;
    }
  }
  return false;
}

// ── The gate ─────────────────────────────────────────────────────────────────

/**
 * A baseline of hosts that are allowed before any mod has configured anything.
 *
 * Small on purpose, and NOT a curated view of the good internet. It exists so
 * that arming the gate for the first time does not instantly hold the platforms
 * the stream lives on; the site's own domain comes from siteHosts(). Everything
 * else is the mods' to add with `/whitelist host`.
 */
// @test-only linkGate.test.ts + linkGateParity.test.ts pin the shipped host set.
export const BASELINE_HOSTS: readonly string[] = [
  "twitch.tv", "youtube.com", "kick.com", "stream.place",
  "wikipedia.org", "wikimedia.org",
];

/** The install's own domain, and through hostMatches every subdomain of it (the site, its API,
 *  its community server): the install key matrix.serverName. Unset = none. Identical to
 *  stream-api's siteHosts (linkGateParity.test.ts). */
function siteHosts(): string[] {
  const name = installValue("matrix.serverName");
  return name ? [name.toLowerCase()] : [];
}

export type GateInput = {
  text: string;
  posture: LinkPosture;
  /** Mod-set host rules, from the runtime override layer. */
  rules: readonly HostRule[];
};

/**
 * The worst verdict across every link in the message.
 *
 * WORST-WINS, matching the word blocklist. A message pairing an allowlisted
 * link with an unlisted one must be judged on the unlisted one, or the gate is
 * bypassed by including a link to youtube.com alongside anything.
 */
export function gateLinks({ text, posture, rules }: GateInput): LinkVerdict {
  if (posture === "off") return ALLOW;

  const urls = extractUrls(text);
  if (urls.length === 0) return ALLOW;

  let worst: LinkVerdict = ALLOW;
  // Reasons in descending order of how much a mod wants to see them, so the
  // verdict a message carries is the most informative one, not the first.
  const RANK: Record<LinkReason, number> = {
    homograph: 4, untrustable: 3, listed: 2, unlisted: 1,
  };

  for (const url of urls) {
    const host = hostOf(url);
    // An http(s) string we cannot parse a host from is not a link we can judge.
    // It is also not a link a browser will follow, so it is left alone.
    if (!host) continue;

    const reason = judgeHost(host, rules);
    if (!reason) continue;
    if (worst.action === "allow" || RANK[reason] > RANK[worst.reason]) {
      worst = { action: "hold", host, reason, url };
    }
  }
  return worst;
}

/**
 * Why this host would be held, or null if it passes.
 *
 * ORDER IS THE POLICY, and it is the part worth reading twice:
 *   1. homograph  — beats everything. A host that misreads is a problem even if
 *                   a mod allowlisted the thing it is impersonating.
 *   2. untrustable — beats an allowlist entry, by design. See UNTRUSTABLE.
 *   3. an explicit mod rule — allow (severity 1) or hold (2-3).
 *   4. the baseline.
 *   5. otherwise: unlisted → held, the default-deny.
 */
export function judgeHost(host: string, rules: readonly HostRule[]): LinkReason | null {
  if (looksHomographic(host)) return "homograph";
  if (isUntrustable(host)) return "untrustable";

  // Most specific rule wins, so `/blacklist host bad.example.com` still bites
  // under a `/whitelist host example.com`.
  let best: HostRule | null = null;
  for (const rule of rules) {
    if (!hostMatches(host, rule.host)) continue;
    if (!best || rule.host.length > best.host.length) best = rule;
  }
  if (best) return actionFor(best.severity) === "allow" ? null : "listed";

  if ([...BASELINE_HOSTS, ...siteHosts()].some((b) => hostMatches(host, b))) return null;
  return "unlisted";
}

// ── Runtime state ────────────────────────────────────────────────────────────
//
// Same shape as the word overrides in blacklist.ts, and for the same reason: the
// gate runs on the send path, so it must be readable SYNCHRONOUSLY. The loader
// refreshes in the background and swaps these references wholesale.
//
// Kept on `globalThis` for the same reason as blacklist.ts's store:
// `instrumentation.ts` gets its own copy of this module in the compiled
// build, so module-level `let`s would leave the refresher updating a copy the
// send path never reads.

type LinkGateStore = { hostRules: readonly HostRule[]; posture: LinkPosture };
const STORE_KEY = Symbol.for("bb.linkGate");
const slots = globalThis as unknown as Record<symbol, LinkGateStore | undefined>;
const store: LinkGateStore = (slots[STORE_KEY] ??= { hostRules: [], posture: "off" });

/**
 * Host rules are keyed by HOSTNAME, not by the word normaliser.
 *
 * This is why the table has a `kind` discriminator instead of one flat list:
 * `normalizeTerm` reduces a term to letters so "tw.ink" keys as "twink", and
 * doing that to a host turns "example.com" into "examplecom" — a rule that can
 * never match anything. Same table, deliberately different normaliser.
 */
export function normalizeHost(raw: string): string {
  let h = String(raw).trim().toLowerCase();
  h = h.replace(/^[a-z]+:\/\//, "");   // tolerate a pasted URL
  h = h.split(/[/?#]/)[0] ?? "";       // …and its path, query or fragment
  h = h.split("@").pop() ?? "";        // …and any userinfo
  h = h.split(":")[0] ?? "";           // …and a port
  h = h.replace(/^www\./, "");
  // Empty labels are refused, not stored: `example..com` passes the shape
  // regex but can never equal a real hostname, so it would sit in the rules
  // table as a no-op with no feedback to the mod who typed it.
  if (h.startsWith(".") || h.includes("..")) return "";
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) ? h : "";
}

export function setHostRules(rules: readonly HostRule[]): void {
  store.hostRules = rules;
}

/** An unrecognised value is treated as `off`, never as `hold`. A posture we
 *  cannot parse must not be able to start withholding chat. */
export function setLinkPosture(p: string): void {
  store.posture = p === "hold" || p === "flag" ? p : "off";
}

export function currentPosture(): LinkPosture {
  return store.posture;
}

export function currentHostRules(): readonly HostRule[] {
  return store.hostRules;
}

/** Production entry point: judge `text` against the live rules and posture. */
export function gate(text: string): LinkVerdict {
  return gateLinks({ text, posture: store.posture, rules: store.hostRules });
}
