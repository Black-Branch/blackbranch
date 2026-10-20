'use strict';
// The database test files run in parallel (node --test), against one database. An aggregate
// rebuild (a whole-table INSERT … SELECT FROM stream.users) and another file's fixture cleanup
// (DELETE FROM stream.users) race: the rebuild reads a person, the cleanup commits their deletion,
// and the rebuild's insert fails its foreign key. The files that do either take this one advisory
// lock around it, so the two never overlap. (testlib/ is not deployed — see source.js.)

const KEY = 0x6c79626b; // any constant shared by every caller

/** Run `fn` holding the shared test lock on its own connection of `pool`. */
async function serially(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock($1)', [KEY]);
    try { return await fn(); } finally { await c.query('SELECT pg_advisory_unlock($1)', [KEY]).catch(() => {}); }
  } finally {
    c.release();
  }
}

module.exports = { serially };
