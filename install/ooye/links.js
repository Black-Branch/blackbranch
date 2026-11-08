// What the bridge has linked, and the one row the panel cannot make through the bridge's own API.
// Run by the host inside the running bridge container (cwd /data, beside ooye.db):
//
//   node --no-warnings /opt/blackbranch-ooye/links.js dump
//   node --no-warnings /opt/blackbranch-ooye/links.js activate <discord server id>
//
// dump      one JSON line on stdout: the Discord servers the bridge knows (guild_active, and the
//           space each is linked to, guild_space) and every channel ↔ room link (channel_room; the
//           bridge's own thread rooms left out).
//           Read only.
// activate  marks a Discord server as one the bridge may link, in self-service mode (autocreate 0:
//           the bridge makes no rooms of its own; the panel links each room), then dumps. Discord's
//           add-the-bot sign-in normally writes this row, and it needs the client secret the panel
//           does without. Writing it again sets self-service again; nothing else is touched.
//
// node:sqlite (in the image's Node), not OOYE's own driver: SQLite's file locks keep this and the
// running bridge out of each other's way, and a busy database is waited for, never written over.
"use strict"
const { DatabaseSync } = require("node:sqlite")

const DB = process.env.BB_OOYE_DB || "ooye.db"
const GUILD = /^\d{17,20}$/

function fail(msg) {
  process.stderr.write(`links: ${msg}\n`)
  process.exit(1)
}

function dump(db) {
  const guilds = db.prepare(`SELECT a.guild_id AS guildId, a.autocreate, s.space_id AS spaceId, s.privacy_level AS privacyLevel
    FROM guild_active a LEFT JOIN guild_space s USING (guild_id) ORDER BY a.guild_id`).all()
  // Channels only: a Discord thread the bridge opened as a room of its own is the bridge's, and a busy
  // server makes thousands of them.
  const links = db.prepare(`SELECT channel_id AS channelId, room_id AS roomId, guild_id AS guildId, name
    FROM channel_room WHERE thread_parent IS NULL ORDER BY guild_id, channel_id`).all()
  return {
    v: 1,
    guilds: guilds.map((g) => ({ guildId: g.guildId, autocreate: g.autocreate, spaceId: g.spaceId ?? null, privacyLevel: g.privacyLevel ?? null })),
    links: links.map((l) => ({ channelId: l.channelId, roomId: l.roomId, guildId: l.guildId, name: l.name })),
  }
}

const [verb, arg] = process.argv.slice(2)
if (verb !== "dump" && verb !== "activate") fail("usage: links.js dump | activate <discord server id>")
if (verb === "activate" && !GUILD.test(arg ?? "")) fail("a Discord server id is 17 to 20 digits")
let db
try {
  db = new DatabaseSync(DB, { readOnly: verb === "dump" })
  db.exec("PRAGMA busy_timeout = 10000")
} catch (e) {
  fail(`cannot open ${DB}: ${e.message}`)
}
try {
  if (verb === "activate") {
    db.prepare("INSERT INTO guild_active (guild_id, autocreate) VALUES (?, 0) ON CONFLICT (guild_id) DO UPDATE SET autocreate = 0").run(arg)
  }
  process.stdout.write(`${JSON.stringify(dump(db))}\n`)
} catch (e) {
  fail(/no such table/.test(e.message) ? "the bridge has not set up its database yet" : e.message)
} finally {
  db.close()
}
