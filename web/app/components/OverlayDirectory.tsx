"use client";

import { useState } from "react";
import { useClientValue } from "@/app/lib/useClientState";
import { Copy, Check, ArrowSquareOut } from "@phosphor-icons/react/dist/ssr";
import { OVERLAY_SOURCES, sourceHref, type OverlaySource } from "@/app/lib/overlayDirectory";
import { RIG_OVERLAYS } from "@/app/lib/plugins/site";

// The site's and stream-api's sources, then the files the install's plugin lists on the streaming PC.
const SOURCES: OverlaySource[] = [...OVERLAY_SOURCES, ...RIG_OVERLAYS.sources];

// The /overlay page's body: every OBS browser source, grouped by where it is
// served from, each with the exact string OBS is given and a button that
// copies it. Site URLs are built against the page's own origin, read through
// useClientValue so the server markup (bare path) and the first client render
// agree — a bare window.location read during render is a hydration mismatch
// on every load, which ClientErrorReporter would then log.

const HOME: Record<OverlaySource["served"], { title: string; blurb: string }> = {
  site: {
    title: "Served by the site",
    blurb: "Pages of this web app. Names, badges and styles render with chat's real engine.",
  },
  "stream-api": {
    title: "Served by stream-api",
    blurb: "Public pages on the API host — the same host the chat socket and the radio use.",
  },
  rig: {
    title: "Files on the streaming PC",
    blurb: `OBS loads these from disk (${RIG_OVERLAYS.dir}).`,
  },
};

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      title="Copy"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }).catch(() => {});
      }}
      className="chrome-bar-btn shrink-0"
    >
      {done ? <Check size={14} weight="bold" /> : <Copy size={14} weight="bold" />}
      <span role="status" className="sr-only">{done ? "Copied" : ""}</span>
    </button>
  );
}

function SourceRow({ s, origin }: { s: OverlaySource; origin: string }) {
  const href = sourceHref(s, origin, RIG_OVERLAYS.dir);
  const isLink = s.served !== "rig";
  return (
    <li className="py-3 border-b border-edge last:border-b-0">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-semibold text-heading">{s.name}</span>
        {s.status === "retiring" && (
          <span className="text-2xs uppercase tracking-wide text-muted border border-edge rounded-full px-2 py-px">Retiring</span>
        )}
      </div>
      <p className="mt-1 text-sm text-secondary">{s.shows}</p>
      <div className="mt-2 flex items-center gap-2 min-w-0">
        <code className="min-w-0 flex-1 truncate rounded-md bg-surface-2 border border-edge px-2 py-1 text-xs text-body" title={href}>
          {href}
        </code>
        <CopyButton text={href} label={`the ${s.name} source`} />
        {isLink && (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${s.name} in a new tab`}
            title="Open"
            className="chrome-bar-btn shrink-0"
          >
            <ArrowSquareOut size={14} weight="bold" />
          </a>
        )}
      </div>
      <p className="mt-1 text-xs text-muted">
        <span className="text-body-dim">Size:</span> {s.size}
        {s.notes ? <> · {s.notes}</> : null}
      </p>
    </li>
  );
}

export default function OverlayDirectory() {
  const origin = useClientValue(() => window.location.origin, "");
  const homes: OverlaySource["served"][] = ["site", "stream-api", "rig"];
  return (
    <div className="flex flex-col gap-8">
      {homes.map((home) => {
        const rows = SOURCES.filter((s) => s.served === home);
        if (rows.length === 0) return null;
        return (
          <section key={home}>
            <h2 className="text-base font-semibold text-heading">{HOME[home].title}</h2>
            <p className="mt-1 text-sm text-secondary">{HOME[home].blurb}</p>
            <ul className="mt-2">
              {rows.map((s) => <SourceRow key={s.id} s={s} origin={origin} />)}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
