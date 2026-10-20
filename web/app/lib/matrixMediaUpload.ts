import { getMatrixSession, type MatrixSession } from "@/app/lib/matrixSession";
import { homeserverFetch } from "@/app/lib/homeserverFetch";
import { readJsonCapped } from "@/app/lib/boundedBody";
import { hasValidImageMagic, sniffImageMime } from "@/app/lib/imageMagic";
import { MXC_RE } from "@/app/lib/matrixHtml";
import type { createCooldown } from "@/app/lib/rateLimit";
import type { NextRequest } from "next/server";

// Shared pipeline for the Matrix-media-backed image upload routes
// (/api/avatar/upload, /api/banner/upload): session, cooldown, declared-size
// pre-check, magic-byte validation, SSRF-safe homeserverFetch upload to the
// session's OWN homeserver's media repo (a federated account's token is only
// valid there), and the mxc:// shape guard. The routes keep only their
// route-specific persistence (Matrix profile write / site.users row).

export type MediaUploadResult =
  | { ok: true; mx: MatrixSession; contentUri: string }
  | { ok: false; response: Response };

export async function uploadImageToMatrixMedia(
  req: NextRequest,
  {
    field,
    maxBytes,
    cooldown,
  }: {
    /** Multipart field name — also the fallback filename stem. */
    field: string;
    maxBytes: number;
    /** Per-route instance, so e.g. an avatar upload doesn't spend the banner slot. */
    cooldown: ReturnType<typeof createCooldown>;
  }
): Promise<MediaUploadResult> {
  const mx = await getMatrixSession().catch(() => null);
  if (!mx) return { ok: false, response: new Response("Unauthorized", { status: 401 }) };

  if (cooldown.hit(mx.matrixId)) {
    return {
      ok: false,
      response: new Response("Too Many Requests — wait 60s between uploads", { status: 429 }),
    };
  }

  const maxMb = Math.round(maxBytes / (1024 * 1024));
  // Reject on the declared size BEFORE req.formData() materializes the whole
  // multipart body in memory. App Router route handlers have no default body cap
  // (that was a Pages-API setting) and there is no middleware, so without this an
  // oversized upload is fully buffered on the single web process before the
  // size check below runs. Cloudflare's edge caps bodies at ~100 MB so this is
  // bounded, but a Content-Length pre-check turns "buffer 100 MB then reject" into
  // an immediate 413. A lying/absent Content-Length still falls through to the
  // post-parse size check below.
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > maxBytes + 1024 * 1024) {
    return {
      ok: false,
      response: new Response(`Payload too large — max ${maxMb} MB`, { status: 413 }),
    };
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get(field);
  if (!file || !(file instanceof Blob)) {
    return { ok: false, response: new Response("No file", { status: 400 }) };
  }

  if (file.size > maxBytes) {
    return { ok: false, response: new Response(`Max ${maxMb} MB`, { status: 400 }) };
  }

  const buffer = await file.arrayBuffer();
  if (!hasValidImageMagic(new Uint8Array(buffer))) {
    return { ok: false, response: new Response("Images only (PNG, JPEG, GIF, WebP)", { status: 400 }) };
  }

  // Derive MIME from magic bytes rather than trusting the client-provided type
  const mime = sniffImageMime(new Uint8Array(buffer));
  const fileName = file instanceof File ? file.name : `${field}.png`;

  // Upload to the session's own homeserver's media repo. This request SENDS megabytes, so it gets a
  // longer deadline than the 10 s default — still one that covers the whole exchange, so a
  // homeserver that stalls (or trickles its answer) cannot hold the route. The answer is one
  // content_uri: a few dozen bytes, read under a 4 KiB cap.
  const upload = await homeserverFetch(
    `${mx.homeserver}/_matrix/media/v3/upload?filename=${encodeURIComponent(fileName)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${mx.accessToken}`, "Content-Type": mime },
      body: buffer,
      timeoutMs: 30_000,
    }
  ).catch(() => null);
  if (!upload?.ok) {
    void upload?.body?.cancel().catch(() => {});
    return { ok: false, response: new Response("Upload failed", { status: 502 }) };
  }
  const { content_uri } = ((await readJsonCapped(upload, 4 * 1024)) ?? {}) as { content_uri?: string };
  // A federated homeserver's response is user-influenced — never persist a content_uri that is not
  // a well-formed mxc URL. It feeds the media-proxy URL builders (matrixMedia.ts), and a prefix
  // check let `mxc://../..\..\api\x` through to become a same-origin /api request.
  if (typeof content_uri !== "string" || !MXC_RE.test(content_uri)) {
    return {
      ok: false,
      response: new Response("Homeserver returned an invalid media URI", { status: 502 }),
    };
  }

  return { ok: true, mx, contentUri: content_uri };
}
