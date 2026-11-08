"use client";

import { ChartBar } from "@phosphor-icons/react/dist/ssr";
import { parsePollStart, textOf } from "@/app/lib/pollStart";

/** A poll started in another Matrix app (Element, FluffyChat), read-only: the question and its
 *  answers, or — when the content holds no readable poll — the sender's text fallback. Voting
 *  here is not built yet, so the card says where to vote. Everything is rendered as text. */
export function PollStartCard({ content }: { content: Record<string, unknown> }) {
  const poll = parsePollStart(content);
  const fallback = poll ? null : (textOf(content) ?? "").trim();
  return (
    <div data-poll-start="" className="mt-1 max-w-[34rem] rounded-lg border border-edge bg-surface-1 p-3 [overflow-wrap:anywhere]">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
        <ChartBar size={14} weight="bold" aria-hidden="true" />
        Poll
      </div>
      {poll ? (
        <>
          <div data-poll-question="" className="font-semibold text-body">{poll.question}</div>
          <ol className="mt-2 flex flex-col gap-1.5">
            {poll.answers.map((a, i) => (
              <li key={i} data-poll-answer="" className="rounded-md border border-edge bg-surface-2 px-2.5 py-1.5 text-body">
                {a.text}
              </li>
            ))}
          </ol>
        </>
      ) : (
        <div data-poll-fallback="" className="whitespace-pre-line text-body">{fallback}</div>
      )}
      <div className="mt-2 text-xs text-muted">Vote in a Matrix app for now</div>
    </div>
  );
}
