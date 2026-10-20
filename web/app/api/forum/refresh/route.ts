import { NextRequest } from "next/server";
import { auth } from "@/auth";
import { forumReader } from "@/app/lib/forumReader";
import { createSlidingWindowLimiter } from "@/app/lib/rateLimit";

// POST /api/forum/refresh { roomId } → 204. After a signed-in viewer posts or
// replies through the booted client, the reader's 60s snapshot of that room is
// dropped so their own post shows on the next read. Signed-in + rate-limited:
// a public cache-buster would be a homeserver DoS lever.
const isRateLimited = createSlidingWindowLimiter(60_000, 6);
const validRoomId = (s: unknown): s is string => typeof s === "string" && s.startsWith("!") && s.length <= 256;

export async function POST(req: NextRequest) {
  const session = await auth();
  const myId = session?.user?.id ?? null;
  if (!myId) return new Response("Unauthorized", { status: 401 });
  if (isRateLimited(myId)) return new Response("Too Many Requests", { status: 429 });
  const body = await req.json().catch(() => ({}));
  const roomId = (body as { roomId?: unknown }).roomId;
  if (!validRoomId(roomId)) return new Response("Bad Request", { status: 400 });
  forumReader.invalidate(roomId);
  return new Response(null, { status: 204 });
}
