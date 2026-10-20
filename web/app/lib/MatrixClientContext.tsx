"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { signOut } from "next-auth/react";
// Type-only SDK imports here — ClientEvent/CryptoEvent are pulled from the
// dynamic import inside startClient. A static VALUE import of matrix-js-sdk in
// this file puts the whole SDK (+RustCrypto wasm glue, ~46% of homepage JS) in
// the first-load bundle, because this provider wraps every page.
import type { MatrixClient, SyncState, SyncStateData, MatrixError, SetPresence } from "matrix-js-sdk";
import { clearDeviceId } from "@/app/lib/deviceId";
import { fetchServerDeviceKeys, ownDeviceKeyState, type ServerDeviceKeys } from "@/app/lib/matrixDeviceKeys";
import { syncIgnoredBots } from "@/app/lib/ignoredBots";
import { PHASE_CANCELLED, PHASE_DONE } from "@/app/lib/matrixVerification";
import { installSyncCryptoDoor, refusedKeyUploadFetch } from "@/app/lib/matrixSyncCrypto";
import { registerReadiness, readReadiness } from "./readiness";
import { statusToMatrix, isSelfStatus } from "./presenceState";
import { MATRIX_READINESS_KEY, setMatrixHandle } from "./matrixHandle";
import { runSignOutHooks } from "./plugins/session";

// Module-level key store: holds the decoded recovery key briefly while 4S operations run.
// Set via setPendingSecretStorageKey before any crypto.loadSessionBackupPrivateKeyFromSecretStorage()
// or crypto.bootstrapCrossSigning() call, then cleared immediately after.
let _pendingSecretStorageKey: Uint8Array | null = null;
export function setPendingSecretStorageKey(key: Uint8Array | null) {
  _pendingSecretStorageKey = key;
}

// Suppress SDK informational logs (sync/RTC/push-rule notices) — keep warnings +
// errors only. Level-setting alone can't do it: matrix-js-sdk force-sets every
// logger to DEBUG on creation (logger.js getPrefixedLogger), and MatrixRTCSession
// logs through the GLOBAL rootLogger (not the client logger), so neither setLevel
// nor a createClient({logger}) option wins. Instead we override the global
// logger's `methodFactory` to return a no-op for trace/debug/info while leaving
// warn/error intact. getChild() copies the parent's methodFactory onto every
// child it creates (logger.js), so this propagates to sync/RTC/etc. loggers made
// later, and we also re-point any already-created matrix loggers.
if (typeof window !== "undefined") {
  import("matrix-js-sdk/lib/logger").then((mod) => {
    type LL = {
      methodFactory: (m: string, lvl?: unknown, name?: unknown) => (...a: unknown[]) => void;
      rebuild?: () => void;
      getLevel?: () => number;
      setLevel?: (l: number) => void;
    };
    const root = (mod as unknown as { logger?: LL }).logger;
    if (!root || typeof root.methodFactory !== "function") return;
    const QUIET = new Set(["trace", "debug", "info"]);
    const noop = () => {};
    // Specific benign messages the SDK logs at warn/error that aren't actionable:
    //  • pushprocessor announcing it's inserting a missing default push rule (warn)
    //  • transient /sync network blips, which the SDK auto-retries — the app still
    //    surfaces real connectivity loss via sync-state events + the UI indicator (error)
    // Dropped by exact prefix; every other warning/error still prints.
    const NOISE = [
      /^Adding default global (override|underride) push rule/,
      /^\/sync error/,
      /^Caught \/sync error/,
    ];
    const orig = root.methodFactory;
    const quiet: LL["methodFactory"] = function (this: unknown, methodName, lvl, name) {
      if (QUIET.has(methodName)) return noop;
      const real = orig.call(this, methodName, lvl, name);
      if (methodName === "warn" || methodName === "error") {
        return function (this: unknown, ...args: unknown[]) {
          if (typeof args[0] === "string" && NOISE.some((re) => re.test(args[0] as string))) return;
          return real.apply(this, args);
        };
      }
      return real;
    };
    try {
      root.methodFactory = quiet;
      if (root.rebuild) root.rebuild();
      else root.setLevel?.(root.getLevel?.() ?? 3);
      // Re-point matrix loggers that already exist (created before this ran).
      import("loglevel").then((ll) => {
        const L = ((ll as { default?: unknown }).default ?? ll) as {
          getLoggers?: () => Record<string, LL>;
        };
        Object.entries(L.getLoggers?.() ?? {}).forEach(([name, lg]) => {
          if (name.startsWith("matrix") && typeof lg.methodFactory === "function") {
            lg.methodFactory = quiet;
            lg.rebuild?.();
          }
        });
      }).catch(() => {});
    } catch { /* logger internals changed — non-fatal, warnings still print */ }
  }).catch(() => {});
}

export type MxStatus = "idle" | "loading" | "ready" | "notoken" | "error";

/** The readiness key the community pane and the encryption section compose — defined beside the
 *  handle so a surface that cannot load this module (the DM window's tests) can name it too. */
export { MATRIX_READINESS_KEY };
// The client's lifecycle as readiness stages: reported at the moments
// startClient already lives through, so the community pane can say WHICH step
// is running instead of "Joining community…" — and which one failed, with a
// retry.
const matrixReadiness = registerReadiness(MATRIX_READINESS_KEY, [
  { id: "token", label: "Checking your session" },
  { id: "sdk", label: "Loading Matrix" },
  { id: "crypto", label: "Preparing encryption" },
  { id: "sync", label: "Syncing the community" },
]);

type MxCtx = {
  client: MatrixClient | null;
  status: MxStatus;
  startClient: () => Promise<void>;
  /** Stop whatever is running, reset the start latch and start again — the
   *  control behind a failed readiness stage. */
  retry: () => void;
  pendingVerification: unknown | null;
  clearPendingVerification: () => void;
  // ── Identity tier (see useMatrixIdentity) ──
  matrixId: string | null;
  identityKnown: boolean;
};

const Ctx = createContext<MxCtx>({
  client: null, status: "idle", startClient: async () => {}, retry: () => {},
  pendingVerification: null, clearPendingVerification: () => {},
  matrixId: null, identityKnown: false,
});

export function useMatrixClient() { return useContext(Ctx); }

/**
 * Who the viewer is, WITHOUT requiring a running Matrix client.
 *
 * Read this — not `useMatrixClient().client?.getUserId()` — whenever all you
 * need is the user's id or a signed-in boolean. The `matrix_id` is the site's
 * own primary key (`site.users`), so the session already carries it; deriving it
 * from the client instead couples a nudge card or an own-message check to a
 * ~46%-of-bundle SDK, a RustCrypto WASM init and a perpetual `/sync` long-poll.
 * That coupling would make those surfaces impossible to render without paying
 * the whole client, and it is enforced by `matrixIdentity.test.ts`, which keeps
 * the allowlist of modules that genuinely need the client object itself.
 *
 * `identityKnown` distinguishes "signed out" from "not resolved yet" — a card
 * that treats the first render as signed-out will flash on every load.
 */
export function useMatrixIdentity(): { matrixId: string | null; identityKnown: boolean } {
  const { matrixId, identityKnown } = useContext(Ctx);
  return { matrixId, identityKnown };
}

/**
 * Declare that this surface needs the Matrix client, and start it if it is not
 * already running. Call it from a component that only mounts on real intent —
 * opening the community, or opening Devices & Security.
 *
 * The client is NOT started on page load. A signed-in viewer who watches the
 * stream and never opens the community would otherwise pay a perpetual ≤15s
 * `/sync` long-poll, SDK event processing, RustCrypto decryption of every room
 * event and IndexedDB writes, for surfaces they never saw. Nothing starts it
 * but this hook.
 *
 * Once started it stays started for the session — matching the one-way
 * `matrixOpened` latch in the chat sidebar rather than fighting it, and
 * `startClient` is idempotent, so calling this from several mounted surfaces is
 * fine.
 *
 * Do NOT call this from a widely-mounted component to "make the dot work".
 * The encryption dot and SecureAccountPrompt render *absent* while the client is
 * down (a null verdict yields no dot), which is correct:
 * they describe the security state of a Matrix session that is not in use, and
 * their natural start triggers are the two surfaces above.
 */
export function useStartMatrixClient(): void {
  const { startClient } = useContext(Ctx);
  useEffect(() => { void startClient(); }, [startClient]);
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, "_");
}

function cryptoStorePrefix(userId: string, deviceId: string): string {
  // Per-(user, device): a store can never be opened under a different device
  // identity, which is what used to corrupt the OlmMachine when browsers
  // shared one site.users token row.
  return `mx-rust-${sanitize(userId)}-${sanitize(deviceId)}`;
}

async function deleteMatrixDatabases(filter: (name: string) => boolean): Promise<void> {
  if (typeof indexedDB === "undefined" || !indexedDB.databases) return;
  const dbs = await indexedDB.databases().catch(() => [] as IDBDatabaseInfo[]);
  await Promise.allSettled(
    dbs
      .filter(db => filter(db.name ?? ""))
      .map(db => new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(db.name!);
        req.onsuccess = req.onerror = () => resolve();
      }))
  );
}

/** Wipe ALL Matrix-related stores (logout / revoked session). */
export async function clearAllMatrixDatabases(): Promise<void> {
  await deleteMatrixDatabases(n =>
    n.includes("matrix") || n.includes("crypto") || n.startsWith("mx-") || n === "idb"
  );
}

// Session revoked upstream (MAS account page, expiry, admin): local crypto
// state is unusable — the server-side device is gone. Wipe everything and
// sign out fully so the user gets a clean sign-in, not a half-dead session.
let revokedHandled = false;
async function handleRevokedSession(): Promise<void> {
  if (revokedHandled) return;
  revokedHandled = true;
  console.warn("[Matrix] session revoked — clearing local state and signing out");
  await clearAllMatrixDatabases().catch(() => {});
  clearDeviceId();
  runSignOutHooks();
  await signOut({ callbackUrl: "/" }).catch(() => {});
}

type TokenData = { accessToken: string; expiresAt: number; homeserver: string; deviceId?: string; presenceStatus?: string };

// In-flight refresh dedup: if multiple callers ask for a token at once (e.g.
// proactive timer + sync error handler), they share one request instead of
// racing MAS's refresh-token rotation.
let inFlightToken: Promise<TokenData | null> | null = null;

async function fetchFreshToken(): Promise<TokenData | null> {
  if (inFlightToken) return inFlightToken;
  inFlightToken = (async () => {
    try {
      const res = await fetch("/api/matrix/token");
      if (!res.ok) {
        if (res.status === 401) {
          const body = await res.json().catch(() => null);
          if (body?.reason === "revoked") await handleRevokedSession();
        }
        return null;
      }
      return await res.json();
    } catch {
      return null;
    } finally {
      setTimeout(() => { inFlightToken = null; }, 0);
    }
  })();
  return inFlightToken;
}

// The signed-in user's matrix_id, straight from the site session — no Matrix
// client involved. Cached for the life of the page: unlike the access token
// this never needs refreshing, and a session that ends is handled by a full
// sign-out, not by this value changing under us. Deduped so the identity tier
// and startClient share one request instead of issuing two on every load.
let inFlightIdentity: Promise<string | null> | null = null;

async function fetchMatrixId(): Promise<string | null> {
  if (inFlightIdentity) return inFlightIdentity;
  inFlightIdentity = (async () => {
    try {
      const s = await fetch("/api/auth/session").then((r) => r.json());
      return (s?.user?.id as string | undefined) ?? null;
    } catch {
      // Only a SUCCESSFUL answer is cached. A network blip that resolved to a
      // cached `null` would render every identity-gated surface as signed-out
      // for the rest of the page's life, with no way back short of a reload.
      inFlightIdentity = null;
      return null;
    }
  })();
  return inFlightIdentity;
}

// Matrix → site profile reconcile, fired once per load as soon as the viewer is
// known to be signed in. Pulls any externally-made profile changes
// (Element/mobile) back into site.users. On a change it emits a window event so
// the user's own profile surfaces (UserMenu) can refresh in place.
async function reconcileProfile(): Promise<void> {
  try {
    const res = await fetch("/api/me/profile/reconcile", { method: "POST" });
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    if (data?.reconciled) {
      window.dispatchEvent(new CustomEvent("bb:profile-synced", { detail: data }));
    }
  } catch {
    /* best-effort — next client-ready retries */
  }
}

// Thrown by setupCrypto when the crypto store can't serve this (user, device).
// The store and device ID have been discarded together; the caller ends the
// session so the next sign-in mints a fresh device.
class CryptoStoreResetError extends Error {
  constructor() { super("CRYPTO_STORE_RESET"); }
}

async function setupCrypto(mxClient: MatrixClient, userId: string, deviceId: string): Promise<void> {
  const prefix = cryptoStorePrefix(userId, deviceId);

  // Janitor: remove this user's stores for OTHER device IDs — they belong to
  // sessions that no longer exist and can only cause confusion.
  const userPrefix = `mx-rust-${sanitize(userId)}-`;
  await deleteMatrixDatabases(n => n.startsWith(userPrefix) && !n.startsWith(prefix)).catch(() => {});

  try {
    await mxClient.initRustCrypto({ cryptoDatabasePrefix: prefix });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("doesn't match the account in the constructor")) {
      // The store is corrupt or belongs to another identity. INVARIANT: device
      // ID and crypto store die together — discard both and end the session
      // (server-side device is best-effort revoked) so the next sign-in mints
      // a fresh device. Never reuse the ID with a fresh OlmMachine: that
      // resets the OTK counter against keys the server already has.
      console.warn("[Matrix] crypto store mismatch — discarding device identity; sign-in required");
      await deleteMatrixDatabases(n => n.startsWith(userPrefix)).catch(() => {});
      clearDeviceId();
      await fetch("/api/matrix/logout", { method: "POST" }).catch(() => {});
      throw new CryptoStoreResetError();
    }
    throw e;
  }
  // Before the first sync: each /sync's engine work cut to what changed (matrixSyncCrypto.ts).
  if (!installSyncCryptoDoor(mxClient.getCrypto())) console.warn("[Matrix] sync crypto door not installed — the SDK's crypto backend changed shape");
  const crypto = mxClient.getCrypto();
  if (!crypto) return;

  // The store opened, but is it the store the SERVER knows this device by?
  // Fresh OlmMachines running under one live device id each re-upload new
  // device keys over the last on their first sync. Synapse keeps the
  // cross-signing signature it already holds for a device and skips any
  // replacement, so once the keys under a signed device change, no
  // recovery-key restore can ever verify it again — silently. This is the one
  // moment the two copies can be compared before the first sync overwrites the
  // server's (the SDK's first /keys/upload is sync-driven;
  // matrixDeviceKeys.test.ts pins that). A mismatch is the same broken
  // invariant as a corrupt store and takes the same exit. A failed fetch is an
  // unanswered question, not a mismatch — log it and boot.
  let server: ServerDeviceKeys | null | undefined;
  await fetchServerDeviceKeys(mxClient, userId, deviceId)
    .then((s) => { server = s; })
    .catch((e: unknown) => { console.warn("[Matrix] own-device key check skipped:", e); });
  if (server !== undefined) {
    const local = await crypto.getOwnDeviceKeys();
    if (ownDeviceKeyState(local, server, deviceId) === "mismatch") {
      console.warn("[Matrix] this device's keys differ from the server's copy — the crypto store was replaced under a live device id; discarding the device, sign-in required", {
        local: local.ed25519, server: server?.keys?.[`ed25519:${deviceId}`],
      });
      await deleteMatrixDatabases(n => n.startsWith(userPrefix)).catch(() => {});
      clearDeviceId();
      await fetch("/api/matrix/logout", { method: "POST" }).catch(() => {});
      throw new CryptoStoreResetError();
    }
  }

  // Connect to an existing Megolm key backup if one is available on the server.
  await crypto.checkKeyBackupAndEnable().catch(() => {});
}

export function MatrixClientProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<MxStatus>("idle");
  const [client, setClient] = useState<MatrixClient | null>(null);
  const [pendingVerification, setPendingVerification] = useState<unknown | null>(null);
  const clearPendingVerification = useCallback(() => setPendingVerification(null), []);
  const [matrixId, setMatrixId] = useState<string | null>(null);
  const [identityKnown, setIdentityKnown] = useState(false);
  const clientRef = useRef<MatrixClient | null>(null);
  // The client BETWEEN `createClient()` and the moment it becomes the client.
  // In that window (crypto setup, the sync start) it already exists, already
  // owns timers and network work, and `clientRef` is still null — so `retry()`
  // and the provider's unmount had nothing to stop and left it running under
  // whatever replaced it. Held from createClient onward, cleared the instant
  // clientRef takes ownership: exactly one ref holds it, never both.
  const bootingRef = useRef<MatrixClient | null>(null);
  const tokenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedRef = useRef(false);
  const runRef = useRef(0);
  const reconciledRef = useRef(false);

  const scheduleRefresh = useCallback((expiresAt: number) => {
    function arm(at: number) {
      if (tokenTimerRef.current) clearTimeout(tokenTimerRef.current);
      const delay = Math.max(10_000, at - Date.now() - 30_000);
      tokenTimerRef.current = setTimeout(async () => {
        const fresh = await fetchFreshToken();
        if (fresh && clientRef.current) {
          clientRef.current.setAccessToken(fresh.accessToken);
          arm(fresh.expiresAt);
        }
      }, delay);
    }
    arm(expiresAt);
  }, []);

  const startClient = useCallback(async (): Promise<void> => {
    if (startedRef.current) return;
    startedRef.current = true;
    // The run's generation — bumped again by the next startClient() call
    // (retry's included) AND by the provider's unmount, so an abandoned run's
    // continuation after any await below can tell it is no longer the current
    // one and stop touching shared state (clientRef, status, the registry)
    // instead of racing a fresh run that started after it, or writing to a
    // provider that is gone.
    const run = ++runRef.current;
    const stale = () => run !== runRef.current;
    // ONE boot-level ceiling, armed HERE — before the first await — so it
    // covers the WHOLE sequence: a token endpoint that never answers, an SDK
    // chunk that never arrives or a crypto setup that hangs would otherwise
    // leave the pane on a silently active stage forever. It marks whichever
    // stage is still ACTIVE at 30s as failed, so the Try again control lands on
    // the step that is actually stuck.
    // Cleared on the first PREPARED/SYNCING (the `prepared` flip below).
    // Deliberately NOT cleared on the early `return` paths: a returned run has
    // no active stage — each of those paths advances its stage to "error"
    // first, and an error stage is not an active one — so the timer finds
    // nothing to mark and is a no-op. A run abandoned by a retry is covered by
    // the `stale()` guard instead.
    const bootTimer = setTimeout(() => {
      if (stale()) return;
      const active = readReadiness([MATRIX_READINESS_KEY]).find((s) => s.status === "active");
      if (!active) return;
      console.warn(`[Matrix] boot timer: "${active.id}" still running after 30s`);
      matrixReadiness.advance(active.id, "error", "Still connecting after 30 seconds");
    }, 30_000);
    setStatus("loading");
    matrixReadiness.reset();
    matrixReadiness.advance("token", "active");

    const tokenData = await fetchFreshToken();
    if (stale()) return;
    if (!tokenData) {
      console.warn("[Matrix] token endpoint returned no token — session likely expired");
      matrixReadiness.advance("token", "error", "Sign in to join the community");
      setStatus("notoken");
      startedRef.current = false;
      return;
    }

    // Same deduped session read the identity tier uses — not a second fetch.
    const userId = await fetchMatrixId();
    if (stale()) return;
    if (!userId) {
      matrixReadiness.advance("token", "error", "Sign in to join the community");
      setStatus("notoken");
      startedRef.current = false;
      return;
    }

    // The device ID comes from the session row — the same value embedded in the
    // OAuth device scope at sign-in. No fallback: a session without a device ID
    // cannot run crypto coherently.
    const deviceId = tokenData.deviceId;
    if (!deviceId) {
      console.warn("[Matrix] session has no device ID — sign-in required");
      matrixReadiness.advance("token", "error", "Sign in again to continue");
      setStatus("notoken");
      startedRef.current = false;
      return;
    }
    matrixReadiness.advance("token", "done");

    // The ~46%-of-homepage-JS chunk the lazy-load verdict kept (see the file
    // header). Guarded: an import failure used to throw out of startClient as
    // an unhandled rejection that no surface ever saw.
    matrixReadiness.advance("sdk", "active");
    let sdk: [typeof import("matrix-js-sdk"), typeof import("matrix-js-sdk/lib/crypto-api")];
    try {
      sdk = await Promise.all([
        import("matrix-js-sdk"),
        import("matrix-js-sdk/lib/crypto-api"),
      ]);
    } catch (e) {
      if (stale()) return;
      console.error("[Matrix] SDK failed to load", e);
      matrixReadiness.advance("sdk", "error", "The chat engine didn't load");
      setStatus("error");
      startedRef.current = false;
      return;
    }
    if (stale()) return;
    const [{ createClient, ClientEvent }, { CryptoEvent }] = sdk;
    matrixReadiness.advance("sdk", "done");

    const mxClient = createClient({
      baseUrl: tokenData.homeserver,
      accessToken: tokenData.accessToken,
      userId,
      deviceId,
      timelineSupport: true,
      fetchFn: refusedKeyUploadFetch(),
      cryptoCallbacks: {
        // Called whenever the SDK needs to decrypt something from 4S (secret storage).
        // Returns the pending recovery key when one has been set by setPendingSecretStorageKey.
        getSecretStorageKey: async ({ keys }) => {
          if (!_pendingSecretStorageKey) return null;
          const keyId = Object.keys(keys)[0];
          if (!keyId) return null;
          return [keyId, _pendingSecretStorageKey as Uint8Array<ArrayBuffer>];
        },
      },
    });
    // A live client exists from this line on, even though `clientRef` is still
    // null — see bootingRef's declaration. This is what makes a retry or an
    // unmount during `Preparing encryption` able to stop it.
    bootingRef.current = mxClient;

    matrixReadiness.advance("crypto", "active");
    let cryptoOk = true;
    await setupCrypto(mxClient, userId, deviceId).catch(e => {
      // The .catch callback settles BEFORE the `await` above resumes this
      // function, so the post-await `stale()` check further down runs too
      // LATE to guard these writes — a stale run's rejection would otherwise
      // clobber the fresh run's registry/status and reopen startedRef.
      if (stale()) return;
      if (e instanceof CryptoStoreResetError) {
        cryptoOk = false;
        matrixReadiness.advance("crypto", "error", "Encryption needs a fresh start — open Devices & Security");
        setStatus("notoken");
        startedRef.current = false;
      } else {
        console.warn("[Matrix] crypto init non-fatal:", e);
      }
    });
    if (stale()) return;
    if (!cryptoOk) return;
    matrixReadiness.advance("crypto", "done");

    clientRef.current = mxClient;
    bootingRef.current = null; // clientRef owns it now — one ref, never both
    setClient(mxClient);
    scheduleRefresh(tokenData.expiresAt);

    mxClient.on(CryptoEvent.VerificationRequestReceived, (request: unknown) => {
      if (stale()) return;
      // Filter out terminal requests replayed by sync catch-up.
      // Only Cancelled/Done are dead. (The previous filter dropped Ready/Started,
      // i.e. live requests, and let finished ones through — the "ghost SAS
      // request" bug.)
      const req = request as { phase?: number } | null;
      if (req?.phase !== PHASE_CANCELLED && req?.phase !== PHASE_DONE) {
        setPendingVerification(request);
      }
    });

    // The boot is over the moment the first PREPARED/SYNCING arrives — that,
    // and not the first Sync event of ANY state (which can be an ERROR), is
    // what disarms the boot timer armed at the top of this run.
    let prepared = false;

    mxClient.on(ClientEvent.Sync, (state: SyncState, _prev: SyncState | null, data?: SyncStateData) => {
      if (stale()) return;
      if (state === "PREPARED" || state === "SYNCING") {
        if (!prepared) {
          prepared = true;
          clearTimeout(bootTimer);
          // Once per client start: bridged bots onto the account's ignore list
          // (see ignoredBots.ts). Best-effort — a failure is a warning, not a
          // broken boot.
          syncIgnoredBots(mxClient, () => !stale()).catch((e) => console.warn("[Matrix] ignore-list sync failed", e));
        }
        matrixReadiness.advance("sync", "done");
        setStatus("ready");
      } else if (state === "ERROR") {
        const isAuthError = (data?.error as MatrixError | undefined)?.errcode === "M_UNKNOWN_TOKEN";
        console.warn("[Matrix] sync ERROR", isAuthError ? "(auth)" : "", data?.error);
        // Before the first PREPARED this is the boot failing, and the stage
        // says so; the SDK keeps retrying on its own, and a later SYNCING
        // marks the stage done again. After PREPARED it is a blip the SDK
        // rides out, and the readiness view is no longer on screen.
        if (!prepared) matrixReadiness.advance("sync", "error", "Couldn't reach the community");
        if (isAuthError) {
          // fetchFreshToken handles the revoked case (full sign-out) itself.
          fetchFreshToken().then((fresh) => {
            if (fresh && clientRef.current) {
              clientRef.current.setAccessToken(fresh.accessToken);
              scheduleRefresh(fresh.expiresAt);
              try { clientRef.current.retryImmediately(); } catch {}
            }
          });
        }
      }
    });

    matrixReadiness.advance("sync", "active");
    try {
      await mxClient.startClient({ initialSyncLimit: 30, lazyLoadMembers: true, pollTimeout: 15000 });
    } catch (e) {
      // The catch settles BEFORE the `await` above resumes this function —
      // exactly the setupCrypto shape above — so stale() must be checked
      // HERE, first, not after the try/catch.
      if (stale()) return;
      // Deliberately does NOT reset startedRef (unlike every earlier failure
      // branch): only an explicit retry() may recover a sync that may still
      // be alive under this thrown startClient() call — an implicit remount
      // restart here would risk a second client racing the first.
      console.error("[Matrix] startClient failed", e);
      matrixReadiness.advance("sync", "error", "Couldn't reach the community");
      setStatus("error");
      return;
    }
    // A stale run must not touch a client it no longer owns — checked here,
    // between the try/catch and setSyncPresence below, not folded into the try
    // itself: a retry() may already have stopped this client and started a new
    // one by the time startClient resolves successfully.
    if (stale()) return;
    // Self-set status: a /sync without set_presence defaults to
    // "online" server-side, which would flip an Idle/Invisible user back the
    // moment the community view opens. setSyncPresence is
    // `this.syncApi?.setPresence(...)` and syncApi exists only once
    // startClient has run — a call BEFORE startClient is a silent no-op.
    // startClient kicks off syncApi.sync()
    // without awaiting it, and sync() awaits the push-rules round-trip
    // before it builds the first /sync, so this continuation lands first.
    // matrixSyncPresence.test.ts pins both SDK facts.
    const stored = tokenData.presenceStatus;
    await mxClient.setSyncPresence(statusToMatrix(isSelfStatus(stored) ? stored : "online", "").presence as SetPresence);
    // Nothing follows: the sync stage is left ACTIVE on purpose, and the boot
    // timer armed at the top of this run is what bounds it.
  }, [scheduleRefresh]);

  // The control behind a failed stage. Stops whatever client the abandoned run
  // left running — BOTH the settled one and a client still mid-boot, which are
  // two different refs (see bootingRef): a retry from a stuck `Preparing
  // encryption` used to leave the half-booted client alive under the fresh one,
  // because clientRef was still null there. Then it drops them and runs the
  // whole sequence again; `startClient` resets the stages itself.
  // Stopping the CLIENT and making the abandoned RUN inert are two separate
  // jobs: the old run's closure keeps going (its awaits may still resolve, its
  // boot timer is still armed), and startClient's generation bump is what makes
  // it harmless — every `stale()` check downstream of an await sees the new
  // run's id and quietly stops touching clientRef/status/the registry.
  const retry = useCallback(() => {
    const old = clientRef.current;
    const booting = bootingRef.current;
    clientRef.current = null;
    bootingRef.current = null;
    setClient(null);
    try { old?.stopClient(); } catch { /* a client that never started has nothing to stop */ }
    try { booting?.stopClient(); } catch { /* mid-boot: same, and it may never have started */ }
    startedRef.current = false;
    setStatus("idle");
    void startClient();
  }, [startClient]);

  // Identity tier: who the viewer is, resolved from the site session alone.
  // Deliberately independent of the client lifecycle — every surface that only
  // needs an id or a signed-in boolean reads this, so none of them is a reason
  // to keep a crypto client running. See useMatrixIdentity.
  useEffect(() => {
    fetchMatrixId().then((id) => {
      setMatrixId(id);
      setIdentityKnown(true);
      // Pull externally-made profile changes (Element/mobile) back into
      // site.users. Not tied to the first-sync event: the route does its Matrix
      // fetch SERVER-side with the session's own token, so it never needs the
      // browser client — only a signed-in user. Server-side throttled, so
      // re-firing across reloads is cheap.
      if (id && !reconciledRef.current) {
        reconciledRef.current = true;
        reconcileProfile();
      }
    });
  }, []);

  // This does NOT start the client — see useStartMatrixClient. It is kept as a
  // mount-time request for one reason: `fetchFreshToken` is where an upstream
  // revocation is detected (401 `{reason:"revoked"}` → wipe crypto stores + sign
  // out), which is what makes "revoke the session in MAS ⇒ signed out of the
  // site" mechanical rather than eventual. Dropping it would defer that to
  // whenever the user next opened the community, which for most viewers is
  // never. One request per load is cheap; it also resolves `notoken` so
  // signed-out surfaces settle.
  useEffect(() => {
    fetchFreshToken()
      .then((d) => { if (!d?.accessToken) setStatus("notoken"); })
      .catch(() => setStatus("notoken"));
  }, []);

  // Teardown. Three things outlive a provider that has been unmounted unless
  // they are stopped here: the token-refresh timer, the settled client, and a
  // run still between createClient() and clientRef. The generation bump is the
  // fourth — it makes an IN-FLIGHT run stale, so its continuations cannot set
  // clientRef/setClient or leave a boot timer armed against a provider that is
  // gone (the same mechanism retry() leans on, for the same reason).
  // Reopening `startedRef` is not optional once the generation is bumped: a
  // teardown that invalidates the running boot but leaves the latch shut means
  // NOTHING can start again. React's StrictMode runs exactly that sequence on
  // every dev mount (effects → cleanup → effects), and the second pass's
  // `startClient()` would bounce off the latch while run 1 sat stale — a
  // community pane that never loads in `npm run dev`. Together they are one
  // move: invalidate the old run, reopen the door.
  useEffect(() => {
    return () => {
      if (tokenTimerRef.current) clearTimeout(tokenTimerRef.current);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- the rule's fix (copy `.current` into the effect) is the one thing that cannot work here: this is a generation COUNTER, and the whole point is to write the value the cleanup finds, not a value captured at mount. It is never a DOM node and is never read during render.
      runRef.current++;
      startedRef.current = false;
      clientRef.current?.stopClient();
      bootingRef.current?.stopClient();
    };
  }, []);

  // The picker (PresenceStatusPicker) announces a change; an open client must
  // follow it or its next /sync would undo the mirror the server just wrote.
  useEffect(() => {
    const onStatus = (e: Event) => {
      const status = (e as CustomEvent<{ status?: unknown }>).detail?.status;
      const c = clientRef.current;
      if (!c || !isSelfStatus(status)) return;
      void c.setSyncPresence(statusToMatrix(status, "").presence as SetPresence).catch(() => {});
    };
    window.addEventListener("bb:presence-status", onStatus);
    return () => window.removeEventListener("bb:presence-status", onStatus);
  }, []);

  // The context-free handle: the lazy-loaded terminal reads the client through
  // app/lib/matrixHandle.ts instead of importing this module.
  useEffect(() => { setMatrixHandle({ client, status, startClient }); }, [client, status, startClient]);

  return (
    <Ctx.Provider value={{
      client, status, startClient, retry, pendingVerification, clearPendingVerification,
      matrixId, identityKnown,
    }}>
      {children}
    </Ctx.Provider>
  );
}
