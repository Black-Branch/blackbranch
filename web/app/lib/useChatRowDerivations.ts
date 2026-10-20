import { useCallback, useMemo, useRef } from "react";
import { normalizeUsername, type ChatMsg } from "./chatMsg";
import { localpart } from "./matrixDisplay";
import { mentionsAnyOf } from "./chatDirectory";
import { wordsMatcher } from "./behaviorLists";
import { useChatDirectory } from "./useChatDirectory";

type Params = {
  messages: ChatMsg[];
  rendered: ChatMsg[];
  userId?: string | null;
  /** The viewer's own per-platform public ids (ownIdentity.ts): their lines on every platform. */
  ownIds?: ReadonlySet<string> | null;
  ownColor: string | null;
  /** ⑤ Behavior › Words: a message containing one is highlighted like a mention. */
  words?: readonly string[];
};

// Per-row derivations that depend on the message list (own-color override,
// continuation grouping, reply-to-me highlight) plus @mention candidates —
// consolidated here since they all read the same message stream and share
// the "own identity" tracking below.
export function useChatRowDerivations({ messages, rendered, userId, ownIds, ownColor, words }: Params) {
  // Every username the viewer goes by (Matrix localpart plus names on messages
  // matching their identities) — for reply-to-me highlight. Maintained
  // INCREMENTALLY: names are additive (an old alias staying in the set is
  // correct — it's still the viewer's name), so instead of rescanning the whole
  // ≤1000-message buffer on every WS flush we keep a persistent set and only
  // scan messages newer than a watermark (with a small overlap window for
  // same-timestamp arrivals; the set dedupes). Identity change rebuilds.
  const ownNamesRef = useRef<{ ident: string; sinceTs: number; names: Set<string> }>({
    ident: "", sinceTs: 0, names: new Set(),
  });
  /* eslint-disable react-hooks/refs -- the ref IS this memo's cross-render cache; it never drives rendering on its own, because every read happens inside the memo, which re-runs exactly when its inputs change */
  const ownNames = useMemo(() => {
    const st = ownNamesRef.current;
    const ident = `${userId ?? ""}|${ownIds ? [...ownIds].sort().join(",") : ""}`;
    if (st.ident !== ident) {
      st.ident = ident;
      st.sinceTs = 0;
      st.names = new Set(userId ? [localpart(userId).toLowerCase()] : []);
    }
    const cutoff = st.sinceTs - 5000;
    let maxTs = st.sinceTs;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m) continue;
      const ts = Number(m.ts) || 0;
      if (ts < cutoff) break; // sorted by ts — everything earlier is already scanned
      if (ts > maxTs) maxTs = ts;
      if ((userId && m.matrixId === userId) || (!!m.publicId && !!ownIds && ownIds.has(m.publicId))) {
        st.names.add(normalizeUsername(m.username).toLowerCase());
      }
    }
    st.sinceTs = maxTs;
    // New Set identity only matters to the `rows` memo below; the contents are
    // stable-growing, so passing the same Set instance is fine.
    return st.names;
  }, [messages, userId, ownIds]);
  // (disable stays open through `rows`: it consumes the ref-cached Set above,
  // and its own memo deps re-run it exactly when the cache can have changed)

  // Highlighted when a message CONCERNS the viewer and is not theirs: a reply to
  // them, or an @mention of any name they go by. One function, used by the rows
  // below AND by the mention sound (which watches every message, including the
  // ones queued while the viewer is scrolled up — useMentionSound).
  //
  // This is why "visible only to the person tagged" needs no plumbing —
  // it is derived in the reader's own client from the reader's own identity,
  // so the highlight cannot leak to anyone else and the sender is not told
  // whose client lit up. Nothing about it rides the message.
  const wordHit = useMemo(() => wordsMatcher(words ?? []), [words]);
  const mentionsMe = useCallback((msg: ChatMsg) => {
    if ((userId && msg.matrixId === userId) || (!!msg.publicId && !!ownIds && ownIds.has(msg.publicId))) return false;
    return (!!msg.reply_to_username && ownNames.has(normalizeUsername(msg.reply_to_username).toLowerCase()))
      || mentionsAnyOf(msg.message, ownNames)
      || wordHit(msg.message);
  }, [userId, ownIds, ownNames, wordHit]);

  const rows = useMemo(() =>
    rendered.map((msg, i) => {
      const isOwn = !!(userId && msg.matrixId === userId);
      const isOwnStream = !!(!!msg.publicId && !!ownIds && ownIds.has(msg.publicId));
      const resolved = isOwn && ownColor ? { ...msg, usernameColor: ownColor } : msg;
      const compact = i > 0
        && rendered[i - 1]?.username === msg.username
        && rendered[i - 1]?.platform === msg.platform
        && !msg.reply_to_username;
      const highlight = mentionsMe(msg);
      return { msg: resolved, isOwn, isOwnStream, compact, highlight };
    }),
  [rendered, userId, ownIds, ownColor, mentionsMe]);
  /* eslint-enable react-hooks/refs */

  // Everyone visible in the buffer, by every name they answer to — the source
  // for @-autocomplete AND for colouring a rendered mention.
  //
  // Not a capped list of bare `localpart(m.username)` strings: that carries no
  // identity, so `@bob` could not find a user whose DISPLAY name is "Bobby
  // McGee", and a cap silently stops offering people during a busy stream —
  // the exact moment you most want to address someone by name.
  const { directory, mentionCandidates } = useChatDirectory(messages, { userId, ownIds, ownColor });

  return { rows, mentionCandidates, directory, mentionsMe };
}
