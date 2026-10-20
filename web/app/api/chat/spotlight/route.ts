import { requireAdmin } from "@/app/lib/admin";
import { streamApiFetch } from "@/app/lib/streamApi";
import { NextRequest } from "next/server";

// The broadcaster's highlighted message (chatSpotlight.ts): the one message
// being answered on stream, shown to everyone with the highlight-card look.
//   POST { spotlight: { platform, messageId } } — pick it
//   POST { spotlight: null }                    — clear it
// Gated on the ADMIN flag (site.users.is_admin via requireAdmin), never on a
// name. Nothing is stored: stream-api /chat/spotlight keeps the pick in memory,
// broadcasts the `spotlight` frame, and replays it to connecting clients — so
// there is no GET; every client learns it from the socket.

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export async function POST(req: NextRequest) {
  const me = await requireAdmin();
  if (!me) return new Response("Forbidden", { status: 403 });

  const body = await req.json().catch(() => ({}));
  if (!body || typeof body !== "object" || !("spotlight" in body)) {
    return new Response("Bad Request", { status: 400 });
  }
  let spotlight: { platform: string; messageId: string | number } | null = null;
  if (body.spotlight !== null) {
    const platform = String(body.spotlight?.platform ?? "");
    const messageId: unknown = body.spotlight?.messageId;
    const idOk = typeof messageId === "number"
      ? Number.isInteger(messageId) && messageId > 0
      : typeof messageId === "string" && ID_RE.test(messageId);
    if (!platform || !ID_RE.test(platform) || !idOk) {
      return new Response("Bad Request", { status: 400 });
    }
    spotlight = { platform, messageId: messageId as string | number };
  }

  const r = await streamApiFetch("/chat/spotlight", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spotlight }),
  }).catch(() => null);
  if (!r?.ok) return new Response("Bad Gateway", { status: 502 });
  return Response.json({ spotlight });
}
