// Polls started in other Matrix apps (MSC3381). Element Web and FluffyChat send them through
// matrix-js-sdk's PollStartEvent serializer, under the unstable names; the stable names are
// accepted too. Reading only: the site cannot vote or end a poll yet (the card says so).
//
// The content is hostile input (any signed-in user can send any event): every field is checked
// for type, text is rendered as text, and answers are capped where the SDK caps them.

/** Both spellings of the poll-start event type. */
const POLL_START_TYPES: ReadonlySet<string> = new Set(["org.matrix.msc3381.poll.start", "m.poll.start"]);

export const isPollStartType = (type: string): boolean => POLL_START_TYPES.has(type);

/** matrix-js-sdk's PollStartEvent keeps the first 20 answers; so do we. */
const MAX_ANSWERS = 20;
// The content key holding the poll: the SDK's unstable and stable names, and MSC3381's final `m.poll`.
const POLL_KEYS = ["org.matrix.msc3381.poll.start", "m.poll.start", "m.poll"] as const;

export type PollStart = { question: string; answers: { id: string; text: string }[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The plain text of an MSC1767 text node: the unstable string, the stable `m.text` (a string or a
 *  list of representations, plain text preferred over HTML), else `body`. */
export function textOf(node: unknown): string | null {
  if (!isRecord(node)) return null;
  const unstable = node["org.matrix.msc1767.text"];
  if (typeof unstable === "string") return unstable;
  const stable = node["m.text"];
  if (typeof stable === "string") return stable;
  if (Array.isArray(stable)) {
    const reps = stable.filter(isRecord).filter((r) => typeof r.body === "string");
    const plain = reps.find((r) => r.mimetype === undefined || r.mimetype === "text/plain") ?? reps[0];
    if (plain) return plain.body as string;
  }
  return typeof node.body === "string" ? node.body : null;
}

/** The poll in a poll-start event's content, or null when it has no question or no answers
 *  (the SDK rejects those as invalid events too) — then the caller shows the text fallback. */
export function parsePollStart(content: Record<string, unknown>): PollStart | null {
  const poll = POLL_KEYS.map((k) => content[k]).find(isRecord);
  if (!poll) return null;
  const question = textOf(poll.question)?.trim();
  if (!question || !Array.isArray(poll.answers)) return null;
  const answers: PollStart["answers"] = [];
  for (const [i, a] of poll.answers.slice(0, MAX_ANSWERS).entries()) {
    const text = textOf(a)?.trim();
    if (!text || !isRecord(a)) continue;
    const id = typeof a.id === "string" ? a.id : typeof a["m.id"] === "string" ? (a["m.id"] as string) : String(i);
    answers.push({ id, text });
  }
  return answers.length > 0 ? { question, answers } : null;
}
