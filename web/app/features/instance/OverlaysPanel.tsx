"use client";

// The overlay pages stream-api serves (the overlay directory's stream-api entries), each with its
// address on this install's API host and a copy button. Utility → OBS lists them with how OBS takes
// them; an overlay with a settings page of its own (the support bar, the alerts) is listed there
// instead, beside its settings. The meter is the owner's and is never listed.
// No settings: an overlay page reads the live socket and draws nothing until something happens.

import { useState } from "react";
import { OVERLAY_SOURCES, sourceHref, type OverlaySource } from "@/app/lib/overlayDirectory";
import { card, h2, h3, btn } from "./parts";

/** Overlays listed on their own settings page, by place: the support bar's, the alerts' (Effects). */
const OVERLAY_HOME: Readonly<Record<string, string>> = { "support-bar": "utility/bar", alert: "utility/effects" };
/** The overlays the product lists: the directory's stream-api pages, in its order, without the meter. */
const API_OVERLAYS: readonly OverlaySource[] = OVERLAY_SOURCES.filter((s) => s.served === "stream-api" && s.id !== "meter");

function CopyAddress({ text, name }: { text: string; name: string }) {
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const copy = () => {
    const p = navigator.clipboard?.writeText(text);
    if (!p) { setCopied("failed"); return; }
    p.then(() => setCopied("copied"), () => setCopied("failed")).finally(() => setTimeout(() => setCopied(null), 1800));
  };
  return (
    <button type="button" className={`${btn} w-20`} onClick={copy} aria-live="polite" aria-label={`Copy the ${name} address`}>
      {copied === "copied" ? "Copied" : copied === "failed" ? "Not copied" : "Copy"}
    </button>
  );
}

/** One or more overlays' addresses, as a card: on the page whose settings they draw. */
export function OverlayAddresses({ ids, title = "In OBS" }: { ids: readonly string[]; title?: string }) {
  const rows = API_OVERLAYS.filter((s) => ids.includes(s.id));
  if (!rows.length) return null;
  return (
    <section className={card} aria-label="Overlay address">
      <h2 className={h2}>{title}</h2>
      <p className="mt-0.5 text-xs text-muted">Add this page to OBS as a Browser source, width 1920, height 1080.</p>
      <OverlayList rows={rows} />
    </section>
  );
}

function OverlayList({ rows }: { rows: readonly OverlaySource[] }) {
  return (
    <ul className="mt-2 divide-y divide-edge">
      {rows.map((s) => {
        const href = sourceHref(s, "");
        return (
          <li key={s.id} className="py-2.5 first:pt-0 last:pb-0 space-y-1" data-overlay={s.id}>
            <h3 className={h3}>{s.name}</h3>
            <p className="text-xs text-secondary">{s.shows}</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 basis-64 rounded-md border border-edge bg-surface-2 px-2 py-0.5 text-xs text-strong break-all" data-overlay-url>{href}</code>
              <CopyAddress text={href} name={s.name} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Utility → OBS's overlay cards: how to add one, then every overlay without a page of its own. */
export default function OverlaysPanel({ go }: {
  /** Opens another Admin Panel place (an overlay listed beside its own settings). */
  go: (id: string) => void;
}) {
  return (
    <>
      <section className={`${card} space-y-2`} data-overlays-howto>
        <h2 className={h2}>Add an overlay to OBS</h2>
        <ol className="list-decimal space-y-0.5 pl-4 text-xs text-secondary">
          <li>In OBS: Sources → + → Browser.</li>
          <li>Paste the overlay&apos;s address from the list below.</li>
          <li>Width 1920, height 1080. Leave the custom CSS as it is.</li>
          <li>Put the source in every scene you stream from (or in one scene you nest into each).</li>
        </ol>
        <p className="text-xs text-muted">
          Each overlay is transparent and shows only while something happens. The voice, the sound alerts and the
          bot&apos;s avatar come through the rig page above. The support bar&apos;s address is on{" "}
          <button type="button" className="text-body-dim underline hover:text-strong" onClick={() => go("utility/bar")}>Support bar</button>, the alerts&apos; on{" "}
          <button type="button" className="text-body-dim underline hover:text-strong" onClick={() => go("utility/effects")}>Effects</button>.
          {" "}Chat and the credit line: <a href="/overlay" className="text-body-dim underline hover:text-strong">the overlay directory</a>.
        </p>
      </section>
      <section className={card} aria-label="Overlay addresses">
        <h2 className={h2}>Overlays</h2>
        <OverlayList rows={API_OVERLAYS.filter((o) => !(o.id in OVERLAY_HOME))} />
      </section>
    </>
  );
}
