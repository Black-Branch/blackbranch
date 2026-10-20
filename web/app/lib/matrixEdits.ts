import type { MatrixEvent } from "matrix-js-sdk";

// targetEventId → the latest edited message content (`m.new_content`).
export type EditsMap = Map<string, Record<string, unknown>>;

// Recompute edits (`m.replace`) from the raw timeline, mirroring the reactions
// pass. The homeserver only aggregates edits from the original sender, so we can
// trust the edit events present and just keep the newest per target. The edit
// events themselves are filtered out of the rendered message list (in Timeline).
export function aggregateEdits(events: MatrixEvent[]): EditsMap {
  const latest = new Map<string, { content: Record<string, unknown>; ts: number }>();

  for (const ev of events) {
    if (ev.getType() !== "m.room.message" || ev.isRedacted()) continue;
    const c = ev.getContent() as Record<string, unknown>;
    const rel = c["m.relates_to"] as { rel_type?: string; event_id?: string } | undefined;
    if (rel?.rel_type !== "m.replace" || !rel.event_id) continue;
    const nc = c["m.new_content"] as Record<string, unknown> | undefined;
    if (!nc) continue;
    const ts = ev.getTs();
    const prev = latest.get(rel.event_id);
    if (!prev || ts > prev.ts) latest.set(rel.event_id, { content: nc, ts });
  }

  const out: EditsMap = new Map();
  for (const [id, v] of latest) out.set(id, v.content);
  return out;
}
