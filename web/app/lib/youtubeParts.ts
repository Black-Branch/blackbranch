// YouTube's live chat takes at most 200 characters a message, while a mod or the streamer may
// type 500 (chatLimits.ts). Their YouTube copy goes as parts of at most 200, split at a word
// boundary, in order, with no marker. Measured in UTF-16 units, which is never fewer than the
// characters YouTube counts.

const YOUTUBE_CHAT_CHARS = 200;

type PartResult = { ok: true; platformMsgId?: string } | ({ ok: false } & Record<string, unknown>);

/** The parts a line goes to YouTube as. A line within the limit is one part, unchanged.
 *  @test-only sendInParts and youtubeEchoParts in this file call it; the tests pin the split. */
export function youtubeParts(text: string, max = YOUTUBE_CHAT_CHARS): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let cur = "";
  for (const word of text.trim().split(/\s+/)) {
    for (const piece of cutWord(word, max)) {
      if (!cur) cur = piece;
      else if (cur.length + 1 + piece.length <= max) cur += ` ${piece}`;
      else { parts.push(cur); cur = piece; }
    }
  }
  if (cur) parts.push(cur);
  return parts.length ? parts : [text];
}

// A word longer than the limit is cut by code point, so an emoji is never split in two.
function cutWord(word: string, max: number): string[] {
  if (word.length <= max) return [word];
  const out: string[] = [];
  let cur = "";
  for (const ch of word) {
    if (cur.length + ch.length > max) { out.push(cur); cur = ""; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** The /chat/native field that arms the echo of every part (only when there is more than one). */
export function youtubeEchoParts(text: string): { platformParts?: { youtube: string[] } } {
  const parts = youtubeParts(text);
  return parts.length > 1 ? { platformParts: { youtube: parts } } : {};
}

/** Post a line's parts one after another. The first failure stops the rest (a later part would
 *  arrive out of order) and is the result; on success the first part's id keys the copy. */
export async function sendInParts<R extends PartResult>(text: string, post: (part: string) => Promise<R>): Promise<R> {
  let first: R | null = null;
  for (const part of youtubeParts(text)) {
    const r = await post(part);
    if (!r.ok) return r;
    first ??= r;
  }
  return first!;
}
