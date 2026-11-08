// The community service account's profile: the site's name, and the site's icon as its picture.
// Run by `blackbranch up` (community_service_ensure) inside the stream-api image, like bootstrap.mjs,
// with the appservice token on stdin — never on a command line. The registration alone makes the
// account exist: nothing here registers it (Synapse answers 500 to /register once a profile exists).
// Each step reads first and writes only what differs, so a second run changes nothing.
//
//   MX_BASE          the homeserver inside the bundle (http://synapse:8008)
//   MX_USER_ID       @<name>:<server>: the token must answer as exactly this account
//   MX_DISPLAY_NAME  the site's name
//   MX_AVATAR        optional: the site's icon, a PNG of at most 2 MB
//   MX_AVATAR_STAMP  optional: "<sha256> <mxc>" — the icon this script set last time, and where
//
// Prints one JSON line: {"user","name":"set"|"kept","avatar":"set"|"kept"|"none"|"failed","avatarStamp"}.
// Fails (exit 1, "community: <reason>" on stderr) when the token does not answer as MX_USER_ID or
// the name cannot be set. A picture that cannot be set is reported in the line, never fatal.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const fail = (why) => { process.stderr.write(`community: ${why}\n`); process.exit(1); };
const BASE = (process.env.MX_BASE ?? "").replace(/\/+$/, "");
const USER = process.env.MX_USER_ID ?? "";
const NAME = process.env.MX_DISPLAY_NAME ?? "";
const AVATAR = process.env.MX_AVATAR ?? "";
const STAMP = process.env.MX_AVATAR_STAMP ?? "";
const ICON_MAX = 2 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MXC = /^mxc:\/\/[A-Za-z0-9.:-]+\/[A-Za-z0-9_-]+$/;

if (!/^https?:\/\/[^/\s]+$/.test(BASE)) fail("MX_BASE must be the homeserver's address");
if (!/^@[a-z0-9._=-]{1,64}:[A-Za-z0-9.:-]+$/.test(USER)) fail("MX_USER_ID must be @name:server");
if (!NAME.trim() || NAME.length > 256) fail("MX_DISPLAY_NAME must be 1-256 characters");
const token = readFileSync(0, "utf8").split("\n")[0].trim();
// The same rule as the registration's (render.sh mx_render_appservice_community).
if (!token) fail("no token on stdin");
if (!/^[0-9a-f]{32,128}$/.test(token)) fail(`the token on stdin must be 32-128 hex characters (it is ${token.length} characters${/^[0-9a-f]*$/.test(token) ? "" : ", not all hex"})`);

async function call(method, path, body, type = "application/json") {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = type;
  let res;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, signal: AbortSignal.timeout(15_000),
      body: body === undefined ? undefined : type === "application/json" ? JSON.stringify(body) : body });
  } catch (e) { return { status: 0, json: null, error: e instanceof Error ? e.message : String(e) }; }
  return { status: res.status, json: await res.json().catch(() => null) };
}
const profile = (field) => `/_matrix/client/v3/profile/${encodeURIComponent(USER)}/${field}`;

const who = await call("GET", "/_matrix/client/v3/account/whoami");
if (who.status === 0) fail(`the homeserver did not answer (${who.error})`);
if (who.status !== 200) fail(`the homeserver refused the token (${who.status} ${who.json?.errcode ?? ""})`.trim());
if (who.json?.user_id !== USER) fail(`the token answers as ${String(who.json?.user_id ?? "nobody").slice(0, 100)}, not ${USER}`);

let name = "kept";
const shown = await call("GET", profile("displayname"));
if (shown.status !== 200 || shown.json?.displayname !== NAME) {
  const w = await call("PUT", profile("displayname"), { displayname: NAME });
  if (w.status !== 200) fail(`the name could not be set (${w.status} ${w.json?.errcode ?? ""})`.trim());
  name = "set";
}

let avatar = "none";
let avatarStamp = null;
if (AVATAR) {
  avatar = "failed";
  let png = null;
  try { png = readFileSync(AVATAR); } catch { /* reported as failed */ }
  if (png && png.length <= ICON_MAX && png.subarray(0, 8).equals(PNG)) {
    const sha = createHash("sha256").update(png).digest("hex");
    const [stampSha, stampMxc] = STAMP.split(" ");
    const now = await call("GET", profile("avatar_url"));
    const current = now.status === 200 ? now.json?.avatar_url : null;
    if (stampSha === sha && MXC.test(stampMxc ?? "") && current === stampMxc) {
      avatar = "kept"; avatarStamp = `${sha} ${stampMxc}`;
    } else {
      const up = await call("POST", "/_matrix/media/v3/upload?filename=icon.png", png, "image/png");
      const mxc = up.json?.content_uri;
      if (up.status === 200 && typeof mxc === "string" && MXC.test(mxc)) {
        const w = await call("PUT", profile("avatar_url"), { avatar_url: mxc });
        if (w.status === 200) { avatar = "set"; avatarStamp = `${sha} ${mxc}`; }
      }
    }
  }
}

process.stdout.write(`${JSON.stringify({ user: USER, name, avatar, avatarStamp })}\n`);
