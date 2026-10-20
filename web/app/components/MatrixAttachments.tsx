"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { decryptAttachment, type EncryptedFile } from "@/app/lib/matrixEncryptAttachment";
import { Download } from "@phosphor-icons/react/dist/ssr";
import { mxcToScaled, mxcToDownload, onScaledError } from "@/app/lib/matrixMedia";
import { fitMediaBox, MEDIA_BOX_W } from "@/app/lib/mediaFit";
import { blobMediaType } from "@/app/lib/mediaHeaders";
import { videoPlaybackMode } from "@/app/lib/videoPlayback";
import { pushDismissLayer } from "@/app/lib/chrome/dismissStack";

// ─── Lightbox ────────────────────────────────────────────────────────────────

const ZOOM_MIN = 1;
const ZOOM_MAX = 8;

function Lightbox({ src, alt, onClose, downloadName }: { src: string; alt: string; onClose: () => void; downloadName?: string }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // `dragging` mirrors dragRef for render (cursor/transition); the ref keeps the
  // drag-origin coords for the pointer handlers.
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const reset = useCallback(() => { setScale(1); setOffset({ x: 0, y: 0 }); }, []);
  const zoomBy = useCallback(
    (factor: number) => setScale((s) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s * factor))),
    []
  );

  // Panning only makes sense while zoomed; snap back to centre at 1×
  // (render-time adjust, no effect pass).
  if (scale === 1 && (offset.x !== 0 || offset.y !== 0)) setOffset({ x: 0, y: 0 });

  // Esc closes (via the shared LIFO dismiss stack — a lightbox over a panel
  // must close itself first); +/- zoom; 0 resets. Lock body
  // scroll while open.
  useEffect(() => {
    const popLayer = pushDismissLayer(onClose);
    function handler(e: KeyboardEvent) {
      if (e.key === "+" || e.key === "=") zoomBy(1.25);
      else if (e.key === "-" || e.key === "_") zoomBy(0.8);
      else if (e.key === "0") reset();
    }
    document.addEventListener("keydown", handler);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      popLayer();
      document.removeEventListener("keydown", handler);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose, zoomBy, reset]);

  // Native non-passive wheel listener so we can preventDefault the page scroll.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      setScale((s) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s * (e.deltaY < 0 ? 1.15 : 0.87))));
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function onPointerDown(e: React.PointerEvent) {
    if (scale === 1) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    setDragging(true);
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    setOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
  }
  function onPointerUp() { dragRef.current = null; setDragging(false); }

  if (typeof document === "undefined") return null;
  const zoomed = scale > 1;
  const btn =
    "w-9 h-9 flex items-center justify-center rounded-md bg-surface-3 hover:bg-surface-4 text-strong/90 text-lg leading-none transition-colors";
  return createPortal(
    <div
      ref={containerRef}
      className="fixed inset-0 z-(--z-overlay) bg-scrim-heavy flex items-center justify-center overflow-hidden select-none"
      onClick={onClose}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        className={`max-w-[92vw] max-h-[92vh] object-contain rounded ${
          zoomed ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in"
        }`}
        style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, transition: dragging ? "none" : "transform var(--anim-fast) var(--anim-ease)" }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => { e.stopPropagation(); if (zoomed) reset(); else setScale(2.5); }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />

      {/* Toolbar — stops propagation so clicks don't close the overlay */}
      <div
        className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-scrim-heavy ring-1 ring-edge"
        onClick={(e) => e.stopPropagation()}
      >
        <button className={btn} title="Zoom out (−)" onClick={() => zoomBy(0.8)}>−</button>
        <span className="text-strong/60 text-xs tabular-nums w-12 text-center">{Math.round(scale * 100)}%</span>
        <button className={btn} title="Zoom in (+)" onClick={() => zoomBy(1.25)}>+</button>
        <button className={btn} title="Reset (0)" onClick={reset}>⤢</button>
        <a className={btn} title="Download" href={src} download={downloadName ?? alt ?? true} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
          <Download size={17} weight="bold" />
        </a>
      </div>

      <button
        className="absolute top-4 right-4 text-strong/70 hover:text-strong text-2xl leading-none"
        onClick={onClose}
        title="Close (Esc)"
      >
        ✕
      </button>
    </div>,
    document.body
  );
}

// ─── Inline image/sticker (lightbox + GIF) ───────────────────────────────────

// Fetch + AES-CTR-decrypt an EncryptedFile into a blob: object URL (E2EE rooms).
// Returns null until ready; revokes the URL on unmount.
function useDecryptedUrl(file: EncryptedFile | undefined, mimetype?: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return;
    let objUrl: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        const dl = mxcToDownload(file.url);
        if (!dl) return;
        // Raw fetch on purpose: binary body — the http.ts helpers are JSON-only.
        const buf = await (await fetch(dl)).arrayBuffer();
        const plain = await decryptAttachment(buf, file);
        // A blob: URL is same-origin: the sender's type is held to the media allowlist, so an
        // "image" sent as text/html and opened in a new tab is a download, not a page.
        objUrl = URL.createObjectURL(new Blob([plain], { type: blobMediaType(mimetype) }));
        if (cancelled) URL.revokeObjectURL(objUrl);
        else setUrl(objUrl);
      } catch (e) {
        console.error("[Matrix] attachment decrypt failed", e);
      }
    })();
    return () => {
      cancelled = true;
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, [file, mimetype]);
  return url;
}

export function MatrixImage({ content }: { content: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const info = content.info as Record<string, unknown> | undefined;
  const enc = content.file as EncryptedFile | undefined;
  const mxcUrl = (content.url ?? enc?.url) as string | undefined;
  const isGif = info?.mimetype === "image/gif";
  const decUrl = useDecryptedUrl(enc, info?.mimetype as string | undefined);

  // Encrypted images can only be shown after client-side decryption (object URL);
  // plaintext images use the 800×600 SCALE thumbnail (aspect kept, no crop) and
  // GIFs the download so they animate.
  const displayUrl = enc ? decUrl : isGif ? mxcToDownload(mxcUrl) : mxcToScaled(mxcUrl);
  const fullUrl = enc ? decUrl : mxcToDownload(mxcUrl) ?? displayUrl;

  if (enc && !decUrl) return <span className="text-muted italic mt-1 inline-block">🔒 decrypting image…</span>;
  if (!displayUrl) return <span className="text-secondary italic">[image]</span>;
  // The event's info gives the source size; the box is Discord's (fit inside
  // 550×350, never upscale) and is reserved via aspect-ratio before the bitmap
  // loads, so nothing shifts. Without usable dims, fall back to CSS caps.
  const fit = fitMediaBox(info?.w, info?.h);
  const w = Number(info?.w) || undefined;
  const h = Number(info?.h) || undefined;
  return (
    <>
      <img
        src={displayUrl}
        alt={(content.body as string) ?? "image"}
        width={w}
        height={h}
        className="rounded-lg mt-1 cursor-pointer hover:opacity-90 transition-opacity img-shadow-chat"
        style={
          fit
            ? { width: fit.width, aspectRatio: fit.aspect, maxWidth: "100%", height: "auto" }
            : { maxWidth: "min(34rem, 100%)", maxHeight: "26rem", width: "auto", height: "auto" }
        }
        onClick={() => setOpen(true)}
        onError={(e) => onScaledError(e.currentTarget, mxcUrl)}
      />
      {open && fullUrl && (
        <Lightbox src={fullUrl} alt={(content.body as string) ?? "image"} downloadName={content.body as string | undefined} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

// Non-image attachment (m.file) — a download chip. Works for plaintext (direct
// media link) and E2EE files (fetch ciphertext, decrypt, then download locally).
export function MatrixFile({ content }: { content: Record<string, unknown> }) {
  const [busy, setBusy] = useState(false);
  const info = content.info as Record<string, unknown> | undefined;
  const enc = content.file as EncryptedFile | undefined;
  const mxcUrl = (content.url ?? enc?.url) as string | undefined;
  const name = (content.body as string) ?? "file";
  const size = typeof info?.size === "number" ? info.size : undefined;
  const sizeLabel = size ? ` · ${size < 1024 * 1024 ? Math.max(1, Math.round(size / 1024)) + " KB" : (size / (1024 * 1024)).toFixed(1) + " MB"}` : "";

  async function download() {
    if (!enc) {
      const dl = mxcToDownload(mxcUrl);
      if (dl) window.open(dl, "_blank", "noopener");
      return;
    }
    setBusy(true);
    try {
      const dl = mxcToDownload(enc.url);
      if (!dl) return;
      // Raw fetch on purpose: binary body — the http.ts helpers are JSON-only.
      const buf = await (await fetch(dl)).arrayBuffer();
      const plain = await decryptAttachment(buf, enc);
      const url = URL.createObjectURL(
        new Blob([plain], { type: blobMediaType(info?.mimetype) })
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      console.error("[Matrix] file decrypt failed", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={download}
      disabled={busy}
      className="mt-1 inline-flex items-center gap-2 rounded-md bg-surface-1 border border-edge px-2.5 py-1.5 text-body hover:bg-surface-2 transition-colors disabled:opacity-50"
      style={{ fontSize: "var(--text-chat-md)" }}
    >
      <span>{enc ? "🔒" : "📎"}</span>
      <span className="truncate max-w-[14rem]">{name}</span>
      <span className="text-muted">{busy ? "…" : "↓" + sizeLabel}</span>
    </button>
  );
}

// ─── Inline video / audio ────────────────────────────────────────────────────

// Synapse ignores Range on media downloads and our proxy buffers the
// whole body, so there is no such thing as "just the metadata": requesting it
// downloads the entire file. Which videos may fetch before play is pressed is
// decided by videoPlaybackMode (app/lib/videoPlayback.ts): Discord gifs
// loop silently like on Discord, small videos show their first frame, and
// everything else stays preload="none" until the reader presses play.
export function MatrixVideo({ content }: { content: Record<string, unknown> }) {
  const info = content.info as Record<string, unknown> | undefined;
  const enc = content.file as EncryptedFile | undefined;
  const mxcUrl = (content.url ?? enc?.url) as string | undefined;
  const decUrl = useDecryptedUrl(enc, info?.mimetype as string | undefined);
  const src = enc ? decUrl : mxcToDownload(mxcUrl);
  const name = (content.body as string) ?? "video";
  const mode = videoPlaybackMode(info, Boolean(enc));
  if (enc && !decUrl) return <span className="text-muted italic mt-1 inline-block">🔒 decrypting video…</span>;
  if (!src) return <span className="text-secondary italic">[video]</span>;
  if (mode === "loop") return <LoopClip src={src} name={name} info={info} />;
  // Same box rule as images: the source aspect inside Discord's 550×350, never
  // upscaled. No poster — no bridged event carries info.thumbnail_url — so a
  // preview is the video's own first frame: `#t=0.001` makes Safari paint it
  // too (Chrome and Firefox paint it from preload="metadata" alone).
  const fit = fitMediaBox(info?.w, info?.h);
  return (
    <video
      src={mode === "preview" ? `${src}#t=0.001` : src}
      controls
      preload={mode === "preview" ? "metadata" : "none"}
      playsInline
      title={name}
      className="rounded-lg mt-1 block bg-surface-1 img-shadow-chat"
      style={
        fit
          ? { width: fit.width, aspectRatio: fit.aspect, maxWidth: "100%", height: "auto" }
          // A placeholder aspect so the box does not jump from 150px when
          // metadata lands; corrected by the real one once `info` carries dims.
          : { width: `min(${MEDIA_BOX_W}px, 100%)`, aspectRatio: "16 / 9" }
      }
    />
  );
}

// A Discord gif: silent, looping, no controls — the way Discord shows it. It
// plays only while on screen (a chat full of loops must not keep decoding video
// nobody can see — the phone-heat rule, see animFence.ts), and under
// prefers-reduced-motion it never starts on its own. A tap toggles it either way.
function LoopClip({ src, name, info }: { src: string; name: string; info: Record<string, unknown> | undefined }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const io = new IntersectionObserver(([e]) => {
      if (e?.isIntersecting) v.play().catch(() => {});
      else v.pause();
    });
    io.observe(v);
    return () => io.disconnect();
  }, [src]);
  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };
  const fit = fitMediaBox(info?.w, info?.h);
  return (
    <video
      ref={ref}
      src={src}
      muted
      loop
      playsInline
      preload="auto"
      title={name}
      aria-label={name}
      onClick={toggle}
      className="rounded-lg mt-1 block bg-surface-1 img-shadow-chat cursor-pointer"
      style={
        fit
          ? { width: fit.width, aspectRatio: fit.aspect, maxWidth: "100%", height: "auto" }
          : { width: `min(${MEDIA_BOX_W}px, 100%)`, aspectRatio: "16 / 9" }
      }
    />
  );
}

export function MatrixAudio({ content }: { content: Record<string, unknown> }) {
  const info = content.info as Record<string, unknown> | undefined;
  const enc = content.file as EncryptedFile | undefined;
  const mxcUrl = (content.url ?? enc?.url) as string | undefined;
  const decUrl = useDecryptedUrl(enc, info?.mimetype as string | undefined);
  const src = enc ? decUrl : mxcToDownload(mxcUrl);
  const name = (content.body as string) ?? "audio";
  if (enc && !decUrl) return <span className="text-muted italic mt-1 inline-block">🔒 decrypting audio…</span>;
  if (!src) return <span className="text-secondary italic">[audio]</span>;
  return (
    <div className="mt-1 flex flex-col gap-1">
      <span className="text-muted truncate max-w-[22rem]" style={{ fontSize: "var(--text-chat-xs)" }}>🎵 {name}</span>
      <audio src={src} controls preload="none" title={name} className="block max-w-full" />
    </div>
  );
}
