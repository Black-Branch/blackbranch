// The composer's id for a line it is sending (`client_msg_id`, v173). The send route answers an id
// it has already stored with the first row instead of posting again, so every attempt at ONE line
// must carry ONE id, and a new line must carry a new one.
//
// The id belongs to the TEXT: a send that failed puts its text back in the box, and sending that
// same text again is the same line (it may have posted, only the answer was lost). Edited text is a
// new line. A send that went through retires the id, so typing the same words again posts them.

export type LineIds = {
  /** The id for this text: the held one while the composer still holds the same text, else a new one. */
  forText(text: string): string;
  /** The line with this id went through; the next line, even with the same words, is a new one. */
  sent(id: string): void;
};

export function createLineIds(mint: () => string = () => crypto.randomUUID()): LineIds {
  let held: { text: string; id: string } | null = null;
  return {
    forText(text) {
      if (held && held.text === text) return held.id;
      held = { text, id: mint() };
      return held.id;
    },
    sent(id) {
      if (held?.id === id) held = null;
    },
  };
}
