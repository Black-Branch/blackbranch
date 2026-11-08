// A name with the part a search matched drawn bold (ticket #193): the /dm picker, its palette and the
// DM list's "+" search all mark the match the same way.
import { matchPart } from "@/app/lib/dm/matchPart";

export function MatchText({ text, query }: { text: string; query: string }) {
  const m = matchPart(text, query);
  if (!m) return <>{text}</>;
  return <>{m.before}<b data-match="" className="font-bold text-strong">{m.match}</b>{m.after}</>;
}
