import { randomUUID } from "node:crypto";
import pool from "@/lib/db";
import { requireMod } from "@/app/lib/admin";
import { appendModLog } from "@/app/lib/modlog";
import { streamApiFetch } from "@/app/lib/streamApi";
import { createCooldown } from "@/app/lib/rateLimit";
import { ANNOUNCE_MAX } from "@/app/lib/dm/api";
import { NextRequest } from "next/server";

// POST { text } — a mod's announcement: every open chat column slides it up for 20 s. Not Matrix,
// not encrypted, nothing to answer. Mods and admins only (the command's scope is UX; this is the
// gate). One per 30 s per mod. Logged in site.mod_log.

const perMod = createCooldown(30_000);

export async function POST(req: NextRequest) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return Response.json({ error: "Write the announcement: /announce <message>" }, { status: 400 });
  if (text.length > ANNOUNCE_MAX) return Response.json({ error: `An announcement is at most ${ANNOUNCE_MAX} characters.` }, { status: 400 });
  if (perMod.remainingMs(mod) > 0) return Response.json({ error: "One announcement every 30 seconds." }, { status: 429 });

  const { rows } = await pool.query<{ display_name: string | null }>(
    `SELECT display_name FROM site.users WHERE matrix_id = $1`, [mod],
  ).catch(() => ({ rows: [] as { display_name: string | null }[] }));
  const by = rows[0]?.display_name?.trim() || mod.slice(1).split(":")[0] || "";

  const id = randomUUID();
  const res = await streamApiFetch("/chat/announce", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, text, by }),
  }).catch(() => null);
  if (!res?.ok) return Response.json({ error: "Couldn't reach the chat server — nothing was sent." }, { status: 502 });

  perMod.arm(mod);
  await appendModLog({ action: "announce", target: "site", by: mod, reason: text });
  return Response.json({ ok: true, id });
}
