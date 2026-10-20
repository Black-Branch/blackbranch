"use client";

import PointsIcon from "@/app/components/PointsIcon";
import { dispatchClaimable } from "@/app/lib/claimableEvent";
import { keepFocus } from "@/app/lib/keepFocus";
import { HIGHLIGHT_PRICE, TTS_PRICE, formatCoinsShort } from "@/app/lib/coins";
import { useItemPrice } from "@/app/lib/useStorePrices";

export type SpendMode = "highlight" | "tts";

const LABEL: Record<SpendMode, string> = {
  highlight: "Highlight",
  tts: "Read aloud",
};

type SpendChipProps = {
  mode: SpendMode;
  coinBalance: number | null;
  onCancel: () => void;
};

// Armed-spend chip. There is no amount picker: highlight and read-aloud are
// fixed prices. All this has to say is which product is armed, what it costs,
// and whether you can afford it.
export function SpendChip({ mode, coinBalance, onCancel }: SpendChipProps) {
  const fallback = mode === "highlight" ? HIGHLIGHT_PRICE : TTS_PRICE;
  const price = useItemPrice(mode) ?? fallback;
  const affordable = coinBalance === null || coinBalance >= price;

  return (
    <div data-chrome-grow className="mb-1 flex flex-wrap items-center gap-1.5 rounded border border-yellow-500/25 bg-yellow-500/[0.06] px-2 py-1 text-xs">
      <PointsIcon size="0.9em" className="shrink-0" />
      <span className="text-body">{LABEL[mode]}</span>
      <span className={affordable ? "text-secondary" : "text-red-400"}>{price}</span>
      {coinBalance !== null && !affordable ? (
        <>
          <span className="text-red-400">
            {price - coinBalance} short (balance {formatCoinsShort(coinBalance)})
          </span>
          {/* NO keepFocus here, and that is deliberate: this opens the
              store, which takes over the view. Holding the keyboard up would
              just park it on top of the panel the user asked to see — the
              second carve-out in keepFocus.ts. Everything else in this chip
              keeps it, because you come straight back to the message. */}
          <button
            type="button"
            // dispatchClaimable, not a bare CustomEvent: the hub's one-host
            // guard reads defaultPrevented, which only a cancelable event
            // carries (useUserMenuEvents.ts).
            onClick={() => { dispatchClaimable("bb:open-store", { tab: "topup" }); }}
            className="text-yellow-400 hover:text-yellow-300 font-medium"
          >
            Top up
          </button>
        </>
      ) : (
        coinBalance !== null && (
          <span className="text-muted">· balance {formatCoinsShort(coinBalance)}</span>
        )
      )}
      <button
        type="button"
        onClick={onCancel}
        onMouseDown={keepFocus}
        aria-label={`Cancel ${LABEL[mode].toLowerCase()}`}
        className="ml-auto rounded px-1 text-secondary transition-colors hover:text-body"
      >
        ✕
      </button>
    </div>
  );
}
