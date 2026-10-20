// The lockdown's ingest lever: the platforms whose chat is not taken in while it holds. POST /chat (the
// one door platform chat comes through) asks `isIngestPaused` FIRST and drops a paused platform's
// message — not stored, not broadcast, answered 200 so stream-ingest does not retry it.
//
// Read from site.lockdown_now, so an expired lockdown reads as nothing paused. Cached for 5 s for
// the whole service, like the account-age lever: one small query per 5 s, never one per message.
// Fails OPEN for the same reason account-age.js does: this lever withholds conversation, so a
// read that throws must not mute a platform no mod paused.

const LEVER_TTL_MS = 5_000;

let lever = { value: [], at: 0 };

/** The paused platforms (cached). Never throws. */
async function pausedPlatforms(pool, now = Date.now()) {
  if (now - lever.at < LEVER_TTL_MS) return lever.value;
  try {
    const { rows } = await pool.query(`SELECT ingest_paused FROM site.lockdown_now WHERE id = 1`);
    const v = rows[0]?.ingest_paused;
    lever = { value: Array.isArray(v) ? v.map(String) : [], at: now };
  } catch (e) {
    console.error('[ingest-pause] lever read failed — treating as nothing paused', e.message);
    lever = { value: [], at: now };
  }
  return lever.value;
}

/** Is chat from this platform paused right now? */
async function isIngestPaused(pool, platform, now = Date.now()) {
  if (!platform) return false;
  const paused = await pausedPlatforms(pool, now);
  return paused.includes(String(platform).toLowerCase());
}

/** Test seam: forget the cached lever. */
function _resetIngestPause() {
  lever = { value: [], at: 0 };
}

module.exports = { isIngestPaused, _resetIngestPause };
