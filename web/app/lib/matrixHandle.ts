// The page's Matrix client, reachable without the React context: the
// terminal is lazy-loaded and must not import MatrixClientContext (next-auth, the SDK's
// types' neighbours) into its chunk — and the context module does not load under node's test
// runner at all. MatrixClientProvider writes here whenever its client or status changes; a
// reader takes the current handle, or listens for the next change.
import type { MatrixClient } from "matrix-js-sdk";

export type MxStatus = "idle" | "loading" | "ready" | "notoken" | "error";

/** The client's readiness stages' key (registered by MatrixClientContext). */
export const MATRIX_READINESS_KEY = "matrix";
export type MxHandle = { client: MatrixClient | null; status: MxStatus; startClient: () => Promise<void> };

let handle: MxHandle = { client: null, status: "idle", startClient: async () => {} };
const listeners = new Set<(h: MxHandle) => void>();

/** The provider's write (its effect, on every client/status change). */
export function setMatrixHandle(h: MxHandle): void {
  handle = h;
  for (const fn of listeners) fn(h);
}

export const matrixHandle = (): MxHandle => handle;

/** Hear the handle change; the unsubscribe comes back. */
// @parked plugin API: a console beside the chat (the owner plugin's terminal, app/(owner)/_terminal) reads or drives the chat through it
export function onMatrixHandle(fn: (h: MxHandle) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
