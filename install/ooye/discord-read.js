// The Admin Panel's Discord reads, made from INSIDE the bridge's container, where the bot token
// already is (registration.yaml, ooye.discord_token): the token never leaves the container and the
// site never holds it. Read only: the one HTTP verb this file sends is GET, to Discord's REST API.
// Run by the host (`blackbranch` discord_read), cwd /data beside registration.yaml:
//
//   node discord-read.js bot            who the bot is, its three privileged switches, the servers it is
//                                       in, and the link that adds it to a server (OOYE's own permissions)
//   node discord-read.js guild <id>     one server: its channels (categories included) with their
//                                       permission overwrites, its roles, its emoji counts
//
// Prints ONE JSON line: {"v":1,"ok":true,…} or {"v":1,"ok":false,"status":number|null,"error":string}
// (status null: Discord did not answer). Exit 0 whenever that line is printed; 1 for a bad call.
// Honours Discord's 429 retry_after (three tries). BB_OOYE_ROOT moves where OOYE's modules are found
// and BB_DISCORD_API where Discord is (a loopback stand-in only, for the tests).
"use strict"
const fs = require("fs")
const path = require("path")
const { createRequire } = require("module")

const GUILD = /^\d{17,20}$/
const TIMEOUT_MS = 15_000
const TRIES = 3
const API = (() => {
  const v = process.env.BB_DISCORD_API
  return v && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(v) ? v : "https://discord.com/api/v10"
})()

// Application flags: the un-suffixed bit is a verified app's switch, the _LIMITED one an unverified
// app's (under 100 servers); either means the bot may use it.
const FLAGS = { presence: [1 << 12, 1 << 13], members: [1 << 14, 1 << 15], content: [1 << 18, 1 << 19] }

class Refused extends Error {
  constructor(status, message) { super(message); this.status = status }
}

function fail(msg) {
  process.stderr.write(`discord-read: ${msg}\n`)
  process.exit(1)
}
const out = (o) => process.stdout.write(`${JSON.stringify({ v: 1, ...o })}\n`)

async function get(token, p) {
  for (let i = 0; i < TRIES; i++) {
    let res
    try {
      res = await fetch(API + p, {
        method: "GET",
        headers: { Authorization: `Bot ${token}`, "User-Agent": "DiscordBot (https://blackbranch.app, 1)" },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw new Refused(null, "Discord did not answer")
    }
    if (res.status === 429 && i < TRIES - 1) {
      const body = await res.json().catch(() => ({}))
      await new Promise((r) => setTimeout(r, Math.min(10_000, Math.ceil((Number(body.retry_after) || 1) * 1000) + 50)))
      continue
    }
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      const said = body && typeof body.message === "string" ? body.message.slice(0, 200) : ""
      throw new Refused(res.status, said || `Discord answered ${res.status}`)
    }
    return body
  }
  throw new Refused(429, "Discord kept asking to wait")
}

const str = (v, max = 100) => (typeof v === "string" ? v.slice(0, max) : "")
const snow = (v) => (typeof v === "string" && GUILD.test(v) ? v : null)
const bits = (v) => (typeof v === "string" && /^\d{1,30}$/.test(v) ? v : "0")

async function bot(token) {
  const [me, app, guilds] = await Promise.all([get(token, "/users/@me"), get(token, "/applications/@me"), get(token, "/users/@me/guilds")])
  const flags = Number(app && app.flags) || 0
  const intents = Object.fromEntries(Object.entries(FLAGS).map(([k, [a, b]]) => [k, !!(flags & a) || !!(flags & b)]))
  const appId = snow(app && app.id)
  let invite = null
  try {
    const { permissions } = createRequire(path.join(process.env.BB_OOYE_ROOT || "/opt/ooye", "start.js"))("./addbot.js")
    if (appId && /^\d{1,30}$/.test(String(permissions))) invite = `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot&permissions=${permissions}`
  } catch { /* the link is OOYE's; without it the page says so */ }
  return {
    ok: true,
    bot: { id: snow(me && me.id), name: str(me && me.username) },
    appId, intents, invite,
    guilds: (Array.isArray(guilds) ? guilds : []).slice(0, 200).map((g) => ({ id: snow(g.id), name: str(g.name) })).filter((g) => g.id),
  }
}

async function guild(token, id) {
  const [g, channels, roles, emojis] = await Promise.all([
    get(token, `/guilds/${id}`), get(token, `/guilds/${id}/channels`), get(token, `/guilds/${id}/roles`), get(token, `/guilds/${id}/emojis`),
  ])
  const list = (v) => (Array.isArray(v) ? v.slice(0, 1000) : [])
  return {
    ok: true,
    guild: { id: snow(g.id), name: str(g.name), premiumTier: Number.isInteger(g.premium_tier) ? g.premium_tier : 0 },
    channels: list(channels).map((c) => ({
      id: snow(c.id), name: str(c.name), type: Number.isInteger(c.type) ? c.type : -1, position: Number.isInteger(c.position) ? c.position : 0,
      parentId: snow(c.parent_id), topic: typeof c.topic === "string" ? c.topic.slice(0, 1024) : null,
      overwrites: list(c.permission_overwrites).map((o) => ({ id: snow(o.id), type: o.type === 1 ? 1 : 0, allow: bits(o.allow), deny: bits(o.deny) })).filter((o) => o.id),
    })).filter((c) => c.id),
    roles: list(roles).map((r) => ({
      id: snow(r.id), name: str(r.name), position: Number.isInteger(r.position) ? r.position : 0, permissions: bits(r.permissions), managed: r.managed === true,
      tags: Object.fromEntries(Object.entries(r.tags && typeof r.tags === "object" ? r.tags : {}).slice(0, 10)
        .map(([k, v]) => [k.slice(0, 40), typeof v === "string" ? v.slice(0, 40) : null])),
    })).filter((r) => r.id),
    emoji: { static: list(emojis).filter((e) => !e.animated).length, animated: list(emojis).filter((e) => e.animated).length },
    readAt: new Date().toISOString(),
  }
}

async function main() {
  const [action, id] = process.argv.slice(2)
  if (action === "bot" ? id !== undefined : !(action === "guild" && GUILD.test(id ?? ""))) fail("usage: discord-read.js bot | guild <discord server id>")
  let reg
  try { reg = JSON.parse(fs.readFileSync("registration.yaml", "utf8")) } catch { fail("no registration.yaml here") }
  const token = reg && reg.ooye && reg.ooye.discord_token
  if (typeof token !== "string" || !token) return out({ ok: false, status: null, error: "no Discord bot token is set" })
  try {
    out(action === "bot" ? await bot(token) : await guild(token, id))
  } catch (e) {
    if (e instanceof Refused) return out({ ok: false, status: e.status, error: e.message })
    throw e
  }
}

main().catch((e) => fail(e && e.message ? e.message : String(e)))
