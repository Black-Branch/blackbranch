import type { ChatMsg } from "./chatMsg.ts";
import { msgTs } from "./historyCursor.ts";

// The chat buffer's first state, and the stripe-parity ordinal both it and the
// live path assign, so the chat opens on a page of history instead of empty.
// Pure and dependency-light so node --test pins it directly —
// the hook (useChatMessages) only consumes these.

/** Dedupe identity shared by the buffer and the scroll engine's freeze boundary. */
export const chatKey = (m: Pick<ChatMsg, "platform" | "id">) => `${m.platform}:${m.id}`;

/**
 * A frame/row is keyable — can be chatKey'd, deduped and rendered — only with
 * both a string platform and a non-null id. A malformed frame missing either
 * must never enter the buffer (it'd poison chatKey/dedupe/render), so every
 * entry point guards on this. Structurally typed + null-safe so it covers
 * ChatMsg frames and purge id items alike.
 */
export const isKeyable = (m: { platform?: unknown; id?: unknown } | null | undefined): boolean =>
  typeof m?.platform === "string" && m.id != null;

// Alternating-row stripe (the `chatAltRows` setting): parity comes from a
// STABLE per-message ordinal, not list position — position parity re-flips
// every row each time the capped buffer trims from the front (constant
// flicker while streaming). DankChat's CheckeredMessageTracker pattern:
// first sight of a message id assigns the next ordinal; the map prunes by
// half when large (a pruned id re-entering could flip its stripe, but ids
// that old have long scrolled out of the buffer).
export type AltState = { next: number; byKey: Map<string, number> };

export const newAltState = (): AltState => ({ next: 0, byKey: new Map() });

export function assignAlt(st: AltState, m: ChatMsg): ChatMsg {
  const k = chatKey(m);
  let o = st.byKey.get(k);
  if (o === undefined) {
    o = st.next++;
    st.byKey.set(k, o);
    if (st.byKey.size > 4000) st.byKey = new Map([...st.byKey.entries()].slice(-2000));
  }
  const alt = o % 2 === 1;
  return m.alt === alt ? m : { ...m, alt };
}

/**
 * The buffer's initial rows from the server-rendered page of history: keyable
 * rows only, deleted rows dropped (the page shows what EVERY viewer sees — a
 * mod's struck-out copies arrive through the same frames they always did),
 * oldest first, the newest `cap` kept, stripe parity assigned in that order so
 * the first live row continues the pattern instead of restarting it.
 */
export function seedMessages(initial: ChatMsg[] | undefined, st: AltState, cap: number): ChatMsg[] {
  if (!initial || initial.length === 0) return [];
  const rows = initial
    .filter((m) => isKeyable(m) && !m.deleted)
    .sort((a, b) => msgTs(a) - msgTs(b));
  const kept = rows.length > cap ? rows.slice(-cap) : rows;
  return kept.map((m) => assignAlt(st, m));
}
