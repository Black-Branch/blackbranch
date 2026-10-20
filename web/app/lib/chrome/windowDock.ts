"use client";
// Float or slide in. On a phone every tool
// window is a panel that slides up from the composer; on a computer it floats.
// This lets a computer slide a window into the chat column too: a default in
// Settings › Behavior › Windows, and a band button that switches ONE window and
// remembers it on this device.
//
// A window's own choice is stored with the default it was made under
// ("slide@float"). When the default changes, choices made under the old one no
// longer match and the default wins — so the setting always means "windows open
// like this", without a write that has to clear every window's key.
//
// The host still decides the presentation (Window never reads matchMedia); this
// is the one place that decision is made for the windows that float.
import { useState } from "react";
import { lsGet, lsSet } from "../safeLocalStorage";
import { useSetting } from "../useSetting";
import { getActiveTarget } from "./windowLayer";

const DOCK_DEFAULT_LS = "chatStyle_winDock";
type DockMode = "float" | "slide";
const savedKey = (id: string) => `bb_windock_${id}`;

/** What the band button needs: which way it points and how to flip it. */
export type WindowDock = { docked: boolean; toggle: () => void };

/** @test-only the truth table windowDock.render.test.ts walks; useWindowDock
 *  below, in this file, is its one production caller. */
export function resolveDock({ narrow, hasLayer, saved, def }: {
  narrow: boolean;
  /** Is there a chat column to slide into? Without one a panel falls back to
   *  a full-screen shape, which on a computer is not what anyone asked for. */
  hasLayer: boolean;
  saved: string | null;
  def: string | null;
}): { presentation: "panel" | "floating"; toggleable: boolean } {
  if (narrow) return { presentation: "panel", toggleable: false };
  if (!hasLayer) return { presentation: "floating", toggleable: false };
  const d: DockMode = def === "slide" ? "slide" : "float";
  const [mode, under] = (saved ?? "").split("@");
  const m = under === d && (mode === "slide" || mode === "float") ? mode : d;
  return { presentation: m === "slide" ? "panel" : "floating", toggleable: true };
}

export function useWindowDock(id: string, narrow: boolean): { presentation: "panel" | "floating"; dock?: WindowDock } {
  const def = useSetting(DOCK_DEFAULT_LS);
  const [saved, setSaved] = useState(() => lsGet(savedKey(id)));
  // Read at render, not subscribed: a window mounts when it opens, and the chat
  // column that registers the layer outlives it. A layer with no size is a
  // chat column folded away on a computer — the layer stays registered, and a
  // window slid into it would vanish.
  const layer = getActiveTarget();
  const hasLayer = !!layer && layer.offsetWidth > 0 && layer.offsetHeight > 0;
  const { presentation, toggleable } = resolveDock({ narrow, hasLayer, saved, def });
  if (!toggleable) return { presentation };
  const docked = presentation === "panel";
  return {
    presentation,
    dock: {
      docked,
      toggle: () => {
        const next = `${docked ? "float" : "slide"}@${def === "slide" ? "slide" : "float"}`;
        lsSet(savedKey(id), next);
        setSaved(next);
      },
    },
  };
}
