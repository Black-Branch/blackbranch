"use client";

import { useState, useRef, useEffect } from "react";
import type React from "react";
import { getEmoteMatches } from "./emoteMatches";
import { saveRecentEmote } from "./recentEmotes";
import type { ChatPerson } from "./chatDirectory";
import type { EmoteMap } from "./useEmotes";
import {
  detectTriggers,
  getCurrentTrigger as detectCurrentTrigger,
  buildValue,
  restoreQuery,
  useEmotePref,
} from "./emoteTriggers";
import type { SavedState } from "./emoteTriggers";

export function useEmoteAutocomplete({
  value,
  setValue,
  emotes,
  inputRef,
  suppress = false,
  mentions,
}: {
  value: string;
  setValue: (v: string) => void;
  emotes: EmoteMap;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  suppress?: boolean;
  /** Chat directory entries. Objects, not names: a completion must MATCH on
   *  the Matrix localpart as well as the display name while still WRITING the
   *  display name. A plain string list cannot express that — the thing you
   *  match and the thing you insert are different strings. */
  mentions?: readonly ChatPerson[];
}) {
  const [overlaySel, setOverlaySel] = useState(0);
  const [savedState, setSavedState] = useState<SavedState | null>(null);
  const [dismissed, setDismissedState] = useState(false);
  const { autoSuggest, isCoarse } = useEmotePref();
  const dismissedRef = useRef(false);
  const lastAppliedRef = useRef<string | null>(null);
  const prevValueRef = useRef(value);
  // True once the user has pressed Tab since the list was (re)summoned. The FIRST
  // Tab only SELECTS the first suggestion (highlight, no fill); subsequent Tabs
  // cycle the highlight like ArrowDown. Reset whenever a fresh query/typing or a
  // commit/dismiss resets the selection.
  const tabbedSinceOpenRef = useRef(false);
  const [suggestReady, setSuggestReady] = useState(false);
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Caret position the trigger detection anchors on — so completion works on the
  // word UNDER THE CARET, not just the last word. Tracks the DOM caret as the
  // value changes (typing); the consumer wires onSelectionChange for pure caret
  // moves (click / arrow). Defaults to end-of-value (the old behavior) when no
  // selection wiring is present.
  const [caret, setCaret] = useState(value.length);

  function setDismissed(v: boolean) {
    dismissedRef.current = v;
    setDismissedState(v);
    if (v) setSuggestReady(false);
  }

  // Keep the caret anchor in step with the DOM as the value changes (typing). A
  // one-frame lag is harmless: the overlay only appears after the 250ms debounce
  // (by which point this has corrected) and display always reads the live caret.
  useEffect(() => {
    const el = inputRef.current;
    const c = el?.selectionStart ?? value.length;
    setCaret((p) => (p === c ? p : c));
  }, [value, inputRef]);

  // --- live trigger detection from current value + caret ---
  const { colonMatch, plainMatch, mentionMatch, isZWFilter } = detectTriggers(value, caret, suppress, mentions);

  // Whether the overlay is in mention mode this render
  const isMentionMode = savedState
    ? savedState.mode === "mention"
    : mentionMatch !== null;

  // --- match lists (raw, ignoring dismissed) ---
  const rawEmoteQuery: string | null = savedState
    ? (savedState.mode !== "mention" ? savedState.query : null)
    : colonMatch
    ? (colonMatch[2] ?? "").toLowerCase()
    : plainMatch
    ? (plainMatch[2] ?? "").toLowerCase()
    : null;

  const rawEmoteMatches: Array<[string, string | null]> = !isMentionMode && rawEmoteQuery !== null
    ? getEmoteMatches(rawEmoteQuery, emotes, savedState ? savedState.zeroWidth : isZWFilter)
    : [];

  const rawMentionMatches: Array<[string, string | null]> = isMentionMode && mentions
    ? (() => {
        const q = (savedState?.query ?? mentionMatch?.[1] ?? "").toLowerCase();
        // Match on ANY key, offer the display name. `mentions` is already
        // recency-ordered, so first-8 is the ranking without a sort.
        const out: Array<[string, string | null]> = [];
        for (const p of mentions) {
          if (out.length >= 8) break;
          if (p.keys.some((k) => k.startsWith(q))) out.push([p.name, null]);
        }
        return out;
      })()
    : [];

  const rawOverlayMatches = isMentionMode ? rawMentionMatches : rawEmoteMatches;

  // No matches → not ready, immediately (render-time adjust; the debounce effect
  // below only ever arms the show timer).
  if (rawOverlayMatches.length === 0 && suggestReady) setSuggestReady(false);

  // --- debounce: delay overlay appearance 250ms after last keystroke ---
  useEffect(() => {
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    suggestTimerRef.current = null;
    if (rawOverlayMatches.length === 0) {
      return;
    }
    // An explicit ':' trigger is unambiguous intent — show the list near-
    // instantly (Chatterino/DankChat show at ~0-20ms). Plain-word matching
    // keeps the longer settle so mid-sentence typing isn't noisy.
    const delay = colonMatch ? 100 : 250;
    suggestTimerRef.current = setTimeout(() => setSuggestReady(true), delay);
    return () => { if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the debounce re-arms on KEYSTROKES only. colonMatch is a fresh regex match object every render (listing it re-arms every render, i.e. never settles), and rawOverlayMatches.length changes when the emote set loads, which would re-arm the timer under a user who has stopped typing
  }, [value]);

  // Plain-word emotes stay hidden until Tab when auto-suggest is OFF (until the
  // user Tabs, which sets savedState). Colon/mention modes auto-open as before.
  const currentMode: SavedState["mode"] | null = savedState
    ? savedState.mode
    : colonMatch ? "colon" : plainMatch ? "plain" : mentionMatch ? "mention" : null;
  // Auto-suggest OFF: suppress plain-word lists. Desktop keeps matches ready and
  // only hides until Tab (savedState set); mobile has no Tab, so suppress always.
  const plainSuppressed = !autoSuggest && currentMode === "plain" && (isCoarse || savedState === null);

  // Gate display with dismissed, debounce, and suppression flags. NOTE: showing
  // the overlay does NOT mutate the input — navigation (arrows/hover) only moves
  // the highlight; the value changes only on an explicit commit (Tab/Enter/click).
  const overlayMatches: Array<[string, string | null]> =
    (dismissed || !suggestReady || plainSuppressed) ? [] : rawOverlayMatches;

  // --- reset selection when query changes (and not in cycle mode) ---
  // The live MENTION query must be a dep too: without it, narrowing an @query
  // kept a stale overlaySel pointing at a different user than the one
  // highlighted, so Tab/Enter committed the wrong @mention.
  const liveMentionQuery = savedState?.mode === "mention"
    ? savedState.query
    : mentionMatch?.[1] ?? null;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- input-machine reset: the selection must clear exactly when the query deps change; a render-time derive would need a ref write during render (also disallowed)
    if (savedState === null) { setOverlaySel(0); tabbedSinceOpenRef.current = false; }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- savedState is READ as a guard, never as a trigger: Tab sets savedState, and re-running this on that change would reset the very selection Tab just established
  }, [rawEmoteQuery, liveMentionQuery, isZWFilter, isMentionMode]);

  // --- clear cycle mode / dismissed when user types ---
  useEffect(() => {
    if (value === lastAppliedRef.current) { // we caused this change
      prevValueRef.current = value;
      return;
    }
    const wasDeletion = value.length < prevValueRef.current.length;
    prevValueRef.current = value;
    lastAppliedRef.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- input-machine transition: cycle/dismissed state must reset in commit order against the ref comparisons above; not derivable at render time
    if (savedState !== null) setSavedState(null);
    // Keep an Escape-dismissed list dismissed through backspaces — only forward
    // typing re-opens it, so backspace narrows an open list but never
    // re-triggers a list the user already dismissed.
    if (dismissedRef.current && !wasDeletion) setDismissed(false);
    setOverlaySel(0);
    tabbedSinceOpenRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the user TYPES. savedState is both read and cleared here, so listing it is a self-triggering loop
  }, [value]);

  // --- helpers ---

  const getCurrentTrigger = (): SavedState | null =>
    detectCurrentTrigger(value, caret, { colonMatch, plainMatch, mentionMatch, isZWFilter });

  // Write the chosen completion into the input. This is the ONLY path that
  // mutates the value — navigation never does. Places the caret right after the
  // inserted token so a following word (if any) is left untouched.
  function applyName(state: SavedState, name: string) {
    const { value: newValue, caret: newCaret } = buildValue(state, name);
    lastAppliedRef.current = newValue;
    setValue(newValue);
    setCaret(newCaret);
    // Feed the shared recency store (picker Recent row + completion ranking boost).
    if (state.mode !== "mention" && emotes[name]) saveRecentEmote(name);
    const el = inputRef.current;
    if (el) requestAnimationFrame(() => { el.focus(); el.setSelectionRange(newCaret, newCaret); });
  }

  // Tab-cycle fill (Chatterino-classic): write `name` into the input against the
  // FROZEN state but KEEP the freeze, so the next Tab replaces this fill with the
  // next candidate. Recency is deliberately not recorded per cycle step.
  function cycleFill(state: SavedState, name: string) {
    const { value: newValue, caret: newCaret } = buildValue(state, name);
    lastAppliedRef.current = newValue;
    setValue(newValue);
    setCaret(newCaret);
    const el = inputRef.current;
    if (el) requestAnimationFrame(() => { el.focus(); el.setSelectionRange(newCaret, newCaret); });
  }

  // Move the highlight only — no value mutation. Used by colon/mention lists.
  function moveSelection(direction: 1 | -1): boolean {
    const matches = overlayMatches;
    if (matches.length === 0) return false;
    setOverlaySel((sel) => (sel + direction + matches.length) % matches.length);
    return true;
  }

  // Fill the currently-highlighted item (default first) into the input.
  function commitSelection(): boolean {
    const matches = overlayMatches.length > 0 ? overlayMatches : rawOverlayMatches;
    if (matches.length === 0) return false;
    const idx = Math.min(overlaySel, matches.length - 1);
    const state = savedState ?? getCurrentTrigger();
    if (!state) return false;
    const chosen = matches[idx];
    if (!chosen) return false;
    applyName(state, chosen[0]);
    setSavedState(null);
    setDismissed(false);
    setOverlaySel(0);
    tabbedSinceOpenRef.current = false;
    return true;
  }

  function dismissOverlay(): boolean {
    if (overlayMatches.length === 0 && savedState === null) return false;
    // No preview was written, so dismissing just hides the list — the text the
    // user typed stays exactly as-is.
    setSavedState(null);
    setDismissed(true);
    setOverlaySel(0);
    tabbedSinceOpenRef.current = false;
    return true;
  }

  // Hover over an item: highlight it only (no preview/fill).
  function hoverSelect(i: number) {
    if (overlayMatches.length === 0) return;
    setOverlaySel(i);
  }

  // Click / programmatic accept of a specific item.
  function applyOverlayItem(name: string) {
    const state = savedState ?? getCurrentTrigger();
    if (!state) return;
    applyName(state, name);
    setSavedState(null);
    setDismissed(false);
    setOverlaySel(0);
    tabbedSinceOpenRef.current = false;
  }

  // Wire to the textarea's onSelect so pure caret moves (click / arrow) update
  // the detection anchor — enables mid-word completion after clicking into a word.
  function onSelectionChange() {
    const c = inputRef.current?.selectionStart ?? value.length;
    setCaret((p) => (p === c ? p : c));
  }

  function handleOverlayKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
    // `suppress` gates the LIST, and also the two branches below — otherwise
    // the command overlay and this one fight:
    //   • smart-backspace would delete a whole token when it happened to be an
    //     emote name, so backspacing inside "/ban KEKW" would nuke the argument;
    //   • Tab would call preventDefault() and then often return false, so Tab
    //     would be swallowed with no completion at all while typing a command.
    // While suppressed this handler must do nothing and say so, letting the
    // command palette own the keys.
    if (suppress) return false;

    const hasOverlay = overlayMatches.length > 0 || savedState !== null;

    // Smart backspace: delete an entire completed emote word in one press,
    // regardless of overlay state. Skipped only while actively narrowing a
    // visible list (mid-query, no trailing space) so backspace shrinks the
    // query there as expected instead of nuking the word being typed.
    if (e.key === "Backspace") {
      const el = e.currentTarget;
      if (el.selectionStart === el.selectionEnd) {
        const pos = el.selectionStart ?? 0;
        const before = el.value.slice(0, pos);
        const m = before.match(/([a-zA-Z0-9_]+)( ?)$/);
        const word = m?.[1];
        const space = m?.[2] ?? "";
        const narrowing = overlayMatches.length > 0 && !(m && space === " ");
        if (word && emotes[word] && !narrowing) {
          e.preventDefault();
          const del = word.length + space.length;
          setValue(el.value.slice(0, pos - del) + el.value.slice(pos));
          requestAnimationFrame(() => el.setSelectionRange(pos - del, pos - del));
          return true;
        }
      }
    }

    // Tab = Chatterino-classic inline cycling: the FIRST Tab fills the top-ranked
    // match into the input immediately; each further Tab replaces it with the
    // next candidate (Shift-Tab previous), all against the query frozen on the
    // first press (tabbedSinceOpenRef = "cycling"). Typing resumes editing,
    // Escape restores the exact text the user had typed, Enter just sends.
    if (e.key === "Tab") {
      e.preventDefault();
      if (dismissedRef.current) setDismissed(false);
      const matches = overlayMatches.length > 0 ? overlayMatches : rawOverlayMatches;
      if (matches.length === 0) return false;
      let state = savedState;
      if (state === null) {
        state = getCurrentTrigger();
        if (!state) return false;
        setSavedState(state);
        setSuggestReady(true); // show the list as visual feedback while cycling
      }
      const idx = tabbedSinceOpenRef.current
        ? (overlaySel + (e.shiftKey ? -1 : 1) + matches.length) % matches.length
        : Math.min(overlaySel, matches.length - 1);
      const chosen = matches[idx];
      if (!chosen) return false;
      tabbedSinceOpenRef.current = true;
      setOverlaySel(idx);
      cycleFill(state, chosen[0]);
      return true;
    }

    if (!hasOverlay) return false;

    if (e.key === "Escape") {
      e.preventDefault();
      // Mid-cycle Escape = undo the fill back to the exact typed query.
      if (savedState && tabbedSinceOpenRef.current) {
        const { value: v, caret: c } = restoreQuery(savedState);
        lastAppliedRef.current = v;
        setValue(v);
        setCaret(c);
        const el = inputRef.current;
        if (el) requestAnimationFrame(() => { el.focus(); el.setSelectionRange(c, c); });
      }
      return dismissOverlay();
    }

    // Arrows navigate ONLY an explicit colon/mention picker that isn't mid-cycle.
    // Everywhere else they fall through to ChatInput (message-history recall /
    // caret movement) — Up-arrow history beats list navigation, like Chatterino.
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const mode = savedState?.mode ?? (colonMatch ? "colon" : isMentionMode ? "mention" : "plain");
      const navigable = overlayMatches.length > 0 && !tabbedSinceOpenRef.current &&
        (mode === "colon" || mode === "mention");
      if (!navigable) return false;
      e.preventDefault();
      return moveSelection(e.key === "ArrowDown" ? 1 : -1);
    }

    if (e.key === "Enter") {
      // Mid-cycle the input already holds the filled emote — let Enter send it.
      if (tabbedSinceOpenRef.current) return false;
      // Enter on an explicit colon/mention list commits the highlighted item; a
      // plain word with no Tab still sends (plain words are real words).
      const menuVisible = overlayMatches.length > 0;
      const mode = savedState?.mode ?? (colonMatch ? "colon" : isMentionMode ? "mention" : "plain");
      if (menuVisible && (mode === "colon" || mode === "mention")) {
        e.preventDefault();
        return commitSelection();
      }
    }

    return false;
  }

  // Call on form submit to reset state
  function clearOverlayState() {
    setSavedState(null);
    setDismissed(false);
    setSuggestReady(false);
    lastAppliedRef.current = null;
    setOverlaySel(0);
    tabbedSinceOpenRef.current = false;
  }

  return {
    overlayMatches,
    overlaySel,
    isMentionMode,
    hoverSelect,
    applyOverlayItem,
    handleOverlayKeyDown,
    onSelectionChange,
    clearOverlayState,
  };
}
