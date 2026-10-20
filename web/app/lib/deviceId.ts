// Per-browser Matrix device identity.
//
// INVARIANT: a device ID and its Rust crypto store (IndexedDB
// `mx-rust-{user}-{deviceId}`) are created together and destroyed together.
// Reusing a device ID with a fresh OlmMachine resets the one-time-key counter
// against keys the server already holds — the OTK-conflict loop that wedged
// sync in the 2026-06 crisis. Sign-in therefore reuses the stored ID only when
// its crypto store is still intact, and mints a fresh ID otherwise.
//
// The ID must satisfy MAS's authorization policy (≥10 chars, alphanumeric) and
// must match between the OAuth device scope at login time and createClient.

const KEY = "mx_device_id";

function generate(): string {
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 18);
  return `web${rand}`; // 21 chars, satisfies MAS policy
}

/** The device ID this browser last signed in with, if any. */
function getStoredDeviceId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(KEY);
}

/** Mint and persist a brand-new device ID (always fresh). */
function mintDeviceId(): string {
  const id = generate();
  if (typeof window !== "undefined") localStorage.setItem(KEY, id);
  return id;
}

/** Forget the device ID — call ONLY alongside deleting its crypto store. */
export function clearDeviceId(): void {
  if (typeof window !== "undefined") localStorage.removeItem(KEY);
}

/** True if an intact Rust crypto store exists for this device ID. */
async function hasIntactCryptoStore(deviceId: string): Promise<boolean> {
  if (typeof indexedDB === "undefined" || !indexedDB.databases) return false;
  const dbs = await indexedDB.databases().catch(() => [] as IDBDatabaseInfo[]);
  return dbs.some((db) => {
    const n = db.name ?? "";
    return n.startsWith("mx-rust-") && n.includes(`-${deviceId}`);
  });
}

/**
 * Device ID to use for a new sign-in: the stored one when its crypto store
 * survives (re-login keeps the same Matrix device → verification persists),
 * otherwise a fresh one.
 */
export async function deviceIdForSignIn(): Promise<string> {
  const existing = getStoredDeviceId();
  if (existing && (await hasIntactCryptoStore(existing))) return existing;
  return mintDeviceId();
}
