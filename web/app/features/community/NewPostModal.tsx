"use client";

import { CHAT_FONT } from "@/app/lib/chatFont";
import { useState, useRef, useCallback, useEffect } from "react";
import { Window } from "@/app/components/chrome";
import { EventType } from "matrix-js-sdk";
import type { Room, TimelineEvents } from "matrix-js-sdk";
import { useMatrixClient } from "@/app/lib/MatrixClientContext";
import { FORUM_TITLE_KEY, FORUM_TAGS_KEY, FORUM_BODY_KEY } from "@/app/lib/matrixForum";
import { probeImageDims } from "@/app/lib/imageDims";
// Aliased: jsx-a11y treats a component literally named `Image` as an <img>
// and demands an alt prop — this is an icon, not an image.
import { Image as ImageIcon } from "@phosphor-icons/react/dist/ssr";

// New-post composer for forum rooms. A post is a single top-level message (the
// thread root); its replies become the post's comments. Title and tags live in
// custom content fields (FORUM_*_KEY, matrixForum.ts) for clean parsing here, but the
// human-readable `body` is always populated (title, description, #tags) so the
// post still reads correctly in Element/Cinny.

// Parse #hashtags out of free text, deduped, lower-key, capped.
function parseTags(text: string): string[] {
  const raw = [...text.matchAll(/(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N}_-]{1,29})/gu)].map((m) => m[1]!);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    const k = t.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(t); }
    if (out.length >= 8) break;
  }
  return out;
}

export function NewPostModal({
  room,
  onClose,
  onPosted,
  initialTitle = "",
  initialBody = "",
}: {
  room: Room;
  onClose: () => void;
  /** Fired with the new post's event id after a successful send. */
  onPosted?: (eventId: string) => void;
  /** Pre-fill (e.g. from a feed "Suggest"): the title field and the body. */
  initialTitle?: string;
  initialBody?: string;
}) {
  const { client } = useMatrixClient();
  const [title, setTitle] = useState(initialTitle);
  const [bodyText, setBodyText] = useState(initialBody);
  const [tagText, setTagText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => { titleRef.current?.focus(); }, []);

  // tags come from the dedicated tag field plus any #hashtags typed in the body
  const tags = parseTags(`${tagText} ${bodyText}`);

  const pickFile = useCallback((f: File | null) => {
    setFile(f);
    setPreviewUrl((old) => { if (old) URL.revokeObjectURL(old); return f && f.type.startsWith("image/") ? URL.createObjectURL(f) : null; });
  }, []);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  async function submit() {
    const t = title.trim();
    if (!client || !t || busy) return;
    setBusy(true);
    setError(null);
    // Reddit-style: a new post starts auto-upvoted by its author (+1, immutable).
    const seedSelfUpvote = async (eventId: string) => {
      if (!eventId) return;
      try {
        await fetch("/api/forum/vote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomId: room.roomId, eventId, vote: 1 }),
        });
      } catch { /* non-fatal */ }
    };

    try {
      // A pasted link doesn't belong in the title — pull any URLs out of the
      // title and prepend them to the body so the post reads as a link post
      // (the title then inherits the link's OG title on display).
      const urlRe = /(https?:\/\/\S+)/g;
      const titleUrls = t.match(urlRe) ?? [];
      const cleanTitle = titleUrls.length ? t.replace(urlRe, "").replace(/\s+/g, " ").trim() : t;
      // Human-readable fallback body for other Matrix clients.
      const tagLine = tags.length ? "\n\n" + tags.map((x) => `#${x}`).join(" ") : "";
      const desc = [titleUrls.join(" "), bodyText.trim()].filter(Boolean).join("\n\n");
      // Human body: title line (if any) then the description.
      const humanBody = [cleanTitle, desc].filter(Boolean).join("\n\n") + tagLine;

      if (file) {
        // Image post: the root IS the image so the list thumbnail works. The
        // description rides in FORUM_BODY_KEY (body = title as a caption).
        const isImage = file.type.startsWith("image/");
        const info: Record<string, unknown> = { mimetype: file.type, size: file.size };
        if (isImage) {
          const dims = await probeImageDims(file);
          if (dims) { info.w = dims.w; info.h = dims.h; }
        }
        const up = await client.uploadContent(file, { name: file.name, type: file.type });
        const mxc: string = up.content_uri;
        const res = await client.sendEvent(room.roomId, EventType.RoomMessage, {
          msgtype: isImage ? "m.image" : "m.file",
          body: humanBody,
          url: mxc,
          info,
          [FORUM_TITLE_KEY]: cleanTitle,
          [FORUM_TAGS_KEY]: tags,
          ...(desc ? { [FORUM_BODY_KEY]: desc } : {}),
        } as unknown as TimelineEvents[EventType.RoomMessage]);
        const newId = res.event_id;
        await seedSelfUpvote(newId);
        onPosted?.(newId);
      } else {
        const res = await client.sendEvent(room.roomId, EventType.RoomMessage, {
          msgtype: "m.text",
          body: humanBody,
          [FORUM_TITLE_KEY]: cleanTitle,
          [FORUM_TAGS_KEY]: tags,
          ...(desc ? { [FORUM_BODY_KEY]: desc } : {}),
        } as unknown as TimelineEvents[EventType.RoomMessage]);
        const newId = res.event_id;
        await seedSelfUpvote(newId);
        onPosted?.(newId);
      }
      onClose();
    } catch (e) {
      console.error("[Forum] new post failed", e);
      setError("Couldn't post. Try again.");
      setBusy(false);
    }
  }

  return (
    <Window
      presentation="dialog"
      name={`New post in #${room.name || "forum"}`}
      title={`New post in #${room.name || "forum"}`}
      onClose={onClose}
      width={512}
    >
      <div className="p-5 flex flex-col gap-3">
        <input
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={160}
          placeholder="Title"
          className="bg-scrim border border-control rounded-md px-3 py-2 text-heading outline-none focus:border-accent font-semibold"
          style={{ fontSize: "var(--text-chat-lg)", fontFamily: "var(--chat-font-family, inherit)" }}
        />

        <textarea
          value={bodyText}
          onChange={(e) => setBodyText(e.target.value)}
          placeholder="Write something… (use #tags anywhere)"
          rows={5}
          className="bg-scrim border border-control rounded-md px-3 py-2 text-heading outline-none focus:border-accent resize-none"
          style={{ fontSize: CHAT_FONT, fontFamily: "var(--chat-font-family, inherit)", fontWeight: "var(--chat-font-weight, 400)" as React.CSSProperties["fontWeight"] }}
        />

        <input
          value={tagText}
          onChange={(e) => setTagText(e.target.value)}
          placeholder="Tags — #clips #question (optional)"
          className="bg-scrim border border-control rounded-md px-3 py-1.5 text-body outline-none focus:border-accent"
          style={{ fontSize: "var(--text-chat-md)", fontFamily: "var(--chat-font-family, inherit)" }}
        />

        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.map((x) => (
              <span key={x} className="px-1.5 py-0.5 rounded-md bg-accent/15 text-accent font-medium" style={{ fontSize: "var(--text-chat-sm)" }}>
                #{x}
              </span>
            ))}
          </div>
        )}

        {/* Image attach */}
        <div className="flex items-center gap-3">
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
          {previewUrl ? (
            <div className="relative">
              <img src={previewUrl} alt="" className="h-20 w-20 rounded-lg object-cover bg-scrim" />
              <button
                type="button"
                onClick={() => pickFile(null)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-scrim-heavy text-body text-xs flex items-center justify-center hover:bg-black"
              >
                ✕
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 border border-control text-body-dim hover:bg-surface-1 transition-colors"
              style={{ fontSize: "var(--text-chat-md)" }}
            >
              <ImageIcon size={14} weight="bold" />
              Add image
            </button>
          )}
        </div>

        {error && <p className="text-rose-400 text-xs">{error}</p>}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-body-dim hover:bg-surface-1 transition-colors">Cancel</button>
          <button
            onClick={submit}
            disabled={!title.trim() || busy}
            className="rounded-md px-4 py-1.5 text-sm font-semibold text-strong bg-[#5865f2] hover:bg-[#4f5bd5] disabled:opacity-40 transition-colors"
          >
            {busy ? "Posting…" : "Post"}
          </button>
        </div>
      </div>
    </Window>
  );
}
