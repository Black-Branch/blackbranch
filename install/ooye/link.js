// The Admin Panel's link calls, made from INSIDE the bridge's container, where its as_token already is.
// The bridge's link API answers only a page session sealed with that token (OOYE src/web/auth.js:
// h3 useSession, password reg.as_token); this seals one with OOYE's own iron-webcrypto, for the one
// call, and the token never leaves the container (the site never holds it). Run by the host
// (`blackbranch` discord_call), cwd /data beside registration.yaml:
//
//   node link.js link-space   <mxid> <guild> <space room>
//   node link.js privacy      <mxid> <guild>                 (privacy level "link": the space stays open)
//   node link.js link         <mxid> <guild> <room> <channel>
//   node link.js unlink       <mxid> <guild> <channel>
//   node link.js unlink-space <mxid> <guild>
//
// Prints ONE JSON line, {"ok":bool,"status":number|null,"data":string}: the bridge's own answer (its
// refusal text in data), or status null when it did not answer. Exit 0 whenever that line is printed;
// 1 for a bad call, which never reaches the bridge.
//
// The session names the community's service account as the Matrix side and the one Discord server as
// managed; it lives five minutes and never carries the bridge page's password (which would unlock its
// add-the-bot buttons). BB_OOYE_ROOT moves where OOYE's modules are found (the tests).
"use strict"
const fs = require("fs")
const path = require("path")
const { createRequire } = require("module")
const { randomUUID, webcrypto } = require("crypto")

const GUILD = /^\d{17,20}$/
const ROOM = /^![A-Za-z0-9._~+/=:-]{1,255}$/
const MXID = /^@[a-z0-9._=/+-]{1,255}:[A-Za-z0-9.:-]{1,255}$/
const TTL_MS = 5 * 60_000
const TIMEOUT_MS = 30_000

const CALLS = {
  "link-space": { args: [GUILD, ROOM], path: "/api/link-space", body: ([guild, space]) => ({ guild_id: guild, space_id: space }) },
  privacy: { args: [GUILD], path: "/api/privacy-level", body: ([guild]) => ({ guild_id: guild, privacy_level: "link" }) },
  link: { args: [GUILD, ROOM, GUILD], path: "/api/link", body: ([guild, room, channel]) => ({ guild_id: guild, matrix: room, discord: channel }) },
  unlink: { args: [GUILD, GUILD], path: "/api/unlink", body: ([guild, channel]) => ({ guild_id: guild, channel_id: channel }) },
  "unlink-space": { args: [GUILD], path: "/api/unlink-space", body: ([guild]) => ({ guild_id: guild }) },
}

function fail(msg) {
  process.stderr.write(`link: ${msg}\n`)
  process.exit(1)
}

async function main() {
  const [action, mxid, ...args] = process.argv.slice(2)
  const call = CALLS[action]
  if (!call) fail(`usage: link.js ${Object.keys(CALLS).join("|")} <mxid> <ids…>`)
  if (!MXID.test(mxid ?? "")) fail("not a Matrix user id")
  if (args.length !== call.args.length || !call.args.every((re, i) => re.test(args[i]))) fail(`${action}: the ids are not in their shape`)
  let reg
  try { reg = JSON.parse(fs.readFileSync("registration.yaml", "utf8")) } catch { fail("no registration.yaml here") }
  if (typeof reg.as_token !== "string" || reg.as_token.length < 32) fail("the registration names no as_token")
  const ooye = createRequire(path.join(process.env.BB_OOYE_ROOT || "/opt/ooye", "start.js"))
  const iron = ooye("iron-webcrypto")
  const guild = args[0]
  const session = { id: randomUUID(), createdAt: Date.now(), data: { mxid, managedGuilds: [guild], userID: "0" } }
  const sealed = await iron.seal(webcrypto, session, reg.as_token, { ...iron.defaults, ttl: TTL_MS })
  const port = Number(reg.socket) || 6693
  let res
  try {
    res = await fetch(`http://127.0.0.1:${port}${call.path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `h3=${sealed}` },
      body: JSON.stringify(call.body(args)),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return out({ ok: false, status: null, data: "" })
  }
  const text = await res.text().catch(() => "")
  let data = text
  try {
    const j = JSON.parse(text)
    data = typeof j.data === "string" ? j.data : typeof j.message === "string" ? j.message : text
  } catch { /* not JSON: the text as it came */ }
  const ok = res.ok || (res.status >= 300 && res.status < 400)
  out({ ok, status: res.status, data: ok ? "" : String(data).replace(/\s+/g, " ").slice(0, 400) })
}

function out(o) {
  process.stdout.write(`${JSON.stringify(o)}\n`)
}

main().catch((e) => fail(e && e.message ? e.message : String(e)))
