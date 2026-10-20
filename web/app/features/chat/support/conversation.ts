// The support conversation as a pure reducer. No React, no fetch — the hook
// wraps these with side effects, and the tests exercise the whole behaviour
// synchronously. State transitions are immutable (each helper returns a new
// state) so the hook can hand them straight to setState.

// Relative, not the @/ alias — this module is imported by node --test suites,
// and the alias only resolves under the bundler (the suite dies silently).
import { SUPPORT_ROOT, findNode, type FlowNode } from "../../../lib/support/flows.ts";

export type SupportMsg = { id: number; role: "bot" | "user"; text: string };

export type Awaiting =
  | "options"        // quick-reply buttons have the floor
  | "report-user"    // collecting: who to report
  | "report-reason"  // collecting: why
  | "bug-desc"       // collecting: what broke
  | "free"           // free text → the LLM
  | "busy";          // a reply is in flight; input parked

export type ConvoState = {
  msgs: SupportMsg[];
  options: FlowNode[];
  awaiting: Awaiting;
  pendingReport?: { username: string };
  nextId: number;
};

// Collector prompts — front-desk register, no bits.
const ASK_WHO = "Who's the trouble? Give me their name as it shows in chat.";
const ASK_WHY = "And what happened? One or two sentences is plenty.";
const ASK_BUG = "Describe the bug — what did you do, and what did it do?";

function append(s: ConvoState, role: SupportMsg["role"], text: string): ConvoState {
  return { ...s, msgs: [...s.msgs, { id: s.nextId, role, text }], nextId: s.nextId + 1 };
}

export function openState(opener: string, options: FlowNode[] = SUPPORT_ROOT): ConvoState {
  return {
    msgs: [{ id: 1, role: "bot", text: opener }],
    options,
    awaiting: "options",
    nextId: 2,
  };
}

export function deskSays(
  s: ConvoState, text: string, opts?: { backToRoot?: boolean },
): ConvoState {
  const next = append(s, "bot", text);
  return opts?.backToRoot
    ? { ...next, options: SUPPORT_ROOT, awaiting: "options", pendingReport: undefined }
    : next;
}

export function pickOption(s: ConvoState, key: string): ConvoState {
  // The offered options first — a reminder open puts nodes on the floor that
  // don't live in SUPPORT_ROOT — then the global tree (answer leaves stay
  // pickable right after backToRoot swaps the row out from under a slow tap).
  const node = findNode(key, s.options) ?? findNode(key);
  if (!node) return s;
  // The user's pick reads as their line in the thread — mirrors how the
  // choice would look if they'd typed it.
  const chosen = append(s, "user", node.label);
  if (node.children?.length) {
    return { ...chosen, options: node.children, awaiting: "options" };
  }
  switch (node.action?.kind) {
    case "answer":
      return deskSays(chosen, node.action.text, { backToRoot: true });
    case "report-user":
      return { ...deskSays(chosen, ASK_WHO), options: [], awaiting: "report-user" };
    case "report-bug":
      return { ...deskSays(chosen, ASK_BUG), options: [], awaiting: "bug-desc" };
    case "free-text":
      return { ...deskSays(chosen, "Go ahead — type it below."), options: [], awaiting: "free" };
    default:
      return s;
  }
}

/**
 * Route typed text by what the conversation is waiting for. The BUSY/side-effect
 * transitions (filing the report/ticket, calling the LLM) belong to the hook —
 * this only advances the collector states that need no I/O.
 */
export function userText(s: ConvoState, text: string): ConvoState {
  const typed = append(s, "user", text);
  switch (s.awaiting) {
    case "report-user":
      return { ...deskSays(typed, ASK_WHY), pendingReport: { username: text.trim() }, awaiting: "report-reason" };
    case "report-reason":
    case "bug-desc":
    case "free":
    // Typing INSTEAD of clicking a button is a free-text question — people do
    // it, and "pick a button first" would be a dead end. Routes to the LLM.
    case "options":
      // The hook fires the matching side effect and parks input.
      return { ...typed, awaiting: "busy" };
    default:
      return typed;
  }
}
