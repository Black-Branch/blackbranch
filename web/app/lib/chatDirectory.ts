// Who is in this chat, by every name they answer to.
//
// One index serves three features that would otherwise each grow their own
// half-answer:
//   • @-autocomplete — by display name AND by Matrix localpart (showing the
//     username)
//   • the private "you were tagged" row highlight
//   • rendering an @mention in the mentioned person's own name colour
//
// Built from the loaded message buffer, so it knows everyone who has SPOKEN,
// not everyone who exists. That is the right set for a chat mention and it costs
// no request; someone who has been silent all stream is not completable. A
// server-side search is the upgrade path if that ever bites — the shape here
// (name → identity) is what such a route would fill.
//
// Pure and DOM-free so it runs under `node --test`.

import { normalizeUsername, type ChatMsg } from "./chatMsg.ts";
import { localpart } from "./matrixDisplay.ts";
import { readableColor, DEFAULT_NAME_COLOR } from "./colors.ts";

export type ChatPerson = {
  /** Display name, and exactly what gets written into the box after `@`. */
  name: string;
  /** Lowercased strings that should COMPLETE to this person: their display
   *  name and their Matrix localpart, which are frequently different. */
  keys: string[];
  /** Their own name colour, already contrast-clamped. */
  color: string;
  matrixId: string | null;
  /** Their per-platform public id (chatMsg.ts) — never a canonical id. */
  publicId: string | null;
  /** Where they spoke from (twitch, youtube, native…) — the terminal tags a
   *  chatter with no Matrix id by it. */
  platform?: string | null;
  /** Messages they sent in the buffer, and when they last spoke (ms) — the
   *  terminal's ps and top. */
  said?: number;
  lastAt?: number;
};

export type ChatDirectory = {
  /** Recency-ordered — most recent speaker first, which is the ranking an
   *  autocomplete wants without a separate sort. */
  list: ChatPerson[];
  /** Lowercased key → person. Both a display name and a localpart land here. */
  byKey: Map<string, ChatPerson>;
  /** Every message's time (ms), oldest first — the terminal's load average. */
  times?: number[];
};

/** A mention token: `@name`, plus whatever punctuation trailed it. */
const MENTION_RE = /^@(\w+)(\W*)$/;
/** Every mention in a body of text — for the tagged-me scan. */
const MENTION_SCAN_RE = /@(\w+)/g;

/** Split `@bob,` into the name and the punctuation that must render outside the
 *  coloured span. Returns null for anything that is not a mention token. */
export function matchMention(word: string): { name: string; trail: string } | null {
  const m = MENTION_RE.exec(word);
  return m ? { name: m[1]!, trail: m[2] ?? "" } : null;
}

/**
 * Does `text` tag any of `names`?
 *
 * Deliberately NOT a substring search. "@bobby" must not tag `bob`, and a bare
 * "bob" in a sentence must not tag anyone — the highlight exists to mean "someone
 * addressed you", and a highlight that fires on your name appearing in ordinary
 * conversation is noise that trains you to ignore it.
 */
export function mentionsAnyOf(text: string | null | undefined, names: ReadonlySet<string>): boolean {
  if (!text || names.size === 0) return false;
  MENTION_SCAN_RE.lastIndex = 0;   // the /g regex is module-level; state must not leak between calls
  let m: RegExpExecArray | null;
  while ((m = MENTION_SCAN_RE.exec(text)) !== null) {
    if (names.has(m[1]!.toLowerCase())) return true;
  }
  return false;
}

/**
 * Index the people visible in `messages`, newest first.
 *
 * `ownColor` overrides the colour for the viewer's own identity, matching the
 * row derivation — a viewer who has just changed their colour sees it applied
 * everywhere at once rather than only on messages sent since.
 */
export function buildChatDirectory(
  messages: readonly ChatMsg[],
  opts: { userId?: string | null; ownIds?: ReadonlySet<string> | null; ownColor?: string | null } = {},
): ChatDirectory {
  const { userId, ownIds, ownColor } = opts;
  const list: ChatPerson[] = [];
  const byKey = new Map<string, ChatPerson>();
  // Identity, not name: two display names can belong to one person (a rename
  // mid-buffer), and one display name can belong to two people on different
  // platforms. Falling back to the lowercased name keeps platform chatters with
  // no site identity from collapsing into a single entry.
  const seen = new Map<string, ChatPerson>();
  const times: number[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const name = normalizeUsername(m.username || "");
    if (!name) continue;
    const at = typeof m.ts === "number" ? m.ts : Date.parse(m.ts);
    if (Number.isFinite(at)) times.push(at);

    const isSelf =
      (!!userId && m.matrixId === userId) || (!!m.publicId && !!ownIds && ownIds.has(m.publicId));
    const ident = m.matrixId || m.publicId || `name:${name.toLowerCase()}`;
    const known = seen.get(ident);
    if (known) { known.said = (known.said ?? 0) + 1; continue; }

    // Both keys, which is the whole point of this index. A site user shows as
    // "Bobby McGee" while their Matrix id is @bob:example.org — typing `@bob`
    // must complete to them.
    const keys = new Set<string>([name.toLowerCase()]);
    if (m.matrixId) keys.add(localpart(m.matrixId).toLowerCase());

    const person: ChatPerson = {
      name,
      keys: [...keys],
      color: readableColor((isSelf ? ownColor : null) || m.usernameColor || DEFAULT_NAME_COLOR),
      matrixId: m.matrixId ?? null,
      publicId: m.publicId ?? null,
      platform: m.platform || null,
      said: 1,
      lastAt: Number.isFinite(at) ? at : undefined,
    };
    seen.set(ident, person);
    list.push(person);
    // First writer wins: the loop runs newest-first, so a key that two people
    // answer to resolves to whoever spoke most recently — the same person the
    // autocomplete would have offered first.
    for (const k of person.keys) if (!byKey.has(k)) byKey.set(k, person);
  }

  return { list, byKey, times: times.reverse() };
}
