"use client";

import { useState, useEffect, useRef } from "react";

// A pane's OWN width (ResizeObserver), for layouts that must answer to the
// space they are given rather than to the viewport: the community panel's
// capacity model (panelLayout.tsx) and the Forums tab's side-by-side / drill-in
// thread choice. Moved out of features/community so the Forums feature can
// share it without reaching past that feature's index.
export function useContainerWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}
