#!/usr/bin/env node
// Cutting a signed release of the install bundle (the publisher's side; the box's side is
// install/update/release.mjs).
//
//   node tools/release.mjs keygen --out <dir>
//       an Ed25519 pair: <dir>/release-signing.key (PKCS#8 PEM, mode 600 — keep it OFFLINE and
//       backed up; it is the only thing that can sign a release every install will run) and
//       <dir>/release-key.pub ("ed25519:<base64>", the line install/release-key.pub holds).
//   node tools/release.mjs image --version 1.2.3 [--tree <dir> | --ref <git ref>] [--web-image <repository>] [--push]
//       the site's image for the release: the same file selection as the tarball
//       (install/release-copy.sh), install/Dockerfile's `web` target, tagged <repository>:<version>;
//       --push sends it to the registry and prints its digest — the one every install pulls. Built
//       with nothing install-specific in it: one image serves every install.
//   node tools/release.mjs cut --version 1.2.3 --channel stable|beta --key <signing key> --out <dir>
//       [--security] [--notes "…"] [--tree <dir> | --ref <git ref>] [--digests <file.json>]
//       [--web-image <repository>] [--expires-days 30] [--upstream "…"]… [--owner-playbook <commit>]
//       [--base-url <url where <dir> is served>]
//       --key must be the private half of the release's own install/release-key.pub (the key its
//       fresh installs trust); any other is refused before anything is written.
//       → <dir>/blackbranch-<version>.tar.gz   the release's source, in the public cut's shape
//                                              (install/release-copy.sh), every image pinned by
//                                              digest in install/compose.yaml and install/Dockerfile
//                                              — the site's prebuilt one in place of its build —
//                                              RELEASE = the version
//         <dir>/<channel>.json                  the signed feed (DSSE envelope) naming it
//         <dir>/blackbranch-<version>.manifest.json   the manifest, readable
//         <dir>/install.sh (install-beta.sh)    the one-line form (`curl -fsSL …/install.sh | sudo bash`):
//                                              the release's install.sh stamped with this release —
//                                              version, size, sha256, --base-url (default the
//                                              project's feed address), where it fetches it from,
//                                              and the channel the box it makes follows
//       Digests come from the registries (`docker buildx imagetools inspect`), or from --digests
//       ({ "<image ref as the repo writes it>": "sha256:…" }; the site's as "<repository>:<version>")
//       for a test. The site's image must be pushed first (`image --push`).
//   node tools/release.mjs digests --tree <dir> [--out <file.json>]
//       the registries' digest of every third-party image the tree names by tag (the same lookup
//       `cut` makes), as the --digests table `cut` reads: { "<image ref as the repo writes it>":
//       "sha256:…" }. A rehearsal that cuts several releases from one tree looks them up once, so
//       every release it cuts pins the same images (install/ci/release-candidate.sh).
//   node tools/release.mjs verify --feed <file> --key <ed25519:… | file>
//
// The verifier the box runs is the same module (install/update/release.mjs).
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IMAGE_NAMES, isVersion, manifestProblems, openFeed, pinProblems, pinWebImage, publicKeyString, signFeed } from "../install/update/release.mjs";

// Where the site's image is published — the ONE place: the project's GitHub container registry. A
// test or a pilot names its own with --web-image.
// The form the box's verifier accepts (install/update/release.mjs IMAGE_RE): lower-case path parts,
// with a registry port if it has one (e.g. registry.example:5000/web); `image` and `cut` refuse any other.
const WEB_IMAGE_REPOSITORY = "ghcr.io/black-branch/blackbranch-web";
// Where a release's files are served (the feed, the tarball, the one-line installer): the box's
// default BB_UPDATE_FEED. A pilot or a test serves them elsewhere and says so with --base-url.
const DEFAULT_BASE_URL = "https://blackbranch.app/releases";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const cmd = args.shift();
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const opts = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const flag = (name) => args.includes(`--${name}`);
const die = (msg) => { process.stderr.write(`release: ${msg}\n`); process.exit(1); };

// Where each pinned name is written in the repo: [manifest name, how the repo writes the reference].
function repoImageRefs(tree) {
  const compose = readFileSync(path.join(tree, "install/compose.yaml"), "utf8");
  const docker = readFileSync(path.join(tree, "install/Dockerfile"), "utf8");
  const find = (re, text, what) => { const m = re.exec(text); if (!m) die(`no ${what} image in the bundle`); return m[1]; };
  return {
    postgres: find(/^\s+image:\s*(pgvector\/pgvector:[^\s@]+)\s*$/m, compose, "postgres"),
    synapse: find(/^\s+image:\s*(ghcr\.io\/element-hq\/synapse:[^\s@]+)\s*$/m, compose, "synapse"),
    mas: find(/^\s+image:\s*(ghcr\.io\/element-hq\/matrix-authentication-service:[^\s@]+)\s*$/m, compose, "mas"),
    caddy: find(/^\s+image:\s*(caddy:[^\s@]+)\s*$/m, compose, "caddy"),
    cloudflared: find(/^\s+image:\s*(cloudflare\/cloudflared:[^\s@]+)\s*$/m, compose, "cloudflared"),
    "mautrix-discord": find(/^\s+image:\s*(dock\.mau\.dev\/mautrix\/discord:[^\s@]+)\s*$/m, compose, "mautrix-discord"),
    restic: find(/^FROM\s+(restic\/restic:[^\s@]+)/m, docker, "restic"),
    node: find(/^ARG NODE_IMAGE=([^\s@]+)$/m, docker, "node"),
    dockerfile: find(/^# syntax=([^\s@]+)$/m, docker, "the Dockerfile frontend (# syntax=)"),
  };
}

function resolveDigest(ref, table) {
  if (table) { const d = table[ref]; if (!/^sha256:[0-9a-f]{64}$/.test(d ?? "")) die(`--digests has no sha256 for ${ref}`); return d; }
  let d;
  try {
    d = JSON.parse(execFileSync("docker", ["buildx", "imagetools", "inspect", ref, "--format", "{{json .Manifest}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).digest;
  } catch {
    // No buildx: pull it, and read the digest the registry gave (the index's, for a multi-arch tag).
    execFileSync("docker", ["pull", "-q", ref], { stdio: "ignore" });
    const repo = ref.replace(/:[^/:]+$/, "");
    const digests = JSON.parse(execFileSync("docker", ["image", "inspect", ref, "--format", "{{json .RepoDigests}}"], { encoding: "utf8" }));
    d = (digests.find((x) => x.replace(/^docker\.io\/(library\/)?/, "").startsWith(`${repo}@`)) ?? "").split("@")[1];
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(d ?? "")) die(`no digest for ${ref}`);
  return d;
}

function webRepository() {
  const r = opt("web-image") ?? WEB_IMAGE_REPOSITORY;
  if (!/^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*:\d{1,5}\/)?[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(r)) {
    die(`the site image's repository ("${r}") is not one the box accepts: lower-case path parts, with a registry port if it has one (WEB_IMAGE_REPOSITORY in tools/release.mjs, or --web-image <repository> for a test or pilot)`);
  }
  return r;
}

// The release's files, as install/release-copy.sh selects them, in <work>/blackbranch-<version>.
function stageTree(work, version) {
  let tree = opt("tree") ? path.resolve(opt("tree")) : undefined;
  if (!tree) {
    tree = path.join(work, "tree"); mkdirSync(tree);
    execFileSync("bash", ["-c", 'git -C "$1" archive "$2" | tar -x -C "$3"', "_", repo, opt("ref") ?? "HEAD", tree]);
  }
  const stage = path.join(work, `blackbranch-${version}`);
  try {
    execFileSync("bash", [path.join(tree, "install/release-copy.sh"), tree, stage], { stdio: ["ignore", "ignore", "inherit"] });
  } catch { die("the release's files could not be selected (release-copy.sh says why above) — nothing was written"); }
  writeFileSync(path.join(stage, "RELEASE"), `${version}\n`);
  return stage;
}

function image() {
  const version = opt("version");
  if (!isVersion(version)) die("--version must be a version like 1.2.3 or 1.2.3-beta.1");
  const tag = `${webRepository()}:${version}`;
  const work = mkdtempSync(path.join(tmpdir(), "bb-image-"));
  try {
    const stage = stageTree(work, version);
    execFileSync("docker", ["build", "-f", path.join(stage, "install/Dockerfile"), "--target", "web", "-t", tag, stage], { stdio: "inherit" });
    const id = execFileSync("docker", ["image", "inspect", tag, "--format", "{{.Id}}"], { encoding: "utf8" }).trim();
    if (!flag("push")) { process.stdout.write(`built ${tag} (image ${id}) — push it (--push) before cutting the release\n`); return; }
    execFileSync("docker", ["push", tag], { stdio: "inherit" });
    const digests = JSON.parse(execFileSync("docker", ["image", "inspect", tag, "--format", "{{json .RepoDigests}}"], { encoding: "utf8" }));
    const d = (digests.find((x) => x.startsWith(`${tag.replace(/:[^/:]+$/, "")}@`)) ?? "").split("@")[1];
    if (!/^sha256:[0-9a-f]{64}$/.test(d ?? "")) die(`pushed ${tag}, but the registry gave no digest`);
    process.stdout.write(`pushed ${tag}@${d} (image ${id})\n`);
  } finally { rmSync(work, { recursive: true, force: true }); }
}

function cut() {
  const version = opt("version"), channel = opt("channel"), keyFile = opt("key"), out = opt("out") && path.resolve(opt("out"));
  if (!isVersion(version)) die("--version must be a version like 1.2.3 or 1.2.3-beta.1");
  if (!["stable", "beta"].includes(channel)) die("--channel must be stable or beta");
  if (!keyFile || !out) die("--key and --out are required");
  const key = readFileSync(keyFile, "utf8");
  const days = Number(opt("expires-days") ?? 30);
  if (!(days >= 1 && days <= 365)) die("--expires-days must be 1–365");
  const table = opt("digests") ? JSON.parse(readFileSync(opt("digests"), "utf8")) : null;

  const base = opt("base-url") ?? DEFAULT_BASE_URL;
  if (!/^https?:\/\/[A-Za-z0-9._~:/%-]+$/.test(base)) die("--base-url must be the http(s) address the release's files are served at");
  const webRef = `${webRepository()}:${version}`;
  const work = mkdtempSync(path.join(tmpdir(), "bb-release-"));
  try {
    const stage = stageTree(work, version);
    // The key a fresh install of this release trusts is the one it ships (install/release-key.pub,
    // read by install.sh): a feed signed by any other key is one those installs refuse. Checked
    // before anything is written to --out.
    const trusted = readFileSync(path.join(stage, "install/release-key.pub"), "utf8").split("\n")[0].trim();
    if (trusted !== publicKeyString(key)) {
      die(`the signing key is not the one this release trusts: --key is ${publicKeyString(key)}, install/release-key.pub is ${trusted || "(empty)"} — nothing was written`);
    }

    // Pin every image by digest, in the files the box reads: the third-party ones where the repo
    // names them by tag, and the site's prebuilt image in place of web's build (one image for every
    // install).
    const refs = { ...repoImageRefs(stage), web: webRef };
    const images = {};
    for (const name of IMAGE_NAMES) images[name] = `${refs[name]}@${resolveDigest(refs[name], table)}`;
    let compose = pinWebImage(readFileSync(path.join(stage, "install/compose.yaml"), "utf8"), images.web);
    if (compose === null) die("install/compose.yaml has no web service in the shape the release pins (image + build, target web)");
    let docker = readFileSync(path.join(stage, "install/Dockerfile"), "utf8");
    for (const name of IMAGE_NAMES.filter((n) => n !== "web")) {
      const esc = refs[name].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      compose = compose.replace(new RegExp(`(^\\s+image:\\s*)${esc}\\s*$`, "gm"), `$1${images[name]}`);
      docker = docker.replace(new RegExp(`^(FROM\\s+)${esc}(?=\\s)`, "gm"), `$1${images[name]}`).replace(new RegExp(`^(ARG NODE_IMAGE=)${esc}$`, "m"), `$1${images[name]}`)
        .replace(new RegExp(`^(# syntax=)${esc}$`, "m"), `$1${images[name]}`);
    }
    const pins = pinProblems(compose, docker, images);
    if (pins.length) die(`not every image is pinned:\n  ${pins.join("\n  ")}`);
    writeFileSync(path.join(stage, "install/compose.yaml"), compose);
    writeFileSync(path.join(stage, "install/Dockerfile"), docker);

    mkdirSync(out, { recursive: true });
    const tarName = `blackbranch-${version}.tar.gz`;
    const tarPath = path.join(out, tarName);
    // Reproducible: sorted names, fixed times and owners, gzip without a timestamp.
    execFileSync("bash", ["-c", 'tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=gnu -C "$1" -cf - "$2" | gzip -n -9 > "$3"',
      "_", work, path.basename(stage), tarPath]);
    const tarBytes = readFileSync(tarPath);
    const published = new Date();
    published.setUTCMilliseconds(0);
    const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
    const manifest = {
      schema: 1, product: "blackbranch", version, channel,
      published: iso(published), expires: iso(new Date(published.getTime() + days * 86_400_000)),
      security: flag("security"), notes: opt("notes") ?? "",
      postgresMajor: Number(/:pg(\d+)$/.exec(refs.postgres)?.[1] ?? NaN),
      source: { url: tarName, sha256: createHash("sha256").update(tarBytes).digest("hex"), size: tarBytes.length },
      images,
      ...(opts("upstream").length ? { upstream: opts("upstream") } : {}),
      ...(opt("owner-playbook") ? { ownerPlaybook: opt("owner-playbook") } : {}),
    };
    const problems = manifestProblems(manifest);
    if (problems.length) die(`the manifest is malformed: ${problems.join("; ")}`);
    const feed = signFeed(manifest, key);
    const opened = openFeed(JSON.stringify(feed), trusted);
    if (!opened.ok) die(`the signed feed does not verify: ${opened.reason}`);
    const installer = stampInstaller(readFileSync(path.join(stage, "install/install.sh"), "utf8"),
      { version, sha256: manifest.source.sha256, size: manifest.source.size, base, channel });
    const installerName = channel === "stable" ? "install.sh" : `install-${channel}.sh`;
    if (installer === undefined) die(`this release's install.sh cannot name its channel (no BOOTSTRAP_CHANNEL stamp line): ${installerName} would install boxes that follow stable`);
    writeFileSync(path.join(out, `${channel}.json`), `${JSON.stringify(feed, null, 2)}\n`);
    writeFileSync(path.join(out, `blackbranch-${version}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);
    if (installer === null) process.stdout.write(`note: this release's install.sh has no one-line form (no stamp lines): ${installerName} not written\n`);
    else writeFileSync(path.join(out, installerName), installer, { mode: 0o644 });
    process.stdout.write(`release ${version} (${channel}${manifest.security ? ", security" : ""}): ${tarName} ${manifest.source.size} bytes, sha256 ${manifest.source.sha256}\n`
      + `signed by ${publicKeyString(key)}\nfeed: ${path.join(out, `${channel}.json`)}\n`);
  } finally { rmSync(work, { recursive: true, force: true }); }
}

// The release's install.sh with its stamp lines filled (install.sh section 0): null when the
// release's installer has none (a release from before the one-line form); undefined when it cannot
// carry a channel other than stable (from before BOOTSTRAP_CHANNEL) — a beta box would follow stable.
function stampInstaller(text, { version, sha256, size, base, channel }) {
  const lines = { BOOTSTRAP_VERSION: version, BOOTSTRAP_SHA256: sha256, BOOTSTRAP_SIZE: String(size), BOOTSTRAP_BASE: base.replace(/\/+$/, "") };
  let t = text;
  for (const [k, v] of Object.entries(lines)) {
    const re = new RegExp(`^${k}=""$`, "m");
    if (!re.test(t)) return null;
    t = t.replace(re, `${k}="${v}"`);
  }
  const re = /^BOOTSTRAP_CHANNEL=""$/m;
  if (re.test(t)) return t.replace(re, `BOOTSTRAP_CHANNEL="${channel}"`);
  return channel === "stable" ? t : undefined;
}

function digests() {
  const tree = opt("tree") && path.resolve(opt("tree"));
  if (!tree || !existsSync(path.join(tree, "install/compose.yaml"))) die("--tree <dir> must be a release or checkout (it has no install/compose.yaml)");
  const table = {};
  for (const ref of Object.values(repoImageRefs(tree))) table[ref] = resolveDigest(ref, null);
  const text = `${JSON.stringify(table, null, 2)}\n`;
  if (opt("out")) writeFileSync(path.resolve(opt("out")), text);
  else process.stdout.write(text);
}

function keygen() {
  const out = opt("out");
  if (!out) die("--out <dir> is required");
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const priv = path.join(out, "release-signing.key");
  if (existsSync(priv)) die(`${priv} exists — a signing key is never replaced by accident`);
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });
  writeFileSync(priv, pem, { mode: 0o600 });
  chmodSync(priv, 0o600);
  writeFileSync(path.join(out, "release-key.pub"), `${publicKeyString(pem)}\n`);
  if ((statSync(priv).mode & 0o077) !== 0) die("the signing key is readable by others");
  process.stdout.write(`signing key: ${priv} (mode 600 — back it up offline)\npublic key:  ${publicKeyString(pem)}\n`);
}

function verify() {
  let key = opt("key") ?? "";
  if (existsSync(key)) key = readFileSync(key, "utf8").trim();
  const r = openFeed(readFileSync(opt("feed"), "utf8"), key);
  if (!r.ok) die(r.reason);
  process.stdout.write(`ok: ${r.manifest.version} (${r.manifest.channel}${r.manifest.security ? ", security" : ""}), published ${r.manifest.published}, expires ${r.manifest.expires}\n`);
}

if (cmd === "cut") cut();
else if (cmd === "image") image();
else if (cmd === "keygen") keygen();
else if (cmd === "verify") verify();
else if (cmd === "digests") digests();
else die("usage: release.mjs keygen|image|cut|digests|verify … (see the header)");
