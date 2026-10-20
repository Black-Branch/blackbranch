// Kick / ban / unban fanned out across every channel in a server.
//
// SEQUENTIAL, not Promise.all. Many membership writes fired at once CAN hit
// Synapse's rate limiter part way through, and the limiter's rejection is
// indistinguishable from a real permission failure in the card's summary — so
// the user would be told a ban half-failed when it was only throttled.

import type { RoomOutcome } from "./matrixModeration.ts";

export type ModAction = "kick" | "ban" | "unban";

/** The slice of MatrixClient this needs; an SDK client satisfies it. */
export type ModClient = {
  kick(roomId: string, userId: string): Promise<unknown>;
  ban(roomId: string, userId: string): Promise<unknown>;
  unban(roomId: string, userId: string): Promise<unknown>;
};

export type ScopeRoom = { roomId: string; name: string };

type MatrixLikeError = { errcode?: string; data?: { error?: string; retry_after_ms?: number }; message?: string };

function asMatrixError(e: unknown): MatrixLikeError {
  return (e ?? {}) as MatrixLikeError;
}

/** Synapse's answer when the target was never in the room (kick/ban) or was
 *  never banned (unban). Either way the end state we wanted already holds, so
 *  this is a no-op and not a failure. */
function isAlreadyDone(e: MatrixLikeError): boolean {
  const text = `${e.data?.error ?? ""} ${e.message ?? ""}`.toLowerCase();
  if (e.errcode === "M_FORBIDDEN" && text.includes("not in the room")) return true;
  if (e.errcode === "M_BAD_STATE" && text.includes("not banned")) return true;
  return false;
}

function retryAfterMs(e: MatrixLikeError): number | null {
  if (e.errcode !== "M_LIMIT_EXCEEDED") return null;
  const ms = e.data?.retry_after_ms;
  return typeof ms === "number" && ms >= 0 ? ms : 1000;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type AttemptResult = { status: "ok" | "noop" | "failed"; error?: string };

/**
 * Run one write, in isolation from whatever loop calls it: a rate-limited
 * write is retried ONCE after the delay the server names, and any other
 * failure — or a second rate limit — is reported rather than thrown, so a
 * caller looping over many writes never has one exception end the loop.
 *
 * `classify` names the errors that mean "already in the state we wanted" —
 * moderateEverywhere uses it for "target not in the room" / "not banned";
 * a caller with no such case (useModPowerSync) can leave it unset.
 */
export async function attemptWithRetry(
  op: () => Promise<void>,
  classify: (err: MatrixLikeError) => "noop" | "fail" = () => "fail",
  sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<AttemptResult> {
  let last: MatrixLikeError = {};
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await op();
      return { status: "ok" };
    } catch (e) {
      const err = asMatrixError(e);
      last = err;
      if (classify(err) === "noop") return { status: "noop" };
      const wait = retryAfterMs(err);
      if (wait !== null && attempt === 0) {
        await sleep(wait);
        continue;
      }
      break;
    }
  }
  return { status: "failed", error: last.errcode ?? last.message ?? "failed" };
}

/**
 * Apply `action` to `userId` in every room, in order, and report each one —
 * one room's failure never stops the rest (attemptWithRetry never throws).
 */
export async function moderateEverywhere(
  client: ModClient,
  action: ModAction,
  rooms: ScopeRoom[],
  userId: string,
  sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<RoomOutcome[]> {
  const out: RoomOutcome[] = [];
  for (const room of rooms) {
    const result = await attemptWithRetry(
      () => client[action](room.roomId, userId).then(() => undefined),
      (err) => (isAlreadyDone(err) ? "noop" : "fail"),
      sleep
    );
    out.push({
      roomId: room.roomId,
      name: room.name,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
    });
  }
  return out;
}
