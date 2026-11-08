"use client";

import React, { useRef, useState, useEffect, useCallback } from "react";
import { EventType } from "matrix-js-sdk";
import type { MatrixClient, Room, TimelineEvents } from "matrix-js-sdk";
import { useEmotes } from "@/app/lib/useEmotes";
import { useEmoteAutocomplete } from "@/app/lib/useEmoteAutocomplete";
import { useMatrixClient } from "@/app/lib/MatrixClientContext";
import { isEncryptedRoom } from "@/app/lib/matrixRooms";
import { encryptAttachment } from "@/app/lib/matrixEncryptAttachment";
import { threadRelation } from "@/app/lib/matrixThreads";
import { pickMsgtype, probeMediaInfo, uploadLimitBytes, tooLargeNote, uploadFailedNote } from "@/app/lib/mediaInfo";
import { EmoteCompletionList } from "./EmoteCompletionList";
import { ChatComposerField } from "./ChatComposerField";
import UserMenu from "./UserMenu";
import { File as FileIcon, Paperclip, PaperPlaneRight, X } from "@phosphor-icons/react/dist/ssr";
import { ctlBox, ctlClass, CTL_ICON } from "@/app/lib/composerControls";
import { keepFocus } from "@/app/lib/keepFocus";
import { CHAT_FONT_SM } from "@/app/lib/chatFont";
import { useSetting } from "@/app/lib/useSetting";

const MAX_STAGED = 10;
type StagedFile = { id: number; file: File };
const NO_FILES: StagedFile[] = [];
let stagedSeq = 0;

/**
 * Upload one file and build its message: `body` is the caption when there is
 * one, else the file name; `filename` always names the file. Encrypted rooms
 * upload ciphertext and carry the key in `file` (no plaintext `url`).
 */
async function uploadAttachment(client: MatrixClient, room: Room, file: File, caption: string): Promise<Record<string, unknown>> {
  const msgtype = pickMsgtype(file.type);
  const info: Record<string, unknown> = { mimetype: file.type, size: file.size, ...(await probeMediaInfo(file)) };
  const base = { msgtype, body: caption || file.name, filename: file.name, info };
  if (isEncryptedRoom(room)) {
    const { data, file: encMeta } = await encryptAttachment(await file.arrayBuffer());
    const up = await client.uploadContent(
      new Blob([data], { type: "application/octet-stream" }),
      { name: file.name, type: "application/octet-stream", includeFilename: false }
    );
    return { ...base, file: { ...encMeta, url: up.content_uri } };
  }
  const up = await client.uploadContent(file, { name: file.name, type: file.type });
  return { ...base, url: up.content_uri };
}

/** A staged file: a thumbnail for a picture, the name for anything else, and its ✕. */
function StagedChip({ file, onRemove }: { file: File; onRemove: () => void }) {
  const isImage = file.type.startsWith("image/");
  const imgRef = useRef<HTMLImageElement>(null);
  // The preview URL lives exactly as long as the chip: made and revoked by one effect.
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const url = URL.createObjectURL(file);
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <li data-attachment-chip={file.name} title={file.name} className="relative shrink-0 rounded-lg bg-surface-2 border border-edge">
      {isImage ? (
        <img ref={imgRef} alt={file.name} className="block h-16 w-16 rounded-lg object-cover" />
      ) : (
        <span className="flex h-16 w-32 items-center gap-1.5 px-2 text-secondary" style={{ fontSize: CHAT_FONT_SM }}>
          <FileIcon size={18} weight="bold" className="shrink-0" />
          <span className="truncate">{file.name}</span>
        </span>
      )}
      {/* The corner is placed by the span: tap-hit-44 sets position on the button itself. */}
      <span className="absolute -top-1.5 -right-1.5">
        <button
          type="button"
          onClick={onRemove}
          onMouseDown={keepFocus}
          aria-label={`Remove ${file.name}`}
          title="Remove"
          className="tap-hit-44 flex h-5 w-5 items-center justify-center rounded-full bg-surface-3 border border-edge text-strong hover:brightness-110"
        >
          <X size={12} weight="bold" />
        </button>
      </span>
    </li>
  );
}

export function MatrixInput({
  value,
  onChange,
  onSubmit,
  onEscape,
  placeholder,
  disabled,
  inputRef: externalRef,
  isSignedIn,
  hideUserMenu,
  railBeside = false,
  room,
  thread,
  onSent,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onEscape?: () => void;
  placeholder?: string;
  disabled?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  isSignedIn?: boolean;
  /** Split view: the live chat column already shows the user settings. */
  hideUserMenu?: boolean;
  /** The Community rail is docked beside this box (modes 2 and 3): its profile tile opens the same
   *  card, so the box draws no second one (#255). The UserMenu stays mounted headless — it is the
   *  hub that answers the tile and every other bb:open-* sender. */
  railBeside?: boolean;
  /** Current room — enables attachments (encrypted rooms upload ciphertext). */
  room?: Room;
  /**
   * The thread this box replies in (the thread panel, the forum Reply dialog).
   * Every file then carries the m.thread relation a typed reply carries; the
   * first falls back to `latestId()` (read at send time), each later one to
   * the file sent before it. Absent: the main channel, no relation.
   */
  thread?: { rootId: string; latestId: () => string };
  /** Staged files all went: the last posted event (a failed send reports nothing). */
  onSent?: (eventId: string) => void;
}) {
  const emotes = useEmotes();
  const { client } = useMatrixClient();
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = externalRef ?? internalRef;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showEmotePicker, setShowEmotePicker] = useState(false);
  // Community › Return key (settingsRegistry communityReturnKey; default "send").
  const newlineMode = useSetting("chatStyle_mxReturnKey") === "newline";
  // Same rule as the live-chat composer: expanded = focused AND has text, so a
  // draft you have clicked away from hands its space back.
  const [focused, setFocused] = useState(false);
  const composing = focused && value.trim().length > 0;
  const [uploading, setUploading] = useState(false);
  // Attachments work in both unencrypted channels and E2EE DMs: in encrypted
  // rooms the bytes are AES-CTR encrypted client-side before upload.
  const canUpload = !!room && !!client;
  // Staged files and the note belong to the room — and the thread — they were
  // made in: changing either drops them (reset during render, so the new place
  // never paints them). The thread panel is reused across roots, not remounted.
  const scope = room ? (thread ? `${room.roomId}\u0000${thread.rootId}` : room.roomId) : null;
  const [stage, setStage] = useState<{ scope: string | null; files: StagedFile[] }>({ scope, files: [] });
  const [noteState, setNoteState] = useState<{ scope: string | null; forms: string[] } | null>(null);
  const [seenScope, setSeenScope] = useState(scope);
  if (seenScope !== scope) {
    setSeenScope(scope);
    setStage({ scope, files: [] });
    setNoteState(null);
  }
  const staged = stage.scope === scope ? stage.files : NO_FILES;
  const noteForms = noteState && noteState.scope === scope ? noteState.forms : null;
  const noteText = noteForms?.[0] ?? null;
  // The field shows its note only while empty; with a draft kept (a caption
  // whose upload failed) the same line sits under the chips instead.
  const fieldNote = noteText && !value ? { text: noteText, forms: noteForms ?? undefined, onDismiss: () => setNoteState(null) } : null;
  const lineNote = noteText && value ? noteText : null;

  const {
    overlayMatches, overlaySel,
    isMentionMode, hoverSelect, applyOverlayItem,
    handleOverlayKeyDown, onSelectionChange, clearOverlayState,
  } = useEmoteAutocomplete({
    value,
    setValue: onChange,
    emotes,
    inputRef,
  });

  const stageFiles = useCallback(
    async (picked: File[]) => {
      if (!client || !scope || picked.length === 0) return;
      const limit = await uploadLimitBytes(client);
      const fits = limit == null ? picked : picked.filter((f) => f.size <= limit);
      const add = fits.slice(0, Math.max(0, MAX_STAGED - staged.length)).map((file) => ({ id: ++stagedSeq, file }));
      if (limit != null && fits.length < picked.length) setNoteState({ scope, forms: tooLargeNote(limit) });
      else if (add.length < fits.length) setNoteState({ scope, forms: [`Up to ${MAX_STAGED} files at a time`] });
      else setNoteState(null);
      if (add.length === 0) return;
      setStage((s) => ({ scope, files: [...(s.scope === scope ? s.files : []), ...add].slice(0, MAX_STAGED) }));
    },
    [client, scope, staged.length]
  );

  const unstage = useCallback((forScope: string, id: number) => {
    setStage((s) => (s.scope === forScope ? { ...s, files: s.files.filter((f) => f.id !== id) } : s));
  }, []);

  // Enter or Send with files staged: the first file carries the text as its
  // caption, the others go bare. An upload that fails stops here and keeps that
  // file (and the text, if it was not sent yet) for the next Send.
  const sendStaged = useCallback(
    async (text: string) => {
      if (!client || !room || !scope || uploading) return;
      const target = room;
      const at = scope;
      const files = staged;
      setUploading(true);
      setNoteState(null);
      let caption = text.trim();
      // In a thread, the first file falls back to the thread's newest event and
      // each later one to the file before it, so plain clients keep them in order.
      let fallback = thread ? thread.latestId() : null;
      let lastId: string | null = null;
      try {
        for (const { id, file } of files) {
          let content: Record<string, unknown>;
          try {
            content = await uploadAttachment(client, target, file, caption);
          } catch (e) {
            console.error("[Matrix] upload failed", e);
            setNoteState({ scope: at, forms: uploadFailedNote(file.name) });
            return;
          }
          if (thread && fallback) content["m.relates_to"] = threadRelation(thread.rootId, fallback);
          unstage(at, id);
          if (caption) { caption = ""; onChange(""); }
          // A send that fails stays in the timeline as "Not sent" with Retry (localEcho.ts).
          const res = await client
            .sendEvent(target.roomId, EventType.RoomMessage, content as unknown as TimelineEvents[EventType.RoomMessage])
            .catch((e: unknown) => { console.error("[Matrix] attachment send failed", e); return null; });
          if (res?.event_id) { lastId = res.event_id; fallback = res.event_id; }
        }
        if (lastId) onSent?.(lastId);
      } finally {
        setUploading(false);
      }
    },
    [client, room, scope, thread, uploading, staged, unstage, onChange, onSent]
  );

  // Paste stages too: every file on the clipboard, not only the first.
  useEffect(() => {
    const el = inputRef.current;
    if (!el || !canUpload) return;
    function onPaste(e: ClipboardEvent) {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((it) => it.kind === "file")
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f);
      if (files.length) { e.preventDefault(); void stageFiles(files); }
    }
    el.addEventListener("paste", onPaste);
    return () => el.removeEventListener("paste", onPaste);
  }, [inputRef, canUpload, stageFiles]);

  function submit() {
    clearOverlayState();
    setShowEmotePicker(false);
    if (staged.length) void sendStaged(value);
    else onSubmit();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && showEmotePicker) { setShowEmotePicker(false); return; }
    if (handleOverlayKeyDown(e)) return;
    if (e.key === "Escape" && onEscape) { onEscape(); return; }
    if (e.key === "Enter" && !e.shiftKey) {
      // New-line mode: Enter keeps its own action (a line); Ctrl/⌘+Enter sends.
      if (newlineMode && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      submit();
      return;
    }
  }

  return (
    <div className="relative">
      {/* Unified emote autocomplete overlay */}
      {overlayMatches.length > 0 && (
        <EmoteCompletionList
          matches={overlayMatches}
          selected={overlaySel}
          onSelect={applyOverlayItem}
          onChangeSelected={hoverSelect}
          isMention={isMentionMode}
          listboxId="matrix-emote-listbox"
        />
      )}

      {/* minHeight mirrors the live-chat row — see ChatInput: pins the bar
          against the composing-collapse 1-2px dip on the first typed letter. */}
      <div className={`flex ${staged.length ? "items-end" : "items-center"} min-w-0`} style={{ gap: "var(--composer-gap)", minHeight: "var(--composer-ctl)" }}>
        {isSignedIn && !hideUserMenu && <UserMenu button={!railBeside} />}
        {canUpload && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                e.target.value = "";
                void stageFiles(picked);
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onMouseDown={keepFocus}
              disabled={disabled || uploading}
              title="Attach a file"
              aria-label="Attach a file"
              // Same size and skin as every other composer control
              // (lib/composerControls).
              className={`composer-collapsible ${ctlClass(false)} ${uploading ? "animate-pulse" : ""}`}
              data-collapsed={composing ? "true" : "false"}
              style={ctlBox}
            >
              <Paperclip size={CTL_ICON} weight="bold" />
            </button>
          </>
        )}
        <ChatComposerField
          value={value}
          onChange={onChange}
          onKeyDown={handleKeyDown}
          onSelect={onSelectionChange}
          inputRef={inputRef}
          emotes={emotes}
          maxLength={2000}
          placeholder={placeholder}
          disabled={disabled}
          showEmotePicker={showEmotePicker}
          setShowEmotePicker={setShowEmotePicker}
          expanded={composing}
          enterKeyHint={newlineMode ? "enter" : "send"}
          note={fieldNote}
          attachments={(staged.length && scope) || lineNote ? (
            <>
              {staged.length > 0 && scope && (
                <ul className="flex gap-2 overflow-x-auto pt-1.5 pr-1.5" aria-label="Files to send">
                  {staged.map((f) => (
                    <StagedChip key={f.id} file={f.file} onRemove={() => unstage(scope, f.id)} />
                  ))}
                </ul>
              )}
              {lineNote && (
                <p data-attachment-note role="status" className="mt-1 px-1 text-secondary" style={{ fontSize: CHAT_FONT_SM }}>
                  {lineNote}
                </p>
              )}
            </>
          ) : null}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          combobox={{
            expanded: overlayMatches.length > 0,
            controls: overlayMatches.length > 0 ? "matrix-emote-listbox" : undefined,
            activeDescendant: overlayMatches.length > 0 ? `matrix-emote-listbox-opt-${overlaySel}` : undefined,
          }}
        />
        {/* self-stretch: follows the input bar's height as the font grows */}
        {/* Keeps the keyboard, like the live-chat send button — same R-11 call,
            and the two composers are held to parity on purpose. */}
        <button
          type="button"
          onClick={submit}
          onMouseDown={keepFocus}
          disabled={disabled || uploading || (!value.trim() && !staged.length)}
          className="tap-press chat-send-btn shrink-0 inline-flex items-center justify-center disabled:opacity-30 rounded-full text-on-accent hover:brightness-110 transition-[filter,background-color]"
          style={{ ...ctlBox, backgroundColor: "var(--accent)" }}
          aria-label="Send"
          // New-line mode has no Return-to-send, so the arrow shows whatever the Send-button setting says.
          data-send-button={newlineMode ? "always" : undefined}
        >
          <PaperPlaneRight size={CTL_ICON} weight="fill" />
        </button>
      </div>

    </div>
  );
}
