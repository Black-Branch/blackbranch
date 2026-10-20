"use client";

// Page-presentation windows are MODAL: the app shell
// goes inert while ≥1 is open. Counted, because the account card and the mod
// window can stack. This is NOT the "occluded-but-focusable" park — that
// is a partially visible live list, where inert-ing is wrong; here the app
// is fully covered, where inert is the standard (M3: a full-screen dialog
// disables the app behind it).

let holds = 0;

function shell(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.getElementById("app-shell");
}

export function acquireShellInert(): () => void {
  holds += 1;
  shell()?.setAttribute("inert", "");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    if (holds === 0) shell()?.removeAttribute("inert");
  };
}

/**
 * Counted `inert` over every CURRENT sibling of `layerEl` inside its parent —
 * the panel window's task-kind modality: the covered body region
 * (scroll layer, pinned banner, jump pill) goes dead while the composer,
 * which is OUTSIDE the body wrapper, stays live. Counted so stacked task
 * windows (account card over mod tools) release correctly.
 */
const siblingCounts = new WeakMap<Element, number>();
export function acquireSiblingInert(layerEl: HTMLElement): () => void {
  // `.children` (not `.childNodes`) already yields only Element siblings, so
  // no `instanceof HTMLElement` narrowing is needed — and a bare reference to
  // that global would throw in the node:test harness, which never installs
  // it (testDom.ts sets up `window`/`document` only). `setAttribute` and
  // `removeAttribute` are Element methods, not HTMLElement-specific.
  const sibs = Array.from(layerEl.parentElement?.children ?? []).filter((c) => c !== layerEl);
  for (const s of sibs) {
    const n = siblingCounts.get(s) ?? 0;
    siblingCounts.set(s, n + 1);
    if (n === 0) s.setAttribute("inert", "");
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const s of sibs) {
      const n = (siblingCounts.get(s) ?? 1) - 1;
      siblingCounts.set(s, n);
      if (n <= 0) { s.removeAttribute("inert"); siblingCounts.delete(s); }
    }
  };
}
