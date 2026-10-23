"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { onChatNotice, isLongNotice } from "@/app/lib/chatNotice";
import { flushSync } from "react-dom";
import { useEmotes } from "@/app/lib/useEmotes";
import { usePersonalEmotes } from "@/app/lib/usePersonalEmotes";
import { mergeForInput } from "@/app/lib/personalEmotes";
import { useEmoteAutocomplete } from "@/app/lib/useEmoteAutocomplete";
import { EmoteCompletionList } from "@/app/components/EmoteCompletionList";
import { ChatComposerField } from "@/app/components/ChatComposerField";
import UserMenu from "@/app/components/UserMenu";
import { EarnChip } from "@/app/components/EarnChip";
import { normalizeUsername, type ChatMsg } from "@/app/lib/chatMsg";
import type { ChatPerson } from "@/app/lib/chatDirectory";
import PlatformIcon, { PLATFORM_COLORS } from "@/app/components/PlatformIcon";
import { isRoutablePlatform } from "@/app/lib/platforms";
import { PaperPlaneRight, Lock } from "@phosphor-icons/react/dist/ssr";
import PollComposer from "@/app/components/PollComposer";
import { HIGHLIGHT_PRICE, TTS_PRICE } from "@/app/lib/coins";
import { currencyName } from "@/app/lib/currency";
import { useItemPrice } from "@/app/lib/useStorePrices";
import { useCoinBalance } from "@/app/lib/useCoinBalance";
import { useChatHistoryRecall } from "@/app/lib/useChatHistoryRecall";
import { useSlowMode } from "@/app/lib/useSlowMode";
import { useSendDestination } from "@/app/lib/useSendDestination";
import { ENCRYPTED_DEST, composerAccent, destMark } from "@/app/lib/sendDestination";
import { publishOwnSend } from "@/app/lib/chatEvents";
import { RedactedQuote } from "@/app/components/RedactedText";
import { useStickerSend } from "@/app/lib/useStickerSend";
import { SpendChip, type SpendMode } from "./SpendChip";
import { ComposerToolsPopover } from "@/app/components/ComposerToolsPopover";
import { SendToButton, SupportButton } from "@/app/components/SendToButton";
import { ctlBox, CTL_ICON } from "@/app/lib/composerControls";
import { CHAT_FONT_SM } from "@/app/lib/chatFont";
import { keepFocus } from "@/app/lib/keepFocus";
import { useBadges } from "@/app/lib/BadgesContext";
import { chatCharLimit } from "@/app/lib/chatLimits";
import { CommandPalette } from "@/app/components/CommandPalette";
import { parseCommandLine, suggestFor, applySuggestion, currentArg } from "@/app/lib/commands/parse";
import { createCommandRunner } from "@/app/lib/commands/run";
import { currentBinding, releaseComposer } from "@/app/lib/composerBinding";
import { CHAT_CONSOLE } from "@/app/lib/plugins/chat";
import { formatMxid } from "@/app/lib/matrixDisplay";
import { useComposerBinding } from "@/app/lib/useComposerBinding";
import { provideChatSender, setChatDest } from "@/app/lib/chatSender";
import { shouldRecallHistory } from "@/app/lib/historyRecallGate";
import { chatScrollKey, type ChatScrollKey } from "@/app/lib/chatScrollKeys";
import { normalizePlatform } from "@/app/lib/nativePlatform";
import { useRefusalNote, useSkippedPlatforms, dismissRefusalNote, retryDestination } from "@/app/lib/platformRefusals";
import { failedSendAction } from "@/app/lib/failedSend";
import { takeReHideNotice } from "@/app/lib/behaviorStore";
import { featureOn } from "@/app/lib/siteFeatures";
import { useComposerFocus } from "./useComposerFocus";

type Props = {
  replyTo: ChatMsg | null;
  onClearReply: () => void;
  // Re-arm the reply banner after a failed send — the banner is cleared
  // optimistically pre-send, so without this a retry goes out as a top-level
  // message instead of the reply the user composed.
  onRestoreReply: (m: ChatMsg) => void;
  mentionCandidates: readonly ChatPerson[];
  isMod: boolean;
  onSendMessage: (
    text: string,
    replyTo: ChatMsg | null,
    forcedDest?: string | null,
    spend?: { mode: SpendMode; spendId: string; expectedPrice: number } | null,
    encrypted?: boolean
  ) => Promise<string | null>;
  anchorToBottom: () => void;
  /** PgUp/PgDn/Home/End from the composer scroll the feed. */
  onScrollKey?: (key: ChatScrollKey) => void;
  matrixId: string | null;
  canonicalId: string | null;
  onShowTimestampsChange: (show: boolean) => void;
  onShowMatrixNameChange: (show: boolean) => void;
  isPopout: boolean;
  /**
   * Does this composer host a support panel? Only the main app's sidebar does —
   * popouts/overlays leave both unset, which keeps the support destination out
   * of their cycle entirely (there is no panel there to open).
   */
  supportEnabled?: boolean;
  /** Support-mode text sink — the panel's input path. Never the chat wire. */
  onSupportText?: (text: string) => void | Promise<void>;
  /**
   * Open the conversation (from the /support command), optionally with a first
   * message. The sidebar opens the thread SYNCHRONOUSLY before sending, so the
   * first turn can't outrun the greeting.
   */
  onSupportOpen?: (firstMessage?: string) => void;
  /**
   * Close from /support off — routed through the sidebar (not bare
   * leaveSupport) so the thread is RESET too: exiting clears history.
   */
  onSupportClose?: () => void;
  /**
   * Support-mode signals. Landing on the support destination alone opens
   * nothing — `true` fires when the user starts TYPING in support mode;
   * explicit opens (/support, reminders) use onSupportOpen.
   * Disarming fires `false` immediately.
   */
  onSupportModeChange?: (active: boolean) => void;
  /**
   * Hands the sidebar imperative enter/leave controls over the destination —
   * the load-time reminder and the /support command arm support mode from
   * outside this component, and the destination state lives in here.
   */
  onRegisterSupportControls?: (c: { enter: () => void; leave: () => void }) => void;
};

// The install's console, mounted beside the input when it has one (app/lib/plugins/chat.ts).
const ConsoleHost = CHAT_CONSOLE?.Host ?? null;

export default function ChatInput({
  replyTo,
  onClearReply,
  onRestoreReply,
  mentionCandidates,
  isMod,
  onSendMessage,
  anchorToBottom,
  onScrollKey,
  matrixId,
  canonicalId,
  onShowTimestampsChange,
  onShowMatrixNameChange,
  isPopout,
  supportEnabled = false,
  onSupportText,
  onSupportOpen,
  onSupportClose,
  onSupportModeChange,
  onRegisterSupportControls,
}: Props) {
  const emotes = useEmotes();
  const { emotes: personalEmoteMap, needsRelink: personalNeedsRelink } = usePersonalEmotes();
  // Input surfaces get the MERGED map (global wins collisions — personalEmotes.ts).
  const inputEmotes = useMemo(() => mergeForInput(emotes, personalEmoteMap), [emotes, personalEmoteMap]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showEmotePicker, setShowEmotePicker] = useState(false);
  const [showPollComposer, setShowPollComposer] = useState(false);
  // Spend mode (highlight / read-aloud): the tools menu arms the next send.
  // Native-only, so it's suspended while replying (replies route to the
  // replied-to platform). spendId is the server-side idempotency key — held in
  // a ref so a RETRY of a failed send replays instead of double-debiting;
  // regenerated after a confirmed success or a product change.
  const [spendMode, setSpendMode] = useState<SpendMode | null>(null);
  const spendIdRef = useRef<string>(crypto.randomUUID());
  // Which product spendIdRef.current was minted for. The chip and the
  // `/highlight` / `/tts` commands share one ref (same idempotency-key space),
  // so a product switch through EITHER door must mint a fresh key before the
  // next send — otherwise an unconfirmed send's already-committed ledger row
  // (site.coin_ledger's unique index is (kind='spend', ref), NOT scoped by
  // sink/product) makes the NEXT product's debitCoins call a silent replay:
  // it returns replay:true, deliverChatEvent is never called, and the route
  // answers { ok: true } for a message that never posted. See dadde85's
  // CheerChip, which regenerated on every amount change for the same reason.
  const spendProductRef = useRef<SpendMode | null>(null);
  function armSpendId(product: SpendMode): string {
    if (spendProductRef.current !== null && spendProductRef.current !== product) {
      spendIdRef.current = crypto.randomUUID();
    }
    spendProductRef.current = product;
    return spendIdRef.current;
  }
  const coinBalance = useCoinBalance(spendMode !== null && !!matrixId);
  const highlightPrice = useItemPrice("highlight") ?? HIGHLIGHT_PRICE;
  const ttsPrice = useItemPrice("tts") ?? TTS_PRICE;
  const spendPrice = spendMode === "tts" ? ttsPrice : highlightPrice;
  const { stickerBusy, sendSticker, stickerPrice } = useStickerSend(setSendError);
  const { slowActive, slowRemaining, armSlowMode } = useSlowMode(isMod);
  // Read BEFORE useSendDestination, which needs `canEncrypt` to build its
  // cycle. `undefined` (not yet loaded) is passed through deliberately — see the
  // prune guard in sendDestination.ts.
  // `supporter`, NOT `tier`. `tier` is the viewer's own Stripe subscription and
  // is null for someone holding a GIFTED Supporter sub — who would be refused
  // the encrypted destination here while /api/chat/send accepts their message
  // (it gates on getActiveTier, which counts gifts). See the long note in
  // /api/me. Same tri-state contract: `undefined` means the read has not landed
  // and must not prune a stored redaction choice.
  const { isAdmin, supporter } = useBadges();
  // The box's limit is the server's limit — see chatLimits.ts. TTS mode caps
  // at what the voice reads; a draft that outlives a shrunk limit is not cut,
  // the counter goes red and the server names the number on send.
  const charLimit = chatCharLimit({ isMod, isAdmin }, spendMode === "tts" ? "tts" : null);
  const canEncrypt = supporter === undefined ? null : supporter;
  const {
    forcedDest, destCycle, linkedDests, setDest, resetDest,
    supportArmed, armSupport, leaveSupport,
  } = useSendDestination(canEncrypt);
  const encryptArmed = forcedDest === ENCRYPTED_DEST;

  // A window holding the composer — reactive, for the send-to control's face.
  // Null unless a window binds the composer.
  const binding = useComposerBinding();

  // Support-mode signals to the sidebar. Landing on the support destination
  // alone shows NOTHING — the panel pops when the user starts TYPING in
  // support mode (no auto-open from cycling; reminders and the /support
  // command open it through their own explicit paths). Disarming closes
  // immediately.
  useEffect(() => {
    if (!onSupportModeChange) return;
    if (!supportArmed) { onSupportModeChange(false); return; }
    if (input.trim().length > 0) onSupportModeChange(true);
  }, [supportArmed, input, onSupportModeChange]);

  // Imperative enter/leave for the sidebar (reminder, /support command) — the
  // destination state lives in this component, the callers don't.
  useEffect(() => {
    onRegisterSupportControls?.({
      enter: armSupport,
      leave: leaveSupport,
    });
  });

  // THERE IS NO HELP-DESK CONTROL IN THE COMPOSER. Support mode is reached by
  // the `/support` command, the load-time greeting bubble, and the panel's own
  // controls — and `supportArmed` is signalled by the composer ACCENT rather
  // than by a label, because the send-to button underneath keeps showing the
  // real destination.
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Does the box have focus — from onFocus, or from a keystroke when the focus came before the
  // page was listening (useComposerFocus). Read by `composing` below.
  const { focused, onFocus: onFieldFocus, onBlur: onFieldBlur, noteInput } = useComposerFocus(inputRef);

  function showNotice(text: string) {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    // A long one (/help) stays until closed: five seconds is not enough to read a list.
    if (!isLongNotice(text)) noticeTimer.current = setTimeout(() => setNotice(null), 5000);
  }
  // Row actions with no surface of their own (a mod's delete, pin, unpin) report
  // a failure through this same line — see chatNotice.ts.
  useEffect(() => onChatNotice((text) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 5000);
  }), []);
  // Once: a signed-out ignore list from before an update held people it can no
  // longer hide (behaviorLegacyLocal.ts). Longer dwell — it names people to re-hide.
  useEffect(() => {
    let live = true;
    void takeReHideNotice().then((text) => {
      if (!live || !text) return;
      setNotice(text);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setNotice(null), 20_000);
    });
    return () => { live = false; };
  }, []);

  // How long a composer error stays up, and why the two differ.
  //
  // A REJECTED command is immediate feedback on a deliberate act — the user
  // typed `/foo` and is still looking at the composer when the answer lands.
  //
  // A FAILED SEND is not. The send is fire-and-confirm with no optimistic row,
  // so the first the user hears of a network failure is whenever the request
  // finally gives up — ~10 seconds, by which time the user's attention has
  // moved. A short dwell would give them a few seconds on a message they were
  // not watching for. The late arrival is what earns the long dwell; do not
  // collapse these back into one number.
  const ERROR_MS_REJECTED = 8_000;
  const ERROR_MS_FAILED_SEND = 20_000;

  function showError(text: string, ms: number) {
    setSendError(text);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setSendError(null), ms);
  }

  // A platform that refused the sender's lines: ONE note
  // at a time, inside the empty field (ChatComposerField `note`) so it neither
  // grows the bar nor covers the chat. A persistent one waits for its ✕; a
  // transient one, and the "couldn't reach" line, go on their own after the
  // failed-send dwell. Per tab — a pop-out or /chat window has its own
  // (platformRefusals.ts).
  const refusal = useRefusalNote();
  const refusalStates = useSkippedPlatforms();
  useEffect(() => {
    if (!refusal || refusal.kind === "persistent") return;
    const t = setTimeout(() => dismissRefusalNote(refusal.id), ERROR_MS_FAILED_SEND);
    return () => clearTimeout(t);
  }, [refusal]);

  // Clear pending notice/error timers on unmount (no setState-after-unmount).
  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    if (errorTimer.current) clearTimeout(errorTimer.current);
  }, []);

  // There is deliberately NO in-flight indicator: a "sending…" line on every
  // message is intrusive. A FAILED send still says so, via sendError with the
  // long ERROR_MS_FAILED_SEND dwell above.

  // Built inside the send handler, not during render: createCommandRunner closes
  // over callbacks that touch refs, and constructing it in render trips the
  // "cannot access refs during render" rule. It is a plain closure — making one
  // per send costs nothing.

  // isAdmin comes from BadgesContext, which already fetches /api/me — no extra
  // request. Client-side scope is UX ONLY: it decides what is offered and gives a
  // clear refusal instead of a bare 403. requireMod/requireAdmin on the server is
  // still the real gate.
  //
  // `dests` gates the /twitch-family routing commands the same way the send-to
  // toggle is gated — a command that can only ever answer "link that account
  // first" should not be offered at all.
  // `features`: a command for a part this install does not run is neither offered nor run (the
  // page records what runs before the chat mounts — siteFeatures.ts).
  const viewer = useMemo(
    () => ({ isMod, isAdmin, dests: linkedDests, isSupporter: canEncrypt !== false, features: featureOn }),
    [isMod, isAdmin, linkedDests, canEncrypt],
  );

  // Command mode is NOT gated on isMod — everyone gets /help, and a non-mod who
  // types a mod command must get told so, not have their message vanish.
  const [caret, setCaret] = useState(0);
  const [cmdSel, setCmdSel] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState(false);
  const parsedCmd = useMemo(() => parseCommandLine(input, caret), [input, caret]);
  const cmdSuggestions = useMemo(
    // Slash-command argument suggestions still want plain names — a command
    // takes a name, not an identity.
    () => (parsedCmd.isCommand ? suggestFor(parsedCmd, viewer, mentionCandidates.map((p) => p.name)) : []),
    [parsedCmd, viewer, mentionCandidates],
  );
  const showingCommandHints = parsedCmd.isCommand && !cmdDismissed;

  // THE CARET IS IN PROSE, NOT IN A COMMAND.
  //
  // `/r catJAM @alice` is a MESSAGE with a routing prefix — the tail of a
  // `rest: true` text argument is ordinary chat text and must complete emotes
  // and @mentions exactly like any other message. Suppressing the emote hook
  // for any line beginning with "/" would make the `/t /k /s /y /l /r` family
  // — the commands whose only job is to carry a message — the one place emotes
  // could not be completed, and ban/timeout reasons too.
  //
  // It would also let Tab ESCAPE THE COMPOSER: with no command suggestions to
  // offer (a free-text argument has none by construction) and the emote
  // handler suppressed, nothing would call preventDefault, so the browser
  // would move focus out of the textarea.
  const cmdFreeText = useMemo(() => {
    const arg = currentArg(parsedCmd);
    return !!arg && arg.kind === "text" && arg.rest === true;
  }, [parsedCmd]);

  // Who owns the arrow keys, Tab and Escape. The palette owns them only while
  // the caret is completing a command TOKEN; in the free-text tail it hands them
  // to the emote/@mention overlay. The signature line stays visible either way
  // (see showingCommandHints at the render site) so you can still see what
  // arguments the command takes while typing the message.
  const cmdOwnsKeys = showingCommandHints && !cmdFreeText;
  // Selection is clamped on READ rather than reset in an effect (setState inside
  // an effect cascades renders — the repo's lint enforces this). Editing the line
  // resets both in the change handler below, which is an event, not a render.
  const cmdSelSafe = cmdSuggestions.length > 0
    ? Math.min(cmdSel, cmdSuggestions.length - 1)
    : 0;

  const pickCommand = useCallback((s: { value: string }) => {
    const out = applySuggestion(input, parsedCmd, s.value);
    setInput(out.text);
    requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(out.caret, out.caret);
      setCaret(out.caret);
    });
  }, [input, parsedCmd, setInput, inputRef]);

  const {
    overlayMatches, overlaySel,
    isMentionMode, hoverSelect, applyOverlayItem,
    handleOverlayKeyDown, onSelectionChange, clearOverlayState,
  } = useEmoteAutocomplete({
    value: input,
    setValue: setInput,
    emotes: inputEmotes,
    inputRef,
    suppress: cmdOwnsKeys,
    mentions: mentionCandidates,
  });

  // Combobox wiring for the field (typeaheadCombobox.test.ts). The two
  // overlays share one slot — the palette yields to emote matches at the
  // render site — so this derives from the SAME conditions the render uses:
  // pointing the SR at the overlay that is not on screen is worse than none.
  const emoteOverlayOpen = overlayMatches.length > 0;
  const paletteListOpen = showingCommandHints && !emoteOverlayOpen && cmdSuggestions.length > 0;
  const composerCombobox = {
    expanded: emoteOverlayOpen || paletteListOpen,
    controls: emoteOverlayOpen ? "chat-emote-listbox"
      : paletteListOpen ? "command-palette-list" : undefined,
    activeDescendant: emoteOverlayOpen ? `chat-emote-listbox-opt-${overlaySel}`
      : paletteListOpen ? `command-palette-list-opt-${cmdSelSafe}` : undefined,
  };

  useEffect(() => {
    if (replyTo) inputRef.current?.focus();
  }, [replyTo]);

  const { handleInputChange, recallHistory, recordSent } = useChatHistoryRecall(input, setInput, inputRef);

  // Editing the line resets the command overlay's selection and un-dismisses it.
  // Done here, in an event, rather than in an effect — setState inside an effect
  // cascades renders and the repo's lint rejects it.
  const onComposerChange = useCallback((v: string) => {
    noteInput();
    handleInputChange(v);
    setCmdSel(0);
    if (!v.startsWith("/")) setCmdDismissed(false);
    // The caret has not moved yet at this point; read it next frame.
    requestAnimationFrame(() => setCaret(inputRef.current?.selectionStart ?? v.length));
  }, [handleInputChange, inputRef, noteInput]);

  // The parser needs the caret, not just the text, to know which token is
  // being edited — that is what makes mid-line completion possible.
  const syncCaret = useCallback(() => {
    setCaret(inputRef.current?.selectionStart ?? input.length);
  }, [inputRef, input.length]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // The feed's keys first: the browser would otherwise page the
    // focused textarea, which has no pages, and nothing would move.
    const scrollKey = chatScrollKey(e.key, { textEmpty: input.trim() === "", modified: e.altKey || e.metaKey || e.ctrlKey || e.shiftKey });
    if (scrollKey && onScrollKey) { e.preventDefault(); onScrollKey(scrollKey); return; }
    if (e.key === "Escape") {
      if (showEmotePicker) { setShowEmotePicker(false); return; }
      if (replyTo) { e.preventDefault(); onClearReply(); return; }
      // Escape leaves spend mode, exactly as the chip's ✕ does. Keyed on
      // spendMode, not spendActive: the mode is what the ✕ clears and what the
      // tools menu toggles, and a spend that is armed but inactive (no matrixId,
      // encrypted armed) must still be escapable or it strands the composer.
      //
      // stopPropagation because the floating Window closes on a document-level Escape, so
      // without it dismissing a spend would also close an open card behind the
      // composer. (The emote/reply branches above have the same exposure.)
      if (spendMode) { e.preventDefault(); e.stopPropagation(); setSpendMode(null); return; }
    }

    // The command palette owns the keys while a command TOKEN is being typed. It
    // runs BEFORE the emote overlay, which bails out entirely when suppressed.
    // Inside a free-text argument `cmdOwnsKeys` is false, so this whole block is
    // skipped and the overlay below gets the keys instead — including Escape,
    // which must close the emote list rather than dismiss the palette.
    if (cmdOwnsKeys) {
      if (e.key === "Escape") { e.preventDefault(); setCmdDismissed(true); return; }
      if (cmdSuggestions.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault(); setCmdSel((i) => (Math.min(i, cmdSuggestions.length - 1) + 1) % cmdSuggestions.length); return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault(); setCmdSel((i) => (Math.min(i, cmdSuggestions.length - 1) - 1 + cmdSuggestions.length) % cmdSuggestions.length); return;
        }
        // Tab always completes. Enter only completes while a suggestion is
        // highlighted by an explicit move — otherwise Enter must SEND, or a
        // fully-typed command could never be run without first dismissing.
        if (e.key === "Tab") {
          e.preventDefault(); pickCommand(cmdSuggestions[cmdSelSafe]!); return;
        }
      }
    }

    if (handleOverlayKeyDown(e)) return;

    // TAB MUST NEVER LEAVE THE COMPOSER WHILE A COMMAND IS BEING TYPED.
    //
    // Both handlers above decline Tab whenever they have nothing to complete —
    // an unknown `/foo`, a leaf that takes no arguments, a free-text tail with
    // no emote match under the caret. Falling through to the browser's default
    // would blur the textarea mid-draft. Swallowing it is strictly better: in a
    // chat composer there is nothing Tab could usefully move to anyway.
    //
    // Deliberately AFTER both, never before — an early return here would eat the
    // completion Tab is actually for.
    if (e.key === "Tab" && parsedCmd.isCommand) { e.preventDefault(); return; }

    // Up/Down history recall — fires only from the very start (ArrowUp) or
    // very end (ArrowDown) of the draft, so cursor movement within or across a
    // wrapped or multi-line draft still works normally. The emote overlay
    // above gets first crack at the arrows only for explicit colon/@ pickers.
    if (!e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const el = e.currentTarget;
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? input.length;
      if (shouldRecallHistory(e.key, input, start, end)) {
        if (recallHistory(e.key === "ArrowUp" ? -1 : 1)) { e.preventDefault(); return; }
      }
    }

    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); return; }
  }

  // Spend chip derived state. A reply suspends spend mode (a spend is a native
  // site celebration; replies route to the replied-to platform).
  // Suspended while the encrypted destination is armed, for the same reason
  // it is suspended while replying — a spend takes its OWN early-return path
  // through /api/chat/send and never reaches the encrypt branch, so allowing
  // both would post the plaintext in a celebration card while the composer
  // showed a padlock. Silent downgrades of a security-flavoured feature are the
  // one failure mode worth writing extra code to make impossible.
  const spendActive = spendMode !== null && !replyTo && !!matrixId && !encryptArmed;
  const spendAffordable = coinBalance !== null && coinBalance >= spendPrice;
  const spendBlocked = spendActive && !spendAffordable;

  // The terminal's `say` sends through this box: wherever the box would send,
  // under its redaction lock and slow mode — but never as a reply, never a
  // paid spend, and never touching the draft sitting in the box.
  const terminalSend = useRef<(text: string, opts?: { redact?: boolean }) => Promise<void>>(async () => {});
  useEffect(() => {
    terminalSend.current = async (text: string, opts?: { redact?: boolean }) => {
      if (slowActive) throw new Error(`Slow mode — you can send again in ${slowRemaining}s`);
      // A whole-message redaction (the TUI's `/redact`) is native by definition, like the lock.
      const redact = encryptArmed || !!opts?.redact;
      await onSendMessage(text, null, redact ? null : forcedDest, null, redact);
      armSlowMode();
    };
  });
  useEffect(() => provideChatSender((text, opts) => terminalSend.current(text, opts)), []);
  // Where that is, for the terminal's chat TUI typing line: the box's own
  // Send-to — the lock rides in forcedDest as ENCRYPTED_DEST, as terminalSend reads it above.
  useEffect(() => { setChatDest(forcedDest); }, [forcedDest]);
  useEffect(() => () => setChatDest(null), []);

  // A send that failed AFTER the sender had moved on (a new draft, or a reply to
  // someone else): its line is held here and offered as a retry, never written
  // over what they are typing now (failedSend.ts).
  type CapturedSpend = { mode: SpendMode; spendId: string; expectedPrice: number };
  const [failedLine, setFailedLine] = useState<{ text: string; reply: ChatMsg | null; spend: CapturedSpend | null } | null>(null);
  // The reply banner as it is NOW — the send's own closure holds the one from
  // when it started.
  const replyNow = useRef(replyTo);
  useEffect(() => { replyNow.current = replyTo; }, [replyTo]);

  // ─── send ──────────────────────────────────────────────────────────────────
  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    // A bare "/" + Enter opens the install's console when it has one;
    // typing "/" still shows the suggestions, and a whole command still runs from here.
    if (text === "/" && CHAT_CONSOLE) { setInput(""); CHAT_CONSOLE.open(); return; }
    if (!text || sending || slowActive || spendBlocked) return;
    const capturedSpend =
      spendMode && spendActive && spendAffordable
        ? { mode: spendMode, spendId: armSpendId(spendMode), expectedPrice: spendPrice }
        : null;
    await sendLine(text, replyTo, capturedSpend, true);
  }

  // Send the held failed line again, leaving the composer and its draft alone. A
  // spend keeps its idempotency key, so the server replays rather than charging twice.
  async function retryFailed() {
    const f = failedLine;
    if (!f || sending || slowActive) return;
    setFailedLine(null);
    setSendError(null);
    await sendLine(f.text, f.reply, f.spend, false);
  }

  async function sendLine(text: string, capturedReply: ChatMsg | null, capturedSpend: CapturedSpend | null, fromComposer: boolean) {
    // What a FAILED send should put back. Normally the captured reply — but a
    // routing command deliberately discards it (see the "send" branch below),
    // and re-arming a banner the command just overrode would leave the retry
    // pointed somewhere the user never chose.
    let replyToRestore = capturedReply;

    if (fromComposer) recordSent(text);

    flushSync(() => {
      setSending(true);
      if (fromComposer) {
        setInput("");
        onClearReply();
        setShowEmotePicker(false);
      }
      // forcedDest is sticky — it persists across sends so the user can fire
      // several messages at the chosen destination without re-toggling.
    });
    if (fromComposer) clearOverlayState();

    anchorToBottom();

    try {
      // A window holding the composer names the destination. Read
      // synchronously, not from the render's hook value: a bind between render
      // and submit must win. (The terminal does not take the line — the two
      // are used side by side.)
      const bound = currentBinding();
      const { runCommand } = createCommandRunner({
        setSendError,
        // A short reply stays the notice line; a long one (/help) opens the install's
        // console and prints there, and /help runs the console's own
        // help when it has one. No console: every reply is the notice line.
        showNotice: (t) => (!CHAT_CONSOLE || !CHAT_CONSOLE.isLongReply(t) ? showNotice(t)
          : CHAT_CONSOLE.ownsHelp && /^\/help\b/i.test(text) ? CHAT_CONSOLE.open({ cmd: text.slice(1), run: true })
          : CHAT_CONSOLE.open({ cmd: text.slice(1), text: t })),
        support: supportEnabled ? {
          open: (m) => { armSupport(); onSupportOpen?.(m); },
          close: () => (onSupportClose ? onSupportClose() : leaveSupport()),
        } : undefined,
      });
      const outcome = await runCommand(text, viewer);
      if (outcome.kind === "rejected") {
        // An unknown "/foo" must be neither run nor silently dropped — say
        // what went wrong instead, for every user.
        showError(outcome.message, ERROR_MS_REJECTED);
        // Rejected means NOTHING ran, so the optimistic clear above has taken
        // a line the app did nothing with — restore it like the thrown path
        // does, reply banner included, so a typo'd command is a one-keystroke
        // retry instead of a retype. (A retried line was never in the box.)
        if (fromComposer) {
          setInput(text);
          if (capturedReply) onRestoreReply(capturedReply);
        }
      } else if (outcome.kind === "handled") {
        // nothing further — the runner surfaced its own notice/error
      } else if (outcome.kind === "send") {
        // A one-shot destination command (`/t hello`). Two things differ from
        // an ordinary send, and both are deliberate:
        //
        //  • the SENT TEXT is the command's argument, not the typed line.
        //  • the reply is DROPPED. A reply routes to the replied-to person's
        //    platform and wins over the toggle server-side, so honouring both
        //    would silently send `/t hi` to wherever the reply pointed —
        //    exactly the "message went to the wrong audience" failure the
        //    window-scoping fix existed to stop. The command names a
        //    destination explicitly and is the more recent instruction, so it
        //    wins outright rather than being quietly overridden.
        //
        // The sticky toggle is untouched: `forcedDest` is not read here and not
        // written, so the next ordinary message goes where it always did.
        //
        // `/highlight` and `/tts` are the same paid-product mechanism as the
        // tools-menu spend chip, reached through a different door — the price
        // MUST come from the live table (highlightPrice / ttsPrice), never the
        // HIGHLIGHT_PRICE/TTS_PRICE SSR fallback constants, or priceGuard's
        // whole reason for existing (never charge a price the viewer wasn't
        // shown) is defeated. They share the chip's spendIdRef (via armSpendId)
        // too: a retried `/highlight` after a thrown error reuses the same key
        // and replays instead of double-debiting, and switching product —
        // `/highlight` then `/tts`, or a command after an armed chip — mints a
        // fresh one so the second debit can't be swallowed as a replay of the
        // first product's ledger row.
        const spend = outcome.spend
          ? {
              mode: outcome.spend,
              spendId: armSpendId(outcome.spend),
              expectedPrice: outcome.spend === "tts" ? ttsPrice : highlightPrice,
            }
          : null;
        setSendError(null);
        replyToRestore = null;
        await onSendMessage(outcome.text, null, outcome.destination, spend, outcome.encrypted);
        // It went: the terminal's on_send hears it, with where.
        publishOwnSend(outcome.text, destMark(outcome.encrypted ? ENCRYPTED_DEST : outcome.destination));
        // An armed redaction lock is LEFT armed here: there is no cooldown, and
        // disarming would only mean the sender's next message goes out in the
        // clear by surprise.
        // A confirmed spend burns its idempotency key, same as the chip-driven
        // path below — the NEXT spend (chip or command) is a new one.
        if (spend) spendIdRef.current = crypto.randomUUID();
        armSlowMode();
      } else if (bound?.kind === "sendTo") {
        // A DM window holds the box: the line goes to its conversation, never the chat wire. No
        // reply, no spend, no slow mode — a private conversation, not the room.
        setSendError(null);
        replyToRestore = null;
        await bound.send(text);
      } else if (supportArmed) {
        // Support mode: the composer is the help desk's panel input, and a support
        // question is a PRIVATE conversation — it must never touch the chat
        // wire (the send route additionally 400s the sentinel as a backstop).
        // Commands above still run — that is how /support off works from
        // inside support mode — and a routing command (`/t hi`) names its own
        // destination, so it rightly bypassed this branch already.
        setSendError(null);
        await onSupportText?.(text);
      } else {
        setSendError(null);
        // Send is fire-and-confirm; no "Sent to …" toast (it adds noise on
        // every message). Failures still surface via setSendError below.
        // The encrypted sentinel is NOT a destination and must never reach
        // the wire as one: /api/chat/send validates forced_destination against
        // the routable platform list and would silently drop it to null,
        // sending the message in clear text. It is translated to the flag here.
        const sentTo = encryptArmed ? null : forcedDest;
        await onSendMessage(text, capturedReply, sentTo, capturedSpend, encryptArmed);
        // It went: the terminal's on_send hears it, with where.
        publishOwnSend(text, destMark(encryptArmed ? ENCRYPTED_DEST : sentTo));
        // The redaction lock STICKS, so no one accidentally posts a
        // non-redacted message; it stays armed until the sender turns it off,
        // like every other destination.
        // A confirmed spend disarms the chip and burns its idempotency key —
        // the NEXT spend is a new one. (A thrown send keeps both, so a retry
        // with the same text replays server-side instead of double-debiting.)
        if (capturedSpend) {
          spendIdRef.current = crypto.randomUUID();
          setSpendMode(null);
        }
        // Accepted → arm the slow-mode countdown (commands above don't count;
        // the server exempts mods and doesn't consume their window either).
        armSlowMode();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send.";
      showError(msg, ERROR_MS_FAILED_SEND);
      // (A line that IS on the site and only missed a platform never lands here:
      // the send hook returns normally and the refusal note says what is needed.)
      if (failedSendAction({ draft: inputRef.current?.value ?? "", replyArmed: replyNow.current != null }) === "restore") {
        setInput(text);
        if (replyToRestore) onRestoreReply(replyToRestore);
      } else {
        // They have moved on: keep their draft, offer this line as a retry.
        setFailedLine({ text, reply: replyToRestore, spend: capturedSpend });
      }
    } finally {
      setSending(false);
    }
  }

  // Controls that aren't needed mid-message fold away once there is text, giving
  // their width to what you're writing. The emote picker, send and pfp stay put.
  //
  // Trigger is "has text", not "focused": an empty composer you merely tapped
  // still shows everything, and the controls come straight back when you clear
  // the field. Focus-triggered would make them vanish the instant a phone
  // keyboard opened, including on an accidental tap.
  //
  // It is focus AND text, not text alone: a draft you have clicked away from
  // should hand its space back to the chat rather than sitting there several
  // lines tall, and clicking back in expands it again.
  const composing = focused && input.trim().length > 0;

  // Where is this message going? — as a colour. Load-bearing rather than
  // decorative: the `send to:` button folds away while composing, so for the
  // length of a message the row would otherwise say NOTHING about where it is
  // going, and "message went to the wrong audience" is exactly the failure
  // cross-window scoping exists to stop.
  //
  // The send button is the last thing you look at before committing, and the
  // field is the thing you are looking at the whole time — so both carry it,
  // from ONE call. The precedence lives in `composerAccent`
  // (lib/sendDestination); keeping it there is what stops the field and the
  // button from ever disagreeing about the destination.
  const accent = composerAccent({
    boundAccent: binding?.kind === "sendTo" ? binding.face.accent ?? null : null,
    cheerActive: spendActive,
    supportArmed,
    encryptArmed,
    replyPlatform: replyTo?.platform,
    forcedDest,
    platformColors: PLATFORM_COLORS,
    isRoutable: isRoutablePlatform,
  });
  // No signal to give → the user's own send colour (default: the accent).
  const sendBtnColor = accent ?? "var(--chat-send-color, var(--accent))";

  return (
    <form
      onSubmit={sendMessage}
      // The Bar (ChatSidebar) owns shape, padding and height; this form is the
      // content. Rows above the main row flag data-chrome-grow so the Bar grows
      // past the token for them.
      className="flex flex-col min-w-0 w-full"
    >
      {/* Composer status lines. All three sit on the CHAT axis (CHAT_FONT_SM),
          not Tailwind's fixed-rem `text-xs` — see chatFont.ts. They are inline
          rows above the composer, not toasts: there is deliberately no toast
          system here. */}
      {sendError && <p role="alert" data-chrome-grow className="text-red-400 mb-1 px-1" style={{ fontSize: CHAT_FONT_SM }}>{sendError}</p>}
      {failedLine && (
        // A failed line held back so it did not overwrite the draft below it.
        <div data-chrome-grow className="flex items-center gap-2 mb-1 px-1 min-w-0" style={{ fontSize: CHAT_FONT_SM }}>
          <span className="text-muted truncate flex-1">Not sent: “{[...failedLine.text].slice(0, 60).join("")}”</span>
          <button type="button" onMouseDown={keepFocus} onClick={() => void retryFailed()} disabled={sending || slowActive}
            className="shrink-0 text-strong underline disabled:opacity-40">Retry</button>
          <button type="button" onMouseDown={keepFocus} onClick={() => setFailedLine(null)}
            aria-label="Dismiss the failed message" className="shrink-0 text-muted hover:text-strong">✕</button>
        </div>
      )}
      {notice && isLongNotice(notice) ? (
        // A long reply (/help with no console) in a bounded box that scrolls, with a close.
        <div role="status" data-chrome-grow className="relative mb-1 max-h-[40vh] overflow-y-auto rounded-md bg-surface-2 px-2 py-1.5 pr-7 text-secondary whitespace-pre-line" style={{ fontSize: CHAT_FONT_SM }}>
          <button type="button" onMouseDown={keepFocus} onClick={() => setNotice(null)}
            aria-label="Close" className="absolute right-1.5 top-1 text-muted hover:text-strong">✕</button>
          {notice}
        </div>
      ) : notice && <p role="status" data-chrome-grow className="text-secondary mb-1 px-1 whitespace-pre-line" style={{ fontSize: CHAT_FONT_SM }}>{notice}</p>}
      {slowActive && (
        // role=status like its siblings above — this is the state that
        // actually REFUSES sends, and it was the one of the three that said
        // nothing to a SR (chatStateA11y.test.ts).
        <p role="status" data-chrome-grow className="text-muted mb-1 px-1" style={{ fontSize: CHAT_FONT_SM }}>
          Slow mode — you can send again in {slowRemaining}s
        </p>
      )}

      {/* Unified emote / @mention autocomplete overlay */}
      {emoteOverlayOpen && (
        <EmoteCompletionList
          matches={overlayMatches}
          selected={overlaySel}
          onSelect={applyOverlayItem}
          onChangeSelected={hoverSelect}
          isMention={isMentionMode}
          listboxId="chat-emote-listbox"
        />
      )}

      {/* Command palette — suggestions + the signature line.
          Yields to the emote overlay when that has matches: both render
          `absolute bottom-full`, so showing them together stacks two panels in
          one slot. In a free-text argument the palette is down to its signature
          line anyway, and the completion list is what the user is looking at. */}
      {showingCommandHints && overlayMatches.length === 0 && (
        <CommandPalette
          parsed={parsedCmd}
          suggestions={cmdSuggestions}
          selected={cmdSelSafe}
          onSelect={setCmdSel}
          onPick={pickCommand}
        />
      )}

      {/* Spend chip — which product is armed, what it costs, and whether you
          can afford it. Hidden while replying (a spend is native-only; the
          reply banner takes the slot). */}
      {spendActive && spendMode && (
        <SpendChip
          mode={spendMode}
          coinBalance={coinBalance}
          onCancel={() => setSpendMode(null)}
        />
      )}

      {/* Reply banner */}
      {replyTo && (
        // Same axis rule as the status lines above: this row quotes CHAT text
        // (`replyTo.message`), so at a large --chat-font-size a fixed `text-xs`
        // left the quote unreadable beside the message it was quoting. The
        // PlatformIcon is sized in `em` and follows.
        <div data-chrome-grow className="flex items-center gap-2 px-2 py-1 bg-surface-1 border border-edge rounded mb-1" style={{ fontSize: CHAT_FONT_SM }}>
          {replyTo.platform && isRoutablePlatform(replyTo.platform) && (
            <span style={{ color: PLATFORM_COLORS[String(normalizePlatform(replyTo.platform))] ?? "#888" }} className="shrink-0 flex items-center">
              <PlatformIcon platform={replyTo.platform} size="0.85em" />
            </span>
          )}
          <span className="text-muted shrink-0">↩ Replying to</span>
          <span className="text-strong font-medium shrink-0">{normalizeUsername(replyTo.username)}</span>
          <span className="text-muted truncate flex-1"><RedactedQuote text={[...replyTo.message].slice(0, 60).join("")} /></span>
          <button type="button" onClick={onClearReply} onMouseDown={keepFocus} aria-label="Cancel reply" className="shrink-0 text-muted hover:text-strong transition-colors">✕</button>
        </div>
      )}

      {/* THE ROW. One gap, one control height, one filled button.
          ─────────────────────────────────────────────────────────────────────
          [pfp] [dest]   ( message…        ☺ )   [+] [➤]

          The two controls that act on the OUTGOING message — add-to-message and
          send — sit together at the end of the row. Identity and destination
          lead it; the text sits between them.

          Everything that is not the field is a circle of the same diameter
          (lib/composerControls), so one row never mixes control sizes. The
          field is a WELL (surface-1, sunk); the controls are RAISED (surface-2,
          outlined). Exactly one is filled — send — so the primary action is
          obvious without reading anything. */}
      {/* minHeight pins the ROW to the derived control diameter, so the bar
          does not shift 1-2px when the first letter arrives (the
          composing-collapse border/width changes can let the tallest child
          dip by a hair). min-, not fixed: a multi-line field still grows. */}
      <div
        className="flex items-center min-w-0"
        style={{ gap: "var(--composer-gap)", minHeight: "var(--composer-ctl)" }}
      >
        {/* The earn chip anchors to the viewer's OWN avatar — the one surface
            in the composer that is unambiguously "you", which is what makes
            "+2q upvoted" read as something that happened to you rather than a
            notice about the stream. `relative` exists only to be its
            positioned ancestor; inline-flex keeps the span exactly the
            avatar's box so the row's gap is unchanged. */}
        <span className="relative inline-flex">
          <UserMenu
            matrixId={matrixId}
            canonicalId={canonicalId}
            onShowTimestampsChange={onShowTimestampsChange}
            onShowMatrixNameChange={onShowMatrixNameChange}
            isPopout={isPopout}
          />
          <EarnChip />
        </span>
        {ConsoleHost && <ConsoleHost
          viewer={viewer}
          name={matrixId ? formatMxid(matrixId) : "guest"}
          signedIn={!!matrixId}
          roles={[...(isAdmin ? ["admin"] : []), ...(isMod ? ["mod"] : []), ...(canEncrypt === true ? ["supporter"] : [])]}
          onShowTimestampsChange={onShowTimestampsChange}
          onShowMatrixNameChange={onShowMatrixNameChange}
        />}

        {/* Destination: a persistent MODE, so its value has to be readable at a
            glance without opening anything. Folds while composing — the send
            button carries the colour so the audience is still visible. */}
        <span className="composer-collapsible" data-collapsed={composing ? "true" : "false"}>
          <SendToButton destCycle={destCycle} forcedDest={forcedDest} onPick={setDest} onDisarm={resetDest} onRetry={retryDestination} refusals={refusalStates}
            binding={binding?.kind === "sendTo" ? { face: binding.face, release: () => releaseComposer(binding.windowId) } : null} />
        </span>

        {showPollComposer && <PollComposer onClose={() => setShowPollComposer(false)} />}

        <ChatComposerField
          value={input}
          onChange={onComposerChange}
          onKeyDown={handleKeyDown}
          onSelect={() => { onSelectionChange(); syncCaret(); }}
          inputRef={inputRef}
          emotes={emotes}
          personalEmotes={personalEmoteMap}
          personalNeedsRelink={personalNeedsRelink}
          maxLength={charLimit}
          counterMax={charLimit}
          placeholder="Send a message…"
          note={refusal ? { text: refusal.text, forms: refusal.forms, onDismiss: () => dismissRefusalNote(refusal.id) } : null}
          showEmotePicker={showEmotePicker}
          setShowEmotePicker={setShowEmotePicker}
          focusAfterPick="fine-pointer"
          expanded={composing}
          // The field carries the destination too, not just the send button.
          // It matters most exactly when the `send to:` button is folded away
          // — while composing, the two ends of the row are then the only
          // things saying where the message is going.
          accentColor={accent}
          onFocus={onFieldFocus}
          onBlur={onFieldBlur}
          combobox={composerCombobox}
        />

        {/* Only while support is LIVE — an indicator you can dismiss, never a way in. It sits
            with the composer's other icon controls (tools, send) rather than apart from them on
            the left. Closing routes through the sidebar's `closeSupport` when present so the
            thread resets and any pending reminder dismissal is posted; `leaveSupport` alone is
            the embed fallback. */}
        {supportArmed && (
          <SupportButton onLeave={() => (onSupportClose ? onSupportClose() : leaveSupport())} />
        )}

        {/* Message tools — outside the field and on the RIGHT, paired with
            send rather than leading the row. The two controls that act on the
            outgoing message sit together at the end of it. */}
        <ComposerToolsPopover
          matrixId={matrixId}
          spendMode={spendMode}
          setSpendMode={setSpendMode}
          highlightPrice={highlightPrice}
          ttsPrice={ttsPrice}
          replyTo={replyTo}
          onOpenPoll={() => setShowPollComposer(true)}
          stickerBusy={stickerBusy}
          stickerPrice={stickerPrice}
          sendSticker={sendSticker}
          // deliberately the UNMERGED catalog: sticker spends must not render from a per-user set
          emotes={emotes}
          collapsed={composing}
          canEncrypt={canEncrypt}
          encryptArmed={encryptArmed}
          // Toggling OFF restores what the lock displaced (resetDest). This is
          // not a guess: the arm captured the exact prior destination. Choosing
          // native here instead (`setDest(null)`) would PERSIST an explicit
          // "native" the user never picked, which would then block their "all"
          // default on every later load.
          onToggleEncrypt={() => (encryptArmed ? resetDest() : setDest(ENCRYPTED_DEST))}
        />


        {/* The send BUTTON keeps the keyboard, the same way Enter does. It is
            the most-used control on the phone — if tapping send dropped the
            keyboard, every next message would cost an extra tap to start.
            There is no submit-side cost: preventing the mousedown default does
            not touch form submission, which fires on click. */}
        <button
          type="submit"
          onMouseDown={keepFocus}
          disabled={sending || !input.trim() || slowActive || spendBlocked}
          title={
            slowActive ? `Slow mode — ${slowRemaining}s`
            : spendBlocked ? `Not enough ${currencyName()} — top up or cancel`
            : undefined
          }
          // The one FILLED control in the row.
          className="tap-press chat-send-btn shrink-0 inline-flex items-center justify-center rounded-full text-on-accent disabled:opacity-30 hover:brightness-110 transition-[filter,background-color]"
          style={{ ...ctlBox, backgroundColor: sendBtnColor }}
          aria-label="Send"
        >
          {/* The glyph changes too, not just the colour — the destination
              button is folded away while composing, so this is the only signal
              left, and it must survive a colour-blind reader. */}
          {encryptArmed
            ? <Lock size={CTL_ICON} weight="fill" />
            : <PaperPlaneRight size={CTL_ICON} weight="fill" />}
        </button>
      </div>

    </form>
  );
}
