'use strict';
// A person's PUBLIC id on one platform (config/public-id.mjs has the why and the construction).
// The public chat socket carries this, never the canonical id: a viewer's Twitch lines and
// their YouTube lines carry two ids nobody outside the install can tie together.
//
// The key comes from STREAM_API_SECRET, the secret web already shares with this process, so web
// makes the same id for the same person (the history it reads from the database) and reads back
// the ids this process put on the socket — no new setting, no lookup table. A box without the
// secret (a dev box with STREAM_API_ENFORCE=0) gets a random key for this process: ids still
// hide the canonical, web simply cannot read them back.

const crypto = require('crypto');
const { PUBLIC_ID } = require('./publicId.generated');
const { ERASED_CANONICAL } = require('./account-erase');
const { NATIVE_SQL } = require('./native-platform');

let keys = null;
function currentKeys(env = process.env) {
  if (keys) return keys;
  const secret = env.STREAM_API_SECRET || '';
  if (!secret) {
    console.warn('[pseudonym] STREAM_API_SECRET unset — public ids use a key of this process only (web cannot read them)');
  }
  keys = PUBLIC_ID.keys(crypto, secret || crypto.randomBytes(32).toString('hex'));
  return keys;
}

/** The public id of `canonical` on `platform`; null for no canonical, and for the shared
 *  erased-person row (every deleted person's kept lines point at it — one id for all of them
 *  would be a meaningless "person"). */
function publicIdFor(canonical, platform) {
  if (!canonical || canonical === ERASED_CANONICAL) return null;
  return PUBLIC_ID.make(crypto, currentKeys(), canonical, platform);
}

/** { canonical, platform } behind a public id this install made; null otherwise. */
function parsePublicId(id) {
  return PUBLIC_ID.parse(crypto, currentKeys(), id);
}

/** SQL: no site account linked to `canonicalExpr` (by either link table) has show_links off — the
 *  one consent predicate for showing a cross-platform link, the same text web uses
 *  (config/public-id.mjs noOptOutSql). `canonicalExpr` is developer-written SQL, never input. */
function noOptOutSql(canonicalExpr) {
  return PUBLIC_ID.noOptOutSql(canonicalExpr, NATIVE_SQL);
}

/** @test-only a fresh key from `env` (the tests swap the secret). */
function _resetPseudonymKeyForTests(env) {
  keys = null;
  if (env) currentKeys(env);
}

module.exports = { publicIdFor, parsePublicId, noOptOutSql, _resetPseudonymKeyForTests };
