"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback, type RefObject } from "react";
import type { EmoteInfo, EmoteMap } from "@/app/lib/useEmotes";
import { useOutsideClick } from "@/app/lib/useOutsideClick";
import { keepFocus } from "@/app/lib/keepFocus";
import { getRecentEmotes, saveRecentEmote } from "@/app/lib/recentEmotes";
import { mergeForInput } from "@/app/lib/personalEmotes";
import { useEmoteChannelName } from "@/app/lib/useEmoteMeta";
import { buildPickerData, type PickerCategory } from "@/app/lib/emotePickerSections";
import { ComposerPopover } from "./ComposerPopover";
import { Chips } from "@/app/components/chrome";
import { useSetting } from "@/app/lib/useSetting";
import { PICKER_EAGER, pickerTileSrc } from "@/app/lib/emotePickerWarm";
import { emoteCrossOrigin } from "@/app/lib/emoteRes";

// Look-ahead for tiles past the eager first screens: one scroller-height above,
// two below (a picker opens at the top and is scrolled DOWN) — an image starts
// loading two screens before it can be seen.
const LOOKAHEAD = "100% 0px 200% 0px";

const CATEGORY_LABELS: Record<PickerCategory, string> = {
  all:    "All",
  "7tv":  "7TV",
  bttv:   "BTTV",
  twitch: "Twitch",
  ffz:    "FFZ",
  mine:   "Mine",
};

// Frecency store shared with the completion ranking — see lib/recentEmotes.
const getRecent = getRecentEmotes;
const saveRecent = saveRecentEmote;

// Stable default so a signed-out / no-personal-emotes render doesn't churn the
// buildPickerData memo's dep array with a fresh {} every render.
const NO_PERSONAL: EmoteMap = {};

/**
 * A ref callback for picker tiles past the eager screens: when a tile comes within
 * LOOKAHEAD of the scroller's viewport its <img> gets its src (from data-src) and
 * stays loaded while the picker is open. Observes the BUTTON, not the img — the
 * button is the content-visibility container and always has a laid-out box.
 */
function useLookahead(rootRef: RefObject<HTMLDivElement | null>): (el: HTMLButtonElement | null) => void {
  const ioRef = useRef<IntersectionObserver | null>(null);
  const pending = useRef(new Set<HTMLButtonElement>());
  useEffect(() => {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const img = (e.target as HTMLElement).querySelector("img");
        if (img && !img.getAttribute("src") && img.dataset.src) img.src = img.dataset.src;
        io.unobserve(e.target);
      }
    }, { root: rootRef.current, rootMargin: LOOKAHEAD });
    ioRef.current = io;
    for (const el of pending.current) io.observe(el);
    pending.current.clear();
    return () => { io.disconnect(); ioRef.current = null; };
  }, [rootRef]);
  return useCallback((el: HTMLButtonElement | null) => {
    if (!el) return;
    if (ioRef.current) ioRef.current.observe(el); else pending.current.add(el);
  }, []);
}

export default function EmotePicker({
  emotes,
  personal = NO_PERSONAL,
  personalNeedsRelink = false,
  onSelect,
  onClose,
  anchorRef,
}: {
  /** The site catalog — NOT the merged input map (see emotePickerSections). */
  emotes: EmoteMap;
  /** The signed-in user's own Twitch emotes, unmerged. */
  personal?: EmoteMap;
  /** Twitch is linked but predates the emote-read scope — shows the re-link nudge. */
  personalNeedsRelink?: boolean;
  onSelect: (name: string) => void;
  onClose: () => void;
  /** The control it hangs off. Portalled, so no ancestor can clip it — see
   *  ComposerPopover for why measuring-and-shrinking was not enough. */
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const [tab, setTab] = useState<PickerCategory>("all");
  const [search, setSearch] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Microtask defer keeps the localStorage-derived setState out of the effect pass.
  // Existence-checked against BOTH maps: a personal-only name can enter the
  // shared frecency store via typed autocomplete (useEmoteAutocomplete checks
  // its MERGED map before recording a use), so checking the catalog alone would
  // silently drop it back out of "Frequent" here.
  useEffect(() => {
    Promise.resolve().then(() => setRecent(getRecent(mergeForInput(emotes, personal))));
  }, [emotes, personal]);

  // Focus the search box as soon as the picker opens (a paste is the common
  // way in, so landing on <body> would cost an extra click every time).
  // Depends on ComposerPopover mounting its children in the FIRST commit and
  // hiding an unplaced popover with `opacity` rather than `visibility`; either
  // change silently breaks this. Read the note there first.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Close on outside click / Escape. The ANCHOR counts as inside: a press on
  // the toggle button is a mousedown (which would close the picker here)
  // followed by a click (which the button's own toggle would then re-open), so
  // the button could never close it. Listing the anchor lets the button's click
  // be the only thing that decides.
  useOutsideClick([ref, anchorRef], onClose, { escape: true, touch: false });

  // Sections/tabs, headless and unit-tested — see emotePickerSections.ts.
  // `emotes` here MUST stay the raw site catalog (never merged with
  // `personal`): buildPickerData's own "Your emotes"/"mine" detection is a
  // set-difference against it, and a pre-merged map would make every personal
  // name look already-present and permanently hide the section.
  const channelLabel = useEmoteChannelName();
  const { sections, tabs } = useMemo(
    () => buildPickerData({ emotes, personal, recent, tab, search, channelLabel }),
    [emotes, personal, recent, tab, search, channelLabel],
  );

  // Grid thumbnails draw 32 CSS px. pickerTileSrc sizes for THIS screen's device
  // pixels (never below — upscaled 28-32px natives are blurry on hi-DPI) and
  // takes the chat's rung when that is bigger, so at default settings a
  // tile is the very file the warmer already cached for chat. Animated emotes off →
  // the still frame here too (the switch says "don't animate").
  const still = useSetting("chatStyle_animEmotes") === "0";
  const scrollerRef = useRef<HTMLDivElement>(null);
  const lookahead = useLookahead(scrollerRef);
  const providerItems = tabs.map((t) => ({ key: t, label: CATEGORY_LABELS[t] }));

  const isEmpty = sections.every((s) => s.items.length === 0);
  // Running tile index across sections: the first PICKER_EAGER render with their
  // image at once (the intent preload already decoded them); the rest look ahead.
  let tileIndex = 0;

  function handleSelect(name: string) {
    // Record frecency but DON'T re-rank the open grid — reshuffling here would
    // pull the just-clicked emote into the "Frequent" section and out from under
    // the cursor. The picker re-mounts fresh each open, so Frequent is current
    // next time; the list stays stable while open.
    saveRecent(name);
    onSelect(name);
  }

  // Portalled to <body>: the composer sits in an `overflow: hidden` column, so
  // an in-place `absolute bottom-full` popover taller than the space above the
  // field would be cut off from the top, search box included.
  // ComposerPopover owns the position/height maths against `visualViewport`.
  // `track`: the composer settles after keyboard open/close on the lifted
  // panel's OWN transform transition (`useKeyboardLift`), which finishes with
  // NO viewport event — without per-frame tracking the picker would stay
  // wherever the last event left it, detached from the composer.
  return (
    <ComposerPopover anchorRef={anchorRef} width={280} maxHeight={320} track>
    <div ref={ref} className="flex flex-col min-h-0">
      {/* Search */}
      <div className="px-2 pt-2 pb-1 shrink-0">
        <input
          ref={searchRef}
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search emotes…"
          aria-label="Search emotes"
          className="w-full bg-surface-2 border border-edge text-strong placeholder-muted text-xs rounded px-2 py-1 outline-none focus:ring-1 focus:ring-edge-strong"
        />
      </div>

      {/* Provider filters. onItemMouseDown={keepFocus} so switching provider leaves
          the picker's own search box focused. */}
      <div className="border-b border-edge shrink-0">
        <Chips items={providerItems} value={tab} onChange={setTab} label="Emote providers" onItemMouseDown={keepFocus} />
      </div>

      {/* Sections — each a flex-wrap of fixed-HEIGHT / natural-WIDTH emotes (7TV
          style), so wide emotes keep their real aspect ratio and there are no shared
          column tracks for off-screen content-visibility cells to inflate (a fixed
          repeat(N,1fr) grid clipped its last column). Sections after the first get a
          divider so "Recent" reads as its own group above the main list. */}
      <div ref={scrollerRef} className="overflow-y-auto no-scrollbar p-1 flex-1">
        {isEmpty ? (
          <p className="text-muted text-xs text-center py-4">No results</p>
        ) : (
          sections.map((sec, si) =>
            sec.items.length === 0 ? null : (
              <div key={sec.key} className={si > 0 ? "mt-1 pt-1 border-t border-edge" : ""}>
                {sec.label && (
                  <div className="px-1 pb-1 text-3xs font-semibold uppercase tracking-wide text-muted">
                    {sec.label}
                  </div>
                )}
                <div className="flex flex-wrap gap-0.5 content-start">
                  {sec.items.map(([name, url]) => {
                    const info: Partial<EmoteInfo> & { url: string } = emotes[name] ?? personal[name] ?? { url };
                    const src = pickerTileSrc(info, still);
                    // The box the image will occupy, reserved before it loads: 32 px
                    // tall, as wide as its aspect ratio says (capped at 6rem, where
                    // object-contain letterboxes the widest), so no tile changes
                    // width when its image lands and nothing in the grid shifts.
                    const w = info.ar ? Math.min(32 * info.ar, 96) : 32;
                    const eager = tileIndex++ < PICKER_EAGER;
                    return (
                      <button
                        key={name}
                        type="button"
                        title={name}
                        ref={eager ? undefined : lookahead}
                        onMouseDown={e => { e.preventDefault(); handleSelect(name); }}
                        className="emote-cv shrink-0 p-0.5 rounded hover:bg-surface-3 transition-colors flex items-center justify-center"
                        // The off-screen (content-visibility) placeholder must be the
                        // tile's REAL size too, or wide tiles jump as they scroll in.
                        style={{ height: "2.25rem", containIntrinsicSize: `auto ${w + 4}px auto 36px` }}
                      >
                        <img
                          src={eager ? src : undefined}
                          crossOrigin={emoteCrossOrigin(src)}
                          fetchPriority={eager ? "high" : "auto"}
                          data-src={src}
                          alt={name}
                          decoding="async"
                          onLoad={(e) => { e.currentTarget.dataset.loaded = "1"; }}
                          className="emote-tile object-contain"
                          // color:transparent: an <img> waiting for its src would
                          // otherwise paint its alt text in the reserved box.
                          style={{ width: `${w}px`, height: "32px", maxWidth: "6rem", color: "transparent" }}
                        />
                      </button>
                    );
                  })}
                </div>
              </div>
            ),
          )
        )}
        {personalNeedsRelink && (
          <p className="px-1.5 pt-1 pb-0.5 text-3xs text-muted">
            Re-link Twitch (Profile → Accounts) to use your own Twitch emotes here.
          </p>
        )}
      </div>
    </div>
    </ComposerPopover>
  );
}
