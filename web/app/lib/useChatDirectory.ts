// The chat directory, shared by the sidebar rows and the OBS overlay rows —
// rebuilt per flush, but IDENTITY-STABLE for the rows.
//
// `messages` gets a new array identity on EVERY WS flush — appends, votes,
// deletes, poll updates — but the PEOPLE visible in the buffer change far more
// rarely. Rebuilding the directory is cheap (one pass over the buffer); what is
// not cheap is a fresh directory OBJECT per flush: `directory` is a prop of the
// memo()d ChatMessage, so a new identity fails the shallow compare and every
// mounted row re-renders and re-tokenizes (renderText) per incoming message —
// on phones and on the OBS overlay alike.
//
// So: return the PREVIOUS object when nothing a row can READ from it changed.
// Rows consume `byKey` only (renderText resolves `directory.byKey.get(…)` for
// mention colour/identity), so equivalence is "every key resolves to the same
// name/colour/identity".
//
// `mentionCandidates` deliberately stays FRESH every build: its recency
// ranking flips on nearly every message in a two-speaker chat, and freezing it
// would silently degrade the ordering. It feeds ONE composer, not N rows —
// identity churn is cheap there.

import { useMemo, useRef } from "react";
import { buildChatDirectory, type ChatDirectory, type ChatPerson } from "./chatDirectory.ts";
import type { ChatMsg } from "./chatMsg.ts";

type Opts = { userId?: string | null; ownIds?: ReadonlySet<string> | null; ownColor?: string | null };

/** Would any mounted row render differently under `next` than under `prev`? */
function sameForRows(prev: ChatDirectory, next: ChatDirectory): boolean {
  if (prev.byKey.size !== next.byKey.size) return false;
  for (const [key, n] of next.byKey) {
    const p = prev.byKey.get(key);
    if (!p) return false;
    if (p.name !== n.name || p.color !== n.color ||
        p.matrixId !== n.matrixId || p.publicId !== n.publicId) return false;
  }
  return true;
}

export function useChatDirectory(
  messages: readonly ChatMsg[],
  opts: Opts = {},
): { directory: ChatDirectory; mentionCandidates: ChatPerson[] } {
  const { userId, ownIds, ownColor } = opts;
  const prevRef = useRef<ChatDirectory | null>(null);
  /* eslint-disable react-hooks/refs -- the ref IS this memo's cross-render cache; it never drives rendering on its own, because every read happens inside the memo, which re-runs exactly when its inputs change */
  const value = useMemo(() => {
    const next = buildChatDirectory(messages, { userId, ownIds, ownColor });
    const directory = prevRef.current && sameForRows(prevRef.current, next) ? prevRef.current : next;
    prevRef.current = directory;
    return { directory, mentionCandidates: next.list };
  }, [messages, userId, ownIds, ownColor]);
  /* eslint-enable react-hooks/refs */
  return value;
}
