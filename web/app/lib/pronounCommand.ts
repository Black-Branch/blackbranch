import { streamApiFetch } from "./streamApi.ts";

// Every web path that sets pronouns asks stream-api's ONE parser
// (/identity/pronoun-command, stream-api pronouns.js): the chat box's `!` lines,
// `/pronouns`, Edit profile, a mod's card and `/pronouns @name`. Lists of its
// own in web would disagree with it.

export type PronounAnswer = {
  matched: boolean; usage?: boolean; pronouns?: string | null; canonicalId?: string;
  /** A mod's `name` lookup: two people chatted under it this month, or nobody did. */
  ambiguous?: boolean; notFound?: boolean;
};

/** The one line a pronoun command gets when it cannot be read. */
export const PRONOUN_USAGE = "Set them with !he, !she or !they (or !pronouns she/her).";

/** null = stream-api unreachable or refused; the caller decides what that means. */
export async function askPronounCommand(body: {
  text: string;
  matrixId?: string;
  canonicalId?: string;
  /** Mods only (stream-api refuses it otherwise): whoever chatted under this name. */
  name?: string;
  source?: "self" | "mod";
  /** With `name`: answer who it lands on, write nothing (the mod route checks its ceiling first). */
  resolveOnly?: boolean;
}): Promise<PronounAnswer | null> {
  try {
    const res = await streamApiFetch("/identity/pronoun-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok ? ((await res.json()) as PronounAnswer) : null;
  } catch {
    return null;
  }
}
