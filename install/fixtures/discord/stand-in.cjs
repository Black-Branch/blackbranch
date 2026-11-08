// A stand-in Discord for the install tests (discord-import.test.mjs): serves guild.json beside it in
// Discord's REST shapes on a loopback port, prints the port, and logs every request
// ("<method> <path> <authorization>") to stderr. Its own process: the host command under test runs
// synchronously, so a server inside the test's own process could not answer it.
"use strict"
const http = require("http")
const path = require("path")
const RAW = JSON.parse(require("fs").readFileSync(path.join(__dirname, "guild.json"), "utf8"))
const G = RAW.guild.id
const routes = {
  "/users/@me": RAW.me, "/applications/@me": RAW.application, "/users/@me/guilds": RAW.guilds,
  [`/guilds/${G}`]: RAW.guild, [`/guilds/${G}/channels`]: RAW.channels, [`/guilds/${G}/roles`]: RAW.roles, [`/guilds/${G}/emojis`]: RAW.emojis,
}
const server = http.createServer((req, res) => {
  process.stderr.write(`${req.method} ${req.url} ${req.headers.authorization}\n`)
  const body = routes[req.url]
  res.writeHead(body ? 200 : 404, { "content-type": "application/json" })
  res.end(JSON.stringify(body ?? { message: "Unknown Guild", code: 10004 }))
})
server.listen(0, "127.0.0.1", () => process.stdout.write(`${server.address().port}\n`))
