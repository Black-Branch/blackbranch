"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  openState, pickOption, userText, deskSays, type ConvoState, type SupportMsg,
} from "./conversation";
import { GREETINGS, FILE_LAST_BUG, NO_FREE_TEXT, supportFreeText, type FlowNode } from "@/app/lib/support/flows";

// The hook is deliberately thin: all conversation logic lives in the pure
// reducer (conversation.ts); this layer only owns React state and fires the
// three side effects the reducer parks on ("busy"):
//   report-reason → onReport   · bug-desc → onTicket   · free → onFreeText
//
// Degradation rule: a failed side effect never dead-ends the thread — the desk
// says what went wrong and hands the floor back to the root options.

export type SupportDeps = {
  /** File a user report. Throw "user_not_found"/"ambiguous" to trigger the fallback lines. */
  onReport: (username: string, reason: string) => Promise<void>;
  onTicket: (kind: "bug" | "other", body: string, transcript: SupportMsg[]) => Promise<void>;
  /** One free-text LLM turn. Returns the desk's reply text. */
  onFreeText: (text: string, history: SupportMsg[]) => Promise<string>;
};

const FILED = "Filed. A human reads these — expect a follow-up if it needs one.";
const REPORT_FILED = "Noted and passed to the mods. Thanks for flagging it.";
const NO_SUCH_USER = "Couldn't find anyone by that name. Check the spelling as it shows in chat — or file it as a general ticket from the menu.";
const AMBIGUOUS = "More than one person matches that — give me the exact name as it shows in chat.";
const BRAIN_DOWN = "I can't reach my brain right now. File it as a bug from the menu and a human will help.";

export function useSupportConversation(deps: SupportDeps) {
  const [state, setState] = useState<ConvoState | null>(null);
  // Mirror of `state` that async work can read/advance without waiting for a
  // render — also what keeps a second Enter during "busy" a clean no-op.
  const stateRef = useRef<ConvoState | null>(null);
  // Deps ride a ref so the callbacks stay referentially stable. Synced in an
  // effect (not during render — react-hooks/refs) and read only at call time,
  // which is always post-render.
  const depsRef = useRef(deps);
  useEffect(() => { depsRef.current = deps; });

  const commit = useCallback((next: ConvoState | null) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const open = useCallback((opener?: string, options?: FlowNode[]) => {
    // Already open → never wipe a thread mid-conversation.
    if (stateRef.current) return;
    const line = opener ?? GREETINGS[Math.floor(Math.random() * GREETINGS.length)] ?? GREETINGS[0]!;
    commit(openState(line, options));
  }, [commit]);

  const reset = useCallback(() => commit(null), [commit]);

  const pick = useCallback((key: string) => {
    // The synthetic "file that as a bug report" chip: files the user's LAST
    // typed message as the ticket body — no retyping. Special-cased here
    // because it isn't a flow node the reducer knows.
    if (key === FILE_LAST_BUG.key) {
      const s = stateRef.current;
      const lastUser = s ? [...s.msgs].reverse().find((m) => m.role === "user") : undefined;
      if (!s || !lastUser) return;
      commit({ ...s, options: [], awaiting: "busy" });
      void (async () => {
        try {
          await depsRef.current.onTicket("bug", lastUser.text, s.msgs);
          commit(deskSays(stateRef.current ?? s, FILED, { backToRoot: true }));
        } catch {
          commit(deskSays(stateRef.current ?? s,
            "Couldn't file it — try the Report a bug button instead.", { backToRoot: true }));
        }
      })();
      return;
    }
    if (stateRef.current) commit(pickOption(stateRef.current, key));
  }, [commit]);

  const sendText = useCallback(async (text: string) => {
    const trimmed = text.trim();
    const prev = stateRef.current;
    if (!trimmed || !prev || prev.awaiting === "busy") return;
    const advanced = userText(prev, trimmed);
    commit(advanced);

    const d = depsRef.current;
    try {
      if (prev.awaiting === "report-reason" && prev.pendingReport) {
        await d.onReport(prev.pendingReport.username, trimmed);
        commit(deskSays(advanced, REPORT_FILED, { backToRoot: true }));
      } else if (prev.awaiting === "bug-desc") {
        await d.onTicket("bug", trimmed, advanced.msgs);
        commit(deskSays(advanced, FILED, { backToRoot: true }));
      } else if ((prev.awaiting === "free" || prev.awaiting === "options") && !supportFreeText()) {
        // Nothing here answers a typed question (no AI help desk on this install): say so
        // at once and hand back the menu — never a 30 s hold ending in "can't reach my brain".
        commit(deskSays(advanced, NO_FREE_TEXT, { backToRoot: true }));
      } else if (prev.awaiting === "free" || prev.awaiting === "options") {
        // Typed over the options row = a free-text question (conversation.ts).
        const reply = await d.onFreeText(trimmed, prev.msgs);
        // Root options come BACK under every answer (backToRoot), still
        // accepting typed follow-ups (awaiting "free") — plus the "file that
        // as a bug report" chip, so a typed bug description files in one tap
        // instead of a retype through the collector.
        const answered = deskSays(advanced, reply, { backToRoot: true });
        commit({ ...answered, options: [...answered.options, FILE_LAST_BUG], awaiting: "free" });
      }
      // Collector states that need no I/O (report-user → report-reason)
      // already advanced inside userText.
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      const line =
        code === "user_not_found" ? NO_SUCH_USER
        : code === "ambiguous" ? AMBIGUOUS
        : code.startsWith("cooldown:")
          ? `Easy — I answer at a human pace. Give it a couple of minutes and ask again.`
        : BRAIN_DOWN;
      // A bad name re-arms the collector so they can retry it; everything
      // else returns to the menu.
      if (code === "user_not_found" || code === "ambiguous") {
        commit({ ...deskSays(advanced, line), awaiting: "report-user", pendingReport: undefined });
      } else {
        commit(deskSays(advanced, line, { backToRoot: true }));
      }
    }
  }, [commit]);

  return { state, open, reset, pick, sendText };
}
