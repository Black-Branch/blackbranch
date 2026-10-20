"use client";
// Behavior: which chat messages the viewer SEES — everyone except the people
// they have hidden, and bots when "Hide bots" is on (the bot flag is the
// server's). The buffer keeps every message; only what is drawn (and what can
// ping, light a dot or count as "new") is filtered, so unhiding someone brings
// their lines back.
//
// Cards (`system` rows — tips, gifts, subs, paid highlights, TTS, stickers) are
// NEVER hidden: someone paid for them, the same rule as Streamer spotlight never
// reaching a paid /highlight. Hiding a person hides their chat lines.
import { useCallback, useMemo } from "react";
import { hiddenMatcher } from "./behaviorLists";
import { useBehaviorLists } from "./behaviorStore";
import { useSetting } from "./useSetting";
import type { ChatMsg } from "./chatMsg";

/** A stable predicate: would this message be hidden from the viewer? */
export function useHidesMessage(): (m: ChatMsg) => boolean {
  const lists = useBehaviorLists();
  const hideBots = useSetting("chatStyle_hideBots") === "1";
  const isHidden = useMemo(() => hiddenMatcher(lists), [lists]);
  return useCallback((m: ChatMsg) => !m.system && (isHidden(m) || (hideBots && !!m.isBot)), [isHidden, hideBots]);
}

/** `list` without the messages the viewer has hidden (the same array when none are). */
export function useShownMessages(list: ChatMsg[]): ChatMsg[] {
  const lists = useBehaviorLists();
  const hideBots = useSetting("chatStyle_hideBots") === "1";
  const hides = useHidesMessage();
  return useMemo(
    () => (lists.hidden.length === 0 && !hideBots ? list : list.filter((m) => !hides(m))),
    [list, lists, hideBots, hides],
  );
}
