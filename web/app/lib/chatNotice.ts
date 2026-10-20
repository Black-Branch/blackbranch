// One-line notices for chat actions that have no surface of their own.
//
// A mod's delete, a pin, an unpin: each is a fire-and-forget POST from a row
// menu, and the row changing is the only other feedback — when the server
// refuses, nothing changes and nothing would say so. The composer already owns a
// short-lived notice line (ChatInput's `notice`), so a failed action speaks
// through it — this module is just the wire between the two, because the
// handlers live in the panel and the line lives in the composer.

type Listener = (text: string) => void;
const listeners = new Set<Listener>();

/** Subscribe; returns the unsubscribe (shaped for a useEffect cleanup). */
export function onChatNotice(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Say one line to whoever is listening. Called by noticeOnFailure below and
 *  by useReplyJump (a reply whose target is no longer loaded). */
export function emitChatNotice(text: string): void {
  for (const fn of listeners) fn(text);
}

/**
 * Await a request and say `text` if it failed. `postJson` RESOLVES on a 4xx or
 * 5xx — only a network error rejects — so "failed" here is a rejection OR a
 * non-2xx answer; a bare `.catch` sees only the first.
 */
export async function noticeOnFailure(req: Promise<Response>, text: string): Promise<void> {
  const res = await req.catch(() => null);
  if (!res?.ok) emitChatNotice(text);
}
