"use client";
// The Stream tab's Platforms section: per platform, whether it is set up, its embed switch (the
// watch page's live sources — one setting, player.embedsOff, written through the Admin Panel's own
// writer), its current title where a key the site holds can read it, and a link to change it on
// the platform. Titles are never written here.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getJson, postJson } from "@/app/lib/http";
import { Toggle } from "@/app/components/SettingsControls";
import PlatformIcon from "@/app/components/PlatformIcon";
import type { PlatformRow } from "@/app/lib/streamStats";
import { card, cardTitle } from "./StreamCharts";

const TITLE_POLL_MS = 2 * 60_000;

export function StreamPlatforms({ active }: { active: boolean }) {
  const [rows, setRows] = useState<PlatformRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    getJson<{ platforms: PlatformRow[] }>("/api/admin/stream/platforms")
      .then((d) => { setRows(d.platforms); setFailed(false); })
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => {
    if (!active) return;
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, TITLE_POLL_MS);
    return () => clearInterval(t);
  }, [active, load]);

  const embeds = (rows ?? []).filter((r) => r.embed);
  const onCount = embeds.filter((r) => r.embed!.on).length;
  async function flip(r: PlatformRow) {
    if (!r.embed) return;
    const off = embeds.filter((x) => (x.key === r.key ? x.embed!.on : !x.embed!.on)).map((x) => x.embed!.source);
    setSaving(r.key);
    setError(null);
    try {
      const res = await postJson("/api/admin/instance/player.embedsOff", { value: off }, "PUT");
      if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not save");
      load();
    } catch {
      setError("Could not save — the site did not answer");
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className={card} data-section="platforms">
      <div className={cardTitle}><span>Platforms</span></div>
      {rows === null ? (
        <p className="mt-2 text-xs text-muted">{failed ? "Couldn't load the platforms." : "Loading…"}</p>
      ) : (
        <ul className="mt-2 divide-y divide-edge">
          {rows.map((r) => (
            <li key={r.key} className="py-2 first:pt-0 last:pb-0" data-platform={r.key}>
              <div className="flex min-h-7 items-center gap-2">
                <PlatformIcon platform={r.key} size={14} />
                <span className="text-xs text-body">{r.label}</span>
                {!r.setUp && (
                  <Link href={r.setupHref} className="text-2xs text-muted underline hover:text-strong">Not set up — set it up</Link>
                )}
                <span className="ml-auto flex items-center gap-2 text-2xs text-muted">
                  {r.embed ? (
                    <>
                      <span>Embed</span>
                      <Toggle
                        on={r.embed.on}
                        label={`${r.label} on the watch page`}
                        // The last source on cannot be switched off: a player with no source is a dark site.
                        disabled={saving !== null || (r.embed.on && onCount <= 1)}
                        onToggle={() => void flip(r)}
                      />
                    </>
                  ) : r.key === "kick" ? <span>No embed on the site</span> : null}
                </span>
              </div>
              {r.setUp && (
                <div className="mt-0.5 pl-6 text-2xs text-muted">
                  {r.title ? (
                    <p className="text-xs text-body break-words" data-title>{r.title}{r.category ? <span className="text-muted"> · {r.category}</span> : null}</p>
                  ) : (
                    <p>{r.titleNote}</p>
                  )}
                  {r.manageUrl && (
                    <a href={r.manageUrl} target="_blank" rel="noopener" className="underline hover:text-strong">Change the title on {r.label} ↗</a>
                  )}
                  {r.key === "youtube" && <p className="mt-0.5 text-faint">Read-only here: setting titles and scheduling on YouTube comes with 1.0.</p>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-2xs text-red-400" role="alert">{error}</p>}
      <p className="mt-2 text-2xs text-faint">Embed switches apply to viewers at their next page load. Setting titles and scheduling streams from here is not in this release.</p>
    </section>
  );
}
