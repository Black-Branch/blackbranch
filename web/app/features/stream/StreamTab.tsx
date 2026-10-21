"use client";
// The Stream tab: admin-only, in the lower dock on a computer and the chat panel's row on a phone.
// The live stream — or a past one picked from a drop-down — with its graphs; the platforms with
// their embed switches and titles; each platform's chat reader (running, starting, failed and why);
// income behind a switch that is off by default; the doctor's health in one strip.
//
// Only an admin's host mounts this (tabRegistry readiness), and every route it reads is admin-only
// on the server. Nothing polls unless the tab is the open one and the page is visible.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { getJson } from "@/app/lib/http";
import { useLocalStorageString } from "@/app/lib/useClientState";
import { Toggle } from "@/app/components/SettingsControls";
import { platformLabel } from "@/app/lib/platforms";
import {
  VIEWER_PLATFORMS, durationMinutes, fmtDuration, fmtMoney,
  type LiveDashboard, type SessionDetail, type SessionSort, type SessionSummary, type StreamLive,
} from "@/app/lib/streamStats";
import { ChatCurve, CompositionBar, EarnedChart, VelocityChart, ViewerCurve, card, cardTitle } from "./StreamCharts";
import { IncomeCard, SupportEventsList } from "./StreamIncome";
import { StreamPlatforms } from "./StreamPlatforms";
import { StreamHealth } from "./StreamHealth";
import { StreamReaders } from "./StreamReaders";

/** Remembered per browser, off by default. */
const INCOME_KEY = "bb_stream_income";
const LIVE_POLL_MS = 15_000;
const OFFLINE_POLL_MS = 60_000;

/** `atMs` is the server's clock when it answered: the live length and the earned graph's end read it,
 *  so a render never reads the clock itself. */
type LiveReply = { live: StreamLive; dash: LiveDashboard | null; last: SessionSummary | null; atMs: number };

const SORT_LABEL: Record<SessionSort, string> = { date: "Newest", viewers: "Most viewers", duration: "Longest", earned: "Most earned" };

const dateLabel = (ms: number, weekday = true) =>
  new Date(ms).toLocaleDateString(undefined, { ...(weekday ? { weekday: "short" } : {}), month: "short", day: "numeric", year: "numeric" });
const lengthOf = (s: SessionSummary) => (s.durationMs === null ? "live" : fmtDuration(Math.round(s.durationMs / 60_000)));

/** Poll `url` while `on`: every `every(data)` ms, only while the page is visible. */
function usePoll<T>(url: string | null, on: boolean, every: (d: T | null) => number) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  // The interval rule is written inline by the caller; read through a ref so a new identity each
  // render does not restart the poll.
  const everyRef = useRef(every);
  useEffect(() => { everyRef.current = every; });
  useEffect(() => {
    if (!on || !url) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      getJson<T>(url)
        .then((d) => { if (alive) { setData(d); setFailed(false); timer = setTimeout(next, everyRef.current(d)); } })
        .catch(() => { if (alive) { setFailed(true); timer = setTimeout(next, OFFLINE_POLL_MS); } });
    };
    const next = () => { if (document.visibilityState === "visible") run(); else timer = setTimeout(next, 5_000); };
    run();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [url, on]);
  return { data, failed };
}

export function StreamTab({ active }: { active: boolean }) {
  const [incomeRaw, setIncomeRaw] = useLocalStorageString(INCOME_KEY);
  const income = incomeRaw === "1";
  const inc = income ? "income=1" : "income=0";
  // null = the live view (or the last stream while offline); a stream id = that stream's review.
  const [pick, setPick] = useState<string | null>(null);
  const [sort, setSort] = useState<SessionSort>("date");
  const effSort: SessionSort = sort === "earned" && !income ? "date" : sort;

  const live = usePoll<LiveReply>(`/api/admin/stream?${inc}`, active && pick === null, (d) => (d?.live.live ? LIVE_POLL_MS : OFFLINE_POLL_MS));
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const loadSessions = useCallback(() => {
    getJson<{ sessions: SessionSummary[] }>(`/api/admin/stream/sessions?sort=${effSort}&${inc}`)
      .then((d) => setSessions(d.sessions)).catch(() => setSessions([]));
  }, [effSort, inc]);
  useEffect(() => { if (active) loadSessions(); }, [active, loadSessions]);
  const detail = usePoll<SessionDetail>(pick ? `/api/admin/stream/sessions/${encodeURIComponent(pick)}?${inc}` : null, active && pick !== null, () => 5 * 60_000);

  const isLive = live.data?.live.live === true;
  const liveId = live.data?.live.live ? live.data.live.streamId : null;
  // The live stream's own row in the list is the live view, not a review.
  const choose = (v: string) => setPick(v === "" || (liveId !== null && sessions?.find((s) => s.streamId === v)?.durationMs === null) ? null : v);

  return (
    <div className="h-full overflow-y-auto overscroll-contain px-3 pt-2 pb-6" data-stream-tab>
      <div className="mx-auto flex max-w-3xl flex-col gap-2.5">
        <Header data={live.data} failed={live.failed} pick={pick} />

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-secondary">
          <label className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0">Stream</span>
            <select
              value={pick ?? ""}
              onChange={(e) => choose(e.target.value)}
              aria-label="Pick a stream"
              className="h-6 min-w-0 max-w-[16rem] rounded-md border border-edge bg-surface-2 px-1.5 text-xs text-body"
            >
              <option value="">{isLive ? "Live now" : "Latest"}</option>
              {(sessions ?? []).filter((s) => s.durationMs !== null).map((s) => (
                <option key={s.streamId} value={s.streamId}>
                  {dateLabel(s.startedMs, false)} · {lengthOf(s)} · {s.peakViewers} peak{s.earnedCents !== null ? ` · ${fmtMoney(s.earnedCents, true)}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <span>Order</span>
            <select
              value={effSort}
              onChange={(e) => setSort(e.target.value as SessionSort)}
              aria-label="Order the streams"
              className="h-6 rounded-md border border-edge bg-surface-2 px-1.5 text-xs text-body"
            >
              {(["date", "viewers", "duration", ...(income ? ["earned" as const] : [])] as SessionSort[]).map((k) => <option key={k} value={k}>{SORT_LABEL[k]}</option>)}
            </select>
          </label>
          <span className="ml-auto flex items-center gap-2">
            <span>Show income</span>
            <Toggle on={income} label="Show income" onToggle={() => setIncomeRaw(income ? "0" : "1")} />
          </span>
        </div>

        {pick === null ? (
          <LiveView data={live.data} failed={live.failed} income={income} onOpen={setPick} />
        ) : (
          <Review detail={detail.data} failed={detail.failed} income={income} onBack={() => setPick(null)} isLive={isLive} />
        )}

        <StreamPlatforms active={active} />
        <StreamReaders active={active} />
        <StreamHealth active={active} />
      </div>
    </div>
  );
}

function Header({ data, failed, pick }: { data: LiveReply | null; failed: boolean; pick: string | null }) {
  if (!data) return <p className="text-xs text-muted">{failed ? "Couldn't load the stream." : "Loading…"}</p>;
  const l = data.live;
  if (!l.live) return <h3 className="text-2xs font-semibold uppercase tracking-wide text-secondary" data-live="0">Offline{pick ? "" : " — nothing is streaming right now"}</h3>;
  return (
    <div data-live="1">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-2xs font-semibold uppercase tracking-wide text-secondary">
          <span className="text-red-400">● Live</span> · {fmtDuration(durationMinutes(l.startedMs, data.atMs))}
        </h3>
        {l.viaSnapshot && <span className="text-3xs text-faint">from the last snapshot — the chat service did not answer</span>}
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-semibold tabular-nums text-heading">{l.viewers?.total ?? "—"}</span>
        <span className="text-2xs text-muted">viewers</span>
        <span className="flex flex-wrap gap-x-3 text-2xs text-muted tabular-nums">
          {VIEWER_PLATFORMS.map((p) => (l.viewers?.[p] == null ? null : <span key={p}>{platformLabel(p)} {l.viewers[p]}</span>))}
        </span>
      </div>
      <CompositionBar viewers={l.viewers} />
    </div>
  );
}

function LiveView({ data, failed, income, onOpen }: { data: LiveReply | null; failed: boolean; income: boolean; onOpen: (id: string) => void }) {
  if (!data) return failed ? null : <p className="text-xs text-muted">Loading the stream…</p>;
  if (!data.live.live) {
    const s = data.last;
    if (!s) {
      return (
        <section className={card}>
          <p className="text-xs text-muted">
            No streams recorded yet. A stream shows here once a platform is set up and you go live.{" "}
            <Link href="/admin/platforms" className="underline hover:text-strong">Set up a platform (Admin → Platforms)</Link>
          </p>
        </section>
      );
    }
    return (
      <button type="button" onClick={() => onOpen(s.streamId)} className={`${card} block w-full text-left hover:border-edge-bright`} data-last-stream>
        <div className={cardTitle}><span>Last stream · {dateLabel(s.startedMs)}</span><span className="normal-case tracking-normal font-normal">Open →</span></div>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-body tabular-nums">
          <span>{lengthOf(s)}</span>
          <span>{s.peakViewers} peak</span>
          <span>{s.avgViewers} average</span>
          <span>{s.messages} messages</span>
          {s.segments > 1 && <span>{s.segments} parts</span>}
          {income && s.earnedCents !== null && <span>{fmtMoney(s.earnedCents, true)}</span>}
        </div>
      </button>
    );
  }
  const l = data.live;
  const dash = data.dash;
  if (!dash) return null;
  return (
    <>
      <ViewerCurve curve={dash.curve} title="Viewers · this stream" />
      <VelocityChart buckets={dash.velocity} />
      <IncomeBlock income={income} money={dash.income} startedMs={l.startedMs} endMs={data.atMs} />
    </>
  );
}

function IncomeBlock({ income, money, startedMs, endMs }: { income: boolean; money: LiveDashboard["income"]; startedMs: number; endMs: number }) {
  if (!income) return <p className="text-2xs text-faint" data-income-hidden>Income is hidden — the earned graph and support list show with it.</p>;
  if (!money) return <p className="text-2xs text-muted">Loading income…</p>;
  return (
    <>
      <EarnedChart events={money.events} startedMs={startedMs} endMs={endMs} />
      <IncomeCard income={money} />
      <SupportEventsList income={money} />
    </>
  );
}

function Review({ detail, failed, income, onBack, isLive }: { detail: SessionDetail | null; failed: boolean; income: boolean; onBack: () => void; isLive: boolean }) {
  const back = <button type="button" onClick={onBack} className="self-start text-2xs text-muted underline hover:text-strong">← {isLive ? "Back to the live stream" : "Back to the latest"}</button>;
  if (!detail) return <div className="flex flex-col gap-1">{back}<p className="text-xs text-muted">{failed ? "Couldn't load that stream." : "Loading the stream…"}</p></div>;
  const s = detail.summary;
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-2xs font-semibold uppercase tracking-wide text-secondary" data-review>{dateLabel(s.startedMs)}</h3>
        <span className="text-2xs text-muted tabular-nums">
          {lengthOf(s)}{s.segments > 1 ? ` · ${s.segments} parts` : ""} · {s.peakViewers} peak · {s.avgViewers} average · {s.messages} messages
        </span>
      </div>
      {back}
      <ViewerCurve curve={detail.curve} title="Viewers" />
      <ChatCurve points={detail.chat} />
      <IncomeBlock income={income} money={detail.income} startedMs={s.startedMs} endMs={s.endedMs ?? s.startedMs + (s.durationMs ?? 0)} />
    </>
  );
}
