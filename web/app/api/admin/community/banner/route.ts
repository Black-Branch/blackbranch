import type { NextRequest } from "next/server";
import { requireAdminMutation } from "@/app/lib/instanceAdminServer";
import { clearBannerResponse, putBannerResponse } from "@/app/lib/community/communityAdmin";
import { communityDeps } from "@/app/lib/community/communityAdminServer";
import { uploadImageToMatrixMedia } from "@/app/lib/matrixMediaUpload";
import { createCooldown } from "@/app/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The image goes to the admin's own homeserver's media repo; the reconciler then names it on the
// space. One upload per 10 s per admin.
const cooldown = createCooldown(10_000);

// POST /api/admin/community/banner (multipart, field "banner") — the community's banner. ADMIN ONLY, same-origin.
export async function POST(req: NextRequest) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return putBannerResponse(
    () => uploadImageToMatrixMedia(req, { field: "banner", maxBytes: 2 * 1024 * 1024, cooldown, mimes: ["image/png", "image/jpeg", "image/webp"] }),
    communityDeps(admin),
  );
}

// DELETE /api/admin/community/banner — no banner. ADMIN ONLY, same-origin.
export async function DELETE(req: Request) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return clearBannerResponse(communityDeps(admin));
}
