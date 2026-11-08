// The bridge container's first process (under Docker's init, compose `init: true`): it starts OOYE
// and keeps it started, so an outage outside the box never becomes a crash loop.
//
// OOYE reads every setting from ONE file in its working directory, registration.yaml, and has no
// environment variables. That file has one owner, the renderer (`blackbranch render`), which writes
// it into the read-only /config mount; this process links it into /data and never writes it.
//
// In order:
//   1. wait (without exiting) until /config/registration.yaml is there and names a bot token;
//   2. wait until /data is writable by this user (a volume made by another uid is said, not hidden);
//   3. run init.js: the database's migrations, and on the first run only the steps of OOYE's own
//      setup that touch no Discord application (the bot's `sim` row, the sender registered);
//   4. run OOYE itself.
// When step 3 or 4 stops (Discord or the homeserver down, a token refused), the next try waits
// 5 s, then twice as long each time, up to 5 min; a run that lasted 10 min starts the wait over.
// The container stays running all the while; its health check says whether OOYE answers, and the
// one word in STATE_FILE says what this process is doing (the host's doctor reads it):
//   waiting-settings  no usable registration yet (step 1)    waiting-storage  /data not writable (2)
//   setup             init.js runs (3)                       running          OOYE runs (4)
//   retrying          the wait before the next try
//
// BB_OOYE_CONFIG, BB_OOYE_INIT, BB_OOYE_START, BB_OOYE_STATE_FILE and the two BB_OOYE_*_MS move the
// defaults below (install/ooye.test.mjs runs this file with stand-ins for OOYE).
"use strict"
const fs = require("fs")
const path = require("path")
const { spawn } = require("child_process")

const CONFIG = process.env.BB_OOYE_CONFIG || "/config"
const INIT = process.env.BB_OOYE_INIT || path.join(__dirname, "init.js")
const START = process.env.BB_OOYE_START || "/opt/ooye/start.js"
const DATA = process.cwd()
const REG_SOURCE = path.join(CONFIG, "registration.yaml")
const REG_LINK = path.join(DATA, "registration.yaml")
const FIRST_DELAY_MS = Number(process.env.BB_OOYE_FIRST_DELAY_MS) || 5_000
const MAX_DELAY_MS = 300_000
const LONG_RUN_MS = 600_000
const POLL_MS = Number(process.env.BB_OOYE_POLL_MS) || 10_000
const STATE_FILE = process.env.BB_OOYE_STATE_FILE || "/tmp/bridge-state"

const log = (msg) => console.log(`[bridge] ${msg}`)
let stopping = false
let child = null
let wake = null

/** The one word the host reads; a failed write only costs the doctor its detail. */
function state(word) {
  try { fs.writeFileSync(`${STATE_FILE}.new`, `${word}\n`); fs.renameSync(`${STATE_FILE}.new`, STATE_FILE) } catch { /* said by the doctor as "not checked" */ }
}

function stop(signal) {
  if (stopping) return
  stopping = true
  if (child) child.kill(signal)
  else process.exit(0)
  if (wake) wake()
}
process.on("SIGTERM", () => stop("SIGTERM"))
process.on("SIGINT", () => stop("SIGINT"))

const sleep = (ms) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms)
  wake = () => { clearTimeout(t); resolve() }
})

/** Why the renderer's registration cannot be used yet, or "" when it can. */
function registrationProblem() {
  let text
  try { text = fs.readFileSync(REG_SOURCE, "utf8") } catch { return `${REG_SOURCE} is not there yet (blackbranch render writes it once the Discord bridge is set up)` }
  let reg
  try { reg = JSON.parse(text) } catch { return `${REG_SOURCE} is not the JSON registration OOYE reads` }
  if (!reg || typeof reg !== "object" || !reg.ooye || typeof reg.ooye !== "object") return `${REG_SOURCE} has no "ooye" block`
  if (!reg.ooye.discord_token) return `${REG_SOURCE} names no Discord bot token`
  return ""
}

function dataProblem() {
  try { fs.accessSync(DATA, fs.constants.W_OK); return "" } catch {
    let owner = "another user"
    try { owner = `uid ${fs.statSync(DATA).uid}` } catch { /* the folder itself is unreadable: said by the line below */ }
    return `the bridge's data folder ${DATA} belongs to ${owner} and this container runs as uid ${process.getuid()}: it cannot keep its database there`
  }
}

/** Wait, saying why once per new reason, until `problem()` has none (or a stop is asked). */
async function waitFor(problem, word) {
  let said = ""
  for (;;) {
    const p = problem()
    if (!p || stopping) return
    state(word)
    if (p !== said) { log(`waiting: ${p}`); said = p }
    await sleep(POLL_MS)
  }
}

// /data/registration.yaml is a link to the renderer's file: OOYE reads it there, the volume keeps
// no copy of its secrets, and a fresh render is read at the next start.
function linkRegistration() {
  let current = null
  try { current = fs.lstatSync(REG_LINK).isSymbolicLink() ? fs.readlinkSync(REG_LINK) : "(a file)" } catch { /* none yet */ }
  if (current === REG_SOURCE) return
  if (current !== null) fs.rmSync(REG_LINK, { force: true })
  fs.symlinkSync(REG_SOURCE, REG_LINK)
}

/** Run one node script to its end; → its exit code (signals count as a failure). */
function run(script, args = []) {
  return new Promise((resolve) => {
    child = spawn(process.execPath, ["--enable-source-maps", script, ...args], { cwd: DATA, stdio: ["ignore", "inherit", "inherit"] })
    child.on("error", (e) => { log(`could not start ${script}: ${e.message}`) })
    child.on("exit", (code, signal) => { child = null; resolve(code === null ? (signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1) : code) })
  })
}

async function main() {
  await waitFor(registrationProblem, "waiting-settings")
  await waitFor(dataProblem, "waiting-storage")
  if (stopping) process.exit(0)
  linkRegistration()
  let delay = FIRST_DELAY_MS
  for (;;) {
    const began = Date.now()
    state("setup")
    let code = await run(INIT)
    let what = "its setup"
    if (code === 0 && !stopping) { state("running"); code = await run(START); what = "the bridge" }
    if (stopping) process.exit(0)
    if (Date.now() - began >= LONG_RUN_MS) delay = FIRST_DELAY_MS
    state("retrying")
    log(`${what} stopped (exit ${code}); starting again in ${Math.round(delay / 1000)} s`)
    await sleep(delay)
    if (stopping) process.exit(0)
    delay = Math.min(delay * 2, MAX_DELAY_MS)
  }
}

main().catch((e) => { log(`stopped: ${e && e.message ? e.message : e}`); process.exit(1) })
