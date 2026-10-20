import type { HomeThread } from "@/app/lib/forumModel";
import { agoLabel } from "@/app/lib/relativeTime";
import { openForumThread } from "@/app/lib/forumLinks";

// "Active threads": the forums' top threads by activity. A click
// asks the host to open the Forums tab on that thread (the deep link); the
// host for this viewport claims it — nothing here knows which host that is.
export function ThreadsWidget({ threads, loading, nowMs }: {
  threads: HomeThread[] | null;
  loading: boolean;
  nowMs: number;
}) {
  if (threads === null) return <p>{loading ? "Loading…" : "Couldn't load right now."}</p>;
  if (threads.length === 0) return <p className="text-muted">Nothing yet</p>;
  return (
    <ul className="flex flex-col gap-1.5">
      {threads.map((t) => (
        <li key={t.eventId} className="min-w-0">
          <button
            type="button"
            onClick={() => openForumThread({ roomId: t.roomId, eventId: t.eventId })}
            className="text-left w-full min-w-0 hover:text-strong"
          >
            <span className="block truncate">{t.title}</span>
            <span className="block text-xs text-muted truncate">
              {t.replyCount === 1 ? "1 reply" : `${t.replyCount} replies`} · {t.roomName} · {agoLabel(new Date(t.lastTs).toISOString(), nowMs)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
