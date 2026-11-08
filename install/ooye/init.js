// The half of OOYE's `npm run setup` that touches no Discord application, run by entrypoint.js
// before every start (cwd /data). Upstream setup is interactive only, and past its prompts it edits
// the Discord application itself (the bot's avatar, application emojis): an install's panel owns
// that application, so none of it runs here.
//
//   every start   the database's migrations. OOYE's start.js prepares SQL as it loads, before its
//                 own migrate() runs, so an empty or older ooye.db stops it ("no such table").
//                 Local only: a Discord or homeserver outage cannot stop this step.
//   first start   (the sender has no `sim` row yet) what setup writes: the bot's Discord user mapped
//                 to the application service's sender, and the sender registered on the homeserver.
//                 These ask Discord and the homeserver; a failure exits 1 and entrypoint.js tries
//                 again later. Both are kept only once both succeed, so a half-done first start
//                 is simply done again.
"use strict"
const fs = require("fs")
const { createRequire } = require("module")

const OOYE = "/opt/ooye"
const TIMEOUT_MS = 15_000
const reg = JSON.parse(fs.readFileSync("registration.yaml", "utf8"))
const ooyeRequire = createRequire(`${OOYE}/start.js`)
const Sqlite = ooyeRequire("better-sqlite3")
const HeatSync = ooyeRequire("heatsync")
const passthrough = ooyeRequire("./src/passthrough")

const db = new Sqlite("ooye.db")
const sync = new HeatSync({ watchFS: false })
Object.assign(passthrough, { sync, db })
const orm = sync.require(`${OOYE}/src/db/orm`)
passthrough.from = orm.from
passthrough.select = orm.select

// A request that got no answer at all says where it went, not only "fetch failed".
const ask = (what, url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  .catch((e) => { throw new Error(`${what} did not answer (${e.cause?.code || e.name || "no answer"})`) })

async function firstStart(sender) {
  const me = await ask("Discord", "https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bot ${reg.ooye.discord_token}` } })
  if (!me.ok) throw new Error(`Discord answered ${me.status} for the bot token${me.status === 401 ? " (the token is not valid)" : ""}`)
  const bot = await me.json()
  // As OOYE's own api.register: M_USER_IN_USE is fine, and so is the 500 an older Synapse gives
  // for a sender that already exists.
  const r = await ask("the homeserver", `${reg.ooye.server_origin}/_matrix/client/v3/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${reg.as_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "m.login.application_service", inhibit_login: true, username: reg.sender_localpart }) })
  const body = await r.json().catch(() => ({}))
  if (!r.ok && body.errcode !== "M_USER_IN_USE" && body.error !== "Internal server error") {
    throw new Error(`the homeserver answered ${r.status} ${body.errcode || ""} when the bridge registered ${sender}`)
  }
  db.prepare("INSERT INTO sim (user_id, username, sim_name, mxid) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .run(bot.id, bot.username, reg.sender_localpart.slice(reg.ooye.namespace_prefix.length), sender)
  console.log(`[bridge] first start done: ${sender} registered, the bot's Discord account mapped to it`)
}

;(async () => {
  await ooyeRequire("./src/db/migrate").migrate(db)
  const sender = `@${reg.sender_localpart}:${reg.ooye.server_name}`
  if (!db.prepare("SELECT 1 FROM sim WHERE mxid = ?").get(sender)) await firstStart(sender)
  db.close()
  process.exit(0)
})().catch((e) => {
  console.error(`[bridge] setup did not finish: ${e && e.message ? e.message : e}`)
  try { db.close() } catch { /* already closed */ }
  process.exit(1)
})
