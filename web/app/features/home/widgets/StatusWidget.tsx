import type { HomeStatus } from "@/app/lib/homePayload";
import type { LastStream } from "@/app/lib/lastStream";
import { agoLabel, durationLabel } from "@/app/lib/relativeTime";

export function StatusWidget({ status, lastStream, loading, onWatchCommunity, nowMs }: {
  status: HomeStatus | null;
  lastStream: LastStream | null;
  loading: boolean;
  onWatchCommunity: () => void;
  nowMs: number;
}) {
  if (status === null) return <p>{loading ? "Loading…" : "Couldn't load right now."}</p>;
  if (status.live) {
    return (
      <p>
        <span className="text-red-400 font-semibold">LIVE now</span>
        {status.viewers !== null && <span className="text-muted"> · {status.viewers} watching</span>}
      </p>
    );
  }
  const ran = lastStream ? Date.parse(lastStream.endedAt) - Date.parse(lastStream.startedAt) : 0;
  return (
    <div className="flex flex-col gap-1">
      <p><span className="font-semibold text-strong">Offline</span></p>
      {lastStream && (
        <p className="text-muted">Last stream ended {agoLabel(lastStream.endedAt, nowMs)} · ran {durationLabel(ran)}</p>
      )}
      {status.community && (
        <p className="flex items-center gap-2">
          <span><span className="text-strong">{status.community.name}</span> is live</span>
          <button type="button" onClick={onWatchCommunity} className="px-2 py-0.5 rounded-md bg-surface-3 hover:bg-surface-5 text-strong text-xs">Watch</button>
        </p>
      )}
    </div>
  );
}
