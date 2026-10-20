// Income for one stream: the take-home per platform, the off-stream slice, and the support
// events — the model's SupportEventsList. Drawn only while the Income switch is on; with it off
// the routes never send money at all.
import { platformLabel } from "@/app/lib/platforms";
import { siteName } from "@/app/lib/siteName";
import { isNativePlatform } from "@/app/lib/nativePlatform";
import { fmtMoney, type StreamIncome } from "@/app/lib/streamStats";
import { card, cardTitle } from "./StreamCharts";

const sourceWord = (p: string) => (isNativePlatform(p) ? siteName() : p === "kofi" ? "Ko-fi" : p === "streamlabs" ? "Streamlabs" : p === "patreon" ? "Patreon" : platformLabel(p));

export function IncomeCard({ income }: { income: StreamIncome }) {
  const platforms = Object.entries(income.byPlatform).sort((a, b) => b[1] - a[1]);
  return (
    <section className={card} data-income>
      <div className={cardTitle}><span>Income · take-home</span><span className="tabular-nums">{fmtMoney(income.earnedCents)}</span></div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted tabular-nums">
        {platforms.length === 0 ? <span>Nothing this stream.</span> : platforms.map(([p, cents]) => <span key={p}>{sourceWord(p)} {fmtMoney(cents)}</span>)}
      </div>
      <p className="mt-1.5 text-2xs text-faint tabular-nums" data-off-stream>
        Off-stream since the stream before: {fmtMoney(income.offStreamCents)} (renewals and tips with no stream attached)
      </p>
    </section>
  );
}

export function SupportEventsList({ income }: { income: StreamIncome }) {
  return (
    <section className={card}>
      <div className={cardTitle}><span>Support · this stream</span><span className="tabular-nums">{income.events.length}</span></div>
      {income.events.length === 0 ? (
        <p className="mt-2 text-xs text-muted">No support events this stream.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {income.events.slice(0, 25).map((e) => (
            <li key={e.id} className="flex items-baseline justify-between gap-2 text-xs">
              <span className="min-w-0 truncate text-body">
                {e.username}
                <span className="ml-2 text-2xs text-faint">{sourceWord(e.platform)}{e.eventType ? ` · ${e.eventType}` : ""}</span>
              </span>
              <span className="shrink-0 tabular-nums text-body">{fmtMoney(e.cents)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
