import { useState, useRef } from "react";
import { postJson } from "./http";
import { setCoinBalance } from "./useCoinBalance";
import { stickerSendFailureCopy } from "./spendFailureCopy";
import { refreshStorePrices, useItemPrice } from "./useStorePrices";

// Sticker: pick IS the spend (price from site.store_prices, resolved +
// throttled server-side).
//
// `expectedPrice` is the price the viewer was actually shown, sent so the
// server can refuse rather than charge a number that moved between the render
// and the tap. `stickerPrice === null` means the table has not loaded — the
// send is refused HERE too, because a request without expectedPrice is a 400 by
// design and there is nothing useful to tell the viewer about it.
export function useStickerSend(setSendError: (msg: string | null) => void) {
  const stickerPrice = useItemPrice("sticker");
  const [stickerBusy, setStickerBusy] = useState(false);
  // Own timer ref, deliberately NOT sharing ChatInput's errorTimer — the React
  // Compiler's immutability check flags a ref as unsafe to mutate once it
  // sees it written from two separate closures (confirmed by trying it: the
  // compiler then also flags the other ref's original, unrelated call site).
  const stickerErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function armStickerError(msg: string) {
    setSendError(msg);
    if (stickerErrorTimer.current) clearTimeout(stickerErrorTimer.current);
    stickerErrorTimer.current = setTimeout(() => setSendError(null), 4000);
  }

  async function sendSticker(emoteName: string) {
    if (stickerBusy) return;
    if (stickerPrice === null) {
      // No fallback constant, ever: sending at a guessed price is the failure
      // the guard exists to prevent. Nudge the table instead.
      refreshStorePrices();
      armStickerError("Sticker price is still loading — try again in a moment.");
      return;
    }
    setStickerBusy(true);
    try {
      const res = await postJson("/api/points/spend/sticker", {
        emoteName, spendId: crypto.randomUUID(), expectedPrice: stickerPrice,
      });
      const d = (await res.json().catch(() => ({}))) as
        { balance?: number; error?: string; retryAfterSeconds?: number; price?: number };
      if (res.ok && typeof d.balance === "number") setCoinBalance(d.balance);
      if (!res.ok) {
        // 409: the price moved between the render and the tap. Pull the new
        // table so the composer re-renders with it, and say the number — the
        // viewer decides whether to send again, which is the whole point of
        // refusing rather than silently charging.
        if (res.status === 409) refreshStorePrices();
        // Copy decision is pure and tested (spendFailureCopy.test.ts) — only a
        // provable refusal may say "nothing was charged".
        armStickerError(stickerSendFailureCopy(res.status, d));
      }
    } catch {
      armStickerError("Network error — sticker not sent.");
    } finally {
      setStickerBusy(false);
    }
  }

  // stickerPrice rides along so the composer shows the same number this hook
  // will send as expectedPrice — one source, so the display and the charge
  // cannot disagree.
  return { stickerBusy, sendSticker, stickerPrice };
}
