// The poll wire/state shape.
//
// Lives in core, not in PollCard, because `ChatMsg.poll` is typed with it and
// lib/chatMsg.ts must not import a UI component (dependency direction). PollCard
// re-exports it so existing `import { type PollState } from "./PollCard"` works.

export type PollState = {
  pollId: number;
  question: string;
  options: { n: number; text: string }[];
  createdByName?: string | null;
  startedAt: number;
  endsAt: number;
  status: "active" | "ended" | "cancelled";
  tallies: Record<number, number>;
  total: number;
  winner: number | null;
};
