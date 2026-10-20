// The box's check of where a backup may go, run inside the backup container before ANY restic call
// (install/backup/run.sh `target_ready`). restic runs as root and connects wherever its address
// says, so an address is a way to make the box reach something; this refuses that:
//   1. the shape — the settings layer's own rule, checkBackupTarget (config/instance-schema.mjs):
//      local takes no address; s3 = s3:https://<host>[:port]/<bucket>[/<folder>]; sftp =
//      sftp:<user>@<host>:/<folder> or sftp://<user>@<host>:<port>/<folder>; nothing else;
//   2. where the host resolves — never loopback, link-local (169.254.0.0/16 — cloud metadata —
//      and fe80::/10), carrier-grade NAT (100.64.0.0/10 — Alibaba's metadata, Tailscale), AWS's
//      IMDS range fd00:ec2::/32, site-local, multicast, unspecified or reserved, never the bundle's
//      own network or Docker's default bridge; IPv6 forms that carry an IPv4 (mapped, compatible,
//      NAT64, 6to4) are judged as that IPv4; localhost names and metadata.google.internal are
//      refused before any lookup. Private addresses (10/8, 172.16/12, 192.168/16, fc00::/7) stay
//      allowed: a NAS at home is a real SFTP target;
//   3. the pin — the checked address is written into THIS container's /etc/hosts and the name is
//      resolved again: restic and ssh then use the address that was checked, so a DNS answer that
//      changes between the check and the connection (rebinding) cannot move them.
// Prints one line `BBCHECK {json}`; exits 1 with the reason in plain words on stdout.
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ALLOWED_NOTE = "private addresses (10.x, 172.16–31.x, 192.168.x) are allowed — a NAS at home is fine";

// Names refused before any lookup: they mean "this machine" or a cloud's metadata service wherever
// they resolve.
const REFUSED_NAMES = /^(localhost|localhost\.localdomain|.+\.localhost|metadata\.google\.internal)\.?$/i;

// IPv4 ranges, as [first octets, prefix length, why].
const V4_BLOCKS = [
  ["0.0.0.0", 8, "unspecified"], ["127.0.0.0", 8, "loopback"], ["169.254.0.0", 16, "link-local — cloud metadata"],
  // Carrier-grade NAT: Alibaba Cloud's metadata service is 100.100.100.200, and Tailscale addresses live here too —
  // a backup server on Tailscale is reached on its LAN address (or a name resolving to one) instead.
  ["100.64.0.0", 10, "carrier-grade NAT — cloud metadata, Tailscale"],
  ["224.0.0.0", 4, "multicast"], ["240.0.0.0", 4, "reserved / broadcast"],
  ["172.17.0.0", 16, "Docker's default bridge"],
];
// IPv6 ranges (after any embedded IPv4 has been taken out and judged as IPv4). ULA fc00::/7 stays
// allowed on purpose (a home network), except AWS's IMDS address range.
const V6_BLOCKS = [
  ["::", 128, "unspecified"], ["::1", 128, "loopback"], ["fe80::", 10, "link-local"], ["fec0::", 10, "site-local (deprecated)"],
  ["ff00::", 8, "multicast"], ["fd00:ec2::", 32, "AWS instance metadata"],
];

const v4int = (a) => a.split(".").reduce((n, o) => n * 256 + Number(o), 0);
function v4in(a, base, len) { const m = len === 0 ? 0 : (2 ** 32 - 2 ** (32 - len)); return (v4int(a) & m) >>> 0 === (v4int(base) & m) >>> 0; }

/** An IPv6 address as 8 numbers (an embedded dotted IPv4 at the end is understood), or null. */
function v6words(a) {
  let s = a.toLowerCase().replace(/%.*$/, "");
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) { const n = v4int(dotted[1]); s = s.slice(0, -dotted[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`; }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const words = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...tail].map((w) => parseInt(w, 16));
  return words.length === 8 && words.every((w) => w >= 0 && w <= 0xffff) ? words : null;
}
const v4of = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
function v6in(w, base, len) {
  const b = v6words(base);
  for (let i = 0; i < 8; i += 1) {
    const bits = Math.min(16, Math.max(0, len - i * 16));
    if (!bits) break;
    const m = (0xffff << (16 - bits)) & 0xffff;
    if ((w[i] & m) !== (b[i] & m)) return false;
  }
  return true;
}

/**
 * An address in one canonical form: { family: 4, address: "a.b.c.d" } for IPv4 AND for every IPv6 form
 * that carries one (mapped ::ffff:a.b.c.d / ::ffff:7f00:1, IPv4-compatible ::a.b.c.d, NAT64 64:ff9b::/96
 * and 64:ff9b:1::/48, 6to4 2002::/16), else { family: 6, address: <8 lowercase hextets> }. Null if not an address.
 */
export function normalizeAddress(address) {
  const a = String(address).trim();
  if (isIP(a) === 4) return { family: 4, address: a.split(".").map(Number).join(".") };
  if (isIP(a) !== 6) return null;
  const w = v6words(a);
  if (!w) return null;
  const zero = (from, to) => w.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && w[5] === 0xffff) return { family: 4, address: v4of(w[6], w[7]) };            // mapped
  if (zero(0, 6) && (w[6] || w[7] > 1)) return { family: 4, address: v4of(w[6], w[7]) };          // IPv4-compatible
  if (w[0] === 0x64 && w[1] === 0xff9b && zero(2, 6)) return { family: 4, address: v4of(w[6], w[7]) }; // NAT64
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return { family: 4, address: v4of(w[6], w[7]) }; // NAT64 local-use
  if (w[0] === 0x2002) return { family: 4, address: v4of(w[1], w[2]) };                            // 6to4
  return { family: 6, address: w.map((x) => x.toString(16)).join(":") };
}

/** One address against the refused ranges → null, or why it is refused. */
export function addressProblem(address, subnet) {
  const n = normalizeAddress(address);
  if (!n) return `${address} is not an address`;
  let why = null;
  if (n.family === 4) {
    const own = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(subnet || "");
    for (const [base, len, w] of [...V4_BLOCKS, ...(own ? [[own[1], Number(own[2]), "the bundle's own network"]] : [])]) {
      if (v4in(n.address, base, len)) { why = w; break; }
    }
  } else {
    const w = v6words(n.address);
    for (const [base, len, r] of V6_BLOCKS) if (v6in(w, base, len)) { why = r; break; }
  }
  if (!why) return null;
  const shown = n.address === String(address) ? n.address : `${address} (= ${n.address})`;
  return `${shown} is refused (${why}): loopback, link-local (169.254.x — cloud metadata), carrier-grade NAT (100.64–127.x — cloud metadata; a Tailscale backup server is reached on its LAN address instead), multicast, unspecified addresses and the bundle's own network are never backup targets; ${ALLOWED_NOTE}`;
}

/**
 * The whole check. Injectable for tests: `lookup(host)` → [{ address }], `pin(host, ip)` writes the
 * pin. Returns { ok: true, repository, host, address } or { ok: false, error }.
 */
export async function checkTarget({ target, repository, subnet, check, lookup = (h) => dnsLookup(h, { all: true, verbatim: true }), pin }) {
  const shape = check(target, repository);
  if (!shape.ok) return { ok: false, error: shape.error };
  if (!shape.host) return { ok: true, repository: null, host: null, address: null }; // local: the box's own folder
  const host = shape.host;
  if (REFUSED_NAMES.test(host)) return { ok: false, error: `${host} is refused: it names this machine or a cloud's metadata service; ${ALLOWED_NOTE}` };
  if (isIP(host)) {
    const p = addressProblem(host, subnet);
    return p ? { ok: false, error: p } : { ok: true, repository, host, address: normalizeAddress(host).address };
  }
  const resolve = async () => {
    try { return (await lookup(host)).map((r) => normalizeAddress(r.address)?.address ?? `invalid:${r.address}`); } catch { return []; }
  };
  const first = [...new Set(await resolve())];
  if (!first.length) return { ok: false, error: `${host} does not resolve` };
  // Every answer must be allowed: a name that ALSO points at 127.0.0.1 is refused, not filtered — so
  // nothing can be left over to fall back to.
  for (const a of first) {
    const p = addressProblem(a.startsWith("invalid:") ? a.slice(8) : a, subnet);
    if (p) return { ok: false, error: `${host} resolves to ${p}` };
  }
  const address = first[0];
  pin(host, address);
  // After the pin the name must answer with exactly the pinned address, compared in canonical form
  // (::ffff:1.2.3.4 IS 1.2.3.4) and as a whole set — a second answer beside it is a change too.
  const again = [...new Set(await resolve())];
  if (again.length !== 1 || again[0] !== address) {
    return { ok: false, error: `${host} changed between the check and the connection (resolved to ${again.join(", ") || "nothing"} after ${address}) — refused` };
  }
  return { ok: true, repository, host, address };
}

async function main() {
  const dir = process.env.BB_CONFIG_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), "../../config");
  const { checkBackupTarget } = await import(pathToFileURL(path.join(dir, "instance-schema.mjs")).href);
  const r = await checkTarget({
    target: process.env.BK_TARGET || "local", repository: process.env.BK_REPOSITORY || "", subnet: process.env.BB_SUBNET || "",
    check: checkBackupTarget,
    pin: (host, ip) => appendFileSync(process.env.BB_HOSTS_FILE || "/etc/hosts", `${ip} ${host}\n`),
  });
  if (!r.ok) { process.stdout.write(`${r.error}\n`); process.exit(1); }
  process.stdout.write(`BBCHECK ${JSON.stringify({ ok: true, host: r.host, address: r.address })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
