"use client";

import React, { useRef, useState, useEffect, useCallback } from "react";
import { EventType } from "matrix-js-sdk";
import type { Room, TimelineEvents } from "matrix-js-sdk";
import { useEmotes } from "@/app/lib/useEmotes";
import { useEmoteAutocomplete } from "@/app/lib/useEmoteAutocomplete";
import { useMatrixClient } from "@/app/lib/MatrixClientContext";
import { isEncryptedRoom } from "@/app/lib/matrixRooms";
import { encryptAttachment } from "@/app/lib/matrixEncryptAttachment";
import { probeImageDims } from "@/app/lib/imageDims";
import { EmoteCompletionList } from "./EmoteCompletionList";
import { ChatComposerField } from "./ChatComposerField";
import UserMenu from "./UserMenu";
import { Paperclip, PaperPlaneRight } from "@phosphor-icons/react/dist/ssr";
import { ctlBox, ctlClass, CTL_ICON } from "@/app/lib/composerControls";
import { keepFocus } from "@/app/lib/keepFocus";
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
  room,
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
  /** Current room — enables file upload (unencrypted rooms only for now). */
  room?: Room;
}) {
  const emotes = useEmotes();
  const { client } = useMatrixClient();
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = externalRef ?? internalRef;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showEmotePicker, setShowEmotePicker] = useState(false);
  // Same rule as the live-chat composer: expanded = focused AND has text, so a
  // draft you have clicked away from hands its space back.
  const [focused, setFocused] = useState(false);
  const composing = focused && value.trim().length > 0;
  const [uploading, setUploading] = useState(false);
  // Attachments work in both unencrypted channels and E2EE DMs: in encrypted
  // rooms the bytes are AES-CTR encrypted client-side before upload.
  const canUpload = !!room && !!client;

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

  const uploadFile = useCallback(
    async (file: File) => {
      if (!client || !room || uploading) return;
      setUploading(true);
      try {
        const isImage = file.type.startsWith("image/");
        const info: Record<string, unknown> = { mimetype: file.type, size: file.size };
        if (isImage) {
          const dims = await probeImageDims(file);
          if (dims) { info.w = dims.w; info.h = dims.h; }
        }
        const msgtype = isImage ? "m.image" : "m.file";

        if (isEncryptedRoom(room)) {
          // E2EE room: encrypt the bytes, upload the ciphertext, and carry the
          // key/iv/hash in the message's `file` field (no plaintext `url`).
          const { data, file: encMeta } = await encryptAttachment(await file.arrayBuffer());
          const up = await client.uploadContent(
            new Blob([data], { type: "application/octet-stream" }),
            { name: file.name, type: "application/octet-stream", includeFilename: false }
          );
          const mxc: string = up.content_uri;
          await client.sendEvent(room.roomId, EventType.RoomMessage, {
            msgtype,
            body: file.name,
            file: { ...encMeta, url: mxc },
            info,
          } as unknown as TimelineEvents[EventType.RoomMessage]);
        } else {
          const up = await client.uploadContent(file, { name: file.name, type: file.type });
          const mxc: string = up.content_uri;
          await client.sendEvent(room.roomId, EventType.RoomMessage, {
            msgtype,
            body: file.name,
            url: mxc,
            info,
          } as unknown as TimelineEvents[EventType.RoomMessage]);
        }
      } catch (e) {
        console.error("[Matrix] upload failed", e);
      } finally {
        setUploading(false);
      }
    },
    [client, room, uploading]
  );

  // Paste-to-upload: catch image data on the composer.
  useEffect(() => {
    const el = inputRef.current;
    if (!el || !canUpload) return;
    function onPaste(e: ClipboardEvent) {
      const file = Array.from(e.clipboardData?.items ?? [])
        .find((it) => it.kind === "file")
        ?.getAsFile();
      // Don't preventDefault while an upload is in flight — uploadFile would
      // bail on its `uploading` guard and the paste would be silently eaten.
      if (file && !uploading) { e.preventDefault(); uploadFile(file); }
    }
    el.addEventListener("paste", onPaste);
    return () => el.removeEventListener("paste", onPaste);
    // `uploading` is listed because onPaste READS it. It was already correct in
    // practice — uploadFile depends on `uploading` too, so its identity changes and
    // this effect re-runs — but that made the correctness incidental: dropping
    // `uploading` from uploadFile's deps would leave this closure with a stale value
    // and silently eat pastes, the exact failure the guard above exists to prevent.
  }, [inputRef, canUpload, uploadFile, uploading]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && showEmotePicker) { setShowEmotePicker(false); return; }
    if (handleOverlayKeyDown(e)) return;
    if (e.key === "Escape" && onEscape) { onEscape(); return; }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      clearOverlayState();
      setShowEmotePicker(false);
      onSubmit();
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
      <div className="flex items-center min-w-0" style={{ gap: "var(--composer-gap)", minHeight: "var(--composer-ctl)" }}>
        {isSignedIn && !hideUserMenu && <UserMenu />}
        {canUpload && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadFile(f);
                e.target.value = "";
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
          onClick={() => { clearOverlayState(); setShowEmotePicker(false); onSubmit(); }}
          onMouseDown={keepFocus}
          disabled={disabled || !value.trim()}
          className="tap-press chat-send-btn shrink-0 inline-flex items-center justify-center disabled:opacity-30 rounded-full text-on-accent hover:brightness-110 transition-[filter,background-color]"
          style={{ ...ctlBox, backgroundColor: "var(--accent)" }}
          aria-label="Send"
        >
          <PaperPlaneRight size={CTL_ICON} weight="fill" />
        </button>
      </div>

    </div>
  );
}
