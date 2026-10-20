// Own-device key checks against the SERVER's copy.
//
// Fresh OlmMachines running under ONE live device id each re-upload device
// keys. Synapse keeps the cross-signing signature it already holds for a device
// (`_process_self_signatures`: "we already have a signature on this device, so
// we can skip it, since it should be exactly the same"), so once the keys under
// a signed device change, that device can never be re-signed — a recovery-key
// restore then sits at "Confirming verification…" forever, with nothing
// reported: the skip is a 200 with no failure entry.
//
// Two consumers, one truth:
//   • boot (MatrixClientContext.setupCrypto): local keys ≠ the server's copy
//     means the store was replaced under a live device id → discard the device
//     BEFORE the first sync would overwrite the server's keys again.
//   • restore (useMatrixEncryptionSetup): when trust never lands, say WHY in
//     the words of the server's state, and offer the one remedy that works —
//     a fresh device.
//
// Pure classifiers + one fetch with an injectable transport, so the tests run
// every branch without a Matrix client.

/** The server's `/keys/query` entry for one device (the fields we read). */
export type ServerDeviceKeys = {
  keys?: Record<string, string>;
  signatures?: Record<string, Record<string, string>>;
};

type KeysQueryResponse = {
  device_keys?: Record<string, Record<string, ServerDeviceKeys>>;
};

/** The narrow client shape the fetch needs — a MatrixClient satisfies it. */
type KeysQueryClient = {
  baseUrl: string;
  getAccessToken(): string | null;
};

/**
 * The server's copy of ONE device's keys. `null` when the server has no entry
 * (a device that never uploaded). Throws on transport failure or a non-2xx —
 * callers decide whether an unanswered question blocks them.
 */
export async function fetchServerDeviceKeys(
  client: KeysQueryClient,
  userId: string,
  deviceId: string,
  fetchFn: typeof fetch = fetch,
): Promise<ServerDeviceKeys | null> {
  const token = client.getAccessToken();
  if (!token) throw new Error("no access token for /keys/query");
  const res = await fetchFn(`${client.baseUrl}/_matrix/client/v3/keys/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ device_keys: { [userId]: [deviceId] } }),
  });
  if (!res.ok) throw new Error(`/keys/query ${res.status}`);
  const json = (await res.json()) as KeysQueryResponse;
  return json.device_keys?.[userId]?.[deviceId] ?? null;
}

type OwnKeyState = "absent" | "match" | "mismatch";

/** Does the server's ed25519 key for this device equal the one in this store? */
export function ownDeviceKeyState(
  local: { ed25519: string },
  server: ServerDeviceKeys | null,
  deviceId: string,
): OwnKeyState {
  const serverKey = server?.keys?.[`ed25519:${deviceId}`];
  if (!serverKey) return "absent";
  return serverKey === local.ed25519 ? "match" : "mismatch";
}

/** Does the server already hold a self-signing-key signature on this device? */
function hasSelfSignature(
  server: ServerDeviceKeys | null,
  userId: string,
  selfSigningKey: string | null,
): boolean {
  if (!selfSigningKey) return false;
  return typeof server?.signatures?.[userId]?.[`ed25519:${selfSigningKey}`] === "string";
}

type VerifyFailure = "keys-replaced" | "stale-signature" | "not-signed";

/** Why a restore's cross-signature never made this device trusted. */
function classifyVerifyFailure(keyState: OwnKeyState, signed: boolean): VerifyFailure {
  if (keyState === "mismatch") return "keys-replaced";
  return signed ? "stale-signature" : "not-signed";
}

/** The remedy named in every message — the section renders a button with these words. */
export const FRESH_DEVICE_ACTION = "Start this device over";

export function verifyFailureMessage(failure: VerifyFailure): string {
  switch (failure) {
    case "keys-replaced":
      return `Verification failed: this browser's encryption keys no longer match the copy the server holds for this device. ${FRESH_DEVICE_ACTION} to get a fresh device, then enter your recovery key again.`;
    case "stale-signature":
      return `Verification failed: the server still holds an old verification for this device from before its keys changed, and it will not replace it. ${FRESH_DEVICE_ACTION} to get a fresh device, then enter your recovery key again.`;
    case "not-signed":
      return `Verification failed: the server did not accept this device's signature. ${FRESH_DEVICE_ACTION}, or try the recovery key again.`;
  }
}

/** One call for the restore flow: the server's state → a named failure. */
export function diagnoseVerifyFailure(input: {
  local: { ed25519: string };
  server: ServerDeviceKeys | null;
  userId: string;
  deviceId: string;
  selfSigningKey: string | null;
}): VerifyFailure {
  const keyState = ownDeviceKeyState(input.local, input.server, input.deviceId);
  const signed = hasSelfSignature(input.server, input.userId, input.selfSigningKey);
  return classifyVerifyFailure(keyState, signed);
}
