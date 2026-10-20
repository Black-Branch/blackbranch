import { useEffect } from "react";
import { cssColorLuma, setContrastRefLuma } from "./colors";

// Keep the username-contrast clamp (readableColor) pointed at the chat panel the
// user is actually looking at. Model B: the chat body is one flat tint,
// --panel-tint-body (possibly see-through over the page gradient); its own luma
// is the reference. Re-reads on `bb:settings-hydrated` — the same signal
// the rest of the app uses when the theme re-applies (see RadioPlayer's viz color).
// Mount this once on each surface that renders chat rows.
export function useChatBgContrastRef() {
  useEffect(() => {
    const refresh = () => {
      const cs = getComputedStyle(document.documentElement);
      // Model B: the chat body is one tint (possibly see-through over the page
      // gradient). The tint's own luma is the reference; see-through bodies sit
      // over a dark page, so this errs toward "dark background" — the safe side
      // for the clamp.
      const luma = cssColorLuma(cs.getPropertyValue("--panel-tint-body"));
      if (luma != null) setContrastRefLuma(luma);
    };
    refresh();
    window.addEventListener("bb:settings-hydrated", refresh);
    return () => window.removeEventListener("bb:settings-hydrated", refresh);
  }, []);
}
