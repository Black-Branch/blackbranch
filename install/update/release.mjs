// A release and its signed feed: ONE module for both sides — the box verifies with
// it (blackbranch runs `node release.mjs …` inside the installed release's stream-api image, with no
// network), and tools/release.mjs signs with it. Imports nothing but node's own modules.
//
// The feed (https://blackbranch.app/releases/<channel>.json) is a DSSE envelope
// (https://github.com/secure-systems-lab/dsse): the manifest travels as exact bytes in `payload`
// and every signature is over PAE(payloadType, payload). Nothing is canonicalised — the verifier
// checks the bytes it was given, then parses them — so no two JSON writers can disagree about what
// was signed. Ed25519, through node's crypto.
//
// The box trusts ONE key: `.env`'s BB_RELEASE_KEY ("ed25519:<base64 of the raw 32 bytes>"), written
// by install.sh from install/release-key.pub (or --release-key) and never changed by an update.

import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PAYLOAD_TYPE = "application/vnd.blackbranch.release+json; version=1";
export const CHANNELS = ["stable", "beta"];
/** The images a release pins by digest: the third-party ones, `dockerfile` (BuildKit's Dockerfile
 *  frontend, which runs during the build), and `web` — the site, ONE prebuilt image for every
 *  install (stream-api and stream-ingest are built on the box from the source). A later release may pin more names: an older box accepts them (each must still be a
 *  digest) and pulls them all. */
export const IMAGE_NAMES = ["postgres", "synapse", "mas", "caddy", "cloudflared", "mautrix-discord", "restic", "node", "dockerfile", "web"];
const MAX_FEED_BYTES = 262_144;
const MAX_SOURCE_BYTES = 1_073_741_824;

const VERSION_RE = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})(?:-([0-9a-z-]+(?:\.[0-9a-z-]+)*))?$/;
// An image by digest: an optional registry host with a port (a pilot's private registry,
// `registry.example:5000/…`), the path, an optional tag, the digest.
const IMAGE_RE = /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*:\d{1,5}\/)?[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[A-Za-z0-9._-]{1,128})?@sha256:[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const HEX64 = /^[0-9a-f]{64}$/;
const FILE_RE = /^[A-Za-z0-9._-]{1,128}$/;

function pae(type, body) {
  const t = Buffer.from(type, "utf8");
  return Buffer.concat([Buffer.from(`DSSEv1 ${t.length} `), t, Buffer.from(` ${body.length} `), body]);
}

/** "ed25519:<base64 raw>" → { key, raw, id } (id: the first 16 hex of the raw key's sha256). */
export function parsePublicKey(s) {
  const m = /^ed25519:([A-Za-z0-9+/]{43}=)$/.exec(String(s ?? "").trim());
  if (!m) throw new Error("not an ed25519 public key (ed25519:<base64 of 32 bytes>)");
  const raw = Buffer.from(m[1], "base64");
  if (raw.length !== 32) throw new Error("an ed25519 public key is 32 bytes");
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
  return { key, raw, id: keyIdOf(raw) };
}
export const keyIdOf = (raw) => createHash("sha256").update(raw).digest("hex").slice(0, 16);

/** The "ed25519:<base64>" form of a private key's public half (PEM or KeyObject in). */
export function publicKeyString(privatePem) {
  const jwk = createPublicKey(createPrivateKey(privatePem)).export({ format: "jwk" });
  return `ed25519:${Buffer.from(jwk.x, "base64url").toString("base64")}`;
}

/** Sign a manifest object into a feed envelope (the publisher's side). */
export function signFeed(manifest, privatePem) {
  const priv = createPrivateKey(privatePem);
  if (priv.asymmetricKeyType !== "ed25519") throw new Error("the signing key is not ed25519");
  const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const pub = parsePublicKey(publicKeyString(privatePem));
  const sig = edSign(null, pae(PAYLOAD_TYPE, body), priv);
  return { payloadType: PAYLOAD_TYPE, payload: body.toString("base64"), signatures: [{ keyid: pub.id, sig: sig.toString("base64") }] };
}

/** Open a feed: the envelope's shape, then a signature by `publicKey` over the exact payload bytes,
 *  then the manifest's own shape. → { ok: true, manifest } | { ok: false, reason } (fixed words). */
export function openFeed(text, publicKey) {
  let pub;
  try { pub = parsePublicKey(publicKey); } catch { return { ok: false, reason: "this box has no usable release key (BB_RELEASE_KEY)" }; }
  if (typeof text !== "string" || text.length > MAX_FEED_BYTES) return { ok: false, reason: "the feed is not a release feed" };
  let env;
  try { env = JSON.parse(text); } catch { return { ok: false, reason: "the feed is not a release feed" }; }
  if (!env || typeof env !== "object" || env.payloadType !== PAYLOAD_TYPE || typeof env.payload !== "string" || !Array.isArray(env.signatures)) {
    return { ok: false, reason: "the feed is not a release feed" };
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(env.payload)) return { ok: false, reason: "the feed is not a release feed" };
  const body = Buffer.from(env.payload, "base64");
  const signed = pae(PAYLOAD_TYPE, body);
  const good = env.signatures.some((s) => s && typeof s.sig === "string" && s.keyid === pub.id
    && /^[A-Za-z0-9+/]{86}==$/.test(s.sig) && edVerify(null, signed, pub.key, Buffer.from(s.sig, "base64")));
  if (!good) {
    const other = env.signatures.some((s) => s && s.keyid !== pub.id);
    return { ok: false, reason: other && !env.signatures.some((s) => s && s.keyid === pub.id) ? "the feed is signed by a key this box does not trust" : "the feed's signature does not verify" };
  }
  let manifest;
  try { manifest = JSON.parse(body.toString("utf8")); } catch { return { ok: false, reason: "the signed manifest is not JSON" }; }
  const problems = manifestProblems(manifest);
  if (problems.length) return { ok: false, reason: `the signed manifest is malformed (${problems[0]})` };
  return { ok: true, manifest };
}

/** Every way a manifest breaks the schema (empty = good). Every field this box reads is checked
 *  strictly; a field it does not know is ignored, so a later release can ADD one without stranding
 *  older boxes. A change an older box must not miss bumps `schema`, which an older box refuses. */
export function manifestProblems(m) {
  const p = [];
  if (!m || typeof m !== "object" || Array.isArray(m)) return ["not an object"];
  if (m.schema !== 1) p.push("schema");
  if (m.product !== "blackbranch") p.push("product");
  if (typeof m.version !== "string" || m.version.length > 64 || !VERSION_RE.test(m.version)) p.push("version");
  if (!CHANNELS.includes(m.channel)) p.push("channel");
  if (typeof m.published !== "string" || !ISO_RE.test(m.published)) p.push("published");
  if (typeof m.expires !== "string" || !ISO_RE.test(m.expires) || !(Date.parse(m.expires) > Date.parse(m.published))) p.push("expires");
  if (typeof m.security !== "boolean") p.push("security");
  if (typeof m.notes !== "string" || m.notes.length > 2000) p.push("notes");
  if (!Number.isInteger(m.postgresMajor) || m.postgresMajor < 10 || m.postgresMajor > 99) p.push("postgresMajor");
  const s = m.source;
  if (!s || typeof s !== "object" || Object.keys(s).some((k) => !["url", "sha256", "size"].includes(k))) p.push("source");
  else {
    if (typeof s.url !== "string" || !(FILE_RE.test(s.url) || /^https?:\/\/[^\s@]+$/.test(s.url))) p.push("source.url");
    if (typeof s.sha256 !== "string" || !HEX64.test(s.sha256)) p.push("source.sha256");
    if (!Number.isInteger(s.size) || s.size < 1 || s.size > MAX_SOURCE_BYTES) p.push("source.size");
  }
  const im = m.images;
  if (!im || typeof im !== "object" || Array.isArray(im)) p.push("images");
  else {
    const keys = Object.keys(im).sort();
    for (const k of IMAGE_NAMES) if (!keys.includes(k)) p.push(`images: no ${k}`);
    if (keys.length > 40) p.push("images: too many");
    for (const k of keys) if (!/^[a-z0-9-]{1,40}$/.test(k) || typeof im[k] !== "string" || !IMAGE_RE.test(im[k])) p.push(`images.${k}`);
    if (typeof im.postgres === "string" && !im.postgres.includes(`:pg${m.postgresMajor}@`)) p.push("images.postgres: not the release's Postgres major");
  }
  if (m.upstream !== undefined && (!Array.isArray(m.upstream) || m.upstream.length > 20 || m.upstream.some((x) => typeof x !== "string" || x.length > 300))) p.push("upstream");
  if (m.ownerPlaybook !== undefined && (typeof m.ownerPlaybook !== "string" || !/^[0-9a-f]{7,40}$/.test(m.ownerPlaybook))) p.push("ownerPlaybook");
  return p;
}

/** Semantic-version precedence (semver 2.0 §11): -1, 0 or 1. A version that does not parse sorts
 *  below every real one (a box installed from a source checkout has none). */
export function compareVersions(a, b) {
  const pa = VERSION_RE.exec(a ?? ""), pb = VERSION_RE.exec(b ?? "");
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 1; i <= 3; i++) { const d = Number(pa[i]) - Number(pb[i]); if (d) return Math.sign(d); }
  if (!pa[4] || !pb[4]) return pa[4] ? -1 : pb[4] ? 1 : 0;
  const x = pa[4].split("."), y = pb[4].split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const nx = /^\d+$/.test(x[i]), ny = /^\d+$/.test(y[i]);
    if (nx && ny) { const d = Number(x[i]) - Number(y[i]); if (d) return Math.sign(d); }
    else if (nx !== ny) return nx ? -1 : 1;
    else if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}
export const isVersion = (v) => typeof v === "string" && v.length <= 64 && VERSION_RE.test(v);

/** What this box should do with a verified manifest. → { decision, refuse?, unread? } with fixed
 *  words. `unread`: the feed itself is not one to act on (another channel's, or expired — a feed
 *  served again after its time is how an old release would be held in place), so it does not count
 *  as a read either. */
export function decide(m, { current, channel, postgresMajor, now = new Date() }) {
  if (m.channel !== channel) return { decision: "refused", unread: true, refuse: `the feed for ${channel} carries a ${m.channel} release` };
  if (Date.parse(m.expires) <= now.getTime()) return { decision: "refused", unread: true, refuse: "the feed has expired (its publisher has not signed it again)" };
  const c = compareVersions(m.version, current);
  if (c <= 0) return { decision: c === 0 ? "same" : "older" };
  if (postgresMajor !== null && postgresMajor !== undefined && m.postgresMajor !== postgresMajor) {
    return { decision: "refused", refuse: `${m.version} runs Postgres ${m.postgresMajor} and this box runs Postgres ${postgresMajor}: a Postgres major upgrade is never part of a normal update — it is its own announced step` };
  }
  return { decision: "newer" };
}

/** Every image reference a release's Compose file and Dockerfile name, against the manifest's
 *  pins: everything third-party pinned by digest, and exactly the manifest's set. */
/** A release's compose.yaml: the site's service names its prebuilt image (`ref`, by digest) in place
 *  of the checkout's `image` + `build` lines — so the box pulls it and never builds the site. null
 *  when the file does not have web's service in the checkout's shape. */
export function pinWebImage(composeText, ref) {
  const re = /(\n {2}web:\n(?: {4}(?:#[^\n]*|<<: \*app)\n)*) {4}image: blackbranch\/web:\$\{BB_RELEASE:-local\}\n {4}build: \{[^\n]*\btarget: web \}\n/;
  return re.test(composeText) ? composeText.replace(re, `$1    image: ${ref}\n`) : null;
}

export function pinProblems(composeText, dockerfileText, images) {
  const refs = new Set();
  // An image built on the box carries the release's tag variable (blackbranch/<app>:${BB_RELEASE…});
  // every other one — the site's prebuilt image among them — must be the manifest's, by digest.
  for (const m of composeText.matchAll(/^\s+image:\s*"?([^\s"]+)"?\s*$/gm)) if (!m[1].includes("${BB_RELEASE")) refs.add(m[1]);
  const syntax = /^#\s*syntax\s*=\s*(\S+)\s*$/m.exec(dockerfileText);
  if (syntax) refs.add(syntax[1]);
  // A FROM that names an earlier stage (FROM base AS …) is not an image.
  const stages = new Set([...dockerfileText.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map((m) => m[1].toLowerCase()));
  for (const m of dockerfileText.matchAll(/^(?:FROM\s+(?!\$)(\S+)|ARG\s+NODE_IMAGE=(\S+))/gm)) {
    const r = m[1] ?? m[2];
    if (!stages.has(r.toLowerCase())) refs.add(r);
  }
  const want = new Set(Object.values(images));
  const p = [];
  for (const r of refs) if (!IMAGE_RE.test(r)) p.push(`${r} is not pinned by digest`); else if (!want.has(r)) p.push(`${r} is not in the manifest`);
  for (const r of want) if (!refs.has(r)) p.push(`${r} (manifest) is used by neither file`);
  return p;
}

// One printable line for the operator's screens: no quote, backslash or control character.
const oneLine = (s, n) => String(s).replace(/[\u0000-\u001f\u007f"\\`$]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

// ── The box's command line ────────────────────────────────────────────────────────────────────
// check --feed <file> --feed-url <url> --key <ed25519:…> --current <version|-> --channel <c> [--pg-major <n>|-]
//   prints KEY=value lines (each value matches a fixed pattern, so the shell reads them as data)
//   and, last, `MANIFEST <the manifest as one line of JSON>`. Exit 0 = read and decided (see
//   DECISION), 3 = refused or unreadable (REASON says why).
// pins --compose <file> --dockerfile <file> --images "<ref> <ref> …"   exit 0 = consistent
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function cli() {
  const cmd = process.argv[2];
  const out = (k, v) => process.stdout.write(`${k}=${v}\n`);
  if (cmd === "check") {
    let text;
    try { text = readFileSync(arg("feed"), "utf8"); } catch { out("REASON", "the feed could not be read"); return 3; }
    const opened = openFeed(text, arg("key"));
    if (!opened.ok) { out("REASON", oneLine(opened.reason, 300)); return 3; }
    const m = opened.manifest;
    const pg = arg("pg-major");
    const current = arg("current");
    const now = arg("now") ? new Date(arg("now")) : new Date();
    const d = decide(m, { current: isVersion(current) ? current : "0.0.0-0", channel: arg("channel"), postgresMajor: /^\d+$/.test(pg ?? "") ? Number(pg) : null, now });
    if (d.unread) { out("REASON", oneLine(d.refuse, 300)); return 3; }
    let src;
    try {
      src = new URL(m.source.url, arg("feed-url"));
      if (!["https:", "http:"].includes(src.protocol) || src.username || src.password) throw new Error("scheme");
    } catch { out("REASON", "the release's source address is not usable"); return 3; }
    out("VERSION", m.version); out("CHANNEL", m.channel); out("SECURITY", m.security ? "true" : "false");
    out("PUBLISHED", m.published); out("EXPIRES", m.expires); out("PGMAJOR", m.postgresMajor);
    out("SRC_SHA256", m.source.sha256); out("SRC_SIZE", m.source.size);
    if (!/^https?:\/\/[A-Za-z0-9._~:/?#[\]@!&'()*+,;=%-]+$/.test(src.href)) { out("REASON", "the release's source address is not usable"); return 3; }
    out("SRC_URL", src.href);
    out("IMAGES", Object.keys(m.images).sort().map((k) => m.images[k]).join(" "));
    out("NOTES", oneLine(m.notes, 300));
    out("DECISION", d.decision);
    if (d.refuse) out("REASON", oneLine(d.refuse, 300));
    process.stdout.write(`MANIFEST ${JSON.stringify(m)}\n`);
    return d.decision === "refused" ? 3 : 0;
  }
  if (cmd === "pins") {
    const imgs = String(arg("images") ?? "").split(/\s+/).filter(Boolean);
    const p = pinProblems(readFileSync(arg("compose"), "utf8"), readFileSync(arg("dockerfile"), "utf8"), Object.fromEntries(imgs.map((r, i) => [i, r])));
    for (const x of p) process.stdout.write(`PROBLEM=${oneLine(x, 300)}\n`);
    return p.length ? 3 : 0;
  }
  if (cmd === "compare") { process.stdout.write(`${compareVersions(process.argv[3], process.argv[4])}\n`); return 0; }
  process.stderr.write("usage: release.mjs check|pins|compare …\n");
  return 2;
}
const isMain = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isMain()) process.exit(cli());
