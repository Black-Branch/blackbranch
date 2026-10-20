"use client";

import { useState, useEffect, useRef, type MouseEvent } from "react";
import { useLongPress } from "../lib/useLongPress";
import { collectLookSettings } from "../lib/settingsKeys";
import { isOverlayScope } from "../lib/settingsRegistry";
import { postJsonOrThrow } from "../lib/http";
import { useIsAdmin } from "../lib/useIsAdmin";
import { resolveSlot, slotTone, type Look } from "../lib/houseLooks";
import { PRESET_SLOTS, loadPresets, savePreset, clearPreset, loadHouseLooks, type Preset, type PresetMode } from "../lib/presetStore";

// Four preset slots. On the signed-in, non-overlay path these roam the
// account (site.setting_presets) — save on desktop, apply on phone. Each
// stores a full settings snapshot (the same blob shape synced to the
// active-config DB row); apply restores it.
//
// House looks (site.house_looks): four site-wide looks that fill any slot the
// viewer has not saved into. The viewer's own look always wins; clearing it
// brings the house look back. An admin publishes a house look from their own
// slot ("Make house look").
//
// The "ov:" scope (/chat window, /overlay/chat OBS source) is device-local by design and keeps the
// localStorage-only behavior — never touches the account, and gets no house
// looks (a site look would set things those trimmed pages don't show).
// Signed-out users (no session / 401) get the same local fallback, plus house looks.
//
// The store itself — account vs browser, the one-time import, save, clear, the
// house looks — is app/lib/presetStore.ts, shared with the terminal's
// presets folder. This file is the buttons.

const LONG_PRESS_MS = 550;

export function PresetSlots({ onApply, appliedSlot = null, editedFrom = null, onSaved, onCleared }: {
  onApply: (blob: Record<string, string>, slot?: number) => void;
  /** The slot whose look the current settings ARE (solid "selected" fill), or
   *  null. Owned by ChatSettings — only it sees both a preset landing and a
   *  single setting moving. */
  appliedSlot?: number | null;
  /** The slot the viewer picked and has changed since (outline + dot; its save
   *  button lights up). Never the same render as appliedSlot. */
  editedFrom?: number | null;
  /** The current settings were just saved into slot n. */
  onSaved: (n: number) => void;
  /** The viewer's own look in slot n was removed. */
  onCleared: (n: number) => void;
}) {
  // "local": overlay scope, signed-out, or offline — localStorage is the store.
  // "account": signed-in, non-overlay — site.setting_presets is the store.
  const [mode, setMode] = useState<"loading" | PresetMode>(
    isOverlayScope() ? "local" : "loading"
  );
  // Which store a save or clear goes to while the account's slots are still loading: the browser's.
  const store = (): PresetMode => (mode === "account" ? "account" : "local");
  // Surfaced under the slots. See the comment in save() — a silent failure here
  // is indistinguishable from a broken button.
  const [saveError, setSaveError] = useState<string | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [house, setHouse] = useState<Record<number, Look>>({});
  // The slot whose action strip (rename / clear / publish) is open.
  const [menuSlot, setMenuSlot] = useState<number | null>(null);
  const isAdmin = useIsAdmin();

  useEffect(() => {
    let cancelled = false;
    loadPresets().then((loaded) => {
      if (cancelled) return;
      setPresets(loaded.presets);
      setMode(loaded.mode);
    });
    return () => { cancelled = true; };
  }, []);

  // House looks — public, so signed-out viewers get them too. A failed fetch just
  // leaves the empty slots empty.
  useEffect(() => {
    if (isOverlayScope()) return;
    let cancelled = false;
    loadHouseLooks().then((byslot) => { if (!cancelled) setHouse(byslot); });
    return () => { cancelled = true; };
  }, []);

  const presetFor = (n: number) => presets.find(p => p.slot === n);
  // Nothing until the account's own looks have loaded: a house look shown in the
  // meantime could be tapped over the viewer's own.
  const houseFor = (n: number): Look | null => (mode === "loading" ? null : house[n] ?? null);
  // The viewer's own look in slot n (a browser-saved one carries no name).
  const ownLook = (n: number): Look | null => presetFor(n) ?? null;
  const viewFor = (n: number) => resolveSlot(ownLook(n), houseFor(n));

  const save = async (n: number) => {
    try {
      setSaveError(null);
      const preset = await savePreset(store(), n, collectLookSettings());
      setPresets(prev => [...prev.filter(p => p.slot !== n), preset]);
      onSaved(n);
    } catch (e) {
      // Never `catch { /* best effort */ }`: if the PUT fails, setPresets never
      // runs, the slot stays grey, and nothing anywhere says why. A
      // user-initiated save must never swallow its own failure — the whole
      // point of pressing the button is to be told whether it worked.
      setSaveError(
        `Couldn't save preset ${n}. ${e instanceof Error ? e.message : ""}`.trim()
      );
    }
  };

  const apply = (n: number) => {
    // Your own look first, else the house look filling the slot (resolveSlot's order).
    const view = viewFor(n);
    if (view.settings) onApply(view.settings, n);
  };

  const rename = async (n: number) => {
    if (mode !== "account") return; // local presets have no name field
    const preset = presetFor(n);
    if (!preset) return;
    const next = window.prompt("Rename preset", preset.name ?? `Preset ${n}`);
    if (next == null) return; // cancelled
    const name = next.trim().slice(0, 40);
    try {
      const updated = await savePreset("account", n, preset.settings, name);
      setPresets(prev => [...prev.filter(p => p.slot !== n), updated]);
    } catch { /* best effort */ }
  };

  // Remove the viewer's own look in slot n; the house look under it (if any)
  // shows again. The local copy goes too, or the account import above would
  // re-upload it on the next open.
  const clear = async (n: number) => {
    setSaveError(null);
    try {
      await clearPreset(store(), n);
    } catch (e) {
      setSaveError(`Couldn't clear preset ${n}. ${e instanceof Error ? e.message : ""}`.trim());
      return;
    }
    setPresets(prev => prev.filter(p => p.slot !== n));
    onCleared(n);
    setMenuSlot(null);
  };

  const publish = async (n: number) => {
    const preset = presetFor(n);
    if (!preset) return;
    setSaveError(null);
    try {
      const { look } = await postJsonOrThrow<{ look: Look }>(
        "/api/house-looks", { slot: n, name: preset.name, settings: preset.settings }, "PUT"
      );
      setHouse(prev => ({ ...prev, [n]: look }));
      setMenuSlot(null);
    } catch (e) {
      setSaveError(`Couldn't publish house look ${n}. ${e instanceof Error ? e.message : ""}`.trim());
    }
  };

  const unpublish = async (n: number) => {
    setSaveError(null);
    try {
      await postJsonOrThrow(`/api/house-looks?slot=${n}`, undefined, "DELETE");
      setHouse(prev => { const next = { ...prev }; delete next[n]; return next; });
      setMenuSlot(null);
    } catch (e) {
      setSaveError(`Couldn't remove house look ${n}. ${e instanceof Error ? e.message : ""}`.trim());
    }
  };

  const canPublish = mode === "account" && isAdmin === true;
  // A slot's strip opens only when it has something to offer: your own look
  // (rename / clear) or, for an admin, a house look to remove.
  const hasActions = (n: number) => viewFor(n).kind === "own" || (canPublish && !!house[n]);
  const openMenu = (n: number) => setMenuSlot(prev => (prev === n ? null : n));

  const slotLabel = (n: number) => viewFor(n).name || String(n);

  // Long-press (touch) / right-click (desktop) → the slot's action strip. One
  // shared hook instance since only one slot can be mid-press at a time; the
  // pressed slot rides a ref. moveTolerance 0: ANY movement cancels, so a
  // scroll-start never opens it.
  const pressedSlot = useRef<number | null>(null);
  const longPress = useLongPress(() => {
    if (pressedSlot.current != null) openMenu(pressedSlot.current);
  }, LONG_PRESS_MS, 0);
  const handleTouchStart = (e: React.TouchEvent, n: number) => {
    if (!hasActions(n)) return;
    longPress.onTouchEnd(); // clear any prior press — single shared timer
    pressedSlot.current = n;
    longPress.onTouchStart(e);
  };
  const handleContextMenu = (e: MouseEvent, n: number) => {
    if (!hasActions(n)) return;
    e.preventDefault();
    openMenu(n);
  };

  const menu = menuSlot != null && hasActions(menuSlot) ? { n: menuSlot, view: viewFor(menuSlot) } : null;
  const stripBtn = "px-2 py-0.5 rounded text-2xs bg-surface-1 hover:bg-surface-3 border border-edge text-body-dim transition-colors";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <span className="w-16 text-3xs text-muted shrink-0">Presets</span>
        {PRESET_SLOTS.map(n => {
          const view = viewFor(n);
          return (
            <button
              key={n}
              type="button"
              disabled={view.kind === "empty"}
              onClick={() => apply(n)}
              onContextMenu={(e) => handleContextMenu(e, n)}
              onTouchStart={(e) => handleTouchStart(e, n)}
              onTouchEnd={longPress.onTouchEnd}
              onTouchMove={longPress.onTouchMove}
              // Wired explicitly because this call site does NOT spread
              // `{...longPress}` (it wraps onTouchStart to record which slot).
              // Without it an OS-claimed gesture leaves the timer armed and opens
              // the strip out of a gesture the OS took over.
              onTouchCancel={longPress.onTouchCancel}
              title={
                view.kind === "empty"
                  ? `Preset ${n} (empty)`
                  : `${view.kind === "house" ? "House look" : "Your preset"} ${n}${view.name ? ` (${view.name})` : ""}` +
                    (editedFrom === n ? " — changed since you picked it" : "") +
                    (hasActions(n) ? " — long-press/right-click for options" : "")
              }
              // Four looks, and the step between each has to be visible: house
              // (neutral), yours (accent tint), selected (light fill — never the
              // accent), edited (your pick, outlined). See houseLooks.ts.
              className={`flex-1 min-w-0 py-1 px-1 rounded text-xs transition-colors ${slotTone(view.kind, appliedSlot === n, editedFrom === n)}`}
            >
              <span className="flex items-center justify-center gap-1 min-w-0">
                {view.kind === "house" && (
                  <svg aria-hidden viewBox="0 0 12 12" className="w-2.5 h-2.5 shrink-0 fill-current opacity-70">
                    <path d="M6 1 1 5.5h1.5V11h3V8h1v3h3V5.5H11z" />
                  </svg>
                )}
                <span className="truncate">{slotLabel(n)}</span>
                {editedFrom === n && <span aria-label="changed" className="shrink-0">•</span>}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-1">
        <span className="w-16 text-3xs text-muted shrink-0">Save current</span>
        {PRESET_SLOTS.map(n => {
          const mine = viewFor(n).kind === "own";
          return (
            <button
              key={n}
              type="button"
              onClick={() => save(n)}
              title={
                editedFrom === n
                  ? `Save your changes into preset ${n}`
                  : mine ? `Overwrite preset ${n} with current settings` : `Save current settings to preset ${n}`
              }
              className={`flex-1 py-0.5 rounded text-2xs border transition-colors ${
                editedFrom === n
                  ? "bg-accent/30 border-accent text-strong hover:bg-accent/45"
                  : "bg-surface-1 hover:bg-surface-3 border-edge text-body-dim"
              }`}
            >
              {mine ? `↻${n}` : `+${n}`}
            </button>
          );
        })}
      </div>
      {menu && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="w-16 text-3xs text-muted shrink-0">Preset {menu.n}</span>
          {mode === "account" && menu.view.kind === "own" && (
            <button type="button" className={stripBtn} onClick={() => { setMenuSlot(null); rename(menu.n); }}>Rename</button>
          )}
          {menu.view.kind === "own" && (
            <button type="button" className={stripBtn} onClick={() => clear(menu.n)}>
              {menu.view.houseBehind ? "Restore house look" : "Clear"}
            </button>
          )}
          {canPublish && menu.view.kind === "own" && (
            <button type="button" className={stripBtn} onClick={() => publish(menu.n)}>Make house look</button>
          )}
          {canPublish && house[menu.n] && (
            <button type="button" className={stripBtn} onClick={() => unpublish(menu.n)}>Remove house look</button>
          )}
          <button type="button" aria-label="Close" className={`${stripBtn} ml-auto`} onClick={() => setMenuSlot(null)}>×</button>
        </div>
      )}
      {saveError && (
        <p role="status" className="text-3xs text-red-400 leading-snug">{saveError}</p>
      )}
    </div>
  );
}
