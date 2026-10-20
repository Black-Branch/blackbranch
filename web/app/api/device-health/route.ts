import { readFileSync } from "node:fs";
import path from "node:path";
import pool from "@/lib/db";
import { auth } from "@/auth";
import { ipKey } from "@/app/lib/rateLimit";
import { readBodyCapped } from "@/app/lib/boundedBody";
import { createDeviceHealthGate, MAX_BODY_BYTES, normalizeReport } from "@/app/lib/deviceHealth/ingest";
import { NextRequest } from "next/server";

// Device-health sink (sender: app/components/DeviceHealthReporter.tsx).
//
// UNAUTHENTICATED ON PURPOSE: signed-out phones are the population we most need numbers from.
// The cost is an open write endpoint, bounded by: 60 reports a minute per address, 120 NEW session
// ids an hour per address (there is no fingerprint dedupe here, unlike client_errors, so this is what
// stops a script minting rows), the 16 KB body cap, normalizeReport's re-validation of every value,
// and the 30-day prune.
//
// Every outcome answers 204. The sender is a beacon and never reads the answer, and a failure here
// must never become a client-side error of its own.

const gate = createDeviceHealthGate();
const NO_CONTENT = () => new Response(null, { status: 204 });

// The build this server runs — so a before/after compares builds, not guessed deploy times.
let buildId: string | null = null;
try {
  buildId = readFileSync(path.join(process.cwd(), ".next/BUILD_ID"), "utf8").trim().slice(0, 64) || null;
} catch {
  buildId = null;
}

const MAX_UA = 300;

export async function POST(req: NextRequest) {
  const ip = ipKey(req);
  if (gate.limited(ip)) return NO_CONTENT();
  // Declared length, then a streaming count that cancels past the cap — never req.text(), which
  // buffers a chunked body of any size before it can be measured.
  const text = await readBodyCapped(req, MAX_BODY_BYTES);
  if (!text) return NO_CONTENT();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NO_CONTENT();
  }
  const row = normalizeReport(body);
  if (!row) return NO_CONTENT();
  if (gate.newSessionLimited(ip, row.sessionId)) return NO_CONTENT();

  // Bound from the session, never from the body; best-effort and never gates the write.
  let matrixId: string | null = null;
  try {
    const id = (await auth())?.user?.id;
    matrixId = typeof id === "string" ? id.slice(0, 255) : null;
  } catch {
    /* auth itself may be what broke — keep the report anyway */
  }
  const ua = req.headers.get("user-agent")?.slice(0, MAX_UA) ?? null;
  const j = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

  try {
    await pool.query(
      `INSERT INTO site.device_health
         (session_id, seq, build_id, matrix_id, route, device_class, narrow, user_agent,
          device_memory, hw_concurrency, effective_type, save_data, dpr, open_ms, visible_ms,
          loaf_count, loaf_blocking_ms, loaf_worst, inp_ms, inp, cls, req_count, bytes,
          socket_reconnects, player, decode, frames, anim, settings, heap_start_mb, heap_peak_mb)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20::jsonb,
               $21,$22,$23::jsonb,$24,$25::jsonb,$26::jsonb,$27::jsonb,$28::jsonb,$29::jsonb,$30,$31)
       ON CONFLICT (session_id) DO UPDATE SET
         seq = EXCLUDED.seq, last_at = now(), build_id = EXCLUDED.build_id,
         matrix_id = COALESCE(EXCLUDED.matrix_id, site.device_health.matrix_id),
         route = EXCLUDED.route, device_class = EXCLUDED.device_class, narrow = EXCLUDED.narrow,
         user_agent = EXCLUDED.user_agent, device_memory = EXCLUDED.device_memory,
         hw_concurrency = EXCLUDED.hw_concurrency, effective_type = EXCLUDED.effective_type,
         save_data = EXCLUDED.save_data, dpr = EXCLUDED.dpr, open_ms = EXCLUDED.open_ms,
         visible_ms = EXCLUDED.visible_ms, loaf_count = EXCLUDED.loaf_count,
         loaf_blocking_ms = EXCLUDED.loaf_blocking_ms, loaf_worst = EXCLUDED.loaf_worst,
         inp_ms = EXCLUDED.inp_ms, inp = EXCLUDED.inp, cls = EXCLUDED.cls, req_count = EXCLUDED.req_count,
         bytes = EXCLUDED.bytes, socket_reconnects = EXCLUDED.socket_reconnects, player = EXCLUDED.player,
         decode = EXCLUDED.decode, frames = EXCLUDED.frames, anim = EXCLUDED.anim,
         settings = EXCLUDED.settings, heap_start_mb = EXCLUDED.heap_start_mb,
         heap_peak_mb = EXCLUDED.heap_peak_mb
       -- A late beacon never rolls a row back: only a NEWER snapshot replaces the stored one.
       WHERE site.device_health.seq < EXCLUDED.seq`,
      [
        row.sessionId, row.seq, buildId, matrixId, row.route, row.deviceClass, row.narrow, ua,
        row.deviceMemory, row.hwConcurrency, row.effectiveType, row.saveData, row.dpr, row.openMs, row.visibleMs,
        row.loafCount, row.loafBlockingMs, j(row.loafWorst), row.inpMs, j(row.inp), row.cls, row.reqCount, j(row.bytes),
        row.socketReconnects, j(row.player), j(row.decode), j(row.frames), j(row.anim), j(row.settings),
        row.heapStartMb, row.heapPeakMb,
      ]
    );
  } catch (e) {
    console.warn("[device-health] store failed:", e);
    return NO_CONTENT();
  }

  void prune();
  return NO_CONTENT();
}

// Opportunistic retention, 1 request in 50 — the same shape as /api/client-error.
const PRUNE_AFTER_DAYS = 30;
let sinceLastPrune = 0;
async function prune(): Promise<void> {
  if (++sinceLastPrune < 50) return;
  sinceLastPrune = 0;
  try {
    await pool.query(`DELETE FROM site.device_health WHERE last_at < now() - INTERVAL '${PRUNE_AFTER_DAYS} days'`);
  } catch {
    /* housekeeping — never affects the report path */
  }
}
