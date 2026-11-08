"use client";

// Admin Panel › Site › Community › Banner: the wide picture at the top of the community's channel
// list, under its name, as Discord shows a server banner. Saved on the community's own row; the
// server then puts it on the space for every app (the route, communityAdmin.ts putBannerResponse).

import { useRef, useState } from "react";
import { mxcToScaled, onScaledError } from "@/app/lib/matrixMedia";
import { btn, card, h2 } from "./parts";

const TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 2 * 1024 * 1024;

/** The route's refusal: JSON `{error}` from the save, plain text from the upload. */
async function refusal(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  try { return (JSON.parse(raw) as { error?: string }).error ?? raw; } catch { return raw; }
}

export default function BannerCard({ bannerMxc, saved, note }: {
  bannerMxc: string | null;
  /** After a save: when the host was asked (null: not asked), and the words for it. */
  saved: (requestedAt: string | null, words: string) => void;
  note: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const src = mxcToScaled(bannerMxc);

  const send = async (init: RequestInit, words: string) => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/community/banner", init);
      if (!res.ok) { note(`Not saved: ${(await refusal(res)) || "the site said no."}`); return; }
      const j = (await res.json().catch(() => ({}))) as { requestedAt?: string | null };
      saved(j.requestedAt ?? null, words);
    } catch {
      note("Not saved: the site did not answer.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const pick = (f: File | null | undefined) => {
    if (!f) return;
    if (!TYPES.includes(f.type)) { note("A banner is a PNG, JPEG or WebP picture."); return; }
    if (f.size > MAX_BYTES) { note("A banner is at most 2 MB."); return; }
    const form = new FormData();
    form.append("banner", f);
    void send({ method: "POST", body: form }, "Banner saved.");
  };

  return (
    <section className={card} aria-label="Banner">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className={`${h2} mr-auto`}>Banner</h2>
        <label className={`${btn} inline-flex cursor-pointer items-center ${busy ? "pointer-events-none opacity-40" : ""}`}>
          {bannerMxc ? "Change" : "Upload"}
          <input ref={input} type="file" accept={TYPES.join(",")} className="sr-only" disabled={busy}
            onChange={(e) => pick(e.target.files?.[0])} />
        </label>
        {bannerMxc && (
          <button type="button" className={btn} disabled={busy} onClick={() => void send({ method: "DELETE" }, "Banner removed.")}>Remove</button>
        )}
      </div>
      <p className="mt-1 text-xs text-muted">
        A wide picture at the top of the channel list, behind the community&apos;s name. PNG, JPEG or WebP, up to 2 MB; a 16:9 picture fits best.
      </p>
      {src ? (
        <div className="mt-2 w-full max-w-sm overflow-hidden rounded-lg border border-edge bg-surface-2" style={{ aspectRatio: "16 / 9" }}>
          <img key={src} src={src} alt="The community's banner" className="h-full w-full object-cover" onError={(e) => onScaledError(e.currentTarget, bannerMxc)} />
        </div>
      ) : (
        <p className="mt-2 text-xs text-body-dim">No banner yet: the channel list shows the community&apos;s name on its own.</p>
      )}
    </section>
  );
}
