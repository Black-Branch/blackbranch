// Pure, React-free trigger detection + value builders for the emote/mention
// autocomplete. Split out of emoteTriggers.ts so it has NO React import and can
// be unit-tested directly (see emoteTriggerLogic.test.ts, run with `node --test`).
//
// Caret-aware: detection operates on the word UNDER THE CARET (not just the last
// word of the whole value), so completion works mid-message. The builders splice
// the completion into that word's span and preserve the trailing text + report
// the new caret position so the following word is never clobbered.

export type TriggerMode = "colon" | "plain" | "mention";

export type SavedState = {
  prefix: string;     // value text before the replaced span
  suffix: string;     // value text after the replaced span (preserved on commit)
  query: string;      // the head-side query the user typed (before the caret)
  tail: string;       // word chars AFTER the caret (consumed on commit, restored on cancel)
  zeroWidth: boolean;
  mode: TriggerMode;
};

export type Triggers = {
  colonMatch: RegExpMatchArray | null;
  plainMatch: RegExpMatchArray | null;
  mentionMatch: RegExpMatchArray | null;
  isZWFilter: boolean;
};

// Detect a trigger ending at the caret. `caret` is the textarea selectionStart;
// detection only looks at value[0..caret] so the trigger is the word the caret
// sits in/at the end of. Order: colon wins over plain word, both over @-mention.
export function detectTriggers(
  value: string,
  caret: number,
  suppress: boolean,
  /** Presence only — an `@` is a trigger when the caller HAS a candidate list.
   *  Typed as an opaque array so the directory's shape can change without
   *  touching trigger detection, which never reads an element. */
  mentions?: readonly unknown[],
): Triggers {
  const head = suppress ? "" : value.slice(0, Math.max(0, Math.min(caret, value.length)));
  const colonMatch = head.match(/:([~]?)([a-zA-Z0-9_]*)$/);
  const plainMatch = !colonMatch ? head.match(/(^|\s)([a-zA-Z0-9_]{2,})$/) : null;
  const mentionMatch = mentions && !colonMatch && !plainMatch ? head.match(/@(\w*)$/) : null;
  const isZWFilter = colonMatch ? colonMatch[1] === "~" : false;
  return { colonMatch, plainMatch, mentionMatch, isZWFilter };
}

// Build the SavedState describing the span to replace: from the trigger start up
// to the end of the word the caret is in (head query + any chars after the caret
// that are still part of the same word).
export function getCurrentTrigger(value: string, caret: number, t: Triggers): SavedState | null {
  const c = Math.max(0, Math.min(caret, value.length));
  const tail = (value.slice(c).match(/^[a-zA-Z0-9_]*/) ?? [""])[0];
  const suffix = value.slice(c + tail.length);
  if (t.colonMatch) {
    const start = c - (t.colonMatch[0]?.length ?? 0);
    return { prefix: value.slice(0, start), suffix, query: t.colonMatch[2] ?? "", tail, zeroWidth: t.isZWFilter, mode: "colon" };
  }
  if (t.plainMatch) {
    const start = c - (t.plainMatch[2]?.length ?? 0);
    return { prefix: value.slice(0, start), suffix, query: t.plainMatch[2] ?? "", tail, zeroWidth: false, mode: "plain" };
  }
  if (t.mentionMatch) {
    const start = c - (t.mentionMatch[0]?.length ?? 0);
    return { prefix: value.slice(0, start), suffix, query: t.mentionMatch[1] ?? "", tail, zeroWidth: false, mode: "mention" };
  }
  return null;
}

// Commit a completion: replace the word span with the chosen name, preserving the
// trailing text. Adds a single separating space unless the suffix already starts
// with whitespace; for end-of-input a trailing space is always added so the user
// keeps typing. Returns the new value and where the caret should land.
export function buildValue(state: SavedState, name: string): { value: string; caret: number } {
  const token = state.mode === "mention" ? "@" + name : name;
  const needsSpace = state.suffix === "" || !/^\s/.test(state.suffix);
  const insert = token + (needsSpace ? " " : "");
  const value = state.prefix + insert + state.suffix;
  return { value, caret: (state.prefix + insert).length };
}

// Reconstruct the exact text the user had typed (used to cancel a frozen
// selection), restoring the caret to where it was (before the tail).
export function restoreQuery(state: SavedState): { value: string; caret: number } {
  const typed =
    state.mode === "mention" ? "@" + state.query
    : state.mode === "colon" ? ":" + (state.zeroWidth ? "~" : "") + state.query
    : state.query;
  const value = state.prefix + typed + state.tail + state.suffix;
  return { value, caret: (state.prefix + typed).length };
}

// ── completion scoring ────────────────────────────────────────────────────────
// Port of the ranking both gold-standard clients use (Chatterino2
// SmartEmoteStrategy `costOfEmote` / DankChat `SuggestionProvider.scoreEmote`):
// substring match, case-insensitive; LOWER score ranks first.
//   • exact-case match of the typed region pins hard (-10), otherwise each
//     casing difference costs 1;
//   • every character the emote is longer than the query costs 100 — shorter/
//     closer emotes beat longer ones containing the query;
//   • the caller subtracts a recency boost (-50) for recently used emotes.
// Returns null when the emote doesn't contain the query at all.
export function scoreEmoteMatch(name: string, query: string): number | null {
  if (!query) return 0;
  const idx = name.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return null;
  const region = name.slice(idx, idx + query.length);
  let caseDiffs = 0;
  for (let i = 0; i < query.length; i++) if (region[i] !== query[i]) caseDiffs++;
  const caseCost = caseDiffs === 0 ? -10 : caseDiffs;
  return caseCost + (name.length - query.length) * 100;
}
