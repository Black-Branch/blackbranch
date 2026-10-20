import pool from "@/lib/db";

type ModLogEntry = {
  // No DB CHECK backs this column — the union IS the contract, so anything
  // added here must also be understood by the mod-log readers.
  action:
    | "ban" | "timeout" | "unban" | "delete" | "purge" | "slowmode" | "slowmode_user"
    // Site-wide raid posture (v82). Unlike every other action these target the
    // SITE, not a user — `target` is the literal "site". HistorySection renders
    // unknown actions via its fallback branch, so adding here is safe; it has a
    // colour branch of its own so a site-wide lockdown doesn't read like a
    // routine delete.
    | "signups_disabled" | "signups_enabled"
    | "crosspost_disabled" | "crosspost_enabled"
    // v85. One action for both directions, with the threshold in the reason —
    // "min age 7d" and "min age off" are the same lever moving, and splitting
    // them into _enabled/_disabled would lose the NUMBER, which is the part a
    // post-raid review actually asks about.
    | "min_account_age_set"
    // v87. Re-grading a blocklist term at runtime. Target is the TERM, not a
    // user — the whole point is accountability for changing what the slur filter
    // does, and "who allowed this word" is the question a later review asks.
    // One action for both directions (the severity is in the reason) for the
    // same reason min_account_age_set is: /blacklist and /whitelist are the same
    // lever moving, and splitting them would lose the NUMBER.
    | "blocklist_override_set" | "blocklist_override_cleared"
    // v88. The link gate's posture. Site-wide like the raid levers, so `target`
    // is the literal "site"; the posture itself rides in the reason, because
    // "which of off/flag/hold" is the whole content of the action.
    | "link_gate_enabled" | "link_gate_disabled"
    // The mod kill switch (/api/mod/stream/end). Site-wide, so
    // `target` is the literal "site" and the ended session id rides in the
    // reason — so it is always known who ended the stream, even when the
    // poller re-opens a session moments later.
    | "stream_force_offline"
    // A mod setting someone's pronouns from their card or
    // `/pronouns @name`; the value (or "cleared") rides in the reason.
    | "pronouns_set"
    // The AI automod switch flipped from the Mod Panel; the lockdown's
    // levers (ingest per platform, sub-only chat) and its expiry. Site-wide: target "site";
    // the platforms / expiry ride in the reason.
    | "automod_enabled" | "automod_disabled"
    | "ingest_paused_set" | "sub_only_enabled" | "sub_only_disabled" | "lockdown_expiry_set" | "lockdown_reason_set"
    // A mod deleting someone's terminal password (`sudo passwd -d
    // name`) so they can run passwd for a new one — the promise in the message
    // passwd prints ("ask a mod to reset it for you").
    | "term_passwd_deleted"
    // A person's AI memory forgotten — written by stream-api memory.js,
    // never through appendModLog; listed so the readers' contract is complete.
    // performed_by = the admin, or the person themselves when they opted out.
    | "memory_forget"
    // A mod's announcement to everyone on the site; target is
    // the literal "site", the text rides in the reason.
    | "announce"
    // The mod role granted or removed (/mod, /unmod, the user card, the Admin Panel's
    // moderator list, or a permanent ban of a mod — reason "banned"). The newest of the two
    // per account is what the owner's client reads to take community room powers back.
    | "mod_granted" | "mod_revoked";
  target: string;
  by: string;
  durationMinutes?: number | null;
  expiresAt?: string | null;
  reason?: string | null;
  /** Groups a purge's site row with its platform_mod_actions fan-out rows. */
  batchId?: string | null;
};

// Append-only moderation audit trail in site.mod_log. Never throws — logging
// must not break a mod action.
export async function appendModLog(entry: ModLogEntry) {
  try {
    await pool.query(
      `INSERT INTO site.mod_log
         (action, target_id, performed_by, duration_minutes, expires_at, reason, batch_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.action,
        entry.target,
        entry.by,
        entry.durationMinutes ?? null,
        entry.expiresAt ?? null,
        entry.reason ?? null,
        entry.batchId ?? null,
      ]
    );
  } catch {
    // swallow — audit logging is best-effort
  }
}
