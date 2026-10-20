"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import BehaviorListPanel from "./BehaviorListPanel";
import { pullAccountSettings } from "../lib/accountSettings";
import { migrateSettingsBlob } from "../lib/settingsMigrate";
import { scheduleSettingsSave, flushSettingsSave, useSettingsSaveState } from "../lib/settingsSave";
import { emitChatNotice } from "../lib/chatNotice";
import {
  WEIGHTS, MIN_REM, MAX_REM,
  remToSlider, sliderToRem,
  DEFAULTS, ENTRIES, SETTING_KEYS, LOOK_KEYS,
  serializeValue, setValue, applyEffect, readValues, defaultFor,
  settingSet, isOverlayScope,
  type Values, type SettingKey, type ApplyCtx, type Control,
} from "../lib/settingsRegistry";
import {
  SECTIONS, filterMenuSections, overlaySections, type MenuItem, type MenuSection, type MenuTab,
} from "../lib/settingsMenu";
import { CHAT_CONSOLE } from "@/app/lib/plugins/chat";
import { lowPowerOn, lowPowerOff, lowPowerState } from "../lib/lowPower";
import { readPick, writePick, type Pick } from "../lib/settingsPick";
import { PresetSlots } from "./PresetSlots";
import { FontPicker } from "./FontPicker";
import { ColorInput, Slider, Toggle, Section, Row, Choice } from "./SettingsControls";

// A section a plugin part brings (the console's button) shows only when the install has it.
const INSTALLED_SECTIONS = SECTIONS.filter((sec) => sec.plugin !== "console" || !!CHAT_CONSOLE);

// The preset the viewer last picked, and whether they have changed anything
// since (house looks): app/lib/settingsPick.ts, shared with the
// terminal, which marks it edited when `set` moves a look setting.

// Visible = an item's showWhen (if any) passes for the current values.
function isItemVisible(item: MenuItem, values: Values): boolean {
  return item.type !== "setting" || !item.showWhen || item.showWhen(values);
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ChatPrefs({
  activeTab,
  search,
  overlayPage,
  onShowTimestampsChange,
  onShowMatrixNameChange,
  headerSlot,
}: {
  // Owned by the mounting panel. Optional so the standalone /chat window and
  // /overlay/chat source's shared mini-panel (OverlaySettingsPanel.tsx) can
  // keep rendering `<ChatPrefs overlayPage={…} />`: no activeTab means every
  // section (of the ones overlayPage allows) renders at once.
  activeTab?: MenuTab;
  /** Non-empty = search mode: matches from EVERY section, activeTab ignored
   *  (the appearance rail passes activeTab={undefined} alongside). */
  search?: string;
  /** Set by OverlaySettingsPanel for the /chat window and the OBS overlay:
   *  trims the menu to overlaySections(overlayPage) (neither page
   *  has bars, a panel body, a composer or site chrome) and hides badge
   *  authoring, which is a site-only admin tool. */
  overlayPage?: "window" | "obs";
  onShowTimestampsChange?: (v: boolean) => void;
  onShowMatrixNameChange?: (v: boolean) => void;
  /** Appearance window (round 2b): render the saved looks + Reset into this
   *  fixed row above the rail instead of inline, so they stay put while the
   *  list scrolls. State stays here; only the DOM home moves (portal). */
  headerSlot?: HTMLElement | null;
}) {
  const [values, setValues] = useState<Values>(DEFAULTS);
  const [confirmReset, setConfirmReset] = useState(false);
  // Which preset slot the CURRENT settings came from (edited: false), or the one
  // they came from before a control moved (edited: true). It lives here rather
  // than in PresetSlots because only this component sees both halves: applyBlob
  // (a preset landing) and applyKey (any single control moving). A child cannot
  // know it has been invalidated.
  // Declared with the other state, above applyKey — the compiler plugin
  // refuses a setter referenced before its declaration inside a useCallback.
  const [pick, setPick] = useState<Pick | null>(null);
  // Flips true once DB settings have been pulled + applied; gates the save effect
  // so opening the panel doesn't immediately re-save before hydration.
  const [hydrated, setHydrated] = useState(false);

  // valuesRef mirrors `values` so paired effects (e.g. rgba from color +
  // opacity) can read the latest partner value during apply/hydrate. Every
  // mutation path below writes it synchronously itself; this post-commit write
  // is only the safety net for externally-triggered renders.
  const valuesRef = useRef<Values>(values);
  // Latest-ref the parent callbacks so ctx stays stable.
  const cbRef = useRef({ onShowTimestampsChange, onShowMatrixNameChange });
  useEffect(() => {
    valuesRef.current = values;
    cbRef.current = { onShowTimestampsChange, onShowMatrixNameChange };
  });

  const ctx = useMemo<ApplyCtx>(() => ({
    get: (k) => valuesRef.current[k],
    onShowTimestamps: (v) => cbRef.current.onShowTimestampsChange?.(v),
    onShowMatrixName: (v) => cbRef.current.onShowMatrixNameChange?.(v),
  }), []);

  // Apply a single setting change: update state + valuesRef synchronously, persist
  // to localStorage, run the CSS/class side-effect.
  const applyKey = useCallback(<K extends SettingKey>(key: K, v: Values[K]) => {
    const next = { ...valuesRef.current, [key]: v };
    valuesRef.current = next;
    setValues(next);
    settingSet(ENTRIES[key].ls, serializeValue(key, v));
    applyEffect(key, v, ctx);
    // The settings no longer match the preset they came from. Marked on EVERY
    // single-control change, without comparing values: a preset is "in effect"
    // only until the user starts editing, and a slot still SELECTED after they
    // have moved a slider claims something untrue. It stays as the edited pick
    // (outline + dot) so one tap saves the change into it.
    setPick((p) => (p && !p.edited ? { ...p, edited: true } : p));
  }, [ctx]);

  // Hydrate: pull cross-device settings from the DB into localStorage FIRST, then
  // read the full value set out of localStorage and apply every effect. Same-device
  // the DB is a no-op; a failing fetch falls back to whatever's already local.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // pullAccountSettings() owns the overlay guard (the "ov:" scope, /chat
      // window + /overlay/chat OBS source, is device-local by design — never
      // pull/merge the account's DB settings there) and the v1→v2 conversion.
      await pullAccountSettings();
      if (cancelled) return;
      const fresh = readValues();
      valuesRef.current = fresh;
      setValues(fresh);
      for (const key of SETTING_KEYS) applyEffect(key, fresh[key], ctx);
      setPick(readPick());
      setHydrated(true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate exactly once: this pulls the saved settings from the DB and overwrites local state with them. Re-running on a `ctx` identity change would clobber whatever the user has adjusted since mount with the server's older copy
  }, []);

  // Save (debounced) to the DB whenever a setting changes, after hydration. The
  // blob is read straight from localStorage, which applyKey keeps current.
  // Closing the panel FLUSHES a pending save rather than cancelling it
  // (settingsSave.ts); a failed one stays offered as a retry below.
  const saveState = useSettingsSaveState();
  useEffect(() => {
    if (!hydrated || isOverlayScope()) return; // overlay = device-local, no DB sync
    scheduleSettingsSave();
  }, [hydrated, values]);
  useEffect(() => () => {
    void flushSettingsSave().then((ok) => {
      if (!ok) emitChatNotice("Couldn't save your settings to your account — open Appearance to retry.");
    });
  }, []);

  // Remember the pick per browser. Written only after hydration, or the first
  // render's null would erase the saved one before it is read back.
  useEffect(() => {
    if (!hydrated) return;
    writePick(pick);
  }, [hydrated, pick]);

  // Apply a saved snapshot blob (from a preset slot): write each known key to
  // localStorage, update state, run every effect. Keys absent from the blob keep
  // their current value (forward-compatible with presets saved before a setting
  // existed). setValues triggers the debounced DB save, so the applied preset
  // becomes the new synced active config.
  const applyBlob = useCallback((savedBlob: Record<string, string>, slot?: number) => {
    // A browser-saved preset (bb_preset_N / ov:bb_preset_N) never went
    // through the server's conversion, so a pre-update one still carries v1
    // keys — convert first or its panel colours/strengths silently drop.
    // Idempotent on an already-v2 blob.
    const blob = migrateSettingsBlob(savedBlob);
    setPick(slot ? { slot, edited: false } : null);
    const next = { ...valuesRef.current } as Values;
    // A look never carries Behavior — an old saved slot that has those keys
    // must not overwrite them either.
    for (const key of LOOK_KEYS) {
      const raw = blob[ENTRIES[key].ls];
      if (raw == null) continue;
      setValue(next, key, raw);
      settingSet(ENTRIES[key].ls, raw);
    }
    // Sync-only key with no registry control (read live by ChatMessage). The /chat window and
    // the OBS page show the account's colour, never a copy of their own, so a look applied
    // there leaves it alone.
    if (blob.chatUsernameColor != null && !isOverlayScope()) settingSet("chatUsernameColor", blob.chatUsernameColor);
    // A house look never carries Low power (houseLooks.ts), so the viewer's switch
    // stays on while the look's effects land on. Re-run Low power over the merged
    // values: the effects go into its memory and come back when it is turned off.
    if (blob[ENTRIES.lowPower.ls] == null && next.lowPower) {
      const lp = lowPowerOn(next as unknown as Record<string, unknown>);
      for (const k of Object.keys(lp) as SettingKey[]) {
        (next as unknown as Record<string, unknown>)[k] = lp[k];
        settingSet(ENTRIES[k].ls, serializeValue(k, next[k]));
      }
    }
    valuesRef.current = next;
    setValues(next);
    for (const key of SETTING_KEYS) applyEffect(key, next[key], ctx);
  }, [ctx]);

  function resetToDefaults() {
    // THIS device's defaults — DEFAULTS alone would write shadow ON for a phone.
    // Reset resets LOOKS only — Behavior keeps its values.
    const next = { ...valuesRef.current, ...Object.fromEntries(LOOK_KEYS.map((k) => [k, defaultFor(k)])) } as Values;
    valuesRef.current = next;
    setValues(next);
    for (const key of LOOK_KEYS) {
      settingSet(ENTRIES[key].ls, serializeValue(key, next[key]));
      applyEffect(key, next[key], ctx);
    }
  }

  // ─── render a single registry-driven control ────────────────────────────────
  function renderControl(key: SettingKey, control: Control) {
    switch (control.kind) {
      case "font":
        return (
          <Row key={key} label={control.label} wide>
            <FontPicker value={values[key] as string} onChange={v => applyKey(key, v as Values[SettingKey])} />
          </Row>
        );
      case "color": {
        const v = values[key] as string;
        const shown = v || (control.fallbackKey ? values[control.fallbackKey] as string : v);
        return (
          <Row key={key} label={control.label}>
            <ColorInput value={shown} onChange={c => applyKey(key, c as Values[SettingKey])} />
          </Row>
        );
      }
      case "toggle":
        return (
          <Row key={key} label={control.label}>
            <Toggle label={control.label} on={values[key] as boolean} onToggle={() => applyKey(key, !values[key] as Values[SettingKey])} />
          </Row>
        );
      case "weights":
        return (
          <Row key={key} label={control.label}>
            <Choice label={control.label} options={WEIGHTS} value={values[key] as number} onChange={v => applyKey(key, v as Values[SettingKey])} />
          </Row>
        );
      case "choice":
        return (
          <Row key={key} label={control.label}>
            <Choice label={control.label} options={control.options} value={values[key] as string} onChange={v => { applyKey(key, v as Values[SettingKey]); control.preview?.(v); }} />
          </Row>
        );
      case "lowPower": {
        if (key !== "lowPower") return null;
        const state = lowPowerState(values as unknown as Record<string, unknown>);
        return (
          <Row key={key} label={state === "some" ? "Low power (some on)" : control.label}>
            <Toggle
              label={control.label}
              on={state !== "off"}
              onToggle={() => {
                const changes = state === "off" ? lowPowerOn(values as unknown as Record<string, unknown>) : lowPowerOff(values as unknown as Record<string, unknown>);
                for (const [k, v] of Object.entries(changes)) applyKey(k as SettingKey, v as Values[SettingKey]);
              }}
            />
          </Row>
        );
      }
      case "slider": {
        const raw = values[key] as number;
        const edit = control.fontSize
          ? {
              value: Number(parseFloat(sliderToRem(raw)).toFixed(2)),
              unit: "rem",
              onCommit: (rem: number) => applyKey(key, remToSlider(Math.max(MIN_REM, Math.min(MAX_REM, rem))) as Values[SettingKey]),
            }
          : undefined;
        return (
          <Slider
            key={key}
            label={control.label}
            min={control.min}
            max={control.max}
            step={control.step}
            value={control.toSlider(raw)}
            onChange={n => applyKey(key, control.fromSlider(n) as Values[SettingKey])}
            display={control.display(raw)}
            title={control.title}
            edit={edit}
          />
        );
      }
    }
  }

  function renderItem(item: MenuItem) {
    if (!isItemVisible(item, values)) return null;
    return renderControl(item.key, ENTRIES[item.key].control);
  }

  function renderSection(section: MenuSection) {
    return (
      <Section key={section.title} title={section.title} hint={section.hint}>
        {section.items.map(renderItem)}
        {section.panel && <BehaviorListPanel kind={section.panel} />}
      </Section>
    );
  }

  // Search beats the tab filter (the rail passes only one of the two). The
  // filter itself is filterMenuSections — pure, in settingsMenu.ts, unit-
  // tested — this component just supplies the two live halves: registry
  // labels and showWhen visibility. overlayPage narrows that same "visible"
  // predicate to overlaySections' allowed keys, so search on the /chat window
  // or the OBS overlay still runs over SECTIONS but never surfaces a row
  // neither page can show.
  const q = (search ?? "").trim();
  const overlayAllowed = overlayPage
    ? new Set(overlaySections(overlayPage).flatMap((sec) => sec.items.map((it) => it.key)))
    : null;
  const isVisible = (it: MenuItem) => isItemVisible(it, values) && (!overlayAllowed || overlayAllowed.has(it.key));
  const visibleSections = q
    ? filterMenuSections(INSTALLED_SECTIONS, q, (k) => ENTRIES[k].control.label, isVisible)
    : overlayPage
      ? overlaySections(overlayPage) // the /chat window + OBS overlay have no tab owner — show every allowed section
      : activeTab
        ? INSTALLED_SECTIONS.filter(sec => sec.tab === activeTab)
        : INSTALLED_SECTIONS; // no tab owner (e.g. the standalone /chat window) — show everything

  // Reset — two-click confirm so a stray tap can't wipe a tuned theme. In the
  // Appearance window it sits in the fixed header with the saved looks
  // (round 2b); elsewhere it stays at the bottom of the list.
  const resetButton = (
    <button
      type="button"
      onClick={() => {
        if (!confirmReset) { setConfirmReset(true); return; }
        resetToDefaults();
        setPick(null);
        setConfirmReset(false);
      }}
      onMouseLeave={() => setConfirmReset(false)}
      className={`w-full py-1 rounded text-xs transition-colors ${
        confirmReset
          ? "text-red-200 bg-red-900/50 hover:bg-red-900/70"
          : "text-secondary bg-raised hover:bg-control hover:text-body"
      }`}
    >
      {confirmReset ? "Click again to reset everything" : "Reset to defaults"}
    </button>
  );

  return (
    <div className="space-y-5 text-sm pr-1">
      {saveState === "failed" && (
        <p role="alert" className="flex items-center gap-2 text-xs text-red-300">
          <span className="flex-1">Couldn&apos;t save these settings to your account.</span>
          <button type="button" onClick={() => void flushSettingsSave()} className="shrink-0 underline text-body">Retry</button>
        </p>
      )}
      {/* Presets sit above EVERY tab rather than being a tab of their own:
          applying a saved look is the one action you most want to take while
          looking at the thing it changes, so it must not mean leaving the
          controls. Above the sections, so they are the first thing in reach. */}
      {(() => {
        const head = (
          <div className={headerSlot ? "space-y-2 pb-2" : undefined}>
            <PresetSlots
              onApply={applyBlob}
              appliedSlot={pick && !pick.edited ? pick.slot : null}
              editedFrom={pick?.edited ? pick.slot : null}
              onSaved={(n) => setPick({ slot: n, edited: false })}
              onCleared={(n) => setPick((p) => (p?.slot === n ? null : p))}
            />
            {headerSlot && resetButton}
          </div>
        );
        return headerSlot ? createPortal(head, headerSlot) : head;
      })()}
      <div className="space-y-4">
        {visibleSections.map(renderSection)}
        {q && visibleSections.length === 0 && (
          <p className="text-xs text-muted">No settings match “{q}”.</p>
        )}
      </div>

      {!headerSlot && resetButton}
    </div>
  );
}
