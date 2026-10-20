// The last known E2EE verdict, remembered across reloads.
//
// WHY THIS EXISTS. `useEncryptionStatus` can only compute a verdict once the
// Matrix client reaches "ready", so before that it holds `null` — and the account
// card renders anything that is not "green" as **"Encryption needs setup"**.
// Without a remembered verdict, a user who had already set encryption up would
// be told to set it up again on every load, until and unless they opened the
// community and waited for a full sync — advice that is WRONG, in the
// direction that makes people redo work they had already done.
//
// Booting Matrix just to answer the question is the fix we do NOT want:
// starting the client is what begins /sync, the crypto stores and
// the unread-message traffic. The whole point of the identity tier is that a
// viewer who never opens the community never pays for it.
//
// So: remember the answer. It was computed properly at least once, on this
// device, for this account.
//
// It is a CACHE, not a source of truth. A remembered "green" can be stale if
// the device was un-verified elsewhere — but the failure modes are not
// symmetric. Stale green shows a correct-looking row until the client boots and
// corrects it; stale red tells the user to redo setup. Between two
// kinds of wrong, prefer the one that does not create work.

/**
 * The E2EE traffic-light state. Declared HERE rather than in useEncryptionStatus
 * so this module imports nothing: the hook pulls in MatrixClientContext (a
 * .tsx), and a type-only edge back to it would both create a cycle and put this
 * file beyond `node --test`. The hook re-exports the type for its callers.
 */
export type EncryptionVerdict = "red" | "yellow" | "green" | null;

const PREFIX = "bb_enc-verdict:";

// Keyed per user: a shared browser must not show one account's verdict for
// another's, and "encryption ready" is exactly the claim you don't want to
// inherit from whoever was signed in before you.
const keyFor = (userId: string) => PREFIX + userId;

function isVerdict(v: unknown): v is Exclude<EncryptionVerdict, null> {
  return v === "red" || v === "yellow" || v === "green";
}

/**
 * The last verdict computed for this account on this device, or `null` if we
 * have never computed one.
 *
 * Call from an EFFECT, never during render — reading localStorage while
 * rendering makes the server and client markup disagree, and this value drives
 * a className.
 */
export function readRememberedVerdict(userId: string | null | undefined): EncryptionVerdict {
  if (!userId || typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(keyFor(userId));
    return isVerdict(v) ? v : null;
  } catch {
    // Private-mode / blocked storage. Falling back to "not remembered" is
    // exactly the old behaviour, so this degrades rather than breaking.
    return null;
  }
}

/** Record a freshly computed verdict. `null` is never stored — it means "we do
 *  not know", and overwriting a real answer with it is the bug this file fixes. */
export function rememberVerdict(userId: string | null | undefined, verdict: EncryptionVerdict): void {
  if (!userId || typeof window === "undefined" || !isVerdict(verdict)) return;
  try {
    window.localStorage.setItem(keyFor(userId), verdict);
  } catch { /* quota or blocked — the verdict is still correct in memory */ }
}

/**
 * Drop every remembered verdict. Called from signOutEverything.
 *
 * ALL of them, not just the signed-out user's. Sign-out wipes the crypto
 * stores and mints a fresh device id, so no verdict recorded on this browser
 * describes anything that still exists — including one left by an account that
 * signed out earlier. "Encryption ready" is precisely the claim you must not
 * inherit, and it is the one that would survive a per-user delete.
 */
export function forgetAllVerdicts(): void {
  if (typeof window === "undefined") return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k?.startsWith(PREFIX)) doomed.push(k);
    }
    // Collected first: removeItem reindexes the store, so deleting mid-scan
    // skips entries.
    for (const k of doomed) window.localStorage.removeItem(k);
  } catch { /* nothing to do */ }
}

/**
 * Which verdict a surface should show: the freshly COMPUTED one when we have it,
 * the remembered one only to fill the gap before it exists.
 *
 * The order is the whole safety property, and it is one character away from
 * being backwards. Inverted, a remembered "green" would survive the client
 * computing "red" — the app would keep telling someone their encryption was
 * ready after learning that it is not. The cache may only ever answer a question
 * nothing else has answered yet.
 */
export function effectiveVerdict(
  computed: EncryptionVerdict,
  remembered: EncryptionVerdict
): EncryptionVerdict {
  return computed ?? remembered;
}
