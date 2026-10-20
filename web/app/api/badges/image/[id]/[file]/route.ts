import { getBadgeSnapshot } from "@/app/lib/badgeCache";
import { badgeImageFile, parseDataImage } from "@/app/lib/badgeImage";

// GET /api/badges/image/<id>/<hash>.<ext> — one site badge's image (see
// app/lib/badgeImage.ts). Content-addressed: the hash is of the stored image, so a URL can be
// cached forever and a changed image gets a new URL. A hash that no longer matches is a 404 with
// no-store, never the new bytes under the old address.
//
// Public, like the badge map: these images already render in chat for everyone.
const NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await params;
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return NOT_FOUND();
  const { cat } = await getBadgeSnapshot();
  const row = cat.find((d) => Number(d.id) === n);
  if (!row || !row.image_url.startsWith("data:") || badgeImageFile(row.image_url) !== file) return NOT_FOUND();
  const img = parseDataImage(row.image_url);
  if (!img) return NOT_FOUND();
  return new Response(img.bytes as BodyInit, {
    headers: {
      "Content-Type": img.type,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      // An admin-uploaded SVG opened directly must not run script on our origin.
      ...(img.ext === "svg" ? { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}),
    },
  });
}
