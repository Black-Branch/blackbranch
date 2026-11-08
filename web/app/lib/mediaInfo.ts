// What the composer needs to know about a file before it posts it: which
// Matrix msgtype it is, the `info` a reader's client lays it out with, and the
// homeserver's upload limit. SDK type-only.
import type { MatrixClient } from "matrix-js-sdk";
import { probeImageDims } from "./imageDims.ts";

export type AttachmentMsgtype = "m.image" | "m.video" | "m.audio" | "m.file";

/** The msgtype a file posts as: a video plays and audio has a player, rather than a download chip. */
export function pickMsgtype(mime: string): AttachmentMsgtype {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return "m.image";
  if (m.startsWith("video/")) return "m.video";
  if (m.startsWith("audio/")) return "m.audio";
  return "m.file";
}

export type MediaInfo = { w?: number; h?: number; duration?: number };

// A file the browser cannot decode never fires loadedmetadata or error on some engines; the post must not wait on it.
const PROBE_TIMEOUT_MS = 3000;

function probeMetadata(file: File, tag: "video" | "audio"): Promise<MediaInfo | null> {
  return new Promise((resolve) => {
    const el = document.createElement(tag);
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (v: MediaInfo | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeAttribute("src");
      URL.revokeObjectURL(url);
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    el.preload = "metadata";
    el.muted = true;
    el.onloadedmetadata = () => {
      const out: MediaInfo = {};
      if (Number.isFinite(el.duration) && el.duration > 0) out.duration = Math.round(el.duration * 1000);
      if ("videoWidth" in el && el.videoWidth > 0 && el.videoHeight > 0) {
        out.w = el.videoWidth;
        out.h = el.videoHeight;
      }
      finish(out);
    };
    el.onerror = () => finish(null);
    el.src = url;
  });
}

/**
 * The `info` fields read from the file itself: pixel size for images and video,
 * duration (ms, as the spec has it) for video and audio. null when it cannot be read.
 */
export async function probeMediaInfo(file: File): Promise<MediaInfo | null> {
  const kind = pickMsgtype(file.type);
  if (kind === "m.image") return probeImageDims(file);
  if (kind === "m.video") return probeMetadata(file, "video");
  if (kind === "m.audio") return probeMetadata(file, "audio");
  return null;
}

const limitCache = new WeakMap<MatrixClient, Promise<number | null>>();

/**
 * The homeserver's `m.upload.size`, asked once per client. null = the server did
 * not say; a failed ask is not kept, so the next pick asks again.
 */
export function uploadLimitBytes(client: MatrixClient): Promise<number | null> {
  const hit = limitCache.get(client);
  if (hit) return hit;
  const ask = client
    .getMediaConfig(true)
    .then((c) => {
      const n = c["m.upload.size"];
      return typeof n === "number" && n > 0 ? n : null;
    })
    .catch(() => {
      limitCache.delete(client);
      return null;
    });
  limitCache.set(client, ask);
  return ask;
}

/**
 * The two composer notes, longest first: the field shows the longest form that
 * fits (ChatComposerField `note.forms`), the first is the whole sentence.
 * "Too large — the limit is N MB", N in whole MB rounded down.
 */
export function tooLargeNote(limitBytes: number): string[] {
  const mb = Math.floor(limitBytes / (1024 * 1024));
  return [`Too large — the limit is ${mb} MB`, `Too large — ${mb} MB max`, `Over ${mb} MB`];
}

/** "Couldn't upload <name> — try again". */
export function uploadFailedNote(name: string): string[] {
  return [`Couldn't upload ${name} — try again`, "Couldn't upload — try again", "Upload failed"];
}

/**
 * The file's name: `filename` when the sender set it (then `body` may be a
 * caption), else `body`.
 */
export function attachmentName(content: Record<string, unknown>, fallback: string): string {
  if (typeof content.filename === "string" && content.filename) return content.filename;
  return typeof content.body === "string" && content.body ? content.body : fallback;
}

/** The caption of a media message: `body` when a `filename` is set and differs from it. */
export function attachmentCaption(body: unknown, filename: unknown): string | null {
  if (typeof filename !== "string" || !filename || typeof body !== "string") return null;
  const text = body.trim();
  return text && body !== filename ? body : null;
}
