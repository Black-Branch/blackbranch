// What the browser does when the Matrix token route says the session has ended. Pure, so
// matrixSessionEnd.test.ts runs every answer; MatrixClientContext.tsx acts on the verdict.
//
// Only a CONFIRMED revoke ("revoked": the account server says the device is gone) wipes a crypto
// store, and only that device's store. A "signed_out" answer — any refusal the account server did
// not confirm, a row removed elsewhere — signs the site out and keeps the store and the device id,
// so the next sign-in resumes the same device (deviceId.ts). Vault systems/matrix-crypto.md.

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, "_");
}

/** The Rust crypto store prefix for one (user, device): `mx-rust-{user}-{device}`. */
export function cryptoStorePrefix(userId: string, deviceId: string): string {
  return `mx-rust-${sanitize(userId)}-${sanitize(deviceId)}`;
}

/** Every store of one user, any device. */
export function userStorePrefix(userId: string): string {
  return `mx-rust-${sanitize(userId)}-`;
}

export type SessionEnd =
  /** Wipe the stores named by `prefix` (null = every Matrix store: the account itself is gone and
   *  the server did not say which device), forget the device id, sign out. */
  | { kind: "wipe"; prefix: string | null }
  /** Sign out of the site; keep every store and the device id. */
  | { kind: "sign-out" };

/** The verdict for a token-route answer, or null when the session has not ended. */
export function sessionEndFrom(status: number, body: unknown): SessionEnd | null {
  if (status !== 401 || !body || typeof body !== "object") return null;
  const b = body as { reason?: unknown; matrixId?: unknown; deviceId?: unknown };
  if (b.reason === "signed_out") return { kind: "sign-out" };
  if (b.reason !== "revoked") return null;
  const user = typeof b.matrixId === "string" && b.matrixId ? b.matrixId : null;
  const device = typeof b.deviceId === "string" && b.deviceId ? b.deviceId : null;
  if (user && device) return { kind: "wipe", prefix: cryptoStorePrefix(user, device) };
  if (user) return { kind: "wipe", prefix: userStorePrefix(user) };
  return { kind: "wipe", prefix: null };
}
