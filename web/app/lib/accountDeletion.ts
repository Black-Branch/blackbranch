// Self-serve "Delete my account" (Settings → Privacy). SERVER ONLY.
//
// WHO: only the signed-in account itself — its id from the server-signed session, never from the
// request — from a FRESH sign-in (this session's site.user_sessions.signed_in_at, set by the
// sign-in callbacks only and never by a token refresh, within FRESH_MS), typing its account name,
// with no active subscription (cancel it first — the ONLY thing that blocks a deletion). Runs at
// once; cannot be undone.
// OPEN MODERATION CASES never block it (anyone could file a report to stop a deletion forever);
// instead the deletion keeps what the case depends on, detached from the profile and visible to
// moderators only: with an active ban, an open mark, a message held for review or an open report,
// their messages keep their TEXT (rows marked deleted = mods-only; the author is the tombstone),
// and with an active ban their platform links stay on the tombstone so the same platform
// identities cannot be linked again by a fresh account (a platform account belongs to one site
// account) — the ban keeps holding them.
//
// REMOVES: profile and settings, badges and unlocked styles shown, platform links and their
// stored tokens, their site messages (text removed, rows kept as tombstones so threads stay
// intact; quotes of them in other people's replies too), our copies of the platform lines of
// identities that are theirs ALONE, their AI memory (every plugin's too — never shared notes),
// votes, the points balance, sessions, support conversations. The Matrix account is
// deactivated with erase.
// KEEPS (and the confirm screen says so): payment records the law requires — amount, date,
// processor ids — with the name and message stripped; and moderation records — bans (by account
// id), the mod log, reports, review rows (with their text), suspicious marks (cleared ones: there
// can be no open one), slow mode.
//
// The account row itself is NOT deleted: chat rows and bans reference it and several of those
// keys cascade, so it stays as a tombstone (personal columns cleared, deleted_at set).
// Order: the AI memory and stream-side copies (stream-api, while the identity links still
// exist) → the site erase (ONE transaction, which also reads the credentials it removes) → those
// credentials revoked at their issuers → the Matrix account. Nothing is revoked before the erase
// commits, so a deletion that stops early leaves the person signed in to an intact account.
// site.account_deletions records how far it got, so a Matrix step that failed is visible to the
// operator and can be redone.

import pool from "../../lib/db.ts";
import { streamApiFetch } from "./streamApi.ts";
import { forfeitCoinsForDeletion } from "./coinsServer.ts";
import { eraseMatrixAccount, localpartOf, matrixEraseAvailable } from "./matrixAccountErase.ts";
import { markAccountDeleted } from "./deletedAccounts.ts";
import { decToken } from "./tokenCrypto.ts";
import { oauthRevoke } from "./matrixOAuthClient.ts";
import { revokePlatformGrant } from "./platformRevoke.ts";
import { NATIVE_SQL } from "./nativePlatform.ts";
import { BILLED_PROVIDERS, stillBills } from "./subscriptions/entitlement.ts";
import { cancelPaypalForDeletion, PaypalCancelError } from "./subscriptions/paypal.ts";

export const FRESH_MS = 15 * 60_000;

/** The name a person types to confirm: their account's local name (the part before ':'). Pure.
 *  @test-only exported so the confirm rule is tested directly; this module is its caller. */
export function accountNameOf(matrixId: string): string {
  const m = /^@([^:]+):/.exec(matrixId);
  return m ? m[1]! : matrixId;
}

/** Does the typed text confirm this account? Exact, after trimming and case-folding. Pure.
 *  @test-only exported so the confirm rule is tested directly; deleteAccount is its caller. */
export function confirmsName(typed: unknown, matrixId: string): boolean {
  return typeof typed === "string" && typed.trim().toLowerCase().replace(/^@/, "") === accountNameOf(matrixId).toLowerCase();
}

export type DeletionCheck = {
  accountName: string;
  /** When this browser session signed in, and whether that is recent enough. */
  signedInAt: string | null; fresh: boolean;
  /** An active subscription blocks deletion until it is cancelled. */
  activeSubscription: boolean;
  /** An active ban: the deletion keeps the platform links (the ban holds them) and the evidence. */
  banned: boolean;
  /** When the active ban ends — the latest end of a timeout; null when there is none or one is permanent. */
  banEndsAt: string | null;
  /** Open moderation cases: the deletion keeps their evidence (message text), mods-only. */
  openCases: { mark: boolean; held: boolean; report: boolean };
  /** Can this site deactivate the Matrix account itself? If not, the operator does it. */
  matrixErase: "automatic" | "operator" | "elsewhere";
};

export async function deletionCheck(matrixId: string, sessionId: string | null, now = Date.now()): Promise<DeletionCheck> {
  const [sess, active, ban] = await Promise.all([
    sessionId
      ? pool.query<{ signed_in_at: Date }>(`SELECT signed_in_at FROM site.user_sessions WHERE session_id = $1 AND matrix_id = $2`, [sessionId, matrixId])
      : Promise.resolve({ rows: [] as { signed_in_at: Date }[] }),
    // A subscription the SITE bills that will still charge them (subscription records, §9 of the
    // subscription-sources design): a deleted account must not keep being charged by us.
    stillBills(pool, matrixId),
    pool.query<{ active: boolean; permanent: boolean; ends: Date | null }>(
      `SELECT COUNT(*) > 0 AS active, COALESCE(bool_or(expires_at IS NULL), false) AS permanent, MAX(expires_at) AS ends
         FROM site.bans WHERE matrix_id = $1 AND (expires_at IS NULL OR expires_at > NOW())`, [matrixId]),
  ]);
  const cases = (await pool.query<{ mark: boolean; held: boolean; report: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM site.user_marks WHERE matrix_id = $1 AND cleared_at IS NULL)
              OR EXISTS (SELECT 1 FROM site.user_marks m JOIN site.platform_links p ON p.canonical_id = m.canonical_id
                          WHERE p.matrix_id = $1 AND m.cleared_at IS NULL) AS mark,
            EXISTS (SELECT 1 FROM site.automod_held WHERE matrix_id = $1 AND status IN ('pending', 'blocked', 'flagged')) AS held,
            EXISTS (SELECT 1 FROM site.reports WHERE reported_id = $1 AND status <> 'resolved') AS report`, [matrixId])).rows[0];
  const signedIn = sess.rows[0]?.signed_in_at ? new Date(sess.rows[0].signed_in_at) : null;
  const local = localpartOf(matrixId);
  return {
    accountName: accountNameOf(matrixId),
    signedInAt: signedIn ? signedIn.toISOString() : null,
    fresh: !!signedIn && now - signedIn.getTime() <= FRESH_MS,
    activeSubscription: active,
    banned: !!ban.rows[0]?.active,
    banEndsAt: ban.rows[0]?.active && !ban.rows[0].permanent && ban.rows[0].ends ? new Date(ban.rows[0].ends).toISOString() : null,
    openCases: { mark: !!cases?.mark, held: !!cases?.held, report: !!cases?.report },
    matrixErase: !local ? "elsewhere" : (await matrixEraseAvailable().catch(() => false)) ? "automatic" : "operator",
  };
}

/** When the restriction a deletion leaves on the account's platform ids ends (stream.erased_restrictions,
 *  v156): a TIMEOUT's end, when nothing else holds it. A permanent ban or any open case → null (never).
 *  @test-only exported for accountDeletion.test.ts; deleteAccount (this file) is its caller. */
export function restrictionExpiry(check: Pick<DeletionCheck, "banned" | "banEndsAt" | "openCases">): string | null {
  const open = check.openCases.mark || check.openCases.held || check.openCases.report;
  return check.banned && !open ? check.banEndsAt : null;
}

/** The site erase, in the caller's transaction.
 *  @test-only exported for its real-Postgres test; deleteAccount is its caller. */
export async function eraseSiteData(client: { query: typeof pool.query }, matrixId: string,
  keep: { evidence: boolean; links: boolean } = { evidence: false, links: false }): Promise<Record<string, number>> {
  const n: Record<string, number> = {};
  const run = async (label: string, sql: string) => { n[label] = (await client.query(sql, [matrixId])).rowCount ?? 0; };
  // Quotes of them inside OTHER people's replies are public — gone either way.
  await run("quotesOfThem", `UPDATE site.chat_messages SET reply_to_text = NULL, reply_to_username = NULL
    WHERE reply_to_id IN (SELECT id FROM site.chat_messages WHERE matrix_id = $1) AND (reply_to_text IS NOT NULL OR reply_to_username IS NOT NULL)`);
  if (keep.evidence) {
    // An open case: the text stays as evidence, mods-only (a deleted row reaches moderators only),
    // its author the tombstone. Hidden text and cards go; the visible words a case is about stay.
    await run("messagesKeptForModerators", `UPDATE site.chat_messages SET encrypted_text = NULL, event_json = NULL,
      reply_to_text = NULL, reply_to_username = NULL, is_deleted = true WHERE matrix_id = $1`);
  } else {
    // Tombstones: text, hidden text, emotes, cards and quotes gone; the row stays for the thread.
    await run("messages", `UPDATE site.chat_messages SET message = '', encrypted_text = NULL, emotes = NULL, event_json = NULL,
      reply_to_text = NULL, reply_to_username = NULL, is_deleted = true WHERE matrix_id = $1`);
  }
  // Pins are snapshots of a message: a pin of theirs is unpinned and its copy blanked (the read
  // path re-checks the source too, messageVisibility.ts — this is what makes the copy itself go).
  await run("pins", `UPDATE site.pinned_messages SET active = FALSE, unpinned_at = COALESCE(unpinned_at, now()),
      message = '', username = 'Deleted account', emotes = NULL
    WHERE platform IN ${NATIVE_SQL} AND message_id IN (SELECT id FROM site.chat_messages WHERE matrix_id = $1)`);
  // Payment records stay; the name and the message on them go.
  await run("donations", `UPDATE site.donations SET display_name = NULL, message = NULL, anonymous = true WHERE matrix_id = $1`);
  n.pointsForfeited = await forfeitCoinsForDeletion(client, matrixId);
  // Subscription records of services the site does NOT bill (Patreon, Ko-fi, Twitch, Kick): the
  // service is the merchant and keeps its own record, and ours carry ids that lead back to the
  // person there — deleted, with their payments and events (bodies included). The site-billed
  // ones (Stripe, PayPal) are payment records and stay on the tombstone (DELETION_DECLARATION).
  const notBilled = `SELECT provider, external_id FROM site.subscription_records WHERE matrix_id = $1 AND provider <> ALL($2::text[])`;
  n.subscriptionEvents = (await client.query(
    `DELETE FROM site.subscription_events WHERE (provider, external_id) IN (${notBilled})`, [matrixId, BILLED_PROVIDERS])).rowCount ?? 0;
  n.subscriptionPayments = (await client.query(
    `DELETE FROM site.subscription_payments WHERE record_id IN (SELECT id FROM site.subscription_records WHERE matrix_id = $1 AND provider <> ALL($2::text[]))`,
    [matrixId, BILLED_PROVIDERS])).rowCount ?? 0;
  n.subscriptionRecords = (await client.query(
    `DELETE FROM site.subscription_records WHERE matrix_id = $1 AND provider <> ALL($2::text[])`, [matrixId, BILLED_PROVIDERS])).rowCount ?? 0;
  // PayPal: every subscription of theirs that could still charge — a live record, or one an approval
  // popup created and no webhook has reported yet — is cancelled AT PAYPAL before the intents that
  // name them are erased. A refusal there throws and refuses the deletion, so it is retried whole.
  n.paypalCancelled = (await cancelPaypalForDeletion(matrixId, client)).cancelled;
  for (const [label, sql] of [
    ["atprotoSessions", `DELETE FROM site.atproto_sessions WHERE did IN (SELECT a.provider_account_id FROM site.accounts a WHERE a.matrix_id = $1 AND a.provider = 'streamplace'
       AND NOT EXISTS (SELECT 1 FROM site.accounts o WHERE o.provider = 'streamplace' AND o.provider_account_id = a.provider_account_id AND o.matrix_id <> $1))`],
    ["accounts", "DELETE FROM site.accounts WHERE matrix_id = $1"],
    ["sessions", "DELETE FROM site.user_sessions WHERE matrix_id = $1"],
    ["settings", "DELETE FROM site.user_settings WHERE matrix_id = $1"],
    ["presets", "DELETE FROM site.setting_presets WHERE matrix_id = $1"],
    ["behavior", "DELETE FROM site.user_behavior WHERE matrix_id = $1"],
    ["nudges", "DELETE FROM site.user_nudges WHERE matrix_id = $1"],
    ["signupAnswers", "DELETE FROM site.signup_answers WHERE matrix_id = $1"],
    ["presence", "DELETE FROM site.presence WHERE matrix_id = $1"],
    ["badgeSlots", "DELETE FROM site.badge_slots WHERE matrix_id = $1"],
    ["badgeUnlocks", "DELETE FROM site.badge_unlocks WHERE matrix_id = $1"],
    ["styleUnlocks", "DELETE FROM site.user_style_unlocks WHERE matrix_id = $1"],
    ["emotes", "DELETE FROM site.user_emotes WHERE matrix_id = $1"],
    ["radioLikes", "DELETE FROM site.radio_likes WHERE matrix_id = $1"],
    ["terminalAccounts", "DELETE FROM site.term_accounts WHERE matrix_id = $1"],
    ["terminalFiles", "DELETE FROM site.term_files WHERE matrix_id = $1"],
    ["terminalSnapshots", "DELETE FROM site.term_snapshots WHERE matrix_id = $1"],
    ["messageVotes", "DELETE FROM site.message_votes WHERE voter_matrix_id = $1"],
    ["forumVotes", "DELETE FROM site.forum_votes WHERE voter_matrix_id = $1"],
    // The points-for-upvotes tally: the votes they gave, and who voted for them. What was paid
    // stays in the ledger.
    ["upvoteTallies", "DELETE FROM site.coin_earn_upvotes WHERE voter = $1 OR recipient = $1"],
    ["supportTickets", "DELETE FROM site.support_tickets WHERE matrix_id = $1"],
    ["earnRows", "DELETE FROM site.coin_earn_stream WHERE matrix_id = $1"],
    ["deviceHealth", "DELETE FROM site.device_health WHERE matrix_id = $1"],
    ["pendingSignIns", "DELETE FROM site.federated_pending WHERE matrix_id = $1"],
    ["memoryOptOut", "DELETE FROM site.memory_opt_outs WHERE matrix_id = $1"],
    // Membership links, PayPal subscribe intents, and Ko-fi claims open or closed (a typed email
    // goes with its claim).
    ["subscriptionAccounts", "DELETE FROM site.subscription_accounts WHERE matrix_id = $1"],
    ["subscriptionIntents", "DELETE FROM site.subscription_intents WHERE matrix_id = $1"],
    ["subscriptionClaims", "DELETE FROM site.subscription_claims WHERE matrix_id = $1"],
    ["clientErrors", "UPDATE site.client_errors SET matrix_id = NULL WHERE matrix_id = $1"],
  ] as const) await run(label, sql);
  // Platform links: removed — unless a ban is active, when they stay on the tombstone so the ban
  // keeps holding those platform identities (no other account can link one; the tokens are gone).
  if (!keep.links) await run("platformLinks", "DELETE FROM site.platform_links WHERE matrix_id = $1");
  // The account row: a tombstone (bans, kept chat rows and payment rows reference it).
  await run("profile", `UPDATE site.users SET display_name = 'Deleted account', email = NULL, avatar_url = NULL, username_color = NULL,
    username_style = NULL, banner_mxc = NULL, bio = NULL, mx_refresh_token = NULL, mx_access_token = NULL, mx_token_expires = NULL,
    oidc_token_endpoint = NULL, oidc_client_id = NULL, mx_device_id = NULL, display_name_changed_at = NULL, profile_synced_at = NULL,
    is_admin = false, is_mod = false, show_links = false, deleted_at = now() WHERE matrix_id = $1`);
  return n;
}

/**
 * What the erase does with every per-person column of the site schema, declared in one place.
 * `deletionCoverage.test.ts` reads the generated baseline schema (migrations/baseline/schema.sql)
 * and fails when a `site.*` column ending in `matrix_id`, or any `site.users` column, is in none of
 * these lists or in two — so a new per-person table or profile column cannot ship without someone
 * deciding whether a deletion removes it. Keys are `table.column` (schema `site`).
 *   erased       — the person's rows are deleted, or detached / blanked (eraseSiteData above);
 *   kept         — rows the deletion keeps, with the reason;
 *   resetColumns — `site.users` columns the tombstone UPDATE writes (the test holds the UPDATE to it);
 *   keptColumns  — `site.users` columns the tombstone keeps, with the reason.
 * @test-only the completeness test is its reader; eraseSiteData is what acts on it.
 */
export const DELETION_DECLARATION = {
  erased: [
    "accounts.matrix_id", "user_sessions.matrix_id", "user_settings.matrix_id", "setting_presets.matrix_id",
    "user_behavior.matrix_id", "user_nudges.matrix_id", "signup_answers.matrix_id", "presence.matrix_id",
    "badge_slots.matrix_id", "badge_unlocks.matrix_id", "user_style_unlocks.matrix_id", "user_emotes.matrix_id",
    "radio_likes.matrix_id", "term_accounts.matrix_id", "term_files.matrix_id", "term_snapshots.matrix_id",
    "message_votes.voter_matrix_id", "forum_votes.voter_matrix_id", "coin_earn_upvotes.voter", "coin_earn_upvotes.recipient",
    "support_tickets.matrix_id", "coin_earn_stream.matrix_id", "device_health.matrix_id", "federated_pending.matrix_id",
    "memory_opt_outs.matrix_id", "client_errors.matrix_id",
    "subscription_accounts.matrix_id", "subscription_intents.matrix_id", "subscription_claims.matrix_id",
    // Rows kept so threads stay intact; text, hidden text, emotes and quotes blanked (evidence of an
    // open case is kept for moderators only).
    "chat_messages.matrix_id",
    // Removed — unless a ban is active, when they stay on the tombstone so the ban keeps holding them.
    "platform_links.matrix_id",
  ],
  kept: {
    "users.matrix_id": "the tombstone row itself: bans, kept chat rows and payment rows reference it",
    "account_deletions.matrix_id": "the deletion's own progress record (which steps finished), for the operator",
    "donations.matrix_id": "a payment record the law requires; the name and the message on it are removed",
    "payment_events.matrix_id": "a payment record the law requires (amount, date, processor ids)",
    "paypal_coin_orders.matrix_id": "a payment record the law requires (amount, date, processor ids)",
    "stripe_customers.matrix_id": "the payment processor's customer id, kept with the payment records",
    "subscriptions.matrix_id": "a billing record; a deletion is refused while one is active",
    "subscription_records.matrix_id": "a billing record of a service the site bills (Stripe, PayPal); a deletion is refused while one still renews. The records of services it does not bill are deleted by the erase",
    "gift_pending.gifter_matrix_id": "a paid gift: a payment record",
    "gift_subscriptions.gifter_matrix_id": "a paid gift: a payment record",
    "gift_subscriptions.recipient_matrix_id": "a gift someone else paid for: their payment record",
    "sticker_boosts.booster_matrix_id": "a paid boost: a payment record",
    "coin_ledger.matrix_id": "the points ledger is append-only; the forfeit of the balance is its last row",
    "coin_wallets.matrix_id": "the balance is forfeited to zero; the row is the ledger's account",
    "forum_votes.author_matrix_id": "votes other people cast on their posts: the voters' records, now naming the tombstone",
    "bans.matrix_id": "moderation record: a ban outlives the account it was placed on",
    "user_marks.matrix_id": "moderation record (suspicious marks)",
    "user_slow_mode.matrix_id": "moderation record (slow mode)",
    "automod_held.matrix_id": "moderation record: messages held for review, with their text",
    "reports.reported_id": "moderation record: reports about them",
    "reports.reporter_id": "moderation record: reports they filed",
    "mod_log.target_id": "moderation record: the mod log",
  },
  resetColumns: [
    "display_name", "email", "avatar_url", "username_color", "username_style", "banner_mxc", "bio",
    "mx_refresh_token", "mx_access_token", "mx_token_expires", "oidc_token_endpoint", "oidc_client_id", "mx_device_id",
    "display_name_changed_at", "profile_synced_at", "is_admin", "is_mod",
    // Off, so the one consent predicate (linkConsent.ts) reads "not consenting" for a canonical the
    // tombstone still holds through a ban's kept platform links.
    "show_links",
    "deleted_at",
  ],
  keptColumns: {
    matrix_id: "the key the kept rows reference",
    created_at: "when the account was made: not personal, and ordering ties on it",
    homeserver: "the server part of the account id, which the key already carries",
    is_bot: "whether the account was a bot account: decides how its kept rows are read",
  },
} as const;

type Credentials = {
  sessions: { mx_access_token: string | null; mx_refresh_token: string | null }[];
  grants: { provider: string; access_token: string | null; refresh_token: string | null }[];
};

/**
 * Every credential the site holds for this account, read in the erase's own transaction just
 * before the rows go — so what is revoked is exactly what was deleted. Not a grant whose
 * platform account another site account also links: revoking it at the provider would cut that
 * other account's link too (a shared identity) — only this account's rows go, in the erase.
 */
async function readCredentials(client: { query: typeof pool.query }, matrixId: string): Promise<Credentials> {
  const sess = await client.query<Credentials["sessions"][number]>(
    `SELECT mx_access_token, mx_refresh_token FROM site.user_sessions WHERE matrix_id = $1`, [matrixId]);
  const acc = await client.query<Credentials["grants"][number]>(
    `SELECT a.provider, a.access_token, a.refresh_token FROM site.accounts a
      WHERE a.matrix_id = $1 AND a.type = 'oauth'
        AND NOT EXISTS (SELECT 1 FROM site.accounts o WHERE o.provider = a.provider AND o.provider_account_id = a.provider_account_id AND o.matrix_id <> $1)`, [matrixId]);
  return { sessions: sess.rows, grants: acc.rows };
}

/**
 * Revoke them at their issuers: each browser session's Matrix tokens (MAS ends that session and
 * its device) and each linked platform's OAuth grant. Runs only AFTER the erase committed — a
 * deletion that stops earlier leaves the person signed in, not locked out of an account that
 * still exists. Best-effort per token (an issuer that is down must not undo a finished
 * deletion); the session callback refuses the account from then on (deletedAccounts.ts).
 */
async function revokeAtIssuers(c: Credentials): Promise<{ matrixSessions: number; platformGrants: number }> {
  await Promise.allSettled(c.sessions.flatMap((r) => {
    const out: Promise<unknown>[] = [];
    const refresh = decToken(r.mx_refresh_token);
    const access = decToken(r.mx_access_token);
    if (refresh) out.push(oauthRevoke(refresh, "refresh_token"));
    if (access) out.push(oauthRevoke(access, "access_token"));
    return out;
  }));
  await Promise.allSettled(c.grants.map((r) => revokePlatformGrant(r.provider, { access: decToken(r.access_token), refresh: decToken(r.refresh_token) })));
  return { matrixSessions: c.sessions.length, platformGrants: c.grants.length };
}

/** The 502 when the stream side did not answer: the account, its sign-ins and its site data are
 *  all still there; only part of the AI memory may already be gone (that call is idempotent). */
const STREAM_FAILED = "The chat service didn't answer, so your account was not deleted and you are still signed in. Some of what the AI remembers about you may already be gone. Try again in a minute.";

export type DeletionResult =
  | { ok: true; matrix: "erased" | "operator" | "elsewhere"; counts: Record<string, number> }
  | { ok: false; status: number; error: string };

/** The whole deletion. Every precondition is re-checked HERE, on the server. */
export async function deleteAccount(matrixId: string, sessionId: string | null, typedName: unknown): Promise<DeletionResult> {
  if (!confirmsName(typedName, matrixId)) return { ok: false, status: 400, error: "Type your account name exactly to confirm." };
  const check = await deletionCheck(matrixId, sessionId);
  if (!check.fresh) return { ok: false, status: 403, error: "Sign in again first — deleting needs a sign-in from the last 15 minutes." };
  if (check.activeSubscription) return { ok: false, status: 409, error: "Cancel your subscription first, then delete your account." };
  // What an open case depends on is kept (see the header) — decided here, from server-side facts.
  const keep = { evidence: check.banned || check.openCases.mark || check.openCases.held || check.openCases.report, links: check.banned };

  await pool.query(`INSERT INTO site.account_deletions (matrix_id) VALUES ($1) ON CONFLICT (matrix_id) DO NOTHING`, [matrixId]);
  // 1. Stream side + AI memory, while the identity links still exist. Idempotent, so a retry
  // after a failure here or later simply runs it again. Nothing is revoked yet.
  const res = await streamApiFetch("/account/erase", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ matrixId, keepEvidence: keep.evidence, keepLinks: keep.links, restrictionExpiresAt: restrictionExpiry(check) }),
  }, 30_000).catch(() => null);
  if (!res?.ok) return { ok: false, status: 502, error: STREAM_FAILED };
  const stream = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  await pool.query(`UPDATE site.account_deletions SET memory_erased_at = now() WHERE matrix_id = $1`, [matrixId]);

  // 2. The site, in one transaction.
  const client = await pool.connect();
  let counts: Record<string, number>;
  let credentials: Credentials;
  try {
    await client.query("BEGIN");
    credentials = await readCredentials(client, matrixId);
    // A moderator's role ends with the account (the erase clears is_mod): recorded like every
    // other removal of it, appended to the mod log the erase itself never touches.
    await client.query(`INSERT INTO site.mod_log (action, target_id, performed_by, reason)
      SELECT 'mod_revoked', matrix_id, matrix_id, 'account deleted' FROM site.users WHERE matrix_id = $1 AND is_mod`, [matrixId]);
    counts = await eraseSiteData(client, matrixId, keep);
    await client.query(`UPDATE site.account_deletions SET site_erased_at = now() WHERE matrix_id = $1`, [matrixId]);
    await client.query("COMMIT");
    // Every session of this account, on every device, is refused from the next request on.
    markAccountDeleted(matrixId);
    // Open screens drop a pin that was theirs (GET /api/chat/pin re-checks on every load too).
    if (counts.pins) await streamApiFetch("/chat/pin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: null }) }).catch(() => {});
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[account] site erase failed:", (e as Error).message);
    if (e instanceof PaypalCancelError) {
      return { ok: false, status: 502, error: "PayPal could not be reached to cancel your PayPal subscription, so nothing else was deleted (your AI memory is already gone). Try again in a few minutes; it picks up where it stopped." };
    }
    return { ok: false, status: 500, error: "Deleting stopped partway — your AI memory is gone, the rest is not. Try again; it picks up where it stopped." };
  } finally {
    client.release();
  }
  // 3. Every credential the erase removed, revoked at its issuer — only now that it committed.
  const revoked = await revokeAtIssuers(credentials);
  for (const [k, v] of Object.entries(stream)) if (typeof v === "number") counts[`stream.${k}`] = v;
  counts.revokedMatrixSessions = revoked.matrixSessions;
  counts.revokedPlatformGrants = revoked.platformGrants;

  // 4. The Matrix account.
  if (check.matrixErase === "elsewhere") return { ok: true, matrix: "elsewhere", counts };
  const m = await eraseMatrixAccount(matrixId);
  if (m.ok) {
    await pool.query(`UPDATE site.account_deletions SET matrix_erased_at = now(), matrix_error = NULL WHERE matrix_id = $1`, [matrixId]);
    return { ok: true, matrix: "erased", counts };
  }
  await pool.query(`UPDATE site.account_deletions SET matrix_error = $2 WHERE matrix_id = $1`, [matrixId, m.code]);
  console.error(`[account] Matrix account not deactivated (${m.code}) — the operator must do it; see site.account_deletions`);
  await streamApiFetch("/ops/notify", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "account.matrix-erase", title: "Account deleted — Matrix account left", message: `A deleted site account's Matrix account was not deactivated (${m.code}). See site.account_deletions.` }),
  }).catch(() => {});
  return { ok: true, matrix: "operator", counts };
}
