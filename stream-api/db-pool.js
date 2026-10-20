'use strict';
// The Postgres pool's options and the API's last error handler (review round 5, F2).
//
// The pool used to carry no connection or statement timeout, so a hung database — a socket that
// accepts and never answers, a lock nobody releases — held every request open forever, and every
// money hold with it (alert.js retries a ledger write for ~108 s, but only if each attempt RETURNS).
// Each bound below turns that into an error the caller can act on: the ledger retries it as
// transient (alert.js isTransientDbError — no SQLSTATE, or 57014), and a request answers 503
// "database unavailable" instead of hanging.
//
//   connectionTimeoutMillis  5 s   — waiting for a pooled client OR for a new connection's
//                                    handshake. Same-LAN database: a healthy connect takes
//                                    milliseconds; a full pool for 5 s is itself an outage signal.
//   statement_timeout        60 s  — server-side, per statement. Well above the slowest request-path
//                                    statement (the aggregate rebuild is a whole-table pass); low
//                                    enough that a lock wait cannot pin a connection indefinitely.
//   query_timeout            65 s  — client-side read timeout: catches a database that stopped
//                                    answering at all (network partition), where the server-side
//                                    timer can never report back. Above statement_timeout so the
//                                    server's own cancel (a clean 57014) fires first.
//   idle_in_transaction      60 s  — a transaction whose client hung (a stuck await between BEGIN
//                                    and COMMIT) releases its row and advisory locks.
// Each is overridable by env (DB_CONNECT_TIMEOUT_MS, DB_STATEMENT_TIMEOUT_MS); garbage or 0 keeps
// the default — a typo must never turn a bound off.

const DB_TIMEOUTS = Object.freeze({
  connectionTimeoutMillis: 5_000,
  statement_timeout: 60_000,
  queryGraceMs: 5_000,
  idle_in_transaction_session_timeout: 60_000,
});

function positiveMs(raw, fallback) {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** Options for `new Pool(...)` from the process environment. */
function poolOptions(env) {
  const statement = positiveMs(env.DB_STATEMENT_TIMEOUT_MS, DB_TIMEOUTS.statement_timeout);
  return {
    host:     env.DB_HOST     ?? 'localhost',
    port:     parseInt(env.DB_PORT ?? '5432', 10),
    database: env.DB_NAME     ?? 'stream',
    user:     env.DB_USER     ?? 'streamer',
    password: env.DB_PASSWORD,
    max:      Number(env.DB_POOL_MAX || 20),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: positiveMs(env.DB_CONNECT_TIMEOUT_MS, DB_TIMEOUTS.connectionTimeoutMillis),
    statement_timeout: statement,
    query_timeout: statement + DB_TIMEOUTS.queryGraceMs,
    idle_in_transaction_session_timeout: Math.max(DB_TIMEOUTS.idle_in_transaction_session_timeout, statement),
  };
}

// pg / pg-pool's own messages for the client-side bounds (they carry no code), and the SQLSTATEs
// for "the server cancelled or dropped us" — never a constraint or data error, which is a bug.
const UNAVAILABLE_MESSAGE = /timeout exceeded when trying to connect|Connection terminated|Query read timeout/i;
const UNAVAILABLE_CODE = /^(08|57P|57014|53300|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND)/;

/** Is `err` "the database is unavailable" (as opposed to a bug)? */
function isDbUnavailable(err) {
  if (!err) return false;
  if (typeof err.code === 'string' && UNAVAILABLE_CODE.test(err.code)) return true;
  return typeof err.message === 'string' && UNAVAILABLE_MESSAGE.test(err.message);
}

/** The API's last error handler (four parameters: that is how express knows it). Full detail goes to the journal; the caller gets a generic body
 *  so internal error strings (SQL text, stack frames, file paths) never leak (SA-SEC-003). */
function apiErrorHandler(err, req, res, next) {
  const down = isDbUnavailable(err);
  console.error(down ? '[API] database unavailable:' : '[API] Unhandled error:', (err && (err.stack || err.message)) || err);
  if (res.headersSent) return next(err);
  if (down) return res.status(503).json({ error: 'database unavailable' });
  res.status(500).json({ error: 'internal error' });
}

module.exports = { poolOptions, isDbUnavailable, apiErrorHandler, DB_TIMEOUTS };
