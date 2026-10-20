import { auth } from "@/auth";
import { authRefusal } from "@/app/lib/siteSession";

// The signed-in user's matrix id, or a ready-to-return 401 Response (503 when the
// sign-in check could not reach the database — siteSession.ts) — the
// plain-user counterpart of admin.ts's requireMod(), so routes do not each
// hand-roll the same two-line guard. Usage:
//   const matrixId = await requireUser();
//   if (typeof matrixId !== "string") return matrixId;
// Routes that need more of the session than the user id keep calling auth()
// directly; routes that deliberately answer signed-out requests with a soft
// 200 (me/color GET etc.) are not guards and don't belong here.
export async function requireUser(): Promise<string | Response> {
  const session = await auth();
  if (!session?.user?.id) return authRefusal(session) ?? new Response("Unauthorized", { status: 401 });
  return session.user.id;
}
