// Recording platform-origin blocklist hits for moderator review.
//
// The site half of this lives in web/app/lib/blocklistReview.ts; this is the
// same row, written from the ingest side. Both land in `site.automod_held`, so
// the inline chat bar surfaces platform and native hits with no special-casing.
//
// Why platform rows are always 'blocked' and never 'pending':
// a pending row means "withheld, a mod may still publish it". For a message
// that arrived FROM Twitch/YouTube/Kick there is nothing to publish — it is
// already public over there, and we simply declined to relay it into site chat.
// The row exists so a mod can ban the sender on the other platform: it renders
// with Dismiss, not Allow/Deny, and the actual action is the cross-platform ban
// tooling the mod presses deliberately.

/**
 * Fire-and-forget. Never awaited, never throws.
 *
 * The caller has already decided not to relay the message — that decision is
 * made in memory by `classify`, so a failed write costs a review row, never a
 * leaked message. Awaiting it would put a DB round trip in the ingest path,
 * which every platform message pays.
 */
function recordPlatformReview({ pool, verdict, text, platform, username, canonicalId }) {
  if (!pool) return;
  void pool
    .query(
      `INSERT INTO site.automod_held
         (source, platform, user_id, user_name, text, category, level, matched_term, status)
       VALUES ('blocklist', $1, $2, $3, $4, $5, $6, $7, 'blocked')`,
      [
        platform || null,
        canonicalId || null,
        username || null,
        text,
        // `category` is the Twitch queue's "why" column; reusing it means the
        // existing bar renders these with no changes.
        (verdict.tags && verdict.tags[0]) || 'blocklist',
        verdict.severity,
        verdict.term,
      ]
    )
    .catch((e) => console.error('[blocklist] failed to record platform review row', e.message));
}

/**
 * Record a message withheld by the minimum-account-age lever.
 * Fire-and-forget, same contract as above.
 *
 * Status is 'pending', NOT 'blocked'. A blocklist block is a judgement about
 * the MESSAGE and must never be published; an age hold says nothing about the
 * message — only that we could not vouch for the account. While the lever is
 * armed that includes the ENTIRE Kick audience (Kick publishes no creation
 * date), so these rows need a working Allow button, not a Dismiss.
 */
function recordAgeReview({ pool, reason, minAgeDays, accountCreatedAt, text, platform, username, canonicalId }) {
  if (!pool) return;
  void pool
    .query(
      `INSERT INTO site.automod_held
         (source, platform, user_id, user_name, text, category, level, matched_term, status)
       VALUES ('account_age', $1, $2, $3, $4, $5, $6, $7, 'pending')`,
      [
        platform || null,
        canonicalId || null,
        username || null,
        text,
        // 'too_new' vs 'unknown_age' — the filter working vs the filter unable
        // to work. After a raid, "I turned away 40 fresh accounts" and "I turned
        // away my whole Kick audience" are different sentences.
        reason,
        minAgeDays,
        accountCreatedAt ? new Date(accountCreatedAt).toISOString().slice(0, 10) : 'unknown',
      ]
    )
    .catch((e) => console.error('[account-age] failed to record review row', e.message));
}

/**
 * Record a message withheld by the LINK GATE.
 *
 * `source = 'link_gate'` and `status = 'pending'`, and both matter.
 *
 * `source` is what the resolve route dispatches on to actually REPUBLISH the
 * message when a mod hits Allow. Reusing 'blocklist' would have made this a drop
 * wearing a hold's clothes: the row would resolve, the panel would say allowed,
 * and the message would never appear. That is precisely the failure the
 * account-age release path exists to prevent, and its comment says so —
 * "the difference between withhold and block, quietly erased".
 *
 * `status = 'pending'` (not 'blocked' like a slur hit) because a link IS
 * releasable. Nothing about it is unpublishable on sight; it is waiting on a
 * decision.
 *
 * EXCEPT in flag mode, where the status is 'flagged'. A flag-mode
 * message was DELIVERED — the row is a measurement, not a hold. If it were
 * 'pending' it would render Allow/Deny in the queue and Allow would republish
 * the message a second time. 'flagged' keeps it out of the actionable queue
 * (the bar lists pending/blocked) while staying countable for the sizing pass.
 */
function recordLinkReview({ pool, host, reason, text, platform, username, canonicalId, flagOnly }) {
  if (!pool) return;
  void pool
    .query(
      `INSERT INTO site.automod_held
         (source, platform, user_id, user_name, text, category, level, matched_term, status)
       VALUES ('link_gate', $1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        platform || null,
        canonicalId || null,
        username || null,
        text,
        // The queue's "why" column. The `:flag-only` suffix is kept alongside
        // the status so the sizing query can group on category alone.
        flagOnly ? `link:${reason}:flag-only` : `link:${reason}`,
        3,
        host,
        flagOnly ? 'flagged' : 'pending',
      ]
    )
    .catch((e) => console.error('[link-gate] failed to record review row', e.message));
}

module.exports = { recordPlatformReview, recordAgeReview, recordLinkReview };
