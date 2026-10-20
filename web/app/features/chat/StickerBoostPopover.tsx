"use client";

import { useState, useRef, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { useOutsideClick } from "@/app/lib/useOutsideClick";
import { keepFocus } from "@/app/lib/keepFocus";
import { clampIntoSpan, visibleViewport } from "@/app/lib/visibleViewport";
import PointsIcon from "@/app/components/PointsIcon";
import { STICKER_BOOST_CAP } from "@/app/lib/coins";
import { currencyName } from "@/app/lib/currency";
import { useItemPrice } from "@/app/lib/useStorePrices";

// ─── Sticker boost popover ─────────────────────────────────────────────────
// Anchored fixed-position confirm, same portal + outside-click pattern as
// ContextMenu above. STICKER_BOOST_CAP is only a SIZE ceiling (stickerBoostScale
// saturates there) — it's used here purely as a sane per-click stepper max, not
// a spend limit; boosting past it still charges in full, it just stops growing.

export function StickerBoostPopover({
  x, y, onConfirm, onClose,
}: {
  x: number; y: number;
  onConfirm: (amount: number) => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The floor is also the stepper's increment, and it comes from the table —
  // there is no constant to fall back on, because a stepper seeded at a guessed
  // floor would offer a boost the server then rejects as bad_amount.
  //
  // The chosen amount is DERIVED rather than seeded by an effect: `chosen` is
  // null until the viewer touches the stepper, so the displayed amount tracks
  // the floor until then and cannot be left stale at a price that has moved.
  const step = useItemPrice("sticker_boost");
  const [chosen, setChosen] = useState<number | null>(null);
  const amount = chosen ?? step;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useOutsideClick(ref, onClose, { escape: true });

  const popW = 220;
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  // Measured, not a GUESSED height against the LAYOUT viewport: a guess is
  // wrong the moment an error line appears, and the layout viewport is wrong
  // while the soft keyboard stays up — a boost tapped on a low sticker would be
  // clamped into the keyboard's strip and hidden behind it. Measured like
  // ContextMenu, and against the region that is actually visible. Re-measures
  // every render for the same reason ContextMenu does (the error line changes
  // the height); the equality guard is what stops the update loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- no dep array ON PURPOSE (see above): the error line changes the popover's height without x/y changing, so the [x, y] the rule suggests would miss the re-measure. The setPos equality guard, not the dep list, is what stops the update loop
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const vp = visibleViewport();
    const r = el.getBoundingClientRect();
    const left = clampIntoSpan(x, r.width, vp.left, vp.width);
    const top = clampIntoSpan(y, r.height, vp.top, vp.height);
    setPos((p) => (p.left === left && p.top === top ? p : { left, top }));
  });

  const confirm = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (amount === null) return;
      await onConfirm(amount);
      onClose();
    } catch (e) {
      // postJsonOrThrow surfaces the server's { error } CODE as the message —
      // translate the two boost codes; anything else is already a sentence.
      // unconfirmed ≠ failed: the boost may have landed and was NOT
      // refunded — "nothing was charged" would be a lie there
      // (chatEventDelivery.ts).
      const raw = e instanceof Error ? e.message : "";
      setError(
        raw === "boost_unconfirmed"
          ? "Couldn't confirm that went through — if the boost never appeared, ask a mod for a refund."
          : raw === "boost_failed"
            ? "Boost failed — nothing was charged."
            : raw || "Boost failed");
      setBusy(false);
    }
  }, [amount, onConfirm, onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      // A React child of the row even though it portals: a click on its
      // padding bubbles to the row, and the owner's row click picks the
      // highlight (chatSpotlight.ts) — this marks it as a panel, not the row.
      data-chat-panel=""
      className="fixed z-(--z-menu) glass rounded-lg p-3 text-sm text-body"
      style={{ left: pos.left, top: pos.top, width: popW }}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <button
          type="button"
          className="w-7 h-7 rounded bg-surface-2 hover:bg-surface-3 disabled:opacity-40 transition-colors"
          disabled={busy || step === null || amount === null || amount <= step}
          onClick={() => { if (step !== null && amount !== null) setChosen(Math.max(step, amount - step)); }}
          onMouseDown={keepFocus}
        >
          −
        </button>
        <span className="flex items-center gap-1 font-medium">
          <PointsIcon /> {amount ?? "\u2014"}
        </span>
        <button
          type="button"
          className="w-7 h-7 rounded bg-surface-2 hover:bg-surface-3 disabled:opacity-40 transition-colors"
          disabled={busy || step === null || amount === null || amount >= STICKER_BOOST_CAP}
          onClick={() => { if (step !== null && amount !== null) setChosen(Math.min(STICKER_BOOST_CAP, amount + step)); }}
          onMouseDown={keepFocus}
        >
          +
        </button>
      </div>
      {error && <div role="alert" className="text-red-300 text-xs mb-2">{error}</div>}
      <button
        type="button"
        disabled={busy || amount === null}
        onClick={confirm}
        onMouseDown={keepFocus}
        className="w-full py-1.5 rounded bg-emerald-600/80 hover:bg-emerald-600 disabled:opacity-50 transition-colors text-strong font-medium"
      >
        {amount === null ? "Loading price\u2026" : `Boost for ${amount} ${currencyName(amount)}`}
      </button>
    </div>,
    document.body
  );
}
