"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSponsorClock } from "@/app/lib/SponsorClockContext";
import { useBadges, badgesForMatrixId } from "@/app/lib/BadgesContext";
import { usernameStyleCSS, usernameStyleAnimClass, type EquippedStyle } from "@/app/lib/usernameStyles";
import { useNameInk } from "@/app/lib/nameInk";
import { useAnimFenceRef } from "@/app/lib/animFence";
import { deriveCreditList, namesNeedingStyle, FADE_MS, type CreditEntry } from "@/app/lib/creditRotation";
import { SponsorClockBadge } from "@/app/components/SponsorClockBadge";
import type { BadgeUserState } from "@/app/lib/badgeSlots";

// "THIS STREAM IS MADE POSSIBLE BY ___" — the web-served credit line.
//
// Names render EXACTLY as native chat renders them: the same
// usernameStyleCSS (font / glow / gradient / animation), the same badge images
// from BadgesContext, the same sweep clock badge component — because this page
// is the web app, not a copy of it. The rotation is credit.html's (see
// creditRotation.ts): biggest share first, dwell ∝ share, 0.7s fade between.
//
// Data: the sponsor pool comes from the root layout's SponsorClockProvider
// (one shared socket — never a subscription of this component's own);
// per-name style/colour/public badge state from /api/overlay/credit-styles (never
// the account's Matrix id — the badges come drawn through the chat's own order), fetched
// once per unseen name and cached for the page's life (a style change mid-
// stream shows on the next page load — OBS refreshes the source on scene
// switch, which is often enough for a cosmetic).
//
// Layout mirrors credit.html: a 700px design space anchored bottom-left,
// scaled to the source width (min 4x), so the source sizes the same way. The
// type inside that space is set at 2x so it stays sharp by default: on OBS's
// default 800x600 browser source the name renders ~70px tall, and shrinking
// the source in the scene keeps that density. Widening the source scales
// everything up with it (the fit), so a very long name can run past the edge
// of a narrow source — widen the source.
const DESIGN_W = 700;

type NameStyle = { usernameColor: string | null; usernameStyle: EquippedStyle | null; badges: BadgeUserState | null };

export function CreditOverlay() {
  const sponsors = useSponsorClock();
  const badgeState = useBadges();
  const list = useMemo(() => deriveCreditList(sponsors), [sponsors]);

  // The rotation reads the LATEST list at each step (a ref, written in an
  // effect — never during render), but never swaps mid-dwell: a pool update
  // on the 15s heartbeat must not cut a name short.
  const listRef = useRef<CreditEntry[]>([]);
  useEffect(() => { listRef.current = list; }, [list]);
  const hasList = list.length > 0;
  const [current, setCurrent] = useState<CreditEntry | null>(null);
  const [shown, setShown] = useState(false);
  const idxRef = useRef(0);

  // The cycle starts when the pool goes empty -> non-empty and stops when it
  // empties (the render below shows nothing while `hasList` is false, so no
  // state needs clearing). Every setState here runs inside a timer or rAF
  // callback, never in the effect body itself.
  useEffect(() => {
    if (!hasList) return;
    let dwell: ReturnType<typeof setTimeout> | null = null;
    let fade: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    idxRef.current = 0;
    function step() {
      if (!alive) return;
      const l = listRef.current;
      if (!l.length) return;
      if (idxRef.current >= l.length) idxRef.current = 0;
      const entry = l[idxRef.current]!;
      setCurrent(entry);
      // one frame hidden, then shown — forces the fade-in even on a same-name repeat
      setShown(false);
      requestAnimationFrame(() => { if (alive) setShown(true); });
      dwell = setTimeout(() => {
        setShown(false);
        fade = setTimeout(() => { idxRef.current += 1; step(); }, FADE_MS);
      }, entry.dwellMs);
    }
    const kick = setTimeout(step, 0);
    return () => { alive = false; clearTimeout(kick); if (dwell) clearTimeout(dwell); if (fade) clearTimeout(fade); };
  }, [hasList]);

  // ── per-name style lookup, cached for the page's life ───────────────────
  const [styles, setStyles] = useState<Record<string, NameStyle | null>>({});
  const knownRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const want = namesNeedingStyle(list, knownRef.current);
    if (!want.length) return;
    for (const k of want) knownRef.current.add(k); // mark in-flight so a heartbeat doesn't re-ask
    let cancelled = false;
    fetch(`/api/overlay/credit-styles?names=${encodeURIComponent(want.join(","))}`)
      .then((r) => {
        // A non-ok answer is a FAILED lookup, not "no style". Treating it as
        // "no style" would leave every name in `knownRef` unstyled for the
        // page's life — the first fetch covers the whole pool in one call, so
        // one blip (a web restart while OBS loads the source) would render
        // every sponsor plain until the next page load.
        if (!r.ok) throw new Error(`credit-styles ${r.status}`);
        return r.json();
      })
      .then((d: { styles?: Record<string, NameStyle> }) => {
        if (cancelled) return;
        setStyles((prev) => {
          const next = { ...prev };
          for (const k of want) next[k] = d.styles?.[k] ?? null;
          return next;
        });
      })
      .catch(() => {
        // Un-mark so the next frame asks again; plain names until then.
        for (const k of want) knownRef.current.delete(k);
      });
    return () => { cancelled = true; };
  }, [list]);

  // ── fit to the source width, credit.html's scale(min(4, fit)) ──────────
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const fit = () => setScale(Math.min(4, (window.innerWidth - 80) / DESIGN_W));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // Measured side room for the styled name (see nameInk.ts). Before the
  // early return — it is a hook. `current` may be null here; the ref then does nothing.
  const creditName = current?.name ?? "";
  const nameInkRef = useNameInk(current ? styles[creditName.toLowerCase()]?.usernameStyle?.font : null, creditName);
  // Fenced like every styled name (animFence); an OBS source on screen is always "seen".
  const nameRef = useAnimFenceRef(usernameStyleAnimClass(current ? styles[creditName.toLowerCase()]?.usernameStyle : null) !== "", nameInkRef);

  if (!hasList || !current) return null;
  const st = styles[current.name.toLowerCase()] ?? null;
  // The route sends the name's public badge state, not an id: read it through the same order
  // chat uses, under a key that is never a real id.
  const badges = st?.badges ? badgesForMatrixId({ ...badgeState, perUser: { credit: st.badges } }, "credit") : [];

  return (
    <div
      style={{ position: "absolute", left: 40, bottom: 40, width: DESIGN_W, transform: `scale(${scale})`, transformOrigin: "bottom left" }}
    >
      <span
        style={{ display: "block", marginBottom: 16, fontSize: 30, fontWeight: 700, letterSpacing: ".14em",
                 textTransform: "uppercase", color: "rgba(255,255,255,.92)",
                 textShadow: "0 2px 3px rgba(0,0,0,.9), 0 0 6px rgba(0,0,0,.55)" }}
      >
        this stream is made possible by
      </span>
      <div
        style={{ height: 88, display: "flex", alignItems: "baseline", gap: 16, fontSize: 68, fontWeight: 700,
                 whiteSpace: "nowrap", opacity: shown ? 1 : 0, transition: `opacity ${FADE_MS}ms ease` }}
      >
        {badges.length > 0 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 12, alignSelf: "center" }}>
            {badges.map((b) => (
              <img key={b.id} src={b.imageUrl} alt={b.name} title={b.name}
                   style={{ height: "1.1em", width: "auto", display: "inline-block" }} />
            ))}
          </span>
        )}
        <span>
          <span
            ref={nameRef}
            className={usernameStyleAnimClass(st?.usernameStyle)}
            style={{ color: st?.usernameColor ?? "#99c1f1", filter: "drop-shadow(0 2px 4px rgba(0,0,0,.7))",
                     ...usernameStyleCSS(st?.usernameStyle, st?.usernameColor) }}
          >
            {current.name}
          </span>
          <SponsorClockBadge username={current.name} />
        </span>
      </div>
    </div>
  );
}
